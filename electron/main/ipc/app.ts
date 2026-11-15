/**
 * 应用级杂项 IPC
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { mainHandle } from '@common/mainIpc'
import { getDataDirInfo, setDataDir } from '../portable'

/**
 * 只放行 http / https
 *
 * 这个通道的入参来自渲染进程，等于半个「执行外部命令」的口子，
 * 所以绝不能让 `file:` / `javascript:` / 自定义协议过去。
 */
const isSafeUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export const registerAppHandlers = (): void => {
  mainHandle('app:openExternal', async ({ url }) => {
    if (typeof url !== 'string' || !isSafeUrl(url)) {
      console.warn('[app] 拒绝打开不安全的链接:', url)
      return false
    }
    await shell.openExternal(url)
    return true
  })

  // #region 配置文件位置
  mainHandle('app:getDataDir', () => getDataDirInfo())

  mainHandle('app:setDataDir', ({ mode, customPath }) => setDataDir(mode, customPath))

  /**
   * 选文件夹
   *
   * 挂到当前聚焦窗口上：不挂的话对话框是独立窗口，用户切到别的窗口后
   * 它可能跑到后面去（Windows 上「点了没反应」的经典来源）。
   * `createDirectory` 让用户能当场新建一个文件夹，省得先去资源管理器建。
   */
  mainHandle('app:pickDataDir', async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择配置文件位置',
      buttonLabel: '用这个文件夹',
      properties: ['openDirectory', 'createDirectory'],
    }
    const win = BrowserWindow.getFocusedWindow()
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  /**
   * 重启
   *
   * `relaunch` 只是「登记下次启动」，当前进程还得自己退出；
   * 稍微延后一点再 quit，让这条 IPC 的返回值先送到渲染进程（否则那边会收到
   * 「渲染进程已销毁」而不是正常 resolve）。
   */
  mainHandle('app:relaunch', () => {
    app.relaunch()
    setTimeout(() => app.quit(), 120)
  })
  // #endregion
}
