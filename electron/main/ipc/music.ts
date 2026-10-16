/**
 * 音乐歌单解析 IPC
 *
 * ## ★ 解析结果在这里就**加工成最终形态**（不让渲染层碰字段细节）
 *
 * `resolvePlaylist` 给的是 `ParsedSong`，字段名/单位跟库里**不一样**：
 *
 * | 音源给的 | 库里要的 |
 * | --- | --- |
 * | `interval: "4:03"` | `duration: 243`（秒） |
 * | `albumName` | `album` |
 * | `platformId` | `platformId`（拼 `songs.id` 要用） |
 *
 * 转换本来写在渲染层（`PlaylistManager.vue`），后果是
 * **`platformId` 被丢掉了**（渲染层不知道它有用）→ `songs.id` 退化成
 * `歌名-歌手`，白拆了 `songs` / `playlist_songs` 两张表。
 *
 * 现在改成：**主进程转完再返回**，渲染层只负责展示与把结果原样传回。
 * 好处是渲染层不需要知道 `interval` 是什么形状、也不需要认识 `platformId`。
 */
import { mainHandle } from '@common/mainIpc'
import { resolvePlaylist } from '../music'
import { toPlaylistSongs } from '../utils/playlist'
import { playlistKey } from '@common/types/playlist'

export const registerMusicHandlers = (): void => {
  mainHandle('music:getPlaylistDetail', async (params) => {
    const detail = await resolvePlaylist(params)
    /**
     * ★ 歌单主键**在这里拼好**（`平台_平台歌单id`，如 `tx_8153225605`）
     *
     * 渲染层拿到的 `id` 是**成品**，直接当主键用即可 ——
     * 它不需要知道 `listId` 存在，也不需要知道拼装规则。
     *
     * 兜底：音源没给出 `listId` 时返回 `null`，
     * 由渲染层退化成随机 id（`pl_xxx`，手动新建的歌单走那条路）。
     */
    const id = playlistKey(detail.source, detail.listId)

    /**
     * 返回给渲染层的 `songs` 是 **`PlaylistSong[]`**（与库里同一形态），
     * 不再是音源的 `ParsedSong[]` —— 这个形态在
     * `IpcChannelMap['music:getPlaylistDetail']['result']` 里写明了。
     *
     * `listId` **不再透出**：它只用于上面拼 `id`，渲染层不需要它。
     */
    return {
      info: detail.info,
      songs: toPlaylistSongs(detail.songs),
      total: detail.total,
      page: detail.page,
      limit: detail.limit,
      source: detail.source,
      id,
    }
  })
}
