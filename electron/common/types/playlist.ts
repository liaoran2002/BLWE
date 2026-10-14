/**
 * 歌单数据结构（主 / 渲染共用）
 *
 * 从「单个歌单」升级为「歌单集合」，并补上：
 *  - 自动同步策略（启动时 / 定时）
 *  - 每首歌已选定的 B 站视频（bvId），用于续播时优先还原上次看的那个视频
 *  - 每个歌单自己的播放位置，切歌单不丢进度
 */

/** 歌单同步策略 */
export type PlaylistSyncMode = 'off' | 'startup' | 'interval'

export interface PlaylistSync {
  mode: PlaylistSyncMode
  /** mode === 'interval' 时的间隔（毫秒） */
  intervalMs: number
}

/**
 * 一首歌「收藏」的视频、以及「上次播的是哪个视频」，**都已经不在这个文件里了**。
 *
 * 改造后它们存在 SQLite 的 `videos` / `song_meta` 两张表中（见
 * `electron/main/utils/cache.ts` 的 `VideoRow` 与收藏相关函数）：
 *  - 收藏：`videos.favorites` + `videos.ord`（顺带承载列表顺序）
 *  - 上次播的：`song_meta.selected_bvid`
 *
 * 为什么搬走：两者都是**按搜索键**索引、且带「列表顺序」语义的数据，
 * 和歌单（按 id 索引、全量覆盖）的写入节奏完全不同。以前塞在歌单记录里，
 * 每次切歌/收藏都要把整个歌单集合 `savePlaylists` 全量覆盖一遍，
 * 同步进行时还会被 `syncingIds` 拦下来（收藏丢了都没人知道）。
 * 原来的 `VideoRef` / `FavoriteVideo` 两个接口因此一并删除。
 */

/**
 * 歌单里的一首歌（结构化）
 *
 * 之前 songs 是 `"歌名-歌手"` 字符串数组，没法展示封面/专辑/歌手。
 * 现在改成对象，并用 toSearchKey() 拼出与旧版完全一致的搜索键，
 * 这样 matchScore / nameBonus / 缓存 key 那条链路一行都不用改。
 */
export interface PlaylistSong {
  name: string
  singer: string
  album?: string
  /** 音乐平台给的专辑封面；可能为空（如酷我列表接口不返回封面） */
  cover?: string | null
  /**
   * 时长（**秒**）
   *
   * 原来存的是音乐平台原样给的 `"4:03"` 字符串，而候选视频那边
   * （`videos.duration`）一直是秒 —— 两种形状在下游到处判断。
   * schema v2 起统一成秒，展示时用 `formatDuration()` 转回 `mm:ss`。
   */
  duration?: number | null
  /**
   * 平台侧歌曲 id（QQ 数字 id / 网易云 id / 酷我 rid）
   *
   * 歌单导入时从音源带过来，**取歌词时用它精确定位** ——
   * 不用拿「歌名 + 歌手」重新搜（那是模糊搜索，可能搜到别的版本，
   * 于是显示错误的歌词）。
   */
  platformId?: string | null
  /** 来源音源（`wy` / `tx` / `kw`），与 `platformId` 配对 */
  source?: string
}

/**
 * 搜索键：拼成 `"歌名-歌手"`，与旧版字符串格式保持一致
 */
export const toSearchKey = (song: PlaylistSong): string =>
  song.singer ? `${song.name}-${song.singer}` : song.name

/** 把旧的 `"歌名-歌手"` 字符串解析成结构化歌曲 */
export const parseSearchKey = (text: string): PlaylistSong => {
  const raw = String(text ?? '').trim()
  // 只按第一个 '-' 切分：歌名本身可能带 '-'
  const idx = raw.indexOf('-')
  if (idx < 0) return { name: raw, singer: '' }
  return {
    name: raw.slice(0, idx).trim(),
    singer: raw.slice(idx + 1).trim(),
  }
}

/**
 * 一个歌单
 */
export interface PlaylistRecord {
  id: string
  name: string
  /** 来源音源（wy / tx / kw），手动创建时可能为空 */
  source?: string
  /** 原始分享链接，用于自动同步时重新解析 */
  sourceUrl?: string
  songs: PlaylistSong[]
  sync: PlaylistSync
  /** 上次同步成功时间（毫秒时间戳） */
  lastSyncAt: number | null
  createdAt: number
  updatedAt: number
  /** 该歌单上一次播放到第几首 */
  lastIndex: number
}


/** playlists.json 的结构 */
export interface PlaylistStoreData {
  version: string
  /** 当前选中的歌单 id */
  currentId: string | null
  playlists: PlaylistRecord[]
}

/** 一个歌单的同步结果摘要（用于 UI 提示） */
export interface SyncResult {
  id: string
  name: string
  ok: boolean
  /** 同步后的曲目数 */
  count?: number
  added?: number
  removed?: number
  error?: string
}


/**
 * 一个歌单是否可以自动同步
 *
 * 必须同时满足：有原始分享链接 + 同步方式不是「手动」。
 * 界面与调度都以此为准，避免两边判断不一致。
 */
export const isAutoSyncable = (p: PlaylistRecord): boolean =>
  !!p.sourceUrl && p.sync.mode !== 'off'

/** 歌单的同步间隔（毫秒）；非定时模式返回 0 */
export const getSyncInterval = (p: PlaylistRecord): number =>
  p.sync.mode === 'interval' ? Math.max(0, p.sync.intervalMs || 0) : 0

/**
 * 该歌单此刻是否到了该同步的时间
 *
 * @param now 当前时间戳
 */
export const isSyncDue = (p: PlaylistRecord, now: number): boolean => {
  const interval = getSyncInterval(p)
  if (!interval) return false
  if (!p.lastSyncAt) return true
  return now - p.lastSyncAt >= interval
}

/** IPC：读取 / 保存歌单集合 */
export interface PlaylistSaveParams {
  playlists: PlaylistRecord[]
  currentId: string | null
}
