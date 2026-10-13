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
import type { DashSession } from '../utils/dashPlayer'
import type { PlaylistSong } from '@common/types/playlist'

/** 循环模式下标（与 electron/common 的 PLAY_LOOP_MODES 顺序一致） */
export interface LoopModeIndex {
  read: 0
  single: 1
  random: 2
}

/** 列表弹层类型：none 关闭 / list 歌单 / vList 视频列表 */
export type ListType = 'none' | 'list' | 'vList'

/** biliVideoControls 派发的控制动作 */
export type VideoControlAction =
  | 'list'
  | 'vList'
  | 'before'
  | 'playControls'
  | 'next'
  | 'playMode'

/**
 * B 站搜索结果里的视频项
 *
 * 与 showList 的 VideoListItem 保持结构兼容（bvid/title/pic/author/duration）。
 */
export interface BiliVideo {
  bvid: string
  title: string
  /** B 站缩略图 */
  pic?: string | null
  /** UP 主 */
  author?: string | null
  /** 时长：搜索接口给字符串 "4:03"，view 接口给秒数，两种都可能是 */
  duration?: number | string | null
  /** 后端缓存里可能带上这两个字段 */
  view_result?: unknown
  playurl_result?: unknown
}

export interface AppData {
  // ---- 歌单与播放 ----
  /** 当前歌单的曲目（结构化：含封面 / 专辑 / 歌手） */
  songs: PlaylistSong[]
  videoList: BiliVideo[]
  /** `videoList` 属于哪一首歌（搜索键），用于判断列表是否已经跟上当前歌曲 */
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
  /** 当前 dash 会话（MSE），不进模板所以不需要响应式 */
  _dashSession: DashSession | null
  /** dash 连续失败次数 */
  _dashFailures: number
  /** 本会话是否已判定 dash 不可用（连续失败后置位，避免每首歌都白试一次） */
  _dashDisabled: boolean
  /** 正在播的视频 bvid（`currentVideoIndex` 可能是 -1，所以单独记一个） */
  currentBvid: string
  randomList: number[]
  currentIndex: number
  currentVideoIndex: number
  MODE: LoopModeIndex
  currentMode: number
  videoName: string
  songName: string
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

  // ---- 请求竞态令牌 ----
  _songToken: number

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
  /** 视频请求竞态令牌（切视频时防乱序覆盖） */
  _videoToken: number
  /** 同一个视频的连续失败次数，达到上限就跳过该曲，避免无限重试 */
  _videoErrorCount: number
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
  /** 这次锁定是不是「进全屏时自动锁的」，退出全屏要跟着解开 */
  _lockedByFullscreen: boolean
}

/**
 * 预热槽位里存的东西
 *
 * 「上一首 / 下一首」各一个：搜索 + 播放地址都问好了放在这儿，
 * 真正切歌时主进程直接命中缓存，剩下的只是本地换源。
 */
export interface WarmInfo {
  /** 搜索键（toSearchKey），用来判断槽位是不是过期了 */
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
