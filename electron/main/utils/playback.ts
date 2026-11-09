/**
 * 播放状态读写（**两种东西、两个去处**）
 *
 * | 是什么 | 放哪 | 谁写 | 频率 |
 * | :--- | :--- | :--- | :--- |
 * | 上次在播哪条线的哪个列表、第几条 | 库（`playback_state` 单行：kind + id + index） | `saveProgress` | 只在切歌 / 切源时 |
 * | 播到第几秒 | `userData/last_position` 一个小文件 | `saveLastPosition` | 每秒 |
 *
 * ## 为什么「谁 + 第几条」必须挤在一行里
 *
 * 它们是同一个事实的三段：哪条线、哪个列表、第几条。拆开放（曾经下标在
 * `playlists` / `videolists` 各自的 `last_index` 上）就会两头打架：
 * 歌单侧持久化是整份覆盖、值来自渲染层内存，而 `saveProgress` 只改库不改内存 ——
 * 刚写对的下标被下一次持久化带着旧值冲回去，续播时就灵时不灵。
 *
 * 收进这张只有一行的表之后，任何「覆盖列表」的路径都碰不到它。
 *
 * ## 为什么「谁」必须进库而不是散文件
 *
 * 它要跟列表的存在性绑定：删列表、转本地换 id 时得跟着改（`remapPlaybackSource`），
 * 而散文件做不到这一点。以前它是个设置项（`player.activeVideoListId`），
 * 于是出现「视频列表落盘、当前歌单只存内存」这种一半能续播的状态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { PlaybackProgress, PlaybackSource, PlaybackSourceKind } from '@common/types/playback'
import { getDb } from './db'

interface PlaybackStateRow {
  source_kind: string | null
  source_id: string | null
  source_index: number
}

/** 没在播任何东西时的返回值 */
const EMPTY: PlaybackSource = { kind: '', id: '', index: 0, seconds: 0 }

/**
 * 记录播放秒数的文件（**故意不带后缀**）
 *
 * 内容就是一行数字，人眼看着也知道是什么；带 `.json` 会让人以为里面有结构。
 */
const POSITION_FILE = 'last_position'

const positionPath = (): string => path.join(app.getPath('userData'), POSITION_FILE)

/**
 * 读上次播到第几秒
 *
 * 文件不存在 / 内容不是数字 / 读失败都返回 0（从头播），不抛错 ——
 * 这只是个「续播到哪」的提示值，读不到不该影响启动。
 */
export const getLastPosition = (): number => {
  try {
    const value = Number(fs.readFileSync(positionPath(), 'utf8').trim())
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

/**
 * 写「播到第几秒」（每秒一次）
 *
 * 先写 `.tmp` 再 rename：进程在写一半时被杀，留下的也只会是完整内容
 * （rename 在同一分区上是原子的）。几字节的写不 fsync，掉电丢了最多回退几秒。
 */
export const saveLastPosition = (seconds: number): void => {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  try {
    const file = positionPath()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, String(value), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    console.warn('[playback] 记录播放秒数失败:', err)
  }
}

/**
 * 读「上次在播的是哪条线的哪个列表的第几条」+ 秒数
 *
 * 秒数来自小文件，和库里的记录拼在一起返回 —— 续播时调一次
 * `getPlaybackSource()` 就能拿全「回到哪个列表的第几条的第几秒」。
 */
export const getPlaybackSource = (): PlaybackSource => {
  const seconds = getLastPosition()
  try {
    const row = getDb()
      .prepare(`SELECT source_kind, source_id, source_index FROM playback_state WHERE id = 1`)
      .get() as PlaybackStateRow | undefined
    if (!row || !row.source_kind || !row.source_id) return { ...EMPTY, seconds }
    return {
      kind: row.source_kind === 'ov' ? 'ov' : 'mv',
      id: row.source_id,
      index: Math.max(0, Math.floor(row.source_index) || 0),
      seconds,
    }
  } catch (err) {
    console.warn('[playback] 读取播放状态失败:', err)
    return { ...EMPTY, seconds }
  }
}

/**
 * 改「当前在播的是谁」（**下标归零**）
 *
 * 只在切源时用：换了一个列表，上一个列表的第几条对新列表毫无意义。
 * 正常播放过程中不需要单独调它 —— `saveProgress` 会顺带写好。
 */
export const setPlaybackSource = (kind: PlaybackSource['kind'], id: string): void => {
  getDb()
    .prepare(
      `INSERT INTO playback_state (id, source_kind, source_id, source_index, updated_at)
       VALUES (1, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_kind  = excluded.source_kind,
         source_id    = excluded.source_id,
         source_index = CASE
           -- 同一个源重复调（幂等），别把正在播的位置清掉
           WHEN playback_state.source_kind = excluded.source_kind
            AND playback_state.source_id   = excluded.source_id
           THEN playback_state.source_index
           ELSE 0
         END,
         updated_at   = excluded.updated_at`,
    )
    .run(kind || null, id || null, Date.now())
}

/**
 * 上报「切到哪一条」（**写库的唯一入口**）
 *
 * 一行 UPSERT，不碰任何列表表 —— 列表表里已经没有下标了。
 *
 * `id` 为空表示当前没有可写的目标（比如视频列表被删、视频还在放），
 * 这时**什么都不做**：保留上一次的有效记录，比清空它更接近用户预期。
 */
export const saveProgress = (progress: PlaybackProgress): void => {
  const { kind, id } = progress
  if (!id) return
  const index = Math.max(0, Math.floor(progress.index) || 0)
  getDb()
    .prepare(
      `INSERT INTO playback_state (id, source_kind, source_id, source_index, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_kind  = excluded.source_kind,
         source_id    = excluded.source_id,
         source_index = excluded.source_index,
         updated_at   = excluded.updated_at`,
    )
    .run(kind, id, index, Date.now())
}

/**
 * 同步后重定位下标（**只在当前源就是它时才写**）
 *
 * 列表重新同步 / 换平台后曲目顺序会变，第 N 个位置可能已经是别的条目。
 * 主进程此刻同时握着旧列表和新列表，正是算「原来那条现在排第几」的时机。
 *
 * 别的列表不动：它们的位置本来就是历史残留，改了反而是凭空的写入。
 */
export const relocatePlaybackIndex = (
  kind: PlaybackSourceKind,
  id: string,
  index: number,
): void => {
  const current = getPlaybackSource()
  if (current.kind !== kind || current.id !== id) return
  saveProgress({ kind, id, index })
}

/**
 * 删掉某个列表 / 歌单时，把指向它的播放源改成新 id（或清空）
 *
 * 转换本地列表会换一个新 id，删除则彻底没有 —— 两种情况都要跟过去，
 * 否则 `playback_state` 会指向一个不存在的 id，下次启动读不到东西还查不出原因。
 * 换 id 时**下标原样保留**（还是同一个列表，位置没变）。
 */
export const remapPlaybackSource = (
  kind: PlaybackSource['kind'],
  oldId: string,
  newId: string,
): void => {
  const current = getPlaybackSource()
  if (current.kind !== kind || current.id !== oldId) return
  if (!newId) {
    clearPlaybackSource()
    return
  }
  getDb()
    .prepare(
      `UPDATE playback_state
          SET source_id = ?, updated_at = ?
        WHERE id = 1`,
    )
    .run(newId, Date.now())
}

/** 清空播放源（比如整库重建后） */
export const clearPlaybackSource = (): void => {
  setPlaybackSource('', '')
}
