/**
 * 歌单数据结构（主 / 渲染共用）
 *
 * 从「单个歌单」升级为「歌单集合」，并补上：
 *  - 自动同步策略（启动时 / 定时）
 *  - 每首歌已选定的 B 站视频（bvId），用于续播时优先还原上次看的那个视频
 *  - 每个歌单自己的播放位置，切歌单不丢进度
 */

/** 歌单同步策略 */
export type PlaylistSyncMode = 'off' | 'startup' | 'interval'

export interface PlaylistSync {
  mode: PlaylistSyncMode
  /** mode === 'interval' 时的间隔（毫秒） */
  intervalMs: number
}

/**
 * 一首歌「收藏」的视频、以及「上次播的是哪个视频」，**都已经不在这个文件里了**。
 *
 * 改造后它们存在 SQLite 的 `videos` / `song_meta` 两张表中（见
 * `electron/main/utils/cache.ts` 的 `VideoRow` 与收藏相关函数）：
 *  - 收藏：`videos.favorites` + `videos.ord`（顺带承载列表顺序）
 *  - 上次播的：`song_meta.selected_bvid`
 *
 * 为什么搬走：两者都是**按缓存键**索引、且带「列表顺序」语义的数据，
 * 和歌单（按 id 索引、全量覆盖）的写入节奏完全不同。以前塞在歌单记录里，
 * 每次切歌/收藏都要把整个歌单集合 `savePlaylists` 全量覆盖一遍，
 * 同步进行时还会被 `syncingIds` 拦下来（收藏丢了都没人知道）。
 * 原来的 `VideoRef` / `FavoriteVideo` 两个接口因此一并删除。
 */

/**
 * 歌单里的一首歌（结构化）
 *
 * 之前 songs 是 `"歌名-歌手"` 字符串数组，没法展示封面/专辑/歌手。
 * 现在改成对象，并用 toCacheKey() 拼出与旧版完全一致的缓存键，
 * 这样 matchScore / nameBonus / 缓存 key 那条链路一行都不用改。
 */
export interface PlaylistSong {
  name: string
  singer: string
  album?: string
  /** 音乐平台给的专辑封面；可能为空（如酷我列表接口不返回封面） */
  cover?: string | null
  /**
   * 时长（**秒**）
   *
   * 原来存的是音乐平台原样给的 `"4:03"` 字符串，而候选视频那边
   * （`videos.duration`）一直是秒 —— 两种形状在下游到处判断。
   * schema v2 起统一成秒，展示时用 `formatDuration()` 转回 `mm:ss`。
   */
  duration?: number | null
  /**
   * 平台侧歌曲 id（QQ 数字 id / 网易云 id / 酷我 rid）
   *
   * 歌单导入时从音源带过来，**取歌词时用它精确定位** ——
   * 不用拿「歌名 + 歌手」重新搜（那是模糊搜索，可能搜到别的版本，
   * 于是显示错误的歌词）。
   */
  platformId?: string | null
  /** 来源音源（`wy` / `tx` / `kw`），与 `platformId` 配对 */
  source?: string
}

/**
 * 合法的音源前缀（`songs.id` / `playlists.id` 的前缀部分）
 *
 * 只认这几个 —— 否则 `pl_xxx`（随机兜底 id）会被解析成音源 `pl`，
 * 那是个不存在的平台，下游拿去用会静默出错。
 */
const KNOWN_SOURCES = new Set(['wy', 'tx', 'kw', 'kg'])

/**
 * 从 `songId` / `playlistId` 反推音源（`tx` / `wy` / `kw`）
 *
 * 为什么需要：`songs` 表**没有 `source` 列**了 —— `id` 的前缀（`tx_`）已经
 * 表达了它。反推比再存一列更省，也不可能出现「id 是 tx_ 但 source 写了 wy」
 * 这种自相矛盾。
 *
 * @returns 音源；**前缀不是已知平台时返回 null**
 *          （手动添加的歌是 `歌名-歌手`，兜底歌单是 `pl_xxx`）
 */
export const sourceOfSongId = (id: string): string | null => {
  const m = /^([a-z]+)_/.exec(String(id ?? ''))
  if (!m) return null
  return KNOWN_SOURCES.has(m[1]) ? m[1] : null
}

/**
 * 一首歌的**稳定唯一标识**（`songs.id` / `playlist_songs.song_id`）
 *
 * ## 形态：`音源_平台id`
 *
 * 形如 `tx_002dNLgZ2dk7sy` / `wy_1234567`。带音源前缀是**必须的** ——
 * 各平台的 id 空间独立，QQ 的 `123` 和酷我的 `123` 是两首完全不同的歌，
 * 不带前缀会静默撞在一起。
 *
 * ## ⚠️ 它**只用于 `songs` 表**
 *
 * `videos.search_key` / `song_meta.search_key` 存的是**歌名**
 * （见 `toCacheKey`）—— 那些表要拿键去**搜 B站**，用 id 搜不出任何东西。
 *
 * 这个 id 的唯一用途是让「同一首歌」在两个歌单里只占 songs 表**一行**。
 *
 * ## 没有平台 id 时兜底
 *
 * 手动按「歌名-歌手」添加的歌没有平台 id，退化成 `toCacheKey(song)`。
 */
export const songId = (song: PlaylistSong): string => {
  const pid = typeof song.platformId === 'string' ? song.platformId.trim() : ''
  if (!pid) return toCacheKey(song)
  const src = typeof song.source === 'string' ? song.source.trim() : ''
  return src ? `${src}_${pid}` : pid
}

/** `songId` 的别名（语义更直白：它就是「这首歌的键」） */
export const songKeyOf = songId

/**
 * ★ 歌单主键：`平台_平台歌单id`（如 `tx_8153225605`）
 *
 * ## 为什么不用随机 UUID
 *
 *  - 同一个歌单**重复导入**会命中同一行，而不是攒出一堆副本；
 *  - 重启 / 换机器后靠 `sourceUrl` 能推出同一个 id，不会被认成新歌单。
 *
 * ## 什么时候退化成随机 id
 *
 * **手动新建的歌单**（用户手填歌曲、没有平台链接）没有平台 id ——
 * 那时只能随机生成一个（这部分由主进程处理，见 `newId()`）。
 *
 * @param source 音源（`tx` / `wy` / `kw`）
 * @param listId 平台侧歌单 id
 * @returns 形如 `tx_8153225605`；**参数不全时返回 null**（调用方应退化成随机 id）
 */
export const playlistKey = (
  source: string | undefined | null,
  listId: string | undefined | null,
): string | null => {
  const s = typeof source === 'string' ? source.trim() : ''
  const i = typeof listId === 'string' ? listId.trim() : ''
  if (!s || !i) return null
  return `${s}_${i}`
}

/**
 * 从 `songId` 反推**平台侧歌曲 id**（去掉 `tx_` 前缀）
 *
 * 与 `sourceOfSongId` 配对使用：`songs` 表没有 `source` / `platform_id` 两列，
 * 它们都在 `id` 里。
 *
 * @returns 平台 id；`id` 没有平台前缀时（手动添加的歌）返回 null
 */
export const platformIdOfSongId = (id: string): string | null => {
  const m = /^([a-z]+)_(.+)$/.exec(String(id ?? ''))
  return m ? m[2] : null
}

/**
 * 把「歌名 + 歌手」拼成**缓存键** `"歌名-歌手"`
 *
 * ## ⚠️ 它**不是搜索词**（这两个概念最容易混）
 *
 * 真正发给 B 站的是 `歌名 歌曲 歌手`（见 `buildPrimaryKeyword`，**不带引号**），
 * 而这个只是数据库里用来标识"哪首歌的搜索结果"的**主键**：
 * `videos.search_key` / `song_meta.search_key` 的值。
 *
 * 两者还会**不一致**：歌名带括号时，搜索词是剥过括号的版本，
 * 缓存键保持原始歌名 —— 拿缓存键当搜索词看会完全误解。
 *
 * 命名约定：
 *  - **函数名**用 `CacheKey`（`joinCacheKey` / `toCacheKey` / `parseCacheKey`）
 *  - **变量 / 参数**用 `cacheKey`
 *  - 库里的列名仍是 `search_key`（改列名要清库），但**代码里一律叫 cacheKey**
 *
 * ⚠️ 参数名统一叫 `singer`（**不是 `artist`**）—— 项目里所有其它地方
 * （`PlaylistSong.singer` / `RankOptions.singer` / `scoreVideo` 的参数）
 * 都是 `singer`，用 `artist` 会让读代码的人以为是另一个概念。
 * （唯一叫 `artist` 的地方是 `MediaMetadata` 的**字段名**，那是它的 API。）
 */
export const joinCacheKey = (song: string, singer: string): string => {
  const s = String(song ?? '').trim()
  const a = String(singer ?? '').trim()
  return a ? `${s}-${a}` : s
}

/**
 * 取一首歌的**缓存键**：`"歌名-歌手"`
 *
 * ⚠️ 它**不是歌名**，是「歌名 + 歌手」拼起来的。两处用到它：
 *  1. `videos.search_key` / `song_meta.search_key` —— 缓存主键；
 *  2. 传给 IPC 的歌曲标识。
 *
 * 但**界面显示不要用它**，也**不要为了拿歌名/歌手去拆它** ——
 * `PlaylistSong` 上本来就有 `.name` / `.singer` 两个独立字段，直接取即可
 * （歌名本身还可能含 `-`，拆串是有歧义的）。
 */
export const toCacheKey = (song: PlaylistSong): string =>
  joinCacheKey(song.name, song.singer ?? '')

/**
 * 把 `"歌名-歌手"` 字符串解析成结构化歌曲
 *
 * 只用于**读旧数据**（旧版把曲目存成 `"歌名-歌手"` 字符串数组）。
 * 新数据走 `PlaylistSong` 对象，不需要解析。
 */
export const parseCacheKey = (text: string): PlaylistSong => {
  const raw = String(text ?? '').trim()
  // 只按第一个 '-' 切分：歌名本身可能带 '-'
  const idx = raw.indexOf('-')
  if (idx < 0) return { name: raw, singer: '' }
  return {
    name: raw.slice(0, idx).trim(),
    singer: raw.slice(idx + 1).trim(),
  }
}

/**
 * 一个歌单
 */
export interface PlaylistRecord {
  id: string
  name: string
  /** 来源音源（wy / tx / kw），手动创建时可能为空 */
  source?: string
  /** 原始分享链接，用于自动同步时重新解析 */
  sourceUrl?: string
  songs: PlaylistSong[]
  sync: PlaylistSync
  /** 上次同步成功时间（毫秒时间戳） */
  lastSyncAt: number | null
  createdAt: number
  updatedAt: number
  /**
   * 该歌单上次播放到**第几首**（下标，0 起）
   *
   * ⚠️ 下标会被**重新同步**改变含义（曲目增删后第 N 个位置可能是别的歌）。
   * 所以主进程在 `syncPlaylist` 里**必须重算**这个下标（按歌找新位置），
   * 见那边的注释 —— 那才是这个字段能用的前提。
   *
   * 这首歌被删掉时保留原下标（夹进范围），效果是「下一首顶上来」。
   */
  lastIndex: number
}


/** playlists.json 的结构 */
export interface PlaylistStoreData {
  version: string
  /** 当前选中的歌单 id */
  currentId: string | null
  playlists: PlaylistRecord[]
}

/** 一个歌单的同步结果摘要（用于 UI 提示） */
export interface SyncResult {
  id: string
  name: string
  ok: boolean
  /** 同步后的曲目数 */
  count?: number
  added?: number
  removed?: number
  error?: string
}


/**
 * 一个歌单是否可以自动同步
 *
 * 必须同时满足：有原始分享链接 + 同步方式不是「手动」。
 * 界面与调度都以此为准，避免两边判断不一致。
 */
export const isAutoSyncable = (p: PlaylistRecord): boolean =>
  !!p.sourceUrl && p.sync.mode !== 'off'

/** 歌单的同步间隔（毫秒）；非定时模式返回 0 */
export const getSyncInterval = (p: PlaylistRecord): number =>
  p.sync.mode === 'interval' ? Math.max(0, p.sync.intervalMs || 0) : 0

/**
 * 该歌单此刻是否到了该同步的时间
 *
 * @param now 当前时间戳
 */
export const isSyncDue = (p: PlaylistRecord, now: number): boolean => {
  const interval = getSyncInterval(p)
  if (!interval) return false
  if (!p.lastSyncAt) return true
  return now - p.lastSyncAt >= interval
}

/** IPC：读取 / 保存歌单集合 */
export interface PlaylistSaveParams {
  playlists: PlaylistRecord[]
  currentId: string | null
}
