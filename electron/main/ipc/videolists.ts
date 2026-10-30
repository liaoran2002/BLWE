/**
 * B 站视频列表 IPC
 *
 * 通道分成两组，命名沿用现有风格：
 *  - `api:*`      —— 打 B 站接口的（识别链接、收藏夹、订阅合集）；
 *  - `videolists:*` —— 操作本地库的（列表 CRUD、同步、进度）。
 *
 * 为什么 `videolists:getItems` 不联网：条目在导入时就落库了，
 * 切列表 / 续播都不该再打请求 —— 否则每次开程序都是一串接口，既慢又招风控。
 */
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { mainHandle } from '@common/mainIpc'
import { parseListInput, fetchMyFavFolders, fetchMySubscribedLists } from '../biliApi'
import { classifyDropInput } from '../utils/dropInput'
import {
  VIDEO_FILE_FILTERS,
  localMediaUrl,
  localVideoExists,
  markLocalItemsMissing,
  relocateLocalVideo,
} from '../utils/localVideo'
import {
  addItemToDefaultList,
  addLocalFilesToDefault,
  addLocalItem,
  addVideoList,
  createLocalList,
  getVideoListItems,
  getVideoLists,
  removeVideoList,
  removeVideoListItem,
  renameVideoList,
  setItemFavorite,
  setVideoListIndex,
  syncVideoList,
} from '../utils/videolist'

export const registerVideoListHandlers = (): void => {
  mainHandle('api:parseListInput', ({ text }) => parseListInput(text))

  /** 拖入识别：不联网、不写库，只回答「这是什么」 */
  mainHandle('api:classifyDrop', ({ text }) => classifyDropInput(text))

  mainHandle('api:myFavFolders', () => fetchMyFavFolders())

  mainHandle('api:mySubLists', () => fetchMySubscribedLists())

  mainHandle('videolists:list', () => getVideoLists())

  mainHandle('videolists:add', ({ kind, sourceId, mid }) => {
    /**
     * 本地列表没有远端来源，导入接口对它没有意义
     *
     * 这里明确拦下来（而不是让类型断言糊过去）：界面上的导入入口只在
     * 「新建列表」（粘贴链接 / 收藏夹 / 订阅合集）里出现 —— 选了「空列表」那条
     * 走的是 `videolists:createLocal`，根本不会到这里。走到这里说明是调用方的 bug。
     */
    if (kind === 'local') {
      throw new Error('本地列表不支持从 B 站导入，请用「添加视频」逐条添加')
    }
    return addVideoList(kind, sourceId, mid)
  })

  mainHandle('videolists:remove', ({ id }) => removeVideoList(id))

  mainHandle('videolists:createLocal', ({ name }) => createLocalList(name))

  mainHandle('videolists:rename', ({ id, name }) => renameVideoList(id, name))

  mainHandle('videolists:addItem', ({ id, input }) => addLocalItem(id, input))

  /**
   * 拖入本地视频文件
   *
   * 主进程只做「登记 + 挂列表」，**不解析、不探测**：能不能播由渲染层的
   * `<video>` 探针实测（用的就是待会儿真播放的那个解码器，比任何扩展名白名单准）。
   * 所以这里返回的条目带着 `url`，渲染层拿它探一下就知道了。
   */
  mainHandle('videolists:importLocal', ({ paths }) => {
    const result = addLocalFilesToDefault(Array.isArray(paths) ? paths : [])
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, url: localMediaUrl(item.bvid) })),
    }
  })

  /** 拖入单条视频：放进默认列表（没有就现建），返回 listId 让渲染层去播 */
  mainHandle('videolists:addItemToDefault', ({ input }) => addItemToDefaultList(input))

  mainHandle('videolists:removeItem', ({ id, bvid }) => removeVideoListItem(id, bvid))

  mainHandle('videolists:setFavorite', ({ id, bvid, favorite }) =>
    setItemFavorite(id, bvid, favorite),
  )

  mainHandle('videolists:sync', ({ id }) => syncVideoList(id))

  /**
   * 取列表条目
   *
   * 顺带把**本地文件**条目摸一遍盘（`missing` 标记）：打开视频管理那一刻
   * 就要能看见哪几条文件已经不在了，而不是等播到它才失败。
   *
   * 为什么放在 IPC 这层而不是 `getVideoListItems()` 里：那个函数是同步的，
   * 内部还有同步流程在用；`stat` 一个掉线的网络盘能阻塞好几秒，
   * 同步版会直接把主进程冻住。这里异步并发跑，既不挡事件循环也不改函数签名。
   */
  mainHandle('videolists:getItems', async ({ id }) =>
    markLocalItemsMissing(getVideoListItems(id)),
  )

  mainHandle('videolists:setIndex', ({ id, index }) => setVideoListIndex(id, index))

  /**
   * 重新定位：让用户挑一个视频文件，把某条本地视频重新指过去
   *
   * `currentPath` 只用来定对话框的起始目录（文件原来在的那个文件夹）——
   * 从盘符根目录开始点对用户毫无帮助。
   *
   * ⚠️ 这里**不校验选中的是不是「同一个视频」**：判断不了（没有 ffmpeg 算哈希，
   * 大文件算一遍也慢）。选错了是用户自己的事，而且可逆 —— 再点一次重新定位就行。
   */
  mainHandle('local:pickVideo', async ({ currentPath }) => {
    const dir = currentPath ? path.dirname(String(currentPath)) : undefined
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '重新定位本地视频',
          defaultPath: dir && fs.existsSync(dir) ? dir : undefined,
          properties: ['openFile'],
          filters: VIDEO_FILE_FILTERS,
        })
      : await dialog.showOpenDialog({
          title: '重新定位本地视频',
          defaultPath: dir && fs.existsSync(dir) ? dir : undefined,
          properties: ['openFile'],
          filters: VIDEO_FILE_FILTERS,
        })
    // 用户取消不是错误：返回空串，调用方静默
    return result.canceled ? '' : (result.filePaths[0] ?? '')
  })

  mainHandle('local:relocate', ({ bvid, newPath }) => relocateLocalVideo(bvid, newPath))

  mainHandle('local:exists', ({ bvid }) => localVideoExists(bvid))
}
