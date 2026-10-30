/**
 * B 站视频列表（收藏夹 / 合集 / 系列 / 本地列表）的 CRUD + 同步（主进程）
 *
 * ## 它是 OV 模式（Other Video）的全部数据来源
 *
 * 音乐歌单（MV 模式）的链路是：歌名 + 歌手 → **搜索** → 一堆候选 → 选一个。
 * 视频列表的链路是：条目**本来就是视频**（带 bvid），没有搜索这一步。
 *
 * 但播放引擎那边不能有两条链路 —— 所以这里把每个条目伪装成
 * 「只有一个候选的搜索键」：`search_key = 'bv:<bvid>'`，
 * `api:searchSong` 看到前缀就短路，直接返回这一条（见 cache.listDirectCandidates）。
 *
 * ## 四张表各管什么
 *
 *  - `videolists`      列表元信息（名字 / 封面 / 进度 / 来源）
 *  - `videolist_items` 列表成员 + 顺序 + **收藏** + **来源**（sync / local）
 *  - `song_videos`     `bv:<bvid>` 的关系行 —— 让「候选列表」这个抽象对直连条目也成立
 *  - `videos`          只写**元数据**（标题/封面/UP 主/时长），**不写播放地址**
 *
 * ⚠️ 导入 500 条 = 500 行关系 + 500 行很窄的实体，**不是** 500 份 dash。
 * 地址一律等第一次播放时由 `cache.updateVideoResult()` 自动补。
 *
 * ## 顺序（ord）怎么维护：和音乐歌单那边「添加视频」完全一样的做法
 *
 * `ord` 是**连续的显示顺序**，置顶就是「别人的 ord + 1，自己写 0」，全在一个事务里。
 * 主键是 `(list_id, bvid)` 而**不含 ord**，所以那条 UPDATE 不会撞唯一约束。
 *
 * 置顶区 = `favorites = 1` 或 `origin = 'local'`：
 *  - 收藏一条 → 挪到最前；
 *  - 取消收藏 → **位置不动**（与 `cache.setFavorite` 的语义一致）；
 *  - 手动添加 → 插到最前。
 */
import type {
  VideoListItem,
  VideoListRecord,
  VideoListSyncResult,
  PlaylistSong,
} from '@common/types/playlist'
import { directKeyOf } from '@common/types/playlist'
import { fetchBiliList, parseVideoInput } from '../biliApi'
import type { BiliListDetail, BiliListKind } from '../biliApi'
import fs from 'node:fs'
import path from 'node:path'
import { getDb, tx } from './db'
import { getSetting, updateSetting } from './setting'
import { isLocalBvid, isLocalVideoFile, localBvidOfPath, localTitleOfPath } from './localVideo'

/** 一个列表最多拉多少条（500 条收藏夹 = 13 个请求，已经够用且不容易触发风控） */
const MAX_LIST_ITEMS = 500

/** 列表主键：`bv_<kind>_<平台id>`，重复导入会命中同一行 */
export const videoListIdOf = (kind: BiliListKind, sourceId: string): string =>
  `bv_${kind}_${sourceId}`

interface VideoListDbRow {
  id: string
  kind: string
  source_id: string | null
  mid: string | null
  name: string
  cover: string | null
  item_count: number | null
  sync_mode: string
  last_sync_at: number | null
  last_index: number
  created_at: number
  updated_at: number
}

/** `videolist_items` 一行（判断「保留还是重建」只看 favorites / origin） */
interface ItemRow {
  bvid: string
  ord: number
  favorites: number
  origin: string
  added_at: number
}

const isLocalKind = (kind: string): boolean => kind === 'local'

/**
 * 默认列表的 id（设置项）
 *
 * 只读设置，**不查库、不建表** —— `getVideoLists()` 里要拿它标记 `isDefault`，
 * 如果这里顺手去 `ensureDefaultVideoList()` 就会自己调自己。
 */
const defaultListId = (): string => {
  try {
    return String(getSetting()['player.defaultVideoListId'] ?? '')
  } catch {
    return ''
  }
}

/*
 * `defId` 由调用方传进来（列表可能有几十行，每一行都去 clone 一遍设置没意义）。
 */
const toRecord = (row: VideoListDbRow, defId: string = defaultListId()): VideoListRecord => ({
  id: row.id,
  kind: (['season', 'series', 'local'].includes(row.kind) ? row.kind : 'fav') as VideoListRecord['kind'],
  sourceId: row.source_id,
  mid: row.mid,
  name: row.name,
  cover: row.cover,
  itemCount: row.item_count,
  syncMode: row.sync_mode === 'manual' ? 'manual' : 'off',
  lastSyncAt: row.last_sync_at,
  lastIndex: row.last_index ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  /** 默认列表（拖入单条视频的落点）：界面上不显示删除按钮 */
  isDefault: !!defId && row.id === defId,
})

/**
 * 读全部视频列表
 *
 * **本地列表排在前面**（它们是用户自己攒的，最常用），同类里按创建时间 ——
 * 侧边栏顺序必须稳定，否则每次读库都跳一下。
 */
export const getVideoLists = (): VideoListRecord[] => {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, kind, source_id, mid, name, cover, item_count,
                sync_mode, last_sync_at, last_index, created_at, updated_at
           FROM videolists
          ORDER BY CASE WHEN kind = 'local' THEN 0 ELSE 1 END, created_at ASC`,
      )
      .all() as VideoListDbRow[]
    const defId = defaultListId()
    return rows.map((row) => toRecord(row, defId))
  } catch (err) {
    console.error('[videolist] 读取视频列表失败:', err)
    return []
  }
}

/**
 * 按 id 找一条
 *
 * 同步 / 记录进度 / 渲染层展示都要先拿到 `kind` / `source_id` / `mid`
 * （重新同步时用户不会再给一次链接，这些只能从库里读）。
 */
export const findVideoList = (id: string): VideoListRecord | null => {
  if (!id) return null
  try {
    const row = getDb()
      .prepare(
        `SELECT id, kind, source_id, mid, name, cover, item_count,
                sync_mode, last_sync_at, last_index, created_at, updated_at
           FROM videolists WHERE id = ?`,
      )
      .get(id) as VideoListDbRow | undefined
    return row ? toRecord(row) : null
  } catch (err) {
    console.error('[videolist] 读取视频列表失败:', err)
    return null
  }
}

/**
 * 读列表条目（**已在库里，不联网**）
 *
 * 走 LEFT JOIN：实体行理论上一定存在（导入时就写了元数据），但真缺了也不能让
 * 整条消失 —— 用户看到「我导入的 500 条只有 480 条」比「标题空白」更难解释。
 */
export const getVideoListItems = (id: string): VideoListItem[] => {
  if (!id) return []
  try {
    const rows = getDb()
      .prepare(
        `SELECT i.bvid AS bvid, v.title AS title, v.pic AS cover,
                v.author AS author, v.duration AS duration,
                v.durl_url AS durlUrl,
                i.favorites AS favorites, i.origin AS origin
           FROM videolist_items i
           LEFT JOIN videos v ON v.bvid = i.bvid
          WHERE i.list_id = ?
          ORDER BY i.ord ASC`,
      )
      .all(id) as Array<{
      bvid: string
      title: string | null
      cover: string | null
      author: string | null
      duration: number | null
      durlUrl: string | null
      favorites: number
      origin: string
    }>
    return rows.map((row) => ({
      bvid: row.bvid,
      title: row.title ?? '',
      cover: row.cover,
      author: row.author,
      duration: row.duration,
      favorites: row.favorites === 1,
      origin: row.origin === 'local' ? 'local' : 'sync',
      /**
       * 本地文件条目把**路径**一起带出去
       *
       * 这里不带的话，界面既没法说「文件本来在哪」，也没法把重新定位的对话框
       * 定位到那个目录。B 站条目的 `durl_url` 是直链（带签名、几分钟就过期），
       * 交给渲染层没有意义，所以只给 `lf_` 条目。
       *
       * 顺便注意：**这里不 stat**（见 `markLocalItemsMissing`）——
       * 一个 500 条的列表逐个摸盘会让主进程卡住，失效判定放在 IPC 那一层做。
       */
      localPath: isLocalBvid(row.bvid) ? row.durlUrl : null,
    }))
  } catch (err) {
    console.error('[videolist] 读取列表条目失败:', err)
    return []
  }
}

/**
 * 把列表条目映射成渲染层认识的 `PlaylistSong[]`
 *
 * 渲染层（`App.vue` 的 `songs`）一直吃 `PlaylistSong`，视频列表要复用同一套
 * 播放 / 切歌 / 续播逻辑，所以在这里做一次形状转换：
 *  - `name` = 视频标题（界面显示的就是它）
 *  - `singer` = UP 主（界面上「歌手」这一列在视频列表里改成「UP 主」）
 *  - `bvid` = 关键字段，`App.vue` 据此决定缓存键是 `bv:<bvid>` 而不是 `歌名-歌手`
 *  - `favorites` = 爱心（实心/空心），**不是** `videos` 上的收藏
 */
export const toPlaylistSongs = (items: VideoListItem[]): PlaylistSong[] =>
  items.map((item) => ({
    name: item.title || item.bvid,
    singer: item.author ?? '',
    cover: item.cover,
    duration: item.duration,
    bvid: item.bvid,
    favorites: item.favorites === true,
    /** 本地文件丢了 → 主列表那一行也打标（进列表就能看见，不用等播失败） */
    missing: item.missing === true,
  }))

/** 把视频元数据写进 videos（不含地址列；地址等第一次播放时补） */
const upsertVideoMeta = (
  db: ReturnType<typeof getDb>,
  item: { bvid: string; title: string; cover?: string | null; author?: string | null; duration?: number | null },
): void => {
  db.prepare(
    `INSERT INTO videos (bvid, title, pic, author, duration)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bvid) DO UPDATE SET
       title    = COALESCE(NULLIF(excluded.title, ''), videos.title),
       pic      = COALESCE(excluded.pic, videos.pic),
       author   = COALESCE(excluded.author, videos.author),
       duration = COALESCE(excluded.duration, videos.duration)`,
  ).run(item.bvid, item.title || null, item.cover ?? null, item.author ?? null, item.duration ?? null)
}

/**
 * `bv:<bvid>` 的关系行：**这就是「直连条目」的全部魔法**
 *
 * `ord = 0`（唯一候选）、`favorites = 0`（绝不能是 1 —— 音乐歌单那边取消收藏会把它删掉）、
 * `title_hl = NULL`（视图会回落成 `videos.title` 的干净标题）。
 */
const ensureRelation = (db: ReturnType<typeof getDb>, bvid: string): void => {
  db.prepare(
    `INSERT OR IGNORE INTO song_videos (search_key, bvid, ord, favorites, title_hl)
     VALUES (?, ?, 0, 0, NULL)`,
  ).run(directKeyOf(bvid), bvid)
}

/** 置顶：别人全部 +1，位置 0 留给新来的（与音乐歌单「添加视频」同一套） */
const bumpOrders = (db: ReturnType<typeof getDb>, listId: string): void => {
  db.prepare(`UPDATE videolist_items SET ord = ord + 1 WHERE list_id = ?`).run(listId)
}

/** `item_count` 永远是**实际条数**（本地列表没有远端总数可报） */
const refreshCount = (db: ReturnType<typeof getDb>, listId: string): void => {
  db.prepare(
    `UPDATE videolists
        SET item_count = (SELECT COUNT(*) FROM videolist_items WHERE list_id = ?),
            updated_at = ?
      WHERE id = ?`,
  ).run(listId, Date.now(), listId)
}

/**
 * 把远端拉到的条目合进列表
 *
 * ## 合并规则（收藏、手动添加一律保留）
 *
 * ```
 * 保留 = favorites = 1 OR origin = 'local'      → 维持原有相对顺序，放在最前
 * 其余 = 本次拉到的条目（去掉已保留的 bvid）     → 按 B 站顺序接在后面
 * ```
 *
 * 也就是说：**你收藏的、你手动加的，同步不会删**；哪怕它在 B 站那边已经取消了收藏，
 * 只要本地还收藏着就留着（真要删就在列表里右键删掉）。
 *
 * 顺序重排后 `last_index` 由调用方按 bvid 重定位 —— 它记的是下标，会漂。
 */
const applyRemoteItems = (
  db: ReturnType<typeof getDb>,
  listId: string,
  detail: BiliListDetail,
): { added: number; removed: number } => {
  const old = db
    .prepare(
      `SELECT bvid, ord, favorites, origin, added_at
         FROM videolist_items WHERE list_id = ? ORDER BY ord ASC`,
    )
    .all(listId) as ItemRow[]

  for (const item of detail.items) {
    upsertVideoMeta(db, item)
  }

  const remoteBvids = new Set(detail.items.map((item) => item.bvid))
  const oldBvids = new Set(old.map((row) => row.bvid))
  const kept = old.filter((row) => row.favorites === 1 || row.origin === 'local')
  const keptBvids = new Set(kept.map((row) => row.bvid))

  /** 远端还在、但本地没保留的 → 新增（顺序跟着 B 站） */
  const incoming = detail.items.filter((item) => !keptBvids.has(item.bvid))
  const added = incoming.filter((item) => !oldBvids.has(item.bvid)).length
  const removed = old.filter((row) => !remoteBvids.has(row.bvid)).length

  db.prepare(`DELETE FROM videolist_items WHERE list_id = ?`).run(listId)
  const insert = db.prepare(
    `INSERT INTO videolist_items (list_id, bvid, ord, favorites, origin, added_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const now = Date.now()
  const rows = [
    ...kept.map((row) => ({
      bvid: row.bvid,
      favorites: row.favorites,
      origin: row.origin,
      addedAt: row.added_at,
    })),
    ...incoming.map((item) => ({
      bvid: item.bvid,
      favorites: 0,
      origin: 'sync',
      addedAt: now,
    })),
  ]
  rows.forEach((row, index) => {
    insert.run(listId, row.bvid, index, row.favorites, row.origin, row.addedAt)
    ensureRelation(db, row.bvid)
  })
  refreshCount(db, listId)

  /** 被彻底移出列表的条目：清掉 `bv:` 关系（仍被别的列表引用时**不能**清） */
  for (const row of old) {
    if (remoteBvids.has(row.bvid) || keptBvids.has(row.bvid)) continue
    db.prepare(
      `DELETE FROM song_videos
        WHERE search_key = ? AND bvid = ?
          AND bvid NOT IN (SELECT bvid FROM videolist_items)`,
    ).run(directKeyOf(row.bvid), row.bvid)
  }

  return { added, removed }
}

/**
 * 导入一个列表（拉取 + 落库）
 *
 * 整个写入在**一个事务**里：中途失败不能留下「列表有 500 条、但只有前 200 条能播」
 * 这种半截状态（那种状态用户完全看不出原因）。
 *
 * 重复导入同一个收藏夹会命中同一行（id 由 kind + 平台 id 拼成），
 * 并且走的是和同步同一套合并规则 —— 所以「重新导入」不会洗掉收藏与手动加的条目。
 */
export const addVideoList = async (
  kind: BiliListKind,
  sourceId: string,
  mid?: string,
): Promise<{ record: VideoListRecord; skipped: number; existed: boolean }> => {
  const detail = await fetchBiliList(kind, sourceId, { mid, max: MAX_LIST_ITEMS })
  if (detail.items.length === 0) {
    throw new Error(
      detail.skipped > 0
        ? `这个列表里没有可播放的普通视频（跳过了 ${detail.skipped} 个合集 / 番剧条目）`
        : '这个列表是空的，或者没有可见内容',
    )
  }

  const id = videoListIdOf(kind, sourceId)
  const now = Date.now()
  const db = getDb()

  /**
   * 先查一遍是不是已经有这个列表
   *
   * 主键是「kind + 平台 id」拼出来的，所以重复导入必然命中同一行 ——
   * 这时候走的其实是**同步**（下面 `applyRemoteItems` 的合并规则会保住收藏与手动添加的条目），
   * 记录下 `existed` 只是为了给提示语用（「已导入」还是「已同步」）。
   */
  const existing = db
    .prepare(`SELECT last_index, created_at FROM videolists WHERE id = ?`)
    .get(id) as { last_index: number; created_at: number } | undefined

  tx(() => {
    db.prepare(
      `INSERT INTO videolists
         (id, kind, source_id, mid, name, cover, item_count,
          sync_mode, last_sync_at, last_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'off', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name         = excluded.name,
         cover        = excluded.cover,
         item_count   = excluded.item_count,
         mid          = COALESCE(excluded.mid, videolists.mid),
         last_sync_at = excluded.last_sync_at,
         updated_at   = excluded.updated_at`,
    ).run(
      id,
      kind,
      sourceId,
      mid ?? null,
      detail.name,
      detail.cover,
      detail.itemCount,
      now,
      /** 重新导入时**保留**上次播到第几条 */
      existing?.last_index ?? 0,
      existing?.created_at ?? now,
      now,
    )

    applyRemoteItems(db, id, detail)
  })

  const record = findVideoList(id)
  if (!record) throw new Error('列表写入失败')
  console.log(
    `[videolist] 已${existing ? '同步' : '导入'}《${record.name}》${detail.items.length} 条` +
      (detail.skipped > 0 ? `（跳过 ${detail.skipped} 个不支持的条目）` : ''),
  )
  return { record, skipped: detail.skipped, existed: !!existing }
}

/**
 * 重新同步一个列表
 *
 * ## 必须先记住「现在播的是哪个 bvid」，再按新顺序找回它的位置
 *
 * `last_index` 是**下标**。收藏夹按收藏时间倒序，用户收藏一条新的，全体原点 +1 ——
 * 不重定位的话下次打开就在播「上一条」。
 *
 * 这和音乐歌单 `syncPlaylist` 里那段是同一个坑，只是触发条件不同；
 * `playlist_songs` 那边靠 `toCacheKey` 反查，这里靠 bvid（更简单，因为条目天然唯一）。
 *
 * 本地列表没有远端来源，直接返回「不需要同步」—— 界面上那个按钮也会被禁用。
 */
export const syncVideoList = async (id: string): Promise<VideoListSyncResult> => {
  const record = findVideoList(id)
  if (!record) return { id, name: '', ok: false, error: '列表不存在' }
  if (isLocalKind(record.kind) || !record.sourceId) {
    return { id, name: record.name, ok: false, error: '本地列表没有远端来源，不需要同步' }
  }

  try {
    const detail = await fetchBiliList(record.kind as BiliListKind, record.sourceId, {
      mid: record.mid ?? undefined,
      max: MAX_LIST_ITEMS,
    })
    if (detail.items.length === 0) {
      return { id, name: record.name, ok: false, error: '这个列表现在没有任何可播放的视频' }
    }

    /** 同步前正在播的那条（按 bvid 记，不按下标） */
    const playingBvid = getVideoListItems(id)[record.lastIndex]?.bvid ?? null

    const db = getDb()
    let counts = { added: 0, removed: 0 }
    tx(() => {
      counts = applyRemoteItems(db, id, detail)

      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM videolist_items WHERE list_id = ?`).get(id) as
          | { n: number }
          | undefined
      )?.n ?? 0

      /**
       * `last_index` 按 bvid 重定位
       *
       * 三种情况与音乐歌单一致：
       *  ① 那条还在 → 用它在新列表里的下标；
       *  ② 那条被移除了 → 保留原下标并夹进范围（效果是「下一条顶上来」）；
       *  ③ 旧列表本来就是空的 → 0。
       */
      let nextIndex = 0
      if (total > 0) {
        if (playingBvid) {
          const pos = (
            db
              .prepare(`SELECT ord FROM videolist_items WHERE list_id = ? AND bvid = ?`)
              .get(id, playingBvid) as { ord: number } | undefined
          )?.ord
          nextIndex = typeof pos === 'number' ? pos : Math.min(record.lastIndex, total - 1)
        }
        nextIndex = Math.max(0, Math.min(nextIndex, total - 1))
      }

      db.prepare(
        `UPDATE videolists
            SET name = ?, cover = ?, last_sync_at = ?, updated_at = ?, last_index = ?
          WHERE id = ?`,
      ).run(detail.name, detail.cover, Date.now(), Date.now(), nextIndex, id)
    })

    console.log(`[videolist] 已同步《${detail.name}》：+${counts.added}/-${counts.removed}`)
    return {
      id,
      name: detail.name,
      ok: true,
      count: getVideoListItems(id).length,
      added: counts.added,
      removed: counts.removed,
      skipped: detail.skipped,
    }
  } catch (err) {
    console.error('[videolist] 同步失败:', err)
    return {
      id,
      name: record.name,
      ok: false,
      error: err instanceof Error ? err.message : '同步失败',
    }
  }
}

/**
 * 本地列表的默认名字：`本地列表` / `本地列表2` / `本地列表3` …
 *
 * 用户没填名字时用。从 2 开始编号（第一不叫「本地列表1」，读着别扭），
 * 已经存在就往后找第一个空位 —— 删掉「本地列表2」之后再新建还是叫 2。
 */
export const nextLocalListName = (): string => {
  const names = new Set(getVideoLists().map((item) => item.name))
  if (!names.has('本地列表')) return '本地列表'
  let n = 2
  while (names.has(`本地列表${n}`)) n += 1
  return `本地列表${n}`
}

/** 新建一个**本地列表**（没有远端来源，条目靠手动添加） */
export const createLocalList = (name?: string): VideoListRecord => {
  const db = getDb()
  const finalName = (name ?? '').trim() || nextLocalListName()
  const id = `bv_local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  db.prepare(
    `INSERT INTO videolists
       (id, kind, source_id, mid, name, cover, item_count,
        sync_mode, last_sync_at, last_index, created_at, updated_at)
     VALUES (?, 'local', NULL, NULL, ?, NULL, 0, 'manual', NULL, 0, ?, ?)`,
  ).run(id, finalName, now, now)
  const record = findVideoList(id)
  if (!record) throw new Error('新建本地列表失败')
  console.log(`[videolist] 已新建本地列表《${record.name}》`)
  return record
}

/**
 * 取默认列表（拖入单条视频的落点）
 *
 * ## 为什么要有「默认列表」
 *
 * 单条视频拖进来时总得放进某个列表。每次都问用户「放哪个列表」太啰嗦，
 * 随手新建一个又会攒出一堆「本地列表N」。所以固定一个落点：
 * 第一次需要时自动建好，之后一直用它（改名不影响身份，也不许删）。
 *
 * ## 三级兜底
 *
 *  1. 设置里有 id 且那一行还在 → 就是它；
 *  2. 设置里没有（老库 / 第一次运行）→ 认**最早的本地列表**
 *     （用户之前自己建过列表，没必要再塞一个新的「默认列表」给他）；
 *  3. 一个本地列表都没有 → 建一个「默认列表」（`create: false` 时跳过，返回 null）。
 *
 * 结果会写回设置项 `player.defaultVideoListId`，下次直接命中第 1 条。
 */
export const ensureDefaultVideoList = (
  options: { create?: boolean } = {},
): VideoListRecord | null => {
  const id = defaultListId()
  if (id) {
    const found = findVideoList(id)
    if (found) return found
    console.warn(`[videolist] 默认列表 ${id} 已不在库里（被外部删了？），重新挑一个`)
  }

  const fallback = getVideoLists().find((item) => item.kind === 'local')
  if (fallback) {
    updateSetting({ 'player.defaultVideoListId': fallback.id })
    console.log(`[videolist] 默认列表定为已有的《${fallback.name}》`)
    return { ...fallback, isDefault: true }
  }

  if (options.create === false) return null

  const created = createLocalList('默认列表')
  updateSetting({ 'player.defaultVideoListId': created.id })
  console.log(`[videolist] 已创建默认列表《${created.name}》`)
  return { ...created, isDefault: true }
}

/**
 * 「拖入单条视频」：加进默认列表（没有就现建一个）
 *
 * 顺便把「哪个列表是默认的」这件事留在主进程 —— 渲染层只拿 `listId` 去播放，
 * 不需要知道默认列表是怎么挑出来的。
 */
export const addItemToDefaultList = async (
  input: string,
): Promise<{ listId: string; listName: string; item: VideoListItem }> => {
  const list = ensureDefaultVideoList()
  if (!list) throw new Error('默认列表创建失败')
  const item = await addLocalItem(list.id, input)
  return { listId: list.id, listName: list.name, item }
}

/**
 * 「拖入本地文件」：登记 + 挂进默认列表（整批置顶）
 *
 * 和 `addItemToDefaultList`（B 站单条视频）是**同一件事的另一种入参**：
 * 落点一样、置顶规则一样、续播一样，区别只在「地址从哪来」——
 * 那边是 B 站解析，这边是文件路径（进 `videos.durl_url`，见 `localVideo.ts`）。
 *
 * ## 为什么一批文件只 bump 一次
 *
 * 发现顺序是零碎的：一次拖 10 个文件如果每个都 `bumpOrders` + 写 0，
 * 十次之后顺序会**整个反过来**（最后处理的排最前）。所以这里先把别人的
 * `ord` 一次性后移 N，再把这一批按拖进来的顺序写成 0..N-1 ——
 * 用户看到的就是「我拖的时候什么顺序，列表里就什么顺序」。
 *
 * ## 文件不存在 / 扩展名不对
 *
 * 不整体失败：能进几个进几个，剩下的一条条回报给渲染层提示。
 * 拖了一堆东西进来，因为其中一个坏了就全都不导入，那不叫安全，叫难用。
 */
export interface LocalFilesImportResult {
  listId: string
  listName: string
  items: VideoListItem[]
  /** 没进列表的（扩展名不像视频 / 文件读不到），带原因给界面提示用 */
  skipped: Array<{ path: string; reason: string }>
}

export const addLocalFilesToDefault = (paths: string[]): LocalFilesImportResult => {
  const list = ensureDefaultVideoList()
  if (!list) throw new Error('默认列表创建失败')

  const files: Array<{ bvid: string; filePath: string; title: string }> = []
  const skipped: Array<{ path: string; reason: string }> = []
  /** 同一批里重复拖同一个文件（多选里选中了两次）只算一次 */
  const seen = new Set<string>()

  for (const raw of Array.isArray(paths) ? paths : []) {
    const input = typeof raw === 'string' ? raw.trim() : ''
    if (!input) continue
    if (!isLocalVideoFile(input)) {
      skipped.push({ path: input, reason: '不是视频文件' })
      continue
    }
    try {
      if (!fs.statSync(input).isFile()) {
        skipped.push({ path: input, reason: '不是文件（是不是拖了个文件夹？）' })
        continue
      }
    } catch {
      skipped.push({ path: input, reason: '文件读不到（可能已被移走）' })
      continue
    }
    const bvid = localBvidOfPath(input)
    if (seen.has(bvid)) continue
    seen.add(bvid)
    files.push({ bvid, filePath: path.resolve(input), title: localTitleOfPath(input) })
  }

  if (files.length === 0) {
    return { listId: list.id, listName: list.name, items: [], skipped }
  }

  const db = getDb()
  const now = Date.now()

  tx(() => {
    db.prepare(`UPDATE videolist_items SET ord = ord + ? WHERE list_id = ?`).run(
      files.length,
      list.id,
    )
    files.forEach((file, index) => {
      /**
       * 实体行：**只**写 bvid / 标题 / 作者 / 路径。
       *
       * 不碰 `dash_*` —— 那些列对本地文件永远是 NULL（没有 B 站解析结果），
       * 而 `dash_tried` / `playurl_login_state` 保持默认值即可，
       * 本地分支根本不会走到「要不要重取地址」那段判断（见 handler 里的短路）。
       */
      db.prepare(
        `INSERT INTO videos (bvid, title, author, durl_url)
         VALUES (?, ?, '本地文件', ?)
         ON CONFLICT(bvid) DO UPDATE SET
           title    = excluded.title,
           author   = '本地文件',
           durl_url = excluded.durl_url`,
      ).run(file.bvid, file.title, file.filePath)

      /**
       * 已在列表里 → 只挪位置（**保住收藏标记**），否则插一行并记成「手动加的」。
       *
       * 先 UPDATE 再判断 `changes` 而不是先查一次：两个动作本来就是
       * 「命中就更新、没命中就插入」，多查一次只是多一次往返。
       */
      const moved = db
        .prepare(
          `UPDATE videolist_items SET ord = ?, added_at = ?
            WHERE list_id = ? AND bvid = ?`,
        )
        .run(index, now, list.id, file.bvid)
      if (!moved.changes) {
        db.prepare(
          `INSERT INTO videolist_items (list_id, bvid, ord, favorites, origin, added_at)
           VALUES (?, ?, ?, 0, 'local', ?)`,
        ).run(list.id, file.bvid, index, now)
      }
      ensureRelation(db, file.bvid)
    })
    refreshCount(db, list.id)
  })

  /** 时长可能早就被上一轮探针写过了（重复拖入同一个文件），读回来省得界面闪一下空 */
  const durations = new Map<string, number | null>()
  try {
    const rows = db
      .prepare(
        `SELECT bvid, duration FROM videos WHERE bvid IN (${files.map(() => '?').join(',')})`,
      )
      .all(...files.map((file) => file.bvid)) as Array<{ bvid: string; duration: number | null }>
    for (const row of rows) durations.set(row.bvid, row.duration ?? null)
  } catch {
    /* 读不到就当时长未知，探针随后会补 */
  }

  const items: VideoListItem[] = files.map((file) => ({
    bvid: file.bvid,
    title: file.title,
    cover: null,
    author: '本地文件',
    duration: durations.get(file.bvid) ?? null,
    favorites: false,
    origin: 'local',
  }))

  console.log(
    `[videolist] 已加入《${list.name}》${items.length} 个本地文件` +
      (skipped.length > 0 ? `（跳过 ${skipped.length} 个）` : ''),
  )
  return { listId: list.id, listName: list.name, items, skipped }
}

/** 改名（本地列表与同步来的列表都支持；后者下次同步会被远端名覆盖） */
export const renameVideoList = (id: string, name: string): boolean => {
  const finalName = (name ?? '').trim()
  if (!id || !finalName) return false
  try {
    getDb()
      .prepare(`UPDATE videolists SET name = ?, updated_at = ? WHERE id = ?`)
      .run(finalName, Date.now(), id)
    return true
  } catch (err) {
    console.error('[videolist] 重命名失败:', err)
    return false
  }
}

/**
 * 「添加视频」：解析链接 / BV 号 → 写进 videos → **插到列表最前**
 *
 * 和音乐歌单那边「添加视频」同一个做法：事务里把别人的 `ord` +1，自己写 0，
 * 于是新加的条目出现在置顶区最前。
 *
 * 已经在列表里的条目不报错，只把它挪到最前（用户的意图就是「我要它排第一」）。
 */
export const addLocalItem = async (listId: string, input: string): Promise<VideoListItem> => {
  const record = findVideoList(listId)
  if (!record) throw new Error('列表不存在')

  const info = await parseVideoInput(input)
  const db = getDb()

  tx(() => {
    upsertVideoMeta(db, info)
    bumpOrders(db, listId)
    db.prepare(
      `UPDATE videolist_items
          SET ord = 0, added_at = ?
        WHERE list_id = ? AND bvid = ?`,
    ).run(Date.now(), listId, info.bvid)
    /** 上面那条 UPDATE 没命中 = 库里还没有它 → 插一行（记住它是「手动加的」） */
    db.prepare(
      `INSERT OR IGNORE INTO videolist_items (list_id, bvid, ord, favorites, origin, added_at)
       VALUES (?, ?, 0, 0, 'local', ?)`,
    ).run(listId, info.bvid, Date.now())
    ensureRelation(db, info.bvid)
    refreshCount(db, listId)
  })

  console.log(`[videolist] 已添加到《${record.name}》：${info.bvid}`)
  return {
    bvid: info.bvid,
    title: info.title,
    cover: info.pic,
    author: info.author,
    duration: info.duration,
    favorites: false,
    origin: 'local',
  }
}

/**
 * 收藏 / 取消收藏列表里的某一条
 *
 * 收藏 = 置顶（`ord` 归零、其余 +1）；取消收藏**位置不动**，
 * 与 `cache.setFavorite` 的语义保持一致（那边也是只把 `favorites` 置 0）。
 */
export const setItemFavorite = (listId: string, bvid: string, favorite: boolean): void => {
  if (!listId || !bvid) return
  try {
    const db = getDb()
    tx(() => {
      const row = db
        .prepare(`SELECT favorites FROM videolist_items WHERE list_id = ? AND bvid = ?`)
        .get(listId, bvid) as { favorites: number } | undefined
      if (!row) return
      if (favorite) {
        // 已经是置顶的再点一次没意义，别白挪一遍
        if (row.favorites === 1) return
        bumpOrders(db, listId)
        db.prepare(
          `UPDATE videolist_items SET ord = 0, favorites = 1, added_at = ?
            WHERE list_id = ? AND bvid = ?`,
        ).run(Date.now(), listId, bvid)
      } else {
        db.prepare(
          `UPDATE videolist_items SET favorites = 0 WHERE list_id = ? AND bvid = ?`,
        ).run(listId, bvid)
      }
    })
  } catch (err) {
    console.error('[videolist] 收藏失败:', err)
  }
}

/** 从列表里删掉一条（只删关系；`videos` 的地址缓存留给 GC 判断） */
export const removeVideoListItem = (listId: string, bvid: string): boolean => {
  if (!listId || !bvid) return false
  try {
    const db = getDb()
    tx(() => {
      const row = db
        .prepare(`SELECT ord FROM videolist_items WHERE list_id = ? AND bvid = ?`)
        .get(listId, bvid) as { ord: number } | undefined
      if (!row) return
      db.prepare(`DELETE FROM videolist_items WHERE list_id = ? AND bvid = ?`).run(listId, bvid)
      /** 把后面的 ord 补上来，保证 0 起连续（否则置顶的 +1 会越加越大） */
      db.prepare(
        `UPDATE videolist_items SET ord = ord - 1 WHERE list_id = ? AND ord > ?`,
      ).run(listId, row.ord)
      db.prepare(
        `DELETE FROM song_videos
          WHERE search_key = ? AND bvid = ?
            AND bvid NOT IN (SELECT bvid FROM videolist_items)`,
      ).run(directKeyOf(bvid), bvid)
      refreshCount(db, listId)
    })
    return true
  } catch (err) {
    console.error('[videolist] 删除条目失败:', err)
    return false
  }
}

/** 删列表（连同条目关系与 `bv:` 候选行；被别的列表引用的不动） */
export const removeVideoList = (id: string): boolean => {
  /**
   * 默认列表**不许删**（用户要求：可以改名，不能删）
   *
   * 它是「拖入单条视频」的落点 —— 删掉之后下次拖视频还得悄悄再建一个，
   * 用户看到的会是「我刚删了它，怎么又冒出来了」。所以干脆拦住。
   * 界面上那个按钮已经按 `isDefault` 禁用了，这里只是最后一道闸。
   */
  if (id && id === defaultListId()) {
    console.warn('[videolist] 默认列表不允许删除')
    return false
  }
  try {
    const db = getDb()
    const bvids = (
      db.prepare(`SELECT bvid FROM videolist_items WHERE list_id = ?`).all(id) as Array<{
        bvid: string
      }>
    ).map((row) => row.bvid)

    tx(() => {
      db.prepare(`DELETE FROM videolist_items WHERE list_id = ?`).run(id)
      db.prepare(`DELETE FROM videolists WHERE id = ?`).run(id)
      for (const bvid of bvids) {
        db.prepare(
          `DELETE FROM song_videos
            WHERE search_key = ? AND bvid = ?
              AND bvid NOT IN (SELECT bvid FROM videolist_items)`,
        ).run(directKeyOf(bvid), bvid)
      }
    })
    console.log(`[videolist] 已删除列表 ${id}（${bvids.length} 条）`)
    return true
  } catch (err) {
    console.error('[videolist] 删除列表失败:', err)
    return false
  }
}

/** 记录「这个列表播到第几条」 */
export const setVideoListIndex = (id: string, index: number): void => {
  if (!id) return
  const value = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0
  try {
    getDb()
      .prepare(`UPDATE videolists SET last_index = ?, updated_at = ? WHERE id = ?`)
      .run(value, Date.now(), id)
  } catch (err) {
    console.error('[videolist] 记录播放位置失败:', err)
  }
}
