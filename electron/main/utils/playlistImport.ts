/**
 * 「拖入一个音乐歌单链接」→ 导入（已有则同步）→ 交给渲染层去播
 *
 * ## 为什么要单独一个文件
 *
 * 它同时依赖两边：
 *  - `music/index.ts` 的 `resolvePlaylist`（解析，要联网）；
 *  - `utils/playlist.ts` 的 `getPlaylists` / `savePlaylists`（存储）。
 *
 * 而 `utils/playlist.ts` 自己已经在用音乐那边的同步逻辑（`syncPlaylist`），
 * 把这段塞进任何一边都会变成一个**循环依赖**，所以放在中间这层。
 *
 * ## 「已有就同步」怎么判
 *
 * 两条线索取其一：
 *  1. 主键相同 —— 主键是 `平台_平台歌单id`，同一个歌单从任何链接进来都算出同一个；
 *  2. 原始链接相同 —— 用户拖的链接原样和库里的 `sourceUrl` 一样。
 *
 * 命中哪条都只**刷新曲目**：名字（用户可能改过）、同步设置、播放位置全部保留。
 * 这一点很关键 —— 拖一下就把自己重命名的歌单改回平台名，会让人以为出了 bug。
 */
import { randomUUID } from 'node:crypto'
import type { PlaylistRecord } from '@common/types/playlist'
import { playlistKey } from '@common/types/playlist'
import { resolvePlaylist, resolveSong } from '../music'
import { appendSongToDefaultPlaylist, getPlaylists, savePlaylists, toPlaylistSongs } from './playlist'

export const importMusicPlaylist = async (
  url: string,
): Promise<{ record: PlaylistRecord; existed: boolean }> => {
  const input = (url ?? '').trim()
  if (!input) throw new Error('歌单链接不能为空')

  /** 解析失败会抛（提示语已经写好，比如「网易云 / QQ音乐 / 酷我」的支持范围） */
  const detail = await resolvePlaylist({ input })
  const songs = toPlaylistSongs(detail.songs)
  if (songs.length === 0) throw new Error('这个歌单没有解析到任何歌曲')

  const now = Date.now()
  const id = playlistKey(detail.source, detail.listId) ?? `pl_${randomUUID()}`
  const data = getPlaylists()
  const existing = data.playlists.find(
    (item) => item.id === id || (!!item.sourceUrl && item.sourceUrl.trim() === input),
  )

  /**
   * 已有 → 只换曲目与来源信息
   *
   * `sync`（自动同步策略）、`name`、`lastIndex` 都不动：
   * 用户拖入的意图是「我要看这个歌单」，不是「把歌单恢复出厂设置」。
   */
  if (existing) {
    const updated: PlaylistRecord = {
      ...existing,
      songs,
      source: detail.source,
      sourceUrl: input,
      lastSyncAt: now,
      updatedAt: now,
    }
    const saved = savePlaylists({
      playlists: data.playlists.map((item) => (item.id === existing.id ? updated : item)),
      currentId: existing.id,
    })
    const record = saved.playlists.find((item) => item.id === existing.id) ?? updated
    console.log(`[playlist] 已同步《${record.name}》${songs.length} 首（拖入）`)
    return { record, existed: true }
  }

  const record: PlaylistRecord = {
    id,
    /** 平台没给名字时兜一句，界面上总得有个东西点 */
    name: (detail.info.name ?? '').trim() || '导入的歌单',
    source: detail.source,
    sourceUrl: input,
    songs,
    /** 拖入进来的歌单默认**不自动同步**（和弹窗里新建的默认值一致） */
    sync: { mode: 'off', intervalMs: 0 },
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    lastIndex: 0,
  }
  const saved = savePlaylists({
    playlists: [...data.playlists, record],
    currentId: id,
  })
  const created = saved.playlists.find((item) => item.id === id) ?? record
  console.log(`[playlist] 已导入《${created.name}》${songs.length} 首（拖入）`)
  return { record: created, existed: false }
}

/**
 * 「拖入一首单曲」→ 追加进默认歌单 → 交给渲染层去播
 *
 * 和 `importMusicPlaylist` 的区别是**落点**：那边是「导入一个歌单」，
 * 这边是「往默认歌单里塞一首」。之所以不新建歌单，是因为拖一首歌进来
 * 的意图是「我想听这首」，不是「帮我建个歌单」—— 上次这么干的人
 * 会在歌单列表里攒出十几个只有一首歌的歌单。
 *
 * 默认歌单由 `appendSongToDefaultPlaylist` 保证存在（没有就现建、且删不掉），
 * 去重也在那边做（按 `songs.id` + `歌名-歌手` 两层，见那里的注释）。
 *
 * 返回的 `index` 就是要播的位置：主进程已经把默认歌单的 `lastIndex` 改成它，
 * 渲染层拿 `record.id` 调 `onPlaylistSwitch` 就会从这一首起播。
 */
export const importSongToDefault = async (
  url: string,
): Promise<{ record: PlaylistRecord; index: number; added: boolean; songName: string }> => {
  const input = (url ?? '').trim()
  if (!input) throw new Error('歌曲链接不能为空')

  const { song } = await resolveSong(input)
  const [parsed] = toPlaylistSongs([song])
  if (!parsed) throw new Error('这首歌的信息不完整（缺歌名），无法加入歌单')

  const result = appendSongToDefaultPlaylist(parsed)
  console.log(
    `[playlist] ${result.added ? '已加入' : '已存在'}《${parsed.name}》→ 默认歌单（第 ${result.index + 1} 首）`,
  )
  return { ...result, songName: parsed.name }
}
