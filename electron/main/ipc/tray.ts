/**
 * 托盘 IPC（含自绘菜单）
 */
import { mainHandle } from '@common/mainIpc'
import type { IpcContext } from '../ipcHandlers'

export const registerTrayHandlers = (context: IpcContext): void => {
  mainHandle('tray:updateState', (state) => {
    context.updateTrayState(state)
  })

  // 自绘托盘菜单：状态 / 动作 / 尺寸回报 / 收起
  mainHandle('trayMenu:getState', () => context.getTrayMenuState())
  mainHandle('trayMenu:action', ({ action, value }) => {
    context.runTrayMenuAction(action, value)
  })
  mainHandle('trayMenu:ready', ({ height }) => {
    /**
     * 高度必须校验
     *
     * 渲染层报上来的若是 NaN / Infinity / 负数，`Math.max(60, NaN)` 还是 NaN，
     * 最终交给 `setBounds` 会抛错 —— 那这次菜单就弹不出来了，而且报错点在主进程里，
     * 排查时完全想不到是「页面量了个坏高度」。非法值直接忽略，让 120ms 兜底逻辑接手。
     */
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
      console.warn('[tray] 菜单高度非法，忽略:', height)
      return
    }
    context.sizeTrayMenu(Math.min(2000, Math.round(height)))
  })
  mainHandle('trayMenu:close', () => {
    context.hideTrayMenu()
  })

  // 任务栏播放进度
  mainHandle('window:setProgress', ({ progress, paused }) => {
    // 同样要防坏值：NaN 交给 setProgressBar 行为未定义
    const p = typeof progress === 'number' && Number.isFinite(progress) ? progress : -1
    // 负数在 Electron 里是「不显示进度」（渲染层就是这么表达「没有在播」的），别夹成 0
    context.setProgress(p < 0 ? -1 : Math.min(1, p), paused === true)
  })
}
