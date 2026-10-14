/**
 * preload 暴露给渲染进程的 api 契约（主 / 渲染共用）
 *
 * 为什么需要这个文件：
 *   preload 的 api 类型虽然可以直接从 electron/preload/index.ts 用
 *   `typeof api` 推导出来，但那个文件 import 了 'electron'，
 *   而渲染进程的 tsconfig 里没有（也不该有）electron 的类型。
 *   如果渲染进程直接引用它，就会因为找不到 electron 模块而推导失败，
 *   window.electronAPI 变成 any、TS 提示全部丢失。
 *
 * 所以这里把「契约」单独抽出来，它只依赖 common 里的纯类型：
 *   - preload 的实现用 `satisfies RendererAPI` 做一致性校验
 *   - 渲染进程用这个契约来扩展 window
 * 两边都指向同一份定义，任何一边漏实现/写错签名都会立刻报错。
 */
import type { AppSetting } from './app_setting'
import type {
  DragOffset,
  ParsedVideoInfo,
  RemoveListener,
  TrayMenuAction,
  TrayMenuState,
  TrayState,
  UserInfo,
} from './ipc'

/** 窗口可用区域（避免为了一个矩形把 electron 类型引进渲染进程） */
export interface ScreenWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface RendererAPI {
  // #region 配置（主进程接管，渲染进程只拿副本）
  getSetting: () => Promise<AppSetting>
  updateSetting: (partial: Partial<AppSetting>) => Promise<AppSetting>
  resetSetting: () => Promise<AppSetting>
  onSettingUpdate: (cb: (setting: Partial<AppSetting>) => void) => RemoveListener
  // #endregion

  // #region 登录
  startLogin: () => Promise<void>
  setLoggedIn: (loggedIn: boolean) => Promise<void>
  executeLogout: () => Promise<void>
  onLogout: (cb: () => void) => RemoveListener
  onLoginSuccess: (cb: () => void) => RemoveListener
  // #endregion

  // #region 托盘
  trayUpdateState: (state: TrayState) => Promise<void>
  onTrayPlayControl: (cb: () => void) => RemoveListener
  onTrayPrev: (cb: () => void) => RemoveListener
  onTrayNext: (cb: () => void) => RemoveListener
  onTrayToggleMode: (cb: () => void) => RemoveListener
  /** 托盘菜单进度条：0~1 的比例 */
  onTraySeek: (cb: (ratio: number) => void) => RemoveListener
  /** 托盘菜单音量：0~100 */
  onTrayVolume: (cb: (volume: number) => void) => RemoveListener
  onTrayToggleMute: (cb: () => void) => RemoveListener
  onTrayShowPlaylist: (cb: () => void) => RemoveListener
  onTrayShowLogoutConfirm: (cb: () => void) => RemoveListener
  /** 左键点了托盘图标：让界面解锁（没锁时无事发生） */
  onTrayUnlock: (cb: () => void) => RemoveListener
  // #endregion

  // #region 自绘托盘菜单（菜单窗口用它渲染与回报尺寸；主窗口用 visibility 吞掉合成点击）
  trayMenuGetState: () => Promise<TrayMenuState>
  /** value 用于进度（0~1）与音量（0~100） */
  trayMenuAction: (action: TrayMenuAction, value?: number) => Promise<void>
  trayMenuReady: (height: number) => Promise<void>
  trayMenuClose: () => Promise<void>
  onTrayMenuState: (cb: (state: TrayMenuState) => void) => RemoveListener
  onTrayMenuVisibility: (cb: (visible: boolean) => void) => RemoveListener
  // #endregion

  // #region 任务栏进度（0~1，<0 清除；paused 用「已暂停」样式）
  setProgress: (progress: number, paused: boolean) => Promise<void>
  // #endregion

  // #region B 站接口
  getUserInfo: () => Promise<UserInfo>
  /** skipCache=true 用于视频列表的刷新按钮（真的重搜，同时保住已解析的播放地址） */
  searchSong: (keyword: string, skipCache?: boolean) => Promise<{ data: unknown }>
  /** 「添加视频」：解析 B 站链接 / BV 号 */
  parseVideo: (input: string) => Promise<ParsedVideoInfo>
  /**
   * 收藏 / 取消收藏；返回收藏后的完整 bvid 列表（顺序由主进程的 ord 决定）
   *
   * 收藏会把该条挪到第一位，取消收藏**位置不动**。
   */
  setFavorite: (
    searchKey: string,
    bvid: string,
    favorite: boolean,
  ) => Promise<{ favorites: string[] }>
  /** 某首歌收藏的 bvid 列表 */
  getFavoriteBvids: (searchKey: string) => Promise<string[]>
  /** 某首歌上次播的视频 bvid；没有记录返回 null */
  getSelectedBvid: (searchKey: string) => Promise<string | null>
  /** 注意：没有 setSelectedBvid —— 写入由 resolveVideoUrl 内部完成 */
  resolveVideoUrl: (
    bvid: string,
    keyword?: string,
    skipCache?: boolean,
    noDash?: boolean,
    qn?: number,
    audioId?: number,
  ) => Promise<{
    /** durl（渐进式 mp4）地址；走 dash 时为 null */
    videoUrl: string | null
    /** dash 双轨（音视频分开，需要 MSE 合成）；走 durl 时为 null */
    dash?: import('./ipc').DashStreamsPayload | null
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
    /** 这个视频当前可选的清晰度 / 音质 */
    options?: import('./ipc').QualityOptionsPayload | null
    error?: string
  }>
  /** 解析各大音乐平台的歌单分享链接（移植自 LX 的 musicSdk） */
  getPlaylistDetail: (
    params: import('./musicSdk').GetPlaylistDetailParams,
  ) => Promise<import('./musicSdk').PlaylistDetail>
  // #endregion

  // #region 歌单 / 缓存
  /** 读取歌单集合（多歌单） */
  getPlaylists: () => Promise<import('./playlist').PlaylistStoreData>
  /** 整体保存歌单集合（增删改后调用） */
  savePlaylists: (
    params: import('./playlist').PlaylistSaveParams,
  ) => Promise<import('./playlist').PlaylistStoreData>
  /** 同步指定歌单，返回每个歌单的结果 */
  syncPlaylists: (ids: string[]) => Promise<import('./playlist').SyncResult[]>
  clearCache: () => Promise<boolean>
  /** 缓存统计（视频条数 / 近似占用字节） */
  getCacheStats: () => Promise<import('./cache_stats').CacheStats>
  /** 手动触发一次过期清理（只清播放地址，不删行） */
  pruneCache: () => Promise<import('./cache_stats').CacheStats>
  // #endregion

  // #region 窗口
  winMinimize: () => Promise<void>
  winMaximize: () => Promise<void>
  winClose: () => Promise<void>
  winIsMaximized: () => Promise<boolean>
  winToggleFullscreen: () => Promise<boolean>
  winIsFullscreen: () => Promise<boolean>
  winStartDrag: () => Promise<DragOffset | null>
  winMoveWindow: (x: number, y: number) => Promise<void>
  winGetScreenWorkArea: () => Promise<ScreenWorkArea | null>
  onMaximized: (cb: (val: boolean) => void) => RemoveListener
  onFullscreen: (cb: (val: boolean) => void) => RemoveListener
  // #endregion

  // #region 应用
  /** 用系统默认浏览器打开链接（只允许 http/https） */
  openExternal: (url: string) => Promise<boolean>
  // #endregion

  // #region 壁纸
  wallpaperToggle: () => Promise<boolean>
  wallpaperIsEnabled: () => Promise<boolean>
  onWallpaperState: (cb: (enabled: boolean) => void) => RemoveListener
  /** 壁纸模式不可用时收到原因（原生层加载失败 / 找不到桌面壁纸层等），用于给用户提示 */
  onWallpaperUnavailable: (cb: (reason: string) => void) => RemoveListener
  // #endregion
}
