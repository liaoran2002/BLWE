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
import { parseSearchKey, toSearchKey } from '@common/types/playlist'
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

/** 生成一个歌单 id */
const newId = (): string => randomUUID()

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
  source: string | null
  source_url: string | null
  sync_mode: string
  sync_interval_ms: number
  last_sync_at: number | null
  created_at: number
  updated_at: number
  last_index: number
}

interface SongDbRow {
  playlist_id: string
  ord: number
  name: string
  singer: string
  album: string | null
  cover: string | null
  /** 秒（schema v2 起；原来是平台原样给的 "4:03" 字符串） */
  duration: number | null
  /** 来源音源（wy / tx / kw） */
  source: string | null
  /** 平台侧歌曲 id —— 取歌词要用它精确定位 */
  platform_id: string | null
}

/** `sync_mode` 列 -> `PlaylistSyncMode`（脏值一律当 off，别让界面拿到未定义的行为） */
const toSyncMode = (raw: string | null): PlaylistSyncMode =>
  raw === 'startup' || raw === 'interval' ? raw : 'off'

/**
 * 归一化一首歌
 *
 * 兼容两种输入：
 *  - 旧版 `["歌名-歌手", ...]` 字符串 → 解析成结构化对象（`parseSearchKey`）
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
    const parsed = parseSearchKey(input)
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
  return {
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
}

// #endregion

// #region 读

/** 读全部歌单（含曲目），按 created_at 排序 —— 界面上的顺序必须稳定 */const readPlaylistsFromDb = (): PlaylistRecord[] => {
  const db = getDb()
  const playlistRows = db
    .prepare(
      `SELECT id, name, source, source_url, sync_mode, sync_interval_ms,
              last_sync_at, created_at, updated_at, last_index
         FROM playlists
        ORDER BY created_at ASC`,
    )
    .all() as PlaylistDbRow[]
  if (playlistRows.length === 0) return []

  /**
   * 曲目一次性全查出来再按 playlist_id 分组
   *
   * 不用「每条歌单查一次」：歌单数量不多（几十个），但逐个查就是几十次
   * prepare + 往返，而且这里每次启动都会跑。一次查完在 JS 里分组更划算，
   * 也避免了「歌单很多时启动变慢」这种以后才会发现的性能问题。
   */
  const songRows = db
    .prepare(
      `SELECT playlist_id, ord, name, singer, album, cover, duration, source, platform_id
         FROM playlist_songs
        ORDER BY playlist_id ASC, ord ASC`,
    )
    .all() as SongDbRow[]
  const songsByPlaylist = new Map<string, PlaylistSong[]>()
  for (const row of songRows) {
    let list = songsByPlaylist.get(row.playlist_id)
    if (!list) {
      list = []
      songsByPlaylist.set(row.playlist_id, list)
    }
    list.push({
      name: row.name,
      singer: row.singer ?? '',
      album: row.album ?? undefined,
      cover: row.cover,
      duration: row.duration,
      platformId: row.platform_id,
      source: row.source ?? undefined,
    })
  }

  return playlistRows.map((row) => ({
    id: row.id,
    name: row.name,
    source: row.source ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    songs: songsByPlaylist.get(row.id) ?? [],
    sync: { mode: toSyncMode(row.sync_mode), intervalMs: row.sync_interval_ms ?? 0 },
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastIndex: row.last_index ?? 0,
  }))
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
 * **注意 song_meta / videos 不跟着删**：那两张表按「搜索键」记收藏与播放地址，
 * 删歌单不该顺手把用户收藏的视频全清了（重新加回同一个歌单，收藏还在）。
 */
const writePlaylistsToDb = (store: PlaylistStoreData): void => {
  const db = getDb()
  tx(() => {
    db.prepare(`DELETE FROM playlists`).run()
    db.prepare(`DELETE FROM playlist_songs`).run()

    const insertPlaylist = db.prepare(
      `INSERT INTO playlists
         (id, name, source, source_url, sync_mode, sync_interval_ms,
          last_sync_at, created_at, updated_at, last_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertSong = db.prepare(
      `INSERT INTO playlist_songs
         (playlist_id, ord, name, singer, album, cover, duration, source, platform_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    for (const record of store.playlists) {
      insertPlaylist.run(
        record.id,
        record.name,
        record.source ?? null,
        record.sourceUrl ?? null,
        record.sync.mode,
        record.sync.intervalMs,
        record.lastSyncAt,
        record.createdAt,
        record.updatedAt,
        record.lastIndex,
      )
      record.songs.forEach((song, index) => {
        insertSong.run(
          record.id,
          index,
          song.name,
          song.singer ?? '',
          song.album ?? null,
          song.cover ?? null,
          song.duration ?? null,
          song.source ?? null,
          song.platformId ?? null,
        )
      })
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
  console.log(`[playlist] 已加载 ${records.length} 个歌单，当前=${data.currentId ?? '无'}`)
}

/** 取完整集合（深拷贝，避免调用方改到内存里那份） */
export const getPlaylists = (): PlaylistStoreData => structuredClone(data)

/**
 * 按搜索键查一首歌的时长（秒）
 *
 * 用途：搜索 B站 MV 时按「视频时长 vs 歌曲时长 ±90 秒」过滤候选
 * （见 `biliApi.searchSongFiltered`）—— 时长差太多的多半不是同一首歌。
 *
 * 遍历所有歌单里的所有曲目，取第一个匹配的。**遍历内存里的 data**
 * （不是查库）：歌单是主进程内存里的权威副本，而且这里要的是「快」——
 * 每次搜索都要调一次，走 SQLite 反而多一层开销。
 *
 * @returns 时长（秒）；找不到或时长为空返回 `null`（调用方据此**跳过过滤**）
 */
export const findSongDuration = (searchKey: string): number | null => {
  const want = searchKey.trim().toLowerCase()
  if (!want) return null
  for (const record of data.playlists) {
    for (const song of record.songs) {
      /**
       * 用 `toSearchKey` 生成键再比 —— 与渲染层、缓存用的是**同一个函数**，
       * 这样三处的「这首歌是谁」判定完全一致（手工拼字符串早晚会漂移）。
       */
      if (toSearchKey(song).trim().toLowerCase() !== want) continue
      const d = song.duration
      return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null
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
  let nextCurrentId =
    typeof params?.currentId === 'string' && params.currentId ? params.currentId : null
  if (normalized.length > 0 && !normalized.some((p) => p.id === nextCurrentId)) {
    nextCurrentId = normalized[0].id
  }
  if (normalized.length === 0) nextCurrentId = null

  data = { version: PLAYLIST_DATA_VERSION, currentId: nextCurrentId, playlists: normalized }
  writePlaylistsToDb(data)
  return structuredClone(data)
}

/** 去重用的归一化 key */
const songKey = (song: PlaylistSong): string =>
  toSearchKey(song).trim().toLowerCase()

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
    const detail = await resolvePlaylist({ input: target.sourceUrl })
    /**
     * 直接保留结构化字段（封面/专辑/歌手/时长），不再压成字符串。
     *
     * `interval` 各音源给的形状不一样（wy 是 `"4:03"`、tx 先按秒再被
     * `formatPlayTime` 转成字符串、kw 同样），所以统一过一遍
     * `durationToSeconds` 归一成秒 —— 库里那一列现在是 INTEGER。
     */
    let songs: PlaylistSong[] = detail.songs.map((song) => ({
      name: song.name,
      singer: song.singer,
      album: song.albumName,
      cover: song.cover ?? null,
      duration: durationToSeconds(song.interval),
      /** 顺手带上平台 id 与音源 —— 取歌词要用（见 PlaylistSong.platformId） */
      platformId: song.platformId ?? null,
      source: song.source,
    }))
    if (songs.length > MAX_SYNC_SONGS) songs = songs.slice(0, MAX_SYNC_SONGS)

    /**
     * 固定去重
     *
     * 曾经有个 `duplicatePolicy` 参数（`'keep' | 'dedupe'`），但 IPC 只传 `{ ids }`、
     * 主进程也从来没人传第二个参数 —— `'keep'` 是不可达的死分支，还让人以为「保留重复」可配。
     * 现在直接写明：同步一律去重。
     */
    {
      const seen = new Set<string>()
      songs = songs.filter((song) => {
        const key = songKey(song)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    const before = new Set(target.songs.map(toSearchKey))
    const after = new Set(songs.map(toSearchKey))
    const added = songs.filter((s) => !before.has(toSearchKey(s))).length
    const removed = target.songs.filter((s) => !after.has(toSearchKey(s))).length

    // 名称与来源以远端为准，但保留用户自定义的名字（仅当原名为空时更新）
    if (!target.name.trim()) target.name = detail.info.name || target.name
    target.source = detail.source
    target.songs = songs
    target.lastSyncAt = Date.now()
    target.updatedAt = Date.now()
    // 曲目数变化可能让下标越界
    if (target.lastIndex >= songs.length) target.lastIndex = 0

    /**
     * 这里以前要顺手清掉「已不存在歌曲」的 videoCache / favorites。
     *
     * 现在两者都在 `videos` 表里、按**搜索键**索引，和歌单曲目表是分开的：
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
