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
  protocol,
} from 'electron'
import type { CustomScheme } from 'electron'
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
import * as cacheManager from './utils/cache'
import { initPlaylists, flushPlaylists } from './utils/playlist'
import { ensureDefaultVideoList, getVideoLists } from './utils/videolist'
import { installMediaProtocol, mediaSchemeDescriptor } from './mediaProtocol'
import { PLAY_LOOP_MODES, parseAspectRatio } from '@common/constants'
import {
  installProtectedProtocol,
  protectionEnabled,
  protectedRendererUrl,
  protectedSchemeDescriptor,
} from './protection'
import type { IpcEvent, IpcEventPayload, TrayMenuAction, TrayMenuState } from '@common/types/ipc'

/**
 * 壁纸模式的原生实现（koffi 直接调 Win32，见 `winWallpaper.ts`）
 *
 * 原来这里是 `require('electron-as-wallpaper')`，用空 try/catch 吞掉加载失败，
 * 结果是「点了没反应」而且完全没有日志。那个库还有两个更严重的问题（详见 winWallpaper.ts）：
 *  1. `attach` 里先 `SetParent` 再设透明样式，中间态会让窗口不可见、且已经留在桌面层；
 *  2. 失败回滚没有把窗口 `SetParent` 回来，窗口就永久找不回来了。
 * 现在换成自己用 koffi 调：不需要 Rust 工具链，失败会返回原因而不是静默。
 */
import {
  attachWallpaper,
  detachWallpaper,
  resetWallpaper,
  isWallpaperAvailable,
  getUnavailableReason,
  isAttachedToWallpaper,
  fitWallpaperWindow,
  getWallpaperLayer,
  getWindowParent,
} from './winWallpaper'
import { restoreFromMaximized } from './winShowState'

const isDev = !app.isPackaged

/**
 * 应用「开机自动启动」这个开关
 *
 * ## 为什么用 `app.setLoginItemSettings()` 而不是自己写注册表
 *
 * Electron 内建了这个能力，跨平台都支持（Windows 写注册表 `Run` 键 /
 * 启动文件夹；macOS 用 `LaunchAgents`）——
 * **不需要额外的原生依赖**（对比：托盘/壁纸那些都得自己调 Win32）。
 *
 * ## ⚠️ 每次启动都重写一遍（这是刻意的）
 *
 * `setLoginItemSettings` 会把**当前 exe 的完整路径**写进系统启动项。
 * 而本项目有**便携版**（绿色版），用户可能把它挪到别的文件夹 ——
 * 那之后启动项里还是旧路径，开机时会**静默失败**（Windows 找不到那个 exe 就跳过，
 * 不会有任何提示）。
 *
 * 所以在启动时按设置重写一次：路径变了就自动纠正。
 * 代价是一次注册表写入（可忽略）。
 *
 * ## 为什么用 `execPath` 而不是 `app.getPath('exe')`
 *
 * 两者一样，但 `process.execPath` 在开发模式下指向 `electron.exe` ——
 * 那种情况我们**不注册**（见下面的 `isDev` 判断），否则会把开发环境注册成开机启动，
 * 每次开机弹一个 Electron 空窗口。
 */
const applyAutoLaunch = (): void => {
  const enabled = Boolean(getSetting()['common.autoLaunch'])
  /**
   * 开发模式（`app.isPackaged === false`）一律**关掉**开机启动
   *
   * 原因：开发时 `execPath` 是 `node_modules/electron/dist/electron.exe`，
   * 注册它没有意义（开机弹个空壳），而且会**污染用户的启动项**。
   * 这里主动写一个 `false` 把它清掉 —— 免得之前调试时留下的残留一直在。
   */
  const shouldEnable = enabled && !isDev
  try {
    app.setLoginItemSettings({
      openAtLogin: shouldEnable,
      /** 便携版 / 安装版都用真实 exe 路径（见上面那段说明） */
      path: process.execPath,
      /**
       * 开机启动**不带额外参数**：走的是「正常窗口」这条路。
       *
       * ⚠️ 不传 `--wallpaper-mode` —— 那是「这次启动直接进壁纸」的意思，
       * 而壁纸模式要不要进是 `common.wallpaperMode` 自己决定的（见 createMainWindow）。
       * 在这里再传一个参数会让两个开关打架。
       */
      args: [],
    })
    if (enabled && isDev) {
      console.log('[launch] 开发模式下不注册开机启动（已确保是关闭状态）')
    }
  } catch (err) {
    /**
     * 注册失败**不能影响启动** —— 只是开机不自启而已，
     * 记一行日志让用户知道（而不是静默吞掉、让他以为设置没用）。
     */
    console.warn('[launch] 设置开机启动失败（忽略）：', err)
  }
}

let mainWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isLoggedIn = false
let isPaused = true
let loopModeIndex = 0
/**
 * 应用层认为「当前处于壁纸模式」
 *
 * 注意：这是**应用自己的意图/状态**，不是「窗口真的挂在桌面层」的证据。
 * 判断「要不要 detach」必须用 `wallpaperAttached`，不能用这个（原因见那边注释）。
 */
let wallpaperEnabled = false
/**
 * 窗口是否**真的**已经挂在桌面壁纸层（不可逆操作的唯一凭据）
 *
 * 为什么要和 `wallpaperEnabled` 分开：`attach()` 里 `SetParent` 是那一步不可逆的动作，
 * 一旦执行，窗口就已经离开正常窗口层了 —— 此时哪怕后续步骤失败、`wallpaperEnabled`
 * 被翻回 false，也**必须**把窗口摘回来，否则它永远卡在桌面层且不可见
 * （老代码就是这样：失败回滚只还原了几何，没有 SetParent 回来，托盘也救不回来）。
 *
 * 所以这个标志：
 *  - 在调 `attach()` **之前**置位（宁可多摘一次，也不能漏摘）；
 *  - 只有 `detach()` 成功后才清除；
 *  - `restoreWindow()` 与 `before-quit` 都看它，不看 `wallpaperEnabled`。
 */
let wallpaperAttached = false
/** 是否正在退出应用（区分「点关闭按钮」与「真的要退出」） */
let isQuitting = false
/**
 * 托盘菜单那一项的工作区（「歌单管理」还是「视频管理」）
 *
 * 由渲染层推上来（`trayUpdateState`）——工作区是**播放源的投影**，
 * 只有渲染层算得准（它同时知道 `activeId` 和当前这条是不是视频）。
 * 初始值 `ov` 跟界面默认一致：空库 / 刚装时两边都没内容，按视频列表那侧显示。
 */
let trayMode: 'ov' | 'mv' = 'ov'
/** 托盘悬浮提示里显示的「当前在播什么」（由渲染层同步） */
let trayTitle = ''
/** 托盘菜单进度条要用的播放位置 / 时长（秒） */
let trayPosition = 0
let trayDuration = 0
/** 托盘菜单音量按钮要用的音量与静音状态 */
let trayVolume = 70
let trayMuted = false
/**
 * 托盘菜单「定时」那一项要显示的倒计时
 *
 * 计时器本身在渲染层（它要读 `<video>` 的播放位置判断「暂停冻结」「等视频播完」），
 * 主进程只负责把渲染层送上来的快照原样塞进菜单状态 —— **不在这里自己算时间**，
 * 否则多一个时钟源，迟早和弹窗里的倒计时不一致。
 */
let traySleepActive = false
let traySleepRemainSec = 0
/** 上一次设过的 tooltip 文本，避免重复设置 */
let lastTrayTip = ''
/**
 * 是否处于「全屏」
 *
 * 关键：这是**应用层自己维护**的状态，绝对不要读 `mainWindow.isFullScreen()`。
 *
 * 当初引入应用层模拟的原因：主窗口是 `transparent: true`，而 Windows 上透明窗口的
 * 原生全屏是失效的 —— `setFullScreen(true)` 只会把窗口撑到屏幕大小，
 * `isFullScreen()` 依旧返回 false（electron/electron#27286）。于是老代码里出现了一连串问题：
 *   - 状态被原生值回写，全屏标志永远为 false；
 *   - 退出壁纸模式时「还原」逻辑反而把窗口撑成整屏，且因为没有状态可翻转，
 *     再点全屏只会一路往「进入全屏」走，永远退不出去。
 *
 * 注意：主窗口现在**已经不透明**了（见 `createMainWindow` 里关于壁纸模式的说明），
 * 所以「透明导致原生全屏失效」这个前提不再成立。但**应用层模拟继续保留**：
 * 它已经过大量验证、并且 `fullScreenRestore` 那套还原逻辑完全建立在它之上，
 * 没有理由为了「用回原生 API」去冒回归风险。
 *
 * 所以全屏仍是应用层模拟：解除 16:9 约束 + setBounds 铺满主屏 + 置顶盖住任务栏。
 */
let isFullScreen = false
let isMaximized = false

/**
 * 初始窗口尺寸按哪个比例算
 *
 * 只用于**创建窗口时算初始高度**，不构成约束：
 * 用户选了 `'free'`（不限制）时窗口没有比例约束，但初始尺寸总得是个合理值，
 * 所以这里退回 16:9。真正的约束由 `currentAspect()` 决定。
 */
const INITIAL_SIZE_FALLBACK_ASPECT = 16 / 9

/**
 * 当前应该锁定的宽高比数值（0 = 不限制）
 *
 * 从设置里读，**不要写死** —— 踩过的坑：原来这里是 `const FULLSCREEN_ASPECT = 16/9`，
 * 散落在「建窗口 / 退出全屏 / 退出壁纸」三处；一旦用户把比例改成 4:3，
 * 这几处会把它悄悄改回 16:9（退出全屏后比例莫名变回去）。
 * 现在统一走这个函数，改设置后行为一致。
 */
const currentAspect = (): number => parseAspectRatio(getSetting()['common.windowAspectRatio'])

/**
 * 把用户设置的宽高比应用到主窗口（幂等）
 *
 * 注意全屏 / 壁纸模式下**不要**调用它 —— 那两种情况要铺满屏幕，
 * 由 `applyFullScreenGeometry()` 里的 `setAspectRatio(0)` 解除约束。
 */
const applyAspectRatio = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setAspectRatio(currentAspect())
}

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
  /**
   * 初始尺寸：尽量用「屏幕宽的 0.8」，但要**等比夹紧到屏幕内**
   *
   * **高必须显式给**（实测过）：只给 `width` 时 Electron 用默认高度 600，
   * 而 `setAspectRatio` 会**按高度反推宽度**，你指定的宽度会被覆盖掉
   * （实测给 1138 结果变成 1069）。所以这里自己算高。
   *
   * 但只按宽度算高会**超出屏幕**（实测）：
   *   - `4:3`  → 1138×854，已经比 771 的可用高还高；
   *   - `9:16` → 1138×2023，是屏幕高的 2.6 倍。
   * 窗口一旦高过屏幕，用户看不到底部的控制栏，而且拖动/还原的位置会很怪。
   * 所以两条边都按可用区域的 0.8 封顶，超了就**等比缩回来**（比例不能动，
   * 否则 `setAspectRatio` 会跟初始尺寸打架）。
   *
   * 用 `workArea` 而不是 `bounds`：任务栏要扣掉。
   */
  const workArea = screen.getPrimaryDisplay().workArea
  const maxWidth = Math.round(workArea.width * 0.8)
  const maxHeight = Math.round(workArea.height * 0.8)
  // 解析不出比例（用户选了「不限制」或填了非法值）时，退回 16:9 只为算一个合理初始尺寸
  const initialAspect = currentAspect() || INITIAL_SIZE_FALLBACK_ASPECT

  let initialWidth = maxWidth
  let initialHeight = Math.round(maxWidth / initialAspect)
  if (initialHeight > maxHeight) {
    initialHeight = maxHeight
    initialWidth = Math.round(maxHeight * initialAspect)
  }

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 800,
    minHeight: 450,
    title: 'B站音乐视频',
    frame: false,
    center: true,
    /**
     * **不透明窗口**（刻意不用 `transparent: true`）
     *
     * 踩过：透明窗口在**没有 GPU 加速**的环境（虚拟机、远程桌面、显卡驱动异常、
     * `--disable-gpu`）下，Chromium 会退回 GDI「分层窗口」来实现透明，于是窗口被设上
     * `WS_EX_LAYERED`。而分层窗口一旦 `SetParent` 到桌面壁纸层（WorkerW），
     * 桌面层的合成路径画不出它 —— 现象是**声音还在、画面没了**（实测可复现：
     * 同一台物理机加 `--disable-gpu` 立刻复现，`exstyle` 从 0x0 变成 0x80000）。
     *
     * 不透明窗口不需要分层，`exstyle` 干净（实测 `0x100`，无 `WS_EX_LAYERED`），
     * 从根上绕开这个问题。
     *
     * 界面上的毛玻璃（`--glass-bg` + `backdrop-filter`）**不受影响** ——
     * 那些元素模糊的是页面内部的视频画面，不需要窗口本身透明。
     */
    transparent: false,
    backgroundColor: '#000000',
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
  } else if (protectionEnabled()) {
    // 打包后渲染层产物是加密的，走自定义协议边解密边喂给页面
    void mainWindow.loadURL(protectedRendererUrl('index.html'))
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  // 退出全屏 / 壁纸后，按用户设置的比例恢复约束（'free' = 不限制）
  applyAspectRatio()

  /**
   * 导航护栏：只允许留在我们自己的页面上。
   *
   * preload 会附加到主窗口的每一次导航上，一旦被导航到站外（比如以后谁加了个外链跳转），
   * 那个源就能直接拿到整套 `electronAPI`（改配置、退登录、关窗口、开外链），
   * 而渲染层现在没有任何站外跳转需求 —— 打开外链一律走 `app:openExternal`。
   */
  const appOrigin =
    isDev && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : protectionEnabled()
        ? protectedRendererUrl('')
        : 'file://'
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
    const wantWallpaper =
      getSetting()['common.wallpaperMode'] || process.argv.includes('--wallpaper-mode')
    if (wantWallpaper) {
      // 开机即壁纸模式：applyWallpaperMode 会把此刻的普通窗口尺寸记成还原点，
      // 这样用户切回「窗口模式」时能还原成正常窗口而不是被困在全屏。
      // 走 setWallpaperMode（唯一入口）：它会广播状态、也会和用户在启动瞬间的点击串行化。
      void setWallpaperMode(true)
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
 * 还原点里的尺寸是否已经不可信
 *
 * 「最大化前尺寸」存在窗口的 `rcNormalPosition` 里，而原生 `SetWindowPos` 会改写它 ——
 * 壁纸模式撑满桌面层就是一次（退出时已专门还原，见 `exitWallpaperGeometry`）。
 * 如果拿到的尺寸**等于或大于整块工作区**，它基本就是被撑满操作写坏的，
 * 直接当还原点用会让窗口「还原成满屏」。
 *
 * 这里按工作区 80% 给一个合理值；只有确实异常时才动手，正常窗口不受影响。
 */
const sanitizeRestoreBounds = (bounds: Electron.Rectangle): Electron.Rectangle => {
  const area = screen.getDisplayMatching(bounds).workArea
  if (bounds.width < area.width || bounds.height < area.height) return bounds
  console.warn(
    `[win] 还原尺寸异常（${bounds.width}x${bounds.height} >= 工作区 ${area.width}x${area.height}），改用工作区 80%`,
  )
  return {
    x: area.x + Math.round(area.width * 0.1),
    y: area.y + Math.round(area.height * 0.1),
    width: Math.round(area.width * 0.8),
    height: Math.round(area.height * 0.8),
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
    // 最大化时 getBounds 是工作区大小，要取 normalBounds 才是还原用的尺寸。
    // 只有这条路径需要体检：非最大化时 getBounds 是窗口真实尺寸，本来就可信
    // （普通窗口允许跨屏、允许比工作区大，不能按工作区去卡它）。
    bounds: maximized
      ? sanitizeRestoreBounds(mainWindow.getNormalBounds())
      : mainWindow.getBounds(),
    maximized,
  }
}

/** 把窗口撑满它当前所在的那块屏（全屏的几何部分） */
const applyFullScreenGeometry = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 16:9 的宽高比约束会把 setBounds 的结果改写掉，全屏时必须先解除，
  // 否则在非 16:9 的显示器上窗口撑不满，看起来就「没全屏」
  mainWindow.setAspectRatio(0)
  /**
   * ★ **全屏几何有三条硬性顺序，全都实测踩过**
   *
   * ## ① 最大化要先还原
   *
   * Windows 不允许移动 / 缩放最大化窗口，`setBounds` 只会改写还原尺寸、不动几何。
   * 不还原的话「全屏」实际停在**最大化**的尺寸（工作区，比如 `1920x1040`），
   * 任务栏那一条仍露在外面 —— 这也是「全屏没盖住屏幕」的一种形态。
   * 还原点已经在 `captureFullScreenRestore` 里记过了（含 `maximized` 与普通尺寸），
   * 退出时 `exitFullScreen` 会按它恢复成最大化，所以这里还原不丢状态。
   *
   * ## ② 必须先开缩放 → `setBounds()` → 再关缩放
   *
   * 同一个 `setBounds(w, h)` 在两种状态下语义不一样（实测 dpi=96）：
   *
   * ```
   * 可缩放   setBounds(0,0,1920,1080) → 客户区 1920x1080   ← 按客户区解释，正好铺满
   * 不可缩放 setBounds(0,0,1920,1080) → 客户区 1904x1072   ← 按外框解释，被 8px 边框吃一圈
   * ```
   *
   * 先关缩放再 setBounds 的话，右边和下边各留 8px 缝（外框右缘停在 `x=1912`，
   * 屏幕是 `1920`），看起来就是「全屏右边没盖住」。所以刻意先打开缩放，
   * 让 `setBounds` 走「客户区」语义，铺满之后再关 —— 关缩放本身不改动几何。
   *
   * ## ③ 关缩放是为了禁掉边缘热区
   *
   * 窗口是 `frame: false`，但仍带 `WS_THICKFRAME`，那圈**不可见**的 8px 边框就是
   * 缩放热区。不关的话能在全屏下把窗口拖小，而 `isFullScreen` 仍是 true，
   * 状态和几何脱节（按 F「退出全屏」会跳回一个莫名其妙的位置）。
   * 这同时也解释了「全屏下只有顶边能拖、侧边拖不动」：外框铺满屏幕后，
   * 左右/下的那圈边框被推到屏幕外，只有顶边还在屏内。
   * 退出全屏时 `exitFullScreen` / `exitWallpaperGeometry` 会恢复成可缩放。
   *
   * 整段对同一块屏重算，重复调用幂等（`display-metrics-changed` 会再走一遍）。
   */
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  mainWindow.setResizable(true)
  // 必须按「窗口现在在哪块屏」算，写死 getPrimaryDisplay() 会把副屏上的窗口拽回主屏
  mainWindow.setBounds(screen.getDisplayMatching(mainWindow.getBounds()).bounds)
  mainWindow.setResizable(false)
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
  // 全屏时被 `applyFullScreenGeometry` 关掉的缩放要先恢复：
  // 不可缩放的窗口没有 `WS_MAXIMIZEBOX`，下面那句 `maximize()` 会失效
  mainWindow.setResizable(true)
  // 退出全屏 / 壁纸后，按用户设置的比例恢复约束（'free' = 不限制）
  applyAspectRatio()

  const point = fullScreenRestore
  fullScreenRestore = null
  if (!point) {
    // 没有记录（异常情况）：给一个合理的默认窗口尺寸，别把用户困在全屏
    mainWindow.setSize(1600, 900)
    mainWindow.center()
    return
  }
  /**
   * 原来这里是 `if (point.maximized) maximize()` —— 直接最大化、不写回尺寸。
   *
   * 那样会依赖 Windows 记着的还原尺寸（`rcNormalPosition`），而**进入全屏时那次
   * `setBounds(整屏)` 已经把它写成整屏了**：退出全屏后「拖离最大化」或点「向下还原」，
   * 窗口会还原成整屏大小（看起来像还原失效、也像拖不动）。
   * 所以这里先 `setBounds(还原点)` 把正确的尺寸写回去，再 `maximize()`。
   */
  if (point.maximized) {
    mainWindow.setBounds(point.bounds)
    mainWindow.maximize()
  } else {
    mainWindow.setBounds(point.bounds)
  }
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
  // 全屏（含壁纸模式里那次模拟全屏）关掉的缩放要恢复，否则回到窗口模式后拖不了边
  mainWindow.setResizable(true)
  // 退出全屏 / 壁纸后，按用户设置的比例恢复约束（'free' = 不限制）
  applyAspectRatio()
  if (!point) {
    // 没有记录（异常情况）：给一个合理的默认窗口尺寸，别把用户困在全屏
    mainWindow.setSize(1600, 900)
    mainWindow.center()
    return
  }
  if (point.maximized) {
    /**
     * ★ **先把「最大化前的尺寸」写回去，再最大化**
     *
     * 壁纸模式里窗口是用原生 `SetWindowPos` 撑满桌面层的，而 Windows 会把
     * 那次改动的结果记进窗口的**还原尺寸**（`rcNormalPosition`）—— 也就是说，
     * 从壁纸出来之后，窗口的「最大化前尺寸」已经悄悄变成了整屏大小。
     *
     * 后果全在用户体验上，且看起来像两个不相干的 bug：
     *  - 拖离最大化解锁 / 点还原按钮，窗口变回**整屏大小**（等于没还原）；
     *  - 于是拖动时窗口一直是满屏，"拖不动"的观感就是这么来的。
     *
     * `setBounds` 对最大化窗口只会改还原尺寸、不改变视觉，但这里先
     * `unmaximize()` 再写，纯粹是为了让语义确定（此时窗口是隐藏的，没有视觉影响）。
     */
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    mainWindow.setBounds(point.bounds)
    mainWindow.maximize()
    return
  }
  mainWindow.setBounds(point.bounds)
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
 * 壁纸模式的「贴合守护」
 *
 * 为什么需要它：窗口一旦被 `SetParent` 挂到桌面层，坐标系就变成**父窗口客户区**，
 * 而桌面层的大小是会变的 —— 任务栏改位置 / 改高度 / 自动隐藏 / 改分辨率 / 改缩放 /
 * Explorer 重建桌面窗口，任何一项都会让「窗口尺寸」和「桌面层客户区」对不上。
 * 子窗口**不会**跟着父窗口自动改尺寸，多出来或缺失的那块露的就是宿主层底色，
 * 也就是「一圈白边，而且盖不住任务栏那一条」。
 *
 * 策略是「每秒问一次、只在真不一样时才动」：尺寸一致时 `fitWallpaperWindow`
 * 立刻返回 `changed=false`，不会产生任何副作用（不重绘、不抢焦点）。
 * 之所以轮询而不是监听 `WM_SETTINGCHANGE`：子类化 Chromium 的窗口过程风险太大
 * （那套消息一进来就要和它的 `HWNDMessageHandler` 抢着处理），而每秒两次
 * `GetClientRect` 的开销可以忽略。
 */
let wallpaperFitTimer: ReturnType<typeof setInterval> | null = null
/** 上一次贴合到的尺寸（只在尺寸变化时打日志，避免每秒刷屏） */
let lastWallpaperFitSize = ''

function stopWallpaperFitGuard(): void {
  if (wallpaperFitTimer) {
    clearInterval(wallpaperFitTimer)
    wallpaperFitTimer = null
  }
}

/**
 * 让窗口重新贴合桌面层（幂等，可以高频调用）
 *
 * @param where       触发来源，只用于日志
 * @param checkParent 是否顺带检查「父窗口还是不是当前桌面层」。这项要 `EnumWindows`，
 *                    比读两次客户区矩形贵得多，所以只在必要时（显示器变化、每隔几秒）做
 */
function ensureWallpaperFit(where: string, checkParent = true): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  /**
   * ① 父窗口对不上 = 桌面层被重建过
   *
   * 改任务栏行为、重启资源管理器都可能让 Explorer 重建 WorkerW。旧句柄那棵树
   * 被丢掉之后，窗口要么跟着消失，要么留在屏幕外/尺寸异常的父窗口下面。这时
   * 只能重新挂一次（这是唯一会再发 `0x052C` 的路径，所以特意加了「检测到不一致
   * 才执行」的前置条件，正常运行时一次都不会走到）。
   */
  if (checkParent) {
    const layer = getWallpaperLayer()
    const parent = getWindowParent(mainWindow)
    if (layer && parent !== layer) {
      console.warn(`[wallpaper] ${where}: 窗口不在壁纸层（父=${parent} 期望=${layer}），重新挂载`)
      const retry = attachWallpaper(mainWindow)
      if (!retry.ok) {
        console.warn(`[wallpaper] ${where}: 重新挂载失败:`, retry.reason)
        return
      }
    }
  }

  /** ② 尺寸对不上父客户区 → 原生 `SetWindowPos` 对齐（不经过 Electron 的坐标系） */
  const fit = fitWallpaperWindow(mainWindow)
  if (!fit.ok) {
    console.warn(`[wallpaper] ${where}: 贴合桌面层失败:`, fit.reason)
    return
  }
  if (fit.changed) {
    const size = `${fit.width}x${fit.height}`
    if (size !== lastWallpaperFitSize) {
      console.log(
        `[wallpaper] ${where}: 已重新贴合桌面层 ${fit.fromWidth}x${fit.fromHeight} → ${size}`,
      )
      lastWallpaperFitSize = size
    }
  }
}

function startWallpaperFitGuard(): void {
  stopWallpaperFitGuard()
  lastWallpaperFitSize = ''
  let ticks = 0
  wallpaperFitTimer = setInterval(() => {
    if (!wallpaperEnabled || !wallpaperAttached) return
    ticks += 1
    try {
      // 父窗口每 5 秒校验一次（要 EnumWindows），尺寸每秒校验一次（只有两次 GetClientRect）
      ensureWallpaperFit('守护', ticks % 5 === 0)
    } catch (err) {
      console.warn('[wallpaper] 守护轮询异常（忽略本次）:', err)
    }
  }, 1000)
}

/**
 * 应用壁纸模式
 *
 * 修复要点（老 bug）：
 *  1. **先挂到壁纸层，再撑满**。原实现先把窗口 `setBounds` 铺满整屏并置顶、
 *     等 120ms 才 `SetParent` —— 那 120ms 里它是一个盖住任务栏和桌面图标的
 *     普通窗口，就是「进壁纸模式时闪一下全屏」。现在窗口以小尺寸直接沉到
 *     图标层后面（它在最底层，视觉上等于原地消失），再用原生 `SetWindowPos`
 *     在壁纸层里撑满，整个过程都被图标层挡着。
 *  2. 壁纸几何**不用** `setBounds`：窗口被 `SetParent` 之后坐标系是父客户区，
 *     而 Electron 仍按「顶层窗口 + 屏幕坐标」理解 bounds，两边不一致就会错位
 *     （「一圈白边 + 盖不住任务栏」的根源，见 `fitWallpaperWindow`）。
 *  3. 进入前用独立的 wallpaperRestore 记录窗口状态，退出时原样还原
 *     （原本是全屏就回到全屏，原本是最大化就回到最大化），
 *     不会再出现「退不出去的全屏」。
 *  4. 退出时**先隐藏再 detach**：否则 detach 之后那一瞬间窗口是个盖住整屏的
 *     顶层窗口，又是「闪一下全屏」。
 */
async function applyWallpaperMode(enabled: boolean): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return false

  if (enabled) {
    // 0) 原生层不可用就直接失败，别把窗口改成「铺满 + 无任务栏」的怪状态
    if (!isWallpaperAvailable()) {
      const reason = getUnavailableReason() ?? '未知原因'
      console.error('[wallpaper] 壁纸模式不可用:', reason)
      return false
    }

    // 1) 先记住进入前的状态（已有记录则保留更早的那个）
    captureWallpaperRestore()

    /**
     * 2) 挂到壁纸层 —— 此时窗口还是**原来的小尺寸**，不是全屏
     *
     * `setAspectRatio(0)`：16:9 约束会在尺寸被改写时插手，壁纸要的是「盖满客户区」，
     * 任何比例约束都是错的（退出时 `exitWallpaperGeometry` 会按设置恢复）。
     *
     * 最小化状态要先 `restore()`：最小化的窗口挂到桌面层之后画不出来，而且壁纸
     * 模式不该弹窗抢焦点，后面没有「显示它」的时机。
     */
    mainWindow.setAspectRatio(0)
    /**
     * 清掉置顶：壁纸层里「置顶」没有意义（窗口是桌面的一部分），
     * 却会在任何一次摘层（退出应用 / 回滚 / 托盘恢复）时变成
     * 「一帧置顶的整屏窗口」—— 那就是用户看到的「退出前闪一下」。
     * 退出壁纸若原本是全屏，`exitWallpaperGeometry` 会重新置顶。
     */
    mainWindow.setAlwaysOnTop(false)
    if (mainWindow.isMinimized()) mainWindow.restore()

    /**
     * 3) 挂到壁纸层
     *
     * **必须在调 attach 之前置位 `wallpaperAttached`**：`attachWallpaper` 内部
     * 只要执行到 `SetParent`，窗口就已经离开正常窗口层了 —— 哪怕它返回失败，
     * 也可能已经挂上去（比如 SetParent 成功但 GetParent 回读时机有偏差）。
     * 宁可多摘一次，也不能漏摘：漏摘 = 窗口永久卡在桌面层且不可见。
     */
    wallpaperAttached = true
    const attachResult = attachWallpaper(mainWindow)

    if (!attachResult.ok) {
      console.error('[wallpaper] attach 失败，回滚到窗口模式:', attachResult.reason)
      /**
       * 回滚：**这里必须真的 detach**
       *
       * 老代码的回滚只还原了几何 / 任务栏 / 置顶，没有把窗口 SetParent 回来 ——
       * 于是窗口留在桌面层且不可见，任务栏按钮也没有，托盘和渲染层还都以为
       * 自己是窗口模式（`wallpaperEnabled` 被翻成 false），`restoreWindow()`
       * 因此永远不会去 detach，用户点「恢复窗口」也救不回来。这是最恶劣的那个 bug。
       */
      rollbackWallpaperAttach()
      return false
    }

    // 4) 在壁纸层里撑满桌面层客户区（原生坐标，一步到位，没有过渡帧）
    const fit = fitWallpaperWindow(mainWindow)
    if (!fit.ok) console.warn('[wallpaper] 挂载后贴合桌面层失败（守护会再试）:', fit.reason)

    /**
     * 壁纸模式 = 没有任务栏按钮
     *
     * 窗口这时是「桌面的一部分」，留在任务栏上就像多开了一个程序（用户的要求：
     * 和最小化到托盘一样干净）。要回到窗口模式走托盘：左键单击图标 =
     * `restoreWindow()`，或右键菜单里的「窗口模式」。
     */
    mainWindow.setSkipTaskbar(true)
    isFullScreen = true
    mainWindow.setVisibleOnAllWorkspaces(true)

    /**
     * 从托盘进入时窗口是隐藏的（关闭到托盘 = `hide()`），挂上去也不会自己出现。
     * 用 `showInactive` 而不是 `show`：壁纸不该抢焦点，也不该把用户正在用的窗口挤下去。
     */
    if (!mainWindow.isVisible()) mainWindow.showInactive()

    // 5) 贴合守护（任务栏 / 分辨率 / DPI / Explorer 重建都会触发重新对齐）+ 托盘提示
    startWallpaperFitGuard()
    applyTrayMode()
  } else {
    /** 退出壁纸模式：先脱离壁纸层，再恢复窗口状态 */
    stopWallpaperFitGuard()

    /**
     * **先藏起来再摘**
     *
     * detach 之后窗口立刻变回顶层窗口 —— 如果这时它还是整屏尺寸，用户看到的就是
     * 「退出时又闪一下全屏」，然后才缩回小窗口。隐藏状态下做 detach + 还原几何，
     * 最后一次性 `show`，全程只有「小窗口出现」这一帧。
     */
    const wasVisible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    if (wasVisible) mainWindow?.hide()

    try {
      const detachResult = mainWindow ? detachWallpaper(mainWindow) : { ok: false }
      if (mainWindow && !detachResult.ok) {
        console.warn('[wallpaper] detach 未确认成功，仍继续还原窗口:', detachResult.reason)
      }
      resetWallpaper()
      // detach 已确认（或已尽力）→ 清除「原生层可能挂着」的标志
      if (detachResult.ok) wallpaperAttached = false

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setVisibleOnAllWorkspaces(false)
        // 任务栏按钮恢复（进入壁纸模式时被 setSkipTaskbar(true) 摘掉了）
        mainWindow.setSkipTaskbar(false)
        // 兜一次残留的置顶（壁纸层里置顶没有意义，但退出时会把整屏窗口顶在最上面）
        mainWindow.setAlwaysOnTop(false)
      }

      // 等壁纸层把窗口还回来，再还原尺寸，否则 setBounds 会被忽略（隐藏状态下等，看不见）
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (mainWindow && !mainWindow.isDestroyed()) exitWallpaperGeometry()
    } finally {
      if (mainWindow && !mainWindow.isDestroyed()) {
        /**
         * 还挂在桌面层就再硬摘一次：这时候 `show()` 出来的是一个被图标层盖住的窗口，
         * 用户会觉得「点了恢复窗口但什么都没发生」。
         */
        if (wallpaperAttached) {
          const retry = detachWallpaper(mainWindow)
          if (retry.ok) {
            wallpaperAttached = false
            resetWallpaper()
          } else {
            console.error('[wallpaper] 退出时仍未能脱离桌面层:', retry.reason)
          }
        }
        if (wasVisible) mainWindow.show()
      }
    }

    // 托盘还在（一直是同一个实例），切回「应用模式用法」就行
    applyTrayMode()
  }

  // 通知渲染进程同步状态（全屏标志可能变了）
  syncFullScreenState()
  return true
}

/**
 * attach 失败后的回滚
 *
 * 把窗口从桌面层摘回来，并把几何 / 任务栏 / 置顶全部还原。
 * 无条件尝试 detach —— 此时不知道 SetParent 到底有没有生效，
 * 而「多摘一次」是幂等且无害的，「漏摘」则是永久性故障。
 */
function rollbackWallpaperAttach(): void {
  stopWallpaperFitGuard()
  if (!mainWindow || mainWindow.isDestroyed()) {
    wallpaperAttached = false
    return
  }

  const detachResult = detachWallpaper(mainWindow)
  if (!detachResult.ok) {
    console.warn('[wallpaper] 回滚 detach 未确认成功:', detachResult.reason)
  } else {
    wallpaperAttached = false
  }
  resetWallpaper()

  mainWindow.setSkipTaskbar(false)
  mainWindow.setAlwaysOnTop(false)
  mainWindow.setVisibleOnAllWorkspaces(false)
  exitWallpaperGeometry()
  isFullScreen = false
  applyTrayMode()
}

/**
 * 切换壁纸模式的**唯一入口**（串行 + 合并）
 *
 * 踩过：`toggleWallpaper` 先翻转 `wallpaperEnabled` 再 `await applyWallpaperMode`，
 * 全程没有互斥 —— 连点（标题栏按钮 + 托盘项）或与「开机即壁纸」那次启动 apply 相撞时，
 * 两次 apply 会交错：先进壁纸的那次在 120ms 延时后才 attach，而退出的那次早已 detach
 * 并还原几何，最后 `wallpaperEnabled = false` 但窗口真的挂在桌面层、任务栏按钮也没了 ——
 * 状态与实际长期漂移，托盘左键（按标志判断）还救不回来。
 *
 * 现在：目标状态记在 `wallpaperWant`，同一时刻只跑一个 apply；跑完回头再看一眼
 * 「期间有没有被改成别的目标」，有就再跑一次 —— 即「以最后一次目标为准」。
 */
let wallpaperBusy = false
let wallpaperWant: boolean | null = null

async function setWallpaperMode(want: boolean): Promise<void> {
  wallpaperWant = want
  if (wallpaperBusy) return
  wallpaperBusy = true
  try {
    while (wallpaperWant !== null) {
      const target = wallpaperWant
      wallpaperWant = null
      wallpaperEnabled = target
      // 失败（attach 没生效）时 applyWallpaperMode 会回滚窗口状态（含 detach）并返回 false
      const ok = await applyWallpaperMode(target)
      if (!ok) wallpaperEnabled = !target
      sendToMain('wallpaper:state', wallpaperEnabled)
      refreshTray()
    }
  } finally {
    wallpaperBusy = false
  }
}

async function toggleWallpaper(): Promise<boolean> {
  // 原生层不可用时直接返回当前状态：界面会按返回值纠正按钮文案，
  // 同时下面会把原因告诉渲染层，用户能看到「为什么没反应」而不是一脸茫然
  if (!isWallpaperAvailable()) {
    const reason = getUnavailableReason() ?? '未知原因'
    console.warn('[wallpaper] 原生层不可用，忽略切换请求:', reason)
    sendToMain('wallpaper:unavailable', reason)
    return wallpaperEnabled
  }
  if (!mainWindow || mainWindow.isDestroyed()) return wallpaperEnabled
  // 基准取「最后一次目标」：连点时第二次应基于第一次的目标反向，而不是基于旧的实际值
  const want = !(wallpaperWant ?? wallpaperEnabled)
  await setWallpaperMode(want)
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

  /**
   * 登录窗口加载的是真实 B 站页面，必须自己带护栏
   *
   * 主窗口那套 `setWindowOpenHandler` + `will-navigate` 是给自家页面用的，
   * 远程页面一旦 window.open / 被重定向，就会开出应用不跟踪的新窗口
   * （共用 defaultSession，用户看到的是一个凭空冒出来的浏览器窗口）。
   * 外链一律走 `app:openExternal`，所以这里直接拒绝。
   */
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  loginWindow.webContents.on('will-navigate', (event, url) => {
    const ok = url.startsWith('https://passport.bilibili.com/') || url.startsWith('https://www.bilibili.com/')
    if (!ok) {
      console.warn('[win] 登录窗口已拦截站外导航:', url)
      event.preventDefault()
    }
  })
  loginWindow.loadURL('https://passport.bilibili.com/login').catch((err) => {
    console.warn('[win] 登录页加载失败:', err)
  })

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
    ? `BiLiWallpaperEngine · 壁纸模式\n${title}\n单击：回到窗口　右键：菜单`
    : `BiLiWallpaperEngine\n${title}\n单击：显示窗口　右键：菜单`
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
/**
 * 本次弹出是否还在进行中（`showTrayMenu` 置 true，`hideTrayMenu` 置 false）
 *
 * 和 `trayMenuShown` 不是一回事：`trayMenuShown` 只表示「已经显示过了」，
 * 而页面在菜单**收起之后**依然可能回报高度（ResizeObserver、字体加载完撑开行高）。
 * 那种回报只该更新缓存高度，绝不能顺手 `show()` 把菜单自己弹出来 —— 用户没点托盘。
 */
let trayMenuOpenRequested = false
/** 失焦后延迟判断收起的定时器 */
let blurHideTimer: ReturnType<typeof setTimeout> | null = null
/** 弹出菜单的兜底显示定时器（见 showTrayMenu） */
let trayMenuFallbackTimer: ReturnType<typeof setTimeout> | null = null
const TRAY_MENU_WIDTH = 208
/**
 * 菜单兜底高度（首屏还没量到真实高度时用）
 *
 * 按 `tray-menu.html` 的布局：外层内边距 12 + 标题 25 + 进度条 14 + 时间 22
 * + 控制行 36 + 分隔列表（4×30 + 间距 9）≈ 240。实测页面回报 **271**
 * （`.now` 的行高和 `.item` 的 `gap` 比目测高一些），兜底值取实测值更准。
 *
 * 以前这里直接写 **300**，而菜单内容是**从窗口顶部往下排**的，窗口多出来的高度
 * 全变成底部的一截透明 —— 首屏看着就是「菜单悬在半空、离任务栏很远」。
 */
const TRAY_MENU_DEFAULT_HEIGHT = 272

const trayMenuUrl = (): string =>
  isDev && process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/tray-menu.html`
    : ''

function createTrayMenuWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: TRAY_MENU_WIDTH,
    height: TRAY_MENU_DEFAULT_HEIGHT,
    show: false,
    frame: false,
    /**
     * 不透明窗口（原来是 `transparent: true`）
     *
     * 唯一目的是**不闪**：透明窗口是 layered window，每次 `show()` 都要重建分层表面，
     * Windows 上首帧经常是空的/背景没采样，看起来就是「显示一下、消失、再出现」。
     * 不透明窗口直接由 DWM 合成，没有这一帧。
     *
     * 代价是**四角变直角**，这一点已确认接受：CSS 的 `border-radius` 只在窗口透明时
     * 才看得见外侧的弧，而这台机器是 Windows 10（build 19045），DWM 没有圆角属性
     * （`DWMWA_WINDOW_CORNER_PREFERENCE` 返回 0x80070057），唯一还能裁圆角的
     * `SetWindowRgn` 是二值区域、没有抗锯齿，角上会有明显锯齿 —— 不如不圆。
     *
     * `backgroundColor` 要和 `tray-menu.html` 里 `#menu` 的底色一致，否则会露出一圈边。
     */
    transparent: false,
    backgroundColor: '#232329',
    /**
     * 不要 `WS_THICKFRAME`（Windows 专有选项，默认 `true`）
     *
     * 这是**侧边和下边那条白边**的根因。默认 `true` 时，无边框窗口依然带着
     * 「不可见缩放边框」—— 实测（koffi `GetWindowRect` / `GetClientRect` / `ClientToScreen`）：
     *
     * ```
     * thickFrame 默认 : 左边框 8  上边框 0  右边框 8  下边框 8   （物理像素）
     * thickFrame:false: 左边框 0  上边框 0  右边框 0  下边框 0
     * ```
     *
     * Chromium 只往**客户区**里画，那 8px 边框区由 DWM 用系统窗框色去填 ——
     * 于是左边、右边、下边各露出一条浅色线，**顶上 0px 所以顶部正常**，
     * 和「侧边和下边偶尔有白边」的现象完全对上（窗口重排/重绘时更明显）。
     *
     * 关掉它顺带解决两件事：
     * 1. 窗口矩形 == 客户区矩形，`setBounds(x, y, w, h)` 的矩形就是**看得见的面板**，
     *    不再整体右下偏 8px；
     * 2. 页面回报的高度就是窗口高度，面板底部不会被切掉一截。
     *
     * 代价：这个窗口不再有系统拖边缩放（本来就是 `resizable: false` 的固定尺寸菜单）
     * 和 DWM 投影。两层都用不上。
     */
    thickFrame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 要盖在任务栏和其它窗口之上，所以置顶到 screen-saver 层
    alwaysOnTop: true,
    /**
     * 关掉 `thickFrame` 之后窗口没有 NCRendering 区域，DWM 基本不会再给投影 ——
     * 留着这个开关只是不让 Electron 主动去掉窗口类上的投影样式，实际有没有要看系统。
     * 菜单本身有 1px 边框和深色底，投影丢不丢都能看清。
     */
    hasShadow: true,
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
  else if (protectionEnabled()) void win.loadURL(protectedRendererUrl('tray-menu.html'))
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
  /**
   * 菜单已经开着 → 什么都不做（**这是「右键后闪两下」的解药**）
   *
   * Windows 上同一次右键可能让 `right-click` 触发两次；「菜单开着再右键一次图标」
   * 也会再进来一趟。原来这里没有幂等保护：每进来一次都把 `trayMenuShown` 置回 false
   * 并重新装一个兜底定时器，于是 120ms 后又跑一遍 `placeAndShowTrayMenu` ——
   * `setBounds` + `show()` 再来一次，用户看到的就是菜单闪了两下。
   *
   * 顺手清掉失焦收起：这一下右键本来就发生在菜单开着的时候，光标在托盘图标上，
   * 400ms 后会被判定成「点了别处」把菜单收掉。
   */
  if (trayMenuShown && trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) {
    if (blurHideTimer) {
      clearTimeout(blurHideTimer)
      blurHideTimer = null
    }
    return
  }
  console.log('[tray] 弹出菜单')
  trayMenuShown = false
  trayMenuOpenRequested = true
  /**
   * 重新弹出时把「失焦收起」的定时器清掉
   *
   * 踩过：菜单显示着再右键一次托盘，`blur` 先排了一个 400ms 的收起判断，
   * 而这里的 120ms 兜底又把菜单 show + focus 回来 —— 400ms 到点时按光标位置
   * （在托盘图标上 = 菜单外）判定成「点了别处」，于是菜单弹出来约 400ms 后自己消失。
   */
  if (blurHideTimer) {
    clearTimeout(blurHideTimer)
    blurHideTimer = null
  }
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
  /**
   * 还不知道真实高度时（首次右键，菜单窗口刚建、页面还在加载）多等一会儿
   *
   * 120ms 是给「高度已知」的常规路径的抢速度值；首次加载 tray-menu.html + iconfont
   * 通常要 200ms 以上（dev 下 Vite 更慢），用 120ms 必然抢跑 —— 抢跑弹出的是
   * 一个**还没渲染内容**的窗口（一块纯底色）。放宽到 1s 让它基本总能等到页面回报高度；
   * 这个定时器只在页面彻底加载失败时才会赢。
   */
  const fallbackDelay = trayMenuHeight > 0 ? 120 : 1000
  trayMenuFallbackTimer = setTimeout(() => {
    trayMenuFallbackTimer = null
    if (!trayMenuShown) placeAndShowTrayMenu(trayMenuHeight || TRAY_MENU_DEFAULT_HEIGHT)
  }, fallbackDelay)
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
    // 工作区：菜单里那一项按它显示「歌单管理」还是「视频管理」
    mode: trayMode,
    sleepActive: traySleepActive,
    sleepRemainSec: traySleepRemainSec,
  }
}

/** 页面量好高度后：定位 + 显示 */
function sizeTrayMenu(height: number): void {
  const h = Math.max(60, Math.round(height))
  /**
   * 已经显示过、并且高度几乎没变 → 什么都别做
   *
   * 以前这里是 `if (trayMenuShown) return`，于是「已显示」就再也不会重定位：
   * 首屏（页面还没加载完）只能用兜底高度弹出来，等真实高度回报时被这行直接吃掉，
   * 菜单就一直停在那个人为偏高的位置 —— 这正是「第一次右键菜单离任务栏很远」的原因。
   *
   * 但也不能"变了就挪"：`Math.ceil` 的取整差会造出 1px 的假变化，
   * 每挪一次窗口就是一次重绘（看着像闪）。1px 以内当没变。
   */
  if (trayMenuShown && Math.abs(h - trayMenuHeight) <= 1) return
  trayMenuHeight = h
  console.log(`[tray] 菜单页面回报高度 ${h}px`)
  /**
   * 菜单已经收起了就别再定位
   *
   * 收起后页面仍可能回报（ResizeObserver 观察到字体加载、布局重排），
   * 那只是把高度缓存更新一下，留给下次右键用 —— 这里一旦放行，
   * `placeAndShowTrayMenu` 会把窗口 `show()` 出来，菜单自己冒出来。
   */
  if (!trayMenuOpenRequested) return
  placeAndShowTrayMenu(h)
}

/** 任务栏贴在屏幕的哪条边（`null` = 这块屏没有可见任务栏） */
type TaskbarEdge = 'top' | 'bottom' | 'left' | 'right'

/**
 * 推断这块屏的任务栏贴在哪条边
 *
 * `workArea` 是系统扣掉任务栏之后剩下的区域，所以「屏幕 `bounds` 减去 `workArea`」
 * 就是任务栏占的宽度 —— 哪边差值最大，任务栏就在哪边。这样不用去问 AppBar
 * （那要走 `SHAppBarMessage`，还得自己处理多屏和自动隐藏），Windows 已经把答案放在
 * `workArea` 里了。
 *
 * 差值都 < 2px 说明这块屏没有可见任务栏（自动隐藏、或副屏本来就没放任务栏）→ 返回
 * `null`，调用方回落到「贴图标上方、放不下翻下方」的老启发式。
 */
function detectTaskbarEdge(
  display: ReturnType<typeof screen.getDisplayMatching>
): TaskbarEdge | null {
  const b = display.bounds
  const a = display.workArea
  const insets: Record<TaskbarEdge, number> = {
    top: a.y - b.y,
    bottom: b.y + b.height - (a.y + a.height),
    left: a.x - b.x,
    right: b.x + b.width - (a.x + a.width),
  }
  let edge: TaskbarEdge | null = null
  // 2px 以内当测量误差，不当任务栏
  let widest = 2
  for (const key of ['top', 'bottom', 'left', 'right'] as const) {
    if (insets[key] > widest) {
      widest = insets[key]
      edge = key
    }
  }
  return edge
}

function placeAndShowTrayMenu(height: number): void {
  const win = trayMenuWindow
  if (!win || win.isDestroyed() || !tray) return
  let trayBounds = tray.getBounds()
  /**
   * 图标尺寸为 0 = 系统还没算好图标位置（刚注册、任务栏正在重排）
   *
   * 这种情况下 `getBounds()` 给的是 `{0,0,0,0}`，按它算出来的 y 会落到屏幕顶部，
   * 菜单弹到左上角。右键时鼠标必然在图标上，用光标位置兜一个近似的图标矩形。
   * 这是**兜底**：正常路径永远走不到这里。
   */
  if (trayBounds.width <= 0 || trayBounds.height <= 0) {
    const p = screen.getCursorScreenPoint()
    trayBounds = { x: p.x - 16, y: p.y - 16, width: 32, height: 32 }
  }
  const display = screen.getDisplayMatching(trayBounds)
  const area = display.workArea
  const width = TRAY_MENU_WIDTH
  const gap = 8
  const edge = detectTaskbarEdge(display)

  /**
   * 按任务栏所在的那条边决定弹出方向
   *
   * 原来只有一套「贴图标上方，放不下翻下方」—— 那是照着**底部任务栏**写的。
   * 任务栏挪到顶部还能靠那个「放不下就翻下方」歪打正着，挪到**侧边**就完全不成立了：
   * 竖着排的图标很窄，菜单居中于图标再往上下弹，等于横在任务栏上、
   * 把上下相邻的图标全盖住。
   */
  let x: number
  let y: number
  switch (edge) {
    /**
     * 竖着的任务栏（左侧 / 右侧）—— 图标是**从上往下**排的
     *
     * 菜单要贴着任务栏的**内侧**：左侧任务栏放图标右边，右侧任务栏放图标左边。
     * 竖直方向让菜单**底边与图标底边齐平**：垂直任务栏的托盘图标都在任务栏底部，
     * 这样菜单是「从图标往上展开」，和系统原生菜单在侧边任务栏上的观感一致。
     */
    case 'left':
      x = trayBounds.x + trayBounds.width + gap
      y = trayBounds.y + trayBounds.height - height
      break
    case 'right':
      x = trayBounds.x - width - gap
      y = trayBounds.y + trayBounds.height - height
      break
    /** 顶部任务栏：只能往图标**下方**弹（上方就是任务栏本体 / 屏幕外） */
    case 'top':
      x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2)
      y = trayBounds.y + trayBounds.height + gap
      break
    /**
     * 底部任务栏（绝大多数人）以及**检测不到任务栏**的情况
     *
     * 默认往图标上方弹；上方真放不下（屏幕太矮、图标位置异常）再翻到下方。
     */
    default:
      x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2)
      y = Math.round(trayBounds.y - height - gap)
      if (y < area.y + 4) y = Math.round(trayBounds.y + trayBounds.height + gap)
      break
  }
  /**
   * 不管哪种布局，最后都夹进工作区
   *
   * `workArea` 已经扣掉了任务栏，所以这一步同时保证「菜单不压任务栏、也不出屏」。
   * 上限要跟下限比一次：菜单高到接近工作区高度时，`area 高 - height - 4` 会小于下限，
   * 直接 `min(max(...))` 会把 y 压到屏幕上方去。
   */
  const maxX = Math.max(area.x + 4, area.x + area.width - width - 4)
  const maxY = Math.max(area.y + 4, area.y + area.height - height - 4)
  x = Math.min(Math.max(Math.round(x), area.x + 4), maxX)
  y = Math.min(Math.max(Math.round(y), area.y + 4), maxY)

  win.setBounds({ x, y, width, height })
  trayMenuShown = true
  /**
   * 只有「从隐藏变成显示」才 show + focus + 广播
   *
   * 自纠路径（首屏先用兜底高度弹、随后拿到真实高度重定位）会再进这个函数一次，
   * 那时窗口**已经可见**：再 `show()` / `focus()` 等于让它重新出场一次，
   * `trayMenu:visibility` 也会被重复广播。已可见时只做 `setBounds` 挪位置。
   */
  const wasVisible = win.isVisible()
  if (!wasVisible) {
    win.show()
    win.focus()
    // 告诉主窗口「菜单开着」：壁纸模式下它要把合成点击吞掉
    mainWindow?.webContents.send('trayMenu:visibility', true)
  }
  console.log(`[tray] 菜单${wasVisible ? '重定位' : '显示'} ${width}x${height} @ ${x},${y}`)
}

/** 收起菜单（同时清掉失焦延迟） */
function hideTrayMenu(): void {
  if (blurHideTimer) {
    clearTimeout(blurHideTimer)
    blurHideTimer = null
  }
  /**
   * 兜底显示的定时器也要清
   *
   * 不清的话：显示后 120ms 内按 Esc（或菜单被别的原因收起），那个定时器到点
   * 还会 `placeAndShowTrayMenu()` 把菜单又弹回来 —— 用户按了 Esc，菜单却自己冒出来。
   */
  if (trayMenuFallbackTimer) {
    clearTimeout(trayMenuFallbackTimer)
    trayMenuFallbackTimer = null
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) {
    trayMenuWindow.hide()
  }
  trayMenuShown = false
  trayMenuOpenRequested = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('trayMenu:visibility', false)
  }
}

/**
 * 失焦后判断要不要收起（见 createTrayMenuWindow 里 blur 的注释）
 *
 * 光标还在菜单上 = 正在点菜单（壁纸模式的鼠标转发抢走了激活），等它点完；
 * 光标已经移开 = 真的点了别处，收起。
 *
 * 注意有**次数上限**：光标一直停在菜单上时不能再无限重排（那是每 400ms 一次的轮询），
 * 观察几轮就放手 —— 真在点菜单的话，抬起/移开都会让这个循环自然结束。
 */
const BLUR_RECHECK_LIMIT = 5
function scheduleHideAfterBlur(recheck = 0): void {
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
    // 还在菜单里：继续观察（有上限），别把正在进行的这一下点掉
    if (recheck < BLUR_RECHECK_LIMIT) scheduleHideAfterBlur(recheck + 1)
  }, 400)
}

/**
 * 执行这些菜单动作时**不收起菜单**
 *
 * 判据是「这个动作会不会被连续使用」：
 *  - 进度条 / 音量：拖动是连续的，收起后用户看不到数字、也没法接着拖
 *    （踩过：鼠标一碰音量条菜单就没了）；
 *  - 上一首 / 播放暂停 / 下一首 / 循环模式：控制栏是「连点」场景 ——
 *    连着切两首、或者暂停后顺手换个模式再播。收起菜单等于每点一下
 *    都要重新右键托盘图标，很难用。
 *
 * 与之相对，下面那几项（歌单管理/视频管理 / 壁纸模式 / 退出登录 / 退出程序）
 * 都是**一次性的跳转或命令**，执行完就该收起来。
 *
 * 菜单不收起时，用户仍然可以：按 `Esc`、点菜单外面、或左键点托盘图标来关掉它。
 */
const KEEP_MENU_OPEN: ReadonlySet<TrayMenuAction> = new Set([
  'seek',
  'volume',
  'toggleMute',
  'playControl',
  'prev',
  'next',
  'toggleMode',
])

/**
 * 执行菜单动作：先收起菜单，再复用应用里已有的那套事件
 *
 * 进度条 / 音量这两个带参数，所以接 `value`。
 */
function runTrayMenuAction(action: TrayMenuAction, value?: number): void {
  // 菜单动作都记一行：出问题时能一眼看出「点了什么、有没有传参」
  console.log(`[tray] 菜单动作: ${action}${value === undefined ? '' : ' ' + value}`)
  if (!KEEP_MENU_OPEN.has(action)) {
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
       * 歌单管理 / 视频管理：壁纸模式下**先退出壁纸模式**再打开（用户要求）
       *
       * 壁纸模式下窗口在桌面层、标题栏控制栏又都是隐藏的，直接弹管理窗会看不见，
       * 所以先把窗口恢复出来，再让渲染层打开弹窗。
       *
       * 打开哪一页由渲染层决定（它更清楚当前工作区）：`openManager()` 会按
       * 当前工作区打开「歌单管理」或「视频管理」，和弹窗左下角那个切换按钮同一条路径。
       */
      void restoreWindow().then(() => sendToMain('tray:showPlaylist'))
      break
    case 'showSleepTimer':
      /**
       * 定时：和「歌单管理 / 视频管理」完全同一套跳转 —— **先回到窗口模式，再打开面板**
       *
       * 壁纸模式下窗口在桌面层、标题栏和弹窗都看不见，所以必须先 `restoreWindow`；
       * 面板本身（`SleepTimerPanel`）由渲染层管，这里只发一条「请打开」的事件。
       */
      void restoreWindow().then(() => sendToMain('tray:showSleepTimer'))
      break
    case 'toggleWallpaper':
      void toggleWallpaper()
      break
    case 'restoreWindow':
      /**
       * 「窗口模式」/「恢复窗口」都走这里
       *
       * `restoreWindow` 自己会判断「窗口是不是真的挂在桌面层」（三个条件取或），
       * 所以**不需要**一个单独的「强制…」逃生口动作：它本身就是最稳的那条路径，
       * 状态漂移时也能救回来，而且顺带 `show()` + `focus()`（点「窗口模式」就该看到窗口）。
       */
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
 *
 * **判定条件是「窗口是不是真的挂在桌面层」，不是 `wallpaperEnabled`。**
 * 老代码只看 `wallpaperEnabled`：一旦某次 attach 失败把标志翻回 false，
 * 而窗口其实还挂在 WorkerW 上，这里就会跳过 detach、直接 show() —— 而 show()
 * 对桌面层的子窗口无效，于是「点恢复窗口也回不来」。
 */
async function restoreWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const attachedToWallpaper = wallpaperEnabled || wallpaperAttached || isAttachedToWallpaper(mainWindow)
  if (attachedToWallpaper) {
    try {
      await setWallpaperMode(false)
    } catch (err) {
      console.warn('[win] 退出壁纸模式失败:', err)
    }
    // setWallpaperMode 没确认成功就硬来一次，保证窗口不在桌面层
    if (wallpaperAttached && mainWindow && !mainWindow.isDestroyed()) {
      const retry = detachWallpaper(mainWindow)
      if (retry.ok) wallpaperAttached = false
      resetWallpaper()
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
    /**
     * 左键 = 「我要用窗口了」
     *
     * 除了把窗口弄出来（壁纸模式先退出壁纸层），还要顺手**解锁界面** ——
     * 窗口模式 + 锁定状态下界面只剩左下右下两个角按钮，用户会更自然地点托盘图标，
     * 以前那一下什么都不发生（窗口本来就可见），看着像卡住了。
     * 解锁与否由渲染层判定，没锁时这个广播是无害的。
     */
    void restoreWindow().then(() => sendToMain('tray:unlock'))
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

    /**
     * 绝对超时兜底
     *
     * 这个隐藏窗口只要还在世，`window-all-closed` 就不会触发 —— 而它是 `app.quit()`
     * 的唯一入口。原来的「20 × 500ms 轮询」只在 `did-finish-load` 之后才开始跑：
     * 万一 `did-finish-load` / `did-fail-load` 都不来（加载卡死），这个窗口永不销毁，
     * 用户此后**再也无法通过关窗退出应用**（启动后十几秒内点 X 也会卡住）。
     * 所以这里给一个独立于加载事件的硬超时。
     */
    const hardTimeout = setTimeout(() => settle(), 8000)

    const wrappedSettle = (): void => {
      clearTimeout(hardTimeout)
      settle()
    }

    let pollCount = 0
    const poll = async (): Promise<void> => {
      if (settled) return
      pollCount++
      try {
        const cookies = await session.defaultSession.cookies.get({})
        if (cookies.some((c) => c.name === 'buvid3')) {
          wrappedSettle()
          return
        }
      } catch {
        /* ignore */
      }
      if (pollCount < 20) setTimeout(() => void poll(), 500)
      else wrappedSettle()
    }

    cookieWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => void poll(), 1000)
    })
    cookieWindow.webContents.on('did-fail-load', () => wrappedSettle())
    cookieWindow.webContents.on('render-process-gone', () => wrappedSettle())
    // 隐藏窗口加载的是真实 B 站页面：不许它开新窗口（弹出来会凭空出现在用户桌面上）
    cookieWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    cookieWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('https://www.bilibili.com/')) event.preventDefault()
    })
    cookieWindow.loadURL('https://www.bilibili.com/').catch(() => wrappedSettle())
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

/**
 * ★ 第 1.2 步：**单实例锁**（必须在 `app.whenReady()` 之前）
 *
 * ## 不加会怎样（踩过）
 *
 * 双击第二次图标 → 第二个实例完整跑起来 → 它也去开同一个 `blwe.db`。
 * 而 **SQLite 允许多个连接打开同一个文件**（`new Database()` 根本不会失败），
 * 于是第二个实例读到的歌单是空的（WAL 里第一个实例还没 checkpoint 的部分
 * 它看不见）—— 用户看到的就是「再开一个窗口，里面一个歌单都没有」。
 *
 * ## 为什么不是「检测数据库文件有没有被占用」
 *
 * 那个思路不可靠还会误伤：SQLite 允许多连接，检测不出「被占用」；
 * 就算能检测文件锁，它也不代表是另一个本程序实例 —— 用户开着 DB 浏览器
 * 或备份工具在读，都会被误判成「别开了」。
 *
 * 单实例锁是 Electron 自己的机制，语义精确：同一个 app 只允许一个进程。
 *
 * ## 第二个实例的处理
 *
 * 直接 `app.quit()`；第一个实例通过 `second-instance` 事件**把窗口拉到前台** ——
 * 用户点图标后能看到窗口弹出来，窗口本身就是反馈，不需要再弹「已在运行」。
 *
 * 用现成的 `restoreWindow()` 而不是裸 `mainWindow.show()`：前者会处理
 * 「窗口最小化了」「壁纸模式下窗口挂在桌面层」这些情况
 * （裸 `show()` 对挂在 WorkerW 上的子窗口是无效的，点图标毫无反应）。
 */
/**
 * 本进程有没有拿到单实例锁（`true` = 我是唯一的那个实例）
 *
 * 单独存一个变量是因为 `app.quit()` 是**异步**的：拿不到锁时光调 quit，
 * 已排队的 `whenReady` 回调照样会跑完（照样打开数据库）。所以那个回调里
 * 需要一个标记来提前返回 —— 见下面 `whenReady` 里那道守卫。
 */
let singleInstanceLockHeld = false

if (!app.requestSingleInstanceLock()) {
  /** 第二个实例：立刻退出，什么都不初始化 */
  app.quit()
} else {
  /** 拿不到锁时上面就走了，这里说明「锁拿到了」—— 供 `whenReady` 里再守一道 */
  singleInstanceLockHeld = true
  app.on('second-instance', () => {
    console.log('[main] 检测到重复启动，激活已运行的窗口')
    void restoreWindow()
  })
}

/**
 * 第 1.5 步：注册**全部**自定义协议（一次注册完）
 *
 * 两个约束叠在一起，才有这段「看起来多此一举」的合并：
 *  1. `privileges`（standard / secure / stream）**只有在 `app.whenReady()` 之前**
 *     注册才生效 —— 否则协议会被当成普通自定义协议，页面拿不到安全上下文，
 *     fetch / MSE / 媒体流全都受限；
 *  2. `registerSchemesAsPrivileged` **一生只能调用一次**，第二次会被
 *     **静默忽略**（不报错、不警告）。所以「各模块自己注册各的」这种写法
 *     会在加了第二个协议那天悄悄坏掉 —— 表现是「能导入、点了没画面」。
 *
 * 因此各模块只交出描述（`*SchemeDescriptor()`），这里统一注册一次。
 *
 * 两个协议分别是：
 *  - `blwe://`        加密后的渲染层产物（只在打包构建里启用）；
 *  - `blwe-media://`  本地视频文件的流（开发 / 打包都要）。
 */
const CUSTOM_SCHEMES: CustomScheme[] = []
{
  const protectedScheme = protectedSchemeDescriptor()
  if (protectedScheme) CUSTOM_SCHEMES.push(protectedScheme)
  CUSTOM_SCHEMES.push(mediaSchemeDescriptor())
  protocol.registerSchemesAsPrivileged(CUSTOM_SCHEMES)
}

void app.whenReady().then(async () => {
  /**
   * ★ 第二个实例在 `whenReady` 跑起来之前就退出了 —— 这里**再守一道**
   *
   * `app.quit()` 是**异步**的，它不会中断正在执行的同步代码流：上面那句
   * `if (!app.requestSingleInstanceLock()) app.quit()` 之后，Node 照样会把
   * 已排队的 `whenReady` 回调跑完 —— 于是第二个实例**依然会打开数据库**
   * （实测日志里能看到 `[playlist] 已加载 0 个歌单`）。
   *
   * 所以这里必须早退，什么都不初始化。
   *
   * 为什么用 `return` 而不是再 `app.quit()` 一次：已经 quit 过了，
   * 这里只需**停止后续初始化**；再调一次 quit 也不会更快，只是重复。
   */
  if (!singleInstanceLockHeld) return

  // 第 2 步：初始化配置（读盘 + 迁移 + 合并默认值）与歌单集合
  initSetting()
  initPlaylists()

  /**
   * 第 2.1 步：确保有一个「默认列表」（拖入单条视频的落点）
   *
   * **只在库彻底空的时候建**（第一次启动）：老用户可能已经有列表了，
   * 这时不主动塞一个新列表给他，而是把「最早的本地列表」认作默认的
   * （`ensureDefaultVideoList` 内部按「设置 → 已有本地列表 → 新建」三级兜底）。
   * 这一句同时也是「第一次打开就有一个能拖视频进去的落点」的实现。
   */
  ensureDefaultVideoList({ create: getVideoLists().length === 0 })

  /**
   * 第 2.2 步：按设置把「开机自动启动」写进系统启动项
   *
   * **每次启动都重写**（不是只在第一次）—— 见 `applyAutoLaunch` 的说明：
   * 便携版被挪动后旧路径会失效，重写一次能自动纠正。
   */
  applyAutoLaunch()

  // 第 2.5 步：装上加密资源 / 本地视频的请求处理器（要在创建窗口之前）
  installProtectedProtocol()
  installMediaProtocol()

  /**
   * 配置变化时同步托盘菜单
   *
   * 注意「启动时进入桌面壁纸模式」这个 key **故意什么都不做**：
   * 它是「下次开机进不进壁纸」的开关，不该在打开/关闭的瞬间改变当前状态
   * （用户明确要求：打开这个开关也不要立刻进壁纸模式）。
   * 当前状态只由按钮/托盘切换（`toggleWallpaper`），那边也**不回写**这个设置 —— 两件事互不干涉。
   */
  onSettingChange((_updated, keys) => {
    /**
     * 宽高比改了就立刻生效（改了设置要马上看到效果，不能等重启）
     *
     * 但**全屏 / 壁纸模式下不要动**：那两种状态由 `applyFullScreenGeometry()`
     * 用 `setAspectRatio(0)` 解除了约束，这里插一脚会把窗口缩回去。
     * 那两个状态退出时都会调 `applyAspectRatio()`，所以新比例不会丢。
     */
    if (keys.includes('common.windowAspectRatio') && !isFullScreen && !wallpaperEnabled) {
      applyAspectRatio()
    }
    /**
     * 「搜索结果过期时间」改小了要立刻见效
     *
     * 这个值只在**清理时**被读取（`prune` / 启动时的一次），所以如果不在改动的当下
     * 跑一遍清理，用户把 365 天改成 0 天之后**看不到任何变化**（既没有地址被清，
     * 也没有日志），会以为设置没生效。这里改成变化时立刻清一次：
     * 新值更短就真清掉一批，更长（或 0=永久）时这次 `clearExpiredPlayurl`
     * 自然什么都不做 —— 于是「改设置 -> 立刻看到结果」是成立的。
     */
    if (keys.includes('cache.searchResultExpireMs')) {
      /**
       * 用 `_updated` 里的**新值**而不是 `getSetting()`：两者此时一致，
       * 但显式取新值能表明「本次变化就是要用这个值算过期」，不会被以后
       * 改动 updateSetting 的时序搞坏（比如将来改成先广播再落内存）。
       */
      const maxAge = Number(_updated['cache.searchResultExpireMs']) || 0
      cacheManager.clearExpiredPlayurl(maxAge)
    }
    /**
     * 「开机自动启动」改了要**立刻写进系统启动项**
     *
     * 不能只存设置 —— 那个值只在启动时被读（`applyAutoLaunch`），
     * 用户打开开关后要等下次重启才生效，会以为没起作用。
     */
    if (keys.includes('common.autoLaunch')) {
      applyAutoLaunch()
    }
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

  /**
   * 给 B 站媒体直链的响应**统一改** CORS 头
   *
   * 渲染层是用 `fetch()` 把 dash 音视频流拉下来喂给 MSE 的（见 `src/utils/dashPlayer.ts`），
   * 所以受同源策略约束。实测两种翻车：
   *  1. 有些 CDN 响应**不带** `Access-Control-Allow-Origin` → 直接拦；
   *  2. 有些 CDN 会把**第一个请求者的 Origin** 写进 ACAO 并按 URL 缓存下来
   *     （报错原话：`ACAO has a value 'http://localhost:5173' that is not equal to the supplied origin`，
   *     那个 5173 就是开发服务器），于是别的来源（打包后的 `blwe://app`、或 `file://`）拿到一个对不上的值。
   * 所以这里**不判断、一律覆盖成 `*`**，并且删掉 `Access-Control-Allow-Credentials`
   * —— `*` 和「允许带凭据」是浏览器眼里的非法组合。
   *
   * 安全性：这些直链是带签名的时效地址，请求本身不带 cookie（要凭据的接口都在主进程 `net.fetch` 里），
   * 因此开放 `*` 不会把带凭据的响应暴露给任意站点。只动媒体域，不碰 `*.bilibili.com` 接口域。
   */
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['*://*.bilivideo.com/*', '*://*.bilivideo.cn/*'] },
    (details, callback) => {
      const headers = details.responseHeaders ?? {}
      /**
       * 必须先按**大小写不敏感**把原来的删掉再设
       *
       * 踩过：CDN 回的是小写 `access-control-allow-origin`，我直接
       * `headers['Access-Control-Allow-Origin'] = ['*']` 等于**又加了一条**，
       * 浏览器看到的是 `ACAO: blwe://app, *` —— 两个值直接判非法，
       * 本来能用的那些请求也被我搞挂了（报错从 1 条变成 20 条）。
       */
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase()
        if (
          lower === 'access-control-allow-origin' ||
          lower === 'access-control-allow-credentials'
        ) {
          delete headers[key]
        }
      }
      headers['Access-Control-Allow-Origin'] = ['*']
      callback({ responseHeaders: headers })
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
      // 窗口已销毁时 setPosition 会抛，而渲染层拿到的会是 rejected promise
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.setPosition(Math.round(x), Math.round(y))
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
      // 定时倒计时：菜单里那一项显示「定时 12:34」（到 00:00 变红）
      if (state.sleepActive !== undefined) traySleepActive = state.sleepActive
      if (state.sleepRemainSec !== undefined) {
        traySleepRemainSec = Math.max(0, Math.round(state.sleepRemainSec))
      }
      // 登录态也一起收下（防漂移：托盘菜单那一项要显示「退出登录」还是「登录」）
      if (state.isLoggedIn !== undefined && state.isLoggedIn !== isLoggedIn) {
        isLoggedIn = state.isLoggedIn
      }
      // 工作区同理：菜单文案跟着「正在播哪一边」走
      if (state.mode !== undefined) trayMode = state.mode
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

/**
 * 拖动窗口：最大化状态下先还原再跟手移动
 *
 * @returns 鼠标相对窗口左上角的偏移；`null` = 这次拖动不该发生
 */
function startWindowDrag(): { offsetX: number; offsetY: number } | null {
  if (!mainWindow) return null
  const cursor = screen.getCursorScreenPoint()

  /**
   * ★ **全屏时不允许拖动**（用户要求：和原生全屏一致）
   *
   * 老实现是「全屏时拖动 = 退出全屏 + 把窗口摆到鼠标下」。但全屏下标题栏
   * 是可见的（除非开了「全屏自动锁定」），顺手拖一下就退出全屏，
   * 既容易误触，也和系统全屏的行为不一致 —— 现在退出全屏只走 F / Esc / 按钮。
   *
   * 返回 `null` 而不是偏移量：渲染层拿到 `null` 就不会开始移动窗口。
   */
  if (isFullScreen) return null

  if (mainWindow.isMaximized()) {
    const fullBounds = mainWindow.getBounds()
    /**
     * 兜底：还原尺寸不可信时给一个合理值
     *
     * 「最大化前尺寸」存在窗口的 `rcNormalPosition` 里，任何一次原生 `SetWindowPos`
     * 都会改写它（壁纸模式撑满屏幕就是典型场景，退出时已专门还原，见
     * `exitWallpaperGeometry`）。万一它还是等于或大于整块工作区，按它还原就等于
     * 还原成满屏 —— 用户看到的是窗口没变小、接着拖也看不出位移，即「拖不动」。
     * 这里退回到工作区的 80%，保证「拖离最大化」这个动作永远有可感知的结果。
     */
    const workArea = screen.getDisplayMatching(fullBounds).workArea
    let normalBounds = mainWindow.getNormalBounds()
    if (normalBounds.width >= workArea.width && normalBounds.height >= workArea.height) {
      console.warn(
        '[win] 最大化前尺寸异常（' +
          `${normalBounds.width}x${normalBounds.height} >= 工作区 ` +
          `${workArea.width}x${workArea.height}），按工作区 80% 还原`,
      )
      normalBounds = {
        x: workArea.x + Math.round(workArea.width * 0.1),
        y: workArea.y + Math.round(workArea.height * 0.1),
        width: Math.round(workArea.width * 0.8),
        height: Math.round(workArea.height * 0.8),
      }
    }
    const ratioX =
      fullBounds.width > 0 ? (cursor.x - fullBounds.x) / fullBounds.width : 0.5
    const ratioY =
      fullBounds.height > 0 ? (cursor.y - fullBounds.y) / fullBounds.height : 0.5

    /**
     * ★ **必须用原生还原，不能用 `unmaximize()`**
     *
     * 这个函数是在**鼠标左键按着**的时候调的（渲染层判定拖动超过 5px 才发 IPC），
     * 而 `win.unmaximize()` 恰好在这种状态下是**空操作**：返回成功、`isMaximized()`
     * 仍为 true，松手也不补。窗口留在最大化状态后，下面和后续每一帧的
     * `setBounds / setPosition` 都会被 Windows 忽略 —— 用户看到的就是
     * 「最大化之后窗口拖不动」（实测对照见 `winShowState.ts` 顶部）。
     */
    const restore = restoreFromMaximized(mainWindow)
    if (!restore.restored) {
      console.warn(
        `[win] 拖离最大化失败（via=${restore.via}）:`,
        restore.reason ?? '原因未知',
      )
      return null
    }

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
  if (!mainWindow || mainWindow.isDestroyed()) return null
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
 * 把一块矩形夹回「当前还存在的某个显示器」的工作区里
 *
 * 用途：拔掉一块屏 / 改分辨率之后，进入全屏或壁纸时记下的还原点可能落在
 * **已经不存在的坐标**上。退出全屏（或退出壁纸）时照它 `setBounds`，窗口就跑到屏幕外，
 * 用户点托盘也救不回来，只能手改配置文件。
 */
function clampBoundsToDisplay(bounds: Electron.Rectangle): Electron.Rectangle {
  const displays = screen.getAllDisplays()
  const stillVisible = displays.some((d) => {
    const a = d.workArea
    // 只要有足够面积还落在某块屏上就认为可见（允许部分越界，比如贴边）
    const overlapX = Math.max(0, Math.min(a.x + a.width, bounds.x + bounds.width) - Math.max(a.x, bounds.x))
    const overlapY = Math.max(0, Math.min(a.y + a.height, bounds.y + bounds.height) - Math.max(a.y, bounds.y))
    return overlapX * overlapY > 100 * 100
  })
  if (stillVisible) return bounds

  const area = (screen.getDisplayMatching(bounds) ?? screen.getPrimaryDisplay()).workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const clamped = {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  }
  console.warn('[win] 还原点已不在任何屏幕上，夹回主屏:', JSON.stringify(bounds), '->', JSON.stringify(clamped))
  return clamped
}

/**
 * 显示器变化（拔屏 / 改分辨率 / 改缩放）后，全屏与壁纸的几何是按进入时的屏幕算的，
 * 不重算就会停在旧 bounds 上（甚至落在已经拔掉的显示器坐标里）。
 * 这里只处理「正在全屏 / 壁纸」的情况：普通窗口交给 Windows 自己钳制，别乱动用户摆好的位置。
 */
const handleDisplayChange = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 还原点先夹一遍：这和当前是否全屏无关，留着坏的还原点迟早会用到
  if (fullScreenRestore) {
    fullScreenRestore.bounds = clampBoundsToDisplay(fullScreenRestore.bounds)
  }
  if (wallpaperRestore) {
    wallpaperRestore.bounds = clampBoundsToDisplay(wallpaperRestore.bounds)
  }
  if (!isFullScreen && !wallpaperEnabled) return
  try {
    /**
     * 壁纸模式下**不能**走 `applyFullScreenGeometry`：它用的是 `setBounds`（屏幕坐标），
     * 而挂到桌面层的窗口坐标是**父客户区** —— 两套坐标系混用正是「改完分辨率就一圈白边」
     * 的来源。壁纸模式统一交给原生贴合逻辑（顺带把父窗口被重建的情况也一并处理）。
     */
    if (wallpaperEnabled) {
      ensureWallpaperFit('显示器变化')
      return
    }
    // 全屏是应用层模拟的：窗口还是顶层窗口，用屏幕坐标重算就对了
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
  /**
   * 壁纸模式下退出：先把窗口从桌面层摘下来
   *
   * 不摘的话，BrowserWindow 是带着 `SetParent(WorkerW)` 被直接销毁的，
   * 桌面壁纸 / 图标层可能停在非正常状态，用户重启前都能看到。
   * 必须在窗口销毁**之前**做。
   *
   * 判定用 `wallpaperAttached` 而不是 `wallpaperEnabled`：只要曾经执行过
   * `SetParent`，窗口就可能挂在桌面层 —— 哪怕状态标志因为某次失败已经翻回 false。
   */
  if (mainWindow && !mainWindow.isDestroyed()) {
    const needDetach = wallpaperAttached || wallpaperEnabled || isAttachedToWallpaper(mainWindow)
    if (needDetach) {
      stopWallpaperFitGuard()
      /**
       * ★ **先隐藏 + 取消置顶，再 detach**（否则退出前会在最前面闪一下）
       *
       * `detachWallpaper` 的瞬间，窗口就从桌面层变回一个**普通顶层窗口**。
       * 壁纸模式里它是整屏尺寸，而且可能还带着「进壁纸前是全屏」留下的
       * `alwaysOnTop` —— 两者一叠加，用户看到的就是「程序退出前在最前面闪一下」；
       * 正在打全屏游戏时，这一下甚至会直接把游戏挤出独占全屏。
       *
       * 窗口马上要销毁，`hide()` 不会有任何代价；置顶标志也顺手清掉，
       * 防止任何一帧的可见窗口被顶到最前。
       */
      if (mainWindow.isVisible()) mainWindow.hide()
      mainWindow.setAlwaysOnTop(false)
      const result = detachWallpaper(mainWindow)
      if (!result.ok) console.warn('[wallpaper] 退出前 detach 未确认成功（忽略）:', result.reason)
      resetWallpaper()
    }
  }
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
