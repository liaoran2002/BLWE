/**
 * 搜索结果的匹配打分与排序（主 / 渲染共用）
 *
 * **为什么要有这个文件**：这套打分逻辑原来住在渲染层 `App.vue` 的
 * `sortSearchedVideos()` / `matchScore()` / `nameBonus()` / `tagBonus()` 里，
 * 于是产生了一个很难发现的不一致 ——
 *
 *  - 主进程写进 `videos.ord` 的顺序是「收藏 + 其余按 B 站搜索顺序」；
 *  - 渲染层拿到列表后又按打分把「其余」重排了一遍。
 *
 * 也就是说**界面显示的顺序和库里存的 `ord` 是两套**。日常看不太出来（收藏都在一起），
 * 但「收藏再取消来提升顺序」这种用法一重新搜索就散 —— 因为库里那份顺序里
 * 没有被打分影响过，取消收藏后它就回到 B 站顺序了。
 *
 * 现在把打分抽到这里，**由主进程在写库之前调用**，让 `ord` 直接等于最终显示顺序；
 * 渲染层不再排序，只负责画。抽成共享模块而不是在主进程重写一份：
 * 两处各写一份必然漂移，而这个函数的返回值直接决定用户看到什么。
 *
 * 依赖只有三个入参（`title` / 搜索键 / `player.tagBonus` 设置），都是纯数据，
 * 所以主进程和渲染层都能直接用。
 */

/** 一首歌的搜索键 `"歌名-歌手"`（与 `toSearchKey` 同格式） */
export type SearchKey = string

/**
 * 子序列匹配分：搜索键里的字符能按顺序在标题里找到多少个
 *
 * 不是「包含」判断 —— 逐字符贪心匹配，所以标题里散落着这些字也能得分。
 * 这就是老实现的行为，保留不动（换算法会让所有人的候选顺序都变）。
 */
export const matchScore = (title: string, keywords: string): number => {
  const t = (title || '').replace(/<[^>]*>/g, '').toLowerCase()
  const k = keywords.toLowerCase().replace(/\s/g, '')
  let score = 0
  let remaining = t
  for (const ch of k) {
    const idx = remaining.indexOf(ch)
    if (idx !== -1) {
      score++
      remaining = remaining.slice(0, idx) + remaining.slice(idx + 1)
    }
  }
  return score
}

/**
 * 标题关键词加权
 *
 * `bonusTable` 就是设置里的 `player.tagBonus`：`{ 分值: [关键词...] }`，
 * 命中一个关键词就按它的分值加/减权（负数是降权）。
 */
export const tagBonus = (title: string, bonusTable: Record<string, string[]>): number => {
  const t = (title || '').replace(/<[^>]*>/g, '')
  if (!t) return 0
  let bonus = 0
  const lower = t.toLowerCase()
  for (const [score, keywords] of Object.entries(bonusTable ?? {})) {
    const value = Number(score)
    if (!Number.isFinite(value)) continue
    for (const kw of keywords ?? []) {
      if (kw && lower.includes(String(kw).toLowerCase())) bonus += value
    }
  }
  return bonus
}

/**
 * 歌名 / 歌手是否出现在标题里
 *
 * 同时命中歌名与歌手给得最高（+13）—— 那基本就是原曲。
 */
export const nameBonus = (title: string, songName: string, artistName: string): number => {
  if (!title) return 0
  const t = title.replace(/<[^>]*>/g, '')
  let bonus = 0
  const songMatch = Boolean(songName) && t.includes(songName)
  const artistMatch = Boolean(artistName) && t.includes(artistName)
  if (songMatch) bonus += 5
  if (artistMatch) bonus += 3
  if (songMatch && artistMatch) bonus += 5
  return bonus
}

/** 一条候选视频排序所需的最小形状 */
export interface RankableVideo {
  bvid?: string
  title?: string
  favorites?: boolean
}

/**
 * 给一批候选排序：**收藏整段保持在最前（相对顺序不动），其余按打分排**
 *
 * 为什么收藏那一段不参与打分：打分只看「标题像不像原曲」，跟「有没有收藏」
 * 毫无关系 —— 一位收藏的翻唱会被排到一堆高清原唱后面，收藏就白收藏了。
 * 用 `filter` 而不是 sort 后挑，因为 `filter` 天然保序，而「收藏之间的
 * 相对顺序」正是收藏置顶功能要保住的东西。
 *
 * @param songName 搜索键 `"歌名-歌手"`（打分要从里面拆出歌名和歌手）
 */
export const sortByRelevance = <T extends RankableVideo>(
  videos: T[],
  songName: string,
  bonusTable: Record<string, string[]>,
): T[] => {
  const favorites = videos.filter((v) => v?.favorites)
  const rest = videos.filter((v) => !v?.favorites)

  const keywords = songName.replace(/-/g, '').trim()
  const parts = songName.split('-').map((s) => s.trim())
  const realSongName = parts[0] || ''
  const artistName = parts[1] || ''

  const scoreOf = (v: T): number =>
    matchScore(v.title ?? '', keywords) +
    nameBonus(v.title ?? '', realSongName, artistName) +
    tagBonus(v.title ?? '', bonusTable)

  /**
   * `Array.prototype.sort` 在 V8 上是稳定排序，所以同分候选保持
   * B 站返回的顺序 —— 这一点很重要：同分时不该由我们随机打乱。
   */
  const sorted = [...rest].sort((a, b) => scoreOf(b) - scoreOf(a))
  return [...favorites, ...sorted]
}
