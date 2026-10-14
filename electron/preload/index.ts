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
import { contextBridge } from 'electron'
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
import type { GetPlaylistDetailParams, PlaylistDetail } from '@common/types/musicSdk'
import type {
  PlaylistSaveParams,
  PlaylistStoreData,
  SyncResult,
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

  // #region B 站接口
  getUserInfo: (): Promise<UserInfo> => rendererInvoke('api:getUserInfo'),
  searchSong: (keyword: string, skipCache = false): Promise<{ data: unknown }> =>
    rendererInvoke('api:searchSong', { keyword, skipCache }),
  /** 「添加视频」：解析 B 站链接 / BV 号 */
  parseVideo: (input: string): Promise<ParsedVideoInfo> =>
    rendererInvoke('api:parseVideo', { input }),
  /** 收藏 / 取消收藏；返回值是收藏后的完整列表（顺带刷新界面顺序） */
  setFavorite: (
    searchKey: string,
    bvid: string,
    favorite: boolean,
  ): Promise<{ favorites: string[] }> =>
    rendererInvoke('api:setFavorite', { searchKey, bvid, favorite }),
  getFavoriteBvids: (searchKey: string): Promise<string[]> =>
    rendererInvoke('api:getFavoriteBvids', { searchKey }),
  getSelectedBvid: (searchKey: string): Promise<string | null> =>
    rendererInvoke('api:getSelectedBvid', { searchKey }),
  resolveVideoUrl: (
    bvid: string,
    keyword?: string,
    skipCache?: boolean,
    noDash?: boolean,
    qn?: number,
    audioId?: number,
  ): Promise<IpcChannelMap['api:resolveVideo']['result']> =>
    rendererInvoke('api:resolveVideo', { bvid, keyword, skipCache, noDash, qn, audioId }),
  /** 解析各大音乐平台的歌单分享链接（网易云 / QQ音乐 / 酷我音乐） */
  getPlaylistDetail: (params: GetPlaylistDetailParams): Promise<PlaylistDetail> =>
    rendererInvoke('music:getPlaylistDetail', params),
  // #endregion

  // #region 歌单 / 缓存
  /** 歌单集合（多歌单） */
  getPlaylists: (): Promise<PlaylistStoreData> => rendererInvoke('playlists:get'),
  savePlaylists: (params: PlaylistSaveParams): Promise<PlaylistStoreData> =>
    rendererInvoke('playlists:save', params),
  syncPlaylists: (ids: string[]): Promise<SyncResult[]> =>
    rendererInvoke('playlists:sync', { ids }),
  clearCache: (): Promise<boolean> => rendererInvoke('cache:clearAll'),
  getCacheStats: (): Promise<CacheStats> => rendererInvoke('cache:getStats'),
  pruneCache: (): Promise<CacheStats> => rendererInvoke('cache:prune'),
  // #endregion

  // #region 窗口
  winMinimize: (): Promise<void> => rendererInvoke('win:minimize'),
  winMaximize: (): Promise<void> => rendererInvoke('win:maximize'),
  winClose: (): Promise<void> => rendererInvoke('win:close'),
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
