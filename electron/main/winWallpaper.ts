/**
 * 桌面壁纸模式的原生实现（koffi 直接调 Win32，替代 electron-as-wallpaper）
 *
 * ## 为什么不用 electron-as-wallpaper
 *
 * 那个库的 `attach()` 不是原子操作，而且顺序有致命缺陷（读的是它的 Rust 源码
 * `src/attach.rs` / `src/window.rs`）：
 *
 * ```rust
 * SetParent(hwnd, worker_w).unwrap();          // ① 窗口已经挂到桌面层，不可逆
 * if options.transparent {
 *     toggle_window_transparent(hwnd, true);   // ② 先打 WS_EX_LAYERED，再设属性
 * }
 * ```
 *
 * ② 里 `SetWindowLongA(... | WS_EX_LAYERED)` 和 `SetLayeredWindowAttributes(...).unwrap()`
 * 之间是一个「窗口已被摘出正常窗口层、又被打成 layered 但属性还没生效」的中间态 ——
 * 按 Win32 规则这个窗口**不显示**。一旦第二步 panic，JS 层
 * `window.wallpaperState = { isAttached: true }` 就执行不到，调用方以为「没挂上」，
 * 于是回滚；但回滚只还原了几何/任务栏，**没有 SetParent 回来** ——
 * 窗口永久留在桌面层且不可见，托盘也救不回来。
 *
 * 另外它还有个赋值 bug：`isTransparent` 写的是模块级默认值 `false` 而不是调用方传的
 * `true`，导致 `detach()` 永远不会去清 `WS_EX_LAYERED`。
 *
 * ## 现在的做法
 *
 * 1. **完全不碰 `WS_EX_LAYERED`**。主窗口本来就是 `transparent: true`，Electron 自己有
 *    透明实现；再叠一层 layered 是多余且危险的。这一步去掉后，上面那个中间态根本不存在。
 * 2. **`SetParent` 之后回读 `GetParent` 验证**。不靠「有没有抛异常」猜，而是问系统
 *    「这个窗口现在的父窗口到底是谁」。这是比错误码更可靠的正向验证。
 * 3. **失败不抛异常**，返回结构化结果，由调用方决定怎么回滚 —— 调用方必须能在
 *    「原生层可能已经挂上」的情况下无条件 `detach`。
 * 4. **koffi 是预编译的 N-API 包**，不需要 Rust 工具链。这正是原来那个库最大的坑：
 *    它靠 `cargo build` 现场编译，没装 cargo 的机器 `npm i` 直接失败，
 *    运行时 `require` 又抛异常被空 catch 吞掉，表现成「点了没反应」。
 *
 * ## 调用约定
 *
 * 所有导出函数都不抛异常（内部 try/catch 兜住），失败时返回 `ok: false` + `reason`。
 */

import type { BrowserWindow } from 'electron'
import type { LibraryHandle, TypeObject } from 'koffi'

/** 操作结果：ok=false 时 reason 说明原因（用于日志与界面提示） */
export interface WallpaperResult {
  ok: boolean
  /** 失败原因（成功时为 undefined） */
  reason?: string
}

/** 让 Explorer 把壁纸层分离成独立 WorkerW 的私有消息 */
const WM_SPAWN_WORKERW = 0x052c
/** SendMessageTimeout 的标志：正常返回 */
const SMTO_NORMAL = 0x0000
/** SPI_SETDESKWALLPAPER：让桌面重画（恢复原始壁纸层） */
const SPI_SETDESKWALLPAPER = 0x0014
/** SPIF_SENDCHANGE：把变更广播出去 */
const SPIF_SENDCHANGE = 0x0002
/** GWLP_HWNDPARENT：窗口的父窗口 / owner 句柄（用 GetWindowLongPtr 读） */
const GWLP_HWNDPARENT = -8
/** GA_PARENT：GetAncestor 取父窗口 */
const GA_PARENT = 1
/** GWL_STYLE / GWL_EXSTYLE：窗口样式（用 GetWindowLongPtr 读） */
const GWL_STYLE = -16
const GWL_EXSTYLE = -20
/** 关心的一小撮窗口样式位（用来判断窗口是不是「子窗口 / 分层窗口」） */
const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const WS_EX_LAYERED = 0x00080000
const WS_EX_TRANSPARENT = 0x00000020

/** 初始化好的原生函数集合（任一环节失败则整体为 null） */
interface NativeApi {
  /** 找到承载壁纸的那层 WorkerW；找不到返回 0 */
  findWorkerW: () => number
  setParent: (child: number, parent: number) => number
  /**
   * 取窗口在窗口层级里的**真实父窗口**
   *
   * 注意这里**不能用 `GetParent`**（实测踩过）：
   * `GetParent` 的语义是「子窗口返回 parent，带 `WS_POPUP` 的顶层窗口返回 owner」，
   * 而 `SetParent` **不会**把窗口样式改成 `WS_CHILD` —— 所以窗口挂到 WorkerW 之后，
   * 它在 `GetParent` 眼里仍然是顶层窗口，返回的是 **owner（NULL）**，永远拿不到 WorkerW。
   *
   * 实测（挂载成功后同时读三个 API，窗口确实已经在壁纸层）：
   *   GetParent(hwnd)               = 0        ← 会误判成「没挂上」
   *   GetWindowLongPtr(hwnd, -8)    = 788750   ← 真实父窗口
   *   GetAncestor(hwnd, GA_PARENT)  = 788750   ← 真实父窗口
   *
   * 用错这个 API 的后果很严重：校验永远失败 → 每次进壁纸都被回滚 detach →
   * 壁纸模式完全进不去，而且从日志上完全看不出原因（只看到「SetParent 没有生效」）。
   */
  getRealParent: (hwnd: number) => number
  /**
   * 把窗口在系统眼里的状态拍成一行文本（**只读诊断**，不改任何东西）
   *
   * 用途：排查「挂到壁纸层之后画面看不见」（虚拟机里出现过，物理机正常）。
   * 光知道「父窗口对了」不足以说明画面能显示 —— 还要看系统是否认为它可见、
   * 矩形是否正确、是不是被当成子窗口/分层窗口、以及 DWM 合成有没有开。
   */
  describeWindow: (hwnd: number) => string
  /** 让系统重画桌面壁纸（把桌面层恢复成正常状态） */
  resetWallpaper: () => void
}

let native: NativeApi | null = null
/** koffi / Win32 初始化失败的原因；null 表示可用 */
let unavailableReason: string | null = null

/**
 * 从 BrowserWindow 取原生 HWND
 *
 * HWND 是 32 位值，但 `getNativeWindowHandle()` 返回的是指针宽度（x64 下 8 字节）。
 * 高位可能是零扩展（常见）也可能是符号扩展，所以统一读成 64 位再截低 32 位 ——
 * 直接用 `readUInt32LE(0)` 在符号扩展的情况下会拿到错的句柄。
 */
const hwndOf = (win: BrowserWindow): number => {
  const buf = win.getNativeWindowHandle()
  const raw = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
  return Number(raw & 0xffffffffn)
}

/**
 * 初始化 koffi 与 Win32 函数
 *
 * 用 `require` 而不是顶层 `import`：koffi 本身加载失败（缺二进制、平台不支持）时，
 * 顶层 import 会让整个主进程起不来。这里必须能降级。
 */
const initNative = (): void => {
  if (native || unavailableReason) return

  if (process.platform !== 'win32') {
    unavailableReason = `当前平台不支持壁纸模式（${process.platform}）`
    return
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as {
      load: (path: string) => LibraryHandle
      proto: (definition: string) => TypeObject
      /** 声明 C 结构体（这里用来接收 GetWindowRect 的 RECT） */
      struct: (name: string, def: Record<string, string>) => TypeObject
    }

    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')

    const FindWindowA = user32.func('intptr_t FindWindowA(const char *cls, const char *win)')
    const FindWindowExA = user32.func(
      'intptr_t FindWindowExA(intptr_t parent, intptr_t after, const char *cls, const char *win)',
    )
    const SendMessageTimeoutA = user32.func(
      'intptr_t SendMessageTimeoutA(intptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam, uint32 flags, uint32 timeout, void *out)',
    )
    const SetParentFn = user32.func('intptr_t SetParent(intptr_t child, intptr_t parent)')
    /**
     * 取真实父窗口的两个 API（两个都用，互为交叉验证）
     *
     * 刻意**不加载 `GetParent`** —— 它对被 `SetParent` 挂走的顶层窗口返回 owner(NULL)，
     * 拿不到真实父窗口（原因见 NativeApi.getRealParent 的注释）。
     */
    const GetWindowLongPtrA = user32.func('intptr_t GetWindowLongPtrA(intptr_t hwnd, int index)')
    const GetAncestorFn = user32.func('intptr_t GetAncestor(intptr_t hwnd, uint32 flags)')
    const SystemParametersInfoA = user32.func(
      'int SystemParametersInfoA(uint action, uint param, void *data, uint winIni)',
    )
    /**
     * 诊断用的只读 API（都是「问系统现在什么样」，不修改任何状态）
     *
     * `GetWindowRect` 的第二个参数要求一个 RECT 结构体（4 个 int32 = 16 字节），
     * 用 koffi 的 `struct` 声明后传 Buffer 即可。
     */
    const IsWindowVisibleFn = user32.func('int IsWindowVisible(intptr_t hwnd)')
    const IsIconicFn = user32.func('int IsIconic(intptr_t hwnd)')
    const GetWindowRectFn = user32.func('int GetWindowRect(intptr_t hwnd, _Out_ void *rect)')
    const RECT = koffi.struct('RECT', {
      left: 'int32',
      top: 'int32',
      right: 'int32',
      bottom: 'int32',
    })
    void RECT
    // DwmIsCompositionEnabled 在 dwmapi.dll（不是 user32）
    const dwmapi = koffi.load('dwmapi.dll')
    const DwmIsCompositionEnabledFn = dwmapi.func(
      'int DwmIsCompositionEnabled(_Out_ int *enabled)',
    )
    // EnumWindows 是唯一需要回调原型的 API；返回值 true 表示继续枚举
    //
    // 注意 `koffi.proto` 是**注册**一个原型类型（副作用），注册后就能在下面的
    // 函数声明字符串里按名字引用 `EnumWindowsProc`。所以这个绑定本身不参与运算，
    // 用 `void` 明确表示「只为了注册」。
    const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(intptr_t hwnd, intptr_t lParam)')
    void EnumWindowsProc
    const EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc *cb, intptr_t lParam)')

    // kernel32 也 load 一下：确认基础库可用，失败时能给出明确原因
    void kernel32

    const findWorkerW = (): number => {
      const progman = Number(FindWindowA('Progman', null))
      if (!progman) {
        console.error('[wallpaper] 找不到 Progman 窗口（Explorer 没在运行？）')
        return 0
      }

      // 让 Explorer 把壁纸层分离出来，否则壁纸窗口会盖在图标上面
      SendMessageTimeoutA(progman, WM_SPAWN_WORKERW, 0xd, 0x1, SMTO_NORMAL, 1000, null)

      let worker = 0
      EnumWindows((hwnd: number) => {
        // 挂着 SHELLDLL_DefView 的那层是「图标层」，它后面那个 WorkerW 才是壁纸层
        if (FindWindowExA(hwnd, 0, 'SHELLDLL_DefView', null)) {
          const w = Number(FindWindowExA(0, hwnd, 'WorkerW', null))
          if (w) worker = w
        }
        return true
      }, 0)

      // 兜底：某些 Win10 配置下 WorkerW 直接挂在 Progman 下
      if (!worker) worker = Number(FindWindowExA(progman, 0, 'WorkerW', null))

      if (!worker) console.error('[wallpaper] 没找到 WorkerW，桌面结构异常（壁纸模式不可用）')
      return worker
    }

    native = {
      findWorkerW,
      setParent: (child, parent) => Number(SetParentFn(child, parent)),
      getRealParent: (hwnd) => {
        /**
         * 两个 API 都读，取「非零的那个」；不一致时以 `GetAncestor` 为准。
         *
         * 实测两者一致（都返回 WorkerW），但 `GWLP_HWNDPARENT` 在某些
         * 窗口样式组合下语义偏 owner，`GetAncestor(GA_PARENT)` 更贴近
         * 「窗口挂在谁下面」这个问题本身，所以它优先。
         */
        const ancestor = Number(GetAncestorFn(hwnd, GA_PARENT))
        if (ancestor) return ancestor
        return Number(GetWindowLongPtrA(hwnd, GWLP_HWNDPARENT))
      },
      describeWindow: (hwnd) => {
        /**
         * 只读快照：把排查「画面看不见」需要的几个事实拼成一行
         *
         * 每一项都包在自己的 try 里 —— 诊断函数**绝不能**因为某个 API
         * 不可用（比如老系统没有 dwmapi）而把 attach 流程搞挂。
         */
        const parts: string[] = []
        const safe = (label: string, fn: () => string): void => {
          try {
            parts.push(`${label}=${fn()}`)
          } catch {
            parts.push(`${label}=?`)
          }
        }

        safe('visible', () => String(Number(IsWindowVisibleFn(hwnd))))
        safe('iconic', () => String(Number(IsIconicFn(hwnd))))
        safe('style', () => {
          const st = Number(GetWindowLongPtrA(hwnd, GWL_STYLE))
          return `0x${(st >>> 0).toString(16)}(child=${st & WS_CHILD ? 1 : 0},visibleBit=${
            st & WS_VISIBLE ? 1 : 0
          })`
        })
        safe('exstyle', () => {
          const ex = Number(GetWindowLongPtrA(hwnd, GWL_EXSTYLE))
          return `0x${(ex >>> 0).toString(16)}(layered=${ex & WS_EX_LAYERED ? 1 : 0},transparent=${
            ex & WS_EX_TRANSPARENT ? 1 : 0
          })`
        })
        safe('rect', () => {
          const buf = Buffer.alloc(16)
          GetWindowRectFn(hwnd, buf)
          const l = buf.readInt32LE(0)
          const t = buf.readInt32LE(4)
          const r = buf.readInt32LE(8)
          const b = buf.readInt32LE(12)
          return `${l},${t} ${r - l}x${b - t}`
        })
        safe('dwmComposition', () => {
          const buf = Buffer.alloc(4)
          const hr = DwmIsCompositionEnabledFn(buf)
          return `${buf.readInt32LE(0)}${hr !== 0 ? `(hr=0x${(hr >>> 0).toString(16)})` : ''}`
        })

        return parts.join('  ')
      },
      resetWallpaper: () => {
        /**
         * 第三个参数传 null = 「沿用当前壁纸」，只是触发一次桌面重画。
         *
         * **故意忽略返回值**：这个调用在部分环境下会失败（实测在受限令牌 / 沙箱进程里
         * 返回 0 且 `GetLastError` 是 5 = 拒绝访问）。它只是「让桌面重画一下」的
         * 锦上添花，不是必需步骤 —— 原来的库在这里 `.unwrap()`，失败就 panic，
         * 反而会把一次无关紧要的清理变成异常。
         */
        SystemParametersInfoA(SPI_SETDESKWALLPAPER, 0, null, SPIF_SENDCHANGE)
      },
    }
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err)
    console.error('[wallpaper] 原生模块初始化失败，壁纸模式不可用:', unavailableReason)
  }
}

/** 壁纸模式是否可用（koffi + Win32 是否就绪） */
export const isWallpaperAvailable = (): boolean => {
  initNative()
  return native !== null
}

/** 不可用的原因（可用时为 null）—— 用于界面提示与日志 */
export const getUnavailableReason = (): string | null => {
  initNative()
  return unavailableReason
}

/**
 * 把窗口挂到桌面壁纸层
 *
 * 关键：**不修改任何窗口样式**（尤其不碰 `WS_EX_LAYERED`），只做 SetParent，
 * 然后回读真实父窗口来验证。这样即使失败，窗口也只是「还在正常层」，
 * 不会停在不可见的中间态。
 */
export const attachWallpaper = (win: BrowserWindow): WallpaperResult => {
  initNative()
  if (!native) return { ok: false, reason: unavailableReason ?? '原生模块不可用' }
  if (win.isDestroyed()) return { ok: false, reason: '窗口已销毁' }

  const worker = native.findWorkerW()
  if (!worker) return { ok: false, reason: '找不到桌面壁纸层（WorkerW）' }

  const hwnd = hwndOf(win)

  /**
   * 挂载前后各打一行窗口状态（**只读诊断**）
   *
   * 为什么要这个：曾经出现过「挂上了、声音正常、但画面看不见」，而且只在虚拟机里复现。
   * 光看「父窗口对不对」不足以判断画面能不能显示 —— 这行日志把系统眼里的可见性、
   * 矩形、子窗口/分层窗口标志、DWM 合成状态一起打出来，一眼就能看出是哪一环不对。
   * 物理机上只是多两行日志，行为完全不变。
   */
  const describe = (): string => {
    try {
      return native?.describeWindow(hwnd) ?? '(native 不可用)'
    } catch {
      return '(describe 失败)'
    }
  }
  console.log(`[wallpaper] 挂载前: parent=${native.getRealParent(hwnd)}  ${describe()}`)

  try {
    native.setParent(hwnd, worker)
  } catch (err) {
    return { ok: false, reason: `SetParent 抛错: ${err instanceof Error ? err.message : String(err)}` }
  }

  /**
   * 正向验证：问系统「这个窗口现在挂在谁下面」
   *
   * 比看 SetParent 的返回值/错误码可靠 —— SetParent 成功时返回的是**旧父窗口**，
   * 顶层窗口就是 0，光看返回值会把成功误判成失败（实测 `SetLastError` 也可能是
   * 上一次调用残留的 87，完全不能当依据）。
   */
  const actualParent = native.getRealParent(hwnd)
  console.log(`[wallpaper] 挂载后: parent=${actualParent}(期望 ${worker})  ${describe()}`)
  if (actualParent !== worker) {
    return {
      ok: false,
      reason: `SetParent 没有生效（期望父窗口 ${worker}，实际 ${actualParent}）`,
    }
  }

  return { ok: true }
}

/**
 * 把窗口从桌面壁纸层摘下来
 *
 * 幂等：窗口本来就不在壁纸层时直接返回成功。
 */
export const detachWallpaper = (win: BrowserWindow): WallpaperResult => {
  initNative()
  if (!native) return { ok: false, reason: unavailableReason ?? '原生模块不可用' }
  if (win.isDestroyed()) return { ok: false, reason: '窗口已销毁' }

  const hwnd = hwndOf(win)

  try {
    // 传 0 = 恢复成顶层窗口（父窗口为桌面）
    native.setParent(hwnd, 0)
  } catch (err) {
    return { ok: false, reason: `SetParent 抛错: ${err instanceof Error ? err.message : String(err)}` }
  }

  const worker = native.findWorkerW()
  const actualParent = native.getRealParent(hwnd)
  if (worker && actualParent === worker) {
    return { ok: false, reason: 'SetParent 没有摘下来（窗口仍挂在壁纸层）' }
  }

  return { ok: true }
}

/**
 * 让系统重画桌面壁纸层
 *
 * 窗口从桌面层摘走后，Explorer 不一定立刻重排；调用一次让桌面恢复干净。
 * 失败无所谓（只是重画），所以不返回结果。
 */
export const resetWallpaper = (): void => {
  initNative()
  if (!native) return
  try {
    native.resetWallpaper()
  } catch (err) {
    console.warn('[wallpaper] 重画桌面失败（忽略）:', err)
  }
}

/**
 * 窗口当前是否真的挂在壁纸层
 *
 * 用于 `restoreWindow()`（托盘「窗口模式」/「恢复窗口」）：不看应用自己的状态标志，
 * 直接问系统 —— 这样即使标志漂移了也能把窗口正确摘回来。
 */
export const isAttachedToWallpaper = (win: BrowserWindow): boolean => {
  initNative()
  if (!native || win.isDestroyed()) return false
  try {
    const worker = native.findWorkerW()
    if (!worker) return false
    return native.getRealParent(hwndOf(win)) === worker
  } catch {
    return false
  }
}
