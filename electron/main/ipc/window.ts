/**
 * 窗口控制 IPC
 */
import { mainHandle } from '@common/mainIpc'
import type { IpcContext } from '../ipcHandlers'

export const registerWindowHandlers = (context: IpcContext): void => {
  mainHandle('win:minimize', () => {
    context.getMainWindow()?.minimize()
  })

  mainHandle('win:close', () => {
    context.getMainWindow()?.close()
  })

  mainHandle('win:maximize', () => {
    const win = context.getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  mainHandle('win:isMaximized', () => context.getMainWindow()?.isMaximized() ?? false)

  mainHandle('win:toggleFullscreen', () => {
    if (!context.getMainWindow()) return false
    context.toggleFullScreen()
    return context.isFullScreen()
  })

  /**
   * ⚠️ **不能用 `win.isFullScreen()`** —— 全屏状态由主进程自己维护
   *
   * 历史原因：主窗口曾经是 `transparent: true`，而 Windows 上透明窗口的原生全屏
   * 是失效的（`setFullScreen(true)` 只把窗口撑大，`isFullScreen()` 仍返回 false），
   * 所以改成「应用层模拟全屏 + 主进程自维护标志」。
   *
   * 现在主窗口**已经不透明了**（见 `index.ts` 里 `transparent: false` 的说明：
   * 为了绕开「无 GPU 加速 → WS_EX_LAYERED → 挂到 WorkerW 后画面消失」），
   * 所以那个前提不再成立。但**应用层模拟继续保留** ——
   * `fullScreenRestore` 那套还原逻辑完全建立在它之上，
   * 没有理由为用回原生 API 去冒回归风险。
   */
  mainHandle('win:isFullscreen', () => context.isFullScreen())

  mainHandle('win:startDrag', () => context.startWindowDrag())

  mainHandle('win:moveWindow', ({ x, y }) => {
    // 坏坐标直接丢：`Math.round(NaN)` 还是 NaN，setPosition 会抛，
    // 而渲染层拿到的会是 rejected promise（类型上承诺的是 void）
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      console.warn('[win] moveWindow 收到非法坐标，已忽略:', x, y)
      return
    }
    context.moveWindow(x, y)
  })

  mainHandle('win:getScreenWorkArea', () => context.getScreenWorkArea())
}
