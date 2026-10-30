/**
 * 媒体探针：用 `<video preload="metadata">` 读一个地址的元信息
 *
 * ## 为什么不用 ffmpeg
 *
 * 真正需要的只有两件事：**时长**，和「这个文件到底能不能播」。
 * 而这两件事 Chromium 自己就能回答 —— 用的还是待会儿真播放的那套解码器：
 *
 *  - 体积：`ffmpeg-static` 单平台 ~80MB，三平台两三百 MB。这个项目的依赖
 *    一共才 4 个轻包，为一行时长引入这种量级不划算；
 *  - 一致性：ffmpeg 说「这个 mp4 没问题」不代表 Chromium 能播（HEVC 就是典型）。
 *    探针的结论**必然**和真播放一致，因为它俩是同一个解码器；
 *  - 顺带解掉「格式白名单」：不需要按扩展名猜，`loadedmetadata` 不出来就是播不了。
 *
 * ## 为什么探针在渲染层
 *
 * 媒体元素只存在于渲染层。这一步只是**测量**，判断与落库都在主进程
 * （`api:fillVideoDuration`）—— 「渲染层只管渲染」说的是不做业务判断，
 * 不是「不许碰 DOM」。
 *
 * ## 用完必须释放
 *
 * `src` 置空 + `load()`：Windows 上媒体元素只要还持有文件句柄，
 * 用户就删不掉 / 改不了名（报「文件正在使用」）。探针是一次性的，必须当场拆掉。
 */

export interface MediaProbeResult {
  /** 解出了容器元数据（大致等价于「能播」） */
  ok: boolean
  /** 秒；`0` = 拿不到（有些容器没有 duration，或根本没解出来） */
  duration: number
  /** 失败原因（给日志和提示用） */
  error?: string
}

/**
 * 探一个地址
 *
 * @param url      `blwe-media://local/<bvid>` 这类地址
 * @param timeoutMs 超时（默认 8s）。**必须有**：文件在慢速移动硬盘上、
 *                  或者是个坏文件时，`loadedmetadata` / `error` 可能都不来，
 *                  不设超时就是一条永不 resolve 的 Promise，导入流程整个卡住。
 */
export const probeMedia = (url: string, timeoutMs = 8000): Promise<MediaProbeResult> =>
  new Promise((resolve) => {
    const video = document.createElement('video')
    /** 不挂 DOM：媒体元素不进文档也能加载元数据，省得影响布局 */
    video.preload = 'metadata'
    video.muted = true

    let settled = false
    let timer = 0

    const cleanup = (): void => {
      window.clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      /**
       * 释放文件句柄。顺序不能反：先摘 `src` 再 `load()`，
       * 直接 `load()` 会尝试重新加载那个空 src（控制台一条无意义报错）。
       */
      video.removeAttribute('src')
      video.load()
    }

    const finish = (result: MediaProbeResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    function onLoaded(): void {
      const raw = video.duration
      /** `Infinity` / `NaN` 都当未知（流式容器没有总时长时会是 Infinity） */
      const duration = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0
      finish({ ok: true, duration })
    }

    function onError(): void {
      const code = video.error?.code
      /**
       * 1 中断 / 2 网络 / 3 解码 / 4 不支持的格式
       *
       * 本地文件最常见的是 4（编码不支持，比如 HEVC 塞在 mkv 里）
       * 和 2（路径失效，协议回了 404）。
       */
      const reason =
        code === 4
          ? '编码不受支持'
          : code === 2
            ? '文件读不到'
            : code === 3
              ? '解码失败'
              : '无法播放'
      finish({ ok: false, duration: 0, error: reason })
    }

    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('error', onError)
    timer = window.setTimeout(() => {
      finish({ ok: false, duration: 0, error: '读取超时' })
    }, timeoutMs)

    video.src = url
  })
