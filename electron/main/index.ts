/**
 * 主进程入口
 *
 * 启动顺序（很重要，顺序错了会出现配置/缓存写到两个不同目录）：
 *   1. setupUserDataPath()  —— 最早期判断便携模式，改写 userData
 *   2. app.whenReady()
 *   3. initSetting()        —— 读盘 + 迁移 + 合并默认值
 *   4. registerIpcHandlers()
 *   5. createMainWindow() / createTray()
 */

import {
  app,
  BrowserWindow,
  dialog,
  session,
  screen,
  Tray,
  nativeImage,
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerIpcHandlers } from './ipcHandlers'
import { setupUserDataPath, isPortable } from './portable'
import {
  initSetting,
  flushSetting,
  getSetting,
  onSettingChange,
} from './utils/setting'
import * as biliApi from './biliApi'
import { initPlaylists, flushPlaylists } from './utils/playlist'
import { PLAY_LOOP_MODES } from '@common/constants'
import type { IpcEvent, IpcEventPayload, TrayMenuAction, TrayMenuState } from '@common/types/ipc'

// electron-as-wallpaper 是原生模块，且只在 Windows 有意义，加载失败不应该影响主功能
type AsWallpaper = typeof import('electron-as-wallpaper')
let asWallpaper: AsWallpaper | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  asWallpaper = require('electron-as-wallpaper') as AsWallpaper
} catch {
  asWallpaper = null
}

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isLoggedIn = false
let isPaused = true
let loopModeIndex = 0
let wallpaperEnabled = false
/** 是否正在退出应用（区分「点关闭按钮」与「真的要退出」） */
let isQuitting = false
/** 托盘悬浮提示里显示的「当前在播什么」（由渲染层同步） */
let trayTitle = ''
/** 托盘菜单进度条要用的播放位置 / 时长（秒） */
let trayPosition = 0
let trayDuration = 0
/** 托盘菜单音量按钮要用的音量与静音状态 */
let trayVolume = 70
let trayMuted = false
/** 上一次设过的 tooltip 文本，避免重复设置 */
let lastTrayTip = ''
/**
 * 是否处于「全屏」
 *
 * 关键：这是**应用层自己维护**的状态，绝对不要读 `mainWindow.isFullScreen()`。
 *
 * 主窗口是 `transparent: true`，Windows 上透明窗口的原生全屏是失效的：
 * `setFullScreen(true)` 只会把窗口撑到屏幕大小，`isFullScreen()` 依旧返回 false
 * （electron/electron#27286）。于是老代码里出现了一连串问题：
 *   - 状态被原生值回写，全屏标志永远为 false；
 *   - 退出壁纸模式时「还原」逻辑反而把窗口撑成整屏，且因为没有状态可翻转，
 *     再点全屏只会一路往「进入全屏」走，永远退不出去。
 *
 * 所以全屏改成应用层模拟：解除 16:9 约束 + setBounds 铺满主屏 + 置顶盖住任务栏。
 */
let isFullScreen = false
let isMaximized = false

/** 主窗口的宽高比约束（视频播放器保持 16:9） */
const FULLSCREEN_ASPECT = 16 / 9

const MODE_NAMES = ['列表循环', '单曲循环', '随机播放']

/** 进入全屏前的普通窗口状态，退出全屏时据此还原 */
interface FullScreenRestore {
  /** 普通窗口尺寸 */
  bounds: Electron.Rectangle
  maximized: boolean
}
let fullScreenRestore: FullScreenRestore | null = null

/** 进入壁纸模式前的窗口状态，退出壁纸时据此还原 */
interface WallpaperRestore {
  /** 进入壁纸之前是否已经是全屏 */
  fullScreen: boolean
  /** 退出壁纸后（非全屏时）要还原的普通窗口尺寸 */
  bounds: Electron.Rectangle
  maximized: boolean
}
let wallpaperRestore: WallpaperRestore | null = null


app.commandLine.appendSwitch('force-device-scale-factor', '1')

/**
 * 资源路径解析（窗口图标 / 托盘图标）
 *
 * 同一个文件在三种环境里位置不同，所以要按顺序找，不能只拼一个路径：
 *  1. 打包后：`extraResources` 把 public/ 里的图标放到了 resources/icons（**不在 asar 里**，
 *     真实文件路径，nativeImage 读起来最稳）；
 *  2. 开发期：项目根目录的 public/；
 *  3. 兜底：renderer 产物里的同名文件（Vite 会把 public/ 整个拷到 out/renderer/）。
 *
 * 等等：以前这里打包后直接拼的是 `app.getAppPath()/bili.ico`（也就是 resources/app.asar/bili.ico），
 * 那个路径根本不存在 —— 表现就是「portable 版托盘没图标、窗口图标也是空的」。
 */
const resolveAsset = (file: string): string => {
  const candidates = [
    path.join(process.resourcesPath, 'icons', file),
    path.join(app.getAppPath(), 'public', file),
    path.join(__dirname, '..', 'renderer', file),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]
}

/** 读图标：找不到 / 解不出来都要留一条日志，别静默变成空白图标 */
const loadIcon = (file: string): Electron.NativeImage => {
  const iconPath = resolveAsset(file)
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) console.warn('[icon] 图标加载失败（会是空白图标）:', iconPath)
  return icon
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 800,
    minHeight: 450,
    title: 'B站音乐视频',
    frame: false,
    center: true,
    transparent: true,
    icon: loadIcon('bili.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // contextIsolation 必须保持开启：preload 通过 contextBridge 暴露类型化 api，
      // 页面本身拿不到 ipcRenderer，这是安全边界，不做简化
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /**
       * 关掉后台节流
       *
       * 「关闭到托盘」之后窗口是隐藏的，Chromium 默认会把隐藏窗口的定时器压到约 1 次/分钟：
       * 片尾看门狗、缓冲刷新、任务栏进度都会跟着失灵。音乐播放器缩到托盘还要继续正常播，
       * 所以这里关掉节流。
       */
      backgroundThrottling: false,
    },
    show: false,
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  mainWindow.setAspectRatio(FULLSCREEN_ASPECT)

  /**
   * 导航护栏：只允许留在我们自己的页面上。
   *
   * preload 会附加到主窗口的每一次导航上，一旦被导航到站外（比如以后谁加了个外链跳转），
   * 那个源就能直接拿到整套 `electronAPI`（改配置、退登录、关窗口、开外链），
   * 而渲染层现在没有任何站外跳转需求 —— 打开外链一律走 `app:openExternal`。
   */
  const appOrigin =
    isDev && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : 'file://'
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appOrigin)) {
      event.preventDefault()
      console.warn('[win] 已拦截站外导航:', url)
    }
  })
  // 不允许弹出新窗口（外链走系统浏览器）
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    mainWindow.show()
    // 配置里的壁纸模式优先，命令行 --wallpaper-mode 作为兜底
    wallpaperEnabled =
      getSetting()['common.wallpaperMode'] || process.argv.includes('--wallpaper-mode')
    if (wallpaperEnabled) {
      // 开机即壁纸模式：applyWallpaperMode 会把此刻的普通窗口尺寸记成还原点，
      // 这样用户切回「应用程序」时能还原成正常窗口而不是被困在全屏
      void applyWallpaperMode(true).then(() => {
        sendToMain('wallpaper:state', true)
      })
    }
  })

  /**
   * 关闭按钮：按设置决定「真退出」还是「收到托盘」
   *
   * `isQuitting` 由 `before-quit` 置位 —— 否则「退出应用」菜单项 / 系统关机时
   * 也会被这里拦下来，变成永远退不掉。
   */
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    if (!getSetting()['common.closeToTray']) return
    event.preventDefault()
    mainWindow?.hide()
    // 藏起来了：托盘「恢复窗口」那一项要跟着变，tooltip 也说明一下
    refreshTray()
    console.log('[win] 已最小化到托盘（设置里关掉「关闭窗口时最小化到托盘」即可恢复直接退出）')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    /**
     * 主窗口关了就把托盘菜单窗口一起收掉。
     *
     * 否则 `window-all-closed` 永远不触发（那个自绘菜单窗口还「开着」，哪怕只是隐藏着），
     * 表现就是「点 X 之后应用没退出，进程还在后台」。
     */
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
      trayMenuWindow.destroy()
      trayMenuWindow = null
    }
  })

  mainWindow.on('maximize', () => {
    if (!mainWindow) return
    isMaximized = mainWindow.isMaximized()
    sendToMain('window:maximized', isMaximized)
  })

  mainWindow.on('unmaximize', () => {
    if (!mainWindow) return
    isMaximized = mainWindow.isMaximized()
    sendToMain('window:maximized', isMaximized)
  })

  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    // 注意：这里只同步「最大化」，不再回写 isFullScreen。
    // 全屏是应用层模拟的，窗口尺寸会被撑到整屏，
    // 一旦从原生状态回读就会把全屏标志抹成 false（老 bug 的根源之一）。
    const realMaximized = mainWindow.isMaximized()
    if (isMaximized !== realMaximized) {
      isMaximized = realMaximized
      sendToMain('window:maximized', isMaximized)
    }
  })
}

/**
 * 向主窗口发送广播（窗口不存在时静默忽略）
 *
 * 用 `mainSend` 的类型化签名 + `BROADCAST_EVENT_NAME` 里的常量：
 * 以前这里是 `channel: string`，主进程各处直接写裸字符串（`'tray:prev'` 之类），
 * 打错一个字母不报错，渲染层就永远收不到。
 */
function sendToMain<E extends IpcEvent>(event: E, payload?: IpcEventPayload<E>): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, payload)
  }
}

/**
 * 取当前窗口作为「普通窗口」时的尺寸与最大化状态
 *
 * 只在窗口不是全屏时调用：全屏是我们自己用 setBounds 撑出来的，
 * `getBounds()` / `getNormalBounds()` 都会返回整屏尺寸，不能拿来当还原点。
 */
const readNormalWindowState = (): FullScreenRestore => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { bounds: { x: 160, y: 70, width: 1600, height: 900 }, maximized: false }
  }
  const maximized = mainWindow.isMaximized()
  return {
    // 最大化时 getBounds 是工作区大小，要取 normalBounds 才是还原用的尺寸
    bounds: maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds(),
    maximized,
  }
}

/** 把窗口撑满它当前所在的那块屏（全屏的几何部分） */
const applyFullScreenGeometry = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 16:9 的宽高比约束会把 setBounds 的结果改写掉，全屏时必须先解除，
  // 否则在非 16:9 的显示器上窗口撑不满，看起来就「没全屏」
  mainWindow.setAspectRatio(0)
  // 必须按「窗口现在在哪块屏」算，写死 getPrimaryDisplay() 会把副屏上的窗口拽回主屏
  mainWindow.setBounds(screen.getDisplayMatching(mainWindow.getBounds()).bounds)
  // 不置顶的话任务栏会压在窗口上面，看起来也不像全屏
  mainWindow.setAlwaysOnTop(true)
}

/** 记录「进入全屏前」的普通窗口状态（已有记录则保留，避免被全屏几何污染） */
const captureFullScreenRestore = (): void => {
  if (fullScreenRestore) return
  fullScreenRestore = readNormalWindowState()
  console.log('[win] 记录全屏还原点:', JSON.stringify(fullScreenRestore))
}

/** 进入全屏：记还原点 + 撑满主屏 */
const enterFullScreen = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  captureFullScreenRestore()
  isFullScreen = true
  applyFullScreenGeometry()
}

/** 退出全屏：回到普通窗口（最大化则恢复最大化） */
const exitFullScreen = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  isFullScreen = false
  mainWindow.setAlwaysOnTop(false)
  mainWindow.setAspectRatio(FULLSCREEN_ASPECT)

  const point = fullScreenRestore
  fullScreenRestore = null
  if (!point) {
    // 没有记录（异常情况）：给一个合理的默认窗口尺寸，别把用户困在全屏
    mainWindow.setSize(1600, 900)
    mainWindow.center()
    return
  }
  if (point.maximized) mainWindow.maximize()
  else mainWindow.setBounds(point.bounds)
}

/** 退出壁纸模式：按壁纸还原点回到全屏 / 最大化 / 普通窗口 */
const exitWallpaperGeometry = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const point = wallpaperRestore
  wallpaperRestore = null

  if (point?.fullScreen) {
    // 进入壁纸之前本来就是全屏，退出后回到全屏
    // （fullScreenRestore 仍然有效，用户还能再按 F 退出全屏）
    isFullScreen = true
    applyFullScreenGeometry()
    return
  }

  isFullScreen = false
  mainWindow.setAlwaysOnTop(false)
  mainWindow.setAspectRatio(FULLSCREEN_ASPECT)
  if (!point) {
    // 没有记录（异常情况）：给一个合理的默认窗口尺寸，别把用户困在全屏
    mainWindow.setSize(1600, 900)
    mainWindow.center()
    return
  }
  if (point.maximized) mainWindow.maximize()
  else mainWindow.setBounds(point.bounds)
}

/** 全屏状态变化后通知渲染进程 */
const syncFullScreenState = (): void => {
  sendToMain('window:fullscreen', isFullScreen)
}

function toggleFullScreen(): void {
  // 壁纸模式下窗口几何由壁纸层接管，不允许用户再切全屏
  if (!mainWindow || mainWindow.isDestroyed() || wallpaperEnabled) return
  setFullScreenState(!isFullScreen)
}

/**
 * 把全屏状态设为指定值（幂等）
 *
 * 老实现是「翻转」语义（isFullScreen = !isFullScreen）叠加原生 setFullScreen：
 * 原生调用在透明窗口上无效，于是状态和窗口真实几何彻底脱节，
 * 出现「退出壁纸后又变成退不掉的全屏」。现在显式设定目标状态，
 * 并且全屏完全由应用层模拟（原因见 isFullScreen 的注释）。
 */
function setFullScreenState(target: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (target === isFullScreen) {
    syncFullScreenState()
    return
  }

  if (target) {
    enterFullScreen()
  } else if (wallpaperEnabled) {
    // 壁纸模式下几何由壁纸层接管，只改状态
    if (wallpaperRestore) wallpaperRestore.fullScreen = false
    isFullScreen = false
  } else {
    exitFullScreen()
  }

  syncFullScreenState()
}

/** 记录「进入壁纸模式前」的窗口状态（已有记录则保留） */
const captureWallpaperRestore = (): void => {
  if (wallpaperRestore || !mainWindow || mainWindow.isDestroyed()) return
  wallpaperRestore = isFullScreen
    ? {
        fullScreen: true,
        // 全屏时窗口尺寸就是整屏，普通尺寸要问全屏还原点
        bounds: fullScreenRestore?.bounds ?? mainWindow.getBounds(),
        maximized: fullScreenRestore?.maximized ?? false,
      }
    : { fullScreen: false, ...readNormalWindowState() }
  console.log('[wallpaper] 记录还原点:', JSON.stringify(wallpaperRestore))
}

/**
 * 应用壁纸模式
 *
 * 修复要点（老 bug）：
 *  1. **先把窗口几何铺满主屏，再挂壁纸层**。
 *     原实现是先 attach 再切全屏，挂载时窗口还是普通尺寸，
 *     所以「进了壁纸模式但没在壁纸层全屏」。
 *  2. 完全不调用原生 setFullScreen：主窗口是 `transparent: true`，
 *     Windows 上原生全屏对透明窗口无效（见 isFullScreen 的注释），
 *     改用「解除宽高比约束 + 铺满主屏 + 置顶」在应用层实现。
 *  3. 进入前用独立的 wallpaperRestore 记录窗口状态，退出时原样还原
 *     （原本是全屏就回到全屏，原本是最大化就回到最大化），
 *     不会再出现「退不出去的全屏」。
 */
async function applyWallpaperMode(enabled: boolean): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (enabled) {
    // 1) 先记住进入前的状态（已有记录则保留更早的那个）
    captureWallpaperRestore()

    // 2) 先把窗口铺满主屏 —— 必须在挂到壁纸层之前完成
    applyFullScreenGeometry()
    mainWindow.setVisibleOnAllWorkspaces(true)
    isFullScreen = true
    // 壁纸层跟随窗口几何，等系统把尺寸应用完再挂载，否则 attach 拿到的是旧几何
    await new Promise((resolve) => setTimeout(resolve, 120))

    // 3) 几何就绪后再挂到壁纸层
    try {
      asWallpaper?.attach(mainWindow, {
        transparent: true,
        /**
         * 壁纸模式**不转发鼠标**
         *
         * 界面上的标题栏和控制栏在壁纸模式下是隐藏的（`.wm-hidden`），窗口里没有可点的东西，
         * 所以不需要把全系统的鼠标事件合成进壁纸窗口。
         *
         * 而且这个转发本身就是一堆麻烦的源头：它会在 `RIDEV_INPUTSINK` 里把**每一次**
         * 鼠标按下都 `PostMessage` 给壁纸窗口，Chromium 随即在那里 `SetCapture`，
         * 于是别的窗口（托盘菜单、原生弹出菜单）的点击会被抢走一半。
         * 关掉之后壁纸模式下点击/拖拽都交还给系统，桌面该怎么用还怎么用。
         */
        forwardMouseInput: false,
        forwardKeyboardInput: false,
      })
    } catch (err) {
      console.error('[wallpaper] attach 失败:', err)
    }

    /**
     * 壁纸模式 = 没有任务栏按钮
     *
     * 窗口这时是「桌面的一部分」，留在任务栏上就像多开了一个程序（用户的要求：
     * 和最小化到托盘一样干净）。要回到窗口模式走托盘：左键单击图标 =
     * `restoreWindow()`，或右键菜单里的「窗口模式」。
     */
    mainWindow.setSkipTaskbar(true)

    // 4) 刷新托盘提示（壁纸模式下操作都在托盘菜单里）
    applyTrayMode()
  } else {
    // 退出壁纸模式：先脱离壁纸层，再恢复窗口状态
    try {
      asWallpaper?.detach(mainWindow)
    } catch {
      /* ignore */
    }
    try {
      asWallpaper?.reset()
    } catch {
      /* ignore */
    }

    mainWindow.setVisibleOnAllWorkspaces(false)
    // 任务栏按钮恢复（进入壁纸模式时被 setSkipTaskbar(true) 摘掉了）
    mainWindow.setSkipTaskbar(false)

    // 等壁纸层把窗口还回来，再还原尺寸，否则 setBounds 会被忽略
    await new Promise((resolve) => setTimeout(resolve, 80))
    if (mainWindow && !mainWindow.isDestroyed()) exitWallpaperGeometry()

    // 托盘还在（一直是同一个实例），切回「应用模式用法」就行
    applyTrayMode()
  }

  // 通知渲染进程同步状态（全屏标志可能变了）
  syncFullScreenState()
}

async function toggleWallpaper(): Promise<boolean> {
  if (!asWallpaper || !mainWindow || mainWindow.isDestroyed()) return wallpaperEnabled
  wallpaperEnabled = !wallpaperEnabled

  /**
   * **不再**顺手改写「启动时进入桌面壁纸模式」
   *
   * 踩过：这里原来每次都 `updateSetting({'common.wallpaperMode': wallpaperEnabled})`，
   * 于是用按钮/托盘切一下壁纸模式，设置里那个「启动时进入」开关就跟着自己翻 ——
   * 用户看到的是「我没动它，它自己打开了」，而且下次开机会莫名进壁纸模式。
   *
   * 现在两件事分开：
   *  - 按钮/托盘 = 这次运行进不进壁纸（`wallpaperEnabled`，不落盘）；
   *  - 设置里那个开关 = 要不要**开机就进**，改动由 onSettingChange 实时应用（见下）。
   */
  await applyWallpaperMode(wallpaperEnabled)

  sendToMain('wallpaper:state', wallpaperEnabled)
  refreshTray()
  return wallpaperEnabled
}

function createLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return
  }

  loginWindow = new BrowserWindow({
    width: 1150,
    height: 600,
    parent: mainWindow ?? undefined,
    modal: true,
    title: '账号登录',
    frame: false,
    webPreferences: {
      session: session.defaultSession,
    },
  })

  void loginWindow.loadURL('https://passport.bilibili.com/login')

  let loginAutoCloseTimer: ReturnType<typeof setTimeout> | null = null
  let loginPollTimer: ReturnType<typeof setInterval> | null = null
  const isLoginWallpaper = wallpaperEnabled
  if (isLoginWallpaper) {
    loginAutoCloseTimer = setTimeout(() => {
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
    }, 15000)
  }

  /**
   * 打开登录窗口时已有的 SESSDATA（可能是已经过期的旧值）
   *
   * `null` 表示基线还没读出来，此时不做任何判断。
   */
  let initialSessdata: string | null = null
  const readSessdata = async (): Promise<string> => {
    try {
      const cookies = await session.defaultSession.cookies.get({})
      return cookies.find((c) => c.name === 'SESSDATA' && c.value)?.value ?? ''
    } catch {
      return ''
    }
  }
  void readSessdata().then((value) => {
    initialSessdata = value
  })

  /**
   * 检查是否登录成功，成功则收尾
   *
   * 两步走，缺一不可：
   *  1. **cookie 变化当触发器** —— SESSDATA 必须和打开窗口时的值不同，
   *     否则「本来就有一个过期 SESSDATA」会被误判成登录成功，窗口一闪就关；
   *  2. **接口裁定** —— cookie 存在不代表登录有效（可能被风控或已过期），
   *     清掉 nav 缓存后问一次 `isLogin`，以接口为准。
   *
   * 之所以不能只靠 `did-navigate`：B 站登录可能走 SPA 内部跳转，
   * 用户也可能登录完直接手动关窗 —— 这两条路都触发不了导航事件，
   * 于是「登录成功」没人告诉主进程，必须重启一次才生效。
   *
   * 轮询（1s）和 `did-navigate` 都会调它，函数里又有两个 await，
   * 所以必须加 in-flight 标记：否则两次调用会一起越过上面的判断，
   * `auth:loginSuccess` 发两遍，渲染层跟着把同一个视频重复解析两次。
   */
  let finishingLogin = false
  let loginFinished = false
  const finishLoginIfReady = async (): Promise<boolean> => {
    if (loginFinished || finishingLogin) return loginFinished
    if (initialSessdata === null) return false
    const sessdata = await readSessdata()
    if (!sessdata || sessdata === initialSessdata) return false

    finishingLogin = true
    try {
      // 丢掉「未登录时」拿到的 nav / wbi / 用户信息缓存，
      // 否则 isLoggedIn() 还是 false，解析播放地址时仍按未登录处理
      biliApi.clearNavData()
      const ok = await biliApi.ensureLoginState()
      if (!ok) return false

      loginFinished = true
      if (loginPollTimer) {
        clearInterval(loginPollTimer)
        loginPollTimer = null
      }
      if (loginAutoCloseTimer) {
        clearTimeout(loginAutoCloseTimer)
        loginAutoCloseTimer = null
      }
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
      loginWindow = null
      isLoggedIn = true
      refreshTray()
      sendToMain('auth:loginSuccess')
      return true
    } finally {
      finishingLogin = false
    }
  }

  // 登录页可能不触发顶层导航，轮询 cookie 兜底
  loginPollTimer = setInterval(() => {
    void finishLoginIfReady()
  }, 1000)

  loginWindow.webContents.on('did-navigate', () => {
    void finishLoginIfReady()
  })

  loginWindow.webContents.on('dom-ready', () => {
    if (!loginWindow || loginWindow.isDestroyed()) return
    // dom-ready 每次主框架导航都会触发（登录成功后 B 站自己就会跳一次），
    // 不判重就会叠出好几个关闭按钮和倒计时（文字重影）
    void loginWindow.webContents
      .executeJavaScript(
        `!document.querySelector('.mimo-close-btn') && !document.querySelector('.mimo-countdown')`,
      )
      .then(async (clean: boolean) => {
        if (!clean || !loginWindow || loginWindow.isDestroyed()) return
        await loginWindow.webContents.insertCSS(`
      .mimo-close-btn {
        position: fixed; top: 0; right: 0; z-index: 99999;
        width: 36px; height: 36px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; color: rgba(0,0,0,0.4);
        transition: background 0.15s, color 0.15s;
      }
      .mimo-close-btn:hover { background: #e81123; color: white; }
      .mimo-countdown {
        position: fixed; top: 0; left: 0; z-index: 99999;
        padding: 4px 12px;
        font-size: 30px; font-weight: 700;
        color: #e81123;
        pointer-events: none;
        font-family: system-ui, sans-serif;
      }
    `)
        if (!loginWindow || loginWindow.isDestroyed()) return
        await loginWindow.webContents.executeJavaScript(`
      ${
        !isLoginWallpaper
          ? `
      const btn = document.createElement('div');
      btn.className = 'mimo-close-btn';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1L13 13M1 13L13 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      btn.onclick = () => window.close();
      document.body.appendChild(btn);
      `
          : ''
      }
      ${
        isLoginWallpaper
          ? `
      const cd = document.createElement('div');
      cd.className = 'mimo-countdown';
      document.body.appendChild(cd);
      let remain = 15;
      cd.textContent = remain + '秒 后自动关闭,请尽快登录';
      const iv = setInterval(() => {
        remain--;
        if (remain <= 0) { clearInterval(iv); return; }
        cd.textContent = remain + '秒 后自动关闭,请尽快登录';
      }, 1000);
      `
          : ''
      }
    `)
      })
  })

  loginWindow.on('closed', () => {
    if (loginPollTimer) {
      clearInterval(loginPollTimer)
      loginPollTimer = null
    }
    if (loginAutoCloseTimer) {
      clearTimeout(loginAutoCloseTimer)
      loginAutoCloseTimer = null
    }
    loginWindow = null
    // 手动关窗也再确认一次：用户很可能就是登录完直接把窗口关掉的
    void finishLoginIfReady()
  })
}

/**
 * 刷新托盘（悬浮提示）
 *
 * 菜单已经改成自绘窗口（见 showTrayMenu），这里只维护 tooltip。
 */
function refreshTray(): void {
  if (!tray || tray.isDestroyed()) return
  // 视频标题里可能带 B 站搜索的 <em> 高亮标签，托盘提示要的是纯文本
  const title = (trayTitle || '未在播放').replace(/<[^>]*>/g, '').trim() || '未在播放'
  /**
   * 悬浮提示要说**现在的**左键行为
   *
   * 踩过：左键早就从「播放 / 暂停」改成「回到窗口」了，壁纸模式这句提示还留着旧文案，
   * 用户按提示点了一下，结果窗口直接跳出来 —— 提示与实际不一致比没有提示更糟。
   */
  const tip = wallpaperEnabled
    ? `BiLiMusicVideo-desktop · 壁纸模式\n${title}\n单击：回到窗口　右键：菜单`
    : `BiLiMusicVideo-desktop\n${title}\n单击：显示窗口　右键：菜单`
  if (tip !== lastTrayTip) {
    tray.setToolTip(tip)
    lastTrayTip = tip
  }
  tray.setContextMenu(null)
}

/** 托盘菜单窗口（自绘，见 showTrayMenu 的注释） */
let trayMenuWindow: BrowserWindow | null = null
/** 页面最后一次回报的内容高度 */
let trayMenuHeight = 0
/** 本次弹出是否已经显示过（避免 ready 回报两次时重复定位） */
let trayMenuShown = false
/** 失焦后延迟判断收起的定时器 */
let blurHideTimer: ReturnType<typeof setTimeout> | null = null
/** 弹出菜单的兜底显示定时器（见 showTrayMenu） */
let trayMenuFallbackTimer: ReturnType<typeof setTimeout> | null = null
const TRAY_MENU_WIDTH = 208

const trayMenuUrl = (): string =>
  isDev && process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/tray-menu.html`
    : ''

function createTrayMenuWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: TRAY_MENU_WIDTH,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 要盖在任务栏和其它窗口之上，所以置顶到 screen-saver 层
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  /**
   * 失焦**不能立刻**收起（壁纸模式下的坑）
   *
   * 壁纸模式开着鼠标转发：用户按下鼠标的那一刻，库会往壁纸窗口塞一个合成
   * `WM_LBUTTONDOWN`，Chromium 随即在那个窗口上 `SetCapture`（鼠标捕获）并抢走激活。
   * 于是菜单窗口立刻收到 `blur` —— 如果这时直接 `hide()`，菜单在按键还没抬起来时就没了，
   * 那个真实的 mouseup 也就不会发生在菜单项上，用户看到的就是「点了没反应」。
   *
   * 所以失焦后先看光标是不是还在菜单里：还在就说明这一下正是点菜单，等它抬起来；
   * 挪走了（真正的「点别处」）才收。
   */
  win.on('blur', () => scheduleHideAfterBlur())
  // 自绘菜单窗口不需要任何外链/新窗口
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = trayMenuUrl()
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname, '../renderer/tray-menu.html'))
  return win
}

/**
 * 弹出托盘菜单
 *
 * **为什么不用原生菜单**（读的是 electron-as-wallpaper 的 Rust 源码）：
 * `attach()` 在 `forwardMouseInput: true` 时会注册 `RIDEV_INPUTSINK`，
 * 把**全系统的鼠标事件**都 `PostMessageA` 塞进壁纸窗口。原生弹出菜单只要收到
 * 「菜单外的一次按下」就关掉 —— 点托盘图标那一下就同时被塞进壁纸窗口，
 * 菜单刚出来就被自己关掉，点菜单项也会被打断。这个转发是全局装的，JS 侧关不掉。
 *
 * 所以自己开一个**独立的置顶窗口**画菜单：它不是壁纸窗口，收的是真实鼠标消息，
 * 合成点击打不到它，而且能盖在任务栏上面。
 */
function showTrayMenu(): void {
  if (!tray) return
  trayMenuShown = false
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) {
    trayMenuWindow = createTrayMenuWindow()
  }
  pushTrayMenuState()
  /**
   * 兜底显示（**每次**弹出都要装，不能只装在创建时）
   *
   * 页面那边「高度没变就不回报」，所以显示这件事**不能**绑在 `trayMenu:ready` 上：
   * 只装一次的话，第一次右键能弹（高度从 0 变成 N），第二次开始高度没变、页面不回报，
   * 菜单就再也不出现了 —— 这正是「进了壁纸模式后右键弹不出来」的原因。
   * 现在每次都用上次的高度先弹出来；高度真变了页面会回报，`sizeTrayMenu` 再重新定位。
   */
  if (trayMenuFallbackTimer) clearTimeout(trayMenuFallbackTimer)
  trayMenuFallbackTimer = setTimeout(() => {
    trayMenuFallbackTimer = null
    if (!trayMenuShown) placeAndShowTrayMenu(trayMenuHeight || 300)
  }, 120)
}

/** 把最新状态推给菜单窗口 */
function pushTrayMenuState(): void {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return
  trayMenuWindow.webContents.send('trayMenu:state', getTrayMenuState())
}

function getTrayMenuState(): TrayMenuState {
  return {
    paused: isPaused,
    loopModeIndex,
    loopModeName: MODE_NAMES[loopModeIndex] ?? MODE_NAMES[0],
    isLoggedIn,
    wallpaperEnabled,
    // 被「关闭到托盘」藏起来了：菜单那一项要显示「恢复窗口」
    windowHidden: !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible(),
    title: (trayTitle || '').replace(/<[^>]*>/g, '').trim(),
    position: trayPosition,
    duration: trayDuration,
    volume: trayVolume,
    muted: trayMuted,
  }
}

/** 页面量好高度后：定位 + 显示 */
function sizeTrayMenu(height: number): void {
  trayMenuHeight = Math.max(60, Math.round(height))
  console.log(`[tray] 菜单页面回报高度 ${trayMenuHeight}px`)
  if (trayMenuShown) return
  placeAndShowTrayMenu(trayMenuHeight)
}

function placeAndShowTrayMenu(height: number): void {
  const win = trayMenuWindow
  if (!win || win.isDestroyed() || !tray) return
  const trayBounds = tray.getBounds()
  const display = screen.getDisplayMatching(trayBounds)
  const area = display.workArea
  const width = TRAY_MENU_WIDTH
  const gap = 8

  // 贴着托盘图标弹：默认在图标上方，上方放不下就改到下方；再夹进工作区
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2)
  let y = Math.round(trayBounds.y - height - gap)
  if (y < area.y + 4) y = Math.round(trayBounds.y + trayBounds.height + gap)
  x = Math.min(Math.max(x, area.x + 4), area.x + area.width - width - 4)
  y = Math.min(Math.max(y, area.y + 4), area.y + area.height - height - 4)

  win.setBounds({ x, y, width, height })
  trayMenuShown = true
  win.show()
  win.focus()
  // 告诉主窗口「菜单开着」：壁纸模式下它要把合成点击吞掉
  mainWindow?.webContents.send('trayMenu:visibility', true)
}

/** 收起菜单（同时清掉失焦延迟） */
function hideTrayMenu(): void {
  if (blurHideTimer) {
    clearTimeout(blurHideTimer)
    blurHideTimer = null
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) {
    trayMenuWindow.hide()
  }
  trayMenuShown = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('trayMenu:visibility', false)
  }
}

/**
 * 失焦后判断要不要收起（见 createTrayMenuWindow 里 blur 的注释）
 *
 * 光标还在菜单上 = 正在点菜单（壁纸模式的鼠标转发抢走了激活），等它点完；
 * 光标已经移开 = 真的点了别处，收起。
 */
function scheduleHideAfterBlur(): void {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed() || !trayMenuWindow.isVisible()) return
  if (blurHideTimer) clearTimeout(blurHideTimer)
  blurHideTimer = setTimeout(() => {
    blurHideTimer = null
    const win = trayMenuWindow
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const b = win.getBounds()
    const c = screen.getCursorScreenPoint()
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height
    if (!inside) {
      hideTrayMenu()
      return
    }
    // 还在菜单里：继续观察，别把正在进行的这一下点掉
    scheduleHideAfterBlur()
  }, 400)
}

/**
 * 执行菜单动作：先收起菜单，再复用应用里已有的那套事件
 *
 * 进度条 / 音量这两个带参数，所以接 `value`。
 */
function runTrayMenuAction(action: TrayMenuAction, value?: number): void {
  // 菜单动作都记一行：出问题时能一眼看出「点了什么、有没有传参」
  console.log(`[tray] 菜单动作: ${action}${value === undefined ? '' : ' ' + value}`)
  /**
   * 音量与静音**不收起菜单**
   *
   * 这两个是连续操作：调音量时菜单一关，用户看不到音量数字、也没法接着调，
   * 之前的现象就是「鼠标一碰音量条菜单就没了」。
   */
  if (action !== 'volume' && action !== 'toggleMute') {
    hideTrayMenu()
  }
  switch (action) {
    case 'playControl':
      sendToMain('tray:playControl')
      break
    case 'prev':
      sendToMain('tray:prev')
      break
    case 'next':
      sendToMain('tray:next')
      break
    case 'toggleMode':
      sendToMain('tray:toggleMode')
      break
    case 'seek':
      if (typeof value === 'number') sendToMain('tray:seek', value)
      break
    case 'volume':
      if (typeof value === 'number') sendToMain('tray:volume', value)
      break
    case 'toggleMute':
      sendToMain('tray:toggleMute')
      break
    case 'showPlaylist':
      /**
       * 设置歌单：壁纸模式下**先退出壁纸模式**再打开（用户要求）
       *
       * 壁纸模式下窗口在桌面层、标题栏控制栏又都是隐藏的，直接弹歌单管理会看不见，
       * 所以先把窗口恢复出来，再让渲染层打开弹窗。
       */
      void restoreWindow().then(() => sendToMain('tray:showPlaylist'))
      break
    case 'toggleWallpaper':
      void toggleWallpaper()
      break
    case 'restoreWindow':
      void restoreWindow()
      break
    case 'login':
      createLoginWindow()
      break
    case 'logout':
      void restoreWindow().then(() => sendToMain('tray:showLogoutConfirm'))
      break
    case 'quit':
      app.quit()
      break
  }
}

/**
 * 把窗口显示出来（托盘左键 / 菜单里的「恢复窗口」）
 *
 * 壁纸模式下窗口挂在桌面层，`show()/focus()` 是看不见效果的，
 * 所以先退出壁纸模式再显示 —— 用户要的「点一下就回到窗口」。
 */
async function restoreWindow(): Promise<void> {
  if (wallpaperEnabled) {
    try {
      await toggleWallpaper()
    } catch (err) {
      console.warn('[win] 退出壁纸模式失败:', err)
    }
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  const icon = loadIcon('bili.ico')
  tray = new Tray(icon)
  tray.setToolTip('B站音乐视频')
  /**
   * 左键：直接显示窗口
   *
   * 壁纸模式下窗口在桌面层，所以会先退出壁纸模式再显示（`restoreWindow`）。
   * 之前壁纸模式把左键当播放/暂停，和用户预期不符，已经去掉。
   */
  tray.on('click', () => {
    void restoreWindow()
  })
  // 右键（两种模式都是）：弹自绘菜单
  tray.on('right-click', () => showTrayMenu())
  applyTrayMode()
}

/**
 * 模式切换后刷新托盘表现
 *
 * 菜单本身是自绘窗口（`showTrayMenu`），两种模式共用；这里只需要更新 tooltip
 * 与「左键干什么」的语义（左键行为在 createTray 的 click 回调里按 wallpaperEnabled 分支）。
 *
 * 顺带说明**为什么放弃原生菜单**（读的是 electron-as-wallpaper 的 Rust 源码，不是猜的）：
 * `attach()` 除了 `SetParent(hwnd, WorkerW)` 把窗口挂到桌面图标后面，还会在
 * `forwardMouseInput: true` 时注册 `RIDEV_INPUTSINK` 原始输入，把**全系统的鼠标事件**
 * 都 `PostMessageA(壁纸窗口, WM_LBUTTONDOWN/UP, …)`。原生弹出菜单只要收到
 * 「菜单外的一次按下」就关掉 —— 点托盘图标那一下就同时被塞进壁纸窗口，
 * 菜单刚弹出来就被自己关掉，点菜单项也会被打断；这个转发是 Rust 侧全局装的，JS 关不掉。
 */
function applyTrayMode(): void {
  refreshTray()
}

async function grabCookiesSilently(): Promise<void> {
  const cookieWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: { session: session.defaultSession },
  })

  return new Promise((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      if (!cookieWindow.isDestroyed()) cookieWindow.destroy()
      resolve()
    }

    let pollCount = 0
    const poll = async (): Promise<void> => {
      if (settled) return
      pollCount++
      try {
        const cookies = await session.defaultSession.cookies.get({})
        if (cookies.some((c) => c.name === 'buvid3')) {
          settled = true
          if (!cookieWindow.isDestroyed()) cookieWindow.destroy()
          resolve()
          return
        }
      } catch {
        /* ignore */
      }
      if (pollCount < 20) setTimeout(() => void poll(), 500)
      else settle()
    }

    cookieWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => void poll(), 1000)
    })
    cookieWindow.webContents.on('did-fail-load', () => settle())
    cookieWindow.loadURL('https://www.bilibili.com/').catch(() => settle())
  })
}

/** 清除 B 站登录态 cookie */
async function executeLogout(): Promise<void> {
  isLoggedIn = false
  biliApi.clearNavData()
  const cookies = await session.defaultSession.cookies.get({})
  for (const c of cookies) {
    if (c.name === 'SESSDATA' || c.name === 'bili_jct' || c.name === 'DedeUserID') {
      await session.defaultSession.cookies.remove(
        `http${c.secure ? 's' : ''}://${(c.domain ?? '').replace(/^\./, '')}${c.path}`,
        c.name,
      )
    }
  }
  sendToMain('auth:logout')
  refreshTray()
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

// 第 1 步：必须最早执行，改写 userData 之后再碰任何路径相关的 API
setupUserDataPath()

void app.whenReady().then(async () => {
  // 第 2 步：初始化配置（读盘 + 迁移 + 合并默认值）与歌单集合
  initSetting()
  initPlaylists()

  /**
   * 配置变化时同步托盘菜单
   *
   * 注意「启动时进入桌面壁纸模式」这个 key **故意什么都不做**：
   * 它是「下次开机进不进壁纸」的开关，不该在打开/关闭的瞬间改变当前状态
   * （用户明确要求：打开这个开关也不要立刻进壁纸模式）。
   * 当前状态只由按钮/托盘切换（`toggleWallpaper`），那边也**不回写**这个设置 —— 两件事互不干涉。
   */
  onSettingChange(() => {
    refreshTray()
  })

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.bilivideo.com/*', '*://*.bilibili.com/*'] },
    (details, callback) => {
      /**
       * 登录窗口自己的请求不能改 Referer：`passport.bilibili.com` 也匹配上面的规则，
       * 给登录页的 XHR 塞一个 www.bilibili.com 的 Referer 有可能被风控当成异常来源。
       */
      if (details.webContentsId != null && details.webContentsId === loginWindow?.webContents.id) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      details.requestHeaders['Referer'] = 'https://www.bilibili.com/'
      callback({ requestHeaders: details.requestHeaders })
    },
  )

  // 第 3 步：注册 IPC
  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    createLoginWindow,
    toggleFullScreen,
    isFullScreen: () => isFullScreen,
    toggleWallpaper,
    isWallpaperEnabled: () => wallpaperEnabled,
    startWindowDrag,
    moveWindow: (x, y) => {
      mainWindow?.setPosition(Math.round(x), Math.round(y))
    },
    getScreenWorkArea,
    setLoggedIn: (loggedIn) => {
      isLoggedIn = loggedIn
      refreshTray()
    },
    updateTrayState: (state) => {
      if (state.paused !== undefined) isPaused = state.paused
      if (state.loopMode !== undefined) {
        const idx = PLAY_LOOP_MODES.indexOf(state.loopMode as (typeof PLAY_LOOP_MODES)[number])
        if (idx >= 0) loopModeIndex = idx
      }
      // 悬浮提示里带上当前歌曲：壁纸模式下原生菜单用不了，tooltip 是唯一的托盘反馈
      if (state.title !== undefined) trayTitle = state.title
      // 托盘菜单是个迷你控制台：进度条与音量按钮都要跟着实时走
      if (state.position !== undefined) trayPosition = state.position
      if (state.duration !== undefined) trayDuration = state.duration
      if (state.volume !== undefined) trayVolume = state.volume
      if (state.muted !== undefined) trayMuted = state.muted
      // 登录态也一起收下（防漂移：托盘菜单那一项要显示「退出登录」还是「登录」）
      if (state.isLoggedIn !== undefined && state.isLoggedIn !== isLoggedIn) {
        isLoggedIn = state.isLoggedIn
      }
      refreshTray()
      // 菜单开着就把新状态推过去（进度条才会动）
      if (trayMenuShown) pushTrayMenuState()
    },
    getTrayMenuState: () => getTrayMenuState(),
    runTrayMenuAction: (action, value) => runTrayMenuAction(action, value),
    sizeTrayMenu: (height) => sizeTrayMenu(height),
    hideTrayMenu: () => hideTrayMenu(),
    setProgress: (progress, paused) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (progress < 0) {
        mainWindow.setProgressBar(-1)
        return
      }
      // 任务栏进度：暂停时用「已暂停」样式（Windows 上是黄色）
      mainWindow.setProgressBar(Math.min(1, Math.max(0, progress)), {
        mode: paused ? 'paused' : 'normal',
      })
    },
    executeLogout,
    quitApp: () => app.quit(),
  })

  // 第 4 步：创建窗口与托盘
  createMainWindow()
  createTray()

  // 第 5 步：显示器变化（拔屏 / 改分辨率）时重算全屏与壁纸的几何
  watchDisplayChanges()

  void grabCookiesSilently()

  console.log(`[main] ready (dev=${String(isDev)}, portable=${String(isPortable())})`)
})
  /**
   * 启动失败要留个痕迹并退出。
   *
   * 以前这里是裸的 `void app.whenReady().then(...)`：`initSetting` / `initPlaylists`
   * 万一因为磁盘只读、JSON 异常抛错，进程会静默留在「没有窗口」的状态，
   * 用户只看到双击没反应。
   */
  .catch((err: unknown) => {
    console.error('[main] 启动失败:', err)
    try {
      dialog.showErrorBox(
        '启动失败',
        `应用初始化时出错，即将退出。\n\n${err instanceof Error ? err.message : String(err)}`,
      )
    } catch {
      /* 弹窗失败就只留日志 */
    }
    app.exit(1)
  })

/** 拖动窗口：处理全屏/最大化状态下先还原再跟手移动 */
function startWindowDrag(): { offsetX: number; offsetY: number } | null {
  if (!mainWindow) return null
  const cursor = screen.getCursorScreenPoint()

  if (isFullScreen) {
    // 全屏时拖动 = 退出全屏，并按鼠标在窗口中的相对位置把窗口摆到鼠标下
    const fullBounds = mainWindow.getBounds()
    const normalBounds = fullScreenRestore?.bounds ?? fullBounds
    // 注意减掉 fullBounds.x/y：全屏窗口不一定从 (0,0) 开始（副屏 / 多屏），
    // 不减的话相对位置会大于 1，还原出来的窗口直接飞出屏幕
    const ratioX =
      fullBounds.width > 0 ? (cursor.x - fullBounds.x) / fullBounds.width : 0.5
    const ratioY =
      fullBounds.height > 0 ? (cursor.y - fullBounds.y) / fullBounds.height : 0.5
    isFullScreen = false
    fullScreenRestore = null
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setAspectRatio(FULLSCREEN_ASPECT)
    syncFullScreenState()
    mainWindow.setBounds({
      x: Math.round(cursor.x - ratioX * normalBounds.width),
      y: Math.round(cursor.y - ratioY * normalBounds.height),
      width: normalBounds.width,
      height: normalBounds.height,
    })
  }

  if (mainWindow.isMaximized()) {
    const fullBounds = mainWindow.getBounds()
    const normalBounds = mainWindow.getNormalBounds()
    const ratioX =
      fullBounds.width > 0 ? (cursor.x - fullBounds.x) / fullBounds.width : 0.5
    const ratioY =
      fullBounds.height > 0 ? (cursor.y - fullBounds.y) / fullBounds.height : 0.5
    mainWindow.unmaximize()
    mainWindow.setBounds({
      x: Math.round(cursor.x - ratioX * normalBounds.width),
      y: Math.round(cursor.y - ratioY * normalBounds.height),
      width: normalBounds.width,
      height: normalBounds.height,
    })
    const newBounds = mainWindow.getBounds()
    return { offsetX: cursor.x - newBounds.x, offsetY: cursor.y - newBounds.y }
  }

  const bounds = mainWindow.getBounds()
  return { offsetX: cursor.x - bounds.x, offsetY: cursor.y - bounds.y }
}

function getScreenWorkArea(): Electron.Rectangle | null {
  if (!mainWindow) return null
  const bounds = mainWindow.getBounds()
  return screen.getDisplayMatching(bounds).workArea
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (!mainWindow) createMainWindow()
})

/**
 * 显示器变化（拔屏 / 改分辨率 / 改缩放）后，全屏与壁纸的几何是按进入时的屏幕算的，
 * 不重算就会停在旧 bounds 上（甚至落在已经拔掉的显示器坐标里）。
 * 这里只处理「正在全屏 / 壁纸」的情况：普通窗口交给 Windows 自己钳制，别乱动用户摆好的位置。
 */
const handleDisplayChange = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!isFullScreen && !wallpaperEnabled) return
  try {
    // 两种情况都是「窗口应该铺满所在屏幕」，所以同一个几何函数；
    // 壁纸模式下不需要重新 attach（窗口已经贴在桌面层，只是尺寸要跟着新分辨率走）
    applyFullScreenGeometry()
  } catch (err) {
    console.warn('[win] 显示器变化后重算几何失败:', err)
  }
}

/**
 * 监听显示器变化
 *
 * 必须等 `app.ready` 之后再注册：`screen` 模块在 ready 之前取用会直接抛
 * 「The 'screen' module can't be used before the app 'ready' event」——
 * 放在模块顶层会让整个主进程起不来。
 */
const watchDisplayChanges = (): void => {
  screen.on('display-metrics-changed', handleDisplayChange)
  screen.on('display-removed', handleDisplayChange)
  screen.on('display-added', handleDisplayChange)
}

// 退出前把防抖里待写入的配置/歌单刷到磁盘，避免最后几秒的修改丢失
app.on('before-quit', () => {
  // 置位后「关闭到托盘」就不再拦截窗口关闭了，否则会永远退不掉
  isQuitting = true
  flushSetting()
  flushPlaylists()
})

// 兜底：进程即将退出时同步再刷一次
process.on('exit', () => {
  try {
    flushSetting()
    flushPlaylists()
  } catch {
    /* ignore */
  }
})
