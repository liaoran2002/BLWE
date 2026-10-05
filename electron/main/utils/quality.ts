/**
 * 从 B 站 playurl 响应里读出「当前实际在播的视频清晰度」
 *
 * 关键点：请求里写的 `qn`（本项目固定填 64）**不等于**真正拿到的清晰度 ——
 * B 站会按登录态、会员等级、视频可用档位做降级，所以要看响应自己报的 `quality`。
 *
 * 两条链路的字段位置不同：
 *  - `fnval: 16`（dash）：真正播的是 `dash.video[]` 里的某一条，清晰度是它的 `id`；
 *  - `fnval: 1`（durl，渐进式 mp4）：清晰度在顶层的 `data.quality`。
 *
 * 展示名直接用 `support_formats` 里的 `display_desc` / `new_description`，
 * 那是 B 站自己播放器显示的文字（例如「1080P」/「1080P 高清」/「1080P 60帧」），
 * 比按分辨率反推更准确，也能区分 60 帧、高码率这些同分辨率的档位。
 */
import { VIDEO_QUALITY_OPTIONS } from '@common/constants'

/** playurl 响应的形状（字段很多，只声明用到的） */
interface PlayUrlLike {
  data?: {
    quality?: number
    support_formats?: Array<{
      quality?: number
      display_desc?: string
      new_description?: string
    }>
    dash?: {
      video?: Array<{
        id?: number
        baseUrl?: string
        width?: number
        height?: number
      }>
    }
  }
}

/**
 * qn 代码 -> 标签（`support_formats` 缺失时才用到）
 *
 * 直接复用 `@common/constants` 的档位表，**别再抄一份**：同一份映射写两处，
 * 以后加档位（比如 8K 的变体）只改一处就会出现「设置里叫 X、角标里叫 Y」。
 */
const QUALITY_LABELS: Record<number, string> = Object.fromEntries(
  VIDEO_QUALITY_OPTIONS.map((opt) => [opt.id, opt.label]),
)

export interface VideoQualityInfo {
  /** qn 代码，便于排查 */
  code: number
  /** 短标签，用于角标，例如 1080P / 4K */
  label: string
  /** 完整描述，用于悬浮提示，例如 1080P 高清 / 1080P 60帧 */
  description: string
}

/**
 * @param playData playurl 响应（缓存里是 `playurl_result`，新解析的是 `playData`）
 * @param videoUrl 最终交给 `<video>` 的地址，用来确认 dash 里播的是哪一条流
 */
export const readVideoQuality = (
  playData: unknown,
  videoUrl: string | null,
): VideoQualityInfo | null => {
  const data = (playData as PlayUrlLike | null | undefined)?.data
  if (!data) return null

  let code: number | null = null
  let height: number | null = null

  // dash：优先挑「地址和实际播放地址一致」的那条流，取不到再退回第一条
  const dashVideos = data.dash?.video
  if (Array.isArray(dashVideos) && dashVideos.length > 0) {
    const playing =
      (videoUrl ? dashVideos.find((v) => v?.baseUrl === videoUrl) : undefined) ??
      dashVideos[0]
    if (playing && typeof playing.id === 'number') {
      code = playing.id
      height = typeof playing.height === 'number' ? playing.height : null
    }
  }

  // durl：顶层 quality 就是这条渐进式流的清晰度
  if (code === null && typeof data.quality === 'number') code = data.quality
  if (code === null) return null

  const hit = data.support_formats?.find((f) => f?.quality === code)
  const fromApi = typeof hit?.display_desc === 'string' ? hit.display_desc : ''
  const label =
    fromApi || QUALITY_LABELS[code] || (height && height > 0 ? `${height}P` : '')
  if (!label) return null

  const descFromApi =
    typeof hit?.new_description === 'string' ? hit.new_description : ''

  return { code, label, description: descFromApi || label }
}
