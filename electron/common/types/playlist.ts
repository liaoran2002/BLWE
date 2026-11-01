/**
 * 歌单数据结构（主 / 渲染共用）
 *
 * 从「单个歌单」升级为「歌单集合」，并补上：
 *  - 自动同步策略（启动时 / 定时）
 *  - 每首歌已选定的某站视频（bvId），用于续播时优先还原上次看的那个视频
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
  /** 音乐平台给的专辑封面；可能为空（如 kw 列表接口不返回封面） */
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
   * 平台侧歌曲 id（QQ 数字 id / wy id / kw rid）
   *
   * 歌单导入时从音源带过来，**取歌词时用它精确定位** ——
   * 不用拿「歌名 + 歌手」重新搜（那是模糊搜索，可能搜到别的版本，
   * 于是显示错误的歌词）。
   */
  platformId?: string | null
  /** 来源音源（`wy` / `tx` / `kw`），与 `platformId` 配对 */
  source?: string
  /**
   * ★某站视频列表条目的 bvid
   *
   * 只有「视频列表」来源的条目才有这个字段。渲染层据此判断：
   *  - `getSongParts()` 直接返回 `bv:<bvid>`（主进程据此短路，不联网搜索）；
   *  - 歌曲的缓存键 = `bv:<bvid>`，而不是 `歌名-歌手`。
   *
   * 音乐平台的歌单条目**永远没有**它 —— 那是两条互不相交的通道。
   */
  bvid?: string
  /**
   * 这条在**它所在的那个视频列表**里是否被收藏
   *
   * 只有视频列表来源的条目会带它。界面的爱心靠它显示实心 / 空心，
   * 值来自 `videolist_items.favorites`（同一个 bvid 换个列表就可能是另一回事）。
   */
  favorites?: boolean
  /**
   * 本地视频文件的条目**此刻文件不在了**
   *
   * 只由 `VideoListItem` 带过来（见那边的注释），主列表据此把那一行打上
   * 「文件丢失」角标 —— 播到它之前就能看见，而不是等播放失败才知道。
   */
  missing?: boolean
}

/*
 * ## 已删除：`DIRECT_KEY_PREFIX` / `directKeyOf` / `bvidOfDirectKey`
 *
 * 这套东西（`search_key = 'bv:<bvid>'` + `api:searchSong` 认前缀短路）原本是
 * 「让视频借用音乐搜索链路」的那层壳：视频条目在 `song_videos` 里占一行假关系，
 * 搜索接口看到前缀就原样返回它自己，于是下游一行分支都不用加。
 *
 * 代价是**两套语义挤在一张表里**：`song_videos` 既装「真候选」，又装
 * 「视频列表条目的假候选」，清理缓存时要专门写 `NOT LIKE 'bv:%'` 绕开它们，
 * 而播放一个视频要绕「搜索 → 取 selected_bvid → 再解析」三跳，
 * 其中两跳对视频没有任何信息增量。
 *
 * 现在视频走自己的路：队列里它就是 `VideoListItem`（带 bvid），
 * 播放时直接按 bvid 解析地址（`api:resolveVideo` 的 keyword 为空），
 * 地址本来就存在 `videos` 表、按 bvid 一行 —— 不需要任何前缀。
 */

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
 * 各平台的 id 空间独立，QQ 的 `123` 和 kw 的 `123` 是两首完全不同的歌，
 * 不带前缀会静默撞在一起。
 *
 * ## ⚠️ 它**只用于 `songs` 表**
 *
 * `videos.search_key` / `song_meta.search_key` 存的是**歌名**
 * （见 `toCacheKey`）—— 那些表要拿键去**搜 某站**，用 id 搜不出任何东西。
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
 * 真正发给某站的是 `歌名 歌曲 歌手`（见 `buildPrimaryKeyword`，**不带引号**），
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
 * 本地歌单的 id 前缀
 *
 * 歌单分两类，**类型由 id 决定，创建后不变**：
 *
 * | 类型 | id 形态 | 链接 | 同步 | 曲目 |
 * | :--- | :--- | :--- | :--- | :--- |
 * | 平台歌单 | `tx_8153225605` | 身份，用来重新解析 | 有 | 只读（去平台上改） |
 * | 本地歌单 | `pl_default` / `pl_<uuid>` | 只做一次性导入 | **没有这个概念** | 随便增删 |
 *
 * 用前缀而不是加一个 `kind` 字段：`id` 在这个项目里本来就是身份
 * （`songs.id` 带音源前缀是同一个理由）。加字段会让「id 说是 QQ 歌单、
 * 字段说是本地」这种自相矛盾的状态有地方可存。
 */
export const LOCAL_PLAYLIST_PREFIX = 'pl_'

/** 这个歌单是不是本地歌单（`pl_default` / `pl_xxx`） */
export const isLocalPlaylistId = (id: string): boolean =>
  String(id ?? '').startsWith(LOCAL_PLAYLIST_PREFIX)

/**
 * 把另一批歌**合并**进现有列表（导入用），跳过已经有的
 *
 * 判重是**两层**的，和「拖入单曲」同一套规则：
 *
 *  - 第一层按 `songId()`：有平台 id 时是 `wy_347230`，精确到「同一平台的同一首」；
 *  - 第二层按 `toCacheKey()`（`歌名-歌手`）：兜住「手动填过的歌」——
 *    那种歌没有平台 id，`songId()` 本身就退化成缓存键，
 *    所以这一层同时负责「平台导入的歌」和「手动填的同名歌」对上。
 *
 * 代价是**同名同歌手的不同版本**（live / 翻唱）会被判成重复。
 * 这是刻意的：宁可少一行，也不要在复合歌单里出现两条一模一样的歌名。
 *
 * @returns `songs` 合并后的新数组（原数组不动）、新增/跳过的数量
 */
export const mergePlaylistSongs = (
  existing: PlaylistSong[],
  incoming: PlaylistSong[],
): { songs: PlaylistSong[]; added: number; duplicated: number } => {
  const seen = new Set<string>()
  const keyOf = (song: PlaylistSong): string => songId(song).trim().toLowerCase()
  const cacheOf = (song: PlaylistSong): string => toCacheKey(song).trim().toLowerCase()

  for (const song of existing) {
    seen.add(keyOf(song))
    seen.add(cacheOf(song))
  }

  const songs = [...existing]
  let added = 0
  let duplicated = 0
  for (const song of incoming) {
    const key = keyOf(song)
    const cache = cacheOf(song)
    if (seen.has(key) || seen.has(cache)) {
      duplicated += 1
      continue
    }
    seen.add(key)
    seen.add(cache)
    songs.push(song)
    added += 1
  }
  return { songs, added, duplicated }
}

/**
 * 一个歌单
 */
export interface PlaylistRecord {
  id: string
  name: string
  /** 来源音源（wy / tx / kw），手动创建时可能为空 */
  source?: string
  /**
   * 原始分享链接，用于自动同步时重新解析
   *
   * **本地歌单恒为空**（`isLocalPlaylistId(id)`）：本地歌单里贴链接只是
   * 「把那个歌单的歌导进来一次」，导完不留链接 —— 否则它会变成
   * 「既算本地、又跟着平台更新」的第三种东西，同步一次就把手动加的歌冲掉。
   */
  sourceUrl?: string
  songs: PlaylistSong[]
  /** 同步策略。本地歌单恒为 `off`（没有同步这个概念） */
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
  /**
   * 是不是**默认歌单**（拖入单曲的落点）
   *
   * 和视频列表那边不同，这里**不用设置项记 id**：默认歌单的主键是固定的
   * `pl_default`（见 `main/utils/playlist.ts`），所以「是不是默认」看一眼 id 就知道，
   * 不存在「设置项指向一个已经被删掉的 id」这种漂移。
   *
   * 由主进程在出口处贴（`getPlaylists` / `savePlaylists` 都贴），
   * 不落库 —— 它是派生状态，不是数据。渲染层只拿它决定「这条不显示删除按钮」。
   */
  isDefault?: boolean
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

// #region 视频列表（某站收藏夹 / 合集 / 系列）

/**
 * 视频列表的来源类型
 *
 * 刻意**不包含**「稍后再看 / 历史 / UP 主投稿」：那些接口的鉴权与分页各不相同，
 * 第一版只做「公开可访问、且返回字段最规整」的三种。
 */
export type VideoListKind = 'fav' | 'season' | 'series' | 'local'

/**
 * 条目来源
 *
 *  - `sync`：从某站列表拉下来的，下次同步以远端为准；
 *  - `local`：用户手动「添加视频」加进来的，某站上没有它 ——
 *    同步时**必须保留**，否则一次同步就把它删了（而且再也找不回来）。
 */
export type VideoListOrigin = 'sync' | 'local'

/**
 * 一个视频列表（对应 `videolists` 表一行）
 *
 * 与 `PlaylistRecord` **不是**同一个东西，也不该合并：
 *  - `PlaylistRecord.songs` 是「歌」，还要再经过搜索才能变成视频；
 *  - 这里的成员**直接就是视频**（bvid），成员存在 `videolist_items`。
 */
/** 视频列表的同步策略，取值与音乐歌单的 `PlaylistSyncMode` 对齐 */
export type VideoListSyncMode = 'off' | 'startup' | 'interval'

export interface VideoListRecord {
  /** 'bv_fav_123456' / 'bv_season_789' / 'bv_series_456' */
  id: string
  kind: VideoListKind
  /** 平台侧 id：media_id / season_id / series_id */
  sourceId: string | null
  /** UP 主 mid（合集 / 系列重新同步时必带；收藏夹不需要） */
  mid?: string | null
  /** 列表名（收藏夹标题 / 合集名） */
  name: string
  cover: string | null
  /** 远端报告的总条数（可能大于实际拉到的条数） */
  itemCount: number | null
  /**
   * 重新同步策略（和音乐歌单同一套语义）
   *
   * `off` 手动同步 / `startup` 每次启动时同步 / `interval` 定时自动同步。
   * 默认 `off`：几百条的视频列表同步一次要打几十个分页请求，不该默默替用户做。
   */
  syncMode: VideoListSyncMode
  /** 定时同步的间隔（毫秒）；只有 `interval` 模式有意义，其余为 0 */
  syncIntervalMs: number
  lastSyncAt: number | null
  /** 播到第几条（下标）；同步后由主进程按 bvid 重定位 */
  lastIndex: number
  createdAt: number
  updatedAt: number
  /**
   * 是不是**默认列表**（拖入单条视频的落点）
   *
   * 判断依据是设置项 `player.defaultVideoListId`，不是「名字叫默认列表」——
   * 用户改名之后它还是默认列表，删不掉（可以改名）。
   * 由主进程填，渲染层只拿它决定「这条不要显示删除按钮」。
   */
  isDefault?: boolean
}

/**
 * 一条视频的**元数据**（导入预览与落库共用）
 *
 * 就是 `videos` 表里那些「这个视频是什么」的列，不含播放地址：
 * 地址要等第一次播放时才解析（一次性预取几百个地址既慢又招风控）。
 *
 * 预览接口把条目按这个形状交给渲染层确认，确认后再原样传回来落库 ——
 * 这样「预览看到的」和「真正写进去的」是同一份数据，中途不会再打一次接口。
 */
export interface VideoMetaInput {
  bvid: string
  title: string
  cover: string | null
  author: string | null
  /** 时长（秒） */
  duration: number | null
}

/**
 * 「添加歌曲」的导入预览（确认框的数据源，**不写库**）
 *
 * 单曲与整个歌单两种形状：确认框按它画「一首歌」或「歌单详情 + 曲目列表」。
 * 用户点确定后，渲染层把 `song` / `songs` 原样传回主进程落库。
 */
export type MusicImportPreview =
  | { type: 'song'; song: PlaylistSong }
  | {
      type: 'playlist'
      /** 音源（wy / tx / kw），只用于界面标注 */
      source: string
      name: string
      cover: string | null
      author: string | null
      songs: PlaylistSong[]
    }
  | { type: 'none' }

/**
 * 这个列表参不参与「自动同步」（启动同步 / 定时同步）
 *
 * 本地列表没有远端来源，平台列表里选了「手动同步」的也不参与 —— 和歌单的
 * `isAutoSyncable` 是同一套判断。
 */
export const isVideoListAutoSyncable = (list: VideoListRecord): boolean =>
  list.kind !== 'local' && !!list.sourceId && list.syncMode !== 'off'

/** 视频列表的同步间隔（毫秒）；非定时模式返回 0 */
export const getVideoListSyncInterval = (list: VideoListRecord): number =>
  list.syncMode === 'interval' ? Math.max(0, list.syncIntervalMs || 0) : 0

/** 此刻是否到了该同步的时间 */
export const isVideoListSyncDue = (list: VideoListRecord, now: number): boolean => {
  const interval = getVideoListSyncInterval(list)
  if (!interval) return false
  if (!list.lastSyncAt) return true
  return now - list.lastSyncAt >= interval
}

/**
 * 「添加视频」的导入预览（确认框的数据源，**不写库**）
 *
 * 单条视频与整个列表两种形状：确认框按它画「视频详情」或「列表详情 + 每条视频」。
 * 用户点确定后，渲染层把 `item` / `items` 原样传回主进程落库 ——
 * 这样确认框里看到的和写进去的是同一份数据，中途不会再打一次接口。
 */
export type VideoImportPreview =
  | { type: 'video'; item: VideoMetaInput }
  | {
      type: 'list'
      kind: VideoListKind
      name: string
      cover: string | null
      itemCount: number | null
      items: VideoMetaInput[]
      /** 远端列表里不支持的条目（合集里的子合集 / 番剧）数量 */
      skipped: number
    }
  | { type: 'none' }

/** 视频列表里的一条（= 一个视频） */
export interface VideoListItem {
  bvid: string
  title: string
  cover: string | null
  /** UP 主名（音乐那边的「歌手」在界面上的对应物） */
  author: string | null
  /** 时长（秒） */
  duration: number | null
  /**
   * 是否收藏（= 在置顶区）
   *
   * 收藏属于「列表 ✕ 条目」的关系，不属于视频本身：同一个 BV 号在两个列表里
   * 可以一个收藏、一个没收藏。所以它在 `videolist_items.favorites` 上，
   * **不是** `videos` 上的列（那会让列表 B 跟着显示成收藏）。
   */
  favorites?: boolean
  /** 来源（同步来的 / 手动加的）；手动加的同样在置顶区 */
  origin?: VideoListOrigin
  /**
   * 本地视频文件的绝对路径（**只有** `lf_` 条目有）
   *
   * 给界面用：丢了文件时能告诉用户「本来在哪」，重新定位时也能拿它当对话框的
   * 默认目录。某站条目恒为 null。
   */
  localPath?: string | null
  /**
   * 文件此刻不在了（**只有** `lf_` 条目会被检查）
   *
   * 由主进程在 `videolists:getItems` 里并发 `stat` 一次得出，**不落库** ——
   * 文件可能只是暂时不在（拔了移动硬盘），下次插回来自然又「存在」了。
   * 界面据此置灰、打「文件丢失」标、把点击行为改成「重新定位」。
   */
  missing?: boolean
}

/** 导入 / 同步一个视频列表的结果 */
export interface VideoListSyncResult {
  id: string
  name: string
  ok: boolean
  /** 列表里最终有几条可用视频 */
  count?: number
  /** 这次同步新增 / 移除的条数 */
  added?: number
  removed?: number
  /** 跳过的条目数（合集条目 / 番剧 / 课程等第一版不支持的） */
  skipped?: number
  error?: string
}

/**
 * 解析出来的列表标识（用户粘贴链接后先得出它，再去拉内容）
 *
 * `mid` 只有合集 / 系列需要（`seasons_archives_list` 必须带 UP 主 mid），
 * 收藏夹不需要。
 */
export interface ParsedListInput {
  kind: VideoListKind
  id: string
  mid?: string
  /** 原样回显给用户看的规范化链接（可空） */
  url?: string
}

/**
 * 「拖进窗口的那个东西」被认成了什么
 *
 * 拖入只有三种有意义的结果，各自对应一条完全不同的进料管：
 *  - `music` —— **音乐歌单**链接（wy / tx / kw）→ 切 MV，导入歌单；
 *  - `list`  —— **某站列表**（收藏夹 / 合集 / 系列）→ 切 OV，导入视频列表；
 *  - `video` —— **单条某站视频** → 切 OV，塞进默认列表。
 *
 * 识别放在**主进程**（`utils/dropInput.ts`）：链接的正则、音源判定、BV 号规则
 * 本来就都在主进程，渲染层只负责按 `type` 调对应的一个接口。
 */
export type DropInputTarget =
  /** 音乐**歌单**：导入成一个歌单（已有则同步） */
  | { type: 'music'; url: string }
  /**
   * 音乐**单曲**：追加进默认歌单
   *
   * 单独一个分支而不是复用 `music`，是因为下游要做的事完全不同：
   * 歌单是「换个歌单听」，单曲是「往默认歌单里塞一首然后播它」。
   * 混在一起会让 `dropImportMusic` 里长出一个 `if (是单曲)`。
   */
  | { type: 'song'; url: string }
  | { type: 'list'; kind: 'fav' | 'season' | 'series'; id: string; mid?: string }
  /**
   * 单条视频：`input` 原样带回去交给 `parseVideoInput`
   *
   * 不返回 bvid 是因为**还没解析**（短链 `b23.tv` 要跟随 302 才知道是哪个视频），
   * 而那一套逻辑已经在 `parseVideoInput` 里了 —— 这里重复一遍只会多一处会漂的实现。
   */
  | { type: 'video'; input: string }
  /** 没认出来（普通文字、本地文件、别的网站链接）—— 什么都不做 */
  | { type: 'none' }

// #endregion
