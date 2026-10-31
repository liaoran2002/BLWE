/**
 * App.vue 的本地数据类型定义
 *
 * 抽到独立文件是为了：
 *  1. 让 <script lang="ts"> 里的 data() 有明确类型，模板里 this.xxx 能被检查
 *  2. 避免把 90 多行类型定义塞进 SFC
 *  3. 配置相关的类型（AppSetting）来自主 / 渲染共用的 electron/common
 */
import type { RemoveListener } from '@common/types/ipc'
import type { DashStreamsPayload, QualityOptionsPayload } from '@common/types/ipc'
import type { VideoListItem } from '@common/types/playlist'
import type { PlayItem } from './playItem';
import type { DashSession } from '../utils/dashPlayer'
import type { PlaybackEngine } from '../utils/playbackEngine'

/** 循环模式下标（与 electron/common 的 PLAY_LOOP_MODES 顺序一致） */
export interface LoopModeIndex {
  read: 0
  single: 1
  random: 2
}

/**
 * 列表弹层类型
 *
 *  - `songList`  歌单：**MV 的播放队列**，一行一首歌。OV 里没有这个东西。
 *  - `videoList` 视频列表：一行一个视频。两个工作区里都有，但来源不同：
 *                OV 是当前这一列的全部条目（合集 / 收藏夹），
 *                MV 是当前这首歌的备选（搜索结果里的一条一个版本）。
 *
 * 原来是 `list` / `vList` —— 名字既不像英文也不像中文，读代码时得先猜。
 */
export type ListType = 'none' | 'songList' | 'videoList'

/** VideoControls 派发的控制动作 */
export type VideoControlAction =
  | 'songList'
  | 'videoList'
  | 'before'
  | 'playControls'
  | 'next'
  | 'playMode'

/**
 * B 站搜索结果里的视频项
 *
 * 与 SongVideoListDialog 的 VideoListItem 保持结构兼容（bvid/title/pic/author/duration）。
 */
export interface BiliVideo {
  bvid: string
  title: string
  /** B 站缩略图 */
  pic?: string | null
  /** UP 主 */
  author?: string | null
  /**
   * 时长**秒数**（`null` / 缺省 = 未知）
   *
   * 主进程 `biliApi.extract` 在入口就把 B站的 `"4:03"` 转成秒了，
   * 渲染层拿到的**只有数字**；展示时用 `formatDuration()` 转回 `mm:ss`。
   */
  duration?: number | null
  /**
   * 是否已收藏（由主进程写入）
   *
   * 收藏状态以主进程的 `videos.favorites` 为权威：列表里这一项就是它的回显，
   * `favoriteBvids` 直接从这里读，不再需要单独维护一份收藏列表 ——
   * 两份数据一定会漂移（收藏后重排了顺序，另一份却还是旧的）。
   */
  favorites?: boolean
  /*
   * 注意：这里**没有** `view_result` / `playurl_result`。
   *
   * 主进程不再把解析结果整包回传给渲染层了 —— 它现在拆成了 `videos` 表上的结构化列
   * （`durl_url` / `dash_video` / …），渲染层要的播放地址由 `api:resolveVideo`
   * 单独给出 `videoUrl` / `dash`，不需要看见缓存内部的形状。
   */
}

export interface AppData {
  // ---- 歌单与播放 ----
  /**
   * 当前播放队列
   *
   * 装的是**歌或视频**（`PlayItem`）—— 两种条目各自保留自己的字段，
   * 不再把视频改名成歌的形状。分派靠 `isVideoItem()`，见 `types/playItem.ts`。
   */
  songs: PlayItem[]
  /** 播放引擎（`markRaw`，不进响应式）—— 解析 / 挂源 / 降级都在它里面 */
  engine: PlaybackEngine | null
  videoList: BiliVideo[]
  /** `videoList` 属于哪一条（标识键），用于判断列表是否已经跟上当前条目 */
  videoListKeyword: string
  /** 正在播的那个视频的封面（主进程回传，优先于列表里的缩略图） */
  videoPic: string
  /** 正在播的视频清晰度短标签（取自 playurl 响应报的档位），例如 1080P */
  videoQuality: string
  /** 清晰度完整描述，例如 1080P 高清 / 1080P 60帧 */
  videoQualityDesc: string
  /** `<video>` 实际解码出的分辨率，例如 1920×1080，仅用于悬浮提示交叉印证 */
  videoQualityPixels: string
  /** 正在播的音频流音质短标签（playurl 响应报的档位），例如 192K */
  audioQuality: string
  /** 音质完整描述，例如 192K 高音质 */
  audioQualityDesc: string
  /** 这个视频当前可选的清晰度 / 音质（播放器上的切换菜单用） */
  qualityOptions: QualityOptionsPayload | null
  /** 当前这首歌手动选过的清晰度（null = 用设置里的默认上限；换歌时清空） */
  selectedQn: number | null
  /** 当前这首歌手动选过的音质（null = 用设置里的默认上限；换歌时清空） */
  selectedAudioId: number | null
  videoUrl: string
  /** dash 双轨信息（非空时用 MSE 播放；只有 durl 时为空） */
  dashSource: DashStreamsPayload | null
  /** 正在播的视频 bvid（`currentVideoIndex` 可能是 -1，所以单独记一个） */
  currentBvid: string
  randomList: number[]
  currentIndex: number
  currentVideoIndex: number
  MODE: LoopModeIndex
  currentMode: number
  videoName: string
  /**
   * 当前这条的**标识键**（`keyOf`：歌是 `歌名-歌手`，视频是 bvid）
   *
   * 只用于进程内比较（「这个错误/定位是不是当前这条的」）——
   * **不是搜索词、也不能贴到界面上**。显示名一律走 `titleOf()`。
   */
  currentKey: string
  listName: string
  currentVolume: number
  currentTime: number
  duration: number
  isMuted: boolean
  paused: boolean
  listType: ListType

  // ---- 歌单管理弹窗 ----
  /** 统一的歌单管理弹窗（新建/编辑/同步/曲目浏览都在里面） */
  playlistManagerVisible: boolean
  /** B 站视频列表弹窗（收藏夹 / 合集 / 系列的导入与浏览） */
  videoListVisible: boolean
  /**
   * 视频管理页当前**浏览**的列表 id
   *
   * 与 `videoListsStore.activeId`（正在播的那个）刻意分开：
   * 切模式时播放不打断，所以「在看哪个列表」和「在播哪个列表」可以不是同一个。
   */
  browseVideoListId: string
  /** 视频管理页当前浏览列表的条目（从库里读，切换 / 编辑后重载） */
  ovSongs: VideoListItem[]
  /** 已经提示过「还没有任何列表」（避免每次兜底加载都再弹一次） */
  _emptyNotified: boolean
  /** OV 下连续「取不到播放地址」的条数（达到上限就停止自动跳过） */
  _ovSkipStreak: number
  /** 正拖着东西悬在窗口上：显示整窗「松手导入并播放」遮罩 */
  dropActive: boolean
  /** 正在导入拖进来的东西（遮罩上转圈，同时挡住第二次拖入） */
  dropBusy: boolean
  /** dragenter / dragleave 的进出计数（在子元素之间移动也会触发，不能只用布尔） */
  _dragDepth: number

  // ---- 窗口状态 ----
  isMaximized: boolean
  isFullscreen: boolean
  wallpaperEnabled: boolean
  /** 界面锁定：隐藏标题栏 / 控制栏，只留左下锁定与右下全屏两个按钮（快捷键 S） */
  locked: boolean

  // ---- 窗口拖拽 ----
  isDragging: boolean
  dragStarted: boolean
  dragReady: boolean
  dragStartX: number
  dragStartY: number
  dragOffsetX: number
  dragOffsetY: number
  _pendingMoveX: number
  _pendingMoveY: number
  _moveFramePending: boolean

  // ---- 登录态 ----
  isLoggedIn: boolean
  userFace: string
  userName: string

  // ---- 事件监听取消函数 ----
  removeMaximizedListener: RemoveListener | null
  removeFullscreenListener: RemoveListener | null
  removeLoginListener: RemoveListener | null
  removeLogoutListener: RemoveListener | null
  removeTrayPlayControl: RemoveListener | null
  removeTrayPrev: RemoveListener | null
  removeTrayNext: RemoveListener | null
  removeTrayToggleMode: RemoveListener | null
  removeTrayShowPlaylist: RemoveListener | null
  /** 托盘「定时」-> 打开定时面板 */
  removeTrayShowSleepTimer: RemoveListener | null
  removeTrayShowLogoutConfirm: RemoveListener | null
  /** 左键点托盘图标 -> 解锁界面的监听摘除函数 */
  removeTrayUnlock: RemoveListener | null
  removeWallpaperState: RemoveListener | null
  /** 壁纸模式不可用时提示用户原因（原生层加载失败 / 找不到桌面壁纸层） */
  removeWallpaperUnavailable: RemoveListener | null
  /** 托盘菜单（迷你控制台）：进度条 / 音量 / 静音 */
  removeTraySeek: RemoveListener | null
  removeTrayVolume: RemoveListener | null
  removeTrayToggleMute: RemoveListener | null
  /** 自绘托盘菜单：菜单开着时吞掉窗口内点击 */
  removeTrayMenuListener: RemoveListener | null
  trayMenuOpen: boolean

  /** 最后一个非零音量，用于「解除静音」时恢复 */
  lastNonZeroVolume: number

  // ---- 歌单 / 续播 ----
  /** 设置弹窗是否可见 */
  settingsVisible: boolean
  /** 关于弹窗是否可见 */
  aboutVisible: boolean
  /** 「添加视频」弹窗是否可见（视频列表右上角的加号） */
  addVideoVisible: boolean
  /** 定时暂停面板是否展开 */
  sleepPanelVisible: boolean
  /**
   * 定时暂停的状态快照（由 `SleepTimer` 每秒推一次）
   *
   * 类型见 `src/utils/sleepTimer.ts` 的 `SleepTimerState`；这里用结构类型，
   * 避免 `types/app.ts` 反向依赖 `utils/`。
   */
  sleepState: {
    active: boolean
    remainMs: number
    pending: boolean
    action: 'stop' | 'quit'
  }
  /** 定时暂停实例（自带 setInterval，`beforeUnmount` 里 dispose） */
  _sleepTimer: import('../utils/sleepTimer').SleepTimer | null
  /** `SleepTimer` 的订阅取消函数 */
  _sleepUnsub: (() => void) | null
  /** 同一个视频的连续失败次数，达到上限就跳过该曲，避免无限重试 */
  _videoErrorCount: number
  /** 正在播的这条是不是本地视频文件（由 `resolveVideo` 回的 `isLocal` 决定） */
  currentBvidIsLocal: boolean
  /** 这次会话里已经弹过「文件丢了」的 bvid（同一个只问一次） */
  _missingPrompted: string[]
  /** 视频加载完成后要跳转到的秒数（续播用） */
  seekAfterLoad: number
  /** `seekAfterLoad` 是为哪一首歌设的，防止跨歌曲误用 */
  seekAfterLoadFor: string
  /** 是否正在缓冲（换源 / 拖动后 MSE 重新拉流的那段） */
  buffering: boolean
  /** 缓冲百分比（0-100，朝「够播」推进） */
  bufferPercent: number
  /** 播放位置之后已缓冲的秒数 */
  bufferSeconds: number
  /** 缓冲百分比的定时刷新句柄 */
  _bufferTimer: ReturnType<typeof setInterval> | null
  /** 上次写入播放进度的时间戳（节流用） */
  _lastPersistAt: number
  /** 上次同步 SMTC 进度的时间戳（节流用） */
  _lastMediaPosAt: number
  /** 上次发给任务栏的进度指纹（百分比 + 暂停态） */
  _lastTaskbarKey: string
  /** 上次给托盘菜单推状态的时间（菜单开着时 300ms 节流） */
  _lastTraySyncAt: number
  /** 定时自动同步的定时器 */
  _syncTimer: ReturnType<typeof setInterval> | null
  /** 定时器对应的「策略指纹」（有没有定时歌单 + 最小间隔），用来避免无关的配置广播反复重建定时器 */
  _syncKey: string
  /** 片尾看门狗的心跳定时器 */
  _endWatchTimer: ReturnType<typeof setInterval> | null
  /** 换源时延迟显示缓冲提示的定时器 */
  _bufferOverlayTimer: ReturnType<typeof setTimeout> | null
  /** 预热槽位：上一首 / 下一首各一个 */
  _warm: { next: WarmInfo | null; prev: WarmInfo | null }
  /** 某个方向是否已经拉过开头那几秒（拉过就不再重复，避免每 3 秒重建一次 MSE） */
  _warmed: { next: boolean; prev: boolean }
  /** 正在预热哪几个方向（避免同一方向并发重复请求） */
  _warming: { next: boolean; prev: boolean }
  /**
   * 某个方向的预热**失败了几次**
   *
   * 心跳每秒都会调 `warmApi`，而搜不到视频时 `_warm[dir]` 是空的、拦不住它 ——
   * 没有这个计数就会每秒重试一次真网络请求（用户反馈过「日志刷几十行 + 界面卡」）。
   * 到上限后由 `_warmFailed` 彻底停掉。
   */
  _warmTries: { next: number; prev: number }
  /** 某个方向的预热是否已彻底失败（不再重试，等换歌时清掉） */
  _warmFailed: { next: boolean; prev: boolean }
  /**
   * 上次预热失败的时刻
   *
   * 心跳是每秒一次，所以「间隔 3 秒再重试」必须靠时间戳判断 ——
   * 光看 `_warmTries` 会让三次重试在 3 秒内全打完。
   */
  _warmRetryAt: { next: number; prev: number }
  /** 预热媒体用的隐藏 <video>（每个方向一个，长期复用） */
  _warmEl: { next: VideoElement | null; prev: VideoElement | null }
  /** 预热媒体的 dash 会话 */
  _warmSession: { next: DashSession | null; prev: DashSession | null }
  /** 到点停掉预热媒体的定时器 */
  _warmTimer: { next: ReturnType<typeof setTimeout> | null; prev: ReturnType<typeof setTimeout> | null }
  /** 播放位置最后一次前进的时间戳（判断是不是真的卡在片尾） */
  _lastProgressAt: number
  /** 最后一次记录到的播放位置 */
  _progressPos: number
  /** 本次源是否已按「播完」处理过，避免看门狗重复触发 */
  _endStallHandled: boolean
  /** 播放停滞看门狗：停滞起始时间戳（0 = 没在停滞） */
  _stallSince: number
  /** 播放停滞看门狗：本次已恢复几次（开始播了就清零） */
  _stallRecoveries: number
  /** 播放停滞看门狗：单曲歌单反复停滞时放弃这条流，不再周期性告警 */
  _stallGivenUp: boolean
  /**
   * 「所有源都卡住」那条常驻通知当前是否还开着
   *
   * 它 `duration: 0`（要手动关），所以靠这个标记保证**同时只有一条**。
   */
  _stallNoticeOpen: boolean
  /**
   * 卡顿恢复链：当前试到第几个**备用源**（`0` = 主地址）
   *
   * 每次换源 +1（`recoverFromStall` 里）。
   *
   * **归零**发生在「换了一条新流」的时候：
   *  - `onVideoLoaded`（新视频真正开始播）；
   *  - `changeSong`（切歌，含新歌在 `loadeddata` 之前就卡住的盲区）；
   *  - `clearNowPlaying`（没有在播的东西了）；
   *  - 单曲循环的那一圈。
   *
   * ⚠️ **换清晰度时不归零**（`applyVideoSource` 里也不归零）—— 这是刻意的：
   * 降清晰度就是在同一条流的恢复链上往前走，复位会让它在第一档上打转。
   */
  _stallUrlIndex: number
  /**
   * 卡顿恢复链：已经**降了几档清晰度**（最多 `MAX_QUALITY_DROPS` 档）
   *
   * 降到 3 档还卡就直接降 durl，不再继续降（画面已经没法看了）。
   *
   * 归零时机与 `_stallUrlIndex` 完全一致（同一件事的两个计数）。
   */
  _stallQualityDrops: number
  /** 这次锁定是不是「进全屏时自动锁的」，退出全屏要跟着解开 */
  _lockedByFullscreen: boolean
  /**
   * ★ **当前有几个网络请求在飞**（搜索 / 解析播放地址）
   *
   * 控制栏据此禁用「会再发请求」的控件（切歌、清晰度/音质切换）——
   * 用户狂点会让请求成倍打出去，B站直接 412 风控。
   *
   * 用**计数器**而不是布尔：切歌时「搜索 → 解析地址」是两段连续的请求，
   * 布尔会被先结束的那个提前清掉。
   *
   * ⚠️ 它参与渲染（`netBusy` 计算属性读它），所以**必须在 data 里**、
   * 不能只做成普通实例字段。
   */
  _netBusyCount: number
  /**
   * ★ 清晰度 / 音质切换后的**冷却截止时间戳**（毫秒；`0` = 没有冷却）
   *
   * 切换会重新解析地址，`_netBusyCount` 只管到请求结束；
   * 这个冷却再压 3 秒，防止「请求刚结束就再点一次」。
   */
  _qualityCooldownUntil: number
  /** 上面那个冷却的定时器句柄（重复调用时先清旧的，避免堆定时器） */
  _qualityCooldownTimer: ReturnType<typeof setTimeout> | null
  /**
   * 上次提示「正在加载，先别点」的时间戳（毫秒）
   *
   * 用于给 `notifyNetBusy()` 节流 —— 用户连点切歌时别让 toast 刷屏。
   */
  _lastNetBusyHintAt: number
}

/**
 * 预热槽位里存的东西
 *
 * 「上一首 / 下一首」各一个：搜索 + 播放地址都问好了放在这儿，
 * 真正切歌时主进程直接命中缓存，剩下的只是本地换源。
 */
export interface WarmInfo {
  /** 缓存键（toCacheKey），用来判断槽位是不是过期了 */
  song: string
  bvid: string
  videoUrl: string | null
  dash: DashStreamsPayload | null
}

/**
 * 模板里 <video ref="video"> 的最小接口
 *
 * 只声明本项目真正用到的成员，避免到处 (this.$refs.video as HTMLVideoElement)，
 * 也避免把整个 HTMLVideoElement 的庞杂类型引进来。
 */
export interface VideoElement {
  /** durl 播放时由 applyVideoSource 赋值；dash 播放时是 MediaSource 的 blob 地址 */
  src: string
  /** 当前真正加载的地址（空 = 还没设过源）；停滞看门狗用它区分「起播等待」和「卡住」 */
  readonly currentSrc: string
  /** MSE 缓冲区裁剪时要用 */
  readonly buffered: TimeRanges
  /** 停滞看门狗用：0=HAVE_NOTHING … 4=HAVE_ENOUGH_DATA */
  readonly readyState: number
  readonly paused: boolean
  readonly seeking: boolean
  volume: number
  muted: boolean
  currentTime: number
  readonly duration: number
  /** 实际解码出的画面尺寸（分辨率），用于印证清晰度 */
  readonly videoWidth: number
  readonly videoHeight: number
  play(): Promise<void>
  pause(): void
  /** 停掉当前流（清空播放信息时用：pause + removeAttribute('src') + load()） */
  removeAttribute(name: string): void
  load(): void
}
