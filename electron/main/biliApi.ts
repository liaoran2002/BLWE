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
import { rankVideos, baseSongName, splitSongName } from '@common/utils/videoRank'
import { durationToSeconds } from '@common/utils/duration'

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

/**
 * ★ **被风控**时抛出的专用错误
 *
 * B站的风控返回的是 **HTTP 412**（「请求被拦截」，响应体是一整页 HTML
 * 而不是 JSON）。它和「网络断了 / 接口抽风」是**完全不同**的性质：
 *
 *  - 网络错误：等一下重试是合理的；
 *  - **风控 412**：再发请求只会让封禁时间更长 —— 必须**立刻停手**，
 *    并且让用户知道「暂时搜不到，等一下」，而不是傻等着重试。
 *
 * 所以单独定义这个错误类型，让上层能一眼分辨。
 *
 * ## ⚠️ `message` 用**中性措辞**（`RATE_LIMIT_MESSAGE`）
 *
 * 这个 message 可能经 `errMsg(err)` 漏到界面上（用户能截图）——
 * 里面**不能**出现「风控」「限流」「412」这类词。
 * 所以它只表达「现象 + 怎么办」，识别靠**类型**（`instanceof`）而不是靠文案。
 */
export const RATE_LIMIT_MESSAGE =
  '暂时搜不到结果，通常是操作太频繁导致的，请稍等一会儿再试'

export class RateLimitError extends Error {
  constructor(message = RATE_LIMIT_MESSAGE) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/**
 * 判断一个错误是不是「被风控」
 *
 * ⚠️ 只认**类型**（`instanceof`）+ 主进程自己写的那个 message，
 * 不要在这里匹配「风控 / 412」之类的词 —— 那些词不会出现在 message 里了。
 */
export const isRateLimitError = (err: unknown): boolean =>
  err instanceof RateLimitError ||
  (err instanceof Error && err.message === RATE_LIMIT_MESSAGE)

async function biliGet(url: string): Promise<BiliResponse> {
  const response = await net.fetch(url, {
    method: 'GET',
    headers: await biliHeaders(),
  })
  /**
   * 412 = 风控拦截（响应体是 HTML 拦截页，不是 JSON）—— 单独识别
   *
   * 其它非 2xx（500/502/超时等）当作普通网络错误，交上层决定。
   */
  if (response.status === 412) {
    throw new RateLimitError()
  }
  /**
   * ⚠️ **不要把 `HTTP xxx` 原文抛给用户**（会经 `errMsg` 显示在界面上）
   *
   * 用户看不懂状态码。所以这里抛一句人话，**真实状态码只打日志**（排查用）。
   */
  if (!response.ok) {
    console.warn(`[bili] 请求失败，HTTP ${response.status}: ${url.slice(0, 120)}`)
    throw new Error('网络请求失败，请稍后再试')
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
 * ⚠️ **时长过滤已经搬到 `@common/utils/videoRank` 了**
 *
 * 原来这里有 `DURATION_TOLERANCE_SEC` / `filterByDuration` / `parseDurationToSeconds`
 * 三件套。新的排序方案把「硬过滤（含时长）→ 分层 → 排序」收在一个地方，
 * 于是时长判断也必须跟着走 —— 否则「过滤」和「排序」会用两套规则，
 * 出现「排序认为该留、过滤已经扔掉」这种自相矛盾。
 *
 * 这里只保留**搜索 + 翻页**（网络部分），过滤与打分的判据全部由 `videoRank` 决定。
 */

/**
 * B站搜索分区代码（`tids`）
 *
 *  - `''` / `'0'`  → **全站**搜索（不限制分区，音乐视频可能发在任意区）
 *  - `'3'`        → **音乐**区
 *
 * 为什么两种都要试：音乐区里大多是"正经 MV / 官方投稿"，但**翻唱、饭制、
 * 动态歌词排版**这类常发在别的区（生活 / 鬼畜 / 影视）。只搜音乐区会漏掉它们，
 * 只搜全站又容易被无关视频淹没 —— 所以**各搜一轮，取并集**。
 */
const TIDS_ALL = ''
const TIDS_MUSIC = '3'

/**
 * 两次搜索请求之间**强制**的间隔（毫秒）
 *
 * ## 为什么必须有
 *
 * 一首歌要搜 4 轮（全站 / 音乐区 / MV / 括号内容），每次切歌就是 4 个请求；
 * 用户连点几首就是十几个请求打出去 —— B站**很快就返回 412 风控**。
 *
 * 实测（用最朴素的裸请求验证过）：同一个 IP 前后两个请求，
 * 一个正常返回 200、下一个直接 412。**请求密度**就是触发条件。
 *
 * 500ms 是「用户几乎无感、但足以显著降低被拦概率」的折中：
 * 一整首歌 4 轮 ≈ 1.5 秒额外等待，而切歌本来就要等解析地址。
 */
const SEARCH_THROTTLE_MS = 500

/** 上一次真正发出搜索请求的时间戳（模块级，跨调用共享） */
let lastSearchAt = 0

/**
 * 遵守节流：距上次请求不足 `SEARCH_THROTTLE_MS` 就等够再走
 *
 * 放在**发请求之前**调用，所以「第一个请求」不需要等（`lastSearchAt` 初值 0）。
 */
const throttleSearch = async (): Promise<void> => {
  const wait = lastSearchAt + SEARCH_THROTTLE_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastSearchAt = Date.now()
}

/**
 * 搜 B站（**单次请求**，不含降级逻辑）
 *
 * ## ★ 没有重试（这是刻意的）
 *
 * 原来失败会递归重试 2 次（各等 1 秒）。那是**有害**的：
 *  - 风控 412 时重试只会加重封禁 —— B站要的是「停下来」；
 *  - 真网络错误时，上层（渲染层）本来就会重搜，重试是重复劳动；
 *  - 一首歌 4 轮 × 每轮重试 2 次 = 最坏 12 个请求，正是被风控的元凶。
 *
 * 现在**单次尝试，失败就抛**（`RateLimitError` 单独标记 412），
 * 由上层决定「是提示用户别切太快，还是当作网络错误重搜」。
 *
 * ## ★ 也**不翻页**（`page` 参数保留但调用方只传 1）
 *
 * 翻页会成倍放大请求数。四轮降级本来就覆盖了「换词再找」的需求，
 * 再叠加翻页就太密了。
 *
 * @param keyword 搜索词
 * @param page 页码（**调用方只传 1**；保留参数是为了签名与可读性）
 * @param tids 分区代码；**缺省 = 全站**（`''` 时不会往请求里塞 `tids`）
 */
export async function searchSong(
  keyword: string,
  page = 1,
  tids: string = TIDS_ALL,
): Promise<BiliResponse> {
  /** 节流：与上一个请求至少隔 `SEARCH_THROTTLE_MS` */
  await throttleSearch()

  const mixinKey = await getMixinKeyCached()

  if (mixinKey) {
    const params = buildSearchParams(keyword, page)
    /**
     * `tids` 必须在**算签名之前**设好
     *
     * WBI 签名覆盖所有参数。先签名后改参数 → 请求串里带了 `tids` 但 `w_rid`
     * 没覆盖它 → 服务端重算对不上 → 风控拒绝（踩过：改了 tids 之后搜索全挂）。
     */
    if (tids) params.tids = tids
    const query = encWbi(params, mixinKey)
    const url = `${SEARCH_API}?${query}`
    try {
      return await biliGet(url)
    } catch (err) {
      /**
       * WBI 签名失效（mixin key 过期）时清掉缓存，让**下一次**调用重新拉 key
       *
       * ⚠️ 但**不在这里重试** —— 见上面「没有重试」那段。
       * 风控 412 直接往上抛，绝不能重发。
       */
      if (!isRateLimitError(err)) clearMixinKey()
      throw err
    }
  }

  const params = buildSearchParams(keyword, page)
  /** 同上：**先**设 tids 再算签名 */
  if (tids) params.tids = tids
  params.w_rid = oldGetW_rid(params)
  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const url = `${SEARCH_API}?${queryString}`

  return biliGet(url)
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
  /**
   * 时长**秒数**（`extract` 里已经把 B 站的 `"4:03"` 转成秒）
   *
   * `null` / 缺省 = 时长未知（过滤时这种会被保留，不因缺数据而误杀）。
   */
  duration?: number | null
  [key: string]: unknown
}

/**
 * ★ **搜索降级流程**（用户定的四轮）
 *
 * | 轮 | 搜索词 | 分区（tids） |
 * | :--- | :--- | :--- |
 * | 1 | `歌名 歌手` | **全站**（不给 / `0`）|
 * | 2 | `歌名 歌手` | **音乐区**（`3`）|
 * | 3 | `歌名 歌手 MV` | 音乐区 |
 * | 4 | `歌名 歌手 <括号内容>`；没括号则 `歌名 歌手 可视化` | 音乐区 |
 *
 * ## 形态约定
 *
 * **不带引号、不带书名号**，纯空格分隔（用户明确要求）。
 * 用空格就是普通的「与」语义，几个词都要命中。
 *
 * ## ⚠️ 不要用 `-`
 *
 * B站搜索把 `-` 当**排除语法**（"A -B" = 搜 A 并排除含 B 的结果）——
 * 写成 `歌名 - 歌手` 会变成「搜歌名、**排除**这个歌手」，正好和意图相反。
 *
 * ## 为什么前两轮搜同一句话、只换分区
 *
 * 音乐区（`tids=3`）里是"正经 MV / 官方投稿"，但**翻唱、饭制、
 * 动态歌词排版**这类常发在别的区。只搜音乐区会漏掉它们，
 * 只搜全站又容易被无关视频淹没 —— 所以**各搜一轮，取并集**。
 *
 * ## 为什么第 4 轮用「括号里的内容」
 *
 * 括号里往往是**副标题**（`九重楼 (不敢独上九重楼)`）或版本说明。
 * 拿它当独立关键词搜一次，能捞到标题里只写副标题、不写正名的视频。
 * 没有括号时退回 `可视化`（覆盖「动态歌词排版 / 可视化」这类标题）。
 */
/** 最后一级在歌名**没有括号**时用的兜底后缀 */
const LAST_FALLBACK_SUFFIX = '可视化'

/**
 * 拼搜索词：`歌名 歌手`
 *
 * ## 形态（用户定的）
 *
 *  - **不带引号、不带书名号**，纯空格分隔
 *  - 歌手拼在后面（空则不拼，只留歌名）
 *
 * ```
 * buildPrimaryKeyword('修炼爱情', '林俊杰')  →  修炼爱情 林俊杰
 * buildPrimaryKeyword('晴天', '')            →  晴天
 * ```
 *
 * @param songName 歌名
 * @param singer   歌手名；空则不拼
 */
export const buildPrimaryKeyword = (songName: string, singer: string): string => {
  const parts = [songName.trim()]
  const a = singer.trim()
  if (a) parts.push(a)
  return parts.join(' ').trim()
}

/**
 * 拼「降级轮」搜索词：`歌名 歌手 <后缀>`
 *
 * ⚠️ 与主搜索词的区别只有**末尾多的那个后缀** —— 歌手**要带上**
 * （早期版本刻意不带歌手，但实测带着更准：`歌名 MV` 会搜出一堆
 * 同名不同歌的合集，带上歌手能显著收窄）。
 */
export const buildFallbackKeyword = (
  songName: string,
  singer: string,
  suffix: string,
): string => {
  const parts = [songName.trim()]
  const a = singer.trim()
  if (a) parts.push(a)
  parts.push(suffix.trim())
  return parts.join(' ').trim()
}

/*
 * 这里**没有** `bracketContentOf`（已删）。
 *
 * 它原来只取「括号里的内容」，现在由 `@common/utils/videoRank` 的
 * `splitSongName().tail` 承担 —— 那个会取**括号及其之后的全部内容**
 * （例如 `溯(Reverse)feat.马吟吟` → `Reverse feat.马吟吟`），
 * 比只取括号内更完整。而且它和「歌名的提取」**在同一个函数里**，
 * 两者天然互补（名字 + 尾巴 = 原串的全部信息），不会各算各的。
 */

/**
 * 搜索流程里**一轮**的原始结果（dev dump / 排查用）
 *
 * 「一轮」= 用一个搜索词 + 一个分区搜一次（含它内部的翻页）。
 * 降级是**多轮**：`歌名 歌手`（全站）→ `歌名 歌手`（音乐区）→ 加 `MV` → 加括号部分。
 */
export interface SearchRoundDetail {
  /** 这一轮发给 B 站的完整搜索词 */
  keyword: string
  /** 这一轮用的分区代码（`''` = 全站，`'3'` = 音乐区） */
  tids: string
  /** 降级后缀；主搜索词那轮是 `null` */
  suffix: string | null
  /** 这一轮是否放宽了时长上限（降级轮是 `true`） */
  relaxed: boolean
  /** 这一轮采了几页 */
  pages: number
  /** ★ 这一轮**原样**的结果（还没跟别的轮次去重） */
  items: SearchVideoItem[]
  /** 是不是降级轮（`false` = 主搜索词） */
  isFallback: boolean
}

/**
 * 搜索 + **降级重搜**
 *
 * ## 流程（四轮，见下面 `plan` 处的详细表格）
 *
 *  1. `歌名 歌手`，**全站**（不给 tids）→ 第 1 页，不够再查第 2 页；
 *  2. `歌名 歌手`，**音乐区**（`tids=3`）→ 同样「一页不够就两页」；
 *  3. `歌名 歌手 MV` → 同上；
 *  4. `歌名 歌手 <括号内容>`（没括号则 `可视化`）→ 同上。
 *
 * 每轮结果**累加**（按 bvid 去重），不是替换。
 * 每轮之前都会判「过滤后够不够 `minResults`」，够了就不再往下走。
 *
 * ## ⚠️ 这里的过滤判据与调用方**完全一致**
 *
 * 「够不够」用的是 `rankVideos` 那一套（歌名 + 屏蔽词 + 时长），
 * 不是只做时长 —— 否则数字虚高，降级永远不触发（踩过）。
 * 它需要 `filterKeywords` / `tagBonus`，所以由调用方从设置里读好传进来
 * （这个函数是纯网络层，不依赖 setting 模块）。
 *
 * @param song 歌名（**纯歌名**，不含歌手）
 * @param singer 歌手（空串 = 未知）；与歌名**分开传**，不再拼成 `歌名-歌手` 再拆
 * @param songDurationSec 歌曲时长（秒）；**未知则不做时长过滤**
 * @param minResults 过滤后少于它就开始补齐/降级；`0` = 不补齐、不降级
 * @param toleranceSec 时长容差（秒）
 * @param filterKeywords 命中即丢的关键词（设置项 `player.filterKeywords`）
 *        —— **必须传**，否则「够不够」会按一个虚高的数字判断（见下）
 * @param tagBonus 关键词加权表（设置项 `player.tagBonus`）；只影响排序，不影响条数
 */
export const searchSongFiltered = async (
  song: string,
  singer: string,
  songDurationSec: number | null | undefined,
  minResults: number,
  toleranceSec: number,
  filterKeywords: string[],
  tagBonus: Record<string, string[]>,
  /**
   * **已经取到的第 1 页响应**（可选）
   *
   * 调用方（`api:searchSong`）为了「搜索失败要能抛错」先调了一次
   * `searchSong(主搜索词)`，那个响应的 `result` 就是第 1 页。
   * 传进来就能**省掉一次网络往返**（一次完整的 WBI 签名 + 请求）。
   *
   * ⚠️ 复用它的前提是**调用方用的搜索词与本函数的第一级搜索词一致** ——
   * 两边都走 `buildPrimaryKeyword`，所以是一致的。
   *
   * 不传则自己搜第 1 页（保持这个函数能独立使用）。
   */
  firstPage?: BiliResponse,
): Promise<{
  items: SearchVideoItem[]
  /** 采了几页 */
  pages: number
  /** 走了几轮（1 = 没降级） */
  rounds: number
  /**
   * ★ 这份结果是否**按放宽后的时长上限**取的
   *
   * 降级轮次会放宽（`容差 × 1.7`）。调用方做**精确过滤**（`rankVideos`）时
   * 必须传同样的 `relaxUpperBound`，否则会出现
   * 「按放宽的规则数出 40 条、按严格规则只剩 5 条」—— 白降级一场。
   */
  relaxed: boolean
  /**
   * ★ 本次**实际用过的搜索词**（主搜索词 + 降级词，按使用顺序）
   *
   * 调用方打日志 / 写 dev dump 时要它：`歌名-歌手` 是缓存键，
   * 看不出"到底搜了什么"（歌名带括号时真正发出去的是剥过括号的版本）。
   */
  keywords: string[]
  /**
   * ★ **每一轮的原始结果**（主搜索词一轮 + 每个降级词各一轮）
   *
   * 与 `items` 的区别：`items` 是**去重合并后**的结果池（能用的候选），
   * 而这一个记的是「每一轮**各自**网到了什么」—— 排查搜索问题时要看的是后者：
   * 「哪个降级词多搜到了东西」「哪些条目在合并时被去重掉了」。
   */
  roundsDetail: SearchRoundDetail[]
}> => {
  /** 从响应里取出视频条目（`result` 里可能混着番剧/专栏，只要 `type === 'video'`） */
  /**
   * 从响应里取出视频条目（`result` 里可能混着番剧/专栏，只要 `type === 'video'`）
   *
   * ## ★ `duration` 在这里**一次性转成秒**
   *
   * B 站搜索接口给的是 `"4:03"` 这种**时分秒字符串**，而下游（过滤、排序、
   * 写库、渲染）全都按**秒数**工作。所以在**进入我们代码的第一道门**就转好，
   * 之后**永远不再解析**。
   *
   * 原来下游到处调 `durationToSeconds`（`videoRank.passHardFilter`、
   * `cache.save`、渲染层 `durationText` 各一份），等于把同一个字符串
   * 反复解析好几遍；而且任何一处忘了转，就会拿字符串跟秒数比大小（静默出错）。
   *
   * 转不了的（空串 / 脏数据）存 `null` = 「时长未知」，
   * 过滤时那种条目会被**保留**（不因缺数据而误杀）。
   *
   * ## `...item` 是**必须**的（别改成只挑几个字段）
   *
   * 这里靠 `...item` 把 B站原始条目**整个**接住，只覆盖 `duration` 一个字段。
   *
   * 踩过：曾经改成「只挑 `bvid`/`title`/`pic`/`author`/`duration`」，
   * 结果把 `type` 也丢了 —— 而 `api:searchSong` 里**还有一处**
   * `filter(item => item.type === 'video')`（它拿到的是本函数的产物），
   * 于是那个过滤**恒为空**，日志一路喊「搜索结果为空」、缓存永远写不进去。
   *
   * 保留全部原始字段就没这个问题：`type` 还在，下游那处过滤照常有效。
   * 代价只是多存了几个用不到的字段（内存里的临时对象，不写库）。
   */
  const extract = (res: BiliResponse): SearchVideoItem[] => {
    const list = res.data?.result
    if (!Array.isArray(list)) return []
    return (list as SearchVideoItem[])
      .filter((item) => (item as { type?: string }).type === 'video')
      .map((item) => ({
        ...item,
        /** ★ 秒数（不再是 `"4:03"`）；`null` = 时长未知 */
        duration: durationToSeconds(item.duration),
      }))
  }

  /**
   * 「够不够」的计数：跑**完整的**过滤规则（不是只做时长）
   *
   * ## ⚠️ 这里曾经只做时长过滤，那是个 bug
   *
   * 原实现是：
   *
   * ```ts
   * items.filter(v => passHardFilter(v, '', [], songDurationSec, toleranceSec, relax))
   * //                              ↑ 歌名传空  ↑ 过滤词传空
   * ```
   *
   * 歌名与过滤词都传空 → 那两条规则**直接跳过**，于是这个计数**只反映时长过滤**
   * 的结果。而它被用来判断「够不够 `minResults` 条、要不要降级」——
   * 于是出现：
   *
   * ```
   * 粗过滤 80 条 → 80 >= 30 → 判定「够了，不降级」
   * 精过滤 25 条 → 用户实际只拿到 25 条，本该降级
   * ```
   *
   * **降级机制等于永远不生效** —— 而它存在的唯一理由就是
   * 「过滤之后不够条数时去多搜一点」。用一个虚高的数字判断，
   * 这个功能就白写了。
   *
   * 现在直接把**同一套规则**（歌名 + 屏蔽词 + 时长）用上：
   * `rankVideos` 也是这套，所以「这里数的」和「用户看到的」是同一个数。
   * 唯一差别是不做排序（只取 `.length`，排序对条数没影响）。
   *
   * ## ⚠️⚠️ 但**必须先把 B站自己的 `favorites` 字段清掉**（第二次踩）
   *
   * B站搜索接口返回的每条里**本来就有个 `favorites`** —— 它是
   * 「这条视频被多少人收藏了」（一个数字，几乎总是 truthy），
   * 而 `rankVideos` 用 `v.favorites` 判断「**是不是用户在我们这儿收藏的**」，
   * 并**豁免收藏项不参与过滤**。
   *
   * 于是不清掉的话：
   *
   * ```
   * 39 条搜索结果 → 38 条被当成"收藏" → 全部豁免过滤 → countPassing = 39
   * 判定「39 >= 30 够了」→ 不补第 2 页、不降级
   * 而 mergeWithFavorites 之后 favorites 被规范成 false → 真过滤 → 只剩 24 条
   * ```
   *
   * 表现就是日志里那两个数字对不上：
   * 「取回 39 条（1 页）」但「过滤后 24 条」—— 而且降级永远不触发。
   *
   * 所以这里显式把 `favorites` 置为 `false`（搜索结果**一律不是**收藏，
   * 「收藏」是 `mergeWithFavorites` 之后才有的概念）。
   *
   * ---
   *
   * ★ 搜索用的歌名：**去掉所有括号及其内容**
   *
   * 必须和硬过滤用**同一套规则**（`rankVideos` 内部也走 `baseSongName`）：
   * 搜索用「九重楼 (不敢独上九重楼)」、过滤却要求标题含「九重楼」时，
   * 两边不一致会出现「搜到了但一条都不通过」（踩过：140 条全灭）。
   *
   * 剥完为空时 `baseSongName` 会退化成「只去括号留内容」，不会变成空搜索词。
   */
  const searchSongName = baseSongName(song)
  const primaryKeyword = buildPrimaryKeyword(searchSongName, singer)

  const countPassing = (items: SearchVideoItem[], relax: boolean): number =>
    rankVideos(
      items.map((v) => ({ ...v, favorites: false })),
      {
        song,
        singer,
        songDurationSec,
        tagBonus,
        filterKeywords,
        durationToleranceSec: toleranceSec,
        relaxUpperBound: relax,
      },
    ).length

  /**
   * 搜一轮：**只搜第 1 页**
   *
   * ## ★ 不再翻页（用户明确要求，也是风控的主要来源）
   *
   * 原来「第 1 页过滤后不够 `minResults` 就再翻第 2 页」。
   * 但一首歌要跑 4 轮，每轮再翻页 = 最多 8 个请求 ——
   * 而渲染层在搜索为空时还会重搜，实际密度远超 B站能接受的范围。
   *
   * 四轮降级本来就覆盖了「换词再找」的需求，**翻页的边际收益不值得**。
   * 所以现在每轮**只取第 1 页**（B站一页 42 条，够用）。
   *
   * 正因为不翻页，原来那个「这一轮够不够、要不要翻第二页」的判断
   * （以及它需要的 `relax` 参数）也一并没有了 —— 函数变简单了。
   */
  const searchRounds = async (
    kw: string,
    /**
     * 这一轮的第 1 页响应（复用调用方已取到的那份）
     *
     * 只在**第一轮**会传 —— 降级轮换了关键词，必须自己搜。
     */
    reusedFirstPage?: BiliResponse,
    /** 分区代码（`''` = 全站，`'3'` = 音乐区）；不给则用默认（全站） */
    tids?: string,
  ): Promise<{ items: SearchVideoItem[]; pages: number }> => {
    /**
     * 复用已有响应，避免把第 1 页搜两遍
     *
     * ⚠️ `api:searchSong` 为了「失败要能抛错」先调了一次 `searchSong(keyword)`，
     * 而这里原本又搜了一次第 1 页 —— 每次缓存未命中都白打一次
     * 完整的 WBI 签名 + 网络往返。
     */
    const first = reusedFirstPage ?? (await searchSong(kw, 1, tids))
    /**
     * B站返回非 0 时**不要把它自己的 message 透传给用户**
     *
     * `first.message` 是 B站原文（可能是 `-352`、风控说明之类的技术文案）。
     * 它经 IPC 抛到渲染层就会被 `$message.error` 显示出来 —— 用户看不懂，
     * 而且把接口的内部说法写在了界面上。所以**统一换成中性文案**，
     * 原始 message 只打日志（排查用）。
     */
    if (first.code !== 0) {
      console.warn(`[search] 搜索接口返回非 0（code=${first.code}）：${first.message ?? ''}`)
      throw new Error('搜索失败，请稍后再试')
    }
    return { items: extract(first), pages: 1 }
  }

  /** 第一轮：主搜索词（**全站**，复用调用方已取到的那份响应） */
  const first = await searchRounds(primaryKeyword, firstPage)

  /**
   * ★ **第一轮返回 0 条 = 被风控**，不要再往下跑（用户明确要求）
   *
   * 判断依据很硬：**B站搜索不会对一首正常存在的歌返回「0 条」**。
   * 只要搜索词里有歌名，它总能搜到点东西（哪怕不相关）。
   * 所以「第 1 轮就是 0 条」几乎只有一种解释：**请求被风控拦了** ——
   * 要么返回了 412（那会更早抛 `RateLimitError`），
   * 要么风控给了个「成功但空」的响应。
   *
   * ## 为什么必须在这里停手
   *
   * 原来的行为是「不够就继续跑第 2、3、4 轮」—— 在风控状态下
   * **每一轮都会被打回**，等于对着风控连打 3 次，只会让封禁更久。
   * 用户的原话：「被风控就不要再发请求出去了，直接提醒用户切歌太快太频繁」。
   *
   * 抛 `RateLimitError` 让上层能给出**准确的提示**（而不是「搜不到这首歌」）。
   *
   * ⚠️ 抛的是**默认 message**（`RATE_LIMIT_MESSAGE`，中性措辞）——
   * 这里不自己传字符串，免得再写出一句带技术细节的文案。
   */
  if (first.items.length === 0) {
    throw new RateLimitError()
  }

  /**
   * ★ **每一步的原始结果**（dev dump 用）
   *
   * 记的是「每个搜索词**各自**搜回来什么」，**不去重、不合并** ——
   * 排查时要看的是「这一轮到底网到了哪些东西」，而不是合并后的池子。
   *
   * 每一项：
   *  - `keyword`   ：这一轮用的搜索词
   *  - `suffix`    ：降级后缀（主词那轮是 `null`）
   *  - `relaxed`   ：这一轮是否放宽了时长上限
   *  - `pages`     ：采了几页
   *  - `items`     ：**该轮的原样结果**（还没跟别的轮次去重）
   *  - `isFallback`：是不是降级轮
   */
  const roundsDetail: SearchRoundDetail[] = [
    {
      keyword: primaryKeyword,
      tids: TIDS_ALL,
      suffix: null,
      relaxed: false,
      pages: first.pages,
      items: first.items,
      isFallback: false,
    },
  ]
  /**
   * ★ **累加合并**的结果池（降级是「补充」，不是「替换」）
   *
   * 用户的原话：「降级的意思是降级搜索，**不是要把之前的结果不要啊**」——
   * 完全正确。原来的实现是「哪一轮过滤后更多就用哪一轮」，
   * 于是第 1 轮的 10 条会被降级轮的 36 条**整个顶掉**：
   *
   * ```
   * 第1轮: 10 条  ┐
   *               ├─ 旧实现：比大小 → 用 36 条 → 最终 36 条（第1轮的 10 条丢了）
   * 降级轮: 36 条 ┘
   *
   * 正确：10 + 36 去重合并 = 46 条（降级是为了**多搜一些补进来**）
   * ```
   *
   * 降级词搜出来的往往是**另一批**视频，两批的重合度并不高，
   * 合起来才是「能挑的候选」。
   */
  const merged: SearchVideoItem[] = [...first.items]
  const seenBvid = new Set(merged.map((x) => String(x.bvid ?? '')))
  /** 用过的搜索词（第一轮 + 降级轮），只用于日志 */
  const usedKeywords: string[] = [primaryKeyword]
  /**
   * 已搜过的**「搜索词 + 分区」组合**（判重用）
   *
   * 为什么不用 `usedKeywords` 判重：第 1、2 轮搜索词相同、只有分区不同，
   * 只比搜索词会把第 2 轮当成重复跳过。
   */
  const usedKeys = new Set<string>([`${primaryKeyword}@${TIDS_ALL}`])
  let pages = first.pages
  let rounds = 1
  /**
   * 是否走过降级轮（走过就要放宽时长上限）
   *
   * 初值 `false` = 只有第一轮的结果，按严格上限。
   */
  let relaxed = false

  /**
   * ★ **四轮降级流程**（用户定的）
   *
   * | 轮 | 搜索词 | 分区（tids） |
   * | :--- | :--- | :--- |
   * | 1 | `歌名 歌手` | **全站**（不给 / `0`）|
   * | 2 | `歌名 歌手` | **音乐区**（`3`）|
   * | 3 | `歌名 歌手 MV` | 音乐区 |
   * | 4 | `歌名 歌手 <括号内容>`；没括号则 `歌名 歌手 可视化` | 音乐区 |
   *
   * ## 为什么第 1、2 轮搜同一个词、只换分区
   *
   * 音乐区（`tids=3`）里是"正经 MV / 官方投稿"，但**翻唱、饭制、
   * 动态歌词排版**这类常发在别的区。只搜音乐区会漏，只搜全站又容易被
   * 无关视频淹没 —— 所以**同一句话各搜一轮，取并集**。
   * 全站那轮排在前面（相关性更宽，先拿到基础候选）。
   *
   * ## 每一轮都是「一页不够就两页」
   *
   * 由 `searchRounds` 内部统一处理，这里不为某一轮加特例。
   *
   * ## 「够不够」判的是**过滤之后**的条数
   *
   * 用户设的 `minResults`（默认 30）是「**过滤完**还剩几条才算够」。
   * 用过滤前的条数判断的话，搜出来 80 条就一定「够」，
   * 哪怕过滤完只剩 25 条也不会降级 —— 那这个设置项就等于没有。
   *
   * ⚠️ 这里踩过：原实现用的 `roughFilter` 把歌名和过滤词都传空，
   * 实际只做了时长过滤，于是判断数字虚高、降级**永远不触发**。
   * 现在用 `countPassing`，跑的是与 `rankVideos` 完全相同的规则。
   */
  if (minResults > 0) {
    /**
     * 第 4 轮的词：**歌名以外的那部分**（括号内容 + 括号后面的文字）
     *
     * ## 为什么不再只取「括号里的内容」
     *
     * 用户点出的典型歌名：`溯(Reverse)feat.马吟吟`
     *
     * ```
     * 歌名（第 1~3 轮用）：溯          ← `baseSongName`，第一个括号之前
     * 第 4 轮用：Reverse feat.马吟吟  ← `splitSongName().tail`，括号及其后的全部
     * ```
     *
     * 两者**互补**：一个负责正名，一个负责「括号 + 后面那串说明」。
     * 只取括号内容的话 `feat.马吟吟` 那段就永远搜不到；
     * 而把它留在歌名里又会让第 1~3 轮的搜索词变成
     * `溯feat.马吟吟 马吟吟`（还和歌手名撞了）。
     *
     * 没有括号时 `tail` 是空串，退回 `可视化` 兜底（行为与以前一致）。
     */
    const tailText = splitSongName(song).tail
    const lastSuffix = tailText || LAST_FALLBACK_SUFFIX

    /**
     * 四轮的参数：搜索词 + 分区
     *
     * 第 1 轮已经在上面搜过了（`first`），这里从第 2 轮开始列。
     */
    const plan: Array<{ kw: string; tids?: string; suffix: string | null; label: string }> = [
      /** 第 2 轮：同一句话，换成音乐区 */
      { kw: primaryKeyword, tids: TIDS_MUSIC, suffix: null, label: '音乐区' },
      /** 第 3 轮：加 MV */
      {
        kw: buildFallbackKeyword(searchSongName, singer, 'MV'),
        tids: TIDS_MUSIC,
        suffix: 'MV',
        label: 'MV',
      },
      /** 第 4 轮：括号及其后的内容（没有则用 `可视化` 兜底） */
      {
        kw: buildFallbackKeyword(searchSongName, singer, lastSuffix),
        tids: TIDS_MUSIC,
        suffix: lastSuffix,
        label: tailText ? '括号部分' : '可视化',
      },
    ]

    for (const step of plan) {
      /** 够了吗？够了就不再加了（`countPassing` 跑的是完整规则） */
      if (countPassing(merged, relaxed) >= minResults) break
      /**
       * ⚠️ 判重必须用**搜索词 + 分区**的组合键，不能只看搜索词
       *
       * 第 1、2 轮**搜索词完全相同**（`歌名 歌手`），只有分区不同。
       * 只比搜索词的话第 2 轮会被当成"重复"直接跳过 ——
       * 那整个"全站 + 音乐区各搜一轮"的设计就白做了。
       */
      const stepTids = step.tids ?? TIDS_ALL
      const stepKey = `${step.kw}@${stepTids}`
      if (!step.kw || usedKeys.has(stepKey)) continue
      usedKeys.add(stepKey)

      try {
        /**
         * ★ 降级轮**放宽时长上限**（`relax = true` → `容差 × 1.7`）
         *
         * 降级时搜出来的结果更杂（大量合集 / 全场 / 串烧），
         * 用第一轮那套上限会把本来能找到的砍掉。
         *
         * ⚠️ 这里以前传的是写死的 `false` —— `relaxUpperBound` 这个参数
         * **声明了、注释了，却从来没有被传成 `true`**，等于那条规则根本没生效。
         * 是代码审查时靠全仓 grep 才发现的：它是个**永远走不到的分支**。
         */
        const round = await searchRounds(step.kw, undefined, stepTids)
        rounds++
        usedKeywords.push(step.kw)

        /** ★ 记下这一轮的**原样结果**（去重合并之前的） */
        roundsDetail.push({
          keyword: step.kw,
          tids: stepTids,
          suffix: step.suffix,
          relaxed: true,
          pages: round.pages,
          items: round.items,
          isFallback: true,
        })

        /**
         * ★ 按 bvid 去重后**追加**到结果池
         *
         * 去重是必须的：降级词与主搜索词的结果**一定会重合**。
         * 同一 bvid 只留第一次出现的 —— 那批是更靠前那轮的结果，
         * 元数据（带 `<em>` 高亮的标题）更贴合。
         */
        let added = 0
        for (const item of round.items) {
          const bvid = String(item.bvid ?? '')
          if (!bvid || seenBvid.has(bvid)) continue
          seenBvid.add(bvid)
          merged.push(item)
          added++
        }
        pages = Math.max(pages, round.pages)
        /**
         * 走过降级轮就置 `relaxed`：调用方做**精确过滤**（`rankVideos`）时
         * 要跟着放宽上限，否则降级轮补进来的那些会因为「时长超了严格上限」
         * 又被挡回去 —— 白降级一场。
         */
        relaxed = true

        console.log(
          `[search] ${song}-${singer} 降级「${step.kw}」（${step.label}` +
            `${stepTids === TIDS_ALL ? '，全站' : ''}）+${added}（累计 ${merged.length}）`,
        )
      } catch (err) {
        /**
         * ★ **被风控（412）时立刻整个中止，绝不继续下一轮**（用户明确要求）
         *
         * 风控状态下「继续试下一个降级词」是最坏的做法：每一轮都会被拦，
         * 等于对着风控连打三次，只会让封禁更久。所以这里**重新抛出去**，
         * 由 IPC 层转成给用户的提示（「切歌太快了」）。
         *
         * 其它错误（网络抖动、接口抽风）才当作「这一轮没成」继续往下 ——
         * 已经有结果的话还能用。
         */
        if (isRateLimitError(err)) throw err
        console.warn(
          `[search] ${song}-${singer} 降级搜索「${step.kw}」失败（继续用已有结果）:`,
          err,
        )
      }
    }
  }

  return {
    items: merged,
    pages,
    rounds,
    /** ★ 本次结果是否按放宽后的时长上限取的（调用方排序时要跟着放宽） */
    relaxed,
    /** ★ 实际用过的搜索词（主词 + 降级词，按顺序） */
    keywords: usedKeywords,
    /** ★ 每一轮的原始结果（dev dump 用） */
    roundsDetail,
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
  /**
   * ★ **视频轨的全部候选地址**（主地址 + 所有 `backupUrl`，常规 CDN 优先）
   *
   * 第一个就是 `videoUrl`。卡顿时渲染层按这个列表**换源**（同一清晰度换 CDN），
   * 而不是干等降清晰度 —— 见 `dashUrlsOf`。
   */
  videoUrls: string[]
  /** ★ 音频轨的全部候选地址（第一个就是 `audioUrl`） */
  audioUrls: string[]
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
   * 它**本来就要取**（拿 playurl 必须用）。顺手带出来是为了让调用方
   * 以后要用时不必再发一次 view 请求。
   *
   * ⚠️ 当前**没有任何消费方** —— 它曾经是给「取 AI 字幕做歌词对齐」用的，
   * 而歌词功能已经整体移除（`api:resolveVideo` 把解析结果拆成
   * `videoUrl/dash/viewData/playData`，**丢掉了 `cid`**）。
   *
   * 留着它而不是删掉：字段是免费的（cid 已经在手里），
   * 删了以后要加回来又得改一处签名。
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

/**
 * ★ 取**全部**可用地址（主地址 + 所有备用），常规 CDN 排前面
 *
 * 为什么要它：卡顿时要能「换同一个清晰度的备用源」。
 * 只挑一个地址的话，备用源全丢了，卡顿只能干等降 durl。
 *
 * 返回顺序：常规 CDN 域优先，其余兜底；**去重**（B站有时同一地址
 * 既放 `baseUrl` 又放 `backupUrl`）。
 */
export const dashUrlsOf = (item: DashItem | undefined): string[] => {
  if (!item) return []
  const primary = item.baseUrl || item.base_url
  const backups = item.backupUrl ?? item.backup_url ?? []
  const all = [primary, ...backups].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  )
  const unique = [...new Set(all)]
  return [...unique.filter((u) => isNormalCdn(u)), ...unique.filter((u) => !isNormalCdn(u))]
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

  /** ★ 取**全部**候选地址（不止一个）—— 卡顿时渲染层要靠它换源 */
  const videoUrls = dashUrlsOf(video)
  const audioUrls = dashUrlsOf(audio)
  const videoUrl = videoUrls[0] ?? null
  const audioUrl = audioUrls[0] ?? null
  const videoMime = dashMimeOf(video)
  const audioMime = dashMimeOf(audio)
  if (!videoUrl || !audioUrl || !videoMime || !audioMime) return null

  return {
    videoUrl,
    audioUrl,
    videoUrls,
    audioUrls,
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
  /** 同上：不透传接口原文（用户看不懂），原文只打日志 */
  if (view.code !== 0) {
    console.warn(`[parseVideo] view 接口返回非 0（code=${view.code}）：${view.message ?? ''}`)
    throw new Error('获取视频信息失败，请确认链接是否正确')
  }
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
  /** 同上：不透传接口原文 */
  if (viewData.code !== 0) {
    console.warn(
      `[resolveVideo] view 接口返回非 0（code=${viewData.code}）：${viewData.message ?? ''}`,
    )
    throw new Error('获取视频信息失败')
  }
  const cid = viewData.data?.cid
  if (!cid) {
    /** `cid` 是接口术语，用户看不懂 —— 只说「这个视频暂时放不了」 */
    throw new Error('这个视频暂时无法播放')
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
