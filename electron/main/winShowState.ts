/**
 * 窗口显示状态的原生操作（koffi 直接调 user32）
 *
 * ## 为什么需要这个模块
 *
 * `BrowserWindow.unmaximize()` 在**鼠标左键按着**的时候是**空操作** —— 调用返回、
 * 不抛错、`isMaximized()` 依旧是 `true`，松手后也不会补上。
 *
 * 而「拖离最大化」这个动作的第一步就发生在 mousedown 之后（左键按着），
 * 于是那条路径里的 `unmaximize()` 永远不生效：窗口仍是最大化状态，
 * 后续每一帧的 `setPosition` 被 Windows 直接忽略（最大化窗口不接受移动），
 * 用户看到的就是「最大化之后窗口拖不动」。
 *
 * 实测（同一台机器、同一进程、`frame:false` 窗口，三组对照）：
 *
 * ```
 * A 没按鼠标键：unmaximize()               → isMaximized=false，bounds 立刻变成目标值
 * B 左键按着：  unmaximize()               → isMaximized 仍为 true，
 *                                            等 250ms、松手后也仍是 true（永久失效）
 * C 左键按着：  ShowWindow(SW_RESTORE)     → isMaximized 立刻 false，bounds 正确
 * ```
 *
 * 所以这里的 `restoreFromMaximized()` 走原生 `ShowWindow`，不仅绕开上述限制，
 * 语义上也更接近「用户把最大化窗口拽下来时系统自己做的事」。
 *
 * ## 边界
 *
 * - 只在 `win32` 上加载；其他平台直接退回 Electron 的 `unmaximize()`
 * - koffi 加载失败（缺二进制）同样退回 Electron 的 API，绝不因此让主进程崩
 * - 只在**需要时**调用 `ShowWindow`：窗口本来就没最大化时什么都不做
 */
import type { BrowserWindow } from 'electron'
import type { LibraryHandle } from 'koffi'

/** SW_RESTORE：还原窗口（最大化/最小化 → 普通），与任务栏右键「还原」同一条路径 */
const SW_RESTORE = 9

interface NativeApi {
  /** 原生还原：`ShowWindow(hwnd, SW_RESTORE)` */
  showRestore: (hwnd: number) => boolean
  /** 系统眼里是不是最大化（`IsZoomed`）—— 用来验证还原有没有真的生效 */
  isZoomed: (hwnd: number) => boolean
}

let native: NativeApi | null = null
/** 初始化失败的原因（null 表示可用 / 还没试过） */
let unavailableReason: string | null = null

/**
 * 从 BrowserWindow 取原生 HWND
 *
 * HWND 是 32 位值，`getNativeWindowHandle()` 返回的却是指针宽度（x64 下 8 字节），
 * 高位可能是零扩展也可能是符号扩展 —— 统一读 64 位再截低 32 位。
 */
const hwndOf = (win: BrowserWindow): number => {
  const buf = win.getNativeWindowHandle()
  const raw = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
  return Number(raw & 0xffffffffn)
}

/**
 * 初始化 koffi 与 user32 绑定
 *
 * 用 `require` 而不是顶层 `import`：koffi 缺二进制时顶层 import 会让整个主进程起不来，
 * 而这里丢的只是一个「拖动体验优化」，不值得为它挡住启动。
 */
const initNative = (): void => {
  if (native || unavailableReason) return

  if (process.platform !== 'win32') {
    unavailableReason = `当前平台不支持原生窗口还原（${process.platform}）`
    return
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as { load: (path: string) => LibraryHandle }

    const user32 = koffi.load('user32.dll')
    const ShowWindowFn = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)')
    const IsZoomedFn = user32.func('bool __stdcall IsZoomed(intptr_t hwnd)')

    native = {
      showRestore: (hwnd) => !!ShowWindowFn(hwnd, SW_RESTORE),
      isZoomed: (hwnd) => !!IsZoomedFn(hwnd),
    }
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err)
    console.warn('[win] 原生窗口还原不可用，退回 Electron API:', unavailableReason)
  }
}

/** `restoreFromMaximized` 的结果 */
export interface RestoreFromMaximizedResult {
  /** 调用结束时窗口确实不再是最大化状态 */
  restored: boolean
  /** 走的哪条路径（只用于日志） */
  via: 'noop' | 'native' | 'electron'
  reason?: string
}

/**
 * 让最大化的窗口还原成普通窗口（**可在鼠标左键按着的时候调用**）
 *
 * 与 `win.unmaximize()` 的区别：后者在拖动过程中（左键按着）完全不生效，
 * 见文件顶部的实测对照表。
 *
 * @param win 目标窗口
 */
export const restoreFromMaximized = (win: BrowserWindow): RestoreFromMaximizedResult => {
  if (win.isDestroyed()) return { restored: false, via: 'noop', reason: '窗口已销毁' }
  if (!win.isMaximized()) return { restored: true, via: 'noop' }

  initNative()

  if (!native) {
    // 没有原生绑定：只能退回 Electron 的 API（鼠标按着时它不生效，调用方要自己判断）
    win.unmaximize()
    const ok = !win.isMaximized()
    return {
      restored: ok,
      via: 'electron',
      reason: ok ? undefined : (unavailableReason ?? 'unmaximize 未生效'),
    }
  }

  try {
    const hwnd = hwndOf(win)
    if (!hwnd) return { restored: false, via: 'native', reason: '拿不到 HWND' }

    native.showRestore(hwnd)

    /**
     * 用系统状态（`IsZoomed`）验证，而不是 `win.isMaximized()`
     *
     * 两者都会同步更新（实测），但 `IsZoomed` 是「Windows 眼里是不是最大化」的
     * 唯一真相 —— 后面 `setBounds` / `setPosition` 能不能生效，取决于这个。
     */
    if (native.isZoomed(hwnd)) {
      return { restored: false, via: 'native', reason: 'ShowWindow(SW_RESTORE) 后仍是最大化' }
    }
    return { restored: true, via: 'native' }
  } catch (err) {
    return {
      restored: false,
      via: 'native',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
