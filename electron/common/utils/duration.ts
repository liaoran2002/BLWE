/**
 * 时长（秒）的归一化与格式化（主 / 渲染共用）
 *
 * **为什么要有这个文件**：同一件事——「把各种形状的时长变成秒」——原来在三处各写了一份
 * （`utils/cache.ts` 的 `toSeconds`、`main/utils/playlist.ts` 的隐式透传、
 * `components/showList.vue` 的 `formatSeconds`/`durationText`），而且形状还不止一种：
 *
 *  - B 站**搜索**接口给的是 `"4:03"` 字符串；
 *  - B 站 **view** 接口和本项目自己的库里（`videos.duration`、`playlist_songs.duration`）
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
 * 支持：数字（秒）/ `"4:03"` / `"1:02:03"` / 数字字符串 `"243"` / null / 其它脏数据。
 * 拿不到有效值（<空串、非法、<= 0）时返回 `null`。
 */
export const durationToSeconds = (raw: unknown): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return null
    /**
     * 冒号形态：`m:ss` 或 `h:mm:ss`
     *
     * 时/分都限 1-2 位、秒固定 2 位 —— 和音乐平台与 B 站的文案一致。
     * 不按「冒号个数」硬切是为了让 `1:2:3` 这种不合规的写法自然掉到下面当数字解析失败
     * （返回 null），而不是被错解成 1 小时 2 分 3 秒。
     */
    const parts = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
    if (parts) {
      const a = Number(parts[1])
      const b = Number(parts[2])
      const c = parts[3] ? Number(parts[3]) : 0
      return parts[3] ? a * 3600 + b * 60 + c : a * 60 + b
    }
    // 纯数字字符串（有的源直接给毫秒之外的秒数文本）
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  }
  return null
}

/**
 * 秒 -> `mm:ss`（**总分钟数**会超过 59，例如 `"75:00"`）
 *
 * 刻意不做 `h:mm:ss`：这是**单曲**时长，超过一小时的极少，
 * 而库里存的、B 站给的都是秒，统一按「总分钟:秒」展示最不容易看错
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
