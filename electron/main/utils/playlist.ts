/**
 * 歌单集合服务（主进程）
 *
 * 存储从 `playlists.json`（`getStore` + 防抖整包落盘）换成 SQLite 的
 * `playlists` + `playlist_songs` 两张表，**对外 API 一个都没变** ——
 * `initPlaylists` / `flushPlaylists` / `getPlaylists` / `savePlaylists` / `syncPlaylist(s)`
 * 还是原来那几个，IPC handler 和渲染层因此不用跟着改。
 *
 * 为什么内存里仍然常驻一整份 `data`：
 * 同步（`syncPlaylist`）要跑好几秒网络请求，期间渲染层会发若干次 `playlists:save`。
 * 如果每次读写都直接打数据库，`syncingIds` 那套「正在同步的歌单以主进程内存为准」
 * 的保护就无从谈起 —— 它保护的正是内存里这份快照。所以结构保持「内存权威 + 落库」。
 *
 * 本次改造删掉了两样东西（都是被新数据层取代的，不是遗漏）：
 *  1. `migrateLegacy()`：旧版单歌单文件 `playlist.json` 的迁移。用户明确要求
 *     **不写任何旧数据迁移代码**，旧文件留在原地不管。
 *  2. `favorites` / `videoCache` 的读写。这两个概念已经移到 `videos` 表
 *     （见 `utils/cache.ts`）：收藏＝`videos.favorites` + `videos.ord`，
 *     每首歌选中的视频＝`song_meta.selected_bvid`。
 *     歌单表再存一份只会产生「两处都改了但只同步了一处」的漂移。
 */
import { randomUUID } from 'node:crypto'
import { PLAYLIST_DATA_VERSION } from '@common/constants'
import type {
  PlaylistRecord,
  PlaylistSaveParams,
  PlaylistSong,
  PlaylistStoreData,
  PlaylistSyncMode,
  SyncResult,
} from '@common/types/playlist'
import {
  isLocalPlaylistId,
  parseCacheKey,
  platformIdOfSongId,
  songId,
  sourceOfSongId,
  toCacheKey,
} from '@common/types/playlist'
import { durationToSeconds } from '@common/utils/duration'
import { getDb, tx } from './db'
import { resolvePlaylist } from '../music'

/** 自动同步时最多处理多少首歌（防御异常巨大的歌单） */
const MAX_SYNC_SONGS = 2000

const emptyData = (): PlaylistStoreData => ({
  version: PLAYLIST_DATA_VERSION,
  currentId: null,
  playlists: [],
})

let data: PlaylistStoreData = emptyData()

/**
 * 生成**兜底**歌单 id（`pl_` 前缀）
 *
 * ⚠️ 只在「**没有**拼出平台主键」时用 —— 也就是**手动新建的歌单**
 * （没有分享链接，也就没有平台歌单 id 可拼）。
 *
 * 有链接的歌单，主键是 `平台_平台歌单id`（`tx_8153225605`），
 * 由 `music:getPlaylistDetail` 用 `playlistKey()` 拼好后一路带过来。
 *
 * 前缀 `pl_` 是刻意加的：一眼能看出「这不是平台 id」，
 * 排查时不用猜 `a9648dca-…` 属于哪个平台。
 */
const newId = (): string => `pl_${randomUUID()}`

/**
 * 默认歌单的**固定主键**
 *
 * 视频列表那边靠「设置项记 id + 三级兜底」来认默认列表，因为默认列表
 * 可以是用户已有的任意一个 local 列表。歌单这边不需要那种自由度：
 * 默认歌单是我们自己建的、只有这一个，所以直接钉死主键 ——
 * 判断「是不是默认」就是比一个字符串，不存在「设置项指向一个已经被删掉的 id」的漂移。
 *
 * 前缀仍是 `pl_`，和手动新建的歌单一个系列（`newId()` 生成 `pl_<uuid>`）。
 */
export const DEFAULT_PLAYLIST_ID = 'pl_default'

const DEFAULT_PLAYLIST_NAME = '默认歌单'

/** 空默认歌单（第一次运行 / 用户把别的歌单都删光时用） */
const makeDefaultPlaylist = (): PlaylistRecord => {
  const now = Date.now()
  return {
    id: DEFAULT_PLAYLIST_ID,
    name: DEFAULT_PLAYLIST_NAME,
    songs: [],
    sync: { mode: 'off', intervalMs: 0 },
    lastSyncAt: null,
    createdAt: now,
    updatedAt: now,
    lastIndex: 0,
  }
}

/**
 * 出口处贴 `isDefault` 标记
 *
 * **不落库**：它是从 id 派生出来的，存下来只会多一处可能不一致的地方
 * （比如某天有人改了主键，库里的 true 就变成谎话）。
 * 所以 `getPlaylists` / `savePlaylists` 两个出口各贴一次。
 */
const withDefaultFlag = (list: PlaylistRecord[]): PlaylistRecord[] =>
  list.map((item) => ({ ...item, isDefault: item.id === DEFAULT_PLAYLIST_ID }))

/**
 * 本地歌单的不变量：**没有链接、没有音源、不参与同步**
 *
 * 本地歌单（`pl_` 前缀）的语义是「一堆歌的容器」，链接在它那里只是一个
 * 一次性导入器 —— 导完就该丢掉。如果库里留了 `url` / `sync_mode`，
 * 它就会变成「既算本地、又跟着平台更新」的第三种东西：
 * 下一次同步拿远端曲目**整体替换**，手动加进来的歌静默消失。
 *
 * 所以这条不变量要在**两个出入口**各强制一次：
 *  - 写库前（`normalizeRecord`）：渲染层的全量覆盖带进来什么脏值都清掉；
 *  - 读库后（`toRecord`）：老库 / 手改库里已经存在的脏值也不放出来。
 *
 * 只改副本，不动调用方传进来的对象 —— 调用方有的直接是内存里那份。
 */
const applyLocalInvariant = (record: PlaylistRecord): PlaylistRecord => {
  if (!isLocalPlaylistId(record.id)) return record
  return {
    ...record,
    source: undefined,
    sourceUrl: undefined,
    sync: { mode: 'off', intervalMs: 0 },
    lastSyncAt: null,
  }
}

// #region 数据库行 <-> 领域对象

/**
 * `playlists` 表的原始行（snake_case，和建表语句一一对应）
 *
 * 用不着在 SQL 里 `AS` 出一串 camelCase 别名：转换点集中在这里，
 * 改字段名时只会改到这一个地方，而且一眼能对上建表语句。
 */
interface PlaylistDbRow {
  id: string
  name: string
  url: string | null
  sync_mode: string
  sync_interval_ms: number
  last_sync_at: number | null
  created_at: number
  updated_at: number
  last_index: number
}

/**
 * `songs` 表的原始行（曲目实体，全局唯一）
 *
 * 没有 `source` / `platform_id` 列 —— 它们已经编码在 `id`（`tx_101104624`）里，
 * 需要时用 `sourceOfSongId(id)` 反推。少两列就少两处可能不一致的地方。
 */
interface SongRow {
  id: string
  name: string
  singer: string
  album: string | null
  cover: string | null
  duration: number | null
}

/** `playlist_songs` 的原始行（成员关系 + 顺序） */
interface PlaylistSongRow {
  playlist_id: string
  ord: number
  song_id: string
}

/** `sync_mode` 列 -> `PlaylistSyncMode`（脏值一律当 off，别让界面拿到未定义的行为） */
const toSyncMode = (raw: string | null): PlaylistSyncMode =>
  raw === 'startup' || raw === 'interval' ? raw : 'off'

/**
 * 归一化一首歌
 *
 * 兼容两种输入：
 *  - 旧版 `["歌名-歌手", ...]` 字符串 → 解析成结构化对象（`parseCacheKey`）
 *  - 结构化的 `{name, singer, album, cover, duration}`
 *
 * 空名字直接丢掉：`playlist_songs.name` 是 NOT NULL，塞一个空串进去
 * 只会在界面上留一个点不动的空行，不如不要。
 *
 * `duration` 用 `durationToSeconds` 归一成**秒**：音乐平台给的是 `"4:03"`，
 * 而渲染层有可能回传数字（它从库里读出来就是数字）—— 两种都要能收。
 */
const normalizeSong = (input: unknown): PlaylistSong | null => {
  if (typeof input === 'string') {
    const parsed = parseCacheKey(input)
    return parsed.name ? parsed : null
  }
  if (input && typeof input === 'object') {
    const raw = input as Partial<PlaylistSong>
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) return null
    return {
      name,
      singer: typeof raw.singer === 'string' ? raw.singer : '',
      album: typeof raw.album === 'string' && raw.album ? raw.album : undefined,
      cover: typeof raw.cover === 'string' && raw.cover ? raw.cover : null,
      duration: durationToSeconds(raw.duration),
      /** 平台 id / 音源：取歌词用，可能没有（手动添加的歌就没有） */
      platformId:
        typeof raw.platformId === 'string' && raw.platformId ? raw.platformId : null,
      source: typeof raw.source === 'string' && raw.source ? raw.source : undefined,
    }
  }
  return null
}

/** 归一化歌曲数组（丢掉不合法项） */
const normalizeSongs = (input: unknown): PlaylistSong[] => {
  if (!Array.isArray(input)) return []
  const out: PlaylistSong[] = []
  for (const item of input) {
    const song = normalizeSong(item)
    if (song) out.push(song)
  }
  return out
}

/**
 * 归一化一条歌单记录，补齐缺省字段
 *
 * `songs` 不是数组时返回 null（整条丢弃）：
 * 曲目列表是一条歌单的全部内容，形状不对说明这条记录本身已经坏了，
 * 硬塞一个空数组进去会在界面上显示成一个「空歌单」，用户会以为歌丢了。
 */
const normalizeRecord = (input: Partial<PlaylistRecord>): PlaylistRecord | null => {
  if (!input || typeof input !== 'object') return null
  if (!Array.isArray(input.songs)) return null
  const now = Date.now()
  const record: PlaylistRecord = {
    id: typeof input.id === 'string' && input.id ? input.id : newId(),
    name: typeof input.name === 'string' && input.name ? input.name : '未命名歌单',
    source: typeof input.source === 'string' ? input.source : undefined,
    sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl : undefined,
    songs: normalizeSongs(input.songs),
    sync: {
      mode:
        input.sync?.mode === 'startup' || input.sync?.mode === 'interval'
          ? input.sync.mode
          : 'off',
      intervalMs:
        typeof input.sync?.intervalMs === 'number' && input.sync.intervalMs > 0
          ? input.sync.intervalMs
          : 0,
    },
    lastSyncAt: typeof input.lastSyncAt === 'number' ? input.lastSyncAt : null,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
    lastIndex:
      typeof input.lastIndex === 'number' && input.lastIndex >= 0 ? input.lastIndex : 0,
  }
  /** 本地歌单的链接 / 同步一律清掉（见 `applyLocalInvariant`） */
  return applyLocalInvariant(record)
}

// #endregion

// #region 解析结果 → 领域对象

/**
 * ★ 把音源解析出的 `ParsedSong[]` 转成 `PlaylistSong[]`（**主进程唯一入口**）
 *
 * ## 为什么这件事必须在主进程做
 *
 * `resolvePlaylist` 拿到的 `ParsedSong` 里字段名与库里**不一样**：
 *
 * | 音源给的 | 库里要的 |
 * | --- | --- |
 * | `interval: "4:03"` | `duration: 243`（**秒**） |
 * | `albumName` | `album` |
 * | `platformId` | `platformId`（**拼 `songs.id` 要用**） |
 *
 * 早先这段转换写在**渲染层**（`PlaylistManager.vue`），于是：
 *  - 渲染层要懂「interval 是什么形状」这种音源细节；
 *  - **`platformId` 在转换时被丢掉**了（渲染层根本不知道它有用），
 *    导致 `songs.id` 只能退化成 `歌名-歌手` —— 白拆了表。
 *
 * 现在统一在这里转完，**主进程的 IPC 出口直接返回最终形态**，
 * 渲染层原样透传即可（它只负责展示与回传）。
 *
 * @param songs 音源解析出的原始歌曲
 */
export const toPlaylistSongs = (
  songs: Array<{
    name: string
    singer: string
    interval?: string | null
    albumName?: string
    cover?: string | null
    platformId?: string | null
    source?: string
  }>,
): PlaylistSong[] =>
  (songs ?? []).map((song) => ({
    name: song.name,
    singer: song.singer ?? '',
    album: song.albumName,
    cover: song.cover ?? null,
    /** 音源给的是 `"4:03"` 这类字符串，库里统一存**秒** */
    duration: durationToSeconds(song.interval),
    /** ★ 平台 id —— 拼 `songs.id` 的关键，**不能丢** */
    platformId: song.platformId ?? null,
    source: song.source,
  }))

// #endregion

// #region 读

/** 读全部歌单（含曲目），按 created_at 排序 —— 界面上的顺序必须稳定 */
const readPlaylistsFromDb = (): PlaylistRecord[] => {
  const db = getDb()
  const playlistRows = db
    .prepare(
      `SELECT id, name, url, sync_mode, sync_interval_ms,
              last_sync_at, created_at, updated_at, last_index
         FROM playlists
        ORDER BY created_at ASC`,
    )
    .all() as PlaylistDbRow[]
  if (playlistRows.length === 0) return []

  /**
   * 曲目信息一次全查出来，建成 `id -> PlaylistSong` 的字典
   *
   * 曲目实体在 `songs` 表（全局唯一），`playlist_songs` 只存关系 ——
   * 所以这里是**两次全表读 + 内存拼装**，不是每条歌单查一次（N+1）。
   */
  const songById = new Map<string, PlaylistSong>()
  for (const row of db
    .prepare(`SELECT id, name, singer, album, cover, duration FROM songs`)
    .all() as SongRow[]) {
    songById.set(row.id, {
      name: row.name,
      singer: row.singer ?? '',
      album: row.album ?? undefined,
      cover: row.cover,
      duration: row.duration,
      /**
       * `platformId` / `source` 从 `id`（`tx_101104624`）反推 ——
       * 表里没这两列，前缀已经表达了它们。
       */
      platformId: platformIdOfSongId(row.id),
      source: sourceOfSongId(row.id) ?? undefined,
    })
  }

  /**
   * 关系表按 `(playlist_id, ord)` 读出来，直接就是各歌单的顺序
   *
   * 排序在 SQL 里做（`ORDER BY playlist_id, ord`），所以在 JS 里
   * `push` 的顺序天然正确，不需要再排一次。
   */
  const songsByPlaylist = new Map<string, PlaylistSong[]>()
  for (const row of db
    .prepare(
      `SELECT playlist_id, ord, song_id FROM playlist_songs ORDER BY playlist_id ASC, ord ASC`,
    )
    .all() as PlaylistSongRow[]) {
    const song = songById.get(row.song_id)
    /**
     * `songs` 里找不到 = 悬空引用（关系表有、实体表没有）。
     *
     * 正常情况下不会发生（写库在同一个事务里），但真要出现时
     * **跳过它而不是补一条空的** —— 补空壳会在界面上留一个点不动的空行。
     */
    if (!song) {
      console.warn(`[playlist] 曲目 ${row.song_id} 在 songs 表里不存在，已跳过`)
      continue
    }
    let list = songsByPlaylist.get(row.playlist_id)
    if (!list) {
      list = []
      songsByPlaylist.set(row.playlist_id, list)
    }
    list.push(song)
  }

  return playlistRows.map((row) =>
    /** 本地歌单的 url / sync 列可能是历史脏值，读出来也要清（见 `applyLocalInvariant`） */
    applyLocalInvariant({
      id: row.id,
      name: row.name,
      /** 音源从歌单 id 前缀反推（`tx_8153225605` → `tx`） */
      source: sourceOfSongId(row.id) ?? undefined,
      sourceUrl: row.url ?? undefined,
      songs: songsByPlaylist.get(row.id) ?? [],
      sync: { mode: toSyncMode(row.sync_mode), intervalMs: row.sync_interval_ms ?? 0 },
      lastSyncAt: row.last_sync_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastIndex: row.last_index ?? 0,
    }),
  )
}

/**
 * 「哪个歌单是当前」**不落库**
 *
 * 它每切一次歌单就变一次，而且真正的来源是渲染层（`playlists:save` 带的
 * `currentId`）。落库只会制造「渲染层说 null、库里还留着上次的 id」
 * 这种两边打架的状态。真值就放在内存里的 `data.currentId`，
 * 启动时先取列表第一条（与旧的 `initPlaylists` 行为一致），
 * 渲染层加载完会立刻写回真实值。
 */

// #endregion

// #region 写

/**
 * 整体覆盖写库（先删后插，一个事务里做完）
 *
 * 为什么是「先删后插」而不是逐条 upsert：
 * 渲染层发来的是**全量快照**，被删掉的歌单/曲目必须真的消失。
 * upsert 做不到这一点（它无法表达「这一条没了」），还得额外算差集。
 * 一次事务里清空再写回，语义最简单，也不可能留下半份数据。
 *
 * **注意 song_meta / videos 不跟着删**：那两张表按「缓存键」记收藏与播放地址，
 * 删歌单不该顺手把用户收藏的视频全清了（重新加回同一个歌单，收藏还在）。
 */
const writePlaylistsToDb = (store: PlaylistStoreData): void => {
  const db = getDb()
  tx(() => {
    db.prepare(`DELETE FROM playlists`).run()
    db.prepare(`DELETE FROM playlist_songs`).run()

    /**
     * ⚠️ `songs` 表**不能无脑全清**
     *
     * 它是**全局共享**的曲目实体表，而这里保存的是「歌单集合」——
     * 无脑 `DELETE FROM songs` 会把别的歌单引用的曲目一起删掉
     * （关系表虽然有记录，但实体没了 → 读的时候全是悬空引用 → 曲目整片消失）。
     *
     * 正确做法见下面：先建**本次用到的 id 集合**，只删「没人再引用」的那些。
     * 这样既不会留垃圾（歌单删了曲目也删），也不会误删别的歌单在用的。
     */
    const insertPlaylist = db.prepare(
      `INSERT INTO playlists
         (id, name, url, sync_mode, sync_interval_ms,
          last_sync_at, created_at, updated_at, last_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    /**
     * 曲目实体用 upsert：同一个 id 可能被多个歌单引用，
     * 第二次遇到时**覆盖**（以最新那份为准 —— 同步刚拉回来的元数据更可信）。
     */
    const upsertSong = db.prepare(
      `INSERT INTO songs (id, name, singer, album, cover, duration)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name     = excluded.name,
         singer   = excluded.singer,
         album    = excluded.album,
         cover    = excluded.cover,
         duration = excluded.duration`,
    )
    const insertRelation = db.prepare(
      `INSERT INTO playlist_songs (playlist_id, ord, song_id) VALUES (?, ?, ?)`,
    )

    /** 本次保存里出现过的 song id（用来决定 `songs` 表要删哪些） */
    const keepIds = new Set<string>()

    for (const record of store.playlists) {
      insertPlaylist.run(
        record.id,
        record.name,
        record.sourceUrl ?? null,
        record.sync.mode,
        record.sync.intervalMs,
        record.lastSyncAt,
        record.createdAt,
        record.updatedAt,
        record.lastIndex,
      )
      record.songs.forEach((song, index) => {
        /**
         * `songs.id` = `平台_平台id`（由 `songId` 拼）
         *
         * ⚠️ 它依赖 `song.platformId`，而那个字段由 `resolvePlaylist` 带出来 ——
         * 所以主进程在 IPC 出口**就把解析结果加工成最终形态**（含 platformId），
         * 渲染层只是原样透传。见 `music:getPlaylistDetail` 的 handler。
         */
        const id = songId(song)
        /**
         * 自检：有平台 id 却没拼出 `平台_` 前缀 → 说明 `song.source` 丢了
         *
         * 这是「渲染层原样透传」这条链路唯一的**隐含耦合**：
         * `songId()` 需要 `platformId` **和** `source` 两个字段，
         * 任一丢失都会静默退化成 `歌名-歌手`（曾经 221 条全退化过，
         * 而界面上完全看不出异常）。所以这里打一行警告，让问题**当场可见**。
         */
        if (song.platformId && !/^[a-z]+_/.test(id)) {
          console.warn(
            `[playlist] 曲目「${song.name}」有 platformId 却拼不出平台前缀` +
              `（source 丢了？）→ songs.id 退化成 ${id}`,
          )
        }
        keepIds.add(id)
        upsertSong.run(
          id,
          song.name,
          song.singer ?? '',
          song.album ?? null,
          song.cover ?? null,
          song.duration ?? null,
        )
        insertRelation.run(record.id, index, id)
      })
    }

    /**
     * 清掉**没人再引用**的曲目实体
     *
     * 用 `NOT IN (...)` 而不是遍历比对：`keepIds` 可能上千个，
     * 逐个 `DELETE` 就是上千次语句执行。这里只有一条语句。
     *
     * `keepIds` 为空时（歌单全删了）`NOT IN ()` 是语法错误 ——
     * 那种情况直接全清，所以单独分支。
     */
    if (keepIds.size === 0) {
      db.prepare(`DELETE FROM songs`).run()
    } else {
      const placeholders = [...keepIds].map(() => '?').join(',')
      db.prepare(`DELETE FROM songs WHERE id NOT IN (${placeholders})`).run(...keepIds)
    }
  })
}

/**
 * 立即落盘
 *
 * 保留了 `flushPlaylists` 这个导出，是因为 `index.ts` 在 `before-quit` /
 * `process.on('exit')` 里调用它。SQLite 的写入是同步的（每次 `savePlaylists`
 * 都已经落库了），所以这里**没有待写队列需要 flush** —— 它现在只是
 * 「把内存里这份立刻再写一遍」的兜底，防止将来有人在别处改了 `data`
 * 却没调用保存。**删掉它没有意义**（调用方要改），留成幂等的兜底最省事。
 */
export const flushPlaylists = (): void => {
  try {
    writePlaylistsToDb(data)
  } catch (err) {
    console.error('[playlist] 退出前落盘失败（忽略）：', err)
  }
}

// #endregion

/** 初始化（app.whenReady 之后调用） */
export const initPlaylists = (): void => {
  const loaded = readPlaylistsFromDb()

  /**
   * 逐条再过一遍 `normalizeRecord`，并**记下丢了几条**
   *
   * 从库里读出来的行已经被 `readPlaylistsFromDb` 转成了合法形状，
   * 所以这里正常应该一条都不丢 —— 它是一道**防御性校验**，不是常规路径。
   * 保留它的意义在于「万一丢了要说出来」：以前是 map + filter 一把过，
   * 丢了多少条、哪一条完全没有痕迹，一个结构 bug 就能把整份歌单集合静默抹掉，
   * 事后只能靠用户说「我的歌单没了」。
   */
  let dropped = 0
  const records: PlaylistRecord[] = []
  for (const item of loaded) {
    const record = normalizeRecord(item)
    if (record) records.push(record)
    else dropped += 1
  }
  if (dropped > 0) {
    console.warn(`[playlist] 有 ${dropped} 条歌单记录结构不合法已丢弃（库里的原始行未改动）`)
  }

  data = { version: PLAYLIST_DATA_VERSION, currentId: records[0]?.id ?? null, playlists: records }
  /**
   * 只有真丢了东西才回写
   *
   * 正常路径下**不写库**：启动时读一遍就写一遍会让「每次开程序都产生一次写事务」，
   * 而 WAL 增长、以及「用户没做任何操作却有磁盘写入」都是没必要的。
   */
  if (dropped > 0) writePlaylistsToDb(data)
  /**
   * 打**歌单名**而不是歌单 id
   *
   * `currentId` 是 `平台_平台歌单id`（`tx_8153225605` 这种），看日志时
   * 还得回头去歌单管理里对一遍才知道是哪个歌单；直接打名字一眼就明白。
   * 找不到对应记录（id 有值但记录不在）才退回显示 id，那本身也是要排查的异常。
   */
  const current =
    data.playlists.find((p) => p.id === data.currentId)?.name ?? (data.currentId || '无')
  console.log(`[playlist] 已加载 ${records.length} 个歌单，当前=${current}`)

  /**
   * 最后一步：保证默认歌单在
   *
   * 放在日志之后，是因为它可能**写库**（空库时新建一条）——
   * 让「加载了几个」这句反映的是**库里真实有的**，而不是加上刚建的那个。
   */
  ensureDefaultPlaylist()
}

/** 取完整集合（深拷贝，避免调用方改到内存里那份；出口处贴上 `isDefault`） */
export const getPlaylists = (): PlaylistStoreData => {
  const copy = structuredClone(data)
  copy.playlists = withDefaultFlag(copy.playlists)
  return copy
}

/**
 * 保证默认歌单存在（没有就现建）
 *
 * 和视频列表的 `ensureDefaultVideoList()` 目的相同，但实现简单得多：
 * 主键是固定的，所以只看「内存里有没有这一条」——
 * 不需要三级兜底（设置项 → 已有列表 → 新建），也不需要在出口处比对设置项。
 *
 * 调用点只有 `initPlaylists()`：程序的任何时刻 `data.playlists` 里都该有它，
 * 后面 `savePlaylists` 还会再兜一道（防止渲染层把整份集合覆盖掉）。
 */
export const ensureDefaultPlaylist = (): PlaylistRecord => {
  const existing = data.playlists.find((item) => item.id === DEFAULT_PLAYLIST_ID)
  if (existing) return existing

  const created = makeDefaultPlaylist()
  /**
   * 插到**最前面**：空库时它就是唯一一个；老库（已有歌单但没有默认歌单）时
   * 它排在首位，用户一眼能看到「拖单曲会进这里」。
   */
  data.playlists = [created, ...data.playlists]
  if (!data.currentId) data.currentId = created.id
  writePlaylistsToDb(data)
  console.log('[playlist] 已创建默认歌单')
  return created
}

/**
 * 追加一首歌到默认歌单（拖入单曲的落点）
 *
 * 默认歌单是**本地歌单**（`pl_default`）：没有链接、不参与同步，
 * 所以往它里面加歌不需要考虑「下次同步会被冲掉」——
 * 那正是本地歌单存在的意义。
 *
 * ## 去重是**两层**的，不能只比 id
 *
 * `songId()` 优先用 `音源_平台id`，没有平台 id 时退化成 `歌名-歌手`。
 * 所以同一首歌可能有**两种 id**：
 *
 * | 怎么进来的 | `songs.id` |
 * | :--- | :--- |
 * | 从平台拖单曲 | `wy_347230` |
 * | 歌单管理里手动填 `海阔天空-Beyond` | `海阔天空-Beyond` |
 *
 * 只比 id 的话，同一首歌会被插成两行。所以先按 id 精确命中，
 * 再按缓存键（`歌名-歌手`）兜一层 —— 命中了就定位过去、不重复插。
 *
 * @returns 命中的下标，以及是不是新加进去的
 */
export const appendSongToDefaultPlaylist = (
  song: PlaylistSong,
): { record: PlaylistRecord; index: number; added: boolean } => {
  const def = ensureDefaultPlaylist()
  const id = songId(song)
  const key = toCacheKey(song).toLowerCase()

  const existingIndex = def.songs.findIndex(
    (item) => songId(item) === id || toCacheKey(item).toLowerCase() === key,
  )
  if (existingIndex >= 0) {
    /** 已经在了：只把播放位置挪到它，不重复插 */
    def.lastIndex = existingIndex
    def.updatedAt = Date.now()
    savePlaylists({ playlists: data.playlists, currentId: def.id })
    return { record: getPlaylists().playlists.find((p) => p.id === def.id) ?? def, index: existingIndex, added: false }
  }

  def.songs = [...def.songs, song]
  /** 新歌接在最后，并把播放位置设成它 —— 拖进来就是想听这首 */
  def.lastIndex = def.songs.length - 1
  def.updatedAt = Date.now()
  const saved = savePlaylists({ playlists: data.playlists, currentId: def.id })
  return {
    record: saved.playlists.find((p) => p.id === def.id) ?? def,
    index: def.lastIndex,
    added: true,
  }
}

/**
 * 把一个**平台歌单**转成本地歌单
 *
 * ## 为什么要换 id
 *
 * 「是不是本地歌单」由 id 前缀判定（`pl_`）。如果保留 `tx_8153225605`，
 * 就会造出一个「id 说是 QQ 歌单、实际没有链接也不能同步」的东西 ——
 * 两条互相矛盾的规则指向同一条记录，后面任何一处按 id 判断都会错。
 *
 * 所以换一个全新的 `pl_<uuid>`，旧 id 直接废弃。曲目、顺序、`lastIndex`
 * 全部保留（`playlist_songs` 只是把引用指过去，和改主键在同一个事务里）。
 *
 * ## 为什么不用 `writePlaylistsToDb`
 *
 * 那个函数是**整份覆盖**（先 DELETE 再全插），会把所有歌单和曲目重写一遍。
 * 转换只动一条记录，两条 UPDATE 就够。内存改完之后，后面任何一次
 * `savePlaylists` 都会按新 id 整份写出去，两条路径不冲突。
 *
 * @returns 转换后的记录（新 id）
 */
export const convertPlaylistToLocal = (id: string): PlaylistRecord => {
  const index = data.playlists.findIndex((item) => item.id === id)
  if (index < 0) throw new Error('歌单不存在')
  if (isLocalPlaylistId(id)) throw new Error('这已经是本地歌单了')

  const target = data.playlists[index]

  /**
   * 同步中不许转
   *
   * `syncPlaylist` 是拿着 id 去 `data.playlists` 里找记录、就地改的。
   * 那边正跑着几秒网络请求时这边把 id 换掉，等它回来就会把结果写到一个
   * 已经不存在的 id 上 —— 或者更糟，写进刚转好的本地歌单、把手动加的歌冲掉。
   */
  if (syncingIds.has(id)) throw new Error('该歌单正在同步，请稍后再试')

  const nextId = newId()
  const db = getDb()
  tx(() => {
    /**
     * `playlist_songs` **没有声明外键**（建表语句里只有 PRIMARY KEY），
     * 所以关系行的 `playlist_id` 必须手动指过去 ——
     * `PRAGMA foreign_keys = ON` 对它不起作用，不会级联更新。
     */
    db.prepare(
      `UPDATE playlists
          SET id = ?, url = NULL, sync_mode = 'off', sync_interval_ms = 0, last_sync_at = NULL
        WHERE id = ?`,
    ).run(nextId, id)
    db.prepare(
      `UPDATE playlist_songs SET playlist_id = ? WHERE playlist_id = ?`,
    ).run(nextId, id)
  })

  target.id = nextId
  target.source = undefined
  target.sourceUrl = undefined
  target.sync = { mode: 'off', intervalMs: 0 }
  target.lastSyncAt = null
  target.updatedAt = Date.now()
  /** 正在播的就是它时，当前歌单指向也跟着换，否则高亮和进度都会丢 */
  if (data.currentId === id) data.currentId = nextId

  console.log(`[playlist] 《${target.name}》已转成本地歌单（${id} → ${nextId}）`)
  return structuredClone(target)
}

/**
 * ★ 按**内存歌单**里的一首歌查时长（秒）
 *
 * 用途：搜索 某站 MV 时按「视频时长 vs 歌曲时长 ±90 秒」过滤候选
 * （见 `biliApi.searchSongFiltered`）—— 时长差太多的多半不是同一首歌。
 *
 * 遍历所有歌单里的所有曲目，取第一个匹配的。**遍历内存里的 data**
 * （不是查库）：歌单是主进程内存里的权威副本，而且这里要的是「快」——
 * 每次搜索都要调一次，走 SQLite 反而多一层开销。
 *
 * ## ⚠️ 入参是**缓存键**（`歌名-歌手`），不是 `songs.id`
 *
 * 搜索链路上 `api:searchSong` 拿到的就是 `joinCacheKey(songName, singerName)`
 * 的结果（`新地球-林俊杰` 这种），所以这里必须用 `toCacheKey(song)` 去比。
 *
 * 这两者**完全不同**，踩过一次：
 *
 * | 键 | 谁生成的 | 形态 | 例子 |
 * | :--- | :--- | :--- | :--- |
 * | `songs.id` | `songId()` | `平台_平台id` | `tx_1828354` |
 * | 缓存键 | `toCacheKey()` | `歌名-歌手` | `新地球-林俊杰` |
 *
 * 实测：370 首歌的 `id` **全部**是 `tx_xxx` 形态，没有一个 `歌名-歌手` 形态。
 * 所以用 `songId` 去比 → **0/30 命中**（永远找不到）→ 时长过滤被整段跳过
 * → 5 分钟的歌会搜出 50 分钟的合集，而且**日志里只说"没过滤"、不报错**，极难查。
 *
 * @returns 时长（秒）；找不到或时长为空返回 `null`（调用方据此**跳过过滤**）
 */
export const findSongDuration = (cacheKey: string): number | null => {
  const song = findSongByCacheKey(cacheKey)
  const d = song?.duration
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null
}

/**
 * 按缓存键找到那首歌的**完整信息**
 *
 * 用途：
 *  - 拼搜索词要用「歌名 + 歌手」，而缓存键本身（`tx_xxx`）里没有歌名；
 *  - **拿这首歌的时长**给时长过滤用（`findSongDuration`）；
 *  - 拿 `platformId` / `source` 等展示字段。
 *
 * 找不到返回 `null` —— 调用方应退化成「直接把键当搜索词」。
 *
 * 遍历内存里的 `data`（不是查库）：每次搜索都要调，走 SQLite 多一层开销。
 *
 * ## ⚠️ 必须用 `toCacheKey` 比对，**不能用 `songId`**（踩过，影响很大）
 *
 * 这两个函数返回的**不是同一种键**：
 *
 * | 函数 | 返回 | 例子 |
 * | :--- | :--- | :--- |
 * | `songId(song)` | 歌的**主键**（`songs.id`） | `tx_1828354` |
 * | `toCacheKey(song)` | 歌的**缓存键**（`videos.search_key`） | `新地球-林俊杰` |
 *
 * 而调用方传进来的 `cacheKey` 是**缓存键**（`新地球-林俊杰`）。
 * 之前这里写的是 `songId(song)`，于是：
 *
 * ```
 * 拿 "tx_1828354" 去比 "新地球-林俊杰" → 永远不相等 → 永远返回 null
 * ```
 *
 * 后果非常隐蔽：`findSongDuration` 永远拿到 `null` → **时长过滤整段跳过**
 * → 5 分钟的歌会搜出 50 分钟的合集，而且日志里只说「没过滤」，不报错。
 */
export const findSongByCacheKey = (cacheKey: string): PlaylistSong | null => {
  const want = cacheKey.trim().toLowerCase()
  if (!want) return null
  for (const record of data.playlists) {
    for (const song of record.songs) {
      /** 用 `toCacheKey` 生成键再比 —— 与写缓存 / 读缓存用的是**同一个函数** */
      if (toCacheKey(song).trim().toLowerCase() !== want) continue
      return song
    }
  }
  return null
}

/** 整体覆盖保存（渲染进程每次增删改后调用） */
export const savePlaylists = (params: PlaylistSaveParams): PlaylistStoreData => {
  const normalized: PlaylistRecord[] = []
  if (Array.isArray(params?.playlists)) {
    for (const item of params.playlists) {
      const record = normalizeRecord(item)
      if (!record) continue
      /**
       * 正在同步的歌单：曲目以主进程内存里的为准
       *
       * 渲染层这份是它开始同步之前读到的旧列表，直接覆盖会把刚同步完的曲目丢掉，
       * 而界面还在提示「同步完成 +N/-M」（用户看到的是「同步了个寂寞」）。
       */
      if (syncingIds.has(record.id)) {
        const live = data.playlists.find((p) => p.id === record.id)
        if (live) {
          console.warn(`[playlist] ${record.name} 正在同步，保存时保留内存里的曲目`)
          record.songs = live.songs
          record.lastSyncAt = live.lastSyncAt
        }
      }
      normalized.push(record)
    }
  }

  /**
   * 默认歌单**删不掉**
   *
   * 两个入口都可能把它弄丢：界面上删（那边已经按 `isDefault` 禁了按钮），
   * 以及「整份集合覆盖」时它压根不在数组里（旧版本存档、手改过的库、将来的 bug）。
   * 后者才是这道闸的意义 —— 被删掉之后下次拖单曲又得悄悄建一个，
   * 用户看到的会是「我刚删了它，怎么又冒出来了」。所以干脆补回去。
   *
   * 曲目以**内存里那份**为准：既然这次保存没带上它，就不该借机清空它的歌。
   */
  const liveDefault = data.playlists.find((p) => p.id === DEFAULT_PLAYLIST_ID)
  if (liveDefault && !normalized.some((p) => p.id === DEFAULT_PLAYLIST_ID)) {
    console.warn('[playlist] 保存时默认歌单不在集合里，已补回（它不能被删除）')
    normalized.unshift(liveDefault)
  }

  let nextCurrentId =
    typeof params?.currentId === 'string' && params.currentId ? params.currentId : null
  if (normalized.length > 0 && !normalized.some((p) => p.id === nextCurrentId)) {
    nextCurrentId = normalized[0].id
  }
  if (normalized.length === 0) nextCurrentId = null

  data = { version: PLAYLIST_DATA_VERSION, currentId: nextCurrentId, playlists: normalized }
  writePlaylistsToDb(data)
  /**
   * 返回给渲染层的那份也要贴 `isDefault`
   *
   * 渲染层拿到之后会**直接覆盖**它本地的歌单数组（`playlists` store 的 `persist`），
   * 所以这里漏贴一次，界面上「默认」标签和删除按钮的禁用状态就会一起消失，
   * 直到下一次 `getPlaylists`。
   */
  const saved = structuredClone(data)
  saved.playlists = withDefaultFlag(saved.playlists)
  return saved
}

/**
 * 正在同步中的歌单 id
 *
 * `savePlaylists` 是渲染层**全量覆盖**，而 `syncPlaylist` 是主进程**就地改内存**：
 * 同步要跑好几秒网络请求，期间渲染层任何一次 `persist`（切歌单、编辑歌单）
 * 都会拿它手里的旧曲目列表把同步结果盖掉，随后界面还照样提示「同步完成 +N/-M」。
 * 记下正在同步的 id，覆盖时把这些歌单的曲目**以主进程内存里的为准**。
 */
const syncingIds = new Set<string>()

/**
 * 同步一个歌单（重新解析曲目）
 *
 * @returns 同步结果，其中 added/removed 供界面提示
 */
export const syncPlaylist = async (id: string): Promise<SyncResult> => {
  const index = data.playlists.findIndex((p) => p.id === id)
  if (index < 0) return { id, name: '', ok: false, error: '歌单不存在' }

  const target = data.playlists[index]
  /**
   * 本地歌单**没有同步这个概念**
   *
   * 单独判一句而不是靠下面「没有 sourceUrl」兜住：那样报的是
   * 「该歌单没有保存原始链接，无法自动同步（请重新添加）」——
   * 对本地歌单是误导，它压根不需要链接，用户会以为要去补一个。
   */
  if (isLocalPlaylistId(id)) {
    return {
      id,
      name: target.name,
      ok: false,
      error: '本地歌单不参与同步（链接只用于一次性导入）',
    }
  }
  if (!target.sourceUrl) {
    return {
      id,
      name: target.name,
      ok: false,
      error: '该歌单没有保存原始链接，无法自动同步（请重新添加）',
    }
  }

  syncingIds.add(id)

  try {
    /**
     * 同步时**复用同一个归一化函数**（`toPlaylistSongs`）——
     * 它保证主进程各处产出的 `PlaylistSong` 形态一致（含 `platformId`）。
     */
    const detail = await resolvePlaylist({ input: target.sourceUrl })
    /**
     * ★ 用与 IPC 出口**同一个** `toPlaylistSongs` 归一
     *
     * 同步不经过渲染层（直接在主进程改内存），但产出的形状必须与
     * 「解析 → 渲染层原样回传」那条路径**完全一致** —— 否则同一首歌
     * 走两条路径会得到不同的 `duration` / `platformId`。
     */
    let songs: PlaylistSong[] = toPlaylistSongs(detail.songs)
    if (songs.length > MAX_SYNC_SONGS) songs = songs.slice(0, MAX_SYNC_SONGS)

    /**
     * 固定去重
     *
     * 曾经有个 `duplicatePolicy` 参数（`'keep' | 'dedupe'`），但 IPC 只传 `{ ids }`、
     * 主进程也从来没人传第二个参数 —— `'keep'` 是不可达的死分支，还让人以为「保留重复」可配。
     * 现在直接写明：同步一律去重。
     *
     * 用 `songId` 去重（有平台 id 时是 `tx_xxx`）而不是「歌名-歌手」——
     * 后者会把「同名但不同版本」（live 版、翻唱版）误判成重复。
     */
    {
      const seen = new Set<string>()
      songs = songs.filter((song) => {
        const key = songId(song).trim().toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    /** added / removed 也按 `songId` 算 —— 与「缓存键」同一套，语义才对得上 */
    const before = new Set(target.songs.map((s) => songId(s).trim().toLowerCase()))
    const after = new Set(songs.map((s) => songId(s).trim().toLowerCase()))
    const added = songs.filter((s) => !before.has(songId(s).trim().toLowerCase())).length
    const removed = target.songs.filter((s) => !after.has(songId(s).trim().toLowerCase())).length

    /**
     * 名称与来源**一律以远端为准**
     *
     * 平台歌单的名字属于平台 —— 应用内不给改（编辑表单里名字是只读的），
     * 所以同步时也不需要「保留用户自定义名」那种照顾。反过来还要主动跟上：
     * 用户在平台上改了歌单名，这边同步一次就该跟着变，否则列表里会一直挂着旧名字。
     */
    if (detail.info.name) target.name = detail.info.name
    target.source = detail.source

    /**
     * ★ 把 `lastIndex` **重算成新列表里的位置**（这是「下标能当定位用」的前提）
     *
     * 下标本身是脆弱的：同步后曲目会增删，第 N 个位置可能已经是别的歌。
     * 所以同步时必须把「用户上次听到的那首歌」的**新位置**算出来 ——
     * 此刻旧列表（`target.songs`）和新列表（`songs`）都在手上，正是做这件事的时机。
     *
     * 三种情况：
     *  ① 那首歌还在 → 用它的新下标（可能是另一个位置了）
     *  ② **那首歌被删了** → 保留原下标并夹进范围（效果是「下一首顶上来」，
     *     这是播放器的标准行为；干瞪眼或跳回第一首都不如它合理）
     *  ③ 旧列表本来就是空的（新歌单）→ 0
     */
    const oldSongs = target.songs
    const oldIndex = target.lastIndex
    const playedSong = oldSongs[oldIndex]
    if (songs.length === 0) {
      target.lastIndex = 0
    } else if (playedSong) {
      /** ① 按 `songId` 找它在新列表里的位置（不能用歌名 —— 同步可能改名）*/
      const newPos = songs.findIndex(
        (s) => songId(s).toLowerCase() === songId(playedSong).toLowerCase(),
      )
      /** ② 找不到（歌被删了）就保留原下标；两种情况都要夹进范围 */
      target.lastIndex = Math.min(newPos >= 0 ? newPos : oldIndex, songs.length - 1)
      target.lastIndex = Math.max(0, target.lastIndex)
    } else {
      target.lastIndex = Math.min(Math.max(0, oldIndex), songs.length - 1)
    }

    target.songs = songs
    target.lastSyncAt = Date.now()
    target.updatedAt = Date.now()

    /**
     * 这里以前要顺手清掉「已不存在歌曲」的 videoCache / favorites。
     *
     * 现在两者都在 `videos` 表里、按**缓存键**索引，和歌单曲目表是分开的：
     * 曲目被移出歌单后它的收藏与播放地址仍然留着 —— 这是**有意的**，
     * 用户把一首歌删了再加回来，收藏不该丢（那张表本来就是跨歌单共享的）。
     * 所以这里不需要、也不应该再清任何东西。
     */

    writePlaylistsToDb(data)
    return { id, name: target.name, ok: true, count: songs.length, added, removed }
  } catch (err) {
    target.updatedAt = Date.now()
    writePlaylistsToDb(data)
    return {
      id,
      name: target.name,
      ok: false,
      error: (err as Error)?.message ?? '同步失败',
    }
  } finally {
    // 不管成功失败都要摘掉标记，否则这个歌单以后的覆盖保存都会被拦
    syncingIds.delete(id)
  }
}

/**
 * 同步多个歌单
 *
 * 串行执行，避免同时打多个平台的接口被限流。
 */
export const syncPlaylists = async (ids: string[]): Promise<SyncResult[]> => {
  const results: SyncResult[] = []
  for (const id of ids) {
    results.push(await syncPlaylist(id))
  }
  return results
}
