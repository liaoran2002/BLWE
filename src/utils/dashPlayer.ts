/**
 * 用 MSE 把 B 站 dash 的视频轨 + 音频轨合成到一个 `<video>` 上
 *
 * 为什么需要它：
 * dash 的音视频是**两条独立的流**，直接拿视频轨当地址播会没有声音。
 * 而 `<video>` 一次只能播一个 URL，所以要把两轨都塞进 MediaSource 的
 * 两个 SourceBuffer 里 —— 这样对外仍然只有一个媒体元素，
 * 进度、音量、续播、SMTC 这些现有逻辑一行都不用改。
 *
 * 关于内存 / 配额（实测踩过的坑）：
 * 1080P60 的视频整条流可以到上百 MB，会顶到 Chromium 单个 SourceBuffer 的配额，
 * `appendBuffer` 抛 `QuotaExceededError`，一旦不处理之后再也塞不进任何数据、
 * **播放卡死**。所以这里做三件事：
 *  1. **前向限流**：只往播放位置前面缓冲 `MAX_AHEAD_S` 秒，超了就等播放推进；
 *  2. **配额兜底**：真撞上配额时丢掉 `KEEP_BEHIND_S` 秒之前的数据再重试，
 *     并按 `KEEP_BEHIND_STEPS` 递减；
 *  3. **不切到播放点跟前**：递减有 15 秒下限 —— 离播放位置太近的 `remove()`
 *     会让解码器打嗝甚至停住。
 *
 * 注意这里**不做「每轮 append 都主动裁剪」**：m4s 是顺序下载的，
 * 裁掉的数据拿不回来，主动裁会把回拖窗口压得很小，
 * 用户往回拖超出窗口就只能干等（顺序下载永远追不上）。
 * 宁可让缓冲区涨到配额再一次性回收。
 */

/** DashSession 需要的媒体元素能力（项目里用的是精简的 VideoElement 接口） */
export interface MediaElementLike {
  src: string
  readonly currentTime: number
  readonly buffered: TimeRanges
  readonly readyState: number
  readonly paused: boolean
  readonly seeking: boolean
}

export interface DashSource {
  videoUrl: string
  audioUrl: string
  videoMime: string
  audioMime: string
  /** dash 总时长（秒），用来补 MediaSource.duration */
  duration: number | null
}

/** 往播放位置前面最多缓冲多少秒（控制内存） */
const MAX_AHEAD_S = 30
/**
 * 配额超限时，播放位置之前保留多少秒供回拖
 *
 * 留大一点：裁掉的数据拿不回来，窗口越大能回拖的范围越大。
 */
const KEEP_BEHIND_S = 90
/** 配额兜底时的递减档位；**不降到 15 秒以下**，太靠近播放点的 remove 会让解码器打嗝 */
const KEEP_BEHIND_STEPS = [KEEP_BEHIND_S, 60, 40, 25, 15]
/** SourceBuffer 空闲等待的超时（避免异常情况下永久挂住） */
const UPDATE_TIMEOUT_MS = 15000
/** 播放中连续多少毫秒不推进就打一次停滞日志（只用于排查，不干预播放） */
const STALL_WARN_MS = 12000

/** SourceBuffer 配额超限（缓冲区放不下了）*/
const isQuotaError = (err: unknown): boolean =>
  typeof DOMException !== 'undefined' &&
  err instanceof DOMException &&
  (err.name === 'QuotaExceededError' || err.code === 22)

/** 一条 dash 流的下载与 append 任务 */
interface TrackTask {
  buffer: SourceBuffer
  url: string
  controller: AbortController
}

export class DashSession {
  private el: MediaElementLike
  private mediaSource: MediaSource | null = null
  private objectUrl: string | null = null
  private tasks: TrackTask[] = []
  private stopped = false
  /** 停滞看门狗：上次看到的播放位置与时间戳 */
  private lastTime = -1
  private lastProgressAt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null

  constructor(el: MediaElementLike) {
    this.el = el
  }

  /** 当前浏览器/Electron 是否支持这两条流的编码 */
  static isSupported(source: DashSource): boolean {
    if (typeof MediaSource === 'undefined') return false
    try {
      return (
        MediaSource.isTypeSupported(source.videoMime) &&
        MediaSource.isTypeSupported(source.audioMime)
      )
    } catch {
      return false
    }
  }

  /**
   * 开始播放
   *
   * 失败会抛错，调用方应改用 durl（720P 混流）那条路。
   * 注意：正常返回意味着**两条流都已经取完**，中途失败一律抛错，
   * 因为只拿到一半（黑屏有声 / 哑巴）比退回 720P 更糟。
   */
  async start(source: DashSource): Promise<void> {
    this.stop()
    // stop() 会把 stopped 置为 true，这里必须复位，
    // 否则 append() 每次都在第一行直接返回 —— 流被读完却一个字节都没进 buffer
    this.stopped = false

    const ms = new MediaSource()
    this.mediaSource = ms
    this.objectUrl = URL.createObjectURL(ms)
    this.el.src = this.objectUrl

    const [videoBuffer, audioBuffer] = await new Promise<[SourceBuffer, SourceBuffer]>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MediaSource 打开超时')), 10000)
        ms.addEventListener(
          'sourceopen',
          () => {
            clearTimeout(timer)
            try {
              const v = ms.addSourceBuffer(source.videoMime)
              const a = ms.addSourceBuffer(source.audioMime)
              resolve([v, a])
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          },
          { once: true },
        )
      },
    ).catch((err) => {
      this.stop()
      throw err
    })

    // 分片 MP4 的 mvhd 时长经常是 0，不补的话进度条会拿到 Infinity
    if (source.duration && source.duration > 0) {
      try {
        ms.duration = source.duration
      } catch {
        /* 已经确定下来的 duration 改不了，忽略 */
      }
    }

    this.tasks = [
      { buffer: videoBuffer, url: source.videoUrl, controller: new AbortController() },
      { buffer: audioBuffer, url: source.audioUrl, controller: new AbortController() },
    ]
    this.startWatchdog(videoBuffer)

    // 两条流并行拉取，互不阻塞
    const results = await Promise.allSettled(this.tasks.map((t) => this.pump(t)))
    if (this.stopped) return

    const failed = results.find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined
    if (failed) {
      this.stop()
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason))
    }
    if (ms.readyState === 'open') {
      try {
        ms.endOfStream()
      } catch {
        /* 已经结束了，忽略 */
      }
    }
  }

  /** 顺序把一条流取完并 append 进对应 SourceBuffer */
  private async pump(task: TrackTask): Promise<void> {
    const res = await fetch(task.url, { signal: task.controller.signal })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    try {
      for (;;) {
        await this.waitForRoom(task.buffer)
        if (this.stopped) break
        const { done, value } = await reader.read()
        if (done || this.stopped) break
        if (!value || value.byteLength === 0) continue
        await this.append(task.buffer, value)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 缓冲太多就先等着
   *
   * 不做这一步的话会把整条流（1080P60 四分钟约 150MB）一次性塞进内存，
   * 直接撞上 SourceBuffer 配额。
   */
  private async waitForRoom(buffer: SourceBuffer): Promise<void> {
    for (;;) {
      if (this.stopped) return
      if (!buffer.buffered.length) return
      const ahead = buffer.buffered.end(buffer.buffered.length - 1) - this.el.currentTime
      if (ahead <= MAX_AHEAD_S) return
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  /** 等 SourceBuffer 空闲再 append（同一时刻只能有一个 append 在进行） */
  private async append(buffer: SourceBuffer, chunk: Uint8Array): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await this.waitIdle(buffer)
      if (this.stopped) return
      try {
        // Uint8Array 与 BufferSource 的泛型在 TS 5.9 里不完全兼容，这里收窄
        buffer.appendBuffer(chunk as unknown as BufferSource)
        /**
         * 等这次 append 真正结束再返回
         *
         * `appendBuffer` 是异步的（`updating` 立刻变 true，`updateend` 才结束）。
         * 原来直接 return，`pump` 的最后一轮立刻返回、循环因 `done` 退出，
         * `Promise.allSettled` 随即 resolve —— 接着调用的 `endOfStream()` 会撞上
         * 「还在 updating」抛 InvalidStateError，被上面的空 catch 吞掉，
         * 于是 MediaSource 永远不会 end：`ended` 不触发、duration 也可能停在未定值
         * （正是片尾看门狗要兜的那个场景，等于让所有兜底都建立在不确定状态上）。
         */
        await this.waitIdle(buffer)
        return
      } catch (err) {
        if (!isQuotaError(err)) {
          throw err instanceof Error ? err : new Error(String(err))
        }
        const keep = KEEP_BEHIND_STEPS[Math.min(attempt, KEEP_BEHIND_STEPS.length - 1)]
        const freed = await this.trim(buffer, keep)
        if (!freed) {
          /**
           * ⚠️ 文案用**用户能懂的措辞**
           *
           * 这个 Error 可能经 `errMsg()` 显示给用户（「视频加载失败：xxx」），
           * 所以不能写「SourceBuffer 配额超限」这种内部黑话 —— 对用户毫无意义。
           * 只说现象：「解码器缓存满了」。
           */
          throw new Error('播放器缓存已满，需要重新加载')
        }
      }
    }
  }

  /** 等 SourceBuffer 不处于 updating */
  private async waitIdle(buffer: SourceBuffer): Promise<void> {
    while (buffer.updating && !this.stopped) {
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), UPDATE_TIMEOUT_MS)
        buffer.addEventListener(
          'updateend',
          () => {
            clearTimeout(timer)
            resolve(false)
          },
          { once: true },
        )
      })
      /** 同上：文案要用户能懂，不写内部黑话 */
      if (timedOut) throw new Error('播放器等待超时，需要重新加载')
    }
  }

  /**
   * 丢掉播放位置之前的缓冲，给新数据腾地方
   *
   * @param keepBehind 播放位置之前保留多少秒
   * @returns 是否真的丢掉了东西（false 表示丢不动了）
   */
  private async trim(buffer: SourceBuffer, keepBehind: number): Promise<boolean> {
    if (!buffer.buffered.length) return false
    const start = buffer.buffered.start(0)
    const now = this.el.currentTime
    const cutTo = Math.max(start, now - keepBehind)
    // 留不出 1 秒可丢的就不动它 —— 宁可这次不腾空间，也不要切到播放点跟前
    if (cutTo - start < 1) return false

    await this.waitIdle(buffer)
    if (this.stopped) return false
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), UPDATE_TIMEOUT_MS)
      buffer.addEventListener(
        'updateend',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      try {
        buffer.remove(start, cutTo)
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    return true
  }

  /**
   * 停滞看门狗：播放中长时间不推进就记一条日志
   *
   * 只打日志、不干预播放。下次出现「不动」时，这条日志能直接说明
   * 是缓冲区空了、还是元素自己停了。
   */
  private startWatchdog(buffer: SourceBuffer): void {
    this.stopWatchdog()
    this.lastTime = -1
    this.lastProgressAt = Date.now()
    this.watchdog = setInterval(() => {
      if (this.stopped) return
      const now = Date.now()
      const t = this.el.currentTime
      // 暂停 / 拖动 / 还没起播都不算停滞
      if (this.el.paused || this.el.seeking || this.el.readyState < 2) {
        this.lastProgressAt = now
        this.lastTime = t
        return
      }
      if (this.lastTime < 0 || Math.abs(t - this.lastTime) > 0.25) {
        this.lastTime = t
        this.lastProgressAt = now
        return
      }
      if (now - this.lastProgressAt >= STALL_WARN_MS) {
        const ranges: string[] = []
        for (let i = 0; i < buffer.buffered.length; i++) {
          ranges.push(`[${buffer.buffered.start(i).toFixed(1)},${buffer.buffered.end(i).toFixed(1)}]`)
        }
        console.warn(
          `[mse] 播放停滞 ${Math.round((now - this.lastProgressAt) / 1000)}s：` +
            `t=${t.toFixed(1)} readyState=${this.el.readyState} buffered=${ranges.join(' ') || '空'}`,
        )
        // 打过一次就重置，免得刷屏
        this.lastProgressAt = now
      }
    }, 2000)
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
  }

  /** 停止并清理（换源 / 切歌 / 组件卸载时务必调用） */
  stop(): void {
    this.stopped = true
    this.stopWatchdog()
    for (const t of this.tasks) {
      try {
        t.controller.abort()
      } catch {
        /* 忽略 */
      }
    }
    this.tasks = []
    const ms = this.mediaSource
    this.mediaSource = null
    if (ms) {
      try {
        if (ms.readyState === 'open') ms.endOfStream()
      } catch {
        /* 忽略 */
      }
    }
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl)
      } catch {
        /* 忽略 */
      }
      this.objectUrl = null
    }
  }
}
