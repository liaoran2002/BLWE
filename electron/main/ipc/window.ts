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

  // 注意：不能用 win.isFullScreen()。主窗口是 transparent，Windows 上
  // 透明窗口的原生全屏是失效的，全屏状态由主进程自己维护。
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
