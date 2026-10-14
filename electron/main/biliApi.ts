/**
 * B 站接口封装（主进程）
 *
 * 原为 electron/biliApi.js（CommonJS），迁移为 TS 并补上类型。
 * 逻辑保持与迁移前一致，未做行为改动。
 */
import { net, session } from 'electron'
import crypto from 'node:crypto'
import {
  AUDIO_QUALITY_OPTIONS,
  DEFAULT_AUDIO_ID,
  DEFAULT_VIDEO_QN,
  VIDEO_QUALITY_OPTIONS,
  findQualityOption,
} from '@common/constants'
import type { QualityOption } from '@common/constants'
import type { UserInfo } from '@common/types/ipc'

const SEARCH_API = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
const NAV_API = 'https://api.bilibili.com/x/web-interface/nav'
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view'
const PLAYURL_API = 'https://api.bilibili.com/x/player/wbi/playurl'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17,
  0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

/** B 站接口返回体的公共形状（字段很多，只声明用到的） */
interface BiliResponse {
  code: number
  message?: string
  data?: BiliResponseData
}

interface BiliPlayUrlItem {
  url: string
}

interface BiliResponseData {
  isLogin?: boolean
  face?: string
  uname?: string
  wbi_img?: { img_url?: string; sub_url?: string }
  cid?: number
  durl?: BiliPlayUrlItem[]
  dash?: { video?: Array<{ baseUrl: string }> }
  result?: unknown[]
  [key: string]: unknown
}

/** 搜索接口用到的参数表（键值都会被拼进 query） */
type QueryParams = Record<string, string | number>

let cachedMixinKey: string | null = null
let mixinKeyExpireAt = 0
let cachedUserInfo: UserInfo | null = null

/**
 * 登录态（来自 nav 接口的 `isLogin` 字段）
 *
 * `null` 表示「还不知道」——和 `false` 区分开：
 * 登录窗口刚登录完时，任何基于「已知未登录」的缓存判断都会做出错误结论，
 * 所以拿不准时必须去问一次接口，而不是沿用启动时那份过期的 nav 数据。
 */
let loginState: boolean | null = null
/** 上次成功拉到 nav 数据的时间，用于判断要不要重新确认登录态 */
let navFetchedAt = 0

/** nav 数据的保鲜期；超过就在需要判断登录态时重新拉一次 */
const NAV_TTL_MS = 60 * 1000

/** 上次 nav 请求失败的时间（失败退避用，避免风控期间每秒重试） */
let navFailedAt = 0
/** 失败后的退避窗口 */
const NAV_FAIL_BACKOFF_MS = 15 * 1000

async function getCookieString(): Promise<string> {
  try {
    const cookies = await session.defaultSession.cookies.get({})
    if (cookies.length === 0) return ''
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

const md5 = (str: string): string => crypto.createHash('md5').update(str).digest('hex')

const getMixinKey = (imgKey: string, subKey: string): string => {
  const raw = imgKey + subKey
  let result = ''
  for (let i = 0; i < 32; i++) {
    result += raw[MIXIN_KEY_ENC_TAB[i]]
  }
  return result
}

async function refreshNavData(): Promise<string | null> {
  try {
    const response = await net.fetch(NAV_API, {
      method: 'GET',
      headers: {
        // net.fetch 走的是 electron session，本身就会带上 cookie，
        // 这里补一个显式 Cookie 头只是为了兼容部分风控场景
        Cookie: await getCookieString(),
        'User-Agent': USER_AGENT,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json',
      },
    })
    const json = (await response.json()) as BiliResponse
    const imgUrl = json.data?.wbi_img?.img_url ?? ''
    const subUrl = json.data?.wbi_img?.sub_url ?? ''
    if (imgUrl && subUrl) {
      const imgKey = imgUrl.split('/').pop()?.split('.')[0] ?? ''
      const subKey = subUrl.split('/').pop()?.split('.')[0] ?? ''
      cachedMixinKey = getMixinKey(imgKey, subKey)
      mixinKeyExpireAt = Date.now() + 6 * 3600 * 1000
    }
    /**
     * 先看响应码，再认 `isLogin` —— 这一步是必须的
     *
     * 踩过：只看 `json.data?.isLogin`，任何「HTTP 200 但被风控/拦截」的响应
     * （`code` 为 -352 / -412 这类，`data` 直接是 null）都会被判成「明确未登录」，
     * 于是界面与托盘整体切成未登录，`resolveVideo` 还会把 `loginState: false`
     * 写进缓存条目 —— 之后每次解析都判「未登录时取的，现已登录」而成片重解析。
     * 真正该表达的是「这次没问到」（`null`），而不是「没登录」。
     *
     * -101 是「账号未登录」，那是**有效的**否定结论，按 isLogin 落定即可。
     */
    if (json.code !== 0 && json.code !== -101) {
      console.warn('[auth] nav 返回异常码，登录态保持不变:', json.code, json.message ?? '')
      // 只更新 wbi mixin key（上面已经算好），登录态留空表示「未知」
      loginState = null
      cachedUserInfo = null
      navFetchedAt = Date.now()
      return cachedMixinKey
    }

    if (json.data?.isLogin) {
      cachedUserInfo = {
        face: json.data.face ?? '',
        name: json.data.uname ?? '',
      }
    } else {
      cachedUserInfo = null
    }
    // 以接口返回的 isLogin 为唯一权威（cookie 存在 != 登录有效，可能已过期）
    loginState = !!json.data?.isLogin
    navFetchedAt = Date.now()
    return cachedMixinKey
  } catch {
    // 拉取失败时**不改**登录态：宁可保留上一次的结论，也不要被网络抖动带偏
    return null
  }
}

export const clearNavData = (): void => {
  cachedMixinKey = null
  mixinKeyExpireAt = 0
  cachedUserInfo = null
  loginState = null
  navFetchedAt = 0
}

/**
 * 确认当前登录态（必要时重新拉 nav）
 *
 * 判断「缓存里的播放地址还能不能用」之前必须过这一道：
 * 登录窗口刚登录完时 nav 缓存还是「未登录」，用旧状态判断会把
 * 「该重新解析成更高清晰度」误判成「缓存可用」。
 *
 * 返回值三种情况，**别把它当纯 boolean 用**：
 *  - `true`  / `false`：nav 明确给的结论；
 *  - `null`：这次没问到（网络抖动 / 风控 / 超时）—— 结论未知。
 *
 * 为什么要区分 `null`：以前这里返回 `loginState === true`，也就是「没问到 = 未登录」。
 * 启动时第一次解析如果正好赶上 nav 没问到，就会把 `loginState: false` 写进缓存，
 * 之后每次解析都判定「缓存是未登录时取的，现已登录」→ 无谓地重新解析一遍
 * （用户看到的就是「我明明没退出登录，怎么老在重新解析」）。
 */
export const ensureLoginState = async (): Promise<boolean | null> => {
  if (loginState !== null && Date.now() - navFetchedAt < NAV_TTL_MS) {
    return loginState
  }
  /**
   * 失败退避
   *
   * 登录窗口在轮询、每次解析也要问一次登录态；nav 一旦因为风控/断网失败，
   * 没有退避就是每秒一次的请求风暴（越打越像异常流量）。
   */
  if (navFailedAt && Date.now() - navFailedAt < NAV_FAIL_BACKOFF_MS) {
    return loginState
  }
  const before = navFetchedAt
  await refreshNavData()
  /**
   * 没更新 `navFetchedAt` 就说明**这次没问到**（refreshNavData 失败时不动状态）。
   * 这时候要返回 `null`（未知），而不是把上一次的结论当权威 ——
   * 「陈旧 true」会被写进缓存条目的登录态快照，「陈旧 false」会让界面无端变未登录。
   */
  if (navFetchedAt === before) {
    navFailedAt = Date.now()
    return null
  }
  navFailedAt = 0
  return loginState
}

const clearMixinKey = (): void => {
  cachedMixinKey = null
  mixinKeyExpireAt = 0
}

const getMixinKeyCached = async (): Promise<string | null> => {
  if (cachedMixinKey && Date.now() < mixinKeyExpireAt) return cachedMixinKey
  return refreshNavData()
}

/**
 * 取当前用户信息
 *
 * 失败分两种情况，**必须让调用方区分**（踩坑）：
 *  - nav 明确回了 `isLogin: false` → 真的没登录（`未登录`）；
 *  - nav 请求本身失败（网络抖动 / 风控 / 超时）→ 结论未知（`NAV_FAILED`）。
 *
 * 以前两种情况都抛「未登录」，渲染层就一律把界面切成未登录：托盘菜单显示「登录」、
 * 解析视频时按未登录档位取流并写进缓存，于是每次都要「重新解析」，
 * 明明登录着却像掉线一样。
 */
export const getUserInfo = async (): Promise<UserInfo> => {
  /**
   * `cachedUserInfo` 也要看 TTL
   *
   * 踩过：这里只判「有没有缓存」，于是 nav 数据可能是几天前的 —— 用户早就掉登录了，
   * 界面还拿着旧头像旧名字；反过来 nav 拿不到时又会被下面当成「未登录」。
   */
  if (cachedUserInfo && Date.now() - navFetchedAt < NAV_TTL_MS) return cachedUserInfo
  const state = await ensureLoginState()
  // 刷新失败但手里还有旧信息：继续用旧的，别误报未登录
  if (cachedUserInfo) return cachedUserInfo
  if (state === false) throw new Error('未登录')
  throw new Error('NAV_FAILED')
}

const encWbi = (params: QueryParams, mixinKey: string): string => {
  params.wts = Math.floor(Date.now() / 1000)
  const sorted = Object.keys(params)
    .sort()
    .reduce<QueryParams>((acc, key) => {
      acc[key] = params[key]
      return acc
    }, {})
  const query = Object.entries(sorted)
    .map(([k, v]) => {
      const val = String(v).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(val)}`
    })
    .join('&')
  const w_rid = md5(query + mixinKey)
  return `${query}&w_rid=${w_rid}`
}

const getQvId = (): string => {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let result = ''
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

const oldGetW_rid = (params: QueryParams): string => {
  const paramStr = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  return md5(paramStr + 'ea1db124af3c7062474693fa704f4ff8')
}

const buildSearchParams = (keyword: string, page = 1): QueryParams => ({
  __refresh__: 'true',
  _extra: '',
  ad_resource: '5654',
  category_id: '',
  context: '',
  from_source: '',
  from_spmid: '333.337',
  gaia_vtoken: '',
  highlight: '1',
  keyword,
  order: '',
  /** 页码（从 1 开始）—— 用户要求「结果太少就再查一页」 */
  page: String(page),
  page_size: '42',
  platform: 'pc',
  qv_id: getQvId(),
  search_type: 'video',
  single_column: '0',
  source_tag: '3',
  web_location: '1430654',
  wts: Math.floor(Date.now() / 1000).toString(),
})

async function biliHeaders(): Promise<Record<string, string>> {
  return {
    Cookie: await getCookieString(),
    'User-Agent': USER_AGENT,
    Referer: 'https://www.bilibili.com/',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

async function biliGet(url: string): Promise<BiliResponse> {
  const response = await net.fetch(url, {
    method: 'GET',
    headers: await biliHeaders(),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return (await response.json()) as BiliResponse
}

/** 播放地址提前多少毫秒算「即将过期」（留出解析与起播的时间） */
const URL_EXPIRE_MARGIN_MS = 5 * 60 * 1000

/**
 * 从 B 站播放地址里解析出过期时间戳（毫秒）
 *
 * B 站的视频直链是带签名时效的，常见形态：
 *   ...?deadline=1789929926&...
 *   ...?e=ig8eux...&deadline=...      （部分 CDN 把参数塞进 e= 里）
 * 取不到时返回 null，表示无法判断（按「未知」处理，不当作过期）。
 */
const getUrlDeadline = (url: string | null | undefined): number | null => {
  if (!url || typeof url !== 'string') return null

  const readFrom = (search: string): number | null => {
    // deadline 是秒级时间戳
    const m = /(?:^|[?&])deadline=(\d+)/.exec(search)
    return m ? Number(m[1]) * 1000 : null
  }

  try {
    const parsed = new URL(url)
    const direct = readFrom(parsed.search)
    if (direct) return direct
    // 有些 CDN 把参数整体放在 e= 里面，需要再解一层
    const e = parsed.searchParams.get('e')
    if (e) {
      try {
        const inner = Buffer.from(decodeURIComponent(e), 'base64').toString('utf8')
        const nested = readFrom(`?${inner}`)
        if (nested) return nested
      } catch {
        /* 不是 base64 就算了 */
      }
    }
  } catch {
    /* URL 非法 */
  }
  return null
}

/**
 * 判断播放地址是否还有效
 *
 * @returns true 表示可以继续用；false 表示已过期/即将过期，需要重新解析
 */
export const isUrlUsable = (url: string | null | undefined): boolean => {
  if (!url) return false
  const deadline = getUrlDeadline(url)
  if (deadline === null) return true // 拿不到时效信息时保守地认为可用
  return deadline - Date.now() > URL_EXPIRE_MARGIN_MS
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 视频时长与歌曲时长的容差（秒）
 *
 * **用户定的规则**：搜索出来的 MV 时长和歌单里那首歌的时长差超过 ±90 秒就丢掉 ——
 * 那多半不是同一首歌（可能是合集、live 全场、串烧）。
 *
 * 为什么是 90 秒：MV 常有前奏画面 / 片尾，比纯音频长十几秒很正常；
 * 而「不是同一首歌」的差距通常是几分钟（合集更夸张）。
 * 90 秒是这两者之间一个宽松但有效的分界。
 */
export const DURATION_TOLERANCE_SEC = 90

/**
 * 按「视频时长 vs 歌曲时长」过滤候选
 *
 * @param items 搜索结果里的视频条目
 * @param songDurationSec 歌单里那首歌的时长（秒）；**未知时不过滤**
 *        （宁可多留也不要因为拿不到时长而误杀）
 * @returns 过滤后的条目；`songDurationSec` 未知时原样返回
 */
export const filterByDuration = <T extends { duration?: string | number | null }>(
  items: T[],
  songDurationSec: number | null | undefined,
): T[] => {
  /** 歌曲时长未知就不过滤 —— 没有参照物时任何过滤都是瞎猜 */
  if (typeof songDurationSec !== 'number' || !Number.isFinite(songDurationSec) || songDurationSec <= 0) {
    return items
  }
  return items.filter((item) => {
    const sec = parseDurationToSeconds(item.duration)
    /** 视频时长解析不出来时**保留**它（同上：不因缺数据而误杀） */
    if (sec === null) return true
    return Math.abs(sec - songDurationSec) <= DURATION_TOLERANCE_SEC
  })
}

/**
 * 把 B 站的时长字段解析成秒
 *
 * B 站的搜索结果里 `duration` 是 **`"4:03"` 这样的字符串**（或 `"1:02:03"`）。
 * 这里独立实现一份（而不是复用 `@common/utils/duration`）是因为
 * **main/biliApi.ts 不该依赖 common 的工具函数**（那是渲染层共享的），
 * 而且这个解析只有十几行。
 */
export const parseDurationToSeconds = (
  raw: string | number | null | undefined,
): number | null => {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null
  const s = String(raw).trim()
  if (!s) return null
  /** 纯数字（秒） */
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n > 0 ? n : null
  }
  const parts = s.split(':').map((x) => Number(x))
  if (parts.some((n) => !Number.isFinite(n))) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return null
}

export async function searchSong(
  keyword: string,
  retryCount = 0,
  page = 1,
): Promise<BiliResponse> {
  const mixinKey = await getMixinKeyCached()

  if (mixinKey) {
    const params = buildSearchParams(keyword, page)
    params.tids = '3'
    const query = encWbi(params, mixinKey)
    const url = `${SEARCH_API}?${query}`
    try {
      return await biliGet(url)
    } catch (innerErr) {
      clearMixinKey()
      if (retryCount < 2) {
        await sleep(1000)
        return searchSong(keyword, retryCount + 1, page)
      }
      throw innerErr
    }
  }

  const params = buildSearchParams(keyword, page)
  /**
   * `tids` 必须**先**设好再算签名。
   *
   * 上面走 WBI 的分支就是先 `params.tids = '3'` 再 `encWbi(params, ...)`；
   * 这里原来顺序反了（先签名后加 tids），请求串里带了 tids 但 w_rid 没覆盖它，
   * 服务端按收到的参数重算就会对不上 —— 也就是「拿不到 mixin key 时搜索全挂」。
   */
  params.tids = '3'
  params.w_rid = oldGetW_rid(params)
  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const url = `${SEARCH_API}?${queryString}`

  try {
    return await biliGet(url)
  } catch (err) {
    if (retryCount < 2) {
      await sleep(1000)
      return searchSong(keyword, retryCount + 1, page)
    }
    throw err
  }
}

/**
 * 搜索结果里的一个视频条目（**只声明用到的字段**）
 *
 * 刻意不引 `cache.ts` 里那个内部类型：`biliApi` 是「取数据」的层，
 * 不该依赖缓存层的形状。搜索结果本来就带一堆额外字段，
 * 用索引签名接住即可。
 */
export interface SearchVideoItem {
  bvid?: string
  title?: string
  pic?: string
  author?: string
  duration?: number | string | null
  [key: string]: unknown
}

/**
 * 搜索结果最少要多少条才够用
 *
 * **用户定的规则**：过滤后**少于 30 条就再查一页**。
 * 因为时长过滤会砍掉一批候选（尤其在歌单时长和 MV 对不上的时候），
 * 只剩几条的话用户没得挑。
 */
export const MIN_SEARCH_RESULTS = 30

/**
 * 搜索 + 时长过滤 +「结果太少就再查一页」
 *
 * ## 流程（用户定的规则）
 *
 *  1. 搜第 1 页（B站每页 42 条）
 *  2. 按「视频时长 vs 歌曲时长 ±90 秒」过滤
 *  3. 过滤后**少于 30 条**就再查第 2 页，把两页合并（**去重后**）再过滤一次
 *
 * ## 为什么要「先过滤再判断够不够」
 *
 * 因为时长过滤是**真的会砍掉很多**的 —— 一首 4 分钟的歌，
 * 搜索结果里常混着「合集（2 小时）」「live 全场（1 小时）」。
 * 不滤的话看着有 42 条，实际能用的可能只有十来个。
 *
 * ## 关于「第二页」
 *
 * 只查一页追加（不循环到第 3 页）：B站的音乐搜索相关性排序，
 * 第 3 页以后基本是无关结果，再翻下去等于用噪声凑数。
 *
 * @param keyword 搜索词
 * @param songDurationSec 歌单里那首歌的时长（秒）；**未知则不过滤**
 */
export const searchSongFiltered = async (
  keyword: string,
  songDurationSec: number | null | undefined,
): Promise<{ items: SearchVideoItem[]; filteredOut: number; pages: number }> => {
  /** 从响应里取出视频条目（`result` 里可能混着番剧/专栏，只要 `type === 'video'`） */
  const extract = (res: BiliResponse): SearchVideoItem[] => {
    const list = res.data?.result
    if (!Array.isArray(list)) return []
    return (list as SearchVideoItem[]).filter(
      (item) => (item as { type?: string }).type === 'video',
    )
  }

  const first = await searchSong(keyword, 0, 1)
  if (first.code !== 0) throw new Error(first.message ?? '搜索失败')
  let all = extract(first)
  const firstFiltered = filterByDuration(all, songDurationSec)
  let filteredOut = all.length - firstFiltered.length
  let pages = 1

  if (firstFiltered.length < MIN_SEARCH_RESULTS) {
    /**
     * 结果偏少 → 再查一页。
     *
     * 第二页失败**不影响**已有结果（拿第 1 页的照样能用），
     * 所以单独 try 起来。
     */
    try {
      await sleep(600) // 稍微错开，避免触发风控
      const second = await searchSong(keyword, 0, 2)
      if (second.code === 0) {
        const more = extract(second)
        /** 按 bvid 去重：两页之间可能有重复条目 */
        const seen = new Set(all.map((x) => String(x.bvid ?? '')))
        const add = more.filter((x) => x.bvid && !seen.has(String(x.bvid)))
        all = [...all, ...add]
        pages = 2
        filteredOut = all.length - filterByDuration(all, songDurationSec).length
      }
    } catch (err) {
      console.warn('[search] 第 2 页失败（用第 1 页结果继续）:', err)
    }
  }

  return {
    items: filterByDuration(all, songDurationSec),
    filteredOut,
    pages,
  }
}

/**
 * 从 dash 的视频轨里挑一条
 *
 * 两条规则：
 *  1. 优先 H.264（`avc1`）—— MSE 兼容性最好，AV1 / HEVC 在部分机器上
 *     `MediaSource.isTypeSupported` 会返回 false；
 *  2. 挑「id 不超过期望档位里最高的那条」；若全都比期望高（比如只有 4K），
 *     挑最低的那条，别一上来就拉满。
 */
const pickDashVideo = (videos: DashItem[], preferred: number): DashItem => {
  const avc = videos.filter((v) => (v.codecs ?? '').startsWith('avc1'))
  const pool = avc.length > 0 ? avc : videos
  const withId = pool.filter((v) => typeof v.id === 'number')
  if (withId.length === 0) return pool[0]

  const notAbove = withId.filter((v) => (v.id as number) <= preferred)
  if (notAbove.length > 0) {
    return notAbove.reduce((a, b) => ((a.id as number) >= (b.id as number) ? a : b))
  }
  return withId.reduce((a, b) => ((a.id as number) <= (b.id as number) ? a : b))
}

/**
 * 从 dash 的音频轨里挑一条
 *
 * 优先 id 完全匹配；没有匹配就挑「带宽不超过期望档位、且最大」的那条，
 * 免得用户选了 64K 却因为响应里没有 30216 而悄悄拿到 192K。
 */
const pickDashAudio = (audios: DashItem[], preferred: number): DashItem => {
  const exact = audios.find((a) => a.id === preferred)
  if (exact) return exact
  const target = findQualityOption(AUDIO_QUALITY_OPTIONS, preferred)
  const others = audios.filter((a) => typeof a.bandwidth === 'number')
  if (!target || others.length === 0) return audios[0]
  // 用内置档位的 id（30280 之类）换算成大致带宽做上界
  const ceiling = target.id === 30280 ? 200000 : target.id === 30232 ? 140000 : 70000
  const notAbove = others.filter((a) => (a.bandwidth as number) <= ceiling)
  if (notAbove.length > 0) {
    return notAbove.reduce((a, b) => ((a.bandwidth as number) >= (b.bandwidth as number) ? a : b))
  }
  return others.reduce((a, b) => ((a.bandwidth as number) <= (b.bandwidth as number) ? a : b))
}

/** dash 里的一条流（字段名两套，下划线/驼峰都可能出现） */
interface DashItem {
  id?: number
  baseUrl?: string
  base_url?: string
  backupUrl?: string[]
  backup_url?: string[]
  mimeType?: string
  mime_type?: string
  codecs?: string
  width?: number
  height?: number
  bandwidth?: number
}

/**
 * dash 双轨信息
 *
 * **dash 的视频和音频是两条独立的流**，只给一条就会没有声音，
 * 所以必须两条一起给出，缺一条就当 dash 不可用。
 */
export interface DashStreams {
  videoUrl: string
  audioUrl: string
  /** SourceBuffer 用的 MIME，例如 `video/mp4; codecs="avc1.640032"` */
  videoMime: string
  audioMime: string
  /** dash 总时长（秒）：分片 MP4 的 mvhd 往往是 0，MSE 需要它来补 MediaSource.duration */
  duration: number | null
  /** 视频轨清晰度代码，便于排查 */
  videoId: number | null
  /** 音频流 id（例如 30280），便于展示 / 切换 */
  audioId: number | null
}

export interface ResolveVideoResult {
  /** 渐进式 mp4（durl）地址；走 dash 时为 null */
  videoUrl: string | null
  /** dash 双轨；只有 durl 可用时为 null */
  dash: DashStreams | null
  viewData: BiliResponse
  playData: BiliResponse
  /**
   * 视频的 `cid`
   *
   * 它**本来就要取**（拿 playurl 必须用），顺手带出来是为了让调用方
   * 能拿它去取 **AI 字幕**（歌词自动对齐要用）—— 这样不增加任何额外请求。
   */
  cid: number
}

/**
 * 常规 CDN 域
 *
 * B 站的 playurl 会给每条流一个 `baseUrl` + 若干 `backupUrl`。其中 `baseUrl`
 * 有时是 **P2P / 边缘节点**（实测见过 `*.mountaintoys.cn`、`*.szbdyd.com`），
 * 那种地址只对官方客户端有效，普通 HTTP 请求会被 **403** 拒掉 ——
 * 用户看到的现象就是「别的视频都能放，只有这一个怎么也放不出来」，而且不报任何错。
 */
const NORMAL_CDN_SUFFIXES = [
  '.bilivideo.com',
  '.bilivideo.cn',
  '.bilibili.com',
  '.hdslb.com',
  '.akamaized.net',
]

export const isNormalCdn = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return NORMAL_CDN_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
  } catch {
    return false
  }
}

/**
 * 从「主地址 + 备用地址」里挑一个可用的
 *
 * 优先常规 CDN 域；都不常规（或解析不出主机）就退回第一个 —— 有总比没有强。
 */
export const pickNormalCdnUrl = (
  primary: string | null | undefined,
  backups?: Array<string | null | undefined> | null,
): string | null => {
  const all = [primary, ...(backups ?? [])].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  )
  if (all.length === 0) return null
  return all.find((u) => isNormalCdn(u)) ?? all[0]
}

const dashUrlOf = (item: DashItem | undefined): string | null => {
  if (!item) return null
  return pickNormalCdnUrl(item.baseUrl || item.base_url, item.backupUrl ?? item.backup_url)
}

const dashMimeOf = (item: DashItem): string | null => {
  const type = item.mimeType || item.mime_type
  if (!type) return null
  return item.codecs ? `${type}; codecs="${item.codecs}"` : type
}

/**
 * 从 playurl 响应里取出 dash 双轨
 *
 * @param qn      期望视频清晰度（挑不超过它的最高档）
 * @param audioId 期望音频流 id（挑完全匹配，否则挑不超过它带宽里最高的）
 */
export const extractDashStreams = (
  playData: unknown,
  qn: number = DEFAULT_VIDEO_QN,
  audioId: number = DEFAULT_AUDIO_ID,
): DashStreams | null => {
  const data = (playData as { data?: Record<string, unknown> } | null | undefined)?.data
  const dash = data?.dash as
    | { duration?: number; video?: DashItem[]; audio?: DashItem[] }
    | undefined
  const videos = dash?.video
  const audios = dash?.audio
  if (!Array.isArray(videos) || videos.length === 0) return null
  if (!Array.isArray(audios) || audios.length === 0) return null

  const video = pickDashVideo(videos, qn)
  const audio = pickDashAudio(audios, audioId)

  const videoUrl = dashUrlOf(video)
  const audioUrl = dashUrlOf(audio)
  const videoMime = dashMimeOf(video)
  const audioMime = dashMimeOf(audio)
  if (!videoUrl || !audioUrl || !videoMime || !audioMime) return null

  return {
    videoUrl,
    audioUrl,
    videoMime,
    audioMime,
    duration: typeof dash?.duration === 'number' ? dash.duration : null,
    videoId: typeof video?.id === 'number' ? video.id : null,
    audioId: typeof audio?.id === 'number' ? audio.id : null,
  }
}

/** 音频轨的展示名：优先查内置档位表，查不到就按带宽凑一个 */
const audioLabelOf = (item: DashItem): string => {
  const known = typeof item.id === 'number' ? findQualityOption(AUDIO_QUALITY_OPTIONS, item.id) : undefined
  if (known) return known.label
  if (typeof item.bandwidth === 'number' && item.bandwidth > 0) {
    return `${Math.round(item.bandwidth / 1000)}K`
  }
  return typeof item.id === 'number' ? String(item.id) : '未知'
}

/**
 * 读出「这个视频当前可选的清晰度 / 音质」
 *
 * **只列响应里真正能拿到的档位**，不铺静态全表：
 *  - 有 dash 时以 `dash.video[]` 为准 —— 那才是实际能播的流。
 *    **按 id 分 URL，没有 URL 就放不出来**，所以它比 `accept_quality`
 *    （只说明账号有权限，durl 通道可能给不了，实测列出 1080P 却只回 720P）权威得多；
 *  - 音质来自 `dash.audio[]`。
 *  - 展示名一律走 `@common/constants` 的内置档位表（覆盖全部 12 档）。
 *    **不再读响应里的 `support_formats`** —— schema v4 认为那是静态映射、
 *    每行存一份纯属冗余，所以库里也不再有它。
 *
 * 因此**没有 dash 时这个列表就是空的**（那是 durl 兜底通道，只有一条流、
 * 没什么可切）—— 这是刻意的：宁可菜单空着，也不要列出切不过去的档位。
 *
 * 注意：这里**不按设置里的上限裁剪**。
 * 设置页那个上限管的是「自动播放时最高选到哪一档」，
 * 而这个菜单是用户手动临时切换用的，得能看到全部可用档位。
 */
export const readQualityOptions = (
  playData: unknown,
): { video: QualityOption[]; audio: QualityOption[] } | null => {
  const data = (playData as { data?: Record<string, unknown> } | null | undefined)?.data
  if (!data) return null

  const dash = data.dash as { video?: DashItem[]; audio?: DashItem[] } | undefined
  const dashVideoIds = Array.isArray(dash?.video)
    ? dash.video.map((v) => v.id).filter((id): id is number => typeof id === 'number')
    : []

  const video: QualityOption[] = dashVideoIds
    .map((id) => {
      const known = findQualityOption(VIDEO_QUALITY_OPTIONS, id)
      const label = known?.label || String(id)
      return { id, label, description: known?.description || label }
    })
    // 去重后按档位从高到低
    .filter((o, i, arr) => arr.findIndex((x) => x.id === o.id) === i)
    .sort((a, b) => b.id - a.id)

  const audio: QualityOption[] = Array.isArray(dash?.audio)
    ? dash.audio
        .filter((a) => typeof a.id === 'number')
        .map((a) => {
          const known = findQualityOption(AUDIO_QUALITY_OPTIONS, a.id as number)
          const label = audioLabelOf(a)
          return {
            id: a.id as number,
            label,
            description: known?.description ?? `${label} 音质`,
          }
        })
        .sort((a, b) => b.id - a.id)
    : []

  if (video.length === 0 && audio.length === 0) return null
  return { video, audio }
}

/**
 * 请求 playurl：先用 wbi 签名接口，失败再退回老接口
 *
 * @returns code 为 0 的响应；两个接口都没给出数据时返回 null
 * @throws Error('AUTH_FAILED') 未登录 / 权限不足（调用方需要提示重新登录）
 */
const requestPlayUrl = async (
  bvid: string,
  cid: number,
  mixinKey: string | null,
  extra: QueryParams,
): Promise<BiliResponse | null> => {
  const params: QueryParams = { bvid, cid, fnver: 0, fourk: 1, ...extra }

  if (mixinKey) {
    try {
      const query = encWbi({ ...params }, mixinKey)
      const res = await biliGet(`${PLAYURL_API}?${query}`)
      if (res.code === 0) return res
      if (res.code === -101 || res.code === -403) throw new Error('AUTH_FAILED')
    } catch (err) {
      if (err instanceof Error && err.message === 'AUTH_FAILED') throw err
      // 签名失效：清掉 mixin key，让下次重新拉
      clearMixinKey()
    }
  }

  const legacy: QueryParams = { ...params }
  legacy.w_rid = oldGetW_rid(legacy)
  const qs = Object.entries(legacy)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const res2 = await biliGet(`https://api.bilibili.com/x/player/playurl?${qs}`)
  if (res2.code !== 0) {
    if (res2.code === -101 || res2.code === -403) throw new Error('AUTH_FAILED')
    return null
  }
  return res2
}

/**
 * 从响应里取第一条 durl 地址
 *
 * 同样优先常规 CDN 域：`url` 可能是 P2P 节点（403），而 `backup_url` 是正常 CDN。
 */
const firstDurl = (res: BiliResponse | null): string | null => {
  const durl = (
    res?.data as
      | { durl?: Array<{ url?: string; backup_url?: string[]; backupUrl?: string[] }> }
      | undefined
  )?.durl
  const first = durl?.[0]
  if (!first) return null
  return pickNormalCdnUrl(first.url, first.backup_url ?? first.backupUrl)
}

/**
 * 从一段文本里抠出 BV 号
 *
 * 用户可能直接粘 BV 号，也可能粘整段分享文案（含标题、短链、?p=2 之类），
 * 所以先找 BV 号；找不到再把文本当链接去跟随跳转（b23.tv 短链）。
 */
const BV_PATTERN = /BV[0-9A-Za-z]{10}/

/**
 * 跟随短链拿到最终 URL（b23.tv -> www.bilibili.com/video/BVxxx）
 *
 * `net.fetch` 默认跟 302，这里只关心最终地址里的 BV 号，所以拿到 response.url 就够，
 * 不必读 body（省流量，也避免大页面解析）。
 */
const followShortLink = async (input: string): Promise<string | null> => {
  const url = input.match(/https?:\/\/\S+/)?.[0]
  if (!url) return null
  try {
    const res = await net.fetch(url, {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': USER_AGENT },
    })
    return res.url || null
  } catch {
    return null
  }
}

/** 解析出来的一条视频信息（「添加视频」弹窗预览用；类型定义在 common/types/ipc） */
import type { ParsedVideoInfo } from '@common/types/ipc'
export type { ParsedVideoInfo }

/**
 * 解析用户输入的「B 站视频链接 / BV 号」，取回标题、封面、UP 主
 *
 * 只在「添加视频」里用：先尽量从文本里抠 BV 号，抠不到就跟随短链，
 * 再拿 view 接口把展示需要的信息取齐。
 */
export const parseVideoInput = async (input: string): Promise<ParsedVideoInfo> => {
  const text = String(input ?? '').trim()
  if (!text) throw new Error('请先粘贴视频链接或 BV 号')

  let bvid = text.match(BV_PATTERN)?.[0] ?? ''
  if (!bvid) {
    const finalUrl = await followShortLink(text)
    bvid = finalUrl?.match(BV_PATTERN)?.[0] ?? ''
  }
  if (!bvid) throw new Error('没有识别出 BV 号，请粘贴 B 站视频链接或 BV 号')

  const view = await biliGet(`${VIEW_API}?bvid=${bvid}`)
  if (view.code !== 0) throw new Error(view.message ?? '获取视频信息失败')
  const data = view.data as
    | { title?: string; pic?: string; owner?: { name?: string }; duration?: number }
    | undefined
  return {
    bvid,
    title: typeof data?.title === 'string' ? data.title : '',
    pic: typeof data?.pic === 'string' ? data.pic : null,
    author: typeof data?.owner?.name === 'string' ? data.owner.name : null,
    duration: typeof data?.duration === 'number' ? data.duration : null,
  }
}

export async function resolveVideoUrl(
  bvid: string,
  options: { noDash?: boolean; qn?: number; audioId?: number } = {},
): Promise<ResolveVideoResult> {
  const qn = options.qn ?? DEFAULT_VIDEO_QN
  const audioId = options.audioId ?? DEFAULT_AUDIO_ID
  const viewData = await biliGet(`${VIEW_API}?bvid=${bvid}`)
  if (viewData.code !== 0) {
    throw new Error(viewData.message ?? '获取视频信息失败')
  }
  const cid = viewData.data?.cid
  if (!cid) {
    throw new Error('无法获取视频CID')
  }

  const mixinKey = await getMixinKeyCached()

  /**
   * 优先 dash。
   *
   * 实测 `fnval: 1`（渐进式 mp4 / durl）**这条通道封顶 720P** ——
   * 请求 qn 填 80 / 116 / 120 都一样，`quality` 恒定回 64。
   * 1080P / 4K 只存在于 dash 里（视频轨 `id: 80` = 1920x1080），
   * 而 dash 的音视频是分开的，需要渲染层用 MSE 合成。
   */
  if (!options.noDash) {
    const dashData = await requestPlayUrl(bvid, cid, mixinKey, {
      qn,
      fnval: 16,
    }).catch((err) => {
      // dash 这一路失败不致命，交给下面的 durl 兜底；只有鉴权问题才向上抛
      if (err instanceof Error && err.message === 'AUTH_FAILED') throw err
      console.warn('[video] dash 请求失败，退回 durl：', err)
      return null
    })
    const dash = extractDashStreams(dashData, qn, audioId)
    if (dash && dashData) {
      return { videoUrl: null, dash, viewData, playData: dashData, cid }
    }
  }

  // durl 兜底（720P，音视频混流，拖动进度最省事）
  const durlData = await requestPlayUrl(bvid, cid, mixinKey, {
    qn: 80,
    fnval: 1,
    platform: 'html5',
    high_quality: 1,
  })
  const durl = firstDurl(durlData)
  if (durl && durlData) {
    return { videoUrl: durl, dash: null, viewData, playData: durlData, cid }
  }

  throw new Error('无法获取视频地址')
}

/**
 * 当前是否已登录（**走缓存**，不额外打接口）
 *
 * `ensureLoginState` 自己会缓存登录态（`loginState` 变量），
 * 所以这里只是给它一个更直白的名字给业务代码用。
 */
export const isLoggedIn = async (): Promise<boolean> => (await ensureLoginState()) === true
