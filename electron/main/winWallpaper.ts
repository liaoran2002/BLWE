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
 * 1. **完全不碰 `WS_EX_LAYERED`**。窗口自己不该被这里叠上分层窗口标志 ——
 *    上面那个「已挂到桌面层、又被打成 layered 但属性还没生效」的中间态
 *    正是因为动了这个标志才存在的。不碰它，中间态根本不存在。
 *
 *    > 补充：主窗口**现在也不透明**了（`transparent: false`，见 `index.ts`）——
 *    > 那是为了解决「无 GPU 加速时 Chromium 退回 GDI 分层窗口实现，
 *    > 挂到 WorkerW 后画不出来」的问题。所以「窗口自己会透明」这个前提
 *    > 在当前版本**并不成立**；但结论不变：这里一律不碰 `WS_EX_LAYERED`，
 *    > 实测不透明窗口的 `exstyle` 是干净的（0x100，没有 0x80000）。
 * 2. **`SetParent` 之后回读「真实父窗口」验证**（用 `GetAncestor(GA_PARENT)`，
 *    **不是** `GetParent` —— 后者对挂走的顶层窗口返回 owner，详见 `getRealParent` 的说明）。
 *    不靠「有没有抛异常」猜，而是问系统「这个窗口现在的父窗口到底是谁」。
 *    这是比错误码更可靠的正向验证。
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

/**
 * `SetWindowPos` 的标志位
 *
 *  - `SWP_NOZORDER`：不改变 z 序。**必须带** —— 否则窗口会被提到同层最上面，
 *    而桌面层里可能还有别的壁纸程序，抢 z 序是多余且有害的副作用。
 *  - `SWP_NOACTIVATE`：不激活窗口（壁纸不该抢焦点）。
 *  - `SWP_NOSENDCHANGING`：跳过 `WM_WINDOWPOSCHANGING`。防的是「某个子类化过的
 *    窗口过程在里面把新尺寸改回去」——这类拦截我们无从控制，直接绕过。
 *    注意**仍然会收到 `WM_WINDOWPOSCHANGED`**，Chromium 靠它同步自己的 bounds，
 *    所以不会出现「原生改了、Electron 不知道」的错位。
 */
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_NOSENDCHANGING = 0x0400

/** 初始化好的原生函数集合（任一环节失败则整体为 null） */
interface NativeApi {
  /** 找到承载壁纸的那层 WorkerW；找不到返回 0 */
  findWorkerW: () => number
  /**
   * 同上，但**不发** `0x052C`（不惊动 Explorer）
   *
   * 守护轮询会高频调用，「每次问一个句柄就顺手让 Explorer 重建一次壁纸层」
   * 显然不行。查找本身是只读的，真正需要 `0x052C` 的只有「第一次要往里挂」。
   */
  findWorkerWQuiet: () => number
  /**
   * 把窗口对齐到父窗口的客户区（幂等：尺寸已经一致就什么都不做）
   *
   * 为什么必须用原生 `SetWindowPos` 而不是 Electron 的 `setBounds`：
   * 窗口一旦被 `SetParent` 挂到 WorkerW，它的坐标系就变成**父窗口客户区**，
   * 而 Electron 侧仍然按「顶层窗口 + 屏幕坐标」理解 `bounds`。两边各说各话，
   * 任务栏 / DPI / 分辨率一变就会错位（本项目出现过的「一圈白边 + 盖不住任务栏」
   * 就是这个错位）。原生这条路只有一个坐标系，不存在歧义。
   */
  fitToParent: (
    child: number,
    parent: number,
  ) => {
    changed: boolean
    width: number
    height: number
    /** 改动之前窗口的客户区尺寸（没改时与 width/height 相同） */
    fromWidth: number
    fromHeight: number
    reason?: string
  }
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
    /** 客户区矩形：取父窗口（WorkerW）的宽度高度，窗口要盖满的就是这块 */
    const GetClientRectFn = user32.func('int GetClientRect(intptr_t hwnd, _Out_ void *rect)')
    /**
     * 客户区原点 → 屏幕坐标（`POINT` = 两个 int32，8 字节）
     *
     * 用来算窗口的「左边框 / 上边框」有多宽。`SetWindowPos` 定位的是**外框**，
     * 而我们要对齐的是**客户区**，两者差的就是这块边框（见 `fitToParent`）。
     */
    const ClientToScreenFn = user32.func('int ClientToScreen(intptr_t hwnd, void *point)')
    /** 唯一用来**改**几何的 API（见 NativeApi.fitToParent 的说明） */
    const SetWindowPosFn = user32.func(
      'int SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint flags)',
    )
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

    /**
     * 只读查找桌面壁纸层（**不发任何消息**）
     *
     * 逻辑和原来一样：挂着 `SHELLDLL_DefView` 的那层是图标层，它**后面**那个
     * WorkerW 才是壁纸层；某些配置下 WorkerW 直接挂在 Progman 下，就走兜底。
     */
    const locateWorkerW = (): number => {
      const progman = Number(FindWindowA('Progman', null))
      if (!progman) return 0

      let worker = 0
      EnumWindows((hwnd: number) => {
        if (FindWindowExA(hwnd, 0, 'SHELLDLL_DefView', null)) {
          const w = Number(FindWindowExA(0, hwnd, 'WorkerW', null))
          if (w) worker = w
        }
        return true
      }, 0)

      // 兜底：某些 Win10 配置下 WorkerW 直接挂在 Progman 下
      if (!worker) worker = Number(FindWindowExA(progman, 0, 'WorkerW', null))
      return worker
    }

    const findWorkerWQuiet = (): number => locateWorkerW()

    const findWorkerW = (): number => {
      const progman = Number(FindWindowA('Progman', null))
      if (!progman) {
        console.error('[wallpaper] 找不到 Progman 窗口（Explorer 没在运行？）')
        return 0
      }

      // 让 Explorer 把壁纸层分离出来，否则壁纸窗口会盖在图标上面
      SendMessageTimeoutA(progman, WM_SPAWN_WORKERW, 0xd, 0x1, SMTO_NORMAL, 1000, null)

      const worker = locateWorkerW()
      if (!worker) console.error('[wallpaper] 没找到 WorkerW，桌面结构异常（壁纸模式不可用）')
      return worker
    }

    /** 读 RECT（4 个 int32，按小端硬解，和历史代码保持一致） */
    const readRect = (buf: Buffer): { w: number; h: number } => ({
      w: buf.readInt32LE(8) - buf.readInt32LE(0),
      h: buf.readInt32LE(12) - buf.readInt32LE(4),
    })

    /** 同上，但连左上角一起读（算边框宽度要用到位置） */
    const readRectFull = (buf: Buffer): { l: number; t: number; r: number; b: number } => ({
      l: buf.readInt32LE(0),
      t: buf.readInt32LE(4),
      r: buf.readInt32LE(8),
      b: buf.readInt32LE(12),
    })

    /** 客户区原点（传入 hwnd 的客户区 (0,0)）在屏幕上的坐标；失败返回 null */
    const clientOrigin = (hwnd: number): { x: number; y: number } | null => {
      const buf = Buffer.alloc(8)
      if (!ClientToScreenFn(hwnd, buf)) return null
      return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) }
    }

    native = {
      findWorkerW,
      findWorkerWQuiet,
      fitToParent: (child, parent) => {
        if (!child || !parent) {
          return { changed: false, width: 0, height: 0, fromWidth: 0, fromHeight: 0, reason: '句柄为空' }
        }

        const pb = Buffer.alloc(16)
        if (!GetClientRectFn(parent, pb)) {
          return {
            changed: false,
            width: 0,
            height: 0,
            fromWidth: 0,
            fromHeight: 0,
            reason: 'GetClientRect(parent) 失败',
          }
        }
        const p = readRect(pb)
        // 父客户区取不到有效尺寸时**不要**动窗口：用 0x0 去 SetWindowPos 会把壁纸缩没
        if (p.w <= 0 || p.h <= 0) {
          return {
            changed: false,
            width: p.w,
            height: p.h,
            fromWidth: p.w,
            fromHeight: p.h,
            reason: `父客户区尺寸无效 ${p.w}x${p.h}`,
          }
        }

        const cb = Buffer.alloc(16)
        const c = GetClientRectFn(child, cb) ? readRect(cb) : { w: 0, h: 0 }

        /**
         * ★ **`SetWindowPos` 的 `cx/cy` 是外框尺寸，不是客户区尺寸**
         *
         * `frame: false` 的窗口并不是「零边框」—— Windows 上它仍然带着
         * `WS_THICKFRAME`（用来支持边缘拖拽缩放），只是那圈边框不可见。实测：
         *
         * ```
         * 窗口 windowRect 1935x1048   clientRect 1919x1040
         * 边框: 左 8  上 0  右 8  下 8        （DIP 与物理像素一致时为 8px，随 DPI 变）
         * ```
         *
         * 早先这里直接把**父客户区尺寸**传给 `SetWindowPos`，于是客户区被这圈边框
         * 吃掉一圈 —— 露出的正是「两侧 + 下面」的 8px 白边（上边框为 0，所以上面没有）。
         *
         * 正确做法：把外框反推出去
         *   - 位置 = 目标客户区原点 − (左边框, 上边框)
         *   - 尺寸 = 目标客户区尺寸 + (左+右边框, 上+下边框)
         * 这样客户区才**严丝合缝**等于父客户区（外框会超出父区域那几个像素，
         * 超出部分只是不可见的边框，会被父窗口裁掉）。
         */
        let padLeft = 0
        let padTop = 0
        let padW = 0
        let padH = 0
        const wb = Buffer.alloc(16)
        if (GetWindowRectFn(child, wb) && GetClientRectFn(child, cb)) {
          const w = readRectFull(wb)
          const origin = clientOrigin(child)
          if (origin) {
            padLeft = origin.x - w.l
            padTop = origin.y - w.t
          }
          const fw = w.r - w.l
          const fh = w.b - w.t
          if (fw > 0 && fh > 0) {
            padW = fw - c.w
            padH = fh - c.h
          }
        }

        /** 客户区是否已经等于父客户区，**且**左上角对齐到父客户区的 (0,0) */
        const aligned = (): boolean => {
          if (c.w !== p.w || c.h !== p.h) return false
          const co = clientOrigin(child)
          const po = clientOrigin(parent)
          if (!co || !po) return true // 读不到偏移就只认尺寸，避免每次都白改一次
          return co.x === po.x && co.y === po.y
        }

        if (aligned()) {
          return { changed: false, width: p.w, height: p.h, fromWidth: c.w, fromHeight: c.h }
        }

        const ok = SetWindowPosFn(
          child,
          0, // 配合 SWP_NOZORDER，这个参数被忽略
          -padLeft,
          -padTop,
          p.w + padW,
          p.h + padH,
          SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING,
        )
        return {
          changed: !!ok,
          width: p.w,
          height: p.h,
          fromWidth: c.w,
          fromHeight: c.h,
          reason: ok ? undefined : 'SetWindowPos 返回 0',
        }
      },
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

/** 当前桌面壁纸层句柄（只读、不惊动 Explorer）；取不到返回 0 */
export const getWallpaperLayer = (): number => {
  initNative()
  if (!native) return 0
  try {
    return native.findWorkerWQuiet()
  } catch {
    return 0
  }
}

/** 窗口此刻的真实父窗口句柄（顶层窗口为 0） */
export const getWindowParent = (win: BrowserWindow): number => {
  initNative()
  if (!native || win.isDestroyed()) return 0
  try {
    return native.getRealParent(hwndOf(win))
  } catch {
    return 0
  }
}

/** `fitWallpaperWindow` 的结果 */
export interface WallpaperFitResult {
  /** 没有失败（`changed=false` 也算成功） */
  ok: boolean
  /** 这次是否真的改了几何 */
  changed: boolean
  /** 对齐后应是（或已是）的尺寸 */
  width: number
  height: number
  /** 对齐前窗口的尺寸（排查「是谁把窗口改小了」时最关键的一个数） */
  fromWidth: number
  fromHeight: number
  reason?: string
}

/**
 * 让窗口重新盖满桌面层的客户区（幂等）
 *
 * 这是「任务栏大小 / 位置变化后出现一圈白边、盖不住任务栏」的修法本体：
 *
 *  - 窗口挂到 WorkerW 之后坐标是**父客户区**，而任务栏一动，桌面层的大小就变了
 *    （任务栏占的地方越多，壁纸层能被盖住的区域越小）。子窗口**不会**跟着父窗口
 *    自动改尺寸 —— 于是窗口还是旧尺寸，多出来的那块露的是宿主层的底色，
 *    就是用户看到的那圈「白边」。
 *  - 这里每次都问一遍父客户区，和窗口当前客户区比，不一致才 `SetWindowPos`。
 *    所以可以放心地高频调用（守护轮询就是每秒一次），尺寸对的时候零副作用。
 */
export const fitWallpaperWindow = (win: BrowserWindow): WallpaperFitResult => {
  const fail = (reason: string): WallpaperFitResult => ({
    ok: false,
    changed: false,
    width: 0,
    height: 0,
    fromWidth: 0,
    fromHeight: 0,
    reason,
  })

  initNative()
  if (!native) return fail(unavailableReason ?? '原生模块不可用')
  if (win.isDestroyed()) return fail('窗口已销毁')

  try {
    const hwnd = hwndOf(win)
    const parent = native.getRealParent(hwnd)
    if (!parent) return fail('窗口不在任何父窗口下')
    const r = native.fitToParent(hwnd, parent)
    return {
      ok: !r.reason,
      changed: r.changed,
      width: r.width,
      height: r.height,
      fromWidth: r.fromWidth,
      fromHeight: r.fromHeight,
      reason: r.reason,
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
