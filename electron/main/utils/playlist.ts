/**
 * 歌单集合服务（主进程）
 *
 * 从原来的「单个 playlist.json」升级为「多歌单 + 自动同步」：
 *  - playlists.json 保存整个集合（含每个歌单的同步策略与播放位置）
 *  - 旧版 playlist.json 会在首次启动时自动迁移成一条记录，不丢数据
 *  - 与 setting 服务一致：内存常驻 + 防抖落盘
 *
 * 自动同步只负责「重新解析歌单曲目」；把歌曲匹配成 B 站视频是渲染进程的事，
 * 所以同步结果（新增/移除曲目）返回给渲染进程处理。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLAYLIST_DATA_VERSION, STORE_NAMES } from '@common/constants'
import type {
  FavoriteVideo,
  PlaylistRecord,
  PlaylistSaveParams,
  PlaylistSong,
  PlaylistStoreData,
  SyncResult,
} from '@common/types/playlist'
import { parseSearchKey, toSearchKey } from '@common/types/playlist'
import { compareVer, debounce } from '@common/utils/common'
import { getStore } from './store'
import { resolvePlaylist } from '../music'

const WRITE_DEBOUNCE_MS = 300
/** 自动同步时最多处理多少首歌（防御异常巨大的歌单） */
const MAX_SYNC_SONGS = 2000

const emptyData = (): PlaylistStoreData => ({
  version: PLAYLIST_DATA_VERSION,
  currentId: null,
  playlists: [],
})

let data: PlaylistStoreData = emptyData()
let store: ReturnType<typeof getStore<PlaylistStoreData & Record<string, unknown>>> | null = null

const getNewPlaylistPath = (): string =>
  path.join(app.getPath('userData'), `${STORE_NAMES.PLAYLISTS}.json`)
/** 旧版单歌单文件（本项目 ≤1.5.x 一直在用） */
const getLegacyPlaylistPath = (): string =>
  path.join(app.getPath('userData'), `${STORE_NAMES.PLAYLIST}.json`)

/** 落盘 */
const writeToDisk = (): void => {
  if (!store) return
  store.override(data as unknown as PlaylistStoreData & Record<string, unknown>)
}
const writeDebounced = debounce(writeToDisk, WRITE_DEBOUNCE_MS)

/** 立即落盘（退出前调用） */
export const flushPlaylists = (): void => {
  writeDebounced.flush()
}

/** 生成一个歌单 id */
const newId = (): string => randomUUID()

/**
 * 把旧的单歌单文件迁移成集合里的第一条记录
 *
 * 旧结构：{ name: string, songs: string[] }
 */
const migrateLegacy = (): PlaylistRecord | null => {
  const legacyPath = getLegacyPlaylistPath()
  if (!fs.existsSync(legacyPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as {
      name?: string
      songs?: string[]
    }
    if (!Array.isArray(raw.songs) || raw.songs.length === 0) return null
    const now = Date.now()
    const record: PlaylistRecord = {
      id: newId(),
      name: raw.name || '我的歌单',
      songs: normalizeSongs(raw.songs),
      sync: { mode: 'off', intervalMs: 0 },
      lastSyncAt: now,
      createdAt: now,
      updatedAt: now,
      lastIndex: 0,
      videoCache: {},
    }
    // 迁移成功后把旧文件改名备份，避免重复迁移
    try {
      fs.renameSync(legacyPath, `${legacyPath}.migrated`)
    } catch {
      /* 备份失败不影响迁移结果 */
    }
    console.log(`[playlist] 已迁移旧歌单《${record.name}》，共 ${record.songs.length} 首`)
    return record
  } catch (err) {
    console.error('[playlist] 迁移旧歌单失败:', err)
    return null
  }
}

/**
 * 归一化歌曲数组
 *
 * 兼容两种磁盘格式：
 *  - 旧版 `["歌名-歌手", ...]` 字符串数组 → 解析成结构化对象（不丢数据）
 *  - 新版 `[{name, singer, album, cover, duration}, ...]`
 */
const normalizeSongs = (input: unknown): PlaylistSong[] => {
  if (!Array.isArray(input)) return []
  const result: PlaylistSong[] = []
  for (const item of input) {
    if (typeof item === 'string') {
      const parsed = parseSearchKey(item)
      if (parsed.name) result.push(parsed)
      continue
    }
    if (item && typeof item === 'object') {
      const raw = item as Partial<PlaylistSong>
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      if (!name) continue
      result.push({
        name,
        singer: typeof raw.singer === 'string' ? raw.singer : '',
        album: typeof raw.album === 'string' && raw.album ? raw.album : undefined,
        cover: typeof raw.cover === 'string' && raw.cover ? raw.cover : null,
        duration:
          typeof raw.duration === 'string' && raw.duration ? raw.duration : null,
      })
    }
  }
  return result
}

/** 归一化一条记录，补齐缺省字段（磁盘上的旧数据可能缺项） */
const normalizeRecord = (input: Partial<PlaylistRecord>): PlaylistRecord | null => {
  if (!input || typeof input !== 'object') return null
  if (!Array.isArray(input.songs)) return null
  const now = Date.now()
  return {
    id: typeof input.id === 'string' && input.id ? input.id : newId(),
    name: typeof input.name === 'string' && input.name ? input.name : '未命名歌单',
    source: typeof input.source === 'string' ? input.source : undefined,
    sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl : undefined,
    songs: normalizeSongs(input.songs),
    sync: {
      mode:
        input.sync?.mode === 'startup' || input.sync?.mode === 'interval'
          ? input.sync.mode
          : 'off',
      intervalMs:
        typeof input.sync?.intervalMs === 'number' && input.sync.intervalMs > 0
          ? input.sync.intervalMs
          : 0,
    },
    lastSyncAt: typeof input.lastSyncAt === 'number' ? input.lastSyncAt : null,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
    lastIndex:
      typeof input.lastIndex === 'number' && input.lastIndex >= 0 ? input.lastIndex : 0,
    videoCache:
      input.videoCache && typeof input.videoCache === 'object' ? input.videoCache : {},
    // 收藏视频：形状不合法就整条丢掉，别把脏数据写回磁盘
    favorites: normalizeFavorites(input.favorites),
  }
}

/** 每首歌收藏的视频：key 是搜索键，值是一组 { bvid, title, ... } */
const normalizeFavorites = (
  input: unknown,
): Record<string, FavoriteVideo[]> | undefined => {
  if (!input || typeof input !== 'object') return undefined
  const out: Record<string, FavoriteVideo[]> = {}
  for (const [song, list] of Object.entries(input as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const items: FavoriteVideo[] = []
    for (const raw of list) {
      const item = raw as Partial<FavoriteVideo>
      if (!item || typeof item.bvid !== 'string' || !item.bvid) continue
      items.push({
        bvid: item.bvid,
        title: typeof item.title === 'string' ? item.title : '',
        cover: typeof item.cover === 'string' ? item.cover : null,
        author: typeof item.author === 'string' ? item.author : null,
        duration: typeof item.duration === 'number' ? item.duration : null,
        savedAt: typeof item.savedAt === 'number' ? item.savedAt : Date.now(),
      })
    }
    if (items.length > 0) out[song] = items
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 初始化（app.whenReady 之后调用） */
export const initPlaylists = (): void => {
  const filePath = getNewPlaylistPath()
  store = getStore<PlaylistStoreData & Record<string, unknown>>(filePath)

  const raw = store.get('playlists')
  let loaded: PlaylistRecord[] = []
  if (Array.isArray(raw)) {
    /**
     * 逐条记数：`normalizeRecord` 返回 null 就是「整条丢弃」
     *
     * 以前是 map + filter 一把过，丢了多少条、哪一条完全没有痕迹 ——
     * 渲染层一个结构 bug 就能把整份歌单集合静默从内存里抹掉（并且随后落盘），
     * 事后只能靠用户说「我的歌单没了」。至少要留下日志。
     */
    let dropped = 0
    for (const item of raw) {
      const record = normalizeRecord(item as Partial<PlaylistRecord>)
      if (record) loaded.push(record)
      else dropped += 1
    }
    if (dropped > 0) {
      console.warn(
        `[playlist] 有 ${dropped} 条歌单记录结构不合法已丢弃（原文件 ${filePath}，本次未覆盖前可先备份）`,
      )
    }
  }

  /**
   * 磁盘上记的版本号
   *
   * 下面那个「同步策略一次性升级」**必须**靠它做闸门：升级本身会把 off 改成 startup，
   * 而用户也完全可能**故意**选「手动同步」—— 没有闸门就会每次启动都把用户的选择推翻，
   * 还会顺手联网同步覆盖曲目（用户看到的是「我明明设了手动，它自己又开始同步了」）。
   */
  const storedVersion = store.get('version')
  const isUpgradeFromOlder =
    typeof storedVersion !== 'string' || compareVer(storedVersion, PLAYLIST_DATA_VERSION) < 0

  let currentId = store.get('currentId')
  if (typeof currentId !== 'string') currentId = null

  let needSave = false
  if (loaded.length === 0) {
    const migrated = migrateLegacy()
    if (migrated) {
      loaded = [migrated]
      currentId = migrated.id
      needSave = true
    }
  }
  if (loaded.length > 0 && !loaded.some((p) => p.id === currentId)) {
    currentId = loaded[0].id
    needSave = true
  }

  /**
   * 一次性升级：把「有分享链接但仍处于手动同步」的歌单改成启动同步
   *
   * 背景：同步策略原先有一半由全局设置（playlist.syncOnStartup）控制，
   * 现在改成完全由每个歌单自己决定。如果不做这一步，老用户那些
   * mode === 'off' 的歌单会突然完全不再自动同步。
   *
   * 只在**从更老的数据版本升上来**时做一次（见上面的 isUpgradeFromOlder）：
   * 否则用户每次启动手动设的「手动同步」都会被无声改回启动同步。
   */
  const upgraded = isUpgradeFromOlder
    ? loaded.filter((p) => p.sourceUrl && p.sync.mode === 'off')
    : []
  if (upgraded.length > 0) {
    for (const p of upgraded) {
      p.sync = { mode: 'startup', intervalMs: 0 }
      p.updatedAt = Date.now()
    }
    needSave = true
    console.log(
      `[playlist] 已将 ${upgraded.length} 个有链接的歌单升级为「启动同步」：` +
        upgraded.map((p) => p.name).join('、'),
    )
  }

  data = { version: PLAYLIST_DATA_VERSION, currentId, playlists: loaded }
  if (needSave) writeToDisk()
  console.log(`[playlist] 已加载 ${loaded.length} 个歌单，当前=${currentId ?? '无'}`)
}

/** 取完整集合（深拷贝，避免调用方改到内存里那份） */
export const getPlaylists = (): PlaylistStoreData => structuredClone(data)

/** 整体覆盖保存（渲染进程每次增删改后调用） */
export const savePlaylists = (params: PlaylistSaveParams): PlaylistStoreData => {
  const normalized: PlaylistRecord[] = []
  if (Array.isArray(params?.playlists)) {
    for (const item of params.playlists) {
      const record = normalizeRecord(item)
      if (!record) continue
      /**
       * 正在同步的歌单：曲目以主进程内存里的为准
       *
       * 渲染层这份是它开始同步之前读到的旧列表，直接覆盖会把刚同步完的曲目丢掉，
       * 而界面还在提示「同步完成 +N/-M」（用户看到的是「同步了个寂寞」）。
       */
      if (syncingIds.has(record.id)) {
        const live = data.playlists.find((p) => p.id === record.id)
        if (live) {
          console.warn(`[playlist] ${record.name} 正在同步，保存时保留内存里的曲目`)
          record.songs = live.songs
          record.lastSyncAt = live.lastSyncAt
        }
      }
      normalized.push(record)
    }
  }
  let currentId =
    typeof params?.currentId === 'string' && params.currentId ? params.currentId : null
  if (normalized.length > 0 && !normalized.some((p) => p.id === currentId)) {
    currentId = normalized[0].id
  }
  if (normalized.length === 0) currentId = null

  data = { version: PLAYLIST_DATA_VERSION, currentId, playlists: normalized }
  writeDebounced()
  return structuredClone(data)
}

/** 去重用的归一化 key */
const songKey = (song: PlaylistSong): string =>
  toSearchKey(song).trim().toLowerCase()

/**
 * 同步一个歌单（重新解析曲目）
 *
 * @returns 同步结果，其中 added/removed 供界面提示
 */
/**
 * 正在同步中的歌单 id
 *
 * `savePlaylists` 是渲染层**全量覆盖**，而 `syncPlaylist` 是主进程**就地改内存**：
 * 同步要跑好几秒网络请求，期间渲染层任何一次 `persist`（收藏视频、切歌单、编辑歌单）
 * 都会拿它手里的旧曲目列表把同步结果盖掉，随后界面还照样提示「同步完成 +N/-M」。
 * 记下正在同步的 id，覆盖时把这些歌单的曲目**以主进程内存里的为准**。
 */
const syncingIds = new Set<string>()

export const syncPlaylist = async (id: string): Promise<SyncResult> => {
  const index = data.playlists.findIndex((p) => p.id === id)
  if (index < 0) return { id, name: '', ok: false, error: '歌单不存在' }

  const target = data.playlists[index]
  if (!target.sourceUrl) {
    return {
      id,
      name: target.name,
      ok: false,
      error: '该歌单没有保存原始链接，无法自动同步（请重新添加）',
    }
  }

  syncingIds.add(id)

  try {
    const detail = await resolvePlaylist({ input: target.sourceUrl })
    // 直接保留结构化字段（封面/专辑/歌手/时长），不再压成字符串
    let songs: PlaylistSong[] = detail.songs.map((song) => ({
      name: song.name,
      singer: song.singer,
      album: song.albumName,
      cover: song.cover ?? null,
      duration: song.interval,
    }))
    if (songs.length > MAX_SYNC_SONGS) songs = songs.slice(0, MAX_SYNC_SONGS)

    /**
     * 固定去重
     *
     * 曾经有个 `duplicatePolicy` 参数（`'keep' | 'dedupe'`），但 IPC 只传 `{ ids }`、
     * 主进程也从来没人传第二个参数 —— `'keep'` 是不可达的死分支，还让人以为「保留重复」可配。
     * 现在直接写明：同步一律去重。
     */
    {
      const seen = new Set<string>()
      songs = songs.filter((song) => {
        const key = songKey(song)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    const before = new Set(target.songs.map(toSearchKey))
    const after = new Set(songs.map(toSearchKey))
    const added = songs.filter((s) => !before.has(toSearchKey(s))).length
    const removed = target.songs.filter((s) => !after.has(toSearchKey(s))).length

    // 名称与来源以远端为准，但保留用户自定义的名字（仅当原名为空时更新）
    if (!target.name.trim()) target.name = detail.info.name || target.name
    target.source = detail.source
    target.songs = songs
    target.lastSyncAt = Date.now()
    target.updatedAt = Date.now()
    // 曲目数变化可能让下标越界
    if (target.lastIndex >= songs.length) target.lastIndex = 0

    // 清掉已不存在歌曲的缓存（videoCache / favorites 的 key 都是搜索键，不是下标）
    if (target.videoCache || target.favorites) {
      const valid = new Set(songs.map(toSearchKey))
      for (const key of Object.keys(target.videoCache ?? {})) {
        if (!valid.has(key)) delete target.videoCache![key]
      }
      for (const key of Object.keys(target.favorites ?? {})) {
        if (!valid.has(key)) delete target.favorites![key]
      }
    }

    writeDebounced()
    return { id, name: target.name, ok: true, count: songs.length, added, removed }
  } catch (err) {
    target.updatedAt = Date.now()
    writeDebounced()
    return {
      id,
      name: target.name,
      ok: false,
      error: (err as Error)?.message ?? '同步失败',
    }
  } finally {
    // 不管成功失败都要摘掉标记，否则这个歌单以后的覆盖保存都会被拦
    syncingIds.delete(id)
  }
}

/**
 * 同步多个歌单
 *
 * 串行执行，避免同时打多个平台的接口被限流。
 */
export const syncPlaylists = async (ids: string[]): Promise<SyncResult[]> => {
  const results: SyncResult[] = []
  for (const id of ids) {
    results.push(await syncPlaylist(id))
  }
  return results
}
