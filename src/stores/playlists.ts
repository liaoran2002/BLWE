/**
 * 歌单 store（渲染进程）
 *
 * 与 setting store 一样，这里只做**响应式副本 + 业务编排**，
 * 持久化由主进程负责（`playlists:save` 整体覆盖，落到 SQLite 的
 * `playlists` + `playlist_songs` 两张表）。
 *
 * 职责：
 *  - 歌单的增删改查、当前歌单切换
 *  - 自动同步编排（启动时 / 定时），实际解析在主进程
 *
 * **收藏视频与「每首歌选中的视频」不在这里**（`getFavorites` / `addFavorite` /
 * `removeFavorite` / `setVideoForSong` / `getVideoForSong` 都已删除）。
 * 它们搬到了主进程的 `videos` / `song_meta` 表，渲染层直接调
 * `api.setFavorite` / `api.getFavoriteBvids` / `api.getSelectedBvid`。
 * 为什么必须搬走：收藏带「列表顺序」语义，而这个 store 的
 * 持久化是**整个歌单集合全量覆盖**——每收藏一次就把所有歌单所有曲目重写一遍，
 * 而且同步进行中还会被主进程的 `syncingIds` 拦下（收藏静默丢失）。
 * （写入 `selected_bvid` 连 `get` 之外的接口都不需要：`resolveVideoUrl` 内部会写。）
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api/electron'
import type {
  PlaylistRecord,
  PlaylistSong,
  PlaylistStoreData,
  SyncResult,
} from '@common/types/playlist'
import {
  getSyncInterval,
  isAutoSyncable,
  isSyncDue,
} from '@common/types/playlist'
import { toPlain } from '@/utils/plain'

/** 生成 id（渲染进程侧；主进程保存时会补齐/校验） */
const newId = (): string => {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export const usePlaylistStore = defineStore('playlists', () => {
  const playlists = ref<PlaylistRecord[]>([])
  const currentId = ref<string | null>(null)
  const loaded = ref(false)
  /** 正在同步的歌单 id 集合 */
  const syncing = ref<string[]>([])

  const current = computed<PlaylistRecord | null>(
    () => playlists.value.find((p) => p.id === currentId.value) ?? null,
  )

  const isSyncing = computed(() => syncing.value.length > 0)
  const isSyncingOne = (id: string): boolean => syncing.value.includes(id)

  /**
   * 从主进程加载集合
   *
   * 只有 `src/App.vue` 的 init 会调用它（而且是 await 的），
   * 所以不需要「幂等 ensureLoaded + 复用同一个 promise」那层包装 —— 已删。
   */
  const load = async (): Promise<void> => {
    const data: PlaylistStoreData = await api.getPlaylists()
    playlists.value = data.playlists
    currentId.value = data.currentId
    loaded.value = true
  }

  /** 整体写回主进程 */
  const persist = async (): Promise<void> => {
    const data = await api.savePlaylists({
      playlists: toPlain(playlists.value),
      currentId: currentId.value,
    })
    // 以主进程归一化后的结果为准（它会补齐 id / 默认字段）
    playlists.value = data.playlists
    currentId.value = data.currentId
  }

  /** 新增歌单 */
  /**
   * 新增歌单
   *
   * songs 允许传字符串（手输的 `"歌名-歌手"`），会自动解析成结构化歌曲，
   * 这样「手动填歌曲」那条旧路径不用改。
   */
  const addPlaylist = async (input: {
    name: string
    songs: PlaylistSong[]
    source?: string
    sourceUrl?: string
    syncMode?: PlaylistRecord['sync']['mode']
    intervalMs?: number
  }): Promise<PlaylistRecord> => {
    const now = Date.now()
    const record: PlaylistRecord = {
      id: newId(),
      name: input.name || '未命名歌单',
      source: input.source,
      sourceUrl: input.sourceUrl,
      songs: input.songs,
      sync: {
        mode: input.syncMode ?? 'off',
        intervalMs: input.intervalMs ?? 0,
      },
      lastSyncAt: now,
      createdAt: now,
      updatedAt: now,
      lastIndex: 0,
    }
    playlists.value = [...playlists.value, record]
    currentId.value = record.id
    await persist()
    return record
  }

  /** 更新歌单字段 */
  const updatePlaylist = async (
    id: string,
    patch: Partial<Omit<PlaylistRecord, 'id'>>,
  ): Promise<void> => {
    playlists.value = playlists.value.map((p) =>
      p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p,
    )
    await persist()
  }

  /** 删除歌单 */
  const removePlaylist = async (id: string): Promise<void> => {
    playlists.value = playlists.value.filter((p) => p.id !== id)
    if (currentId.value === id) {
      currentId.value = playlists.value[0]?.id ?? null
    }
    await persist()
  }

  /** 切换当前歌单 */
  const setCurrent = async (id: string | null): Promise<void> => {
    currentId.value = id
    await persist()
  }

  /**
   * 记录当前歌单播放到第几首
   */
  const setLastIndex = async (index: number): Promise<void> => {
    const target = current.value
    if (!target || target.lastIndex === index) return
    playlists.value = playlists.value.map((p) =>
      p.id === target.id ? { ...p, lastIndex: index } : p,
    )
    await persist()
  }

  /** 同步指定歌单（默认当前歌单）；重复歌曲由主进程固定去重 */
  const sync = async (ids?: string[]): Promise<SyncResult[]> => {
    const targetIds = ids ?? (currentId.value ? [currentId.value] : [])
    if (targetIds.length === 0) return []

    syncing.value = [...new Set([...syncing.value, ...targetIds])]
    try {
      const results = await api.syncPlaylists(targetIds)
      // 同步会改歌曲列表，重新拉一次以拿到最新数据
      await load()
      return results
    } finally {
      syncing.value = syncing.value.filter((id) => !targetIds.includes(id))
    }
  }

  /** 同步所有「可自动同步」的歌单 */
  const syncAll = (): Promise<SyncResult[]> =>
    sync(playlists.value.filter(isAutoSyncable).map((p) => p.id))

  /** 启动时需要同步的歌单 id（按每个歌单自己的策略） */
  const getStartupSyncIds = (): string[] =>
    playlists.value
      .filter((p) => isAutoSyncable(p) && p.sync.mode === 'startup')
      .map((p) => p.id)

  /**
   * 启动时自动同步
   *
   * 同步策略完全由「每个歌单自己」决定（新建/编辑歌单时设置），
   * 设置界面不再提供全局开关 —— 避免「歌单设了自动同步但被全局开关关掉」这种困惑。
   */
  const syncOnStartupIfNeeded = async (): Promise<SyncResult[]> => {
    const ids = getStartupSyncIds()
    if (ids.length === 0) return []
    return sync(ids)
  }

  /** 当前到点该做定时同步的歌单 id */
  const getDueSyncIds = (now = Date.now()): string[] =>
    playlists.value.filter((p) => isAutoSyncable(p) && isSyncDue(p, now)).map((p) => p.id)

  /** 是否存在「定时同步」的歌单（没有就不必装定时器） */
  const hasIntervalSync = computed(() =>
    playlists.value.some((p) => isAutoSyncable(p) && getSyncInterval(p) > 0),
  )

  /**
   * 所有定时同步歌单里最小的间隔（毫秒）
   *
   * 定时器按这个最小间隔「心跳」，每次心跳只同步真正到点的歌单，
   * 这样不同歌单可以有自己的周期，又只需要一个定时器。
   */
  const minSyncInterval = computed(() => {
    const list = playlists.value
      .filter((p) => isAutoSyncable(p) && getSyncInterval(p) > 0)
      .map((p) => getSyncInterval(p))
    return list.length > 0 ? Math.min(...list) : 0
  })
  return {
    playlists,
    currentId,
    loaded,
    syncing,
    current,
    isSyncing,
    isSyncingOne,
    load,
    persist,
    addPlaylist,
    updatePlaylist,
    removePlaylist,
    setCurrent,
    setLastIndex,
    sync,
    syncAll,
    getStartupSyncIds,
    syncOnStartupIfNeeded,
    // 定时同步（策略来自每个歌单自己的 sync 配置）
    hasIntervalSync,
    minSyncInterval,
    getDueSyncIds,
  }
})
