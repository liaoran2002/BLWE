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

/**
 * playurl 响应的形状（字段很多，只声明用到的）
 *
 * **不再声明 `quality` / `support_formats`**：schema v4 删了这两列，
 * 所以从库里拼回来的最小形状里也不会有它们。durl 的档位改从
 * `durl[0].url` 反推（见 `qualityFromDurlUrl`），展示名走内置档位表。
 *
 * 注意这里仍然要能吃下**联网新解析的整包响应** —— 多出来的字段无所谓，
 * 结构类型允许它。
 */
interface PlayUrlLike {
  data?: {
    dash?: {
      video?: Array<{
        id?: number
        baseUrl?: string
        width?: number
        height?: number
      }>
    }
    durl?: Array<{ url?: string }>
  }
}

/**
 * qn 代码 -> 标签
 *
 * 直接复用 `@common/constants` 的档位表，**别再抄一份**：同一份映射写两处，
 * 以后加档位（比如 8K 的变体）只改一处就会出现「设置里叫 X、角标里叫 Y」。
 *
 * schema v4 之后这就是**唯一**的档位名来源（那条「优先用 B 站 support_formats
 * 文案」的分支已经删掉 —— 内置表本来就覆盖了全部 12 档，而每行存一份映射纯属冗余）。
 */
const QUALITY_LABELS: Record<number, string> = Object.fromEntries(
  VIDEO_QUALITY_OPTIONS.map((opt) => [opt.id, opt.label]),
)

/**
 * 从 durl 地址反推清晰度
 *
 * **为什么能这么干**：B 站的 durl 地址把档位编码在文件名里。实测 24/24 成立：
 *
 * ```
 * ...-1-192.mp4  -> quality 64   (64 + 128)
 * ...-1-208.mp4  -> quality 80   (80 + 128)
 * ```
 *
 * 也就是说 `quality = URL 里的那个数字 - 128`。schema v4 正是因此删掉了
 * `videos.quality` 列 —— 从 `durl_url` 反推即可，不丢信息。
 *
 * ⚠️ 这是 B 站的**命名约定而不是契约**，所以反推失败时返回 `null`
 * （调用方会当作「读不出档位」），**绝不猜一个值** ——
 * 宁可角标空着，也不要显示一个错的清晰度。
 */
export const qualityFromDurlUrl = (url: string | null | undefined): number | null => {
  if (!url) return null
  // 形如 `.../460901307-1-192.mp4?e=...`：取 `-数字.mp4` 里的数字
  const m = /-(\d+)\.mp4(?:[?#]|$)/.exec(url)
  if (!m) return null
  const encoded = Number(m[1])
  if (!Number.isFinite(encoded)) return null
  const quality = encoded - 128
  // 反推出的档位必须是个合理的正数，否则说明这个 URL 不是我们理解的那种格式
  return quality > 0 ? quality : null
}

export interface VideoQualityInfo {
  /** qn 代码，便于排查 */
  code: number
  /** 短标签，用于角标，例如 1080P / 4K */
  label: string
  /** 完整描述，用于悬浮提示，例如 1080P 高清 / 1080P 60帧 */
  description: string
}

/**
 * @param playData playurl 响应。两条来源都可用：新解析时是接口原始响应，
 *                 读缓存时是 `cache.ts` 用结构化列拼回来的**最小形状**
 *                 （只含 `dash` / `durl`，见 `toPlayUrlLike`）
 * @param videoUrl 最终交给 `<video>` 的地址。dash 时用它确认播的是哪一条流；
 *                 durl 时它**本身就是** durl 地址，档位从它反推
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

  /**
   * durl：档位编码在地址里（`URL 数字 - 128`），不再依赖已删除的 `quality` 列。
   *
   * 只在 dash 取不到档位时才走这里 —— dash 有 `id` 就用它，那是最准的。
   */
  if (code === null) {
    const fromUrl = qualityFromDurlUrl(
      videoUrl ?? (data.durl?.[0]?.url as string | undefined) ?? null,
    )
    if (fromUrl !== null) code = fromUrl
  }
  if (code === null) return null

  const label = QUALITY_LABELS[code] || (height && height > 0 ? `${height}P` : '')
  if (!label) return null

  const known = VIDEO_QUALITY_OPTIONS.find((o) => o.id === code)

  return { code, label, description: known?.description ?? label }
}
