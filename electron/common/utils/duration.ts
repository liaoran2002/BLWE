/**
 * 时长（秒）的归一化与格式化（主 / 渲染共用）
 *
 * **为什么要有这个文件**：同一件事——「把各种形状的时长变成秒」——原来在三处各写了一份
 * （`utils/cache.ts` 的 `toSeconds`、`main/utils/playlist.ts` 的隐式透传、
 * `components/showList.vue` 的 `formatSeconds`/`durationText`），而且形状还不止一种：
 *
 *  - 某站**搜索**接口给的是 `"4:03"` 字符串；
 *  - 某站 **view** 接口和本项目自己的库里（`videos.duration`、`playlist_songs.duration`）
 *    给的是**秒数**；
 *  - 音乐平台歌单给的是 `"4:03"` / `"1:02:03"` 字符串。
 *
 * schema v2 把 `playlist_songs.duration` 从「平台原样字符串」改成了**秒**，
 * 于是转换发生在存/取的两侧，再散落几份实现必然出现「一边按秒、一边按 mm:ss」的错。
 * 所以收在这里，主进程与渲染层共用同一份。
 *
 * 注意 `durationToSeconds` 对 `<= 0` 与非法输入一律返回 `null` 而不是 0：
 * 「未知时长」和「0 秒」在界面上是两种东西（前者该留空，后者是坏数据）。
 */

/**
 * 各种形状的时长 -> 秒
 *
 * 支持：数字（秒）/ `"4:03"` / `"1:02:03"` / `"100:00"` / 数字字符串 `"243"` / null。
 * 拿不到有效值（空串、非法、<= 0）时返回 `null`。
 *
 * ## 实现：按冒号 `split`，**不用正则**
 *
 * 曾经用正则 `^(\d{1,2}):(\d{2})(?::(\d{2}))?$` 去卡「分钟只能 1-2 位」，
 * 结果 **≥100 分钟的时长解析失败**：
 *
 * ```
 * "100:00"  → 正则不匹配 → 退回 Number("100:00") = NaN → null
 * ```
 *
 * 而平台的时长文案本来就允许总分钟超过 99（长串烧、全场 live 音频），
 * 我们自己写库用的 `formatPlayTime` 产出的也正是 `"100:00"` 这种形态 ——
 * 等于**自己写出去的值自己读不回来**。这会让那首歌的时长存成 NULL，
 * 于是时长过滤整段跳过（5 分钟的歌唱片会放进 50 分钟的合集）。
 *
 * 改成 `split(':')` 后，位数多长都认：
 *
 * ```
 * 2 段 → 分:秒        "4:03"    → 243
 * 3 段 → 时:分:秒     "1:02:03" → 3723
 * 4 段及以上 → 非法（返回 null）
 * ```
 *
 * 这样做还有个额外好处：**每段必须是纯数字**这个校验是天然成立的
 * （`Number('')` 是 0 但空段会被下面的 `some` 拦住，见实现）。
 */
export const durationToSeconds = (raw: unknown): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null

  /** 冒号形态（2 段或 3 段） */
  if (s.includes(':')) {
    const parts = s.split(':')
    /** 只认「分:秒」和「时:分:秒」两种形态 */
    if (parts.length !== 2 && parts.length !== 3) return null
    /** 每段都必须是非空数字串 —— `Number('')` 是 0，会把 "1::3" 错解成合法 */
    if (parts.some((p) => p.trim() === '' || !/^\d+$/.test(p.trim()))) return null
    const nums = parts.map((p) => Number(p.trim()))
    const total =
      nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1]
    return total > 0 ? total : null
  }

  /** 纯数字字符串（有的源直接给秒数文本） */
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/**
 * 秒 -> `mm:ss`（**总分钟数**会超过 59，例如 `"75:00"`）
 *
 * 刻意不做 `h:mm:ss`：这是**单曲**时长，超过一小时的极少，
 * 而库里存的、某站给的都是秒，统一按「总分钟:秒」展示最不容易看错
 * （和 `showList.vue` 原来的视频时长格式、以及音乐平台的写法一致）。
 *
 * 拿不到有效秒数时返回 `''`（调用方直接贴进模板就是空白，不用再判空）。
 */
export const formatDuration = (seconds: unknown): string => {
  const sec = typeof seconds === 'number' ? seconds : Number(seconds)
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${pad(m)}:${pad(s)}`
}
