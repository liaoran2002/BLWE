/**
 * preload
 *
 * 手写 preload：在 contextIsolation 开启的前提下，通过 contextBridge
 * 把主题化、类型化的 api 暴露到 window.electronAPI。
 *
 * 类型链路：
 *   electron/common/types/ipc.ts 的 IpcChannelMap
 *     -> rendererInvoke / rendererOn 自动推导出入参与返回值
 *     -> electron/preload/index.d.ts 扩展 window
 *     -> 渲染进程调用 window.electronAPI.xxx 时自动获得 TS 提示
 *
 * 因此渲染进程侧不再需要手写一层 any 转发（见 src/api/electron.ts）。
 */
import { contextBridge, webUtils } from 'electron'
import { rendererInvoke, rendererOn } from '@common/rendererIpc'
import type {
  AppSetting,
  DragOffset,
  IpcChannelMap,
  ParsedVideoInfo,
  RemoveListener,
  TrayMenuAction,
  TrayMenuState,
  TrayState,
  UserInfo,
} from '@common/types/ipc'
import type { RendererAPI, ScreenWorkArea } from '@common/types/api'
import type { GetPlaylistDetailParams } from '@common/types/musicSdk'
import type {
  PlaylistRecord,
  PlaylistSaveParams,
  PlaylistStoreData,
  SyncResult,
  DropInputTarget,
  ParsedListInput,
  VideoListKind,
  VideoListItem,
  VideoListSyncMode,
  VideoListRecord,
  VideoListSyncResult,
  VideoImportPreview,
  VideoMetaInput,
} from '@common/types/playlist'
import type { CacheStats } from '@common/types/cache_stats'

/** 暴露给渲染进程的 api：每个方法都从 IpcChannelMap 推导出入参与返回值 */
const api = {
  // #region 配置（主进程接管，渲染进程只拿副本）
  getSetting: (): Promise<AppSetting> => rendererInvoke('setting:get'),
  updateSetting: (partial: Partial<AppSetting>): Promise<AppSetting> =>
    rendererInvoke('setting:update', partial),
  resetSetting: (): Promise<AppSetting> => rendererInvoke('setting:reset'),
  /** 监听配置更新广播（多窗口同步） */
  onSettingUpdate: (cb: (setting: Partial<AppSetting>) => void): RemoveListener =>
    rendererOn('setting:update', cb),
  // #endregion

  // #region 登录
  startLogin: (): Promise<void> => rendererInvoke('auth:startLogin'),
  setLoggedIn: (loggedIn: boolean): Promise<void> =>
    rendererInvoke('auth:setLoggedIn', { loggedIn }),
  executeLogout: (): Promise<void> => rendererInvoke('auth:executeLogout'),
  onLogout: (cb: () => void): RemoveListener => rendererOn('auth:logout', cb),
  onLoginSuccess: (cb: () => void): RemoveListener => rendererOn('auth:loginSuccess', cb),
  // #endregion

  // #region 托盘
  trayUpdateState: (state: TrayState): Promise<void> =>
    rendererInvoke('tray:updateState', state),
  onTrayPlayControl: (cb: () => void): RemoveListener => rendererOn('tray:playControl', cb),
  onTrayPrev: (cb: () => void): RemoveListener => rendererOn('tray:prev', cb),
  onTrayNext: (cb: () => void): RemoveListener => rendererOn('tray:next', cb),
  onTrayToggleMode: (cb: () => void): RemoveListener => rendererOn('tray:toggleMode', cb),
  /** 托盘菜单进度条：payload 是 0~1 的比例 */
  onTraySeek: (cb: (ratio: number) => void): RemoveListener => rendererOn('tray:seek', cb),
  /** 托盘菜单音量：payload 是 0~100 */
  onTrayVolume: (cb: (volume: number) => void): RemoveListener => rendererOn('tray:volume', cb),
  onTrayToggleMute: (cb: () => void): RemoveListener => rendererOn('tray:toggleMute', cb),
  onTrayShowPlaylist: (cb: () => void): RemoveListener => rendererOn('tray:showPlaylist', cb),
  onTrayShowSleepTimer: (cb: () => void): RemoveListener => rendererOn('tray:showSleepTimer', cb),
  onTrayShowLogoutConfirm: (cb: () => void): RemoveListener =>
    rendererOn('tray:showLogoutConfirm', cb),
  /** 左键点了托盘图标：让界面解锁（没锁时无事发生） */
  onTrayUnlock: (cb: () => void): RemoveListener => rendererOn('tray:unlock', cb),
  // #endregion

  // #region 自绘托盘菜单
  trayMenuGetState: (): Promise<TrayMenuState> => rendererInvoke('trayMenu:getState'),
  trayMenuAction: (action: TrayMenuAction, value?: number): Promise<void> =>
    rendererInvoke('trayMenu:action', { action, value }),
  trayMenuReady: (height: number): Promise<void> => rendererInvoke('trayMenu:ready', { height }),
  trayMenuClose: (): Promise<void> => rendererInvoke('trayMenu:close'),
  onTrayMenuState: (cb: (state: TrayMenuState) => void): RemoveListener =>
    rendererOn('trayMenu:state', cb),
  onTrayMenuVisibility: (cb: (visible: boolean) => void): RemoveListener =>
    rendererOn('trayMenu:visibility', cb),
  // #endregion


  // #region 任务栏进度
  setProgress: (progress: number, paused: boolean): Promise<void> =>
    rendererInvoke('window:setProgress', { progress, paused }),
  // #endregion

  // #region某站接口
  getUserInfo: (): Promise<UserInfo> => rendererInvoke('api:getUserInfo'),
  searchSong: (song: string, singer: string, skipCache = false): Promise<{ data: unknown }> =>
    rendererInvoke('api:searchSong', { song, singer, skipCache }),
  /** 「添加视频」：解析某站链接 / BV 号 */
  parseVideo: (input: string): Promise<ParsedVideoInfo> =>
    rendererInvoke('api:parseVideo', { input }),
  /** 收藏 / 取消收藏；返回值是收藏后的完整列表（顺带刷新界面顺序） */
  setFavorite: (
    cacheKey: string,
    bvid: string,
    favorite: boolean,
  ): Promise<{ favorites: string[] }> =>
    rendererInvoke('api:setFavorite', { cacheKey, bvid, favorite }),
  /** ★ 补一条视频的时长（搜索接口没给时长时，播放后补上并回写库） */
  fillVideoDuration: (cacheKey: string, bvid: string, duration: number): Promise<void> =>
    rendererInvoke('api:fillVideoDuration', { cacheKey, bvid, duration }),
  getSelectedBvid: (cacheKey: string): Promise<string | null> =>
    rendererInvoke('api:getSelectedBvid', { cacheKey }),
  resolveVideoUrl: (
    bvid: string,
    keyword?: string,
    skipCache?: boolean,
    noDash?: boolean,
    qn?: number,
    audioId?: number,
  ): Promise<IpcChannelMap['api:resolveVideo']['result']> =>
    rendererInvoke('api:resolveVideo', { bvid, keyword, skipCache, noDash, qn, audioId }),
  /** 解析各大音乐平台的歌单分享链接（wy / tx / kw） */
  getPlaylistDetail: (
    params: GetPlaylistDetailParams,
  ): Promise<IpcChannelMap['music:getPlaylistDetail']['result']> =>
    rendererInvoke('music:getPlaylistDetail', params),
  /** 拖入歌单链接：导入（已有则同步）并设为当前 —— 会写库 */
  importMusicPlaylist: (url: string): Promise<IpcChannelMap['music:importPlaylist']['result']> =>
    rendererInvoke('music:importPlaylist', { url }),
  /** 拖入单曲链接：追加进默认歌单并把它设为当前 —— 会写库 */
  importMusicSong: (url: string): Promise<IpcChannelMap['music:importSong']['result']> =>
    rendererInvoke('music:importSong', { url }),
  // #endregion

  // #region 歌单 / 缓存
  /** 歌单集合（多歌单） */
  getPlaylists: (): Promise<PlaylistStoreData> => rendererInvoke('playlists:get'),
  savePlaylists: (params: PlaylistSaveParams): Promise<PlaylistStoreData> =>
    rendererInvoke('playlists:save', params),
  syncPlaylists: (ids: string[]): Promise<SyncResult[]> =>
    rendererInvoke('playlists:sync', { ids }),
  /** 把平台歌单转成本地歌单（不可逆，返回的记录 id 已经变了） */
  convertPlaylistToLocal: (id: string): Promise<PlaylistRecord> =>
    rendererInvoke('playlists:convertToLocal', { id }),
  clearCache: (): Promise<boolean> => rendererInvoke('cache:clearAll'),
  getCacheStats: (): Promise<CacheStats> => rendererInvoke('cache:getStats'),
  pruneCache: (): Promise<CacheStats> => rendererInvoke('cache:prune'),
  // #endregion

  // #region某站视频列表（收藏夹 / 合集 / 系列）
  parseListInput: (text: string): Promise<ParsedListInput | null> =>
    rendererInvoke('api:parseListInput', { text }),
  /** 拖入识别：音乐歌单 /某站列表 / 单条视频 / 没认出来（不联网、不写库） */
  classifyDrop: (text: string): Promise<DropInputTarget> =>
    rendererInvoke('api:classifyDrop', { text }),
  fetchMyFavFolders: (): Promise<
    Array<{ id: string; title: string; count: number; cover: string | null }>
  > => rendererInvoke('api:myFavFolders'),
  /** 「订阅合集」：我收藏的合集（主进程只回 `type = 21` 的那些） */
  fetchMySubLists: (): Promise<
    Array<{
      kind: 'season' | 'series'
      id: string
      mid: string
      title: string
      count: number
      cover: string | null
    }>
  > => rendererInvoke('api:mySubLists'),
  getVideoLists: (): Promise<VideoListRecord[]> => rendererInvoke('videolists:list'),
  addVideoList: (input: {
    kind: VideoListKind
    sourceId: string
    mid?: string
  }): Promise<{ record: VideoListRecord; skipped: number; existed: boolean }> =>
    rendererInvoke('videolists:add', input),
  removeVideoList: (id: string): Promise<boolean> =>
    rendererInvoke('videolists:remove', { id }),
  createLocalVideoList: (name?: string): Promise<VideoListRecord> =>
    rendererInvoke('videolists:createLocal', { name }),
  renameVideoList: (id: string, name: string): Promise<boolean> =>
    rendererInvoke('videolists:rename', { id, name }),
  /** 「添加视频」第一步：解析成预览数据（不写库），界面拿它做确认框 */
  previewVideoImport: (input: string): Promise<VideoImportPreview> =>
    rendererInvoke('videolists:previewImport', { input }),
  /** 第二步（单条）：把确认过的那一条放进本地列表（置顶） */
  addVideoListItem: (
    id: string,
    item: VideoMetaInput,
  ): Promise<IpcChannelMap['videolists:addItem']['result']> =>
    rendererInvoke('videolists:addItem', { id, item }),
  /** 第二步（批量）：把确认过的一批追加到本地列表末尾 */
  addVideoListItems: (
    id: string,
    items: VideoMetaInput[],
  ): Promise<IpcChannelMap['videolists:addItems']['result']> =>
    rendererInvoke('videolists:addItems', { id, items }),
  /** 平台列表 → 本地列表（换 id；调用方要重映射正在播的那个 id） */
  convertVideoListToLocal: (
    id: string,
  ): Promise<IpcChannelMap['videolists:convertToLocal']['result']> =>
    rendererInvoke('videolists:convertToLocal', { id }),
  setVideoListSyncMode: (
    id: string,
    mode: VideoListSyncMode,
    intervalMs = 0,
  ): Promise<boolean> => rendererInvoke('videolists:setSyncMode', { id, mode, intervalMs }),
  /** 拖入单条视频：放进默认列表（没有就现建），返回落点供播放 */
  addVideoItemToDefault: (
    input: string,
  ): Promise<IpcChannelMap['videolists:addItemToDefault']['result']> =>
    rendererInvoke('videolists:addItemToDefault', { input }),
  /**
   * 拖入本地视频文件：登记 + 挂进默认列表，返回带 `url` 的条目供探针与起播
   */
  importLocalVideoFiles: (
    paths: string[],
  ): Promise<IpcChannelMap['videolists:importLocal']['result']> =>
    rendererInvoke('videolists:importLocal', { paths }),
  /**
   * 拖进来的 `File` → 真实磁盘路径
   *
   * **必须走 preload 的 `webUtils`**：Electron 32 起 `File.path` 已被移除
   * （安全考虑），渲染层拿到的 File 上没有任何路径信息。
   *
   * 这个函数是**同步**的、也没有 IPC —— `webUtils.getPathForFile` 只是查一下
   * 拖拽数据里那条系统路径，不跨进程。失败返回空串，调用方按「没认出」处理。
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  removeVideoListItem: (id: string, bvid: string): Promise<boolean> =>
    rendererInvoke('videolists:removeItem', { id, bvid }),
  setVideoListItemFavorite: (id: string, bvid: string, favorite: boolean): Promise<void> =>
    rendererInvoke('videolists:setFavorite', { id, bvid, favorite }),
  syncVideoList: (id: string): Promise<VideoListSyncResult> =>
    rendererInvoke('videolists:sync', { id }),
  getVideoListItems: (id: string): Promise<VideoListItem[]> =>
    rendererInvoke('videolists:getItems', { id }),
  setVideoListIndex: (id: string, index: number): Promise<void> =>
    rendererInvoke('videolists:setIndex', { id, index }),
  // #endregion

  // #region 本地视频文件（丢了之后怎么救）
  /** 弹系统对话框选一个视频文件；用户取消返回空串 */
  pickLocalVideo: (currentPath?: string): Promise<string> =>
    rendererInvoke('local:pickVideo', { currentPath }),
  /** 重新定位（改 `durl_url`，bvid 不变 → 列表位置 / 收藏 / 续播都保留） */
  relocateLocalVideo: (
    bvid: string,
    newPath: string,
  ): Promise<IpcChannelMap['local:relocate']['result']> =>
    rendererInvoke('local:relocate', { bvid, newPath }),
  /** 文件此刻还在不在（`<video>` 报错后用它区分「丢了」和「解码不支持」） */
  localVideoExists: (bvid: string): Promise<{ exists: boolean; filePath: string | null }> =>
    rendererInvoke('local:exists', { bvid }),
  // #endregion

  // #region 窗口
  winMinimize: (): Promise<void> => rendererInvoke('win:minimize'),
  winMaximize: (): Promise<void> => rendererInvoke('win:maximize'),
  winClose: (): Promise<void> => rendererInvoke('win:close'),
  /** ★ 真正退出应用（不受「关闭到托盘」影响）—— 定时关闭用它 */
  winQuit: (): Promise<void> => rendererInvoke('win:quit'),
  winIsMaximized: (): Promise<boolean> => rendererInvoke('win:isMaximized'),
  winToggleFullscreen: (): Promise<boolean> => rendererInvoke('win:toggleFullscreen'),
  winIsFullscreen: (): Promise<boolean> => rendererInvoke('win:isFullscreen'),
  winStartDrag: (): Promise<DragOffset | null> => rendererInvoke('win:startDrag'),
  winMoveWindow: (x: number, y: number): Promise<void> =>
    rendererInvoke('win:moveWindow', { x, y }),
  winGetScreenWorkArea: (): Promise<ScreenWorkArea | null> =>
    rendererInvoke('win:getScreenWorkArea'),
  onMaximized: (cb: (val: boolean) => void): RemoveListener => rendererOn('window:maximized', cb),
  onFullscreen: (cb: (val: boolean) => void): RemoveListener =>
    rendererOn('window:fullscreen', cb),
  // #endregion

  // #region 应用
  openExternal: (url: string): Promise<boolean> => rendererInvoke('app:openExternal', { url }),
  // #endregion

  // #region 壁纸
  wallpaperToggle: (): Promise<boolean> => rendererInvoke('wallpaper:toggle'),
  wallpaperIsEnabled: (): Promise<boolean> => rendererInvoke('wallpaper:isEnabled'),
  onWallpaperState: (cb: (enabled: boolean) => void): RemoveListener =>
    rendererOn('wallpaper:state', cb),
  onWallpaperUnavailable: (cb: (reason: string) => void): RemoveListener =>
    rendererOn('wallpaper:unavailable', cb),
  // #endregion
} as const satisfies RendererAPI

/**
 * preload 对外暴露的 api 类型
 *
 * `satisfies RendererAPI` 让 TS 校验这里的实现与契约完全一致：
 * 少一个方法、多一个方法、参数或返回值写错，都会在编译期报错。
 */
export type ElectronAPI = typeof api

// contextIsolation 开启时这是唯一的安全通道
contextBridge.exposeInMainWorld('electronAPI', api)
