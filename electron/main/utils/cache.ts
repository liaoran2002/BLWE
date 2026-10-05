/**
 * 搜索缓存管理（主进程）
 *
 * 背景：原实现只写不删、且**从不检查 `timestamp`** ——
 * 也就是说配置里的 `cache.maxAge` 是个死设置。实测 107 个文件 / 45MB，
 * 其中 88% 已超过 3 天，单个文件最大 7.4MB（缓存了整包 B 站搜索响应）。
 *
 * 现在补上三件事：
 *  1. `cache.maxAge` 真正生效：读取时判断是否过期，过期按未命中处理并删除
 *  2. 容量上限 + LRU 淘汰：文件数超过上限时，按「最久未使用」优先删除
 *  3. 维护一份轻量内存索引，避免为了淘汰而频繁 stat 整个目录
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getSetting } from './setting'
import { writeJsonAtomic } from './atomicJson'
import type { CacheStats } from '@common/types/cache_stats'

export interface CacheEntry<T = unknown> {
  /** 写入时间 */
  timestamp: number
  /** 最后一次被读取的时间（LRU 依据）；老数据可能没有 */
  lastUsed?: number
  /** 关键词原文：文件名是它的 md5，读出来对一下，避免极端的撞名 */
  keyword?: string
  data: T
}

/**
 * 缓存文件数上限
 *
 * 不直接按字节限制，是因为单文件差异极大（100KB ~ 7MB）：
 * 按个数控制更可预期，配合 maxAge 足以把体积压下来。
 */
const MAX_CACHE_FILES = 300
/** 触发淘汰后，回落到这个数量以下，避免每次写入都触发一轮清理 */
const EVICT_TARGET = Math.floor(MAX_CACHE_FILES * 0.8)

interface IndexItem {
  file: string
  lastUsed: number
}

/** 内存索引：文件名 -> 使用信息 */
const index = new Map<string, IndexItem>()
let indexReady = false
/** 淘汰重入保护 */
let evicting = false

const getCacheDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'search-cache')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * 缓存文件名 = 关键词的 md5
 *
 * 不能只做「清洗非法字符」：`"A/B"` 与 `"AB"`、`"夜曲:前奏"` 与 `"夜曲前奏"`
 * 清洗后会落到同一个文件，两个关键词的搜索结果互相串味；
 * 全是非法字符的关键词会落到 `.json`，超长关键词还会 ENAMETOOLONG（save 静默失败）。
 * md5 之后长度固定、字符集安全，关键词原文留在 entry 里，读出来对不上就当未命中。
 *
 * 改命名时**不做旧文件迁移**：`search-cache/` 里全是搜索缓存，重新搜一次的成本
 * 远低于维护一条兼容分支 —— 需要的话直接在设置里「全部清除」。
 */
const fileNameOf = (keyword: string): string =>
  `${createHash('md5').update(keyword, 'utf8').digest('hex')}.json`

/**
 * 首次使用时建立索引
 *
 * `lastUsed` 取 mtime —— 老的缓存文件里没有这个字段，
 * 而 mtime 正好能反映「最后一次写入/读取后的落盘时间」，
 * 用它做 LRU 排序足够准确。
 */
const buildIndex = (): void => {
  index.clear()
  try {
    const dir = getCacheDir()
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const stat = fs.statSync(path.join(dir, file))
        index.set(file, { file, lastUsed: stat.mtimeMs })
      } catch {
        /* 单个文件 stat 失败就跳过 */
      }
    }
  } catch (err) {
    console.error('[cache] 建立索引失败:', err)
  }
}

const ensureIndex = (): void => {
  if (indexReady) return
  indexReady = true
  buildIndex()
}

/**
 * 重新扫描目录，把索引与磁盘对齐
 *
 * 为什么需要：索引是常驻内存的，但缓存目录里的文件数**可能被外部改变**
 * （上一次进程没走正常退出、用户手动删了文件、杀软清理等）。
 * 如果只信内存，就会出现「明明有文件却统计不到 / prune 清不掉」的问题。
 *
 * 注意：只增不删的合并（新文件加进来，已知文件保留内存里的 lastUsed），
 * 这样既能看到外部新增，又不会丢掉 LRU 的读访问信息。
 */
const refreshIndex = (): void => {
  indexReady = true
  try {
    const dir = getCacheDir()
    let added = 0
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      if (index.has(file)) continue
      try {
        const stat = fs.statSync(path.join(dir, file))
        index.set(file, { file, lastUsed: stat.mtimeMs })
        added++
      } catch {
        /* 跳过 */
      }
    }
    // 磁盘上已经没有的，从索引里去掉
    for (const file of [...index.keys()]) {
      if (!fs.existsSync(path.join(dir, file))) index.delete(file)
    }
    if (added > 0) console.log(`[cache] 索引已同步，新增 ${added} 个文件`)
  } catch (err) {
    console.error('[cache] 刷新索引失败:', err)
  }
}

/** 安全删除一个缓存文件 */
const removeFile = (file: string): void => {
  try {
    fs.unlinkSync(path.join(getCacheDir(), file))
    index.delete(file)
  } catch {
    // 文件被占用/已删除都不影响主流程，索引仍移除以免反复尝试
    index.delete(file)
  }
}

/**
 * 淘汰：先按 maxAge 清过期，再按 LRU 压到目标数量以下
 *
 * 失败不抛出 —— 缓存清理是尽力而为，绝不能影响正常播放。
 */
const evictIfNeeded = (force = false): void => {
  if (evicting) return
  ensureIndex()
  // 清理前先与磁盘对齐，否则「外部新增的过期文件」会被漏掉
  refreshIndex()

  const maxAge = Number(getSetting()['cache.maxAge']) || 0
  const now = Date.now()
  const needAgeSweep = maxAge > 0
  const needLru = force || index.size > MAX_CACHE_FILES
  if (!needAgeSweep && !needLru) return

  evicting = true
  try {
    let removedByAge = 0
    if (needAgeSweep) {
      for (const item of [...index.values()]) {
        if (now - item.lastUsed > maxAge) {
          removeFile(item.file)
          removedByAge++
        }
      }
    }

    let removedByLru = 0
    if (index.size > (needLru ? EVICT_TARGET : MAX_CACHE_FILES)) {
      // 最久未使用的排前面
      const sorted = [...index.values()].sort((a, b) => a.lastUsed - b.lastUsed)
      const overflow = index.size - EVICT_TARGET
      for (let i = 0; i < overflow && i < sorted.length; i++) {
        removeFile(sorted[i].file)
        removedByLru++
      }
    }

    if (removedByAge || removedByLru) {
      console.log(
        `[cache] 已清理：过期 ${removedByAge} 个，LRU 淘汰 ${removedByLru} 个，剩余 ${index.size} 个`,
      )
    }
  } catch (err) {
    console.error('[cache] 淘汰失败:', err)
  } finally {
    evicting = false
  }
}

export async function get<T = unknown>(keyword: string): Promise<CacheEntry<T> | null> {
  try {
    ensureIndex()
    const file = fileNameOf(keyword)
    const filePath = path.join(getCacheDir(), file)
    if (!fs.existsSync(filePath)) {
      index.delete(file)
      return null
    }

    const raw = fs.readFileSync(filePath, 'utf-8')
    const entry = JSON.parse(raw) as CacheEntry<T>
    /**
     * 坏条目兜底：没有 `data` 的缓存等于空。
     *
     * 曾经踩过：`save()` 里传了 `undefined`，`JSON.stringify` 会把 `data` 字段整个丢掉，
     * 于是磁盘上留下 `{"timestamp":…,"keyword":…}` 这种文件，之后每次读到它都会
     * 在下游炸出 `Cannot read properties of undefined (reading 'data')`。
     * 读到就顺手删掉，让它自愈。
     */
    if (entry == null || typeof entry !== 'object' || entry.data == null) {
      removeFile(file)
      return null
    }
    /**
     * 形状检查：搜索缓存里存的必须是**整包 B 站返回体**（带 `code`）。
     *
     * 曾经有一版构建把里层的 `data` 存了进来（`{result, selectedBvid}`），
     * 这种条目少了 `code`，下游 `payload.data.result` 会取不到、每次都得重新联网。
     * 认出来就直接删掉，让下一次写入恢复正常形状。
     */
    const payload = entry.data as { code?: unknown } | null
    if (payload === null || typeof payload !== 'object' || typeof payload.code !== 'number') {
      removeFile(file)
      return null
    }
    // 文件名是关键词的 md5；entry 里也存了原文，对不上就当未命中（理论上不会发生）
    if (typeof entry.keyword === 'string' && entry.keyword !== keyword) return null

    // 关键修复：maxAge 之前完全没被使用过
    const maxAge = Number(getSetting()['cache.maxAge']) || 0
    const writtenAt = typeof entry.timestamp === 'number' ? entry.timestamp : 0
    if (maxAge > 0 && writtenAt > 0 && Date.now() - writtenAt > maxAge) {
      removeFile(file)
      return null
    }

    // 命中即刷新 LRU 位置（只更新内存索引与文件 mtime，不重写内容）
    const now = Date.now()
    index.set(file, { file, lastUsed: now })
    try {
      fs.utimesSync(filePath, new Date(now), new Date(now))
    } catch {
      /* 改 mtime 失败不影响读取 */
    }

    return entry
  } catch (err) {
    console.error('Cache read error:', err)
    return null
  }
}

export async function save(keyword: string, data: unknown): Promise<boolean> {
  try {
    ensureIndex()
    const file = fileNameOf(keyword)
    const filePath = path.join(getCacheDir(), file)
    const now = Date.now()
    const cacheData: CacheEntry = {
      timestamp: now,
      lastUsed: now,
      keyword,
      data,
    }
    writeJsonAtomic(filePath, cacheData)
    index.set(file, { file, lastUsed: now })

    // 写完之后顺手淘汰，保证目录不会无限长大
    evictIfNeeded()
    return true
  } catch (err) {
    console.error('Cache write error:', err)
    return false
  }
}

export async function clearAll(): Promise<boolean> {
  try {
    const dir = getCacheDir()
    let count = 0
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      removeFile(file)
      count++
    }
    index.clear()
    indexReady = true
    console.log(`[cache] 已清空 ${count} 个缓存文件`)
    return true
  } catch (err) {
    console.error('Cache clear error:', err)
    return false
  }
}


export const getStats = (): CacheStats => {
  ensureIndex()
  // 统计要准，先和磁盘对齐（用户可能在外部删过文件）
  refreshIndex()
  let bytes = 0
  const dir = getCacheDir()
  for (const file of index.keys()) {
    try {
      bytes += fs.statSync(path.join(dir, file)).size
    } catch {
      /* 忽略 */
    }
  }
  return { count: index.size, bytes }
}

/** 手动触发一次清理（设置界面/调试可用） */
export const prune = (): CacheStats => {
  evictIfNeeded(true)
  return getStats()
}
