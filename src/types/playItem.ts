/**
 * 播放队列里的一条：**歌**或者**视频**
 *
 * ## 为什么是联合类型，而不是把视频改造成歌
 *
 * 队列必须只用一种类型装两种来源 —— 播放器（MSE / 清晰度 / 预热 / 卡顿恢复 /
 * 续播）只写一遍，这是真的省事。但「队列统一」不等于「数据模型统一」：
 *
 *  - `PlaylistSong`：歌名 / 歌手，播放前要**搜索**出候选，再挑一个；
 *  - `VideoListItem`：标题 / UP 主 / bvid，**本身就是视频**，直接解析地址。
 *
 * 以前的做法是后者映射成前者的形状（`name` 装标题、`singer` 装 UP 主），
 * 于是下游只能靠 `if (item.bvid)` 猜这是不是视频，类型系统完全帮不上忙，
 * 每加一个视频功能都要先绕过这个假设一次。现在两者各保各的字段，
 * 判断改成**显式**的类型守卫，编译器能帮忙检查。
 *
 * ## 判别字段为什么是 `title`
 *
 * `VideoListItem.title` 必有、`PlaylistSong` 永远没有；而 `bvid` 曾经在
 * `PlaylistSong` 上也是可选字段，用它判别会重叠。
 */
import type { PlaylistSong, VideoListItem } from '@common/types/playlist'
import { toCacheKey } from '@common/types/playlist'

export type PlayItem = PlaylistSong | VideoListItem

/** 这一条是视频（自带 bvid，不需要搜索） */
export const isVideoItem = (item: PlayItem): item is VideoListItem => 'title' in item

/** 这一条是歌（要拿歌名 + 歌手去搜候选） */
export const isSongItem = (item: PlayItem): item is PlaylistSong => !isVideoItem(item)

/**
 * 显示用的主标题
 *
 * 视频的标题可能是空（库里 `videos.title` 还没拉到）—— 回退 bvid，
 * 至少界面上有一行能点的东西，而不是一片空白。
 */
export const titleOf = (item: PlayItem | null | undefined): string => {
  if (!item) return ''
  if (isVideoItem(item)) return item.title || item.bvid
  return item.name || ''
}

/** 显示用的副标题：视频是 UP 主，歌是歌手 */
export const subtitleOf = (item: PlayItem | null | undefined): string => {
  if (!item) return ''
  if (isVideoItem(item)) return item.author ?? ''
  return item.singer ?? ''
}

/** 封面（两种条目都有这个字段，取法一致） */
export const coverOf = (item: PlayItem | null | undefined): string | null =>
  item?.cover ?? null

/** 时长（秒） */
export const durationOf = (item: PlayItem | null | undefined): number | null =>
  item?.duration ?? null

/** 这一条对应的 bvid（歌没有就是 null） */
export const bvidOf = (item: PlayItem | null | undefined): string | null =>
  item?.bvid ?? null

/**
 * 这一条在会话内的**标识键**（用于「这个错误/定位是不是当前这条的」比较）
 *
 * - 视频：`bvid` 本身（全局唯一）
 * - 歌：`歌名-歌手`（也就是它的缓存键）
 *
 * ⚠️ 只用于**本进程内的相等比较**，不要写进数据库、也不要当搜索词。
 * 视频这边故意不加任何前缀：以前那个 `bv:` 前缀是为了让搜索接口认得出来，
 * 而搜索接口已经不看视频了（见 `types/playlist.ts` 顶部）。
 */
export const keyOf = (item: PlayItem | null | undefined): string => {
  if (!item) return ''
  if (isVideoItem(item)) return item.bvid
  if (!item.name) return ''
  return toCacheKey(item)
}
