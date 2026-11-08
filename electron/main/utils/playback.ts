/**
 * 播放状态读写（**分两层，两层职责不同**）
 *
 * | 是什么 | 放哪 | 谁写 | 频率 |
 * | :--- | :--- | :--- | :--- |
 * | 上次在播哪条线的哪个列表 + 第几条 | 库（`playback_state` + 各表 `last_index`） | `saveProgress` | 只在切歌 / 切源时 |
 * | 播到第几秒 | `userData/last_position` 一个小文件 | `saveLastPosition` | 每秒 |
 *
 * ## 为什么秒数不进库
 *
 * 它是一条**全局的当前播放位置**：换列表、换来源，下一次播放就把它覆盖掉了，
 * 按列表各存一份没有意义（那是过度设计，我加过又撤了）。进库还意味着每秒一次
 * 事务 + WAL 增长，而它丢了最多少续几秒 —— 一个几字节的文本文件刚好。
 *
 * ## 为什么「谁」必须进库
 *
 * 它要跟列表的存在性绑定：删列表、转本地换 id 时得跟着改（`remapPlaybackSource`），
 * 而散文件做不到这一点。以前它是个设置项（`player.activeVideoListId`），
 * 于是出现「视频列表落盘、当前歌单只存内存」这种一半能续播的状态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { PlaybackProgress, PlaybackSource } from '@common/types/playback'
import { getDb, tx } from './db'

interface PlaybackStateRow {
  source_kind: string | null
  source_id: string | null
}

/** 没在播任何东西时的返回值 */
const EMPTY: PlaybackSource = { kind: '', id: '', seconds: 0 }

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
 * 读「上次在播的是哪条线的哪个列表」+ 秒数
 *
 * 秒数来自小文件，和库里的记录拼在一起返回 —— 调用方一次就能拿全
 * 「回到哪个列表的第几条的第几秒」。
 */
export const getPlaybackSource = (): PlaybackSource => {
  const seconds = getLastPosition()
  try {
    const row = getDb()
      .prepare(`SELECT source_kind, source_id FROM playback_state WHERE id = 1`)
      .get() as PlaybackStateRow | undefined
    if (!row || !row.source_kind || !row.source_id) return { ...EMPTY, seconds }
    return { kind: row.source_kind === 'ov' ? 'ov' : 'mv', id: row.source_id, seconds }
  } catch (err) {
    console.warn('[playback] 读取播放状态失败:', err)
    return { ...EMPTY, seconds }
  }
}

/**
 * 改「当前在播的是谁」（不带进度）
 *
 * 只在切源时用。正常播放过程中不需要单独调它 —— `saveProgress` 会顺带写好。
 */
export const setPlaybackSource = (kind: PlaybackSource['kind'], id: string): void => {
  const db = getDb()
  db.prepare(
    `INSERT INTO playback_state (id, source_kind, source_id, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source_kind = excluded.source_kind,
       source_id   = excluded.source_id,
       updated_at  = excluded.updated_at`,
  ).run(kind || null, id || null, Date.now())
}

/**
 * 上报「切到哪一条」（**写库的唯一入口**）
 *
 * 两件事一起做，放在同一个事务里：`playback_state` 记「在播谁」、
 * 对应表记「第几条」。避免「源切了、下标没写」这种半截状态 ——
 * 那会让下次启动恢复到 A 列表，却拿着 B 列表的下标。
 *
 * `id` 为空表示当前没有可写的目标（比如视频列表被删、视频还在放），
 * 这时**什么都不做**：保留上一次的有效记录，比清空它更接近用户预期。
 */
export const saveProgress = (progress: PlaybackProgress): void => {
  const { kind, id } = progress
  if (!id) return
  const index = Math.max(0, Math.floor(progress.index) || 0)
  const now = Date.now()

  tx(() => {
    const db = getDb()
    db.prepare(
      `INSERT INTO playback_state (id, source_kind, source_id, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_kind = excluded.source_kind,
         source_id   = excluded.source_id,
         updated_at  = excluded.updated_at`,
    ).run(kind, id, now)

    const table = kind === 'ov' ? 'videolists' : 'playlists'
    db.prepare(`UPDATE ${table} SET last_index = ?, updated_at = ? WHERE id = ?`).run(
      index,
      now,
      id,
    )
  })
}

/**
 * 删掉某个列表 / 歌单时，把指向它的播放源改成新 id（或清空）
 *
 * 转换本地列表会换一个新 id，删除则彻底没有 —— 两种情况都要跟过去，
 * 否则 `playback_state` 会指向一个不存在的 id，下次启动读不到东西还查不出原因。
 */
export const remapPlaybackSource = (
  kind: PlaybackSource['kind'],
  oldId: string,
  newId: string,
): void => {
  const current = getPlaybackSource()
  if (current.kind !== kind || current.id !== oldId) return
  setPlaybackSource(newId ? kind : '', newId)
}

/** 清空播放源（比如整库重建后） */
export const clearPlaybackSource = (): void => {
  setPlaybackSource('', '')
}
