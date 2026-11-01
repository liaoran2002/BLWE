/**
 * 搜索结果的**硬过滤 + 分层打分 + 排序**（主 / 渲染共用）
 *
 * ## 一句话逻辑
 *
 * **标题必须含歌名，时长必须对得上；歌手名命中给 +100 的断层分，
 * 层内再用关键词细分；找不到就降级找原唱。**
 *
 * ## 为什么推翻了旧实现
 *
 * 旧的三件套（`matchScore` 子序列逐字匹配 + `nameBonus` 加减 + `tagBonus` 无上限）
 * 有两个硬伤：
 *  1. **子序列匹配太宽松** —— 标题里散落着歌名的字就能得分，于是
 *     「吉他谱教程」也能拿到不低的分数（它确实含那些字）；
 *  2. **关键词权重靠拍脑袋**，没有明确的主次。
 *
 * 新版用**硬过滤**先砍掉明显不是同一首的（不含歌名、时长差太多、命中屏蔽词），
 * 再用**歌手断层分**保证「歌手名也命中」的一批**远远压在**「只有歌名」的一批上面，
 * 最后才在层内用关键词微调。
 *
 * ## ⚠️ 关键词加权**不再有上限**（这里改过）
 *
 * 早先层内加权被 `clamp` 到 `[-10, +10]`，而断层分定成 `+50` ——
 * 那个 50 是**由 clamp 上限倒推出来的**（保证两层数值区间不重叠）。
 *
 * 但那个上限有个副作用：**堆几个关键词就能顶满**，用户把 `-20` 档给「伴奏」
 * 就是为了把伴奏压下去，结果被夹到 -10，与 `-4` 档的乐器演奏**只差 6 分**，
 * 表达不出「伴奏要重罚」的意图。
 *
 * 现在**去掉 clamp**：用户给多少分就是多少分，`tagBonus` 里所有命中的关键词
 * 直接累加。代价是「断层分不再有数学上的保证」—— 见下面 `LAYER_BOTH` 的说明。
 */

/** 一首歌的缓存键 `"歌名-歌手"`（已废弃，仅为兼容旧数据保留） */
export type CacheKey = string

/** 一条候选视频排序与过滤所需的最小形状 */
export interface RankableVideo {
  bvid?: string
  title?: string
  /**
   * 时长**秒数**（`null` / 缺省 = 未知）
   *
   * ⚠️ **进来之前就该是秒**：某站搜索给的是 `"4:03"` 字符串，
   * 那个转换统一在 `biliApi.extract` 里做（唯一入口）。
   * 这里不再接受字符串 —— 原来 `passHardFilter` 每次判断都要
   * 解析一遍，既慢又容易漏。
   */
  duration?: number | null
  favorites?: boolean
}

/**
 * 排序与过滤的完整配置
 *
 * 全部来自设置项（用户可改），所以这个模块本身**不读设置**，
 * 只接收它 —— 这样主进程和渲染层能共用同一份实现（两边各读一次设置必然漂移）。
 */
export interface RankOptions {
  /**
   * 歌名（**纯歌名**，不含歌手）
   *
   * ⚠️ 以前这里是一个 `"歌名-歌手"` 拼串，用的时候再 `splitCacheKey` 拆开 ——
   * 那是「先合并再拆开」的多余往返：歌名和歌手本来就是**两个独立字段**
   * （歌单里、界面上都分开存），只有拼搜索词那一刻才需要放在一起。
   *
   * 拆开传的另一个好处：歌名里**本来就可能含 `-`**
   * （如 `下坠Falling` / `R.` / `若是明仔载`），拼串后按 `-` 拆是**有歧义**的。
   */
  song: string
  /** 歌手（多个用「、」连接）；空串表示未知 -> 只按歌名判定 */
  singer: string
  /** 这首歌曲单里的时长（秒）；**未知则不按时长过滤** */
  songDurationSec: number | null | undefined
  /** 关键词加权表：`{ 分值: [关键词...] }`（设置项 `player.tagBonus`） */
  tagBonus: Record<string, string[]>
  /** 命中即丢弃的关键词（设置项 `player.filterKeywords`） */
  filterKeywords: string[]
  /** 时长容差（秒，默认 90） */
  durationToleranceSec: number
  /**
   * 放宽时长**上限**为 `容差 × 1.7`
   *
   * 用于**降级搜索**那一轮：降级时搜索结果更杂（含大量合集 / 全场），
   * 用同一套上限会把本来能找到的都砍掉。按规格，降级轮次一律放宽
   * （不像第一轮那样只在标题有 `MV/官方/Live/现场` 时才放宽）。
   */
  relaxUpperBound?: boolean
}

/**
 * **歌手名命中**的断层分（+100）
 *
 * 硬过滤已经保证了「标题含歌名」，所以在打分阶段**还是 0 分的那一批，
 * 就等价于「只有歌名、歌手对不上」**（同曲不同歌手的翻唱 / 别的版本）。
 *
 * 用户的要求很明确：**歌手名前后的优先级要拉开**，所以给 100 ——
 * 一个「只有歌名」的候选哪怕把 `tagBonus` 里的正分词全命中（4K + 官方 + MV…），
 * 也很难靠堆词追平这 100 分，于是「歌手对」的那批稳定排在最前。
 *
 * ⚠️ 关键词加权**已取消上限**，所以理论上堆够多正分词可以超过 100 ——
 * 但那是**用户自己配的**，他配了那么多正分词就是想让它们起作用，
 * 与我们替他夹一个上限相比，后者更不透明。
 */
const LAYER_BOTH = 100
/** 只有歌名、歌手没命中（硬过滤已保证含歌名，所以这是兜底值） */
const LAYER_NAME_ONLY = 0

/**
 * 时长上限的放宽倍数
 *
 * 标题里含 `MV/官方/Live/现场` 时用 `容差 × 1.7` —— 那些版本常带前奏画面 /
 * 片尾 / 报幕，比纯音频长几十秒很正常，用同一套容差会**误杀真的官方 MV**。
 */
const LONG_FORM_HINT_RE = /mv|官方|live|现场/i
const LONG_FORM_FACTOR = 1.7

/**
 * 时长**下界**的兜底比例（歌长 × 它）
 *
 * 只用来防止「容差设得很大时下界变成负数」—— 正常情况由容差决定，
 * 这个系数只是最后一道防线。**用户指定 0.3**（原来是 0.5，会误杀短版本）。
 * 详见 `passHardFilter` 里那段说明。
 */
const LOWER_BOUND_RATIO = 0.3

/** 去掉 HTML 标签（某站的 `title` 里带 `<em class="keyword">` 高亮标记） */
const stripHtml = (s: unknown): string => String(s ?? '').replace(/<[^>]*>/g, '')

/**
 * 简繁归一：繁体 → 简体（opencc `tw → cn`）
 *
 * ## 为什么必须做
 *
 * 某站标题**大量用繁体**，而歌单里的歌名是简体：
 *
 * ```
 * 歌名（歌单）：旧
 * 标题（某站）：不夠 - 舊『也許是舊的道理 虛情假意，卻總說得很堅定。』
 *                                     ↑ 繁体「舊」≠ 简体「旧」→ 匹配不上 → 误杀
 * ```
 *
 * 而这**不是"另一首歌"** —— 它就是用户要的那首，只是字不同。
 *
 * ## 为什么用 opencc-js 而不是自己写表
 *
 * 简繁不是一对一的（`著` / `乾` / `裏` 有多对多情况，还要处理词组），
 * 自己维护一张表必然漏字，而漏一个字就是「这首歌的候选突然全没了」。
 *
 * ## 为什么只引 `opencc-js/t2cn` 子路径
 *
 * 主入口（`require('opencc-js')`）是 **1.1 MB** 的全量包，含
 * 简→繁、日文新字体、台湾/香港变体等**我们一个都不用**的字典。
 * 而 `t2cn` 子路径只有 **106 KB**，正是「繁体 → 简体」这一件事 ——
 * 体积差 **10 倍**，而程序里只用得到这一个方向。
 *
 * 对**已经是简体**的输入是幂等的（转换后不变），所以可以无条件调用。
 */
const toSimplified = ((): ((s: string) => string) => {
  try {
    /**
     * 引子路径 `opencc-js/t2cn`（不是主入口）
     *
     * 用它导出的 `Converter({ from: 'tw', to: 'cn' })` —— 接口与主入口一致。
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OpenCC = require('opencc-js/t2cn') as {
      Converter: (o: { from: string; to: string }) => (s: string) => string
    }
    const convert = OpenCC.Converter({ from: 'tw', to: 'cn' })
    /** 启动时自检一次：转换器坏了要立刻知道，而不是让过滤结果悄悄变错 */
    if (convert('舊') !== '旧') {
      console.warn('[videoRank] opencc 转换结果异常，简繁归一退化为不转换')
      return (s: string) => s
    }
    return (s: string) => convert(s)
  } catch (err) {
    /**
     * 拿不到 opencc **不能让过滤整体失败** —— 退化成"不转换"，
     * 代价是繁体标题的歌候选变少，但程序仍然可用。
     */
    console.warn('[videoRank] opencc 不可用，简繁归一退化为不转换:', err)
    return (s: string) => s
  }
})()

/**
 * 归一化：**简繁归一** + 去标签 + 转小写 + **去所有空白**
 *
 * 去空格是必须的：标题里常写「起风了 - 买辣椒也用券」，而歌名是「起风了」；
 * 歌名本身也可能带空格（`Shape of You`），两边都去空格才能稳定包含匹配。
 */
const normalize = (s: unknown): string =>
  toSimplified(stripHtml(s)).toLowerCase().replace(/\s+/g, '')

/**
 * 括号**开**字符的字符类（中英文都认，含 `【】〔〕〖〗`）
 *
 * 只用来「找第一个左括号的位置」—— 找到它，前面就是歌名、后面全是尾巴。
 * 不需要匹配「配对」：`splitSongName` 只关心**劈开点在哪儿**，
 * 至于尾巴里括号配对是否规整，靠 `stripBracketChars` 统一去掉符号就行。
 */
const BRACKET_OPEN = '[（(\\[【〔〖]'

/**
 * ★ **拆歌名**：把「正名」和「括号部分」分开
 *
 * ```
 * 溯(Reverse)feat.马吟吟      → { name: '溯',        tail: 'Reverse feat.马吟吟' }
 * 九重楼 (不敢独上九重楼)       → { name: '九重楼',    tail: '不敢独上九重楼' }
 * 起风了 (Live)               → { name: '起风了',    tail: 'Live' }
 * Going Home (回家) (萨克斯版)  → { name: 'Going Home', tail: '回家 萨克斯版' }
 * 晴天                        → { name: '晴天',      tail: '' }
 * (Intro)                     → { name: 'Intro',    tail: '' }   ← tail 没新信息
 * 【伴奏】晴天                  → { name: '伴奏 晴天', tail: '' }   ← 同上
 * ```
 *
 * ## 规则（用户定的）
 *
 * 1. **`name` = 第一个括号之前的全部内容** —— 那才是「歌名」。
 *    括号里的东西（`(Live)` / `(Reverse)` / `(不敢独上九重楼)`）和
 *    **括号后面的文字**（`feat.马吟吟`）都**不算歌名**。
 *
 *    > 为什么：`溯(Reverse)feat.马吟吟` 这种歌名里，真正的歌名只有「溯」——
 *    > 把 `feat.马吟吟` 留在歌名里，搜出去的是
 *    > `溯feat.马吟吟 马吟吟`（还和歌手名重复了一遍），某站很难匹配。
 *
 * 2. **`tail` = 第一个括号及其之后的全部内容**，括号符号去掉、多段用空格连、
 *    **重复的词去掉**（`(回家) (萨克斯版) (萨克斯版)` → `回家 萨克斯版`）。
 *    它和 `name` **互补**：`name` + `tail` 覆盖原串的全部有效信息，
 *    第 4 轮降级就用它搜（见 `biliApi` 的 `lastSuffix`）。
 *
 * 3. **括号前没有字**（`(Intro)` / `【伴奏】晴天` 里的第一个括号在最前）：
 *    `name` 退回用**括号里的内容**（连同括号后的字）—— 否则歌名空着就没法搜了。
 *
 * 4. **没有括号**：`name` = 原串、`tail` = `''`，行为与以前一致。
 *
 * 5. ★ **`tail` 里没有新信息时置空**（这条是用户指出来的）：
 *    规则 3 生效时，`name` 本来就是由 `tail` 撑起来的 —— 再拿 `tail` 去搜，
 *    第 4 轮的搜索词会和第 1 轮**一模一样**，纯属白发一次请求：
 *
 *    ```
 *    (Intro)       → name='Intro',      tail='Intro'       ← 重复！
 *    【伴奏】晴天    → name='伴奏 晴天',  tail='伴奏 晴天'   ← 重复！
 *    置空后：         → name=...,        tail=''            → 第4轮退回「可视化」
 *    ```
 *
 *    判定用**词集包含**（不是整串相等）：词序不同但信息等价也算重复。
 *    详见 `isCoveredBy`。
 */
export interface SplitSongName {
  /** 真正的歌名（第一个括号之前；括号前为空时退回括号内容） */
  name: string
  /** 第一个括号及其之后的全部内容（括号符号去掉、多段空格连接；无括号时为 ''） */
  tail: string
}

/**
 * 去掉括号符号并把**重复的词**去掉（只留字）
 *
 * ```
 * "回家 萨克斯版"            → "回家 萨克斯版"
 * "回家 萨克斯版 萨克斯版"     → "回家 萨克斯版"     ← 重复的词只留一次
 * ```
 *
 * ## 为什么必须去重（踩过）
 *
 * 歌单里出现过「同一个后缀写两遍」的数据：
 * `Going Home (回家) (萨克斯版) (萨克斯版)` —— 不去重的话第 4 轮的搜索词会变成
 * `… 回家 萨克斯版 萨克斯版`。重复词不增加信息量，却让搜索词变长变怪
 * （搜索词越长，某站越可能匹配不到）。
 *
 * 按**空格**切词去重而不是按整串比较：`(萨克斯版)` 与 `(萨克斯版)` 中间
 * 可能隔着别的段，整串比不出来；按词去重才抓得住。
 */
const stripBracketChars = (s: string): string => {
  const words = s
    .replace(/[（()）[\]【】〔〖〗]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
  /** 按出现顺序去重（第一次出现的位置决定了搜索词的词序，不宜打乱） */
  const unique = [...new Set(words)]
  return unique.join(' ')
}

/**
 * `tail` 是否**完全被** `name` 覆盖（即 tail 没有任何新信息）
 *
 * 按**词集**判断，不按整串：
 *
 * ```
 * name='伴奏 晴天'  tail='伴奏 晴天'   → true   （词集相同）
 * name='伴奏 晴天'  tail='晴天 伴奏'   → true   （顺序不同，信息等价）
 * name='溯'         tail='Reverse'    → false  （tail 有新词）
 * name=''          tail='Intro'       → false  （name 空时一切 tail 都算新信息）
 * ```
 *
 * 空串一律返回 `false`：`tail` 本来就是空的时候不用走这条判断
 * （调用方只在 `rest` 非空时才问）。
 */
const isCoveredBy = (tail: string, name: string): boolean => {
  if (!tail) return false
  const nameWords = new Set(name.split(/\s+/).filter(Boolean))
  if (nameWords.size === 0) return false
  const tailWords = tail.split(/\s+/).filter(Boolean)
  if (tailWords.length === 0) return false
  /** tail 的每个词都在 name 里出现 → 没有新信息 */
  return tailWords.every((w) => nameWords.has(w))
}

export const splitSongName = (input: unknown): SplitSongName => {
  const raw = stripHtml(input).trim()
  if (!raw) return { name: '', tail: '' }

  /** 第一个开括号的位置 —— 有它才谈「拆分」 */
  const firstOpen = raw.search(new RegExp(BRACKET_OPEN))
  if (firstOpen < 0) {
    /** 规则 4：没有括号，原样返回 */
    return { name: raw.replace(/\s+/g, ' ').trim(), tail: '' }
  }

  /** 规则 1：正名 = 第一个括号之前 */
  const head = raw.slice(0, firstOpen).replace(/\s+/g, ' ').trim()
  /** 规则 2：尾部 = 第一个括号之后的所有文字（括号符号去掉、重复词去掉） */
  const restRaw = raw.slice(firstOpen)
  const rest = stripBracketChars(restRaw)

  /** 规则 3：括号前没有字 → 用括号里的内容当歌名 */
  const songName = head || rest

  /**
   * ★ **规则 5：`tail` 里没有新东西时置空**
   *
   * 第 4 轮的作用是「用**歌名以外**的信息再搜一次」。如果 `tail` 的内容
   * 已经全部包含在 `name` 里，它就是**纯重复**，那一轮等于把第 1 轮的
   * 搜索词再发一次 —— 白浪费一次请求（还会推高被限制的概率）。
   *
   * 什么时候会这样：
   *
   * ```
   * 规则 3 的产物：(Intro)        → name='Intro',       tail 原样='Intro'
   *                【伴奏】晴天    → name='伴奏 晴天',   tail 原样='伴奏 晴天'
   * ```
   *
   * 这两种情况下 `name` 就是由 `tail` 撑起来的，再拿 `tail` 去搜毫无意义。
   * 置空后第 4 轮会退回 `可视化` 兜底（行为和「没有括号」一致）。
   *
   * 判定用「**词集包含**」而不是整串相等：`伴奏 晴天` 与 `晴天 伴奏`
   * 顺序不同但信息等价，也该算重复。
   */
  const tail = isCoveredBy(rest, songName) ? '' : rest

  return { name: songName, tail }
}

/**
 * 取「真正的歌名」（第一个括号之前的内容）
 *
 * 这是**搜索词与过滤判据共用的唯一来源** —— 两处必须用同一个名字，
 * 否则「搜的是 A、过滤却要求标题含 B」，会一条都过不了（踩过）。
 *
 * 实现委托给 `splitSongName`，细节见它的说明。
 *
 * ```
 * 溯(Reverse)feat.马吟吟      → 溯
 * 起风了 (Live)              → 起风了
 * 九重楼 (不敢独上九重楼)      → 九重楼
 * (Intro)                    → Intro     ← 括号前没字，用括号内容
 * 晴天                       → 晴天
 * ```
 */
export const baseSongName = (name: unknown): string => splitSongName(name).name

/**
 * 标题里取所有 `《…》` 段（也认 `〈〉`）
 *
 * 为什么要它：某站标题里的书名号**几乎总是指向"这首歌"**，
 * 所以它是最强的信号 —— 比"歌名出现在标题某处"精确得多。
 */
const bookTitlesOf = (title: string): string[] => {
  const out: string[] = []
  const re = /[《〈]([^》〉]*)[》〉]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(title)) !== null) out.push(m[1])
  return out
}

/**
 * 歌名后面紧跟这些词时，**算作"独立出现"**
 *
 * 它们是「这个视频是什么形式」的说明（`聊表心意` + `歌词排版`），
 * 而不是歌名的一部分。不认它们的话这些**正确的候选**会被判成
 * "歌名紧邻汉字"而丢掉（实测踩过）：
 *
 * ```
 * 刘惜君、薛之谦 - 聊表心意歌词排版透明通道     ← 该留（歌名后是"歌词排版"）
 * 刘惜君、薛之谦 - 聊表心意伴奏歌词排版透明通道  ← 该留
 * ```
 *
 * ⚠️ 与「别的歌名」的区别：`童话镇` 里的"镇"**不属于**这个表，
 * 所以 `童话镇` 依然会被判丢（那才是我们要挡的）。
 */
const TRAILING_FORM_WORDS = [
  '歌词排版',
  '歌词版',
  '字幕版',
  '字幕',
  '伴奏',
  '纯伴奏',
  '和声',
  '翻唱',
  '原唱',
  '完整版',
  '无损',
  '音质',
  '版',
  'mv',
  'live',
  'remix',
  'cover',
  'demo',
  'hd',
  '4k',
  '8k',
]

/**
 * 从 `idx` 开始，看歌名后面跟着的是不是「形式词」
 *
 * @returns 匹配到的形式词长度（0 = 不是）
 */
const trailingFormWordLen = (text: string, idx: number): number => {
  const rest = text.slice(idx)
  for (const w of TRAILING_FORM_WORDS) {
    if (rest.startsWith(w)) return w.length
  }
  return 0
}

/** 当分隔符用的"汉字区"字符（它们的实际作用等于竖线） */
const SEPARATOR_CHARS = new Set(['丨', '・', '｜'])

/** 是不是"词字符"：汉字 / 字母 / 数字。（符号、空格、串首尾都不算） */
const isWordChar = (c: string | undefined): boolean => {
  if (!c) return false
  if (SEPARATOR_CHARS.has(c)) return false
  const n = c.codePointAt(0) ?? 0
  if (n >= 0x4e00 && n <= 0x9fff) return true
  if (n >= 0x3400 && n <= 0x4dbf) return true
  if (/[0-9a-z]/.test(c)) return true
  return false
}

/**
 * 把字符串压成"无空白"形态，并记下**每个字符在原文里的下标**
 *
 * 用途：比对时要去空格（`Shape of You` ↔ `shapeofyou`），
 * 但判"前后是不是符号"必须回**原文**看邻居 —— 空格本身就是关键的分隔符，
 * 压缩后的串里它已经没了。
 *
 * 踩过：先 `normalize`（去空格）再判边界，于是「童话 光良」变成「童话光良」，
 * 右邻成了「光」→ 被误判成"紧邻汉字"而误杀（其实中间明明有空格）。
 */
const flattenWithMap = (s: string): { src: string; text: string; map: number[] } => {
  const src = toSimplified(s).toLowerCase()
  let text = ''
  const map: number[] = []
  for (let i = 0; i < src.length; i++) {
    if (/\s/.test(src[i])) continue
    text += src[i]
    map.push(i)
  }
  return { src, text, map }
}

/**
 * ★ 歌名是否在标题里**独立出现**（硬过滤的核心判据）
 *
 * ## 规则
 *
 *  1. **标题里有 `《…》`**：任一段**等于**歌名 → **通过**（书名号指向的就是它）。
 *     ⚠️ 书名号**只放行、不否决** —— 不匹配时**继续走规则 2**，不是丢弃。
 *     理由见下面函数体里的 ⚠️ 块（书名号也可能是电视剧名，曾因此误杀
 *     `【许茹芸】泪海（《真爱一世情》电视剧主题曲）`）。
 *  2. **其余情况**：看歌名前后是不是**符号 / 空格 / 串首尾**
 *     - 是 → 通过（「光良 - 童话」「童话 光良」「【罗艺恒】童话」）
 *     - 紧邻汉字 → 丢弃（「童话镇」「哥本哈根的童话」「红颜旧」）
 *     - 例外：**右边**紧跟「形式词」（`TRAILING_FORM_WORDS`）也算独立
 *
 * ## 为什么要有第 2 条（"独立出现"）
 *
 * 因为光判"标题含歌名"会放进**别的歌**（踩过）：
 *
 * ```
 * 搜「童话」→ 放进《童话镇》        ← 不是同一首歌
 * 搜「旧」  → 放进《红颜旧》《旧梦一场》← 不是同一首歌
 * ```
 *
 * 而「童话」在「童话镇」里是**词的一部分**，不是独立出现的歌名。
 *
 * ## ⚠️ 这条规则**必须**配简繁归一
 *
 * 否则「旧」会把 `不夠 - 舊『…』`（**正是用户要的那首**，只是繁体）也杀掉 ——
 * 简繁不同不是"另一首歌"。见 `toSimplified`。
 *
 * ## 已知代价
 *
 * `光良童话KTV纯享版`（同曲不同歌手，无分隔符）会被判丢 ——
 * 它与「童话镇」在**字符层面完全同构**（歌名后紧邻汉字），
 * 纯字符串规则无法区分。这是「宁可漏掉也不能放错」的必然代价。
 *
 * @param rawTitle 原始标题（**未归一化**，函数内部自己归一 —— 判边界要用原串）
 * @param wantName **已归一化**的歌名（无空白、小写、简体）
 */
const titleHasSongName = (rawTitle: string, wantName: string): boolean => {
  if (!wantName) return true

  /**
   * 规则 1：书名号里**等于**歌名 → 直接通过（最强信号）
   *
   * ⚠️ 但书名号**不能用来否决**（这里改过一次）：
   * 标题里的书名号也可能指向**电视剧 / 专辑 / 栏目**，而不是歌名：
   *
   * ```
   * 【许茹芸】泪海（《真爱一世情》电视剧主题曲）   ← 《…》是剧名，歌名"泪海"在别处
   * ```
   *
   * 早先的规则是"有书名号但都不等于歌名 → 丢弃"，于是上面这条**被误杀**。
   * 现在改成：书名号只用来**放行**，不匹配就继续走规则 2。
   */
  const books = bookTitlesOf(rawTitle)
  if (books.some((b) => normalize(b) === wantName)) return true

  /** 规则 2：看歌名是否**独立出现**（前后是符号 / 空格 / 串首尾） */
  const { src, text, map } = flattenWithMap(rawTitle)
  let i = 0
  while ((i = text.indexOf(wantName, i)) >= 0) {
    const startOrig = map[i]
    const endOrig = map[i + wantName.length - 1]
    const left = startOrig > 0 ? src[startOrig - 1] : ''
    const right = endOrig + 1 < src.length ? src[endOrig + 1] : ''
    /** 左右都是边界 → 通过 */
    if (!isWordChar(left) && !isWordChar(right)) return true
    /**
     * 右边紧邻的若是「形式词」（`歌词排版` / `伴奏` / `完整版`…），也算独立
     *
     * 那些词说的是"这个视频是什么形式"，不是歌名的一部分。
     */
    if (!isWordChar(left) && trailingFormWordLen(text, i + wantName.length) > 0) return true
    i++
  }
  return false
}
/**
 * 判断一条候选是否**通过硬过滤**
 *
 * 三条规则任一命中就丢弃：
 *  1. 标题里没有**独立出现**的歌名（详见 `titleHasSongName`）；
 *  2. 时长超出容差范围；
 *  3. 标题命中过滤关键词。
 *
 * @returns `true` = 保留
 */
export const passHardFilter = (
  video: RankableVideo,
  song: string,
  filterKeywords: string[],
  songDurationSec: number | null | undefined,
  toleranceSec: number,
  /** 是否无条件放宽上限（降级轮次用；不传则只在标题有 MV/Live 提示时放宽） */
  relaxUpperBound = false,
): boolean => {
  const rawTitle = stripHtml(video.title)
  const title = normalize(rawTitle)
  /** ★ 用 `baseSongName` 处理过的歌名来判（**第一个括号之前的那段**） */
  const songName = baseSongName(song)
  const want = normalize(songName)

  /**
   * ① 歌名必须出现（详见 `titleHasSongName`）
   *
   * ## ★ 带空格的歌名：**整串匹配不上就按词分别匹配**
   *
   * `baseSongName` 可能返回带空格的多词串 —— 最典型的是
   * `【伴奏】晴天`（括号在最前面，规则 3 退回时把括号内容和后面的字都带上了）
   * → 歌名 = `伴奏 晴天`。
   *
   * 而 `normalize` 会把空格去掉变成 `伴奏晴天`，要求标题里**连着**出现这 5 个字 ——
   * 实际标题是「伴奏 - 晴天」或「晴天（伴奏）」，根本连不起来，**必然全被挡**。
   *
   * 所以这类歌名拆成词分别判：**每个词都要在标题里独立出现**才算通过。
   * 比整串连着出现宽松（能容纳标题里的分隔符 / 调换顺序），
   * 又比「只匹配其中一个词」严格（`伴奏` 单命中不足以证明是这首歌）。
   *
   * ⚠️ 顺序：**先试整串**，不中才拆词 —— 单字歌名 / 普通歌名走整串，
   * 行为与以前完全一致，只有带空格的多词串才会走第二条路。
   */
  if (want && !titleHasSongName(rawTitle, want)) {
    const words = songName
      .split(/\s+/)
      .map((w) => normalize(w))
      .filter((w) => w.length > 0)
    /** 只有一个词（或拆完和整串一样）→ 拆词没有意义，直接判定不通过 */
    if (words.length <= 1) return false
    /** 每个词都得独立出现；任一不中就算这首歌不匹配 */
    if (!words.every((w) => titleHasSongName(rawTitle, w))) return false
  }

  /** ③ 命中屏蔽词直接丢（在时长之前判，省一次解析） */
  for (const kw of filterKeywords ?? []) {
    const k = normalize(kw)
    if (k && title.includes(k)) return false
  }

  /** ② 时长过滤（歌曲时长未知时**不过滤** —— 没参照物时任何判断都是瞎猜） */
  if (
    typeof songDurationSec === 'number' &&
    Number.isFinite(songDurationSec) &&
    songDurationSec > 0
  ) {
    /**
     * 视频时长**已经是秒**（`biliApi.extract` 在入口转好的，
     * 库里 `videos.duration` 存的也是秒）—— 直接用，不再解析。
     */
    const sec = video.duration
    /** 视频时长未知（`null` / 0）时**保留**（不因缺数据而误杀） */
    if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) {
      /**
       * 下界 = `max(歌长 - 容差, 歌长 × LOWER_BOUND_RATIO)`
       *
       * 两个条件各管一件事：
       *  - `歌长 - 容差`：正常的「允许比歌短多少」，由用户设的容差决定；
       *  - `歌长 × 系数`：**兜底下限**，防止容差设得很大时下界变成负数
       *    （那样任意短的视频都能过）。
       *
       * ## ⚠️ 系数原来是 0.5，用户改成 0.3
       *
       * 踩过：歌长 258 秒、容差 300 秒时
       * ```
       * 歌长 - 容差 = -42        ← 负数，被兜底顶掉
       * 歌长 × 0.5  = 129        ← 实际生效的下界
       * ```
       * 于是「设了 300 秒的大容差」**完全没起作用**，下界还是 129 ——
       * 把一条 117 秒的《歌颂》（标题正确、只是内容短）挡掉了。
       *
       * 改成 0.3 后同一个例子下界 = `258 × 0.3 = 77`，117 秒就能通过。
       */
      const lo = Math.max(songDurationSec - toleranceSec, songDurationSec * LOWER_BOUND_RATIO)
      /**
       * 上限：MV/Live/现场 类放宽 `×1.7`（降级轮次无条件放宽）
       *
       * 用**归一化后**的标题判断（小写、无空格），所以 `MV` / `mv` 都能命中。
       */
      const longForm = relaxUpperBound || LONG_FORM_HINT_RE.test(title)
      const factor = longForm ? LONG_FORM_FACTOR : 1
      const hi = songDurationSec + toleranceSec * factor
      if (sec < lo || sec > hi) return false
    }
  }

  return true
}

/**
 * 给一条候选打分（**只对已通过硬过滤的调用**）
 *
 * 两段：
 *  1. **歌手名命中 → `+100`**（断层）；
 *  2. 层内关键词加权（命中即累加，**无上限**）。
 *
 * ⚠️ 不需要 `song` 参数：**硬过滤已经保证标题含歌名了**，
 * 所以这里再判一次「歌名命中」永远是 true，没有信息量。
 * 早先留着它是为了「歌名+歌手同时命中」的分层，现在歌手单独成一层，
 * 那个判断就没用了。
 */
export const scoreVideo = (
  video: RankableVideo,
  singer: string,
  tagBonus: Record<string, string[]>,
): number => {
  const title = normalize(video.title)

  /**
   * 歌手名命中 → 断层分（`+100`）
   *
   * 歌手名可能带多个（`A、B`），所以按分隔符拆开逐个试 —— 命中任意一个就算命中。
   */
  const singerHit =
    Boolean(singer) &&
    singer
      .split(/[、,，/&]/)
      .map((s) => normalize(s))
      .filter(Boolean)
      .some((w) => title.includes(w))

  const layer = singerHit ? LAYER_BOTH : LAYER_NAME_ONLY

  /**
   * 层内：关键词加权**直接累加，不再 clamp**
   *
   * 用户给多少分就是多少分（`-20` 档的「伴奏」就该比 `-4` 档的乐器演奏低得多）。
   * 见文件头「关键词加权不再有上限」那段。
   */
  let bonus = 0
  for (const [score, keywords] of Object.entries(tagBonus ?? {})) {
    const value = Number(score)
    if (!Number.isFinite(value)) continue
    for (const kw of keywords ?? []) {
      const k = normalize(kw)
      if (k && title.includes(k)) bonus += value
    }
  }

  return layer + bonus
}

/**
 * 过滤 + 打分 + 排序（**一站式入口**）
 *
 * ## 排序规则
 *
 *  1. **收藏整段置顶**，相对顺序不变，**不参与打分**；
 *  2. 非收藏按总分降序；
 *  3. 同分保持某站原始顺序（V8 的 `sort` 是稳定排序）。
 *
 * ## ⚠️ 硬过滤**只作用于非收藏项**（这里改过一次）
 *
 * 收藏是**用户自己挑的**（点收藏，或者手动「添加视频」粘的链接）——
 * 它不该被「标题里有没有歌名」「时长对不对」这类**搜索匹配规则**判掉。
 *
 * 我第一版把收藏也一起过滤了，后果是：
 *  - 用户手动添加的视频（标题往往就是自己起的，不含歌名）**直接从列表消失**；
 *  - 「我收藏的怎么不见了」—— 而且刷新列表也找不回来，因为它被规则挡在门外。
 *
 * 过滤是**给搜索结果做筛选**的，收藏不参与筛选，只参与「置顶」。
 *
 * ## 收藏为什么也不参与打分
 *
 * 打分只看「标题像不像原唱」，与「有没有收藏」无关 ——
 * 一条收藏的翻唱被打到一堆高清原唱后面，收藏就白收藏了。
 * 用 `filter` 而不是排完再挑，因为 `filter` 天然保序，
 * 而「收藏之间的相对顺序」正是收藏置顶要保住的东西。
 *
 * @returns **新数组**（不修改入参）；被硬过滤掉的候选不在里面
 */
export const rankVideos = <T extends RankableVideo>(
  videos: T[],
  options: RankOptions,
): T[] => {
  const { songDurationSec, tagBonus, filterKeywords, durationToleranceSec, relaxUpperBound } =
    options
  /** 歌名与歌手是**两个独立参数**，直接用（不再从拼串里拆） */
  const { song, singer } = options

  /** 先把收藏摘出来 —— 它们**不参与过滤**，原样保留（顺序也不动） */
  const favorites = (videos ?? []).filter((v) => v?.favorites)

  const rest = (videos ?? []).filter(
    (v) =>
      !v?.favorites &&
      passHardFilter(v, song, filterKeywords, songDurationSec, durationToleranceSec, relaxUpperBound),
  )

  const scoreOf = (v: T): number => scoreVideo(v, singer, tagBonus)

  /**
   * `Array.prototype.sort` 在 V8 上是**稳定排序**，所以同分候选保持
   * 某站返回的顺序 —— 同分时不该由我们打乱。
   */
  const sorted = [...rest].sort((a, b) => scoreOf(b) - scoreOf(a))
  return [...favorites, ...sorted]
}
