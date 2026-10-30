/**
 * 本地视频文件（拖进窗口的 mp4 / webm / mkv …）
 *
 * ## 为什么本地文件「长得像一条 bvid」
 *
 * 播放层整套是围着 `bvid` 建的：视频列表条目（`videolist_items.bvid`）、
 * 直连键（`bv:<bvid>`）、续播（按 bvid 重定位）、收藏置顶、失效刹车、
 * 托盘媒体信息 —— 全都只认 bvid。
 *
 * 所以本地文件不去另造一套「本地条目」的概念，而是**给文件发一个 bvid**：
 *
 * ```
 * lf_ + sha1(规范化路径).slice(0, 16)     例：lf_9f2c1a7b3d4e5f60
 * ```
 *
 * 于是「拖单条 B 站视频」和「拖本地文件」在主进程里走的是**同一条路**
 * （进默认列表 → 置顶 → 起播 → 续播），差别只有一处：地址怎么来。
 * 路径按哈希算，所以**同一个文件重复拖必然复用同一行**，不会攒出副本。
 *
 * ## 路径存在哪：`videos.durl_url`
 *
 * 不新增列。`durl_url` 的语义本来就是「一个可以直接塞进 `<video src>` 的完整地址」，
 * 本地文件是**同一个语义**，只是这个地址由我们自己的协议生成。好处很实在：
 * 表结构不变 → 指纹不变 → **不触发整库重建**，现有歌单 / 列表 / 收藏全部无损。
 *
 * 库里存**原始绝对路径**而不是 `blwe-media://` 的 URL：
 *  - 路径是事实，URL 是派生的（协议名改了不该让全库数据失效）；
 *  - 文件名里可能有 `#` / `?` / `%` / 中文，塞进 URL 要 encode，存进去再读出来
 *    很容易二次编码 —— 而 `#` 之后会被当成 fragment，直接播错文件。
 *
 * 代价是「`durl_url` 里可能是路径」这一点必须让两处清扫知道（见 `cache.ts`
 * 里 `clearAll` / `clearExpiredPlayurl` 的 `NOT LIKE 'lf\_%'`），否则路径会被当缓存抹掉。
 *
 * ## 这个文件不做什么
 *
 * 不解析、不探测、不联网：只做「路径 ↔ bvid」的身份换算、按 bvid 的查询，
 * 以及**文件不见了之后的两件善后事** —— 判定「这条失效了」（`localVideoExists`
 * / `markLocalItemsMissing`）和「用户重新指了条路」（`relocateLocalVideo`）。
 * 导入（写 videos + 挂进列表）在 `utils/videolist.ts`，读路径在 `resolveVideo`。
 *
 * ## 文件被删 / 被移走之后会发生什么
 *
 * 三层，一层比一层晚：
 *
 *  1. **播放前**：`api:resolveVideo` 先 `stat` 一次，不存在就回 `LOCAL_MISSING`，
 *     播放器据此弹「重新定位 / 移除」，而不是笼统地「取不到播放地址」；
 *  2. **播放中**：`blwe-media://` 会再 `stat` 一次，404 → `<video>` 报错 →
 *     渲染层按 `LOCAL_MISSING` 走同一套善后（那边先问一次 `localVideoExists`，
 *     文件还在就说明是**解码不支持**，别误报成丢失）；
 *  3. **列表里**：视频管理打开 / 切列表时批量摸一遍（`markLocalItemsMissing`），
 *     失效的置灰打标，可以就地重新定位或移除。
 *
 * **任何一层都不自动删库里的行**：拔了移动硬盘、盘符暂时没挂上，过两天插回来
 * 就该照常能播。删不删由用户点。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { VideoListItem } from '@common/types/playlist'
import { getDb } from './db'

/**
 * 本地文件的 bvid 前缀
 *
 * 单独抽出来是因为它**同时是几个 SQL 判据的一部分**（"是不是缓存"、
 * "要不要清地址"）。散着写 `'lf_'` 字面量，改的时候必然漏一处。
 */
export const LOCAL_BVID_PREFIX = 'lf_'

/** 媒体协议名（`blwe-media://local/<bvid>` → 主进程流式返回文件） */
export const LOCAL_MEDIA_SCHEME = 'blwe-media'

/**
 * 认得出「这可能是个视频文件」的扩展名
 *
 * ⚠️ **这不是「能不能播」的白名单** —— 能不能播由渲染层的探针实测
 * （`<video preload="metadata">` 解不出 `loadedmetadata` 就是播不了）。
 * 这里只是别把 zip / jpg / exe 也当视频拖进来：拖个压缩包进来必然报错，
 * 那一句「这不是视频文件」比「导入失败」有用得多。
 *
 * 所以宁可放宽（`mkv` / `avi` / `ts` 都收）：解不出来时探针会明确说编码不支持，
 * 而不是让它连列表都进不去、用户不知道为什么没反应。
 */
const VIDEO_EXTS = new Set([
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.flv',
  '.ts',
  '.m2ts',
  '.wmv',
  '.mpg',
  '.mpeg',
  '.ogv',
  '.3gp',
])

/** 是不是本地文件条目（`lf_` 开头的 bvid） */
export const isLocalBvid = (bvid: string): boolean =>
  typeof bvid === 'string' && bvid.startsWith(LOCAL_BVID_PREFIX)

/** 扩展名像不像视频（只用于「拖进来的东西要不要当视频处理」） */
export const isLocalVideoFile = (filePath: string): boolean =>
  VIDEO_EXTS.has(path.extname(filePath).toLowerCase())

/**
 * 「重新定位文件」对话框的文件类型过滤器
 *
 * 和 `VIDEO_EXTS` 是同一份清单的两个视图：那边用来判定拖进来的东西，
 * 这边交给系统的打开对话框 —— 两处各写一份必然会漂（用户能在对话框里选到
 * 一个拖不进来的扩展名，或者反过来）。
 */
export const VIDEO_FILE_FILTERS = [
  { name: '视频文件', extensions: [...VIDEO_EXTS].map((ext) => ext.slice(1)) },
  { name: '所有文件', extensions: ['*'] },
]

/**
 * 路径 → bvid
 *
 * 规范化后再哈希，三个细节：
 *  - `path.resolve`：拖进来的可能是相对路径 / `~` 残缺形式，先落成绝对路径；
 *  - Windows 上转小写：`D:\A.mp4` 和 `d:\a.mp4` 是同一个文件（大小写不敏感），
 *    不转的话同一个文件拖两次会得到两个 bvid，列表里出现两条一样的；
 *  - 只取哈希前 16 位：冲突概率可以忽略，而 `bv:` 键、日志、界面都不会太长。
 *
 * 注意**不用文件 inode / size 做身份**：换个盘符、重新拷一份都是「新的」，
 * 而用户的心智是「这个文件」，不是「这次拷过来的这个 inode」。
 */
export const localBvidOfPath = (filePath: string): string => {
  const abs = path.resolve(filePath)
  const normalized = process.platform === 'win32' ? abs.toLowerCase() : abs
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 16)
  return LOCAL_BVID_PREFIX + hash
}

/** 文件名去掉扩展名当标题（没有 ffmpeg，读不到容器里的真实标题） */
export const localTitleOfPath = (filePath: string): string => {
  const base = path.basename(filePath)
  const ext = path.extname(base)
  const title = ext ? base.slice(0, -ext.length) : base
  return title.trim() || base
}

/**
 * 渲染层要播放的地址
 *
 * 带 `bvid` 而不是带路径：协议处理器拿 bvid 回查库，**只放我们登记过的文件**。
 * 如果把路径编进 URL，这个协议就成了「任意本地文件读取器」——
 * 虽然本项目的渲染层是我们自己的代码，但没必要给将来的某个 XSS 留这个口子。
 */
export const localMediaUrl = (bvid: string): string =>
  `${LOCAL_MEDIA_SCHEME}://local/${encodeURIComponent(bvid)}`

/** `blwe-media://local/<bvid>` → bvid（解析不出来返回空串） */
export const bvidOfMediaUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== `${LOCAL_MEDIA_SCHEME}:`) return ''
    return decodeURIComponent(url.pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
}

export interface LocalVideoRecord {
  bvid: string
  /** 绝对路径（库里就是它，见文件头的取舍） */
  filePath: string
  title: string | null
  /** 秒；导入时是 NULL，播过一次后由渲染层的探针回写 */
  duration: number | null
}

/**
 * 按 bvid 取本地文件记录
 *
 * 只查一列 `durl_url`（= 路径），不带 dash 那两坨 JSON —— 这个函数
 * 在每次起播时都会被调一次，没必要为了一个路径把几十 KB 拖出来。
 */
export const getLocalVideo = (bvid: string): LocalVideoRecord | null => {
  if (!isLocalBvid(bvid)) return null
  try {
    const row = getDb()
      .prepare(`SELECT bvid, title, duration, durl_url FROM videos WHERE bvid = ?`)
      .get(bvid) as
      | { bvid: string; title: string | null; duration: number | null; durl_url: string | null }
      | undefined
    if (!row?.durl_url) return null
    return {
      bvid: row.bvid,
      filePath: row.durl_url,
      title: row.title,
      duration: row.duration,
    }
  } catch (err) {
    console.error('[local] 读取本地视频失败:', err)
    return null
  }
}

/**
 * 文件此刻还在不在（**异步**，给 IPC 用）
 *
 * 为什么是异步、而且只给 IPC 用：`stat` 一个网络盘 / 掉线的移动硬盘可能要阻塞
 * 好几秒，同步版本放进 `getVideoListItems()` 会**冻住主进程**（连带界面卡死）。
 * 所以「判定失效」只在「界面明确要看一眼」时做，且并发跑（见 `markLocalItemsMissing`）。
 *
 * 查不到 = 视为不存在：路径被删、盘符没挂上、权限被改，对播放来说都是同一件事。
 */
export const localVideoExists = async (
  bvid: string,
): Promise<{ exists: boolean; filePath: string | null }> => {
  const record = getLocalVideo(bvid)
  if (!record) return { exists: false, filePath: null }
  try {
    const stat = await fsp.stat(record.filePath)
    return { exists: stat.isFile(), filePath: record.filePath }
  } catch {
    return { exists: false, filePath: record.filePath }
  }
}

/**
 * 给一批列表条目打上「文件丢失」标记（只检查本地文件条目）
 *
 * 只对 `lf_` 开头的条目 `stat`，B 站条目一次 IO 都不做 ——
 * 一个列表里绝大多数是 B 站视频，逐个 stat 既无意义又慢。
 *
 * 结果**不落库**：文件可能只是暂时不在（拔了硬盘），标记只活在这一屏。
 */
export const markLocalItemsMissing = async (items: VideoListItem[]): Promise<VideoListItem[]> => {
  const locals = items.filter((item) => isLocalBvid(item.bvid))
  if (locals.length === 0) return items

  /** bvid → 是否缺失 */
  const missing = new Map<string, boolean>()
  await Promise.all(
    locals.map(async (item) => {
      if (!item.localPath) {
        missing.set(item.bvid, true)
        return
      }
      try {
        const stat = await fsp.stat(item.localPath)
        missing.set(item.bvid, !stat.isFile())
      } catch {
        missing.set(item.bvid, true)
      }
    }),
  )

  return items.map((item) =>
    missing.has(item.bvid) ? { ...item, missing: missing.get(item.bvid) === true } : item,
  )
}

export interface RelocateResult {
  ok: boolean
  /** 重定位后的 bvid —— 恒等于入参（原因见函数注释） */
  bvid: string
  title: string
  /** 新路径本身已经有一条**别的**记录（同一文件曾从新位置拖进来过） */
  duplicate: boolean
  error?: string
}

/**
 * 「重新定位」：把某条本地视频指向一个新路径
 *
 * ## 只改 `durl_url`，**不改 bvid**
 *
 * bvid 是身份的锚点：列表位置（`videolist_items.bvid`）、收藏、续播
 * （`song_meta.selected_bvid`）、`bv:` 直连键全都引着它。若为了「路径变了身份也变」
 * 去做一次主键迁移，就要把这些引用**逐个跟着改** —— 漏一处就是一条孤儿数据。
 *
 * 而这些引用本来就不需要变：用户的语义是「**同一条**记录，文件换了个位置」，
 * 不是「换了一条视频」。所以路径只是记录的一个属性，改它就行。
 *
 * ## 代价：同一份文件可能出现两条记录
 *
 * bvid 是路径哈希，所以换了位置的同一份文件如果**再次被拖进来**，
 * 会算出另一个 bvid，得到第二条记录（这条老的还在，只是也指向同一个文件）。
 * 这种情况无法在「重定位」这一刻消除（老记录的列表引用还在），
 * 所以这里只回报 `duplicate`，由界面决定要不要提示 —— 不影响播放。
 *
 * 标题保持原样（重定位 = 同一个视频），只在原来为空时用新文件名补一个：
 * 用户把 `S01E01.mp4` 挪到 `第一集.mp4`，列表里那条名字不该莫名其妙变掉。
 */
export const relocateLocalVideo = (bvid: string, newPath: string): RelocateResult => {
  const fail = (error: string): RelocateResult => ({
    ok: false,
    bvid,
    title: '',
    duplicate: false,
    error,
  })

  if (!isLocalBvid(bvid)) return fail('这一条不是本地视频文件')

  const abs = path.resolve(String(newPath || ''))
  if (!newPath) return fail('没有选择文件')
  if (!isLocalVideoFile(abs)) return fail('选中的不是视频文件')
  try {
    if (!fs.statSync(abs).isFile()) return fail('选中的不是文件')
  } catch {
    return fail('选中的文件打不开（可能没有读取权限）')
  }

  try {
    const db = getDb()
    const row = db
      .prepare(`SELECT bvid, title, durl_url FROM videos WHERE bvid = ?`)
      .get(bvid) as { bvid: string; title: string | null; durl_url: string | null } | undefined
    if (!row) return fail('这条记录已经不在库里了')

    const dupBvid = localBvidOfPath(abs)
    const duplicate =
      dupBvid !== bvid && db.prepare(`SELECT 1 FROM videos WHERE bvid = ?`).get(dupBvid) !== undefined

    const title = row.title || localTitleOfPath(abs)
    db.prepare(`UPDATE videos SET durl_url = ?, title = ? WHERE bvid = ?`).run(abs, title, bvid)
    console.log(`[local] 重新定位 ${bvid} → ${abs}`)
    return { ok: true, bvid, title, duplicate }
  } catch (err) {
    console.error('[local] 重新定位失败:', err)
    return fail(err instanceof Error ? err.message : String(err))
  }
}
