/**
 * 搜索缓存 / 候选视频 / 收藏（主进程）
 *
 * 数据层从「一个关键词一个 JSON 文件」换成了 SQLite 的 `videos` + `song_meta` 两张表。
 * 换掉的不只是存储方式，**过期语义**也跟着变了，这是理解本文件的关键：
 *
 *  - 旧实现（JSON 文件）把「整个搜索结果包」当一个条目，`cache.maxAge` 到期就
 *    **连标题、封面、收藏一起删掉**。而播放直链里是带签名的地址，
 *    实测寿命只有约 2 小时 —— 用 2 小时的数据寿命去决定 3 天的元数据寿命，
 *    结果就是「隔一天回来，收藏的东西位置全乱、标题也没了」。
 *  - 现在把两类数据分开：元数据（标题/封面/收藏/顺序）**永不过期**，
 *    只有播放地址相关的列（`durl_url` / `dash_*` / `playurl_at`）会被清理
 *    （见 `clearExpiredPlayurl`）。行永远不删 —— 这是「收藏不会自己消失」的前提。
 *
 * 另外收藏的「顺序」由 `videos.ord` 承担：收藏一条就把它的 ord 挪到最前，
 * 重新搜索时把新结果接在收藏项后面，于是**渲染层拿到的顺序就是最终顺序**，
 * 不需要再自己排一遍（旧实现是在渲染层 `applyFavoriteOrder` 里补的，
 * 两处各排一次必然对不上）。
 *
 * ## schema v2 之后的关键变化（本文件的第二次改造）
 *
 * schema v2 把解析结果**合回了 `videos`**、并拆成结构化列（`durl_url` /
 * `dash_video` / `dash_audio` / `dash_duration` / `quality` / `support_formats` /
 * `playurl_login_state` / `dash_tried` / `playurl_at`），`video_details` 表连同
 * `view_result` / `playurl_result` 两个整包 JSON 列一起删掉了。于是本文件多了两件必须做的事：
 *
 *  1. **`biliApi` 里那几个读取函数是按响应形状写的，不能改**（它们同时被
 *     「联网新解析」和「读缓存」两条路径共用）。所以这里用 `toPlayUrlLike()`
 *     把结构化列**拼回最小响应形状**，`VideoRow.playurl` 就是这个拼好的东西。
 *  2. **`save()` 必须显式搬运地址列**。以前地址在 `video_details`（按 bvid 唯一），
 *     `save` 只删插 `videos`，所以地址「天然保留着」。合表之后 `save` 的
 *     DELETE 会把地址一起删掉 —— 必须先从旧行读出来再写回去，见那里的注释。
 */
import type { CacheStats } from '@common/types/cache_stats'
import { pickNormalCdnUrl } from '../biliApi'
import { getSetting } from './setting'
import { getDb, tx } from './db'

/**
 * 「B 站 playurl 响应」的最小形状
 *
 * **不是**整包响应，只含 `extractDashStreams` / `readQualityOptions` /
 * `readVideoQuality` 三个读取函数真正用到的字段。类型上用 `data: unknown`：
 * 那三个函数本来就按自己的最小声明去 narrow（它们同时要能吃下联网拿到的整包响应），
 * 这里如果精确声明反而会和它们的入参类型打架。
 */
export interface PlayUrlLike {
  data: unknown
}

/** `videos` 表的一行（对外的形状；列名用 camelCase 给渲染层） */
export interface VideoRow {
  cacheKey: string
  bvid: string
  /** 列表顺序（越小越靠前）；收藏项永远在最前面 */
  ord: number
  /** 来自**搜索结果**，含 `<em class="keyword">` 关键词高亮（必须原样留着） */
  title: string
  /** 封面来自 **view 响应**（搜索结果里的封面尺寸偏小） */
  pic: string | null
  author: string | null
  /** 时长（秒） */
  duration: number | null
  favorites: boolean
  /**
   * 拼好的最小 playurl 形状，给 `extractDashStreams` / `readQualityOptions` /
   * `readVideoQuality` 用；这一行还没解析过地址时为 null。
   */
  playurl: PlayUrlLike | null
  /**
   * 上次解析时的登录态快照：true/false，未知为 `undefined`（**故意不用 null**）
   *
   * 和「库里存 NULL」是同一件事的两种写法：`undefined` 表示这个字段没有任何约束，
   * 于是 `cache === false` 这类判断天然为假 —— 不会把「未知」误当成「未登录时取的」，
   * 那是「我明明登录着却老在重新解析」的根源。
   */
  playurlLoginState?: boolean
  /** 这次解析有没有试过 dash（试过但没拿到，下次就别反复重取） */
  dashTried: boolean
  /** 上面那批地址的写入时刻（过期判定）；没解析过为 null */
  playurlAt: number | null
}

/**
 * `videos` 表的**元数据行**（snake_case）
 *
 * 这是从 `videos_meta` 视图读出来的形状 —— **没有地址列**。
 * 绝大多数读都走这个（列候选、合并收藏项、给渲染层的整包）。
 */
interface VideoMetaDbRow {
  search_key: string
  bvid: string
  ord: number
  title: string | null
  pic: string | null
  author: string | null
  duration: number | null
  favorites: number
  playurl_login_state: number | null
  dash_tried: number
  playurl_at: number | null
}

/**
 * `videos` 表的**完整行**（含地址列）
 *
 * 只有「解析前要判断地址还能不能用」那条路需要它（`getVideoRow` / `getVideoAddress`）。
 * 地址列加起来约 27 KB/行，能少读就少读 —— 见 `db.ts` 里 `videos_meta` 的注释。
 */
interface VideoDbRow extends VideoMetaDbRow {
  durl_url: string | null
  dash_video: string | null
  dash_audio: string | null
  dash_duration: number | null
}

/**
 * `videos` 的**全列**清单（含地址）—— 只有「解析前要读地址」那条路用它
 *
 * 顺序与建表语句一致，一眼能对上。
 */
const VIDEO_COLUMNS = `
  search_key, bvid, ord, title, pic, author, duration, favorites,
  durl_url, dash_video, dash_audio, dash_duration,
  playurl_login_state, dash_tried, playurl_at
`

/**
 * 元数据列清单 —— 与 `videos_meta` 视图的列**逐字一致**
 *
 * 单独留一份常量（而不是只靠视图）是因为 `save()` 里要按这些列从旧行搬运，
 * 而那里读的也是视图；两处共用这一个常量就不会漂移。
 */
const META_COLUMNS = `
  search_key, bvid, ord, title, pic, author, duration, favorites,
  playurl_login_state, dash_tried, playurl_at
`

/** 缓存里的一条搜索结果条目（`api:searchSong` 的 `result[]` 元素） */
interface CachedSearchItem {
  bvid: string
  title?: string
  pic?: string
  author?: string
  /**
   * 时长**秒数**（`null` / 缺省 = 未知）
   *
   * 上游（`biliApi.extract`）已经把 B站的 `"4:03"` 转成秒了，
   * 写库直接存这个值。
   */
  duration?: number | null
  favorites?: boolean
  [key: string]: unknown
}

/** `api:searchSong` 的整包返回体形状（`get`/`save` 的搬运对象） */
interface SearchPayload {
  code: number
  message?: string
  data?: {
    result?: CachedSearchItem[]
    selectedBvid?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** 每一首歌最多留多少条候选视频（防御搜索结果异常巨大把库撑爆） */
const MAX_VIDEOS_PER_KEY = 300

/** JSON 字符串解析：坏数据一律当空，不让一条脏行毁掉整次读取 */
const parseJson = <T>(raw: string | null): T | undefined => {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * 把 `videos` 行的结构化列拼回「B 站 playurl 响应」的最小形状
 *
 * **入参必须是完整行**（含地址列）。元数据行没有地址，调用方要先用
 * `getVideoAddress()` / `getVideoRow()` 单独取那一行。
 *
 * **为什么要拼回去而不是让那几个读取函数改成读列**：
 * `extractDashStreams` / `readQualityOptions` / `readVideoQuality` 是**同一条逻辑
 * 服务两条路径**——联网刚解析出来的整包响应、以及从库里读出来的结构化列。
 * 让它们同时认两种形状等于把「两套解析」塞进一个函数，是最容易漂移的写法；
 * 而让它们只认响应形状、在这一个地方做适配，改动面最小。
 *
 * 返回 null 的判据是「**一点地址都没有**」：只有 `durl_url` / `dash_video` /
 * `dash_audio` 三个都为 NULL 才算没解析过。
 * 这个判据同时被 handler 当作 `hasValidData` 用，所以不能放宽。
 *
 * **拼回去的字段只包含「真的还存在库里的」**：`quality` / `support_formats` 两列
 * 在 schema v4 删掉了（durl 档位从 `durl_url` 反推、展示名走内置档位表），
 * 所以这里也不再有它们 —— `readVideoQuality` 改为认 URL。
 */
const toPlayUrlLike = (row: VideoDbRow): PlayUrlLike | null => {
  if (!row.durl_url && !row.dash_video && !row.dash_audio) return null

  const video = parseJson<unknown[]>(row.dash_video)
  const audio = parseJson<unknown[]>(row.dash_audio)

  return {
    data: {
      /**
       * `duration` 要一起带上：`extractDashStreams` 会把它交给 MSE 补
       * `MediaSource.duration`（分片 MP4 的 mvhd 常是 0）。
       */
      dash: { duration: row.dash_duration ?? undefined, video, audio },
      // `readVideoQuality` / `extractDashStreams` 都按 `durl[0].url` 读
      durl: row.durl_url ? [{ url: row.durl_url }] : undefined,
    },
  }
}

/**
 * 把元数据行转成对外的 `VideoRow`
 *
 * `playurl` 恒为 `null` —— 元数据行里没有地址（这正是它快 15 倍的原因）。
 * 需要地址的调用方走 `getVideoAddress()`。
 */
const toVideoRow = (row: VideoMetaDbRow): VideoRow => ({
  cacheKey: row.search_key,
  bvid: row.bvid,
  ord: row.ord,
  title: row.title ?? '',
  pic: row.pic,
  author: row.author,
  duration: row.duration,
  favorites: row.favorites === 1,
  playurl: null,
  // 库里 NULL（未知）刻意映射成 undefined：见 VideoRow.playurlLoginState 的注释
  playurlLoginState:
    row.playurl_login_state === null ? undefined : row.playurl_login_state === 1,
  dashTried: row.dash_tried === 1,
  playurlAt: row.playurl_at,
})

/**
 * 从 playurl 响应里取第一条 durl（渐进式 mp4）地址
 *
 * 这条逻辑的**唯一实现**就在这里（原来在 `biliApiHandlers.ts` 里另有一份，
 * 读缓存那条路改成结构化列之后它没了用处）。写库时提取 `durl_url` 要用它，
 * 不能两处各写一份：`url` 有可能是 P2P 节点（普通请求 403），
 * 「优先常规 CDN 的备用地址」这条规则改一处漏一处就会出现「有的视频放不出来」。
 */
const extractDurl = (playData: unknown): string | null => {
  const durl = (
    playData as
      | { data?: { durl?: Array<{ url?: string; backup_url?: string[]; backupUrl?: string[] }> } }
      | null
      | undefined
  )?.data?.durl
  const first = durl?.[0]
  if (!first) return null
  return pickNormalCdnUrl(first.url, first.backup_url ?? first.backupUrl)
}

/** 一次 playurl 解析要落库的那几列 */
interface PlayurlColumns {
  durlUrl: string | null
  dashVideo: string | null
  dashAudio: string | null
  dashDuration: number | null
}

/**
 * 从整包 playurl 响应里抽出结构化列（写库前的**唯一**一处转换）
 *
 * `dash_video` / `dash_audio` 存的是**完整数组**（`data.dash.video` 整个，
 * 每条含 `baseUrl` / `backupUrl` / `id` / `width` / `height` / `mimeType` /
 * `codecs` / `bandwidth`），**不是** `extractDashStreams` 挑中的那一条：
 *
 *  - 渲染层「切换清晰度」就是拿这份全量在本地重新挑一条，只存挑中的那条
 *    会让每次换档位都得重新联网；
 *  - 更要紧的是 `backupUrl` 必须留着：只存挑中的那一个 URL，
 *    某个 CDN 返回 403 时就没有备用地址可换了。
 *  - 它同时是**档位列表的来源**（`dash.video[].id`）—— 按 id 分 URL，
 *    没有 URL 就放不出来，所以比 `accept_quality` 权威，那一列也就没存。
 *
 * **不抽 `quality` 和 `support_formats`**（schema v4 已删这两列）：
 * durl 的档位编码在 `durl_url` 里（`URL 数字 = quality + 128`，实测 24/24 成立），
 * 展示名走 `@common/constants` 的内置档位表（已覆盖全部 12 档）。
 *
 * 两处（UPDATE 已有行 / INSERT 补插行）都走这一个函数，避免「一边存全量、
 * 一边只存挑中的那条」这种查起来极痛苦的漂移。
 */
const extractPlayurlColumns = (playurl: unknown): PlayurlColumns => {
  const data = (
    playurl as
      | { data?: { dash?: { duration?: unknown; video?: unknown; audio?: unknown } } }
      | null
      | undefined
  )?.data
  const dash = data?.dash
  return {
    durlUrl: extractDurl(playurl),
    dashVideo: Array.isArray(dash?.video) ? JSON.stringify(dash.video) : null,
    dashAudio: Array.isArray(dash?.audio) ? JSON.stringify(dash.audio) : null,
    dashDuration: typeof dash?.duration === 'number' ? dash.duration : null,
  }
}

/** 该缓存键下现有的最大 ord（空表返回 -1，方便 +1 得到 0） */
const maxOrdOf = (cacheKey: string): number => {
  const row = getDb()
    .prepare(`SELECT MAX(ord) AS maxOrd FROM videos WHERE search_key = ?`)
    .get(cacheKey) as { maxOrd: number | null } | undefined
  return row?.maxOrd ?? -1
}

/**
 * 按主键取一行**完整行**（内部用：要读到地址那几列）
 *
 * 这是**唯一**会读地址列的内部读取点 —— 地址列约 27 KB/行，
 * 其它地方一律走 `videos_meta` 视图（见 `db.ts` 里视图的注释）。
 */
const getVideoRow = (cacheKey: string, bvid: string): VideoDbRow | undefined =>
  getDb()
    .prepare(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE search_key = ? AND bvid = ?`)
    .get(cacheKey, bvid) as VideoDbRow | undefined

/**
 * 取某个 bvid 的**播放地址信息**（给 `api:resolveVideo` 判断能不能直接用缓存）
 *
 * 为什么要单独开一个函数，而不是让调用方从 `get()` 的整包里翻：
 * `get()` 返回的是**整份候选列表**，而解析时只关心**当前这一个 bvid**。
 * 从整包里翻意味着把 300 行的 dash JSON（好几 MB）全读出来只为了用其中一行 ——
 * 实测读全列 9.6 ms、只读一行带地址的行不到 0.1 ms。
 *
 * 返回值里的 `playurl` 已经拼成 `extractDashStreams` 等函数认识的形状；
 * 没解析过（三个地址列全空）时为 null。
 */
export const getVideoAddress = (
  cacheKey: string,
  bvid: string,
): {
  durlUrl: string | null
  playurl: PlayUrlLike | null
  loginState: boolean | undefined
  dashTried: boolean
  playurlAt: number | null
} | null => {
  if (!cacheKey || !bvid) return null
  try {
    const row = getVideoRow(cacheKey, bvid)
    if (!row) return null
    return {
      durlUrl: row.durl_url,
      playurl: toPlayUrlLike(row),
      loginState:
        row.playurl_login_state === null ? undefined : row.playurl_login_state === 1,
      dashTried: row.dash_tried === 1,
      playurlAt: row.playurl_at,
    }
  } catch (err) {
    console.error('[cache] 读取播放地址失败:', err)
    return null
  }
}

/**
 * 读一个**缓存键**下的所有视频（按 ord 排序，**只有元数据**）
 *
 * `ord` 里已经蕴含了「收藏在最前 + 收藏的相对顺序 + 其余保持搜索结果顺序」，
 * 所以调用方**直接按返回顺序用**即可，不要再按收藏过滤重排。
 *
 * 走 `videos_meta` 视图：这里的调用方（合并收藏项、判断某条在不在）都只要元数据，
 * 读上 dash 大 JSON 纯属浪费（实测快 15 倍）。
 */
export const listVideos = (cacheKey: string): VideoRow[] => {
  if (!cacheKey) return []
  const rows = getDb()
    .prepare(`SELECT ${META_COLUMNS} FROM videos_meta WHERE search_key = ? ORDER BY ord ASC`)
    .all(cacheKey) as VideoMetaDbRow[]
  return rows.map(toVideoRow)
}

/**
 * 整包读取（给 `api:searchSong` / `api:resolveVideo` 用）
 *
 * 把 `videos` + `song_meta` 拼回原来的形状 `{ code, data: { result, selectedBvid } }`。
 * **形状必须保持一致**：`api:searchSong` 的调用方（渲染层）是按 `data.result` 读的。
 *
 * **走 `videos_meta` 视图**：这个包是给渲染层显示列表用的，渲染层从来不用地址
 * （播放地址由 `api:resolveVideo` 单独给），所以没必要把 dash 大 JSON 拖出来。
 * 需要地址的地方走 `getVideoAddress()`。
 *
 * 没有任何视频时返回 null（= 未命中），让调用方去联网 —— 这和旧实现的语义一致。
 */
export const get = async <T = unknown>(keyword: string): Promise<{ data: T } | null> => {
  try {
    if (!keyword) return null
    const rows = getDb()
      .prepare(`SELECT ${META_COLUMNS} FROM videos_meta WHERE search_key = ? ORDER BY ord ASC`)
      .all(keyword) as VideoMetaDbRow[]
    if (rows.length === 0) return null

    const result: VideoRow[] = rows.map(toVideoRow)

    const selectedBvid = getSelectedBvid(keyword)
    /**
     * `code: 0` 是硬编码的：缓存命中的语义就是「这次搜索成功过」。
     * 存一份真实的 code 没有意义 —— 非 0 的返回体（搜索失败）本来就不会被写进来。
     */
    const payload: SearchPayload = {
      code: 0,
      data: {
        result: result as unknown as CachedSearchItem[],
        ...(selectedBvid ? { selectedBvid } : {}),
      },
    }
    return { data: payload as T }
  } catch (err) {
    console.error('[cache] 读取缓存失败:', err)
    return null
  }
}

/**
 * 整包写入
 *
 * 把 `result[]` 拆成 `videos` 的行，`selectedBvid` 写进 `song_meta`。
 *
 * **顺序由调用方决定（`ord` = 数组下标），本函数不做任何重排。**
 * 为什么把「谁排前面」交给调用方：收藏要在最前面、收藏之间还要保持原相对顺序、
 * 收藏里没搜到的还要回源刷新标题 —— 这些判断需要联网（`parseVideoInput`）
 * 和对「旧收藏」的理解，都不是一个存储层该做的事。存储层只管忠实落盘，
 * 于是「渲染层看到的顺序」和「库里存的顺序」永远一致，不会出现两边各排一次。
 *
 * ## ⚠️ 地址列必须显式搬运（本函数最容易出错的地方）
 *
 * 现在是「DELETE 该 search_key 的所有行 + 重新 INSERT」。schema v2 之前地址在
 * `video_details`（按 bvid 唯一），那句 DELETE 只删 `videos`，所以同一个 bvid 的地址
 * **天然保留着**，不需要搬运。**合表之后这个前提没有了**：地址就在被删掉的那些行里，
 * 不搬就等于「每点一次刷新列表，所有已解析好的地址全丢」，用户看到的是
 * 「刷新一下，每首歌都要重新解析 dash 才能播」。
 *
 * 新搜索结果里**根本没有地址**（搜索接口只给标题/封面/时长），所以唯一的来源
 * 就是旧行。下面 `insert.run(...)` 那一段把旧行的 9 个地址列原样写回去。
 * 改这段时务必保证删掉的 DELETE 之后、INSERT 之前能拿到 `existing` 里的旧行。
 *
 * 另外两样东西**只认库里的旧值**，不能由传入的包覆盖：
 *  - `favorites`：新搜索结果里没有「收藏」这个概念。以前把入参的收藏标记当真，
 *    用户取消收藏后一刷新又回来了（入参是渲染层的旧回显）。
 *  - 入参没带的展示字段（title/pic/author/duration）回落到旧值，避免把好数据抹成空。
 */
export const save = async (keyword: string, data: unknown): Promise<boolean> => {
  try {
    if (!keyword) return false
    const payload = data as SearchPayload | null
    const items = payload?.data?.result
    if (!Array.isArray(items) || items.length === 0) {
      // 空结果不写：调用方（api:searchSong）已经拦了一层，这里再兜一次
      return false
    }

    /** 去重 + 丢空：同一 bvid 只留第一次出现的位置（顺序权威在调用方） */
    const seen = new Set<string>()
    const incoming: CachedSearchItem[] = []
    for (const raw of items) {
      const item = raw as CachedSearchItem
      if (!item?.bvid || seen.has(item.bvid)) continue
      seen.add(item.bvid)
      incoming.push(item)
    }
    if (incoming.length === 0) return false

    const db = getDb()
    /**
     * **在这里重新读一次库**（而不是用调用方读过的快照）
     *
     * `api:searchSong` 是「读库 -> 联网搜索/回源刷新收藏项（秒级 await）-> 写库」，
     * 中间那段 await 里用户完全可能刚点了一个收藏。如果拿调用方的旧快照写回，
     * 那个刚收藏的条目不在新结果里 -> 被下面这句 DELETE 一起删掉，
     * 用户看到的是「我收藏了一下，刷新完它没了」。所以权威的旧状态必须在这里读。
     *
     * 同一份 `existing` 还负责**保住地址列**（见上面 ⚠️ 那段），一次读两用。
     */
    const existing = new Map<string, VideoDbRow>()
    for (const row of db
      .prepare(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE search_key = ?`)
      .all(keyword) as VideoDbRow[]) {
      existing.set(row.bvid, row)
    }

    /**
     * 新结果里**没有**的已收藏条目：保留在列表最后
     *
     * 两种来路，都是不能丢的：
     *  1. 搜索期间刚被收藏的（上面那段竞态）；
     *  2. 用户「添加视频」加进来的、本来就不在搜索结果里的 BV 号。
     *
     * 放在最后而不是最前：正常路径下 `api:searchSong` 的合并会把收藏项排到前面
     * 并把它们一起放进 `incoming`，所以这里命中的只是上面那两种边角情况 ——
     * 对它们来说「不要消失」是刚需，「排第几」无所谓。反过来放在最前就有问题：
     * 会插到合并好的收藏项前面，把用户刚收藏的那一条挤出第一位。
     */
    const orphans = [...existing.values()].filter(
      (row) => row.favorites === 1 && !seen.has(row.bvid),
    )

    tx(() => {
      db.prepare(`DELETE FROM videos WHERE search_key = ?`).run(keyword)

      /**
       * 列清单是**全量**的：展示字段 + 顺序 + 收藏 + 全部地址列。
       * 少写一个地址列，对应那种地址就会在每次刷新列表时被清成 NULL。
       */
      const insert = db.prepare(
        `INSERT INTO videos
           (search_key, bvid, ord, title, pic, author, duration, favorites,
            durl_url, dash_video, dash_audio, dash_duration,
            playurl_login_state, dash_tried, playurl_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )

      /**
       * 写一行：展示字段取新结果的（缺失回落旧值），其余一律沿用旧行。
       *
       * `ord` 永远用本次下标：顺序的权威就是调用方传进来的数组顺序。
       */
      const insertRow = (
        bvid: string,
        ord: number,
        title: string,
        pic: string | null,
        author: string | null,
        duration: number | null,
        favorites: number,
        old: VideoDbRow | undefined,
      ): void => {
        insert.run(
          keyword,
          bvid,
          ord,
          title,
          pic,
          author,
          duration,
          favorites,
          // ↓↓ 地址列：唯一来源是旧行（新搜索结果里没有地址）↓↓
          old?.durl_url ?? null,
          old?.dash_video ?? null,
          old?.dash_audio ?? null,
          old?.dash_duration ?? null,
          old?.playurl_login_state ?? null,
          // `dash_tried` 是 NOT NULL：没有旧行（全新条目）就是 0 = 没试过
          old?.dash_tried ?? 0,
          old?.playurl_at ?? null,
        )
      }

      incoming.slice(0, MAX_VIDEOS_PER_KEY).forEach((item, index) => {
        const old = existing.get(item.bvid)
        insertRow(
          item.bvid,
          index,
          item.title ?? old?.title ?? '',
          item.pic ?? old?.pic ?? null,
          item.author ?? old?.author ?? null,
          /**
           * 时长**已经是秒**（`biliApi.extract` 在入口转好），不再解析。
           * 拿不到就沿用旧值。
           */
          item.duration ?? old?.duration ?? null,
          old?.favorites ?? 0,
          old,
        )
      })

      orphans.forEach((row, i) => {
        insertRow(
          row.bvid,
          incoming.length + i,
          row.title ?? '',
          row.pic,
          row.author,
          row.duration,
          1,
          row,
        )
      })
    })

    /**
     * 整包里带的 `selectedBvid` 一起落进 `song_meta`
     *
     * 这是规格里明确要求的（`save` 负责 result + selectedBvid 两件事）。
     * 新搜索结果通常不带这个字段，所以只有真的有值时才写；
     * **绝不写 null** —— 那会把「上次播的那个视频」抹掉，而 `save` 完全不涉及
     * 用户的选择，没道理顺手把它清了。
     */
    const selected = payload?.data?.selectedBvid
    if (typeof selected === 'string' && selected) {
      setSelectedBvid(keyword, selected)
    }

    return true
  } catch (err) {
    console.error('[cache] 写入缓存失败:', err)
    return false
  }
}

/**
 * 只更新一条视频的解析结果（地址列 + 展示字段）
 *
 * 为什么单独开一个函数，而不是让 `api:resolveVideo` 走「get 整包 -> 改一条 -> save」：
 *
 * 1. **避免互相覆盖**。解析要跑 view + playurl 两次网络往返（秒级），
 *    期间同一 keyword 上很可能还有别的事在发生（用户快速连点两个候选视频、
 *    预热与切歌重叠、`api:searchSong` 刚写了新结果）。旧实现为此在 save 前
 *    **重新读一次缓存再合并**，还只挑「本次真正动过的那一条」写回去 —— 那段代码
 *    存在的唯一理由就是「整包覆盖」这个存储形态。现在按主键更新一行，这个问题
 *    从根上没有了，那段容易写错的合并逻辑也就可以删掉。
 * 2. **不碰 `ord`**。整包 save 会按数组下标重写顺序，而解析地址跟「列表怎么排」
 *    毫无关系，不该有机会动它。
 *
 * ## 签名为什么和以前不一样
 *
 * 以前传的是 `viewResult` / `playurlResult` 两个**整包响应**（还存在
 * `video_details` 里）。schema v2 之后整包响应不再落库：这里直接从 `playurl`
 * 里**提取结构化列**写进 `videos` 那一行，`view` 响应除了展示字段本来也没有别的用途
 * （`cid` 用完即弃，playurl 才是要留的）。
 *
 * @param playurl 新解析出来的 playurl 响应（整包，来自 `resolveVideoUrl`）。
 *        传 `undefined` = 只更新 meta，**不碰任何地址列**。
 * @param playurlLoginState 这次解析时的登录态；`null` = 未知（表示**保留旧值**）。
 *        未知绝不能当成 false 写下去：那会让以后每次解析都判「缓存是未登录时取的、
 *        现已登录」→ 白重取一遍（用户看到的是「我明明登录着却老在重新解析」）。
 * @param noDash 这次解析是不是明确要求了 durl（dash 播放失败后的兜底）。
 * @param meta 这一行**还不在库里**时用来补插的展示字段。
 *        什么情况下会不在库里：`selectedBvid` 是历史选择，完全可能已经不在
 *        本次搜索结果里（下架 / 排序变化），而用户仍在续播它。
 *        旧实现的做法是把这条塞进结果数组再整包写回，效果一样；
 *        这里显式补插，并且顺带把 view 响应里的标题/封面填上 ——
 *        旧实现在这条路径上只写了地址，于是列表里出现一个没有标题、没有封面的
 *        空壳（那段「backfillFromView 自愈」的代码就是为了给这种坏数据擦屁股，
 *        现在从写入侧就不会产生了）。
 */
export const updateVideoResult = (
  cacheKey: string,
  bvid: string,
  playurl: unknown | undefined,
  playurlLoginState: boolean | null,
  noDash: boolean,
  meta?: { title?: string; pic?: string | null; author?: string | null; duration?: number | null },
): void => {
  if (!cacheKey || !bvid) return
  try {
    const db = getDb()
    const setPlayurl = playurl !== undefined
    tx(() => {
      const old = getVideoRow(cacheKey, bvid)

      /**
       * 地址列只在真的重新解析过时写；`extractPlayurlColumns` 是整包响应
       * 转结构化列的**唯一**实现（UPDATE 与 INSERT 两条路共用它，
       * 避免「一边存全量 dash、一边只存挑中的那条」这种查起来极痛苦的漂移）。
       */
      const cols = setPlayurl ? extractPlayurlColumns(playurl) : null

      /**
       * `dash_tried` 的语义是「**有没有试过** dash」，一旦试过就永久为 1：
       * `noDash=true` 的那次（dash 播不动、退回 durl）不能把它清回 0 ——
       * 清了的话下次解析又会去试一遍 dash，而它刚刚才失败过。
       * 反过来 `noDash=false` 且拿到了 dash，自然是 1。
       */
      const dashTried = setPlayurl ? (!noDash || (old?.dash_tried ?? 0) === 1 ? 1 : 0) : null
      /**
       * 登录态：`null`（这次没问到）**保留旧值**。
       * 旧行也没有时写 NULL 而不是 0 ——「未知」和「未登录」必须区分，
       * 理由见函数头注释。
       */
      const loginState =
        playurlLoginState === null
          ? (old?.playurl_login_state ?? null)
          : playurlLoginState
            ? 1
            : 0

      if (setPlayurl) {
        db.prepare(
          `UPDATE videos
              SET durl_url = ?, dash_video = ?, dash_audio = ?, dash_duration = ?,
                  playurl_login_state = ?, dash_tried = ?, playurl_at = ?
            WHERE search_key = ? AND bvid = ?`,
        ).run(
          cols!.durlUrl,
          cols!.dashVideo,
          cols!.dashAudio,
          cols!.dashDuration,
          loginState,
          dashTried,
          // 地址与时间是**一起**写的：只写地址会让下一轮清理把新地址当成老数据删掉
          Date.now(),
          cacheKey,
          bvid,
        )
      }

      /**
       * 保证 `videos` 里有这一行
       *
       * 不在库里 = 「正在播的视频不在候选列表里」（缓存被清了 / 该 bvid 不在本次
       * 搜索结果里）。补一行让它下次能直接命中缓存 —— 这正是「正在播的视频」应有的待遇。
       * `ord` 取当前最大值 + 1（排在候选列表最后），`favorites` 保持 0：
       * 「播过」不等于「收藏过」，不能顺手给用户加一个收藏。
       */
      if (old) {
        /**
         * 已存在：只补展示字段里「库里还是空的」那些。
         *
         * 不整体覆盖 title/pic —— `meta` 的封面来自 view 响应、标题来自搜索结果，
         * 而库里已有的那份同样是这两个来源写进去的，没必要互相盖。
         * 只在库里是空的时候补，避免把 `<em>` 高亮的标题盖成 view 的纯文本标题。
         */
        db.prepare(
          `UPDATE videos
              SET title = COALESCE(NULLIF(title, ''), ?),
                  pic = COALESCE(pic, ?),
                  author = COALESCE(author, ?),
                  duration = COALESCE(duration, ?)
            WHERE search_key = ? AND bvid = ?`,
        ).run(
          meta?.title ?? '',
          meta?.pic ?? null,
          meta?.author ?? null,
          meta?.duration ?? null,
          cacheKey,
          bvid,
        )
        return
      }

      db.prepare(
        `INSERT INTO videos
           (search_key, bvid, ord, title, pic, author, duration, favorites,
            durl_url, dash_video, dash_audio, dash_duration,
            playurl_login_state, dash_tried, playurl_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        cacheKey,
        bvid,
        maxOrdOf(cacheKey) + 1,
        meta?.title ?? '',
        meta?.pic ?? null,
        meta?.author ?? null,
        meta?.duration ?? null,
        // 地址列：这一行不在库里，第一次写就是「新解析出来的那份」
        cols?.durlUrl ?? null,
        cols?.dashVideo ?? null,
        cols?.dashAudio ?? null,
        cols?.dashDuration ?? null,
        loginState,
        dashTried ?? (!noDash ? 1 : 0),
        setPlayurl ? Date.now() : null,
      )
      console.log(`[cache] 已为「正在播但不在候选列表里」的视频补一条记录: ${bvid}`)
    })
  } catch (err) {
    console.error('[cache] 写入解析结果失败:', err)
  }
}

/**
 * 统计：视频条数 / 近似占用字节数
 *
 * 为什么是「近似」：SQLite 的实际占用要跑 `dbstat` 虚拟表（需要编译选项），
 * 代价高且不稳。而这里要回答的问题只是「缓存有多大、要不要清一下」，
 * 按地址相关列的字符数估算足够了（它们占了绝大部分体积，
 * 和旧实现相比统计口径从「文件大小」变成「JSON 文本长度」，量级一致）。
 *
 * 口径跟着 schema 演进：原来算的是 `playurl_result` + `view_result` 两个整包 JSON，
 * v2 起改算结构化列，v4 又去掉了 `support_formats`（那是静态映射，不该落库）。
 * 现在算 `durl_url` + `dash_video` + `dash_audio` 三列 —— `dash_*` 是完整数组，
 * 仍然是体积大头。
 *
 * `count` 的口径是**视频条数**，不是「关键词个数」—— 界面上写的是
 * 「N 个视频」，因为一条 dash 数组可能几十 KB，按关键词数看不出体积差异。
 */
export const getStats = (): CacheStats => {
  try {
    const count =
      (
        getDb().prepare(`SELECT COUNT(*) AS count FROM videos`).get() as
          | { count: number }
          | undefined
      )?.count ?? 0
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(durl_url)), 0)   AS durlBytes,
                COALESCE(SUM(LENGTH(dash_video)), 0) AS videoBytes,
                COALESCE(SUM(LENGTH(dash_audio)), 0) AS audioBytes
           FROM videos`,
      )
      .get() as
      | { durlBytes: number; videoBytes: number; audioBytes: number }
      | undefined
    const bytes = (row?.durlBytes ?? 0) + (row?.videoBytes ?? 0) + (row?.audioBytes ?? 0)
    return { count, bytes }
  } catch (err) {
    console.error('[cache] 统计失败:', err)
    return { count: 0, bytes: 0 }
  }
}

/**
 * 清理过期
 *
 * 「过期」现在只有一种含义：**播放直链过期**（元数据永不过期）。
 * 时长取设置里的 `cache.searchResultExpireMs`（0 = 永久，等于不清）。
 * 处理完成后顺手 `VACUUM` 不必做 —— 只更新字段不删行，不会产生大量碎片。
 */
export const prune = (): CacheStats => {
  const maxAge = Number(getSetting()['cache.searchResultExpireMs']) || 0
  clearExpiredPlayurl(maxAge)
  return getStats()
}

/**
 * 清空全部缓存（`videos` + `song_meta`）
 *
 * 语义就是「全部清除」：收藏、选中视频、播放地址一起没了。
 * 界面上那个按钮的文案也是「全部清除」，两边必须一致 ——
 * 用户点「全部清除」的预期就是回到干净状态。
 *
 * **只需要清两张表**：schema v2 把解析结果合回了 `videos`，`video_details` 已经删掉
 * （以前这里必须三张表一起清，只清 `videos` 会留下一堆没人引用的 `video_details`，
 * 磁盘占用并不会降下来 —— 而用户点这个按钮就是为了腾空间）。
 * `playlists` / `playlist_songs` **不在这里清**：那是歌单本身，不是缓存。
 */
export const clearAll = async (): Promise<boolean> => {
  try {
    const before = getStats().count
    tx(() => {
      const db = getDb()
      db.prepare(`DELETE FROM videos`).run()
      db.prepare(`DELETE FROM song_meta`).run()
    })
    console.log(`[cache] 已清空缓存（${before} 条视频记录 + 播放地址与选中记录）`)
    return true
  } catch (err) {
    console.error('[cache] 清空失败:', err)
    return false
  }
}

// #region 收藏 / 选中视频

/**
 * 收藏 / 取消收藏
 *
 * ## 收藏 → 置顶（用户明确要求）
 *
 * 实现：**其余所有条目的 `ord` 各 +1，自己占住 `ord = 0`**。
 * 不分「库里有没有这一行」两种情况 —— 要做的事本来就完全一样。
 *
 * 这样 `ord` 保持 **0..n-1 连续** 这个不变量。
 * ⚠️ 曾经用过「取当前最小值 - 1」，那会让 `ord` 变成负数且不连续，
 * 而且 `save()` 按下标从 0 重写，负数活不过一次重新搜索 —— 已废弃。
 *
 * ## 取消收藏 → **只把 `favorites` 置 0，位置不动**（同样是用户明确要求）
 *
 * 取消完它还在原地，不会突然跳回搜索结果中间。
 *
 * ## 该 bvid 不在 `videos` 里时（用户「添加视频」加了个搜索没搜到的）
 *
 * 也走同一套置顶：先给其余项 +1，再**新插一行** `ord = 0`。
 * 标题 / 封面 / 时长先留空，由 handler 里的 `upsertVideoMeta` 用
 * `api:parseVideo` 的结果补上。
 *
 * ## 事务
 *
 * 整个函数体在 `tx()` 里；写操作要么全成要么全回滚 —— 中途进程被杀
 * 不会留下「其他都 +1 了、自己还没置 0」的中间态（那会出现两个 `ord = 0`）。
 */
export const setFavorite = (cacheKey: string, bvid: string, favorite: boolean): void => {
  if (!cacheKey || !bvid) return
  try {
    tx(() => {
      const db = getDb()
      const existing = getVideoRow(cacheKey, bvid)

      /** ① 取消收藏：**只改标记，位置不动**（用户明确要求：不跳回搜索结果中间） */
      if (!favorite) {
        /** 库里没这一行就没什么可取消的（新行只可能是"添加视频"，必然已收藏） */
        if (!existing) return
        db.prepare(`UPDATE videos SET favorites = 0 WHERE search_key = ? AND bvid = ?`).run(
          cacheKey,
          bvid,
        )
        return
      }

      /** ② 已经收藏了，幂等（不动位置） */
      if (existing?.favorites === 1) return

      /**
       * ③ **收藏置顶** —— 不管这行在不在库里，都走同一套动作
       *
       * 「其他所有条目的 `ord` 各 +1，自己占住 `ord = 0`」。
       *
       * 为什么**不区分在不在**：两种情况要做的事本来就完全一样 ——
       * 置顶 = 把自己放第一位、其余整体后移一格。分两条路写只会写出两种行为：
       *
       * ```
       * 已有行 → 置 0、前面各 +1        （正确）
       * 新行   → 插到 max+1 = 末尾       （错误，与渲染层「添加后显示在第一位」相反）
       * ```
       *
       * ⚠️ 这里踩过：原来「库里没有这一行」的分支插到 `maxOrdOf + 1`（末尾），
       * 于是「添加视频」加进来的条目**界面上在第一、库里在最后** ——
       * 任何按 `ord` 重取列表的地方（收藏后刷新、切歌重搜）都会把它甩到末尾。
       *
       * ## 为什么是「+1 / 置 0」而不是「取最小值 -1」
       *
       * 递减方案会让 `ord` 变成负数且不连续（来回收藏几十次就到 -50），
       * `SELECT` 出来看不出「哪个是第几」；而且 `save()` 按下标从 0 重写，
       * 那些负数**活不过一次重新搜索**。`+1` 方案保持 `ord` 恒为 `0..n-1` 连续。
       *
       * ## 事务
       *
       * 整个 `setFavorite` 体都在 `tx()` 里，两条写操作同一事务：
       * 中途进程被杀 → SQLite 回滚，**不会**留下「其他都 +1 了、自己还没置 0」
       * 那种中间态（那会让列表里出现两个 `ord = 0`，顺序不确定）。
       * 已经在第一位时第一条命中 0 行、第二条置 0，整体幂等。
       */
      const bound = maxOrdOf(cacheKey) + 1
      db.prepare(`UPDATE videos SET ord = ord + 1 WHERE search_key = ? AND ord < ?`).run(
        cacheKey,
        bound,
      )

      if (existing) {
        /** 已有行：只改标记 + 挪位置（标题封面等原样保留） */
        db.prepare(
          `UPDATE videos SET favorites = 1, ord = 0 WHERE search_key = ? AND bvid = ?`,
        ).run(cacheKey, bvid)
      } else {
        /**
         * 库里没有这一行（「添加视频」加了个搜索没搜到的 BV 号）：
         * 在这里**新插一行**并把 `ord` 直接写成 0。
         *
         * 标题 / 封面 / 时长先留空 —— 调用方（`api:setFavorite`）会先用
         * `api:parseVideo` 拿到的信息调 `upsertVideoMeta` 补上。
         */
        db.prepare(
          `INSERT INTO videos (search_key, bvid, ord, title, pic, author, duration, favorites)
           VALUES (?, ?, 0, '', NULL, NULL, NULL, 1)`,
        ).run(cacheKey, bvid)
      }
    })
  } catch (err) {
    console.error('[cache] 设置收藏失败:', err)
  }
}

/**
 * 写入 / 更新一条视频的元数据（不改收藏标记、不改顺序、**不碰地址列**）
 *
 * 给「添加视频」用：用户粘贴的 BV 号可能不在搜索结果里，
 * 这时先把它插成一行（`favorites = 0`、`ord` 用当前最大值 + 1 = 暂时排末尾），
 * 紧接着 `setFavorite(..., true)` 会把它**置顶**。
 *
 * 为什么先插末尾再置顶、而不是一步到位插到 0：
 * 这个函数只管"把元数据写进去"，置顶是收藏语义、该由 `setFavorite` 决定 ——
 * 一个函数只做一件事（它也用于"更新已存在行的信息"，那时完全不该动顺序）。
 */
export const upsertVideoMeta = (
  cacheKey: string,
  video: { bvid: string; title?: string; pic?: string | null; author?: string | null; duration?: number | null },
): void => {
  if (!cacheKey || !video?.bvid) return
  try {
    tx(() => {
      const db = getDb()
      const existing = getVideoRow(cacheKey, video.bvid)
      const title = video.title || existing?.title || ''
      const pic = video.pic ?? existing?.pic ?? null
      const author = video.author ?? existing?.author ?? null
      const duration = video.duration ?? existing?.duration ?? null

      if (existing) {
        db.prepare(
          `UPDATE videos SET title = ?, pic = ?, author = ?, duration = ?
            WHERE search_key = ? AND bvid = ?`,
        ).run(title, pic, author, duration, cacheKey, video.bvid)
        return
      }

      db.prepare(
        `INSERT INTO videos
           (search_key, bvid, ord, title, pic, author, duration, favorites)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(cacheKey, video.bvid, maxOrdOf(cacheKey) + 1, title, pic, author, duration)
    })
  } catch (err) {
    console.error('[cache] 写入视频元数据失败:', err)
  }
}

/** 该歌收藏的 bvid 列表（按 ord 排序，第一个就是「最重要的」） */
export const getFavorites = (cacheKey: string): string[] => {
  if (!cacheKey) return []
  try {
    const rows = getDb()
      .prepare(
        `SELECT bvid FROM videos WHERE search_key = ? AND favorites = 1 ORDER BY ord ASC`,
      )
      .all(cacheKey) as Array<{ bvid: string }>
    return rows.map((r) => r.bvid)
  } catch (err) {
    console.error('[cache] 读取收藏失败:', err)
    return []
  }
}

/** 上次播的是哪个视频（没有记录就返回 null，调用方回落到搜索结果第一条） */
export const getSelectedBvid = (cacheKey: string): string | null => {
  if (!cacheKey) return null
  try {
    const row = getDb()
      .prepare(`SELECT selected_bvid FROM song_meta WHERE search_key = ?`)
      .get(cacheKey) as { selected_bvid: string | null } | undefined
    return row?.selected_bvid ?? null
  } catch (err) {
    console.error('[cache] 读取选中视频失败:', err)
    return null
  }
}

/**
 * 记录「这首歌上次播的是哪个视频」
 *
 * upsert 进 `song_meta`：这张表只有一行一歌，用 `ON CONFLICT ... DO UPDATE`
 * 比「先查再决定 insert/update」少一次往返，也不会有并发下的竞态。
 *
 * 注意**不碰 `search_login_state`**：那是「搜索结果是在什么登录态下取的」，
 * 与「用户选了哪个视频」毫无关系，顺手写一遍只会互相覆盖。
 */
export const setSelectedBvid = (cacheKey: string, bvid: string): void => {
  if (!cacheKey || !bvid) return
  try {
    getDb()
      .prepare(
        `INSERT INTO song_meta (search_key, selected_bvid, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(search_key) DO UPDATE SET
           selected_bvid = excluded.selected_bvid,
           updated_at    = excluded.updated_at`,
      )
      .run(cacheKey, bvid, Date.now())
  } catch (err) {
    console.error('[cache] 记录选中视频失败:', err)
  }
}

/**
 * 读「这份**搜索结果**是在什么登录态下取的」
 *
 * `null` = 未知（库里存 NULL）。**必须与 `false` 区分**：
 * 未登录时 B 站只返回部分结果，所以「已知未登录时搜的」可以据此判断
 * 「这份结果该重搜」；而「不知道当时登没登录」不能当成未登录，否则每次
 * 用这份缓存都会白重搜一遍。
 *
 * 刻意与 `videos.playurl_login_state` 分开：两者是不同时刻、不同请求的登录态快照 ——
 * 搜索可能几小时前就做了，而播放地址是刚刚解析的。合并成一个字段必然互相覆盖。
 */
export const getSearchLoginState = (cacheKey: string): boolean | null => {
  if (!cacheKey) return null
  try {
    const row = getDb()
      .prepare(`SELECT search_login_state FROM song_meta WHERE search_key = ?`)
      .get(cacheKey) as { search_login_state: number | null } | undefined
    if (!row || row.search_login_state === null) return null
    return row.search_login_state === 1
  } catch (err) {
    console.error('[cache] 读取搜索登录态失败:', err)
    return null
  }
}

/**
 * 记「这份搜索结果是在什么登录态下取的」
 *
 * `state === null`（这次没问到）时**不覆盖已有值**：未知不等于未登录，
 * 写进去会让「已知未登录时搜的」这个结论被一次网络抖动抹掉。
 * 旧值也没有时才落一个 NULL（表示确实不知道），行本身要建出来 ——
 * `song_meta` 那行还可能承载 `selected_bvid`，缺行不代表没数据。
 */
export const setSearchLoginState = (cacheKey: string, state: boolean | null): void => {
  if (!cacheKey) return
  try {
    const db = getDb()
    const existing = db
      .prepare(`SELECT search_login_state FROM song_meta WHERE search_key = ?`)
      .get(cacheKey) as { search_login_state: number | null } | undefined

    // 未知 + 已经有一行：什么都不做（连 updated_at 都不动，避免无意义的写盘）
    if (existing && state === null) return

    db.prepare(
      `INSERT INTO song_meta (search_key, search_login_state, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(search_key) DO UPDATE SET
         search_login_state = excluded.search_login_state,
         updated_at         = excluded.updated_at`,
    ).run(cacheKey, state === null ? null : state ? 1 : 0, Date.now())
  } catch (err) {
    console.error('[cache] 记录搜索登录态失败:', err)
  }
}

/**
 * 清理过期的播放地址
 *
 * **只把地址相关的列置 NULL，绝不删行**（用户明确要求）：
 * 行里还有标题、封面、收藏、顺序，这些永不过期。
 *
 * schema v2 之后「置 NULL」的清单就是**所有地址列**：
 * `durl_url` / `dash_video` / `dash_audio` / `dash_duration` / `playurl_at`。
 *
 * > ⚠️ 这里以前还列着 `quality` / `support_formats` 两列，但它们在 schema v4
 * > 就已经删掉了（durl 的清晰度改成从 URL 反推，档位表内置在 `constants`）——
 * > 属于**注释漂移**，以 SQL 为准。
 *
 * 但**刻意保留 `dash_tried` 和 `playurl_login_state`**：
 *  - `dash_tried` 不是地址，它是「试没试过」的记忆，清掉就失去了
 *    「试过但拿不到 dash，别反复重取」的保护 —— 每次过期清理之后又会去试一遍；
 *  - `playurl_login_state` 描述的也不是地址本身，而是**取地址时的账号权限**，
 *    这个结论不随时间过期（用户没退出登录，它就一直成立）。清了它，
 *    「登录后才该重取」的判断就会失效。
 *
 * `maxAgeMs <= 0` 表示「永不过期」，直接返回 —— 这是设置项 `cache.searchResultExpireMs`
 * 里 0 的约定（界面上显示成「永久」）。
 *
 * 另有一种「地址在、但没有 `playurl_at`」的数据：它的地址到底什么时候取的无人知道，
 * 所以**保守地一并清掉**，让下次播放时重新解析。这样处理是安全的：
 * 清掉的只是地址，重新解析回来就有正确的 `playurl_at` 了。
 */
export const clearExpiredPlayurl = (maxAgeMs: number): void => {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return
  try {
    const cutoff = Date.now() - maxAgeMs
    const result = getDb()
      .prepare(
        `UPDATE videos
            SET durl_url = NULL, dash_video = NULL, dash_audio = NULL,
                dash_duration = NULL, playurl_at = NULL
          WHERE (durl_url IS NOT NULL OR dash_video IS NOT NULL OR dash_audio IS NOT NULL
                 OR dash_duration IS NOT NULL)
            AND (playurl_at IS NULL OR playurl_at < ?)`,
      )
      .run(cutoff)
    const changed = Number(result.changes) || 0
    if (changed > 0) {
      console.log(`[cache] 已清理 ${changed} 条过期播放地址（元数据与收藏保留）`)
    }
  } catch (err) {
    console.error('[cache] 清理过期播放地址失败:', err)
  }
}

// #endregion
