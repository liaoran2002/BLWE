/**
 * IPC 类型工具 —— 主 / 渲染进程共用
 *
 * 参考 LX Music 的 src/common/types/ipc_main.d.ts 与 ipc_renderer.d.ts
 *
 * 设计要点：
 * 1. 所有 invoke 统一走「单个 payload 对象」而不是多参数，
 *    这样主进程与渲染进程的类型签名能一一对应，避免参数顺序写错。
 * 2. 用一个 ChannelMap 集中描述「频道 -> (入参, 返回值)」，
 *    渲染进程侧的 api.updateSetting 就能自动拿到正确的参数与返回值类型，
 *    从而彻底消除手写 api 层的 any。
 */

// 方便调用方直接从本模块拿到配置类型
export type { AppSetting } from './app_setting'

/**
 * 「添加视频」解析出来的信息（主进程 -> 渲染层）
 *
 * 放在这里而不是 import biliApi 的类型：biliApi 是主进程模块，
 * 渲染层的类型链路不该把它拖进来。
 */
export interface ParsedVideoInfo {
  bvid: string
  title: string
  pic: string | null
  author: string | null
  /** 时长（秒） */
  duration: number | null
}

/**
 * dash 双轨（主进程 -> 渲染层）
 *
 * dash 的视频和音频是两条独立的流，只给一条会没有声音，
 * 渲染层用 MSE 把它们合成到同一个 `<video>` 上。
 */
export interface DashStreamsPayload {
  videoUrl: string
  audioUrl: string
  /** SourceBuffer 的 MIME，例如 `video/mp4; codecs="avc1.640032"` */
  videoMime: string
  audioMime: string
  /** dash 总时长（秒）；分片 MP4 的 mvhd 常为 0，MSE 需要它补 MediaSource.duration */
  duration: number | null
  /** 视频轨清晰度代码，便于排查 */
  videoId: number | null
  /** 音频流 id（例如 30280），便于展示 / 切换 */
  audioId: number | null
}

/** 可选档位（清晰度 / 音质），主进程 -> 渲染层 */
export interface QualityOptionPayload {
  id: number
  label: string
  description: string
}

/** 某个视频当前可选的清晰度 / 音质 */
export interface QualityOptionsPayload {
  video: QualityOptionPayload[]
  audio: QualityOptionPayload[]
}

/** IPC 频道契约：channel -> { params, result } */
export interface IpcChannelMap {
  // #region setting（主进程接管配置）
  'setting:get': { params: void; result: import('./app_setting').AppSetting }
  'setting:update': {
    params: Partial<import('./app_setting').AppSetting>
    result: import('./app_setting').AppSetting
  }
  'setting:reset': { params: void; result: import('./app_setting').AppSetting }
  // #endregion

  // #region window
  'win:minimize': { params: void; result: void }
  'win:maximize': { params: void; result: void }
  'win:close': { params: void; result: void }
  'win:isMaximized': { params: void; result: boolean }
  'win:toggleFullscreen': { params: void; result: boolean }
  'win:isFullscreen': { params: void; result: boolean }
  'win:startDrag': { params: void; result: DragOffset | null }
  'win:moveWindow': { params: { x: number; y: number }; result: void }
  'win:getScreenWorkArea': { params: void; result: Electron.Rectangle | null }
  // #endregion

  // #region auth
  'auth:startLogin': { params: void; result: void }
  'auth:setLoggedIn': { params: { loggedIn: boolean }; result: void }
  'auth:executeLogout': { params: void; result: void }
  // #endregion

  // #region app
  /** 用系统默认浏览器打开链接（只允许 http/https），返回是否真的打开了 */
  'app:openExternal': { params: { url: string }; result: boolean }
  // #endregion

  // #region bilibili api
  'api:getUserInfo': { params: void; result: UserInfo }
  'api:searchSong': {
    params: {
      keyword: string
      /** 视频列表的刷新按钮：绕过缓存真的重搜（同时会与旧条目合并，保住已解析的地址） */
      skipCache?: boolean
    }
    result: { data: unknown }
  }
  /** 「添加视频」：解析 B 站链接 / BV 号，取回标题、封面、UP 主 */
  'api:parseVideo': { params: { input: string }; result: ParsedVideoInfo }
  /**
   * 收藏 / 取消收藏某个视频
   *
   * 返回**收藏后的完整 bvid 列表**（而不是 void）：收藏会重排顺序，
   * 界面拿列表直接刷新就行，不用自己猜「它现在排第几」——
   * 顺序由主进程的 `videos.ord` 决定，只有它知道权威结果。
   */
  'api:setFavorite': {
    params: { searchKey: string; bvid: string; favorite: boolean }
    result: { favorites: string[] }
  }
  /** 某首歌收藏的 bvid 列表（按收藏顺序，第一个排最前） */
  'api:getFavoriteBvids': { params: { searchKey: string }; result: string[] }
  /** 某首歌上次播的视频 bvid；没有记录返回 null（调用方回落到搜索结果第一条） */
  'api:getSelectedBvid': { params: { searchKey: string }; result: string | null }
  /*
   * 注意这里**没有** `api:setSelectedBvid`。
   *
   * 写入完全由 `api:resolveVideo` 内部完成（每次真正切到某个视频时一行 upsert）。
   * 曾经有过一个独立的 set 频道，是给「渲染层在切歌前 / 退出时集中写一次」用的 ——
   * 那是 JSON 时代的省写盘手段（每写一次都要重写整个候选列表），
   * 换 SQLite 之后按主键更新一行就够了，那个频道随之删掉（已无调用方）。
   */
  'api:resolveVideo': {
    params: {
      bvid: string
      keyword?: string
      skipCache?: boolean
      /** 强制不用 dash（dash 播放失败后兜底成 durl 720P） */
      noDash?: boolean
      /** 指定清晰度（qn）；不传则用设置里的默认值 */
      qn?: number
      /** 指定音质（dash 音频流 id）；不传则用设置里的默认值 */
      audioId?: number
    }
    result: {
      /** durl（渐进式 mp4）地址；走 dash 时为 null */
      videoUrl: string | null
      /** dash 双轨（音视频分开，需要 MSE 合成）；走 durl 时为 null */
      dash?: DashStreamsPayload | null
      /** 正在解析的这个视频的标题（权威值，渲染层不必再去列表里找） */
      title?: string | null
      /** 正在解析的这个视频的封面 */
      pic?: string | null
      /** 正在解析的这个视频的清晰度短标签，例如 1080P / 4K */
      quality?: string | null
      /** 清晰度完整描述，例如 1080P 高清 / 1080P 60帧 */
      qualityDesc?: string | null
      /** 实际在播的音质短标签，例如 192K */
      audioQuality?: string | null
      /** 音质完整描述，例如 192K 高音质 */
      audioQualityDesc?: string | null
      /** 这个视频当前可选的清晰度 / 音质（用于播放器上的切换菜单） */
      options?: QualityOptionsPayload | null
      error?: string
    }
  }
  // #endregion

  // #region 音乐平台歌单解析（移植自 LX 的 musicSdk）
  'music:getPlaylistDetail': {
    params: import('./musicSdk').GetPlaylistDetailParams
    result: import('./musicSdk').PlaylistDetail
  }
  // #endregion

  // #region playlist
  /** 读取歌单集合 */
  'playlists:get': { params: void; result: import('./playlist').PlaylistStoreData }
  /** 整体保存歌单集合（增删改后调用） */
  'playlists:save': {
    params: import('./playlist').PlaylistSaveParams
    result: import('./playlist').PlaylistStoreData
  }
  /** 同步指定歌单（重新解析曲目；重复歌曲由主进程固定去重） */
  'playlists:sync': {
    params: { ids: string[] }
    result: import('./playlist').SyncResult[]
  }
  // #endregion

  // #region cache
  /** 清空全部缓存（videos + song_meta：收藏与播放地址一起清） */
  'cache:clearAll': { params: void; result: boolean }
  /** 缓存统计（视频条数 / 近似占用字节） */
  'cache:getStats': {
    params: void
    result: import('./cache_stats').CacheStats
  }
  /** 手动触发一次过期清理（**只清播放地址，不删行**） */
  'cache:prune': {
    params: void
    result: import('./cache_stats').CacheStats
  }
  // #endregion

  // #region wallpaper / tray
  'wallpaper:toggle': { params: void; result: boolean }
  'wallpaper:isEnabled': { params: void; result: boolean }
  'tray:updateState': { params: TrayState; result: void }
  /** 自绘托盘菜单：取一次当前状态（播放 / 循环 / 登录 / 壁纸） */
  'trayMenu:getState': { params: void; result: TrayMenuState }
  /** 自绘托盘菜单：执行一个动作；value 用于进度（0~1）与音量（0~100） */
  'trayMenu:action': { params: { action: TrayMenuAction; value?: number }; result: void }
  /** 自绘托盘菜单：页面量好自己的高度后回报，主进程据此定位并显示 */
  'trayMenu:ready': { params: { height: number }; result: void }
  /** 自绘托盘菜单：收起 */
  'trayMenu:close': { params: void; result: void }
  /**
   * 任务栏播放进度
   *
   * progress 0~1；小于 0 表示清除进度条。paused 为真时 Windows 会画成「已暂停」样式。
   */
  'window:setProgress': { params: { progress: number; paused: boolean }; result: void }
  // #endregion
}

/** 可从 ChannelMap 推导出的合法频道名 */
export type IpcChannel = keyof IpcChannelMap

/** 取某频道的入参类型 */
export type IpcParams<C extends IpcChannel> = IpcChannelMap[C]['params']
/** 取某频道的返回值类型 */
export type IpcResult<C extends IpcChannel> = IpcChannelMap[C]['result']

/**
 * 主进程 -> 渲染进程的广播频道契约
 */
export interface IpcEventMap {
  /** 配置更新广播（多窗口同步的核心） */
  'setting:update': Partial<import('./app_setting').AppSetting>
  'auth:logout': void
  'auth:loginSuccess': void
  'tray:playControl': void
  'tray:prev': void
  'tray:next': void
  'tray:toggleMode': void
  'tray:showPlaylist': void
  'tray:showLogoutConfirm': void
  /**
   * 左键点了托盘图标：让界面解锁
   *
   * 锁定状态只在渲染层，主进程不知道也不该去猜，所以这里只是「通知一下」，
   * 渲染层没锁就什么都不做（`toggleLock(false)` 本身是幂等的）。
   */
  'tray:unlock': void
  /** 托盘菜单拖动进度条：payload 是 0~1 的比例 */
  'tray:seek': number
  /** 托盘菜单调音量：payload 是 0~100 */
  'tray:volume': number
  /** 托盘菜单点音量图标：静音开关 */
  'tray:toggleMute': void
  'wallpaper:state': boolean
  /**
   * 壁纸模式不可用（原生层加载失败 / 找不到 WorkerW 等）
   *
   * 以前这种情况是完全静默的：点了按钮没反应、也没有任何日志，
   * 用户根本不知道是「环境不支持」还是「程序坏了」。现在把原因报给渲染层弹提示。
   */
  'wallpaper:unavailable': string
  'window:maximized': boolean
  'window:fullscreen': boolean
  /**
   * 自绘托盘菜单弹出状态
   *
   * 为什么要广播：壁纸模式开着鼠标转发，用户点菜单项时壁纸窗口**同时**会收到
   * 一次同坐标的合成点击。菜单打开期间主窗口要靠这个标志把点击吞掉，
   * 免得误触到控制栏。
   */
  'trayMenu:visibility': boolean
  /** 主进程把最新状态推给托盘菜单窗口 */
  'trayMenu:state': TrayMenuState
}

export type IpcEvent = keyof IpcEventMap
export type IpcEventPayload<E extends IpcEvent> = IpcEventMap[E]

/** 取消监听函数 */
export type RemoveListener = () => void

export interface DragOffset {
  offsetX: number
  offsetY: number
}

export interface UserInfo {
  face: string
  name: string
}


export interface TrayState {
  paused?: boolean
  /** 当前循环模式（字符串枚举，见 PLAY_LOOP_MODES） */
  loopMode?: string
  /** 当前在播什么（`歌曲名 - 歌手名`），托盘提示与菜单顶部都用它 */
  title?: string
  /** 当前播放位置（秒）——托盘菜单里的进度条要 */
  position?: number
  /** 视频总时长（秒） */
  duration?: number
  /** 当前音量（0~100） */
  volume?: number
  muted?: boolean
  /**
   * 渲染层认定的登录态
   *
   * 一起带上是防漂移：主进程那份 `isLoggedIn` 只由 `auth:setLoggedIn` 改，
   * 万一哪次没同步到，托盘菜单就会把「退出登录」显示成「登录」。
   */
  isLoggedIn?: boolean
}

/**
 * 自绘托盘菜单能执行的动作
 *
 * 菜单是一个迷你控制台：进度条 / 音量 / 上一首 / 播放暂停 / 下一首 / 循环模式，
 * 再加设置歌单、壁纸模式、退出登录、退出程序。
 */
export type TrayMenuAction =
  | 'playControl'
  | 'prev'
  | 'next'
  | 'toggleMode'
  | 'showPlaylist'
  | 'toggleWallpaper'
  /** 窗口被收到托盘里时用它把窗口叫回来（菜单里那一项会变成「恢复窗口」） */
  | 'restoreWindow'
  /** 进度条：value = 0~1 的比例 */
  | 'seek'
  /** 音量：value = 0~100 */
  | 'volume'
  /** 静音开关 */
  | 'toggleMute'
  | 'login'
  | 'logout'
  | 'quit'

/** 自绘托盘菜单渲染时要的状态 */
export interface TrayMenuState {
  paused: boolean
  /** 当前循环模式下标（与 PLAY_LOOP_MODES 对应） */
  loopModeIndex: number
  /** 当前循环模式的展示名 */
  loopModeName: string
  isLoggedIn: boolean
  wallpaperEnabled: boolean
  /** 主窗口是不是被藏起来了（关闭到托盘）——菜单那一项要显示「恢复窗口」 */
  windowHidden: boolean
  /** 当前在播什么（`歌曲名 - 歌手名`）；空表示没在播 */
  title: string
  /** 当前播放位置（秒） */
  position: number
  /** 视频总时长（秒） */
  duration: number
  /** 当前音量（0~100） */
  volume: number
  muted: boolean
}
