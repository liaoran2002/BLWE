/**
 * SQLite 连接 / 建表 / 事务（主进程）
 *
 * 为什么把「连接 + 建表 + 事务 helper」收在一个文件里：
 * 数据层从「一堆 JSON 文件」换成单库之后，**所有**读写都要经过同一个连接，
 * 而连接、PRAGMA、schema 版本三者必须同时就位才有意义。分散到各业务文件里写
 * 就会出现「这一处开了 WAL、那一处没开」这种查不出来的不一致。
 *
 * 几个刻意的选择（都是踩过的坑，不是随手写的）：
 *
 * 1. **`require` 而不是 `import`**
 *    better-sqlite3 是预编译的原生模块（`prebuilds/*.node`），必须由运行时按 .node
 *    真实路径加载，不能被打进 bundle。顶层 `import` 在打包/加密产物里会先被静态解析，
 *    一旦加载失败整个主进程都起不来（`winWallpaper.ts` 加载 koffi 用的是同一套做法）。
 *    另外它不带类型声明、仓库里也没装 `@types/better-sqlite3`，所以这里自己按
 *    **实际用到的那几个 API** 声明最小接口 —— 不是重新造一套类型。
 *
 * 2. **`PRAGMA user_version` 管 schema**
 *    库文件里没有任何「版本表」，但 schema 一定会继续演进。user_version 是 SQLite
 *    自带的一个整数位，读写不需要额外建表，正好当版本闸门用。
 *
 * 3. **惰性初始化**
 *    连接必须在 `app.getPath('userData')` 可用（便携模式改写之后）才能算路径，
 *    所以第一次真正用到库时才建连接；早了会写到错误的目录。
 */
import { app } from 'electron'
import path from 'node:path'

/**
 * 当前 schema 版本（`PRAGMA user_version`）；**改表结构时必须 +1**
 */
const SCHEMA_VERSION = 1

/** 库文件名（放在 userData 下，和 setting.json 同级） */
const DB_FILE_NAME = 'blmv.db'

// #region better-sqlite3 的最小类型声明
// 只声明本项目真正调用的成员：prepare / exec / pragma / transaction / close。
// 声明成「够用的最小集」而不是 any，是为了让调用处还能拿到 ts 检查（参数写错会红）。

interface SqliteRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface SqliteDatabase {
  prepare(source: string): SqliteStatement
  exec(source: string): SqliteDatabase
  /** `{ simple: true }` 时直接返回标量（如 user_version） */
  pragma(source: string, options?: { simple?: boolean }): unknown
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R
  close(): SqliteDatabase
  readonly open: boolean
}

interface SqliteConstructor {
  new (filename: string, options?: { timeout?: number }): SqliteDatabase
}

/** 加载好的构造函数（惰性加载，见 loadSqlite） */
let Sqlite: SqliteConstructor | null = null

/**
 * 惰性加载 better-sqlite3
 *
 * **不能在模块顶层 `require`**：这个模块被 cache / playlist 引用，
 * 而那两条线又被主进程入口引用 —— 顶层 require 一旦失败（缺二进制、
 * 打包漏了 prebuilds、平台不支持），报错会发生在「模块求值」阶段，
 * 整个主进程直接起不来，连一句能看懂的话都没有。
 * 放到函数里，失败就能走下面那条「console.error 说明原因再抛」的路径。
 * （`winWallpaper.ts` 加载 koffi 用的是同一套做法，理由一样。）
 *
 * 用 `require` 而不是顶层 `import` 还有第二个原因：它是预编译原生模块，
 * 必须由运行时按 `.node` 的真实路径加载，不能被打进 bundle。
 */
const loadSqlite = (): SqliteConstructor => {
  if (Sqlite) return Sqlite
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Sqlite = require('better-sqlite3') as SqliteConstructor
  } catch (err) {
    console.error(
      '[db] 无法加载 better-sqlite3（原生模块缺失或与 Electron ABI 不匹配）：',
      err,
    )
    throw new Error(
      `better-sqlite3 加载失败：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return Sqlite
}
// #endregion

/**
 * 建表语句
 *
 * **解析结果合在 `videos` 里，不再单独开表。**
 *
 * 曾经拆出过一张 `video_details`（按 bvid 唯一），理由是「同一个 bvid 被两个搜索键
 * 引用时地址会存两份」。但那个重复**很少见**，而拆表的代价是实打实的：每次查询都要
 * `LEFT JOIN`（还必须用 LEFT，用内连接会把没解析过的候选整批丢掉）、`clearAll` 要清
 * 三张表、补插一条记录要写两张表。解析结果拆成结构化字段之后列本来就多，
 * 再为它们单独开一张表、每次 join，收益更不划算，所以合回来。
 *
 * **为什么不再是整包 JSON**：原来 `view_result` / `playurl_result` 存的是接口原始响应。
 * - `view_result` **整个删掉**：它唯一的用途是取 `title` / `pic`，而这两列在
 *   `videos` 里本来就有（也不缺：view 接口每次解析仍要调，因为 **playurl 必须带
 *   `cid`**，而 `cid` 只能从 view 拿 —— 只是拿完不用存）。
 * - `playurl_result` 拆成下面那些列：体积大幅下降（原始响应含全部 durl 段落、
 *   账号权限字段等一堆用不到的东西），`playurl_at` / `login_state` 也变成可查询的真列。
 *
 * **`dash_video` / `dash_audio` 仍然存 JSON**，而且存的是**完整数组**（不止播的那一条）：
 * 渲染层「切换清晰度」是拿缓存里这份全量重新挑一条（`extractDashStreams`），
 * 只存播过的那条会导致每次切档位都要重新联网。保留全量也顺带把 `backupUrl`
 * 留了下来 —— 原来提取时就把备用地址丢了，某个 CDN 返回 403 时没法换。
 *
 * 关于「过期」：只有播放地址相关的列会过期（约 2 小时），
 * 标题 / 封面 / 收藏 / 顺序**永不过期**，所以清理只把这些列置 NULL、绝不删行。
 */
const CREATE_TABLES_SQL = `
-- 歌单
CREATE TABLE IF NOT EXISTS playlists (
  id               TEXT PRIMARY KEY,
  name             TEXT    NOT NULL,
  source           TEXT,
  source_url       TEXT,
  sync_mode        TEXT    NOT NULL DEFAULT 'off',
  sync_interval_ms INTEGER NOT NULL DEFAULT 0,
  last_sync_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_index       INTEGER NOT NULL DEFAULT 0
);

-- 歌单里的曲目（按 ord 排序）
CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id TEXT    NOT NULL,
  ord         INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  singer      TEXT    NOT NULL DEFAULT '',
  album       TEXT,
  cover       TEXT,
  -- 时长统一成**秒**（整数）。原来是音乐平台原样给的 "4:03" 字符串，
  -- 而候选视频那边（videos.duration）一直是秒 —— 两种形状在下游到处判断。
  -- 展示时再格式化回 mm:ss，见渲染层的 durationText。
  duration    INTEGER,
  PRIMARY KEY (playlist_id, ord)
);

-- 每首歌的候选视频：搜索结果 + 收藏 + 顺序 + 解析结果
CREATE TABLE IF NOT EXISTS videos (
  search_key     TEXT    NOT NULL,
  bvid           TEXT    NOT NULL,
  -- 列表顺序（0 起、连续）；收藏项排在最前
  ord            INTEGER NOT NULL DEFAULT 0,
  -- 展示字段（来自**搜索结果**，标题里带 <em class="keyword"> 关键词高亮，要留着）
  title          TEXT,
  -- 封面来自 **view 响应**（搜索结果里的封面尺寸偏小）
  pic            TEXT,
  author         TEXT,
  duration       INTEGER,
  favorites      INTEGER NOT NULL DEFAULT 0,

  -- ↓↓↓ 解析结果（dash / durl 播放地址）↓↓↓
  -- 渐进式 mp4 地址（durl 兜底通道，封顶 720P）；走 dash 时为 NULL
  --
  -- **durl 的清晰度编码在这个 URL 里**：实测「...-1-192.mp4」对应 quality 64、
  -- 「...-1-208.mp4」对应 80，即「URL 数字 = quality + 128」（24/24 样本成立，映射唯一）。
  -- 所以**不再单独存 quality 列** —— 读的时候从 URL 反推（见 utils/quality.ts）。
  -- 这是 B 站的 URL 命名约定而不是契约，所以那边反推失败时**不显示档位**，绝不猜。
  durl_url       TEXT,
  -- dash 视频轨**完整数组**（JSON）：含 baseUrl + backupUrl + id / width / height / mime
  --
  -- 它同时是**档位列表的来源**（dash.video[].id）—— 按 id 分 URL，没有 URL 就放不出来，
  -- 所以这份数组比 accept_quality 权威，也就没必要再存 accept_quality。
  dash_video     TEXT,
  -- dash 音频轨**完整数组**（JSON）
  dash_audio     TEXT,
  -- dash 总时长（秒）：分片 MP4 的 mvhd 常是 0，MSE 需要它补 MediaSource.duration
  dash_duration  INTEGER,
  -- 注意：**没有 quality 列**（durl 档位从 durl_url 反推，见上）
  -- 注意：**没有 support_formats 列**（那是静态映射，@common/constants 的内置档位表
  --       已覆盖全部 12 档，每行存一份 JSON 纯属冗余）
  -- 这份**播放地址**是在什么登录态下取的：0 否 / 1 是 / **NULL 未知**
  -- （NULL 必须与 0 区分：未知 ≠ 未登录，当成 0 会导致每次解析都白重取一遍）
  playurl_login_state INTEGER,
  -- 这次解析有没有试过 dash（试过但没拿到就别反复重取）
  dash_tried     INTEGER NOT NULL DEFAULT 0,
  -- 上面那批地址的写入时刻（过期判定）
  playurl_at     INTEGER,

  PRIMARY KEY (search_key, bvid)
);

-- 每首歌的元信息
CREATE TABLE IF NOT EXISTS song_meta (
  search_key    TEXT PRIMARY KEY,
  -- 这首歌上次播的是哪个视频（用户切视频时写）
  selected_bvid TEXT,
  -- **搜索结果**是在什么登录态下取的（0/1/NULL）。
  -- 刻意与 videos.playurl_login_state 分开：两者是不同时刻、不同请求的登录态快照 ——
  -- 搜索可能几小时前就做了，而地址是刚刚解析的。合并成一个字段必然互相覆盖。
  -- 用途：未登录时 B 站只返回部分结果，登录后可用它判断「这份结果该重搜」。
  search_login_state INTEGER,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_key_ord ON videos(search_key, ord);
-- 过期清理按 playurl_at 扫；这张表会随视频数一直长，没索引就得全表扫
CREATE INDEX IF NOT EXISTS idx_videos_playurl_at ON videos(playurl_at);

-- 元数据视图：**不含任何地址列**
--
-- 为什么需要它（实测数据）：一行候选的 dash_video + dash_audio 约 27 KB
-- （10 档视频轨 + 每档 4 个 backupUrl，签名参数很长），300 行候选就是 7.5 MB。
-- 而绝大多数读（列候选、合并收藏项、给渲染层的整包）**只要元数据** ——
-- 读全列要 9.6 ms，只读这个视图 0.64 ms，差 15 倍。
--
-- 视图在这里是「查询重写」而不是物化，SQLite 不会去读没被引用的列，
-- 所以它和手写列清单一样快（实测差 0.07 ms，噪声级），但调用方不用记列清单、
-- 加列时也不用改多处 SQL。
--
-- **「全部列」不需要再建一个视图** —— 那就是基表本身，包一层只是多余。
-- 需要地址的地方（解析前读地址）直接查基表。
--
-- 另一个好处：视图**默认只读**（SQLite 会拒绝 UPDATE 一个视图），
-- 写操作只能走明确的 UPDATE，避免有人误用视图改基表。
CREATE VIEW IF NOT EXISTS videos_meta AS
  SELECT search_key, bvid, ord, title, pic, author, duration, favorites,
         playurl_login_state, dash_tried, playurl_at
    FROM videos;
`

let db: SqliteDatabase | null = null
/** 退出关库的钩子只装一次（getDb 会被调用很多次） */
let quitHookInstalled = false

/** 库文件完整路径 */
const getDbPath = (): string => path.join(app.getPath('userData'), DB_FILE_NAME)

/**
 * 建表 / 抬升 schema 版本
 *
 * 只在**库里还没有版本号**（全新库，user_version = 0）时才执行建表语句：
 * 建表语句本身是 `IF NOT EXISTS`，重复执行无害，但把它当成常规流程会掩盖
 * 「版本号被人为改小」这类异常，所以这里用版本号当闸门。
 */
const migrateSchema = (database: SqliteDatabase): void => {
  const version = Number(database.pragma('user_version', { simple: true })) || 0

  if (version === SCHEMA_VERSION) return

  if (version > SCHEMA_VERSION) {
    /**
     * 库比代码新：用户可能降级过版本（装了旧包又换回来）。
     * 这种情况**绝不能**动表结构，只能继续用 —— 报一行日志，让问题可见。
     */
    console.warn(
      `[db] 库的 schema 版本(${version})高于当前程序(${SCHEMA_VERSION})，按原样使用（可能是降级运行）`,
    )
    return
  }

  if (version === 0) {
    database.exec(CREATE_TABLES_SQL)
    database.pragma(`user_version = ${SCHEMA_VERSION}`)
    console.log(`[db] 已初始化数据库，schema 版本 -> ${SCHEMA_VERSION}`)
    return
  }

  /**
   * 旧版本库：**直接丢弃重建**，不写逐字段搬运。
   *
   * 这是刻意的选择，不是偷懒：
   *  - 本项目**只有一个用户**（作者本人），且 SQLite 数据层**从未发布过** ——
   *    v1 只存在于开发期本机，所以「升级」实际只发生在自己的机器上，重搜一次即可；
   *  - 逐字段搬运要处理「旧列可能不存在 / 类型不同 / 解析结果要重新拆」三种情况，
   *    代码量和出错面都比「丢掉重来」大得多，而收益只是省几次重新解析。
   *
   * 副作用要说清楚：**收藏、顺序、选中视频会一起没了**（歌单本身在
   * `playlists` / `playlist_songs`，也在同一库里，同样会被清掉）。
   * 真要保留数据请自己先备份 `blmv.db`。
   *
   * 表名和本次 schema 的差异见上面 SCHEMA_VERSION 的历史注释。
   */
  if (version < SCHEMA_VERSION) {
    console.warn(
      `[db] 库的 schema 版本(${version})低于程序(${SCHEMA_VERSION})，按「不迁移」的约定重建库（数据会清空）`,
    )
    // 顺序无所谓（没有真外键），但要连旧版本留下的表一起清掉，否则残留表会一直在。
    // **视图必须显式 DROP VIEW** —— `DROP TABLE` 管不到视图，留着旧视图会让
    // 下面的 `CREATE VIEW IF NOT EXISTS` 变成空操作，于是视图停留在旧列结构上。
    database.exec(`
      DROP VIEW IF EXISTS videos_meta;
      DROP TABLE IF EXISTS videos;
      DROP TABLE IF EXISTS video_details;
      DROP TABLE IF EXISTS song_meta;
      DROP TABLE IF EXISTS playlist_songs;
      DROP TABLE IF EXISTS playlists;
    `)
    database.exec(CREATE_TABLES_SQL)
    database.pragma(`user_version = ${SCHEMA_VERSION}`)
    console.log(`[db] 已重建数据库，schema 版本 -> ${SCHEMA_VERSION}`)
    return
  }
}

/**
 * 取数据库连接（惰性初始化 + 建表）
 *
 * 失败时**先 console.error 说明原因再抛**：静默降级成「没有缓存」会让用户
 * 以为是 B 站接口的问题，实际是本地库打不开（权限、磁盘满、文件被占用）。
 */
export const getDb = (): SqliteDatabase => {
  if (db && db.open) return db

  const file = getDbPath()
  try {
    const Database = loadSqlite()
    db = new Database(file)
    /**
     * WAL：主进程写、可能还有托盘窗口读，WAL 下读写不互相阻塞；
     * 而且崩溃后不会留下半个库文件。
     */
    db.pragma('journal_mode = WAL')
    /**
     * 外键约束：当前建表语句里没有 `REFERENCES`，所以这行**暂时是空转**。
     * 仍然打开，是为了以后真加外键时不用回头补 —— 而 SQLite 默认是关的，
     * 漏掉这一行会让「约束明明写了却不生效」变成一个很难发现的坑。
     */
    db.pragma('foreign_keys = ON')
    migrateSchema(db)
  } catch (err) {
    db = null
    console.error(`[db] 打开数据库失败（缓存/收藏/歌单都会不可用）：${file}`, err)
    throw new Error(`数据库打开失败：${err instanceof Error ? err.message : String(err)}`)
  }

  if (!quitHookInstalled) {
    quitHookInstalled = true
    /**
     * 退出时关库
     *
     * 用 `will-quit` 而不是 `before-quit`：before-quit 之后渲染层还会收到
     * beforeunload 并可能再发一次写 IPC（如写回 selectedBvid），
     * 这时连接已经关掉就只能重新开一个，反而留下一个没人关的连接。
     * will-quit 是最后一个还能干活的时机，关在这里正好做 WAL 收尾。
     */
    app.on('will-quit', () => {
      closeDb()
    })
  }

  return db
}

/**
 * 关闭数据库连接（退出前调用；重复调用无害）
 */
export const closeDb = (): void => {
  const current = db
  db = null
  if (!current || !current.open) return
  try {
    current.close()
    console.log('[db] 数据库已关闭')
  } catch (err) {
    console.error('[db] 关闭数据库失败（退出阶段，忽略）：', err)
  }
}

/**
 * 事务包装
 *
 * better-sqlite3 的 `transaction()` 返回的是一个**可执行函数**，不是立即执行；
 * 每次调用都新建一个事务函数（有极小的开销，但换来调用处完全不用关心嵌套/回滚）。
 * 注意不要在 fn 里写 async 代码 —— SQLite 的事务是同步的。
 */
export const tx = <T>(fn: () => T): T => {
  const database = getDb()
  return database.transaction(fn)()
}
