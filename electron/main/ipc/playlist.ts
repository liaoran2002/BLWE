/**
 * 歌单 IPC
 *
 * 只保留新版 `playlists:*`（多歌单集合 + 同步）。
 * 旧的单歌单接口 `playlist:get` / `playlist:save` 全项目没有任何调用方，已经删掉。
 *
 * 存储已经是 SQLite（`utils/playlist.ts` + `utils/db.ts`），
 * 旧的 `playlist.json` / `playlists.json` **不再读也不再迁移**（用户明确要求）。
 */
import { mainHandle } from '@common/mainIpc'
import {
  convertPlaylistToLocal,
  getPlaylists,
  savePlaylists,
  syncPlaylists,
} from '../utils/playlist'

export const registerPlaylistHandlers = (): void => {
  mainHandle('playlists:get', () => getPlaylists())

  mainHandle('playlists:save', (params) => savePlaylists(params))

  mainHandle('playlists:sync', ({ ids }) => syncPlaylists(ids))

  mainHandle('playlists:convertToLocal', ({ id }) => convertPlaylistToLocal(id))
}
