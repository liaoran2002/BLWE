/**
 * 定时暂停 / 定时关闭
 *
 * ## 一句话
 *
 * 用户设一个时长（时 + 分），到点后**停止播放**；勾了「关闭程序」就**退出应用**。
 * 勾了「视频播放完毕后停止播放」时，不在倒计时归零那一刻就动手，而是等**某个视频
 * 播到第 1-3 秒**（`currentTime` 落在 `(1, 3)`）再执行 —— 这样不会把人正听着的一首
 * 从中间掐断。
 *
 * ## 为什么这段逻辑放在渲染层
 *
 * 三个执行条件里有两个是**只有渲染层才知道的**：
 *  - 「视频播到第 1-3 秒」→ 要读 `<video>.currentTime`
 *  - 「暂停时冻结倒计时」→ 要读 `paused`
 *
 * 主进程完全看不到这些。所以计时器在这里跑，只有「退出应用」那一步走 IPC。
 *
 * ## 三个选项是**叠加**的，不是互斥
 *
 * | pauseCountdown | waitVideoEnd | closeApp | 行为 |
 * | :---: | :---: | :---: | :--- |
 * | ☐ | ☐ | ☐ | 到点**立刻**停止播放 |
 * | ☐ | ☑ | ☐ | 到点后等视频播到 1-3 秒 → 停止播放 |
 * | ☐ | ☐ | ☑ | 到点**立刻**关闭程序 |
 * | ☐ | ☑ | ☑ | 到点后等视频播到 1-3 秒 → 关闭程序 |
 * | ☑ | 任意 | 任意 | 暂停时倒计时**冻结**（另外两条照旧） |
 */

/** 三个复选框的状态 */
export interface SleepTimerOptions {
  /** 视频暂停时倒计时也暂停 */
  pauseCountdown: boolean
  /** 等视频播完（播到下一首的 1-3 秒）再执行，否则到点立刻执行 */
  waitVideoEnd: boolean
  /** 执行动作是「关闭程序」（否则只是「停止播放」） */
  closeApp: boolean
}

/** 到点后要执行什么 */
export type SleepTimerAction = 'stop' | 'quit'

/** 定时器当前状态（给界面渲染用） */
export interface SleepTimerState {
  /** 是否正在倒计时（含「已归零、在等视频」那段，那时 `remainMs` 为 0） */
  active: boolean
  /** 剩余毫秒（归零后为 0） */
  remainMs: number
  /**
   * 倒计时已归零、**正在等「视频播到 0-3 秒」**
   *
   * 界面据此显示「计时已结束，等待视频播完…」并把按钮标红（`00:00`）。
   */
  pending: boolean
  /** 到点后要执行的动作 */
  action: SleepTimerAction
}

/** 每秒回调一次的状态快照 */
export type SleepTimerListener = (state: SleepTimerState) => void

/**
 * 执行动作的回调（由调用方提供）
 *
 * 为什么用回调而不是在这里直接 `electronApi.quitApp()`：
 * 这个模块要能**单独测试**（不依赖 Electron），而且「停止播放」是纯渲染层的事。
 */
export interface SleepTimerHandlers {
  /** 停止播放（调用方实现：`video.pause()` + 更新界面状态） */
  stop: () => void
  /** 关闭程序（调用方实现：`electronApi.winQuit()`） */
  quit: () => void
  /**
   * 定时**真的执行了**（在 stop / quit 之前调用）
   *
   * 调用方用它来关掉定时弹窗。
   *
   * ⚠️ **只有这里才该关弹窗**：改时长 / 勾复选框也会触发 `emit()`，
   * 那时定时还没启动，若按 `state.active` 判断就会「点一下就关窗」（踩过）。
   */
  fired: () => void
  /**
   * 取当前播放位置（秒）与暂停状态
   *
   * 返回 `null` 表示「现在没有视频元素」（比如还在搜索），
   * 那时**不判定**「播到 1-3 秒」，也不冻结倒计时（当作在播）。
   */
  readVideo: () => { currentTime: number; paused: boolean } | null
}

/** 1 秒一跳：倒计时的粒度就是秒，再细没意义 */
const TICK_MS = 1000

/**
 * 「播到第 1-3 秒」的判定区间（**左开右闭**：`> 0` 且 `<= 3`）
 *
 * ⚠️ **不能用 `currentTime === 1`**：`timeupdate` 大约 250ms 一次，
 * 而且浏览器给的是浮点数（可能是 `0.998` / `1.004` / `1.253`）——
 * 严格等于某个值几乎必然错过。所以取一个**区间**，落进去就算「播到开头了」。
 *
 * 用户定的区间是「大于 0 小于等于 3」：从开播第一帧起就能命中，
 * 而不是必须跨过 1 秒（dash 起播慢的时候，2 秒内就开始放很常见）。
 */
const FIRE_AFTER_SEC = 0
const FIRE_AFTER_INCLUSIVE = false
const FIRE_BEFORE_SEC = 3
const FIRE_BEFORE_INCLUSIVE = true

/** 播放位置是否落在「到点该执行」的窗口里 */
const inFireWindow = (currentTime: number): boolean => {
  const afterOk = FIRE_AFTER_INCLUSIVE
    ? currentTime >= FIRE_AFTER_SEC
    : currentTime > FIRE_AFTER_SEC
  const beforeOk = FIRE_BEFORE_INCLUSIVE
    ? currentTime <= FIRE_BEFORE_SEC
    : currentTime < FIRE_BEFORE_SEC
  return afterOk && beforeOk
}

export class SleepTimer {
  private handlers: SleepTimerHandlers
  private listeners = new Set<SleepTimerListener>()

  /** 到期的时间戳（毫秒）；`null` = 没在倒计时 */
  private deadlineAt: number | null = null
  /** 暂停冻结时：冻结那一刻的剩余毫秒（恢复时据此重算 deadline） */
  private frozenRemainMs: number | null = null
  /** 已归零、正在等「播到 1-3 秒」 */
  private pending = false
  private action: SleepTimerAction = 'stop'
  private options: SleepTimerOptions = {
    pauseCountdown: false,
    waitVideoEnd: false,
    closeApp: false,
  }
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(handlers: SleepTimerHandlers) {
    this.handlers = handlers
  }

  /** 订阅状态变化（每秒一次，以及每次开始/取消/冻结/执行时） */
  subscribe(listener: SleepTimerListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前状态快照 */
  snapshot(): SleepTimerState {
    return {
      /**
       * `active` 要把 `pending` 也算进去
       *
       * 倒计时归零、正在等视频播完时 `deadlineAt` 已经是 `null` 了 ——
       * 如果只看它，界面会以为「没有定时」而把按钮变回「定时」。
       * 那段等待同样是"定时过程"，按钮应显示 `00:00`（红色）。
       */
      active: this.deadlineAt !== null || this.frozenRemainMs !== null || this.pending,
      remainMs: this.remainMs(),
      pending: this.pending,
      action: this.action,
    }
  }

  /** 剩余毫秒（冻结时返回冻结值；未启动返回 0） */
  private remainMs(): number {
    if (this.frozenRemainMs !== null) return this.frozenRemainMs
    if (this.deadlineAt === null) return 0
    return Math.max(0, this.deadlineAt - Date.now())
  }

  /**
   * 启动 / 更新定时
   *
   * @param hours   0-23
   * @param minutes 0-59
   * @param options 三个复选框
   * @returns 是否真的启动了（0 时 0 分 = 取消定时）
   */
  start(hours: number, minutes: number, options: SleepTimerOptions): boolean {
    const totalMs = (Math.max(0, Math.floor(hours)) * 60 + Math.max(0, Math.floor(minutes))) * 60000
    if (totalMs <= 0) {
      this.cancel()
      return false
    }
    this.options = { ...options }
    this.action = options.closeApp ? 'quit' : 'stop'
    this.deadlineAt = Date.now() + totalMs
    this.frozenRemainMs = null
    this.pending = false
    this.ensureTicker()
    this.emit()
    return true
  }

  /** 取消定时（不动播放） */
  cancel(): void {
    this.deadlineAt = null
    this.frozenRemainMs = null
    this.pending = false
    this.stopTicker()
    this.emit()
  }

  /**
   * 立即同步一次状态（**播放 / 暂停事件发生时调用**）
   *
   * ## 为什么需要它
   *
   * 冻结/恢复的判断原来只在每秒的 `tick()` 里做，于是**最多会晚 1 秒**：
   * 用户在 `xx:59.1` 点暂停，下一次 tick 在 `xx:00.0` 才把状态切成冻结，
   * 这中间剩余时间已经从 59 变成 58 —— 用户看到的就是
   * **「点了暂停，倒计时还多跑了一秒」**。
   *
   * 由 `<video>` 的 `play` / `pause` 事件直接调这个函数，
   * 冻结就发生在**事件那一刻**，不会多跑。
   */
  syncNow(): void {
    /** 没有定时 / 没有冻结 → 什么都不用做（避免无意义 emit） */
    if (this.deadlineAt === null && this.frozenRemainMs === null && !this.pending) return
    this.tick()
  }

  /*
   * ⚠️ 这里**没有** `setOptions()`（已删，别再加回来）
   *
   * 曾经有过一个「三个复选框在面板里被改时同步」的方法，但它是死代码 ——
   * 面板走的是**草稿模式**（见 `SleepTimerPanel.vue`）：编辑只改本地 `draftXxx`，
   * 点「确认」才 `emit('apply')` 上报一次。
   *
   * 保留它还有害：它的文档描述的是面板**故意不做**的实时同步行为，
   * 后来读代码的人会以为选项是实时生效的，并照这个假设去改。
   */

  /** 销毁（组件卸载时调） */
  dispose(): void {
    this.stopTicker()
    this.listeners.clear()
  }

  // #region 内部

  private ensureTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => this.tick(), TICK_MS)
  }

  private stopTicker(): void {
    if (!this.ticker) return
    clearInterval(this.ticker)
    this.ticker = null
  }

  private emit(): void {
    const state = this.snapshot()
    for (const fn of this.listeners) fn(state)
  }

  /** 每秒一跳 */
  private tick(): void {
    const video = this.handlers.readVideo()

    /**
     * ① 已经归零、在等「播到 0-3 秒」→ 只看这一条
     *
     * ## ⚠️ 必须给「视频停着不走」留一条出路（踩过）
     *
     * 等待的实现是「每秒看一次 `currentTime` 是否落在 0-3 秒窗口」。
     * 而视频**暂停**时 `currentTime` 永远不动 —— 于是这个等待**永远不会结束**：
     * 面板一直显示「计时已结束，等待视频播放完毕…」，除了点「取消定时」
     * 没有任何出路，用户会以为定时器坏了。
     *
     * 什么时候会这样：勾了「视频播放完毕后停止播放」但**没勾**「暂停时暂停倒计时」，
     * 到点那一刻视频正好是暂停的（用户手动暂停、或元素被 `pause()` 停在中段）。
     *
     * 判断「等不下去了」用 `paused`（而不是「这一秒没动」）：暂停是明确的用户意图，
     * 而后者可能只是缓冲 / 卡顿，等一会儿会自己恢复。
     *
     * 没有视频元素时同理 —— 没有任何东西会「播完」，再等就是死等。
     */
    if (this.pending) {
      if (!video || video.paused) {
        this.fire()
        return
      }
      if (inFireWindow(video.currentTime)) {
        this.fire()
      }
      return
    }

    /**
     * ② 冻结中：判断「继续保持冻结」还是「恢复倒计时」
     *
     * ⚠️ **这段必须在 `deadlineAt === null` 的提前返回之前**
     *
     * 踩过的 bug：原来把恢复逻辑放在 `if (!this.deadlineAt) return` **之后**，
     * 而冻结时 `deadlineAt` 恰好被置成 `null` —— 于是那一跳直接返回，
     * 恢复分支永远走不到。表现就是用户说的
     * **「暂停会暂停倒计时，但点播放后倒计时没有继续」**。
     */
    if (this.frozenRemainMs !== null) {
      /** 还暂停着（且开关还开着）→ 继续冻结 */
      if (this.options.pauseCountdown && video?.paused) return
      /**
       * 恢复播放（或用户把开关关掉了）→ 按冻结的剩余时间重算 deadline
       *
       * 用「剩余时间 + 现在」而不是「补上暂停的那段时长」：
       * 后者要累计每次暂停的时长，容易算错。
       */
      this.deadlineAt = Date.now() + this.frozenRemainMs
      this.frozenRemainMs = null
      this.emit()
      return
    }

    /** 没在倒计时（也没冻结）→ 什么都不用做 */
    if (this.deadlineAt === null) return

    /**
     * ③ 正常跑着：碰到暂停就冻结
     *
     * 记下剩余毫秒并把 deadline 置空，恢复时再按剩余重算（见上面 ②）。
     */
    if (this.options.pauseCountdown && video?.paused) {
      this.frozenRemainMs = Math.max(0, this.deadlineAt - Date.now())
      this.deadlineAt = null
      this.emit()
      return
    }

    if (Date.now() < this.deadlineAt) {
      this.emit()
      return
    }

    /**
     * ③ 归零
     */
    this.deadlineAt = null

    if (this.options.waitVideoEnd) {
      /**
       * 等「播到 0-3 秒」。**当前这一秒就可能已经落在区间里**
       * （比如用户正好在视频开头设的定时）—— 所以这里立刻判一次，
       * 不然要白等最多 1 秒。
       */
      this.pending = true
      if (video && inFireWindow(video.currentTime)) {
        this.fire()
        return
      }
      this.emit()
      return
    }

    /** 不等视频：立刻执行 */
    this.fire()
  }

  /** 执行动作 */
  private fire(): void {
    this.pending = false
    this.deadlineAt = null
    this.frozenRemainMs = null
    this.stopTicker()
    this.emit()
    /** 先通知「执行了」（调用方关弹窗），再真正执行动作 */
    this.handlers.fired()
    if (this.action === 'quit') this.handlers.quit()
    else this.handlers.stop()
  }

  // #endregion
}

/** 把剩余毫秒格式化成倒计时文本：有小时 `H:MM:SS`，没有 `MM:SS` */
export const formatRemain = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
