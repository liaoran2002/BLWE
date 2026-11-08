/**
 * 检查更新 IPC
 *
 * 主进程只负责「查 + 报」，界面负责「怎么显示」—— 所以这里没有自动下载、
 * 也没有静默安装，`update:check` 就是同步式的「跑一次，回结果」。
 */
import { mainHandle } from '@common/mainIpc'
import { checkForUpdate, dismissUpdate, getUpdateInfo } from '../updater'

export const registerUpdateHandlers = (): void => {
  mainHandle('update:check', () => checkForUpdate())
  mainHandle('update:info', () => getUpdateInfo())
  mainHandle('update:dismiss', ({ sha256 }) => {
    dismissUpdate(sha256)
  })
}
