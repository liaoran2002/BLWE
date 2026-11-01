/**
 * 某站视频列表 store（渲染进程）
 *
 * ## 它和 `playlists` store 是**并列**关系，不是父子
 *
 * 音乐歌单（`playlists`）与视频列表（`videolists`）是两条独立的进料管：
 *  - 音乐歌单：**歌名 + 歌手** → 搜索 → 一堆候选 → 选一个；
 *  - 视频列表：条目**本来就是视频**（带 bvid），没有搜索这一步。
 *
 * 它们在库里是两组不相交的表（`playlists` / `videolists`），
 * 所以这里也不把它们塞进同一个 store —— 那会让「当前是哪种来源」变成
 * 一堆 `if (kind === 'video')`。
 *
 * ## 播放队列吃的是联合类型
 *
 * `queue` store 的 `songs` 是 `PlayItem[]`（见 `types/playItem.ts`）：
 * 视频条目**原样进去**，字段一个都不改（`title` / `author` / `bvid`）。
 * 播放前用 `isVideoItem()` 分开 —— 视频直接拿 `bv:<bvid>` 去解析地址，
 * 歌才去搜索候选。
 *
 * 以前这里有个 `toSongs()`，把条目改名成 `{ name: 标题, singer: UP主 }` 塞进
 * 歌的形状里，下游只能靠「有没有 bvid」猜这是不是视频。那个映射已经删了。
 *
 * ## `activeId` 是「当前在播哪个视频列表」
 *
 * `''` 表示当前在播音乐歌单（此时由 `playlists` store 的 `currentId` 说话）。
 * 它需要跨重启保留 —— 落在设置项 `player.activeVideoListId` 里，
 * 由 `queue` store 读写（store 本身不碰设置，保持这一层只做数据）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api/electron'
import type {
  VideoListItem,
  VideoListKind,
  VideoListRecord,
  VideoListSyncMode,
  VideoListSyncResult,
  VideoMetaInput,
} from '@common/types/playlist'
import {
  getVideoListSyncInterval,
  isVideoListAutoSyncable,
  isVideoListSyncDue,
} from '@common/types/playlist'

export const useVideoListStore = defineStore('videoLists', () => {
  const lists = ref<VideoListRecord[]>([])
  const loaded = ref(false)
  /** 正在同步的列表 id（界面上转圈用） */
  const syncing = ref<string[]>([])
  /** 当前正在播的视频列表 id；`''` = 在播音乐歌单 */
  const activeId = ref('')

  const active = computed<VideoListRecord | null>(
    () => lists.value.find((item) => item.id === activeId.value) ?? null,
  )

  const find = (id: string): VideoListRecord | null =>
    lists.value.find((item) => item.id === id) ?? null

  const isSyncingOne = (id: string): boolean => syncing.value.includes(id)

  /**
   * 从主进程加载全部列表
   *
   * 只读库、不联网 —— 列表内容在导入 / 同步时就落库了，
   * 每次开程序都打一串接口既慢又招风控。
   */
  const load = async (): Promise<void> => {
    lists.value = await api.getVideoLists()
    loaded.value = true
  }

  /** 切换「当前在播的视频列表」（持久化由 queue store 的 action 负责） */
  const setActive = (id: string): void => {
    activeId.value = id
  }

  /**
   * 导入一个列表（拉取 + 落库都在主进程）
   *
   * 几百条要跑几秒（分页之间有限速），调用方应自己给出 loading 状态。
   */
  const add = async (
    kind: VideoListKind,
    sourceId: string,
    mid?: string,
  ): Promise<{ record: VideoListRecord; skipped: number; existed: boolean }> => {
    const result = await api.addVideoList({ kind, sourceId, mid })
    await load()
    return result
  }

  const remove = async (id: string): Promise<boolean> => {
    const ok = await api.removeVideoList(id)
    if (ok) {
      lists.value = lists.value.filter((item) => item.id !== id)
      if (activeId.value === id) activeId.value = ''
    }
    return ok
  }

  /** 新建本地列表（名字为空时主进程自动叫「本地列表」「本地列表2」…） */
  const createLocal = async (name?: string): Promise<VideoListRecord> => {
    const record = await api.createLocalVideoList(name)
    await load()
    return record
  }

  const rename = async (id: string, name: string): Promise<boolean> => {
    const ok = await api.renameVideoList(id, name)
    if (ok) await load()
    return ok
  }

  /**
   * 「添加视频」第一步：解析成预览数据（**不写库**）
   *
   * 单条 → 视频详情；合集 / 收藏夹 / 系列 → 列表详情 + 每条视频。
   * 界面拿它画确认框，用户点确定后再调 `addItem` / `addItems` 落库。
   */
  const previewImport = (input: string) => api.previewVideoImport(input)

  /** 第二步（单条）：把确认过的那一条放进本地列表（置顶） */
  const addItem = async (id: string, item: VideoMetaInput) => {
    const result = await api.addVideoListItem(id, item)
    await load()
    return result
  }

  /** 第二步（批量）：把确认过的一批追加到本地列表末尾（只增不删） */
  const addItems = async (id: string, items: VideoMetaInput[]) => {
    const result = await api.addVideoListItems(id, items)
    await load()
    return result
  }

  /**
   * 平台列表 → 本地列表
   *
   * 主进程会换一个 id（`bv_local_` 开头）并把条目整体搬过去。
   * 这里顺手把 `activeId` 重映射 —— 否则「正在播的列表」会指向一个已经不存在的 id，
   * 下一次写播进度就写到空处了（`player.activeVideoListId` 主进程已经改好）。
   */
  const convertToLocal = async (id: string): Promise<{ id: string; name: string }> => {
    const result = await api.convertVideoListToLocal(id)
    if (activeId.value === id) activeId.value = result.id
    await load()
    return result
  }

  /**
   * 设置同步方式（和音乐歌单一样三档）
   *
   * `off` 手动同步 / `startup` 每次启动时同步 / `interval` 定时自动同步。
   * 定时模式下 `intervalMs` 才算数。
   */
  const setSyncMode = async (
    id: string,
    mode: VideoListSyncMode,
    intervalMs = 0,
  ): Promise<boolean> => {
    const ok = await api.setVideoListSyncMode(id, mode, intervalMs)
    if (ok) await load()
    return ok
  }

  /**
   * 拖入单条视频 → 放进**默认列表**（没有就现建一个）
   *
   * 「哪个是默认列表」由主进程决定（设置项 + 库），渲染层只拿回来的 id 去播放。
   * 这里顺手 `load()`：列表数量 / 条目数都可能变了，侧边栏要跟着刷新。
   */
  const addItemToDefault = async (input: string): Promise<{ listId: string; listName: string }> => {
    const result = await api.addVideoItemToDefault(input)
    await load()
    return { listId: result.listId, listName: result.listName }
  }

  /**
   * 拖入**本地视频文件** → 登记 + 挂进默认列表（整批置顶）
   *
   * 和 `addItemToDefault` 是同一件事的另一种入参：落点、置顶、续播都一样，
   * 只有「地址从哪来」不同。返回的条目带 `url`（主进程拼的 `blwe-media://`），
   * 调用方拿它探针 + 起播。
   *
   * 主进程**不**解析也不探测 —— 能不能播由渲染层的 `<video>` 实测，
   * 那是唯一和真播放用同一个解码器的判断。
   */
  const importLocal = async (
    paths: string[],
  ): Promise<{
    listId: string
    listName: string
    items: Array<VideoListItem & { url: string }>
    skipped: Array<{ path: string; reason: string }>
  }> => {
    const result = await api.importLocalVideoFiles(paths)
    await load()
    return result
  }

  const removeItem = async (id: string, bvid: string): Promise<boolean> => {
    const ok = await api.removeVideoListItem(id, bvid)
    if (ok) await load()
    return ok
  }

  /** 收藏 / 取消收藏（收藏 = 置顶；顺序由主进程事务改 ord，这里只负责重新读） */
  const setFavorite = async (id: string, bvid: string, favorite: boolean): Promise<void> => {
    await api.setVideoListItemFavorite(id, bvid, favorite)
    await load()
  }

  /** 重新同步（`last_index` 由主进程按 bvid 重定位） */
  const sync = async (id: string): Promise<VideoListSyncResult> => {
    syncing.value = [...new Set([...syncing.value, id])]
    try {
      const result = await api.syncVideoList(id)
      await load()
      return result
    } finally {
      syncing.value = syncing.value.filter((item) => item !== id)
    }
  }

  /**
   * 批量同步（串行）
   *
   * 视频列表一次同步要打几十个分页请求，并发只会更快触发某站风控；
   * 所以一条一条来，失败的不打断后面的。
   */
  const syncMany = async (ids: string[]): Promise<VideoListSyncResult[]> => {
    const results: VideoListSyncResult[] = []
    for (const id of ids) {
      try {
        results.push(await sync(id))
      } catch (err) {
        results.push({
          id,
          name: find(id)?.name ?? id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return results
  }

  /** 立即同步所有「参与自动同步」的平台列表（手动同步的不动） */
  const syncAll = (): Promise<VideoListSyncResult[]> =>
    syncMany(lists.value.filter(isVideoListAutoSyncable).map((item) => item.id))

  /** 启动时需要同步的列表 id */
  const getStartupSyncIds = (): string[] =>
    lists.value
      .filter((item) => isVideoListAutoSyncable(item) && item.syncMode === 'startup')
      .map((item) => item.id)

  /** 启动时按每个列表自己的策略同步 */
  const syncOnStartupIfNeeded = async (): Promise<VideoListSyncResult[]> => {
    const ids = getStartupSyncIds()
    if (ids.length === 0) return []
    return syncMany(ids)
  }

  /** 当前到点该做定时同步的列表 id */
  const getDueSyncIds = (now = Date.now()): string[] =>
    lists.value
      .filter((item) => isVideoListAutoSyncable(item) && isVideoListSyncDue(item, now))
      .map((item) => item.id)

  /** 是否存在「定时同步」的列表（没有就不必让心跳管这边） */
  const hasIntervalSync = computed(() =>
    lists.value.some((item) => getVideoListSyncInterval(item) > 0),
  )

  /** 定时列表里最小的间隔（心跳按它走） */
  const minSyncInterval = computed(() => {
    const values = lists.value
      .filter((item) => isVideoListAutoSyncable(item))
      .map(getVideoListSyncInterval)
      .filter((ms) => ms > 0)
    return values.length > 0 ? Math.min(...values) : 0
  })

  /**
   * 列表条目（已在库里，不联网）
   *
   * 返回的就是播放队列能直接吃的东西 —— 不需要再转一次形状。
   * 播放层拿 `isVideoItem()` 认它，而不是靠 `bvid` 猜。
   */
  const items = (id: string): Promise<VideoListItem[]> => api.getVideoListItems(id)

  /** 记录播到第几条（等价于歌单的 `lastIndex`） */
  const setIndex = (id: string, index: number): Promise<void> =>
    api.setVideoListIndex(id, index)

  return {
    lists,
    loaded,
    syncing,
    activeId,
    active,
    find,
    isSyncingOne,
    load,
    setActive,
    add,
    remove,
    createLocal,
    rename,
    previewImport,
    addItem,
    addItems,
    addItemToDefault,
    convertToLocal,
    setSyncMode,
    syncMany,
    syncAll,
    syncOnStartupIfNeeded,
    getDueSyncIds,
    hasIntervalSync,
    minSyncInterval,
    importLocal,
    removeItem,
    setFavorite,
    sync,
    items,
    setIndex,
  }
})
