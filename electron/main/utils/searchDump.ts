/**
 * ★ **开发期专用**：把「过滤之前」的搜索结果 dump 成 JSON
 *
 * ## 为什么需要它
 *
 * SQLite 里存的是**过滤并排序之后**的结果，看不到过滤前某站到底返回了什么。
 * 排查「这首歌为什么搜不到 / 为什么被挡掉」时，最关键的是那一批**原始候选**。
 *
 * ## 只在开发模式启用
 *
 * `app.isPackaged === false` 才写。打包后的程序不产生任何额外文件 ——
 * 这是调试工具，不该出现在用户机器上。
 *
 * ## 存到哪
 *
 * `<userData>/search/<缓存键>.json`
 *
 * 文件名就是**缓存键**（`歌名-歌手`），所以同一个搜索词每次覆盖同一份 ——
 * 想看「现在的过滤前数据」，直接去开那个文件就行，不会堆一目录时间戳。
 *
 * 缓存键里的 `/` `\` `:` 等字符会替换成 `_`（Windows 文件名限制）。
 *
 * ## 文件内容
 *
 * ```jsonc
 * {
 *   "cacheKey": "想拥有你-Ssweetxin_",
 *   "song": "想拥有你",
 *   "singer": "Ssweetxin_",
 *   "keywords": ["\"想拥有你\" Ssweetxin_", "\"想拥有你\" MV", "\"想拥有你\""],
 *   "stats": { "raw": 267, "pages": 2, "rounds": 4, "relaxed": true },
 *   "dumpedAt": "2026-10-19T...",
 *
 *   // ★ 搜索过程的每一轮（主词 + 各降级词），每轮是该词**各自**的原样结果
 *   "rounds": [
 *     { "keyword": "\"想拥有你\" Ssweetxin_", "suffix": null, "isFallback": false,
 *       "relaxed": false, "pages": 2, "count": 48, "items": [...] },
 *     { "keyword": "\"想拥有你\" MV", "suffix": "MV", "isFallback": true,
 *       "relaxed": true, "pages": 2, "count": 83, "items": [...] }
 *   ],
 *
 *   // 合并去重后、过滤前的候选池（含库里的收藏项）
 *   "mergedBeforeFilter": { "count": 267, "items": [...] }
 * }
 * ```
 *
 * ⚠️ **文件可能很大**：多轮降级 + 每轮两页，一首歌能到 2 MB 以上。
 * 所以调用点是**注释掉**的（见 `biliApiHandlers.ts` 里那段说明）——
 * 平时不写，排查搜索问题时才放开。
 */
import path from 'node:path'
import { app } from 'electron'
import { writeJsonAtomic } from './atomicJson'

/** dev dump 的目录名（在 userData 下） */
const SEARCH_DUMP_DIR = 'search'

/**
 * 这次运行是不是开发模式
 *
 * 用 `app.isPackaged` 而不是 `index.ts` 里的模块级 `isDev`：
 * 这个模块可能被更早加载，而 `app.isPackaged` 随时可读、语义也直接。
 */
const isDev = (): boolean => {
  try {
    return !app.isPackaged
  } catch {
    return false
  }
}

/** 把缓存键变成合法文件名（Windows 比 POSIX 严：`\ / : * ? " < > |` 都不能有） */
const toFileName = (raw: string): string =>
  String(raw ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'untitled'

export interface SearchDumpInput {
  /** 缓存键（`歌名-歌手`），既是标识也是文件名 */
  cacheKey: string
  /** 歌名（原始，带括号那种） */
  song: string
  /** 歌手 */
  singer: string
  /** 这次**实际用过的搜索词**（主词 + 降级词，按使用顺序） */
  keywords: string[]
  /** 取数统计 */
  stats: { raw: number; pages: number; rounds: number; relaxed: boolean }
  /**
   * ★ **每一轮的原始结果**（主词一轮 + 每个降级词各一轮）
   *
   * 每轮的 `items` 是**该词各自搜回来的原样结果**，没跟别的轮次去重 ——
   * 排查时要看的正是这个（「这个降级词多搜到了什么」）。
   */
  roundsDetail: Array<{
    keyword: string
    /** ★ 这一轮用的分区（`''` = 全站，`'3'` = 音乐区） */
    tids: string
    suffix: string | null
    relaxed: boolean
    pages: number
    isFallback: boolean
    items: unknown[]
  }>
  /** **合并去重后、过滤前**的候选池（含库里的收藏项） */
  items: unknown[]
}

/**
 * 写一份搜索快照（**只在开发模式生效**，非 dev 直接返回）
 *
 * 失败**静默忽略**：这是调试辅助，不能因为它写盘失败影响搜索本身。
 */
export const dumpSearchBeforeFilter = (input: SearchDumpInput): void => {
  if (!isDev()) return
  try {
    const dir = path.join(app.getPath('userData'), SEARCH_DUMP_DIR)
    /**
     * 每次**覆盖**同名文件（文件名就是缓存键）
     *
     * 不叠时间戳是刻意的：用户要的是「这首歌现在搜索过程长什么样」，
     * 每次搜索都新写一份只会堆出一堆看不出差别的文件。
     */
    const file = path.join(dir, `${toFileName(input.cacheKey)}.json`)
    writeJsonAtomic(
      file,
      {
        cacheKey: input.cacheKey,
        song: input.song,
        singer: input.singer,
        keywords: input.keywords,
        stats: input.stats,
        /** 写入时间，方便确认是不是这次的 */
        dumpedAt: new Date().toISOString(),
        /**
         * ★ **搜索过程的每一轮**（主词 + 各降级词）
         *
         * 这是排查的重点：每个词各自搜回来多少、`items` 里有什么。
         */
        rounds: input.roundsDetail.map((r) => ({
          keyword: r.keyword,
          /** 分区：全站（`''`）/ 音乐区（`'3'`） */
          tids: r.tids,
          tidsLabel: r.tids === '3' ? '音乐区' : '全站',
          suffix: r.suffix,
          relaxed: r.relaxed,
          pages: r.pages,
          isFallback: r.isFallback,
          /** 该轮原样结果 */
          count: r.items.length,
          items: r.items,
        })),
        /**
         * **合并去重后、过滤前**的候选池（写库前 `rankVideos` 的输入）
         *
         * 与 `rounds` 的区别：这里已经去过重、并含库里的收藏项。
         */
        mergedBeforeFilter: {
          count: input.items.length,
          items: input.items,
        },
      },
      '\t',
    )
    console.log(
      `[dev] 搜索过程已存到 ${file}（${input.roundsDetail.length} 轮，合并后 ${input.items.length} 条）`,
    )
  } catch (err) {
    console.warn('[dev] 写搜索快照失败（忽略）:', err)
  }
}
