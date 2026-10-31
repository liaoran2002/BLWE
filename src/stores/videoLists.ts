/**
 * B 站视频列表 store（渲染进程）
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
  VideoListSyncResult,
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

  /** 「添加视频」：解析链接后插到列表最前（置顶区） */
  const addItem = async (id: string, input: string): Promise<VideoListItem> => {
    const item = await api.addVideoListItem(id, input)
    await load()
    return item
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
    addItem,
    addItemToDefault,
    importLocal,
    removeItem,
    setFavorite,
    sync,
    items,
    setIndex,
  }
})
