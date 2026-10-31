/**
 * 播放引擎：**把「队列里的某一条」变成「`<video>` 上正在播的流」**
 *
 * ## 它管什么、不管什么
 *
 * 管：
 *  - 分派 —— 歌要「搜索 → 挑候选 → 解析地址」，视频直接解析地址；
 *  - 解析 —— 调 `api:resolveVideo`，把结果收敛成 `ResolvedStream`；
 *  - 挂载 —— dash 走 MSE、durl 直接给 `src`，以及 dash 失败后退回 durl；
 *  - 推进 —— 上一个 / 下一个（含随机与单曲循环）；
 *  - 竞态 —— 一条令牌（`token`），切走后回来的旧请求一律丢弃。
 *
 * 不管（都在 `PlaybackHost` 的实现方，也就是 `stores/playback`）：
 *  - 界面状态（标题 / 封面 / 清晰度角标 / 缓冲圈）；
 *  - 提示文案（搜不到、被限流、失败跳过）；
 *  - 卡顿恢复链与片尾看门狗 —— 它们要看 `buffered`、要弹 UI、要跳下一条，
 *    和「界面」耦合得太紧，硬搬进来只会把 UI 逻辑塞进引擎里。
 *
 * ## 为什么「歌」和「视频」分成两条函数而不是一条带分支的
 *
 * 两条路的**请求数**根本不同：
 *
 * ```
 * 歌：   searchSong（可能联网 1~3 秒） → getSelectedBvid → resolveVideo（可能联网）
 * 视频： resolveVideo（bvid 已经在手里）
 * ```
 *
 * 混在一个函数里，那些 `if (isVideoItem(item))` 就会散落在每个 await 之间，
 * 读的人要同时在脑子里维护两条时间线。分开之后各自是一条直线，
 * 共同的部分（错误处理、令牌校验）由 `playItem` 统一收口。
 */
import api from '@/api/electron'
import { DashSession } from '@/utils/dashPlayer'
import type { DashStreamsPayload, QualityOptionsPayload } from '@common/types/ipc'
import type { PlaylistSong, VideoListItem } from '@common/types/playlist'
import { toCacheKey } from '@common/types/playlist'
import type { BiliVideo, VideoElement } from '@/types/app'
import { isVideoItem, keyOf, coverOf, durationOf, titleOf, type PlayItem } from '../types/playItem'

/** 一次解析的产物：够 store 把界面状态写完，也够 engine 自己降级重挂 */
export interface ResolvedStream {
  /** 这一条自己的标识（`keyOf`），用于「这个事件是不是当前这条的」判断 */
  key: string
  item: PlayItem
  bvid: string
  /** durl 直链；走 dash 时为空串 */
  videoUrl: string
  /** dash 双轨；走 durl 时为 null */
  dash: DashStreamsPayload | null
  title: string
  pic: string
  duration: number | null
  quality: string
  qualityDesc: string
  audioQuality: string
  audioQualityDesc: string
  options: QualityOptionsPayload | null
  isLocal: boolean
  /**
   * 这首歌的候选视频（视频条目恒为空数组）
   *
   * MV 的「视频列表」面板读它；OV 下这个面板装的是合集本身，不看这个字段。
   */
  candidates: BiliVideo[]
}

/** 解析时的一次性开关（重新解析 / 降级时会带上） */
export interface LoadOptions {
  /** 跳过缓存，强制重新联网解析地址 */
  skipCache?: boolean
  /** 强制 durl（dash 播不动时用） */
  noDash?: boolean
  /** 指定清晰度（手动切换时用；不传则用会话值或设置里的默认值） */
  qn?: number
  /** 指定音质 */
  audioId?: number
}

/**
 * 宿主：引擎需要向外界要的东西
 *
 * 全部做成回调而不是直接读 store 的字段，是为了让这个文件**不依赖任何
 * 组件内部结构** —— 换个宿主（比如以后的托盘小窗）也能复用。
 */
export interface PlaybackHost {
  /** 那个 `<video>` 元素 */
  videoEl(): VideoElement | null
  /** 当前播放队列 */
  queue(): PlayItem[]
  /** 当前下标 */
  index(): number
  /**
   * 引擎决定要播第 index 条了（在发请求**之前**调用）
   *
   * 实现方在这里清上一条的界面状态、写 `currentIndex`、持久化播放源。
   * 提前调用是刻意的：搜索要一两秒，这段时间界面该显示新歌的名字而不是旧的。
   */
  onSwitch(index: number, item: PlayItem): void
  /** 解析完成、即将挂到元素上 */
  onStream(stream: ResolvedStream): void
  /** 没有可播的内容（搜索无结果 / 全被过滤规则挡掉） */
  onEmpty(item: PlayItem, filtered: boolean): void
  /** 解析失败（网络 / 风控 / 地址取不到） */
  onError(item: PlayItem, err: unknown): void
  /** 本地文件不在了：交给界面弹「重新定位 / 从列表移除」 */
  onLocalMissing(bvid: string, filePath: string): void
  /** 把一次网络请求包起来（实现方用它做 netBusy 计数、禁用控制栏） */
  withNet<T>(fn: () => Promise<T>): Promise<T>
  /**
   * 「下一条 / 上一条」是哪个下标
   *
   * 顺序循环、随机播放都在实现方算 —— 随机要维护一张打乱的下标表，
   * 那是队列的语义，不是播放的语义。
   */
  stepIndex(direction: 1 | -1): number
  /** 当前是不是暂停状态（决定挂源后要不要立刻 `play()`） */
  isPaused(): boolean
  /** 本会话手动挑过的清晰度 / 音质（换歌时由实现方清空） */
  qualityOverride(): { qn: number | null; audioId: number | null }
  /** 解析成功后，把「这条视频的时长」补进列表（有些搜索结果不带时长） */
  onDurationFilled?(bvid: string, seconds: number): void
  /** 即将重新解析同一条（退 durl / 卡顿恢复）：先把播放进度记下来 */
  rememberSeek?(): void
}

/** 每点一次「下一首」就 +1 的令牌：回调回来时对不上就说明已经被切走了 */
export class PlaybackEngine {
  private host: PlaybackHost
  /** 当前这条的令牌；切走 / 停止都会让旧令牌作废 */
  private token = 0
  private dashSession: DashSession | null = null
  /** 本会话是否放弃 dash（连续失败两次后置位） */
  private dashDisabled = false
  private dashFailures = 0
  /** 当前挂在元素上的流（降级 / 换清晰度时要用它的 bvid 与 item） */
  private current: ResolvedStream | null = null
  /** 上一次解析用的开关（`fallbackToDurl` 要沿用 qn/audioId） */
  private lastOptions: LoadOptions = {}

  constructor(host: PlaybackHost) {
    this.host = host
  }

  /** 当前正在播的流（界面/错误处理可以读，但不要改） */
  get stream(): ResolvedStream | null {
    return this.current
  }

  /** 本会话是否已经放弃 dash */
  get isDashDisabled(): boolean {
    return this.dashDisabled
  }

  /** dash（MSE）成功出画后由界面调用：说明这条机器上 dash 是能用的 */
  noteDashWorked(): void {
    this.dashFailures = 0
  }

  // #region 对外：播 / 换 / 停

  /** 播队列里的第 index 条 */
  async playAt(index: number, options: LoadOptions = {}): Promise<boolean> {
    const item = this.host.queue()[index]
    if (!item) return false
    return this.playItem(index, item, options)
  }

  /** 重新解析**当前这一条**（换清晰度 / 播放出错重试 / 退 durl） */
  async reload(options: LoadOptions = {}): Promise<boolean> {
    const item = this.current?.item ?? this.host.queue()[this.host.index()]
    if (!item) return false
    return this.playItem(this.host.index(), item, { ...this.lastOptions, ...options })
  }

  /**
   * **不换条目**，只在当前这一条里换到另一个 bvid
   *
   * 和 `reload` 的区别：reload 会重跑整条「搜索 → 挑候选」流程，而这里
   * bvid 是调用方指定的。走这条路的有：
   *
   *  - MV 的候选列表里点了另一个视频；
   *  - 换清晰度 / 音质（同一个 bvid 重新挑流）；
   *  - dash 退 durl、登录后按新登录态重取、卡顿后跳过缓存重试；
   *  - 续播时按 `song_meta.selected_bvid` 起播。
   *
   * 候选列表沿用上一份（`this.current.candidates`）：换清晰度又不是换歌，
   * 重搜一次只会把用户正在看的列表刷掉。
   */
  async playCandidate(bvid: string, options: LoadOptions = {}): Promise<boolean> {
    const item = this.current?.item ?? this.host.queue()[this.host.index()]
    if (!item) return false
    const token = ++this.token
    this.lastOptions = options
    try {
      const cacheKey = isVideoItem(item) ? '' : toCacheKey(item)
      const res = await this.host.withNet(() =>
        api.resolveVideoUrl(
          bvid,
          cacheKey,
          options.skipCache ?? false,
          options.noDash || this.dashDisabled,
          this.qnOf(options),
          this.audioIdOf(options),
        ),
      )
      if (token !== this.token) return false
      this.throwIfBroken(bvid, res)
      const candidates = this.current?.candidates ?? []
      const picked = candidates.find((c) => c.bvid === bvid)
      const stream: ResolvedStream = {
        key: keyOf(item),
        item,
        bvid,
        videoUrl: res.videoUrl ?? '',
        dash: res.dash ?? null,
        title: res.title || picked?.title || titleOf(item),
        pic: res.pic ?? picked?.pic ?? coverOf(item) ?? '',
        duration: this.durationOfStream(res, item),
        quality: res.quality ?? '',
        qualityDesc: res.qualityDesc ?? '',
        audioQuality: res.audioQuality ?? '',
        audioQualityDesc: res.audioQualityDesc ?? '',
        options: res.options ?? null,
        isLocal: res.isLocal === true,
        candidates,
      }
      this.current = stream
      this.host.onStream(stream)
      this.attach(stream)
      return true
    } catch (err) {
      if (token !== this.token) return false
      if (err instanceof CancelledByFix) return false
      this.host.onError(item, err)
      return false
    }
  }

  /** 停掉当前的流（不碰界面状态，界面自己清） */
  stop(): void {
    this.token += 1
    this.current = null
    this.stopDash()
  }

  /**
   * 播放停滞 / 直链失效时的最后一道：**跳过缓存重新解析同一条**
   *
   * 和 `reload` 的区别只在于默认值，单独开一个方法是为了让调用方读起来
   * 就知道「这是在救一条坏掉的流」，而不是「用户在换清晰度」。
   */
  async recover(): Promise<boolean> {
    const bvid = this.current?.bvid
    // 有 bvid 就只重取这一条：卡顿恢复不该顺手把候选列表也重搜一遍
    if (bvid) return this.playCandidate(bvid, { skipCache: true })
    return this.reload({ skipCache: true })
  }

  next(): void {
    this.step(1)
  }

  prev(): void {
    this.step(-1)
  }

  // #endregion

  // #region 对外：dash → durl 降级

  /**
   * dash（MSE）播不动时退回 durl（720P 混流）
   *
   * 两条触发路径：`<video>` 报了 error、或者 MSE 会话自己 reject。
   * 连续失败两次就认为这台机器上 dash 用不了，本会话不再尝试 ——
   * 否则每切一首歌都要白跑一次 dash。
   */
  fallbackToDurl(): void {
    this.stopDash()
    this.dashFailures += 1
    if (this.dashFailures >= 2) {
      this.dashDisabled = true
      console.warn('[player] dash 连续失败，本会话改用 durl')
    }
    const bvid = this.current?.bvid
    if (!bvid) return
    // 换 durl 会重新加载视频，让宿主先把进度记下来接着播
    this.host.rememberSeek?.()
    void this.playCandidate(bvid, { skipCache: true, noDash: true })
  }

  /**
   * 只换 dash 的视频轨地址（卡顿恢复链里换备用源用）
   *
   * 音频轨不动 —— 卡顿基本都是视频带宽吃紧（音频只有几十 KB/s），
   * 换音频源收益小、风险大。
   */
  retargetDash(videoUrl: string): void {
    const cur = this.current
    if (!cur || !cur.dash) return
    this.stopDash()
    this.current = { ...cur, dash: { ...cur.dash, videoUrl } }
    this.attach(this.current)
  }

  private stopDash(): void {
    if (this.dashSession) {
      this.dashSession.stop()
      this.dashSession = null
    }
  }

  // #endregion

  // #region 内部：队列推进

  private step(direction: 1 | -1): void {
    if (this.host.queue().length === 0) return
    void this.playAt(this.host.stepIndex(direction))
  }

  // #endregion

  // #region 内部：一条的完整生命周期

  private async playItem(
    index: number,
    item: PlayItem,
    options: LoadOptions,
  ): Promise<boolean> {
    const token = ++this.token
    this.lastOptions = options

    // 先让界面切到这一条（清旧状态、写下标）—— 搜索可能要一两秒，
    // 这段时间里界面显示的应该是新条目，而不是上一条的残影。
    this.host.onSwitch(index, item)

    try {
      const stream = await this.resolve(item, options)
      if (token !== this.token) return false
      // `null` = 没有可播的候选，具体提示已由 onEmpty 发出
      if (!stream) {
        this.current = null
        return false
      }
      this.current = stream
      this.host.onStream(stream)
      this.attach(stream)
      return true
    } catch (err) {
      if (token !== this.token) return false
      this.current = null
      // 「本地文件不在了」已经交给界面弹修复框，不该再叠一条错误提示
      if (err instanceof CancelledByFix) return false
      this.host.onError(item, err)
      return false
    }
  }

  /**
   * 一条 → 一份可播放的流
   *
   * 视频走 `resolveVideoItem`，歌走 `resolveSongItem` —— 唯一的岔路口在这里，
   * 再往下各自是一条直线。
   */
  private async resolve(item: PlayItem, options: LoadOptions): Promise<ResolvedStream | null> {
    return isVideoItem(item)
      ? this.resolveVideoItem(item, options)
      : this.resolveSongItem(item, options)
  }

  /**
   * 视频条目：**bvid 就在手里，不搜索**
   *
   * 这里以前要绕三跳（`searchSong('bv:xxx')` 拿回「只有它自己」的候选 →
   * `getSelectedBvid` 取「上次播的」→ `resolveVideo`），其中前两跳对视频
   * 没有任何信息增量 —— 候选永远只有它自己，「上次播的」也永远是它。
   */
  private async resolveVideoItem(
    item: VideoListItem,
    options: LoadOptions,
  ): Promise<ResolvedStream | null> {
    const bvid = item.bvid
    const res = await this.host.withNet(() =>
      api.resolveVideoUrl(
        bvid,
        // 空 keyword：主进程据此走「按 bvid 直接取地址」那条路，
        // 不写「候选关系」也不记 selectedBvid（视频没有这些概念）
        '',
        options.skipCache ?? false,
        options.noDash || this.dashDisabled,
        this.qnOf(options),
        this.audioIdOf(options),
      ),
    )
    this.throwIfBroken(bvid, res)
    const filled = this.durationOfStream(res, item)
    return {
      key: keyOf(item),
      item,
      bvid,
      videoUrl: res.videoUrl ?? '',
      dash: res.dash ?? null,
      // 标题/封面以主进程回传的为准（它解析的就是正在播的这个），
      // 条目只作兜底：缓存里的行可能缺 title/pic
      title: res.title || titleOf(item),
      pic: res.pic ?? coverOf(item) ?? '',
      duration: filled,
      quality: res.quality ?? '',
      qualityDesc: res.qualityDesc ?? '',
      audioQuality: res.audioQuality ?? '',
      audioQualityDesc: res.audioQualityDesc ?? '',
      options: res.options ?? null,
      isLocal: res.isLocal === true,
      candidates: [],
    }
  }

  /**
   * 歌：搜索 → 挑候选 → 解析地址
   *
   * 「挑哪个视频」的优先级没变（上次播的 → 搜索接口带回来的 → 第一个），
   * 但**搜索永远不重试**：B 站不会对一首正常的歌返回 0 条，第 1 轮就空
   * 几乎只有一种解释 —— 被限流了，而重试恰恰是在限流状态下继续打请求。
   */
  private async resolveSongItem(
    item: PlaylistSong,
    options: LoadOptions,
  ): Promise<ResolvedStream | null> {
    const cacheKey = toCacheKey(item)
    const res = await this.host.withNet(() =>
      api.searchSong(item.name, item.singer ?? '', options.skipCache),
    )
    const payload = res.data as
      | { result?: BiliVideo[]; filtered?: boolean; selectedBvid?: string }
      | null
    const candidates = payload?.result ?? []
    if (candidates.length === 0) {
      this.host.onEmpty(item, Boolean(payload?.filtered))
      return null
    }

    /**
     * 播哪个视频：**优先「上次这首歌播的那个」**
     *
     * `song_meta.selected_bvid` 由主进程在每次真正切到某个视频时写库，
     * 所以这里读到的就是「上次真正在播的那个」。搜索返回体里那份作为兜底
     * （主进程刚写过库时会带上，省一次 IPC）。
     */
    let remembered: string | null = null
    try {
      remembered = await api.getSelectedBvid(cacheKey)
    } catch (err) {
      console.warn('[player] 读取上次播放的视频失败，用第一个候选', err)
    }
    const bvid = remembered || payload?.selectedBvid || candidates[0].bvid

    const video = await this.host.withNet(() =>
      api.resolveVideoUrl(
        bvid,
        cacheKey,
        options.skipCache ?? false,
        options.noDash || this.dashDisabled,
        this.qnOf(options),
        this.audioIdOf(options),
      ),
    )
    this.throwIfBroken(bvid, video)

    // 候选列表里可能查不到这条（历史选择不在本次搜索结果里）→ 取第一个能对上的
    const picked = candidates.find((c) => c.bvid === bvid) ?? candidates[0]
    const filled = this.durationOfStream(video, item)
    return {
      key: keyOf(item),
      item,
      bvid,
      videoUrl: video.videoUrl ?? '',
      dash: video.dash ?? null,
      title: video.title || picked?.title || titleOf(item),
      pic: video.pic ?? picked?.pic ?? coverOf(item) ?? '',
      duration: filled,
      quality: video.quality ?? '',
      qualityDesc: video.qualityDesc ?? '',
      audioQuality: video.audioQuality ?? '',
      audioQualityDesc: video.audioQualityDesc ?? '',
      options: video.options ?? null,
      isLocal: video.isLocal === true,
      candidates,
    }
  }

  // #endregion

  // #region 内部：错误与时长

  /**
   * 解析结果的失败分流
   *
   * 主进程解析失败时**不抛异常**，而是回 `{ videoUrl: null, error }`。
   * 三种情况必须分开处理，混在一起会让用户看到错误的提示：
   *  - 本地文件丢了 → 交界面弹修复入口（不抛，抛了只会变成一条红字）
   *  - 登录失效 → 一句能照做的提示
   *  - 其它 → 抛出，走 `onError`
   */
  private throwIfBroken(
    bvid: string,
    res: {
      videoUrl?: string | null
      dash?: DashStreamsPayload | null
      error?: string
      code?: 'LOCAL_MISSING' | 'AUTH_FAILED'
      detail?: string
    },
  ): void {
    if (!res.error || res.videoUrl || res.dash) return
    if (res.code === 'LOCAL_MISSING') {
      this.host.onLocalMissing(bvid, res.detail ?? '')
      // 用一句「取消」标记跳过后续流程：既不弹错误，也不继续挂源
      throw new CancelledByFix()
    }
    if (res.code === 'AUTH_FAILED' || res.error === 'AUTH_FAILED') {
      throw new Error('B 站登录已失效，请重新登录后再试')
    }
    throw new Error(res.error)
  }

  /**
   * 时长：优先主进程回传（view 响应的权威值），其次条目自带的
   *
   * 补上之后顺手通知界面回写 —— 不然下次重开还是空的，每次都要再补一遍。
   */
  private durationOfStream(
    res: { duration?: number | null },
    item: PlayItem,
  ): number | null {
    const fromRes =
      typeof res.duration === 'number' && Number.isFinite(res.duration) && res.duration > 0
        ? Math.round(res.duration)
        : null
    const fromItem = durationOf(item)
    const seconds = fromRes ?? (typeof fromItem === 'number' && fromItem > 0 ? fromItem : null)
    if (fromRes && fromItem !== fromRes) this.host.onDurationFilled?.(item.bvid ?? '', fromRes)
    return seconds
  }

  private qnOf(options: LoadOptions): number | undefined {
    const override = this.host.qualityOverride()
    return options.qn ?? override.qn ?? undefined
  }

  private audioIdOf(options: LoadOptions): number | undefined {
    const override = this.host.qualityOverride()
    return options.audioId ?? override.audioId ?? undefined
  }

  // #endregion

  // #region 内部：挂到元素上

  /**
   * 把一条流挂到 `<video>` 上
   *
   * dash 走 MSE（音视频是两条独立流，只给一条会没声音），durl 直接给 `src`。
   *
   * ## 两条「不能省」的细节
   *
   * 1. **`play()` 不等 `loadeddata`**：dash 会话卡住时 `loadeddata` 永远不来，
   *    元素一直 `paused === true`，停滞看门狗会把它误判成「用户暂停了」，
   *    于是「时长有了、画面一个字节都没有」永久卡住。
   * 2. **`markRaw` 那件事已经不存在了** —— 引擎实例本身由宿主 `markRaw` 持有，
   *    闭包里的 `session` 和字段上的是同一个对象，`!==` 判断可靠。
   */
  private attach(stream: ResolvedStream): void {
    const el = this.host.videoEl()
    if (!el) return
    this.stopDash()

    const dash = stream.dash
    if (dash && DashSession.isSupported(dash)) {
      const session = new DashSession(el)
      this.dashSession = session
      session.start(dash).catch((err) => {
        // 期间已经换过源（切歌 / 换视频）就忽略这次失败
        if (this.dashSession !== session) return
        console.warn('[player] dash 播放失败，退回 durl:', err)
        this.fallbackToDurl()
      })
      if (!this.host.isPaused()) void el.play().catch(() => {})
      return
    }

    /**
     * 环境不支持这条 dash 编码：**必须真的退回 durl**
     *
     * 踩过：这里原来只打一行日志，什么都没做；而此时旧会话已经 stop、
     * blob 地址也 revoke 过了，走 dash 时主进程回的 `videoUrl` 本来就是 null ——
     * 结果新源根本没设上，画面停在上一首，界面却已经是新歌名。
     */
    if (dash && !DashSession.isSupported(dash)) {
      console.warn('[player] 当前环境不支持该 dash 编码，退回 durl')
      this.dashDisabled = true
      this.fallbackToDurl()
      return
    }

    if (stream.videoUrl) {
      el.src = stream.videoUrl
      if (!this.host.isPaused()) void el.play().catch(() => {})
    }
  }

  // #endregion
}

/**
 * 「本地文件不在了，已经交给界面弹修复框」的内部信号
 *
 * 用它而不是返回 `null`，是为了让 `playItem` 的 catch 认得出来：
 * 这种失败**不该**弹错误提示（用户已经把修复入口点开了）。
 */
export class CancelledByFix extends Error {
  constructor() {
    super('cancelled-by-local-fix')
    this.name = 'CancelledByFix'
  }
}
