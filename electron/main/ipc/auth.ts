/**
 * 登录相关 IPC
 *
 * 曾经有个 `auth:reLogin`（清 cookie 再开登录窗），但渲染层从来没有调用方，
 * 已删掉；「重新登录」现在走 `auth:executeLogout` + `auth:startLogin` 两条现成的路。
 */
import { mainHandle } from '@common/mainIpc'
import type { IpcContext } from '../ipcHandlers'

export const registerAuthHandlers = (context: IpcContext): void => {
  mainHandle('auth:startLogin', () => {
    context.createLoginWindow()
  })

  mainHandle('auth:setLoggedIn', ({ loggedIn }) => {
    /**
     * 收窄成布尔再往下传
     *
     * 主进程这份 `isLoggedIn` 决定托盘菜单显示「登录」还是「退出登录」，
     * 渲染层一旦传了非布尔值（类型 bug / 误调），两份状态就会漂移。
     */
    context.setLoggedIn(loggedIn === true)
  })

  mainHandle('auth:executeLogout', async () => {
    await context.executeLogout()
  })
}
