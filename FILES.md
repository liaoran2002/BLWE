# 文件职责与实现逻辑

> 这份文档回答两个问题：**每个文件负责什么**、**每项功能是怎么实现的**。
>
> - 想看架构 / 数据流 / 踩坑记录 → [ARCHITECTURE.md](ARCHITECTURE.md)
> - 想看怎么用 → [README.md](README.md)
>
> 阅读顺序建议：先看 [第一部分（文件职责）](#第一部分每个文件负责什么) 建立地图，
> 再看 [第二部分（功能实现）](#第二部分每项功能怎么实现的) 把跨文件的链路串起来。

---

## 目录

**第一部分：每个文件负责什么**

- [1. 主进程（electron/main/）](#1-主进程electronmain)
- [2. 主进程与渲染层共用（electron/common/）](#2-主进程与渲染层共用electroncommon)
- [3. 预加载（electron/preload/）](#3-预加载electronpreload)
- [4. 渲染层（src/）](#4-渲染层src)
- [5. 构建与打包](#5-构建与打包)

**第二部分：每项功能怎么实现的**

- [1. 歌单导入与解析](#1-歌单导入与解析)
- [2. 搜索：从歌名到候选视频列表](#2-搜索从歌名到候选视频列表)
- [3. 搜索结果排序（硬过滤 + 打分）](#3-搜索结果排序硬过滤--打分)
- [4. 播放地址解析（dash / durl 两条路）](#4-播放地址解析dash--durl-两条路)
- [5. dash + MSE 播放](#5-dash--mse-播放)
- [6. 切歌预热（为什么切歌几乎无感）](#6-切歌预热为什么切歌几乎无感)
- [7. 收藏与「添加视频」](#7-收藏与添加视频)
- [8. 续播](#8-续播)
- [9. 桌面壁纸模式](#9-桌面壁纸模式)
- [10. 系统托盘（含自绘菜单）](#10-系统托盘含自绘菜单)
- [11. 配置（setting）的读写与广播](#11-配置setting的读写与广播)
- [12. 缓存与过期](#12-缓存与过期)
- [13. 打包与代码保护](#13-打包与代码保护)

---

# 第一部分：每个文件负责什么

## 1. 主进程（electron/main/）

### `index.ts` —— 主进程入口与总装配

**职责**：编排启动顺序，持有主窗口 / 登录窗口 / 自绘托盘菜单窗口的生命周期，
维护「应用层模拟全屏」与「桌面壁纸模式」两套状态机，管理托盘，
响应显示器变化，退出前 flush 配置与歌单。

**启动顺序即契约**（顺序错了会出真问题）：

```
① setupUserDataPath()          ← 必须最早期，改 userData
② registerProtectedScheme()    ← 必须在 whenReady 之前，privileges 才生效
③ whenReady → initSetting() + initPlaylists()
④ installProtectedProtocol()   ← 必须在建窗之前
⑤ registerIpcHandlers({...20 个能力})
⑥ createMainWindow() + createTray()
⑦ watchDisplayChanges() + grabCookiesSilently()
```

整条链末尾挂了 `.catch()` → `dialog.showErrorBox` + `app.exit(1)`，
避免 `initSetting` 抛错时进程静默停在「没有窗口」状态（用户只看到双击没反应）。

**关键设计**：

- **全屏是应用层模拟**：`applyFullScreenGeometry()` = `setAspectRatio(0)` →
  `setBounds(所在屏 bounds)` → `setAlwaysOnTop(true)`。`isFullScreen` 由主进程自维护，
  **绝不从原生状态回读**（`resize` 处理器明确不回写它）。
  历史原因见 `transparent` 那条，但**现在主窗口已经不透明了**，模拟仍保留。
- **壁纸模式唯一入口 `setWallpaperMode(want)`**：用 `wallpaperWant` + `wallpaperBusy`
  实现**串行 + 合并**（以最后一次目标为准）。进入时**先置 `wallpaperAttached = true`
  再 attach**（宁可多摘一次，不能漏摘），失败无条件回滚。
- **`wallpaperEnabled` 与 `wallpaperAttached` 分开**：`SetParent` 不可逆 ——
  一旦执行窗口就已离开正常窗口层，哪怕后续失败、标志被翻回 false，也**必须**摘回来。
- **`restoreWindow()` 三条件取或**：`wallpaperEnabled || wallpaperAttached ||
  isAttachedToWallpaper(win)` —— 不看标志，直接问系统，所以状态漂移也能救回来。
- **自绘托盘菜单**：独立置顶窗口（208 宽、frameless/transparent、`screen-saver` 层级）。
  每次弹出都**重装 120ms 兜底定时器**，因为页面「高度没变就不回报」。
- **两个 `webRequest` 钩子**：注入 `Referer`（跳过登录窗口自己的请求）、
  媒体域 CORS 统一覆写（**必须大小写不敏感地先删再加**）。

**踩过的坑（举几个最重的）**：

| 坑 | 后果 |
| --- | --- |
| 透明窗口 + 无 GPU 加速 → `WS_EX_LAYERED` | 挂到 WorkerW 后**声音还在、画面没了** |
| attach 失败时回滚没 `SetParent` 回来 | 窗口永久留在桌面层且不可见，托盘也救不回来 |
| `grabCookiesSilently` 没有硬超时 | 该隐藏窗口在世则 `window-all-closed` 不触发，**用户再也无法关窗退出** |
| ACAO 大小写 | 直接赋大写 key 等于又加一条，浏览器判非法，报错从 1 条变 20 条 |
| 主窗口关了但 `trayMenuWindow` 没收 | `window-all-closed` 永不触发，进程留在后台 |
| 拔屏后还原点落在不存在的坐标 | 退出全屏后窗口跑到屏幕外，点托盘也救不回来 |

### `ipcHandlers.ts` —— IPC 注册总入口

**职责**：定义依赖注入契约 `IpcContext`，按领域依次调用各 `register*Handlers`。

**为什么要有它**：注释直接给了理由 ——「避免像原来那样把所有 `ipcMain.handle`
堆在一个文件里」。`IpcContext` 是一份**显式的能力清单**（20 个闭包能力），
`ipc/*.ts` 因此不认识 `mainWindow`/`tray`，只认识 `IpcContext`。

### `ipc/` 目录 —— 按领域拆分的 handler

| 文件 | 职责 |
| :--- | :--- |
| `setting.ts` | 配置三条：`get` / `update` / `reset`。**主进程接管配置后对渲染层的唯一入口** |
| `app.ts` | 只有 `app:openExternal`，**协议白名单**（只放行 http/https） |
| `auth.ts` | 登录三条：`startLogin` / `setLoggedIn` / `executeLogout` |
| `window.ts` | 窗口控制九条（最小化 / 关闭 / 最大化 / 全屏 / 拖动 / 移动 / 工作区） |
| `wallpaper.ts` | 壁纸两条：`toggle`（返回切换后状态）/ `isEnabled` |
| `tray.ts` | 托盘状态上报 + 自绘菜单四条 + 任务栏进度 |
| `biliApiHandlers.ts` | ★ **搜索 / 解析视频 / 收藏**，见下面单独一节 |
| `playlist.ts` | 歌单三条：`get` / `save` / `sync` |
| `music.ts` | 只有 `music:getPlaylistDetail` —— ★ 但它是**唯一的加工点**：归一化曲目字段 + 拼好歌单主键，见下 |
| `cache.ts` | 缓存三条：`clearAll` / `getStats` / `prune` |

**`music.ts` 为什么不是「转发一下」那么简单**：解析结果必须在这里
**加工成成品**再交给渲染层，否则渲染层就得懂音源字段、还会在转换途中丢东西：

```ts
const detail = await resolvePlaylist(params)
// ① 音源字段 → 库里形态（interval:"4:03" → duration:243、albumName → album、保留 platformId）
const songs = toPlaylistSongs(detail.songs)
// ② 拼好歌单主键（平台_平台歌单id，如 tx_8153225605）
const id = playlistKey(detail.source, detail.listId)
return { info, songs, total, page, limit, source, id }
```

返回里**不含 `listId`**（它只用于上面拼 `id`）、也不含 `platformId` 之外的音源细节 ——
渲染层拿到的是「能直接回传落库」的成品，**它不认识 `listId`，也不知道拼装规则**。

**共同的信任边界处理**：所有跨进程入参在主进程侧**再校验一次** ——
`app:openExternal` 只放行 http/https；`auth:setLoggedIn` 收窄成 `=== true`；
`trayMenu:ready` 的高度、`window:setProgress` 的进度、`win:moveWindow` 的坐标
全部做 `Number.isFinite` 校验。动机是「坏值在主进程抛错时，报错点离根因太远」。

> 例：`trayMenu:ready` 若收到 `NaN`，`Math.max(60, NaN)` 还是 `NaN`，
> 交给 `setBounds` 会抛错 —— 那这次菜单就弹不出来了，
> 而报错点在主进程里，排查时完全想不到是「页面量了个坏高度」。

### `biliApi.ts` —— B站接口封装

**职责**：登录态（nav）、WBI 签名、搜索、view、playurl。
纯「取数据」层，**不做过滤排序、不读设置、不碰缓存**。

**关键设计**：

- **WBI 签名**：`getMixinKey(imgKey, subKey)` 按 64 项重排表取前 32 位；
  `encWbi` 先设 `wts` → 按 key **字典序排序** → `w_rid = md5(query + mixinKey)`。
  mixinKey 缓存 6 小时。
  > ⚠️ **`tids` 必须在签名之前设好** —— 原来顺序反了，请求串里带了 tids
  > 但 `w_rid` 没覆盖它，服务端重算对不上 =「拿不到 mixin key 时搜索全挂」。
- **登录态三态**：`loginState: boolean | null`，**`null` = 「还不知道」**，与 `false` 严格区分。
  nav 请求失败时**不动**登录态（「宁可保留上一次的结论，也不要被网络抖动带偏」）。
  > 只看 `data.isLogin` 的写法会把风控响应（HTTP 200 但 `code` 为 -352/-412）
  > 判成「明确未登录」，于是 `loginState: false` 被写进缓存条目，
  > 之后每次解析都判「未登录时取的，现已登录」而成片重解析。
- **失败退避**：`navFailedAt` + 15s，避免「登录窗口在轮询 + 每次解析都问」时的请求风暴。
- **`resolveVideoUrl`**：view 拿 cid → **优先 dash**（`fnval:16`）→ 失败退 durl（`fnval:1`）。
  dash 失败**不致命**（除 `AUTH_FAILED` 外都吞掉并 warn）。
- **CDN 挑选**：`pickNormalCdnUrl` 优先常规域，排除 P2P / 边缘节点。
  > 实测见过 `*.mountaintoys.cn`、`*.szbdyd.com` 这类 P2P 地址，
  > 只对官方客户端有效，普通 HTTP 请求会被 **403** 拒掉 ——
  > 现象是「别的视频都能放，只有这一个怎么也放不出来」，而且不报任何错。
- **地址有效性**：`isUrlUsable` 查 `deadline`，留 5 分钟余量；
  **拿不到 deadline 时返回 true**（无法判断就按「未知」处理，不当作过期）。
- **`searchSongFiltered`**：搜索 + 补齐 + **降级重搜**（**四级**，见
  [功能实现 §2](#2-搜索从歌名到候选视频列表)）。入参是
  `(song, singer, songDurationSec, minResults, toleranceSec, filterKeywords, tagBonus, firstPage?)`
  —— **歌名与歌手分开传**，不是一个 `歌名-歌手` 拼串。
  > 拼串再拆是**有歧义**的：歌名本身可能含 `-`（`下坠Falling` / `R.` / `若是明仔载`），
  > 按 `-` 切会切错。而且两者本来就是两个独立字段，只有拼搜索词那一刻才需要同时在场。
- **降级是「累加合并」不是「替换」**：每一轮的结果按 `bvid` 去重后**追加**到结果池。
  > 用户原话：「降级的意思是降级搜索，**不是要把之前的结果不要啊**」。
  > 原来的实现是「哪一轮过滤后更多就用哪一轮」，于是第 1 轮的 10 条会被降级轮的
  > 36 条**整个顶掉**。
- **`countPassing` 必须先把 B站返回的 `favorites` 置 false**：B站搜索接口返回的每条里
  本来就有个 `favorites`（「这条视频被多少人收藏了」，一个数字、几乎总是 truthy），
  而 `rankVideos` 用 `v.favorites` 判断「是不是**用户在我们这儿**收藏的」并**豁免过滤**。
  > 不清掉的后果（实测）：39 条搜索结果里 38 条被当成"收藏" → 全部豁免 →
  > `countPassing = 39` → 判定「够了，不降级」→ 而真过滤后只剩 24 条。
  > 表现就是日志里两个数字对不上，且**降级永远不触发**。
- **日志一行说清两端**：`关键词 取回N → 过滤M（P页/R轮，挡掉K）`。
  取回是**原始条数**（含被规则挡掉的），过滤是写进库的条数 ——
  两者摆在一起才解释得清「取回 80 条怎么列表里只有 40 项」。
  > 措辞注意：`R轮 = 1` 时走的是**主搜索词**，不是降级词。早先一律写
  > 「降级词「X」」会让人以为走了降级（用户直接指出过）。

### `utils/db.ts` —— SQLite schema

**职责**：数据层的唯一入口 —— 连接、PRAGMA、建表 SQL、schema 指纹闸门、事务包装。

**五表一视图三索引**：

| 表 / 视图 | 内容 |
| --- | --- |
| `playlists` | 歌单（id / name / url / sync_mode / sync_interval_ms / last_sync_at / created_at / updated_at / last_index） |
| `songs` | **歌曲实体，全局唯一**（id / name / singer / album / cover / duration）；**duration 存秒** |
| `playlist_songs` | 歌单 ⨯ 歌曲的**成员关系 + 顺序**，PK `(playlist_id, ord)`，只有 `song_id` |
| `videos` | 候选视频，PK `(search_key, bvid)`；展示列 + 解析列（地址 / 登录态快照） |
| `song_meta` | 每首歌的 `selected_bvid` + `search_login_state`，PK `search_key` |
| `videos_meta` | **视图**：`videos` 去掉全部地址列的只读投影 |

索引：`videos(search_key, ord)`、`videos(playurl_at)`、`playlist_songs(song_id)`。

**`songs` 与 `playlist_songs` 为什么要分开**（参考 lx-music 的
`my_list_music_info` + `my_list_music_info_order`，但做得更彻底）：

| | 旧做法（曲目信息塞在关系表里） | 现在 |
| --- | --- | --- |
| 同一首歌在 2 个歌单 | **存 2 行**，歌名/歌手/专辑/封面/时长全重复 | `songs` 表 **1 行**，`playlist_songs` 2 行 |
| 改一次歌名的后果 | 两个歌单里可能一个新名一个旧名 | 一处改、处处一致 |

lx 的 `my_list_music_info` 仍然**按歌单各存一份**（实测 684 行 / 623 首不同的歌），
只有「顺序」被拆了出去；这里把**曲目信息与歌单彻底分开**。

**id 的形态（两张表都不是随机 id）**：

| 表 | id 形态 | 例 |
| --- | --- | --- |
| `playlists` | `平台_平台歌单id` | `tx_8153225605` |
| `playlists`（手动新建） | `pl_<uuid>` | `pl_7f3a…`（没有平台链接可拼） |
| `songs` | `平台_平台歌曲id` | `tx_1828354` |
| `songs`（手动添加的歌） | `歌名-歌手` | `手写的歌-某人` |

> **为什么歌单 id 不用随机 UUID**：同一个歌单**重复导入会命中同一行**，
> 而不是攒出一堆副本；重启 / 换机器后靠 `sourceUrl` 也能推出同一个 id。
> `pl_` 前缀是刻意加的 —— 一眼能看出「这不是平台 id」。
> 拼装统一由主进程做（`playlistKey()`），见 [功能实现 §1](#1-歌单导入与解析)。

**`source` 不再单独存列**：它已经编码在 `id` 前缀里（`tx_`），
用 `sourceOfSongId()` 反推即可 —— 少一列就少一处可能不一致的地方。
> ⚠️ 反推**只认 `wy/tx/kw/kg`**：否则兜底的 `pl_xxx` 会被解析成音源 `pl`，
> 那是个不存在的平台，下游拿去用会**静默出错**。

**写库的关键三步**（`writePlaylistsToDb`）：

1. `upsertSong` —— 同一个 `id` 可能被多个歌单引用，第二次遇到时**覆盖**
   （以最新那份为准：同步刚拉回来的元数据更可信）；
2. `keepIds` 集合 —— 记下本次保存里出现过的所有 song id；
3. `DELETE FROM songs WHERE id NOT IN (...)` —— **只删没人再引用的**。
   > ⚠️ `songs` 是**全局共享**的曲目实体表，绝不能无脑 `DELETE FROM songs`：
   > 那会把别的歌单正在引用的曲目一起删掉，关系表虽然还有记录，
   > 但实体没了 → 读的时候**全是悬空引用 → 曲目整片消失**。
   >
   > 用一条 `NOT IN` 而不是遍历逐个删：`keepIds` 可能上千个，
   > 逐个 `DELETE` 就是上千次语句执行。
   > `keepIds` 为空时（歌单全删了）`NOT IN ()` 是语法错误 —— 那种情况整体清空。

**`playlists.url` 是原来的 `source_url` 改名** —— 列名跟 `PlaylistRecord.sourceUrl`
的对应关系没变，只是更短。

**关键设计**：

- **`videos_meta` 视图为什么存在（有实测数据）**：一行候选的
  `dash_video` + `dash_audio` 约 **27 KB**（10 档视频轨 + 每档 4 个 backupUrl），
  300 行就是 7.5 MB；而绝大多数读**只要元数据** ——
  读全列 **9.6 ms** vs 只读视图 **0.64 ms**，**差 15 倍**。
  视图在 SQLite 里是「查询重写」不是物化，不会读未引用的列。
  附带好处：视图**默认只读**（SQLite 拒绝 UPDATE 视图），写操作只能走明确的 UPDATE。
- **`schemaFingerprint()` 替代手写 `SCHEMA_VERSION`**：
  `sha256(CREATE_TABLES_SQL)` 前 4 字节 `& 0x7fffffff` 写进 `PRAGMA user_version`。
  > 手写常量当闸门时，改表忘了 +1 就会出现「旧库带旧列结构跑起来、
  > 在某个查询上报错」—— 运行时才炸，最难查。改哈希后「忘了升版本」不可能再发生。
- **不做迁移**：本项目只有一个用户、数据层从未发布过。指纹不匹配就
  **把库里所有表 / 视图都 DROP 掉再重建**（数据清空，**从不写迁移代码**）。
  > ⚠️ **DROP 清单是动态取的，不是手写的**：早先手写一份
  > 「`DROP VIEW videos_meta; DROP TABLE videos; DROP TABLE song_meta; …`」，
  > 结果删歌词功能时**建表语句删了、DROP 清单忘了删** ——
  > `lyrics` / `subtitles` 两张表从此**每次重建都清不掉**，永远留在库里当垃圾。
  >
  > 现在改成查 `sqlite_master` 拿全部表名再逐个 drop，不可能再漏：
  >  - **视图必须先于表 drop**（表被删后视图就悬空了，SQLite 不会自动清），
  >    所以按 `type` 排序把 `view` 排前面；
  >  - `sqlite_%` 开头的（`sqlite_sequence` / `sqlite_stat1`）是 SQLite 自己维护的，
  >    **绝不能被 drop**。
  - **模块求值阶段的反引号断言**：`CREATE_TABLES_SQL` 里出现反引号就抛错。
  > 建表 SQL 是模板字符串，在 SQL 注释里用反引号包标识符会**提前终止字符串**，
  > 后面所有 SQL 变成 JS → 一串 `TS1005`/`TS1443`，报错行指向 SQL 中间，
  > **完全看不出根因**。这个错犯过三次，所以用断言根治。
- **`require` 而非顶层 import** better-sqlite3：它是预编译原生模块，
  顶层 require 失败发生在**模块求值阶段**，整个主进程直接起不来、连一句能看懂的话都没有。
- **过期语义**：只有**播放地址那一批列**会过期，元数据 / 收藏 / 顺序永不过期；
  清理**只置 NULL、绝不删行** —— 这是「收藏不会自己消失」的前提。

### `utils/cache.ts` —— 搜索缓存 + 收藏 + 地址

**职责**：搜索缓存、候选视频、收藏、每首歌选中视频、播放地址、过期清理、缓存统计。

**★ `save(keyword, data)` 是本文件最容易出错的地方（DELETE + INSERT）**：

1. 空 result 直接返回 false（不写）
2. 按 bvid 去重丢空，只留第一次出现的位置（**顺序权威在调用方**）
3. **在 `save` 内部重新读一次库**（不用调用方的旧快照）
4. **地址列如何保留**：DELETE 之后整批重插，而新搜索结果里**根本没有地址**
   （搜索接口只给标题/封面/时长），唯一来源就是旧行 → `insertRow` 把旧行的
   地址列原样写回。**列清单是全量的** —— 少写一个地址列，对应那种地址
   就会在每次刷新列表时被清成 NULL
5. **收藏如何保住（`orphans`）**：`favorites === 1 && !seen` 的行补在**列表最后**
6. **`favorites` 只认库里的旧值**（`old?.favorites ?? 0`）
7. 入参没带的展示字段**回落旧值**，避免把好数据抹成空
8. `selectedBvid` 只有是有效字符串才写，**绝不写 null**（会抹掉用户的选择）

**为什么第 3 步要在 `save` 内部重读**：`api:searchSong` 是
「读库 → 联网搜索/回源刷新收藏项（**秒级 await**）→ 写库」，
中间那段 await 里用户完全可能刚点了一个收藏。拿旧快照写回，
那个刚收藏的条目不在新结果里 → 被 DELETE 一起删掉，
用户看到「我收藏了一下，刷新完它没了」。

**`updateVideoResult` 为什么不走「get 整包 → 改一条 → save」**：
① 避免互相覆盖（解析要跑两次网络往返，期间同一 keyword 上很可能还有别的事在发生）；
② **不碰 `ord`** —— 整包 save 会按数组下标重写顺序，而解析地址跟「列表怎么排」毫无关系。

**`setFavorite` 用「前面各 +1、自己置 0」**而不是「取最小值 - 1」：
递减方案会让 ord 变负数且不连续（来回收藏几十次到 -50），
而且 `save()` 按下标从 0 重写，那些负数**活不过一次重新搜索**。

### `utils/playlist.ts` —— 歌单集合服务

**职责**：SQLite 读写 + 内存常驻快照 + 同步（重新解析曲目）。

**对外导出**（几个跟本轮改造相关的）：

| 导出 | 作用 |
| --- | --- |
| `toPlaylistSongs(songs)` | ★ **音源 `ParsedSong[]` → `PlaylistSong[]`** 的唯一转换入口 |
| `findSongByCacheKey(cacheKey)` | 按 `songId` 查歌曲完整信息（拼搜索词要歌名+歌手） |
| `findSongDuration(cacheKey)` | 查歌曲时长；内部改为调 `findSongByCacheKey` |
| `getPlaylists()` / `savePlaylists()` / `syncPlaylists()` | 集合的读 / 写 / 同步 |
| `initPlaylists()` / `flushPlaylists()` | 启动加载 / 退出兜底落盘 |

**★ `toPlaylistSongs` 为什么不写在渲染层**（这是本轮改动的要害）：

音源给的字段名/单位跟库里**不一样**：

| 音源给的 | 库里要的 |
| --- | --- |
| `interval: "4:03"` | `duration: 243`（**秒**） |
| `albumName` | `album` |
| `platformId` | `platformId`（**拼 `songs.id` 要用**） |

这段转换原来写在 `PlaylistManager.vue`，后果是 **`platformId` 被丢掉了** ——
渲染层根本不知道它有用，于是 `songs.id` 只能退化成 `歌名-歌手`，
**白拆了 `songs` / `playlist_songs` 两张表**（实测：库里 221 条 `songs.id`
全是 `歌名-歌手`，带平台前缀的 **0 条**）。

现在统一在主进程转完：**IPC 出口和 `syncPlaylist` 共用同一个函数**，
保证「解析 → 渲染层原样回传」与「同步直接改内存」两条路径产出的形状**完全一致**
（否则同一首歌走两条路径会得到不同的 `duration` / `platformId`）。

**关键设计**：

- **内存权威 + 落库**：内存里常驻一整份 `data`。同步要跑好几秒网络请求，
  期间渲染层会发若干次 `playlists:save`；如果每次读写都直接打数据库，
  `syncingIds` 那套「正在同步的歌单以主进程内存为准」的保护就无从谈起。
- **`syncingIds` 为什么存在**：同步期间渲染层任何一次 persist
  （切歌单、编辑歌单）都会拿它手里的**旧曲目列表**把同步结果盖掉，
  随后界面还照样提示「同步完成 +N/-M」—— 用户看到的是「同步了个寂寞」。
- **先删后插而不是逐条 upsert**：渲染层发来的是**全量快照**，
  被删掉的歌单/曲目必须真的消失；upsert 表达不了「这一条没了」。
  > ⚠️ 但 `songs` 表**不能无脑全清**（它是全局共享的实体表）——
  > 只删「本次没人再引用」的那些，见 `db.ts` 那节。
- **不删 `song_meta` / `videos`**：那两张表按搜索键记收藏与播放地址，
  删歌单不该顺手把用户收藏的视频全清了（重新加回同一个歌单，收藏还在）。
- **「哪个歌单是当前」不落库**：每切一次就变，真值只在内存，启动时取第一条。
- **`readPlaylistsFromDb` 是「两次全表读 + 内存拼装」**：曲目实体从 `songs`
  读成 `id → PlaylistSong` 字典，关系表按 `(playlist_id, ord)` 读出来直接就是
  各歌单的顺序（排序在 SQL 里做，JS 里 `push` 的顺序天然正确）。
  不是「每条歌单查一次」的 N+1 写法。
  > **悬空引用**（关系表有、实体表没有）会**跳过并告警**，而不是补一条空壳 ——
  > 补空壳会在界面上留一个点不动的空行。正常不会发生（写库在同一事务里）。
- **`syncPlaylist` 用 `toPlaylistSongs` 归一**（与 IPC 出口同一个函数）；
  去重、`added` / `removed` 的计算**都按 `songId`**，不是「歌名-歌手」——
  > 后者会把「同名但不同版本」（live 版、翻唱版）**误判成重复**。
- **★ 同步时按歌重算 `last_index`**（这是「下标能当定位用」的前提）：

  下标本身是脆弱的 —— 曲目增删后第 N 个位置可能已经是另一首歌。
  同步时**旧列表和新列表都在手上**，正是重算的时机：

  | 情况 | 处理 |
  | --- | --- |
  | 那首歌还在 | 用它的**新下标**（按 `songId` `findIndex`，不能用歌名 —— 同步可能改名） |
  | **那首歌被删了** | 保留原下标并夹进范围 → 效果是「下一首顶上来」（播放器的标准行为） |
  | 旧列表本来就是空的 | `0` |

### `utils/setting.ts` —— 配置服务

**职责**：主进程**唯一持有**配置 —— 读盘 / 迁移 / 合并默认值、内存单例、
防抖落盘、局部更新 + 类型校验、变更广播。

**关键设计**：

- **两处类型校验管的是不同入口，缺一不可**：
  - `updateSetting` 管「渲染进程写进来的」
  - `mergeSetting` 管「**磁盘上读出来的**」

  > ⚠️ 只做前者会留下一个隐蔽的坑（作者自己标注「我踩过」）：
  > 某个 key 的默认值从 `null` 改成 `number` 之后，老用户磁盘上那个 `null`
  > 会被原样读回来、覆盖新默认值；而 `updateSetting` 的类型校验要求
  > 「与当前默认值同类型」，结果**这个键从此再也写不进去**
  > （每次写入都被判「类型不符」丢掉）。表现就是**「拖动没反应」**，
  > 而且日志只报一行 warn，极难查。
- **必须先深拷贝再合并**：否则 `updateSetting({...})` 只改引用相同的嵌套对象
  （如 `player.tagBonus`），`mergeSetting` 会因为引用相等而判定「没有变化」，
  导致更新**静默丢失**。
- **嵌套对象 / 数组必须显式深拷贝**（`tagBonus` / `filterKeywords` /
  `customAspectRatios`）：`{...defaultSetting}` 只做浅拷贝，
  成员和模块级 `defaultSetting` 是**同一个引用**。用户加一个过滤词
  就会把默认值改脏 —— 表现是「恢复默认之后那个词还在」。

### `utils/store.ts` + `atomicJson.ts` —— 原子写 JSON

**职责**：`Store<T>` 类（按路径复用实例）+「先写临时文件再 rename」的原子写。

**关键设计**：

- **为什么原子写**：直接 `writeFileSync` 到目标文件，断电/崩溃会留下截断的半个 JSON，
  下次启动解析失败、**配置全丢**。`rename` 在同一分区上是原子的。
- **为什么 rename 失败必须清临时文件**：Windows 上被杀软/其它进程占住很常见；
  不清的后果是残骸一直堆在 `userData` 里，而它的名字以 `.temp` 结尾 ——
  缓存那套清理/统计全按 `.json` 过滤，**既看不见也清不掉**。
- **配置损坏时先备份再从空对象重建**（`.bak`），避免用户数据无声消失。

### `winWallpaper.ts` —— Win32 壁纸层

**职责**：用 koffi 直接调 Win32，把主窗口挂到桌面壁纸层（WorkerW）/ 摘下来 /
回读校验 / 只读诊断。替代 `electron-as-wallpaper`。

**关键设计**：

- **`SetParent` 之后回读「真实父窗口」验证**：用 `GetAncestor(GA_PARENT)`
  （**不是 `GetParent`**）。不靠「有没有抛异常」猜，而是问系统。
  > ⚠️ **`GetParent` 不能用来验证**（实测踩过）：它的语义是
  > 「子窗口返回 parent，带 `WS_POPUP` 的顶层窗口返回 owner」，
  > 而 `SetParent` **不会**把窗口样式改成 `WS_CHILD` —— 所以窗口挂到 WorkerW 之后
  > 它在 `GetParent` 眼里仍是顶层窗口，返回 owner（NULL），永远拿不到 WorkerW。
  > 后果：校验永远失败 → 每次进壁纸都被回滚 detach → **壁纸模式完全进不去**，
  > 而且从日志上完全看不出原因。
- **完全不碰 `WS_EX_LAYERED`**：那个「已挂到桌面层、又被打成 layered 但属性还没生效」
  的中间态正是因为动了这个标志才存在的。
- **失败不抛异常**，返回结构化结果，由调用方决定怎么回滚 ——
  调用方必须能在「原生层可能已经挂上」的情况下**无条件 detach**。
- **`require` 而非顶层 import** koffi：加载失败时顶层 import 会让整个主进程起不来。
- **`describeWindow` 只读诊断**：曾经出现「挂上了、声音正常、但画面看不见」
  且只在虚拟机复现；这行日志把可见性、矩形、子窗口/分层标志、DWM 合成状态
  一起打出来。每项包在独立 try 里 —— 诊断函数**绝不能**因为某个 API 不可用
  而把 attach 流程搞挂。

### `portable.ts` —— 便携版数据目录

**职责**：判定数据目录 + 改写 `userData`。导出 `setupUserDataPath()` / `isPortable()`。

**三条优先级规则**：

| 情况 | 用哪个目录 |
| --- | --- |
| `%APPDATA%/BiLiMusicVideo` 里**已经有数据** | 就用它（安装版 / 便携版共用一份） |
| 没有数据，且当前是便携版 | exe 同级的 **`blmvdata/`**（`PORTABLE_DATA_DIR_NAME`） |
| 没有数据，且是安装版 | 默认的 `%APPDATA%/BiLiMusicVideo` |

> ⚠️ **目录名的准确值是 `BiLiMusicVideo`，不是 `BiLiMusicVideo-desktop`** ——
> `app.getPath('userData')` 等于 `%APPDATA%/<package.json 的 name>`，
> 而 `name` 就是 `BiLiMusicVideo`。
> （README 里曾写成 `-desktop`，那是**错的**，排查时按那个路径去找会**一无所获**。）
>
> 实际路径：`C:\Users\<用户>\AppData\Roaming\BiLiMusicVideo\blmv.db`

**关键设计**：

- **必须最早期调用**：`app.getPath('userData')` 一旦被读取就可能被缓存，
  之后再改会导致配置/缓存写到两个不同的地方。
- **判「有数据」必须看自家文件而非目录是否存在**：Electron 一启动就会把
  userData 目录建出来，那样在全新机器上永远判成「有数据」。
- **`blmv.db` 必须在标记列表里**：换成 SQLite 之后真正承载用户数据的就是它；
  漏掉的话，「只有库文件」的目录会被判成没有数据，
  便携版就会去 exe 同级再建一个空库 —— 用户看到的是「**歌单全没了**」。
- **两个 `setPath` 都要改**（`appData` + `userData`）：只改 userData 的话，
  Electron 内部仍可能往 Roaming 里写东西。

### `protection.ts` + `bundleKey.ts` —— 资源解密

**职责**：注册 `blmv://` 协议，页面请求哪个文件就解密哪个，**只解密到内存、不落盘**。

**关键设计**：

- **为什么用自定义协议而不是拦 `file://`**：覆盖内置 file 协议要自己重写
  整套文件服务（MIME、目录穿越、范围请求…），而 `protocol.handle` +
  `registerSchemesAsPrivileged` 是官方支持的路子。注册成 standard + secure 之后
  页面 origin 是 `blmv://app`，fetch / MSE / CORS 行为与 https 页面一致。
- **明文文件原样返回**：加密是**按需可选**的（开发态、image/font 等不需要加密）。
- **`decodeURIComponent` 要兜底**：`blmv://app/%` 这种畸形百分号会让它抛 `URIError`，
  协议处理器直接 reject —— 请求失败 + 一堆控制台噪音，而原因只是一个坏 URL。
- **解密失败要报出来**：静默返回乱码只会看到白屏，查起来更费劲。
- **`bundleKey.ts` 的注释是全项目最诚实的一段**：
  「老实说：这是提高门槛，不是『不可破解』。密钥必须在客户端才能解密……
  真正想拦住人得靠服务端（本项目是纯本地播放器，没有服务端）」。

### `music/` 目录 —— 多平台歌单解析（移植自 LX 的 musicSdk）

| 文件 | 职责 |
| :--- | :--- |
| `index.ts` | 按音源分发 + **按链接 host 自动识别音源** |
| `http.ts` | 请求层（`node:http`/`https`，跟随重定向 / 超时 / 解压） |
| `utils.ts` | 时长格式化、HTML 实体解码、歌手名拼接、音源识别、重试 |
| `sources/tx.ts` | QQ音乐（`musicu.fcg` 优先，旧接口兜底） |
| `sources/wy.ts` | 网易云（weapi 优先，linuxapi 兜底，`trackIds` 补全） |
| `sources/wyCrypto.ts` | 网易云 weapi / linuxapi 加密 |
| `sources/kw.ts` | 酷我（`pl.svc`） |

**关键设计**：

- **★ 每个音源都要把「平台歌单 id」带出来**（`PlaylistDetail.listId`）：
  tx 从 `disstid`、wy 从 `id`、kw 从 `rid`。
  它们本来就在 `getListId()` 里解析过，只是以前没往外带。

  > **为什么必须带**：歌单主键是 `平台_平台歌单id`（`tx_8153225605`），
  > 不是随机 UUID。同一个歌单重复导入要**命中同一行**，而不是攒出一堆副本。
  > 不带出来的话 `playlistKey()` 拿不到参数，只能退回随机 id ——
  > 「重复导入生成新歌单」这个坑就会一直存在。
- **`http.ts` 为什么不用 Electron 的 `net.request`**：实测请求腾讯的
  `c.y.qq.com` / `u.y.qq.com` 时会稳定返回 **`net::ERR_BLOCKED_BY_CLIENT`**；
  而同一时刻同样的 URL、同样的请求头，用 Node 的 `https` 却能正常拿到 100KB+ 数据。
  额外好处：Node 的 http/https **默认不跟随重定向**，响应里能直接读到 `location` 头 ——
  之前用 `fetch`/`net.request` 时拿不到 `Location`，**正是这个坑导致 QQ 接口被误判失败**。
- **`detectSource` 为什么不能只看 `id=` 参数**：网易云和酷我的链接都带 `id=`，
  QQ 的移动端分享链接也带 —— 所以**必须以 host 为准**。
  还要**特判 `digest-<n>__<id>`**（酷我的压缩形式），否则那条分支永远走不到。
- **`decodeName` 为什么手写**：LX 用的是渲染进程的 `DOMParser`，
  **主进程没有 DOM**，所以改用一份手写的 HTML 实体解码，不引入第三方依赖。
- **网易云为什么有两条通道**：新版 `/weapi/v6/playlist/detail` 返回**全量** `tracks`，
  而 **linuxapi 的 `/api/v3/playlist/detail` 在未登录时经常只给 10 首**，
  会把 200 首的歌单静默截断成 10 首 —— 所以数量对不上时按 `trackIds` 补全，
  且**只有更完整时才采用**（避免接口异常反而把数据变少）。

## 2. 主进程与渲染层共用（electron/common/）

### `types/ipc.ts` —— IPC 契约

**职责**：`IpcChannelMap`（invoke 通道的入参/返回值）+ `IpcEventMap`（推送事件）
+ `TrayMenuState` 等共享形状。

**关键设计**：所有 handler 经 `mainHandle(channel, payload => ...)` 注册，
channel → `{params, result}` 的契约集中在这里，
**漏写参数或返回错类型会在编译期报错**。
注释明确批评过「清单拆成两处」的旧做法。

**两处本轮改过契约的通道**：

| 通道 | 变化 |
| --- | --- |
| `api:searchSong` | 入参从 `{ keyword }` 改成 **`{ song, singer }`**（分开传，理由见 §2） |
| `music:getPlaylistDetail` | `result` 改成 **`Omit<PlaylistDetail,'songs'\|'listId'> & { songs: PlaylistSong[]; id: string \| null }`** —— 曲目是归一化后的形态，`id` 是**主进程拼好的歌单主键**，且**不透出 `listId`** |

### `types/api.ts` —— preload 暴露的 api 契约

**职责**：`RendererAPI` 接口，preload 与渲染层共用同一份定义，
**任何一边漏实现/写错签名都会立刻报错**。

> 两个契约定的是同一件事（`ipc.ts` 描述主进程 handler 的入参/返回，
> `api.ts` 描述 preload 暴露的方法签名），所以改了通道形状**两边都得跟着改** ——
> 这也是本轮 `searchSong` 改签名时必须同时动 `ipc.ts` / `api.ts` / `preload` 三处的原因。
> `api.ts` 里的 `getPlaylistDetail` 直接引用
> `import('./ipc').IpcChannelMap[...]['result']`，避免手抄一遍返回类型。

### `types/app_setting.ts` + `defaultSetting.ts` —— 配置类型与默认值

**职责**：`AppSetting` 全量接口（**扁平点号键**）+ 默认值对象（`satisfies` 强校验）。

**关键设计**：

- **扁平点号键的唯一目的**：让 `mergeSetting` 只需要做一层浅合并即可完成
  「默认值 + 用户值」的合并，并且能**精确算出哪些 key 被改动**，
  便于向渲染进程精确广播（避免整包配置来回传）。
- **`satisfies AppSetting` 而不是 `as`**：既能强校验（少写 key / 写错类型都报错），
  又不丢字面量类型。
- **`cache.maxAge` 是兼容占位**：注释写明「这个键在本次数据层改造后已经不再是权威设置了」。
  改造前语义是「整个缓存条目的寿命」，但缓存里混着两种寿命完全不同的数据
  （直链约 2 小时、元数据永不过期），用一个值同时管两者，
  结果就是「地址还没过期、元数据先被删了」。
- **`tagBonus` 与 `filterKeywords` 的区别**（注释里用表格写死了）：

  | | tagBonus | filterKeywords |
  | --- | --- | --- |
  | 作用阶段 | **打分**（歌手命中分之后） | **硬过滤** |
  | 命中后 | 加 / 减分 | **直接丢弃** |
  | 用户场景 | 微调排序偏好 | 绝对不想要的内容 |

- **`tagBonus` 的分值语义本轮改过**（注释也跟着改了）：

  打分的两段是「**先按歌手名是否命中分层（命中 `+100`）**，
  之后把命中关键词的分值**逐条累加、无上限**」。

  > 旧文案写的是「分层断层 +50、层内 clamp 到 ±10」——
  > 那个 `+50` 是**由 clamp 上限倒推出来的**（保证两层数值区间 `[40,60]` 与
  > `[-10,10]` 不重叠）。但 clamp 有个副作用：**堆几个关键词就能顶满** ——
  > 用户把 `-20` 档给「伴奏」就是为了重罚它，结果被夹到 -10，
  > 与 `-4` 档的乐器演奏**只差 6 分**，表达不出轻重。
  > 现在去掉 clamp，用户给多少就是多少；`+100` 的断层分也足以拉开主次。

### `utils/videoRank.ts` —— ★ 搜索排序

**职责**：硬过滤 + 打分 + 排序，**主/渲染共用的纯函数模块**（自己不读设置）。

**几个关键导出**：

| 导出 | 作用 |
| --- | --- |
| `rankVideos(videos, options)` | 一站式入口：过滤 + 打分 + 排序 |
| `passHardFilter(...)` | 单条硬过滤判定 |
| `scoreVideo(video, singer, tagBonus)` | 打分（歌手命中 +100；关键词累加**无上限**） |
| `baseSongName(name)` | **新增**，剥掉括号里的版本标记（`(吉他版)` / `(Live)` / `(DJ版)`…） |
| `splitSearchKey(key)` | ⚠️ **只用于解析旧 JSON**，搜索链路已不再调用 |

**`RankOptions` 收的是 `song` + `singer` 两个独立字段**（不再是 `searchKey` 拼串）——
理由见 `biliApi.ts` 那节「拼串再拆有歧义」。

**内部还有几件不导出的实现细节**（都在 §3 展开）：`titleHasSongName`（硬过滤核心）、
`TRAILING_FORM_WORDS`（形式词表）、`flattenWithMap`（去空格比对但保留索引映射）、
`toSimplified`（opencc 简繁归一）。

详见 [功能实现 §3](#3-搜索结果排序硬过滤--打分)。

### `utils/mergeSetting.ts` / `migrateSetting.ts`

**职责**：前者做「默认值 + 用户值」合并并算出变化的 key；后者按版本闸门逐级迁移。

**关键设计**：

- `mergeSetting` **以基准配置的 key 全集为准遍历** —— 磁盘上多出来的、
  已废弃的 key 会被自然丢弃。
- **类型校验必须在这里也做一遍**（见 `setting.ts` 那条「拖动没反应」）。
- `migrateSetting` 的入参是 `unknown`（老数据不可信）；
  每段代码只负责把 version 从 A 抬到 B，**天然幂等**。
  > 注意：本项目配置此前从未落盘，所以那段 v1.0.0 迁移是**骨架 + 示例**，
  > 不是真实发生过的升级。

### `utils/duration.ts` / `common.ts`

**职责**：时长归一化与格式化；`compareVer` / `debounce`（带 `flush`/`cancel`）。

**关键设计**：

- **`duration.ts` 为什么存在**：同一件事（把各种形状的时长变成秒）
  原来在**三处各写了一份**，而形状还不止一种（B站搜索给 `"4:03"`、
  view 接口和库里给秒数、音乐平台给 `"4:03"`/`"1:02:03"`）。
- **`<= 0` 与非法输入一律返回 `null` 而不是 0**：
  「未知时长」和「0 秒」在界面上是两种东西（前者该留空，后者是坏数据）。
- **`debounce` 带 `flush`** 是 `setting.ts` 的需求：退出前必须把防抖中的配置
  立刻写盘，否则用户最后拖的那一下音量会丢。

### `constants.ts`

**职责**：档位表（12 档视频 qn + 3 档音频）、颜色常量、宽高比解析、
搜索排序的取值范围、配置版本号等。

### `mainIpc.ts` / `rendererIpc.ts` / `ipcNames.ts`

**职责**：类型化 IPC 包装（主进程侧 / preload 侧）+ 广播事件名常量。

## 3. 预加载（electron/preload/）

### `index.ts` + `index.d.ts`

**职责**：`contextBridge` 暴露类型化 api（`window.electronAPI`）+ 全局声明。

**关键设计**：每个方法都从 `IpcChannelMap` 推导出入参与返回值，
所以主进程改了契约、这边没跟上会**编译期报错**。

## 4. 渲染层（src/）

> 每个文件的详细笔记（含「为什么」与踩坑）见
> [docs/渲染层-文件职责与实现要点.md](docs/渲染层-文件职责与实现要点.md)。
> 下面是索引。

### `App.vue` —— ★ 界面中枢

**职责**：模板 + **全部播放业务**。是最大的文件，也是所有状态的权威。

**按功能域分段**：

| 域 | 关键内容 |
| --- | --- |
| 播放状态 | `videoUrl` + `dashSource` 二选一；`videoUpDate`（timeupdate）做 6 件事 |
| 切歌流程 | `changeSong` → `changeVideo`，两个竞态令牌 |
| 搜索与重试 | 空结果最多重试 3 次；`filtered: true` 时**跳过重试** |
| 续播 | `tryResume` / `restoreSongVideo` |
| 切歌预热 | `_warm` 系列九件套状态 |
| 停滞看门狗 | 12 秒不动 → 退 durl / 重解析 / 跳下一首 |
| 片尾看门狗 | `ended` 不触发时按播完处理 |
| 壁纸模式 | `.wm-hidden`（class 不用 v-if）+ 进壁纸关所有弹窗 |
| 界面锁定 | `locked` + `_lockedByFullscreen` |
| 快捷键 | Space / ↑↓ / ←→ / F / S / Esc |
| 托盘事件 | 17 个监听全部存进 data 并在 `beforeUnmount` 摘除 |
| 收藏 / 添加视频 | `onAddVideo` **复用 `setFavorite`** |

**关键设计（几处「先做/不能做」）**：

- **`changeSong` 先就地切本地信息**（`currentIndex`/`songName`），
  注释直说原来排在 `await searchSong()` 后面导致「切了歌，图片和名称还是上一首的」。
- **`videoListKeyword` 不能提前跟成新歌**：否则 `videoError` 会把上一首的报错
  算到新歌头上。
- **`_endStallHandled = true`**：空窗期防片尾看门狗抢跑，
  否则点一次下一首**跳过两首**。
- **`_warmTries` 为什么存在**：心跳每秒调 `warmApi`，而搜不到视频时
  `_warm[dir]` 是空的、拦不住它 —— 注释写「**每秒发一次真网络请求，永不停止**」，
  症状是「控制台同一个关键词刷几十行、界面变卡」。
  因为心跳是 1 秒一次，光靠计数做不到「间隔 3 秒」，所以必须同时看时间戳。
- **`sortSearchedVideos` 现在是恒等函数**：打分排序搬到主进程且在**写库之前**执行，
  `videos.ord` 直接等于显示顺序。保留成恒等而不是删掉，
  是因为调用点在续播/预热/重试好几处，「逐个删容易漏」。
- **★ `getSongName` 与 `getSongParts` 是两个不同的东西，别混用**：

  | 方法 | 返回 | 用作 |
  | --- | --- | --- |
  | `getSongName(index)` | `歌名-歌手`（`toSearchKey`） | **缓存键 / 标识**：传给 `getSelectedBvid` / `resolveVideoUrl` / `setFavorite`，以及 `videoListKeyword` |
  | `getSongParts(index)` | `{ song, singer }` | **搜索入参**：`searchSong(parts.song, parts.singer)` |

  > 五个 `searchSong` 调用点**都传两个参数**（`changeSong` / `restoreSongVideo` /
  > `warmApi` / `refreshVideoList` / 重试）。早先传的是一个 `歌名-歌手` 拼串，
  > 主进程还得 `splitSearchKey` 拆回来 —— 而歌名本身可能含 `-`，拆是**有歧义**的。

### `components/` 目录

| 文件 | 职责 |
| :--- | :--- |
| `biliVideoControls.vue` | 播放控制栏（17 props / 6 emits，**纯展示 + 上报**） |
| `SettingsDialog.vue` | 设置弹窗（**左栏目录 + 右栏一页到底**） |
| `PlaylistManager.vue` | 歌单管理（左列表 + 右「内联表单 / 曲目列表」）；**只做展示与原样透传**，见下 |
| `showList.vue` | 歌曲列表 / 视频列表**双形态**弹层（按 `listType` 切换） |
| `AddVideoDialog.vue` | 「添加视频」弹窗（粘贴链接 → 解析 → 收藏） |
| `AboutDialog.vue` | 关于弹窗 |
| `PlaylistPanel.vue` | 左上角歌单入口 |

**`SettingsDialog.vue` 的关键设计**：

- **左栏是「目录」不是 Tab**：注释给了理由「切换会让人找不到刚看过的那一项」
  （设置项要对照着调，如「时长容差」与「降级阈值」）+
  **用户原话「不要点一下就像换了个页面一样」**。
- **`scrollToSection` 刻意不用 `scrollIntoView`**：它会把**所有可滚祖先**都滚一遍，
  包括弹窗外面那层，整个对话框跟着动。改成手算 `scrollTop` 只动一个容器。
- **`watchScrollSettle` 为什么存在**（注释里写了两版失败尝试）：
  - ① 固定定时器 —— 平滑滚动时长取决于距离，定太短（420ms）长距离没滚完就解锁，
    高亮一路扫过去；定太长则用户自己滚时高亮不响应。
  - ② 只看「连续 3 帧没变」—— 平滑滚动**起步前有几帧 `scrollTop` 不动**，
    被误判成已停下（实测点「界面」只滚 24px 就解锁，高亮被改回「播放」）。
  - ③ 最终：rAF 循环，判据 = **连续 3 帧没变 且（已经动过 或 等够 15 帧）**。
- **`tagBonus` 落盘必须整体换引用**：`updateSetting` 对嵌套对象是**整体替换**语义，
  原地改不会触发写入（引用没变，主进程深比较也看不出差异），
  表现就是「改了没反应」。
- **★ 分值档每行加了 `←` / `→` 按钮**（`shiftTagBonusScore(score, ±1)`），
  分值数字本身可聚焦、**键盘左右箭头也能调**。

  **改键名而不是改数值**：`player.tagBonus` 的**键就是分值**
  （`{ "5": [...], "-2": [...] }`），所以「把 +5 档改成 +6」= 把键 `"5"` 换成 `"6"`，
  **关键词跟着搬过去**。两个细节：

  - **保持键的顺序**：重建对象时按当前显示顺序放新键，
    否则这一档会**跳到最后一行**（按一下 `→` 就往下一行跳，很别扭）；
  - **撞到已存在的档就不动**并提示 —— 合并会**丢信息**（用户本来分了两档不同权重），
    悄悄合并会不知不觉改变打分结果。

- **★ 分值上限已去掉**（`addTier` 不再校验 ±10，`TAG_BONUS_SCORE_MIN/MAX` 常量已删）：
  关键词加权不再被 clamp，用户想给「伴奏」配 `-50` 是完全合理的。
  > `addTier` 现在只校验「是整数」和「不重复」。
- **分值那一块的文案**是「歌手名命中 +100，之后按这里的分值累加」
  （旧的「层内 ±10 内微调」已改）。

**`PlaylistManager.vue` 的关键设计 —— ★「凡是主进程能算的，渲染层一律不碰」**：

解析歌单后它只做**原样透传**，两样东西：

```ts
songs = detail.songs as unknown as PlaylistSong[]   // 已经是库里形态（带 platformId）
presetId = detail.id                                // 已经是 tx_8153225605
```

| 它**不碰** | 原因 |
| --- | --- |
| `platformId` | 拼 `songs.id` 用的，主进程在 IPC 出口已经归一化好 |
| `listId` | 拼 `playlists.id` 用的，主进程已经拼成 `detail.id` |
| `interval` → 秒 | 主进程 `toPlaylistSongs` 已转 |

> **为什么曾经是它做**：这段字段转换原来写在这里，代价是 **`platformId` 被丢掉** ——
> 渲染层不知道它有用，于是 `songs.id` 只能退化成 `歌名-歌手`，
> 白拆了 `songs` / `playlist_songs` 两张表（实测库里 221 条 `songs.id`
> 全是 `歌名-歌手`，带平台前缀的 **0 条**）。
> 现在统一由主进程加工，渲染层不可能再丢东西。
>
> 曲目列表本身也是**只读展示**（没有删除/编辑曲目的功能），
> 所以「原样透传」不会丢用户的任何编辑。

### `stores/` 目录

| 文件 | 职责 |
| :--- | :--- |
| `setting.ts` | 配置的**响应式副本**（持久化在主进程） |
| `playlists.ts` | 歌单副本 + 同步编排 |

**关键设计**：两个 store **都不持久化**。
`playlists.ts` 有一条重要的边界注释：收藏与「每首歌选中的视频」
**已从这个 store 搬走**，因为「这个 store 的持久化是**整个歌单集合全量覆盖** ——
每收藏一次就把所有歌单所有曲目重写一遍，而且同步进行中还会被主进程的
`syncingIds` 拦下（**收藏静默丢失**）」。

**`playlists.ts` 的 id 来自主进程**（本轮改动）：

```ts
const addPlaylist = async (input: {
  name; songs; source?; sourceUrl?
  id?: string | null      // ★ 主进程拼好的主键（tx_8153225605）
  syncMode?; intervalMs?
}) => {
  const id = input.id || newId()   // ← newId() 产出 pl_<uuid>
}
```

- 有平台链接的歌单：`id` 是**主进程拼好的** `平台_平台歌单id`，渲染层直接拿来用，
  **不参与任何拼装**（它不认识 `listId`，也不知道拼装规则）。
- 手动新建的歌单：主进程拼不出来（没有平台歌单 id），退化成 `newId()` 的
  **`pl_<uuid>`** —— `pl_` 前缀是刻意加的，一眼能看出「这不是平台 id」。
- `setLastIndex(index)` 记的是**下标**（不是 `lastSongId`）；
  同步时主进程会按歌把它重算，见 `utils/playlist.ts` 那节。

### `utils/` 目录

| 文件 | 职责 |
| :--- | :--- |
| `dashPlayer.ts` | ★ MSE（dash）分片调度 |
| `uiTheme.ts` | 主题令牌（CSS 变量） |
| `image.ts` | 图片地址规整 |
| `plain.ts` | 深度解包（去响应式，写盘前） |
| `title.ts` | 标题净化（只留 `<em>`） |
| `videoQuality.ts` | 按解码分辨率兜底清晰度标签 |

**`dashPlayer.ts` 的关键设计**：

- **为什么不用 `<video src>`**：dash 音视频是两条独立流，只给一条会没声音；
  `<video>` 一次只能一个 URL，所以两轨塞进同一个 MediaSource 的两个 SourceBuffer，
  「这样对外仍然只有一个媒体元素，**进度、音量、续播、SMTC 这些现有逻辑一行都不用改**」。
- **配额三件套**：前向限流 30s + 撞配额丢 `KEEP_BEHIND_S` 再按
  `[90,60,40,25,15]` 递减重试 + **15 秒下限**
  （「离播放点太近的 `remove()` 会让解码器打嗝甚至停住」）。
- **刻意不做每轮主动裁剪**：m4s 顺序下载，裁掉拿不回来；
  「宁可让缓冲区涨到配额再一次性回收」。
- **三个高价值坑**：
  ① `start()` 里**必须 `stopped = false` 复位**（否则 append 第一行就返回，
  「流被读完却一个字节都没进 buffer」）；
  ② `appendBuffer` 后**必须再 `waitIdle` 才 return**（原来直接 return 会让
  `endOfStream()` 撞「还在 updating」抛 `InvalidStateError` 被空 catch 吞掉，
  **MediaSource 永远不 end、`ended` 不触发**）；
  ③ 分片 MP4 的 `mvhd` 时长常为 0，**手动补 `ms.duration`**，
  否则进度条拿到 `Infinity`。

**`title.ts` 的关键设计**：先整串转义再只还原 `<em>`/`</em>`；
**匹配开标签必须允许 `&`**（转义后属性引号变 `&quot;`），
否则 `<em class="keyword">` 匹配不上、只剩闭标签，产生破损 HTML。

**`image.ts` 的关键设计**：协议相对 URL（`//i0.hdslb.com/...`）在 `file://` 下
会解析成 `file://i0...`，三个后果：图加载不出来 /
**SMTC 直接拒绝该 artwork**（报 `MediaImage src can only be of http/https/data/blob scheme`）/
写进缓存后再解析视频地址抛 `DOMException`。

### `trayMenu/main.ts` —— 自绘托盘菜单

**职责**：托盘菜单窗口的页面逻辑（独立构建入口）。

**两个高危历史 bug**（注释里写得像已修复，值得留意）：

1. **登录项 action 原来写死 `'login'`** 而文案随状态变「退出登录」→
   点「退出登录」反而打开登录窗口。
2. **列表项用 `mouseup` 而非 `click`**（壁纸模式鼠标转发抢走 mousedown，
   down/up 不同元素不合成 click），但**必须自己校验按下与抬起是同一项** ——
   否则从「设置歌单」滑到「退出程序」松手会**直接把应用退掉**。

另：列表**只在启动时建一次 DOM**，之后只改文案
（300ms 推一次状态时重建 DOM 会让 mouseup 落不到同一元素 = 点不动）。

### `main.ts` / `api/electron.ts` / `types/app.ts`

**职责**：启动引导（挂载前先拉配置 + 挂广播监听）/
IPC 出口（只做一层透传，把 `window.electronAPI` 收成有类型的模块）/ `App` 的 data 契约。

## 5. 构建与打包

| 文件 | 职责 |
| :--- | :--- |
| `electron.vite.config.ts` | 三个构建目标（main / preload / renderer）；renderer 两个入口（`index.html` + `tray-menu.html`） |
| `scripts/protect.mjs` | 打包保护流水线：字节码 + 混淆 + 资源加密 |
| `tsconfig.*.json` | 三份配置（base / node / web）+ 路径别名 |
| `package.json` | 脚本与 electron-builder 配置（`dependencies` 里 **`opencc-js`** 是运行期依赖） |

**路径别名**：`@common/*` → `electron/common/*`，主进程与渲染层共用。

**★ 依赖 `opencc-js` 的打包（已实测验证）**

它在 `dependencies` 里，被 `externalizeDepsPlugin()` 外部化 →
**不 bundle 进 `out/`**，而是运行时从 `node_modules` `require` →
electron-builder 把它装进 `app.asar`。

两个关键点：

| 点 | 说明 |
| --- | --- |
| **只引子路径 `opencc-js/t2cn`** | 主入口（`require('opencc-js')`）是 **1.1 MB** 全量包（含简→繁、日文新字体、台湾/香港变体 —— 我们一个都不用）；`t2cn` 子路径只有 **106 KB**，正是「繁→简」这一件事。**体积差 10 倍** |
| **不需要 `asarUnpack`** | `dist/umd/t2cn.js` 是**自包含**的（字典全内联、文件内**零 `require`**），所以直接从 asar 里加载即可 |

> 实测：`npm run pack` 之后 asar 里有 `node_modules/opencc-js/dist/umd/t2cn.js`，
> 跑打包后的 `BLMV.exe` **无 opencc 告警**（退化时会打印
> 「opencc 不可用，简繁归一退化为不转换」—— 没打印就说明加载成功）。
>
> 代码里也**自检了一次**：启动时 `convert('舊') !== '旧'` 就 warn 并退化成「不转换」。
> 这样转换器坏了能立刻知道，而不是让过滤结果**悄悄变错**。
> 拿不到 opencc **不让过滤整体失败** —— 代价只是繁体标题的歌候选变少。

---

# 第二部分：每项功能怎么实现的

## 1. 歌单导入与解析

**入口**：`PlaylistManager.vue` 的「新建歌单」→ `music:getPlaylistDetail`
→ `music/index.ts` 的 `resolvePlaylist()`。

**完整流程**（★ 注意「加工」发生在**主进程的 IPC 出口**，不是渲染层）：

```
用户粘贴分享链接
  ↓
detectSource(input)              ← 按 host 判平台（不只看 id= 参数）
  ↓
SOURCES[source].getListDetail(input, page)
  ├── tx：musicu.fcg（优先）→ 旧接口兜底
  ├── kw：pl.svc
  └── wy：weapi（优先）→ linuxapi 兜底 → trackIds 补全
  ↓  返回 PlaylistDetail { info, songs: ParsedSong[], source, listId }
  ↓
★ 主进程 IPC 出口（ipc/music.ts）做两件加工：
  ├── toPlaylistSongs(songs)      ← 音源字段 → 库里形态
  │     interval:"4:03" → duration:243（秒）
  │     albumName → album
  │     **保留 platformId**（拼 songs.id 要用）
  └── playlistKey(source, listId) ← 拼歌单主键：tx_8153225605
  ↓  返回 { info, songs: PlaylistSong[], source, id }（**不透出 listId**）
  ↓
渲染层**原样透传**（它不认识 platformId / listId，也不做字段转换）
  ↓
写库：playlists(id=tx_8153225605) + songs(id=tx_1828354) + playlist_songs(关系)
```

**★ 为什么加工必须在主进程（一次真实的踩坑）**

这段字段转换原来写在渲染层（`PlaylistManager.vue`），后果是
**`platformId` 被丢掉了** —— 渲染层根本不知道它有用，于是 `songs.id`
只能退化成 `歌名-歌手`。实测：库里 221 条 `songs.id` 全是 `歌名-歌手`，
带平台前缀的 **0 条**，**白拆了 `songs` / `playlist_songs` 两张表**。

现在的原则是：**凡是主进程能算的（id 拼装、字段归一），渲染层一律不碰。**
曲目列表本身也是只读展示，所以「原样透传」不会丢用户的任何编辑。

**两级 id 的由来**

| 主键 | 怎么来的 | 为什么 |
| --- | --- | --- |
| `playlists.id` = `平台_平台歌单id` | `playlistKey(source, listId)`，参数取自音源 | 同一歌单**重复导入命中同一行**，而不是攒副本 |
| `songs.id` = `平台_平台歌曲id` | `songId(song)`，用 `platformId` + `source` | 同上；且**平台改名不断链** |

两者的兜底都是「手动」那条路：歌单退化成 `pl_<uuid>`、歌曲退化成 `歌名-歌手`。

**自动识别平台**：LX 让用户在弹窗里手选音源，本项目只有一个输入框，
所以增加了**按分享链接 host 自动识别**，识别不出来才要求显式指定。
识别不出且输入是纯数字时会明确报错「只填数字 ID 无法判断是哪个音乐平台」。

**未接入的音源显式挡掉**：酷狗（`kg`）在类型里合法但尚未移植解析实现，
`isSupported()` 会挡掉并报「尚未接入」，避免抛 `undefined is not a function` 这种莫名错误。
> 注意区分：**音源识别**会挡掉 `kg`（没实现解析），
> 但 `sourceOfSongId()` 的反推**认 `kg`**（它是合法前缀，只是当前没有这种数据）。

**同步**（`syncPlaylist`）与导入**共用同一个 `toPlaylistSongs`**，保证两条路径
产出的 `PlaylistSong[]` 形状完全一致（否则同一首歌走两条路径会得到不同的
`duration` / `platformId`）：

```
重新解析 → toPlaylistSongs 归一 → 截断到 2000 首
  → 按 songId 去重 → 算 added/removed（也按 songId）
  → ★ 按歌重算 last_index → 写库
```

`syncPlaylists(ids)` **串行**执行，避免同时打多个平台接口被限流。

> **去重/比较为什么用 `songId` 而不是 `歌名-歌手`**：后者会把
> 「同名但不同版本」（live 版、翻唱版）**误判成重复**。

> **★ `last_index` 为什么要重算**：下标是脆弱的 —— 曲目增删后第 N 个位置
> 可能已经是另一首歌。同步时**旧列表和新列表都在手上**，正是重算的时机：
> 那首歌还在就取它的**新下标**（按 `songId` `findIndex`，不能用歌名，同步可能改名）；
> 被删了就保留原下标并夹进范围（效果是「下一首顶上来」，播放器的标准行为）。

## 2. 搜索：从歌名到候选视频列表

**入口**：`App.vue` 的 `changeSong(index)` → `getSongParts(index)` 取
**歌名 + 歌手两个字段** → `electronApi.searchSong(song, singer)`
→ `ipc/biliApiHandlers.ts` 的 `api:searchSong`。

**完整流程**（★ 注意「搜索键」与「搜索词」是两回事）：

```
入参：song（歌名）+ singer（歌手）+ skipCache     ← **两个独立字段**
  ↓
主进程拼出两个东西（拼装只在这里做一次）：
  searchKey      = joinSearchKey(song, singer)      = "歌名-歌手"          ← 缓存主键 / 打分判据
  primaryKeyword = buildPrimaryKeyword(song, singer) = "《歌名》歌曲 歌手"  ← 发给 B站
  ↓
① 读缓存 cacheManager.get(searchKey)
     命中 → rankVideos 只读重过滤 → 返回（不发网络请求）
     过滤后为空 → 忽略缓存，往下真搜
  ↓
② 真实搜索
     findSongDuration(searchKey)          ← 遍历主进程内存，不查库
     biliApi.searchSong(primaryKeyword)   ← WBI 签名
     searchSongFiltered(song, singer, ...)  ← 补齐 + 降级（见下）
     setSearchLoginState(searchKey, ...)
  ↓
③ 过滤 type === 'video'
     空结果 → 直接返回空、**不写缓存**
  ↓
④ mergeWithFavorites(freshItems, oldRows)
     收藏置顶保序 → 新结果覆盖元数据 → 最后逐个回源刷新
  ↓
⑤ rankVideos(...)                    ← 硬过滤 + 打分 + 排序（写库之前！）
     过滤后为空 → 返回 { result: [], filtered: true }
  ↓
⑥ cacheManager.save(searchKey, {...})  ← DELETE + INSERT
  ↓
⑦ 返回 { result, selectedBvid? }
```

> **为什么歌名和歌手要分开传，而不是一个 `歌名-歌手` 拼串**：
> 拼串再拆是**有歧义**的 —— 歌名本身可能含 `-`
> （`下坠Falling` / `R.` / `若是明仔载`），按第一个 `-` 切会切错。
> 而且两者本来就是两个独立字段（歌单里、界面上都分开存），
> 只有**拼搜索词**那一刻才需要同时在场 —— 而那一刻也不必拼串。
>
> 拼串仍然存在，但只在**主进程内部拼一次**（`joinSearchKey`），
> 作为缓存主键用；渲染层不再产生它。

**`searchSongFiltered` 的补齐与降级（★ 四级）**：

| 轮次 | 搜索词 | 说明 |
| :--- | :--- | :--- |
| 1 | `《歌名》歌曲 歌手` | 正常搜索（最精确） |
| 2 | `《歌名》歌曲 MV` | 降级，**不带歌手名** |
| 3 | `《歌名》歌曲 可视化` | 兜底 |
| 4 | **`《歌名》`** | ★ **裸歌名**，不带任何后缀 |

**书名号是字面量**（不是占位符）—— B站上音乐视频的标题大量写作 `《歌名》`，
带上它能显著提高相关度。

> ⚠️ **第 1 级不用 `-` 分隔**：B站搜索把 `-` 当**排除语法**
> （"A -B" = 搜 A 并排除含 B 的结果），写成 `《歌名》歌曲 - 歌手` 会变成
> 「搜歌、**排除**这个歌手」，正好和意图相反。用空格分隔是普通的「与」语义。

**每一级都是「一页不够就翻第二页」**（**统一行为**，不是某一级的特例）：

```
每一级：搜第 1 页 → 过滤后 < minSearchResults（默认 30）→ 再搜第 2 页 → 还不够 → 降级
        （0 = 不补齐、不降级，只搜一次）
```

**降级是「累加合并」，不是「替换」** —— 每一轮结果按 `bvid` 去重后**追加**到结果池。

> 用户原话：「降级的意思是降级搜索，**不是要把之前的结果不要啊**」。
> 原实现是「哪一轮过滤后更多就用哪一轮」，于是第 1 轮的 10 条会被降级轮的
> 36 条**整个顶掉**（`10 + 36` 去重后 ≈ 46 条才是应有的结果）。
>
> 去重是必须的：降级词与主搜索词的结果**一定会重合**，同一 bvid 只留
> **第一次出现**的 —— 那批来自主搜索词，元数据（带 `<em>` 高亮的标题）更贴合。

**★ 第 4 级（裸歌名）为什么存在**：前三级都带后缀（`歌曲` / `歌曲 MV` / `歌曲 可视化`），
而 B站的相关性排序会把**带这些词的**排在前面 —— 于是「动态歌词排版 / 饭制 / 混剪」
这类标题里既不写 `歌曲` 也不写 `MV` 的视频**排在两页之外，永远搜不到**。
直接搜 `《歌名》` 才捞得出来。

**「够不够」判的是过滤之后的条数**（`countPassing`），不是原始条数 ——
用过滤前的数字判断的话，搜出来 80 条就一定「够」，哪怕过滤完只剩 25 条也不会降级，
这个设置项就等于没有。

> ⚠️ `countPassing` **必须先把 B站返回的 `favorites` 置 false**（见 `biliApi.ts` 那节）：
> 否则「这条被多少人收藏了」这个数字会让条目全部豁免过滤，
> 计数虚高 → 判定「够了」→ **降级永远不触发**。

**降级轮放宽时长上限**：降级时搜出来的结果更杂（大量合集/全场/串烧），
用第一轮那套上限会把本来能找到的砍掉，所以降级轮把上限放宽到 `容差 × 1.7`。
这个 `relaxed` 标志会**回传给调用方**，让精确过滤（`rankVideos`）用**同一套上限** ——
否则会出现「按放宽的规则数出 40 条、按严格规则只剩 5 条」，白降级一场。

**渲染层的重试**：搜索为空时最多重试 3 次（每次 `skipCache`，间隔 800ms，
「连着打三次反而更容易被风控」）。
但 **`filtered: true` 时跳过重试** —— 那是合法结果（搜索成功了，只是全被规则挡掉），
重试只会拿到同一批再被同样挡掉，「白打 3 次请求、白等两秒」。
两种空结果给**不同提示**（去放宽规则 / 检查网络与登录），
且用 `$notify` 而非 `$message`（带操作指引要时间读）。

## 3. 搜索结果排序（硬过滤 + 打分）

**位置**：`electron/common/utils/videoRank.ts`（主/渲染共用，纯函数）。

**一句话逻辑**：**标题里歌名必须独立出现、时长必须对得上；
歌手名命中给 +100 的断层分，之后用关键词微调。**

**① 硬过滤**（三条，任一命中直接丢）

| 规则 | 说明 |
| --- | --- |
| **歌名没独立出现** | 见下面「歌名怎么算命中」—— 这是本文件改动最大的地方 |
| 时长超出容差 | 下限 `max(时长−容差, 时长×0.5)`、上限 `时长+容差`。标题含 `MV/官方/Live/现场` 时上限放宽 **×1.7**。**歌曲时长未知、或视频时长解析不出 → 不过滤**（不因缺数据误杀） |
| 命中过滤关键词 | 默认是一组谱类/演奏类词（吉他谱、钢琴谱、指弹、口琴……），命中即丢 |

**★ 歌名怎么算命中（`titleHasSongName`）** —— 两条规则，**先放行后否决**：

```
规则 1：标题里有《…》段，任一段**等于**歌名（多字少字都不算）→ 通过
        ⚠️ 书名号只用来**放行**，不用来否决（见下）
   ↓ 没匹配上就继续
规则 2：看歌名是否**独立出现** —— 前后是符号 / 空格 / 串首尾
        通过对： 「光良 - 童话」「童话 光良」「【罗艺恒】童话」
        丢弃对： 「童话镇」「哥本哈根的童话」「红颜旧」「旧梦一场」
```

> **为什么规则 1 不能用来否决**（这里改过一次）：标题里的书名号也可能指向
> **电视剧 / 专辑 / 栏目**，而不是歌名：
>
> ```
> 【许茹芸】泪海（《真爱一世情》电视剧主题曲）   ← 《…》是剧名，歌名"泪海"在别处
> ```
>
> 早先的规则是「有书名号但都不等于歌名 → 丢弃」，于是上面这条**被误杀**。
> 现在改成：书名号只放行，不匹配就走规则 2。

**为什么必须有「独立出现」这一条**（光判"标题含歌名"会放进别的歌）：

```
搜「童话」→ 放进《童话镇》            ← 不是同一首歌
搜「旧」  → 放进《红颜旧》《旧梦一场》  ← 不是同一首歌
```

**四个必须一起看的实现细节**：

| 细节 | 为什么 |
| --- | --- |
| **形式词豁免**（`TRAILING_FORM_WORDS`：歌词排版 / 字幕 / 伴奏 / 完整版 / mv / live…） | 歌名右边紧跟这些词时**算独立** —— 它们说的是「这个视频是什么形式」，不是歌名的一部分。<br>`刘惜君 - 聊表心意歌词排版透明通道` 该**留**；而 `童话镇` 里的「镇」不在表里，照样**丢** |
| **在保留空格的原串上判边界**（`flattenWithMap` 记「去空格后索引 → 原串下标」的映射） | 比对要去空格（`Shape of You` ↔ `shapeofyou`），但判边界必须回**原串**。<br>踩过：先 `normalize`（去空格）再判边界，于是「童话 光良」变成「童话光良」、右邻成了「光」→ **被误杀**（其实中间明明有空格） |
| **`丨` `・` `｜` 当分隔符**（`SEPARATOR_CHARS`） | 它们在标题里的实际作用等于竖线，但码位落在汉字区，不特判会被当成汉字 |
| **★ 简繁归一**（`toSimplified`，opencc `tw→cn`） | 否则「旧」会把 `不夠 - 舊『…』`（**正是用户要的那首**，只是繁体）也杀掉 —— **简繁不同不是"另一首歌"** |

**已知代价**（字符串规则解决不了）：`光良童话KTV纯享版`（同曲不同歌手、无分隔符）
会被判丢 —— 它与「童话镇」在**字符层面完全同构**（歌名后紧邻汉字）。
这是「宁可漏掉也不能放错」的必然取舍。

**`baseSongName`：先剥掉歌名里的版本标记**

```
Take Me Hand (吉他版) → Take Me Hand
童话（Live）          → 童话
```

括号里是「版本词」（`版/live/现场/remix/cover/伴奏/纯享/吉他/dj/无损…`）时剥掉，
因为 B站标题里**往往不写它** —— 带着 `(吉他版)` 去比对或搜索会匹配不上。
> ⚠️ 只剥「像版本标记」的括号：括号里是歌名正文时**保留**
> （`(Don't) Stop` / `(Everything I Do)` 这些括号属于歌名本身）。

**② 歌手名命中 → 断层分 `+100`**（整个方案的核心）

硬过滤已经保证了「标题含歌名」，所以打分阶段**还是 0 分的那一批，
就等价于「只有歌名、歌手对不上」**（同曲不同歌手的翻唱 / 别的版本）。

| 层级 | 条件 | 基础分 |
| :--- | :--- | :--- |
| 第一层 | **歌手名命中** | **+100** |
| 第二层 | 歌手名没命中（歌名已由硬过滤保证） | **0** |

歌手名可能带多个（`A、B`），按 `、,，/&` 拆开逐个试，**命中任意一个就算命中**。

> **为什么是 100**：用户的要求是「歌手名前后优先级要拉开」。
> 一个「只有歌名」的候选哪怕把正分词全命中（4K + 官方 + MV…），
> 也很难靠堆词追平这 100 分，于是「歌手对」的那批稳定排在最前。

**③ 关键词加权 —— 逐条累加，★ 没有上限**（这里改过）

命中一个关键词就加（或减）一次该档分值，最后**直接用累加值**。

> ⚠️ **旧实现会 clamp 到 `±10`，已删掉**（`TAG_CLAMP` 常量没了）。
> 那个上限有个副作用：**堆几个关键词就能顶满** —— 用户把 `-20` 档给「伴奏」
> 就是为了重罚它，结果被夹到 -10，与 `-4` 档的乐器演奏**只差 6 分**，
> 表达不出轻重。
>
> 代价是「断层分不再有数学上的保证」（理论上堆够多正分词可以超过 100）——
> 但那是**用户自己配的**，他配了那么多正分词就是想让它们起作用，
> 与我们替他夹一个上限相比，后者更不透明。

**`scoreVideo` 不再需要 `song` 参数**：硬过滤已经保证含歌名了，
这里再判一次「歌名命中」永远是 true，没有信息量。

**④ 排序**：收藏整段置顶（相对顺序不变、不参与打分）→ 其余按总分降序 →
同分保持 B 站原序（V8 的 `sort` 是稳定排序）。

**⑤ ⚠️ 过滤只作用于「非收藏项」**
**⑤ ⚠️ 过滤只作用于「非收藏项」**

收藏是**用户自己挑的**（点收藏，或手动「添加视频」粘的链接）——
它不该被「标题里有没有歌名」「时长对不对」这类**搜索匹配规则**判掉。
第一版把收藏也一起过滤了，后果是：用户手动添加的视频（标题往往是自己起的、
不含歌名）**直接从列表消失**，而且刷新也找不回来。

```
rankVideos 里的顺序：
  ① 先把收藏摘出来（不参与过滤，顺序也不动）
  ② 只对 !favorites 的做硬过滤
  ③ 只对 !favorites 的按分数排序
  ④ 拼起来：[...收藏, ...排好序的其余]
```

**⑥ 过滤后为空 → 返回空 + `filtered: true`，不搞「回退」**

```ts
if (finalList.length === 0) {
  return { data: { ...result.data, result: [], filtered: true } }
}
```

> **为什么不「回退成不过滤」**（第一版就是这么写的）：那会把
> **标题不含歌名**的条目一起放回列表里 —— 用户看到列表里混着一堆不相关的视频。
> 歌名是「是不是同一首歌」的唯一硬判据，它没有「回退」这个选项。

**⑦ 缓存路径也要过一遍，但只读不写**

缓存里存的**本来就是过滤好的列表**，所以正常路径下这次过滤什么都不会改 ——
它只解决**一个**场景：**用户改了过滤设置**（缓存不会因为设置变了就失效）。

**但绝不回写缓存**：`save` 是 DELETE + INSERT，把过滤后的列表写回去
= 把「按当前规则不该显示」的行从库里**永久删除**。

> 实测（`cache.save` 真跑）：
> ```
> 初始:               D1, D2
> 回写过滤后的列表后:  D1          ← D2 从库里消失了
> ```
> 后果：用户把容差从 30 调回 90（或删掉一个过滤词）想找回那些结果时，
> **它们已经不在库里了**，必须重新联网搜索才回得来。

缓存路径**一律放宽时长上限**：缓存里存的是已经取回来的结果，
而它当初是用哪一档容差、有没有走降级轮取的 —— 这里无从得知（那份信息没落库）。
用严格上限重过滤可能把合法结果**藏起来**（用户看到「我什么都没改，列表怎么少了」），
所以**宁可多留，不可误藏**。歌名 / 屏蔽词那两条照常严格。

## 4. 播放地址解析（dash / durl 两条路）

**入口**：`App.vue` 的 `changeVideo` → `electronApi.resolveVideoUrl(...)`
→ `ipc/biliApiHandlers.ts` 的 `api:resolveVideo`。

```
① ensureLoginState()                     ← 可能返回 null（未知）
② wantQn / wantAudioId = 本次手动选的 ?? 设置里的默认
③ 读缓存元数据（videos_meta 视图，不含地址列）
   + getVideoAddress(keyword, bvid)      ← 单独读一行（不到 0.1ms）
④ 可用性判定（四个条件）
   loginChanged / urlUsable / needDashUpgrade / needDurl
     全过 → 直接用缓存（除 setSelectedBvid 外不写任何东西）
     否则 → 联网重新解析
⑤ biliApi.resolveVideoUrl(bvid, {noDash, qn, audioId})
     view 拿 cid
       ↓
     优先 dash（fnval:16）→ extractDashStreams
       ↓ 失败（非 AUTH_FAILED 不致命）
     durl 兜底（fnval:1 + platform:html5）→ firstDurl
⑥ 写库
   resolvedFresh → updateVideoResult(...)   ← 按主键 UPDATE 一行
   无条件        → setSelectedBvid(...)     ← 只要切到这个视频就写
⑦ readVideoQuality / readQualityOptions → 角标与切换菜单
```

**dash vs durl**：

| | dash | durl |
| :--- | :--- |
| `fnval` | 1 |
| 形态 | 音视频**分离**，要 MSE 合成 | 渐进式 mp4，音视频混流 |
| 上限 | 1080P60 / 4K / 8K | **封顶 720P** |
| 何时用 | 优先 | dash 失败时兜底 |

> **为什么优先 dash**：实测 `fnval: 1` 这条通道请求 qn 填 80/116/120 都一样，
> `quality` 恒定回 64 —— 1080P / 4K 只存在于 dash 里。

**清晰度档位菜单**：`readQualityOptions` **只列响应里真正能拿到的档位**
（`dash.video[].id` / `dash.audio[].id`），没有 dash 时列表就是**空的**，
这是刻意的 ——「**按 id 分 URL，没有 URL 就放不出来**」，
「宁可菜单空着，也不要列出切不过去的档位」。

**地址有效性**：`isUrlUsable` 查 `deadline` 参数，要求剩余 > 5 分钟
（留解析与起播时间）。**拿不到 deadline 时返回 true**（无法判断就按「未知」处理）。
dash 的 `videoUrl` 与 `audioUrl` **都要检查**。

**标题 / 封面 / 时长来自三个不同来源**：
标题取搜索结果（带 `<em>` 高亮）、封面取 view 响应（尺寸更大）、
时长也取 view 响应 —— 因为**搜索接口有些结果压根不带 `duration`**（实测存在），
而这次解析**无论如何都要调 view** 拿 cid，白拿的数据就该用来补上。
补时长的效果不止「补插新行」：`updateVideoResult` 用的是
`duration = COALESCE(duration, ?)`，所以**库里已经是 NULL 的行也会被补上** ——
那些没时长的候选，**播过一次就有了**。

## 5. dash + MSE 播放

**位置**：`src/utils/dashPlayer.ts`。

**为什么不用 `<video src>`**：dash 的音视频是两条独立流，只给一条会没声音；
`<video>` 一次只能一个 URL。所以两轨塞进同一个 MediaSource 的两个 SourceBuffer ——
「这样对外仍然只有一个媒体元素，**进度、音量、续播、SMTC 这些现有逻辑一行都不用改**」。

**分片调度**：

```
两轨 Promise.allSettled 并行 pump
  ↓
每轮：waitForRoom（前向只留 30 秒，超了 500ms 轮询等播放推进）
  ↓
fetch + getReader + append
  ↓
正常返回 = 两条流都取完；中途失败一律抛错
```

> 「只拿到一半（黑屏有声 / 哑巴）比退回 720P 更糟」。

**配额三件套**：前向限流 30s + 撞配额丢 `KEEP_BEHIND_S` 再按
`[90,60,40,25,15]` 递减重试 + **15 秒下限**。
**刻意不做每轮主动裁剪** —— m4s 是顺序下载的，裁掉拿不回来，
主动裁会把回拖窗口压得很小。

**音视频同步**：**没有显式的 A/V sync 代码**。同步是隐式的 ——
两轨各自顺序 append 进自己的 SourceBuffer，由媒体元素的播放时钟统一驱动。

## 6. 切歌预热（为什么切歌几乎无感）

**位置**：`App.vue` 的 `warmApi` / `maybeWarm` + `_warm` 系列状态。

**能「几乎无感」是四层叠加**：

1. **本地信息先切**（`changeSong` 第一件事就是切 `currentIndex`/`songName`）
2. **接口结果已在槽位**（预热提前把搜索 + 播放地址问好）
3. **隐藏静音 `<video>` 已把开头 2.5 秒拉进 HTTP 缓存**
4. **主进程解析缓存**（地址还没过期就直接用）

**心跳**：1 秒一次，`currentTime > 2` 备下一首、`> 6` 备上一首。

**九件套状态**：`_warm`（槽位）/ `_warmed`（拉过 2 秒没）/ `_warming`（并发去重）/
`_warmTries` / `_warmFailed` / `_warmRetryAt` / `_warmEl` / `_warmSession` / `_warmTimer`。

**`_warmTries` 为什么必须有**：心跳每秒调 `warmApi`，而搜不到视频时
`_warm[dir]` 是空的、拦不住它 —— 「**每秒发一次真网络请求，永不停止**」，
症状是「控制台同一个关键词刷几十行、界面变卡」。
因为心跳是 1 秒一次，光靠计数做不到「间隔 3 秒」，所以必须同时看 `_warmRetryAt` 时间戳。
3 次后 `_warmFailed` 彻底停掉，**只在未登录时才弹通知**
（已登录还搜不到多半是 B站真没有，提示「请登录」是误导）。

**`warmApi` 的挑选规则必须与 `changeSong` 逐字一致**（也必须问 `getSelectedBvid`），
否则预热好的地址切歌时会被换掉。

## 7. 收藏与「添加视频」

**收藏**：`api:setFavorite` → `cache.setFavorite`。

- **收藏**：原来排在它前面的 `ord` 各 +1、自己置 0（**同一事务** ——
  中间态被读到会出现两个 `ord = 0`，排序结果不确定）
- **取消收藏**：只把 `favorites` 置 0、**位置不动**
- **返回完整列表**：顺序由主进程的 `ord` 决定，只有主进程知道权威结果；
  返回 void 的话渲染层只能自己猜「现在排第几」，迟早和库里不一致

**「添加视频」复用 `setFavorite`**：
「添加的语义就是这首歌多一个我一定要用的候选，也就是收藏」——
主进程会补插行 + 挪到第一位，不需要另写一套。

**收藏前要回源补齐元数据**：粘贴的 BV 号很可能**不在**搜索结果里，
`setFavorite` 会补插一行但那时标题/封面是空的，
不写进去下次刷新列表就成了一条只有 BV 号的空壳。

**渲染层的 `favoriteBvids` 直接从 `videoList` 读 `favorites` 字段** ——
主进程 `videos.favorites` 是权威，「两份数据一定会漂移」。
`onToggleFavorite` 用**返回值**刷新标记（不是本地取反）。

## 8. 续播

**位置**：`App.vue` 的 `tryResume` / `restoreSongVideo`。

```
tryResume()
  读 setting: player.resumeOnStart / player.resumeTime
  读歌单的 lastIndex
  ↓
restoreSongVideo(songName, resumeTime)
  ① getSelectedBvid(songName)     ← 主进程 song_meta
     **没有记录就直接 return false**（说明这首歌从没播过）
  ② searchSong(songName)          ← 走缓存，秒回
  ③ 记住的 bvid 不在结果里 → 补成列表第一项
  ④ changeVideo(bvid, songName)
```

**「上次播的是哪个视频」= `song_meta.selected_bvid`**，
由 `api:resolveVideo` 在**每次真正切到某个视频时**落库（一行 upsert）。
换 SQLite 之前之所以要攒到「切歌 / 退出」才写，是因为旧实现是 JSON 文件 ——
每写一次都要把整份候选列表 stringify 再 rename；
现在按主键更新一行就够了，语义反而更准
（不必担心「切了视频但没切歌就退出」会丢）。

## 9. 桌面壁纸模式

**位置**：`electron/main/index.ts` 的 `setWallpaperMode` + `winWallpaper.ts`。

**进入**：

```
① isWallpaperAvailable() 校验      ← 失败会告诉渲染层原因
② captureWallpaperRestore()        ← 记还原点（是否全屏 + 普通尺寸）
③ applyFullScreenGeometry()        ← 先铺满
④ setVisibleOnAllWorkspaces(true) + isFullScreen = true
⑤ await 120ms                      ← 等系统把尺寸应用完
⑥ 先置 wallpaperAttached = true    ← 宁可多摘一次，不能漏摘
⑦ attachWallpaper()                ← SetParent + 回读验证
     失败 → rollbackWallpaperAttach()（必含 detach）
     成功 → setSkipTaskbar(true)
```

**退出**：`detachWallpaper()` → `resetWallpaper()` →
**确认成功才清 `wallpaperAttached`** → `await 80ms` → 还原几何。

**为什么先铺满再 attach、为什么要等 120ms/80ms**：
原实现先 attach 再切全屏，挂载时窗口还是普通尺寸 →
「进了壁纸模式但没在壁纸层全屏」；壁纸层跟随窗口几何，要等尺寸应用完。

**为什么串行 + 合并**：连点（标题栏按钮 + 托盘项）或与「开机即壁纸」的启动
apply 相撞时，两次 apply 会交错 —— 先进壁纸那次在 120ms 延时后才 attach，
而退出那次早已 detach 并还原几何，最后 `wallpaperEnabled = false`
但窗口真的挂在桌面层、任务栏按钮也没了，**状态与实际长期漂移**。

**回到窗口模式的三条路**：标题栏按钮 / 左键点托盘图标 / 托盘菜单里的「窗口模式」。
三者都走 `restoreWindow()`，它用**三条件取或**判断是否需要 detach ——
不看标志，直接问系统，所以状态漂移也能救回来。

**渲染层配合**：`.wm-hidden` 用 **class 不用 `v-if`**（「组件不卸载，
内部状态不会丢」）；**进壁纸时关掉所有弹窗**
（原来弹窗在壁纸模式下既点不动也关不掉）。

## 10. 系统托盘（含自绘菜单）

**位置**：`electron/main/index.ts` 的托盘相关函数 + `src/trayMenu/main.ts`。

**为什么自绘而不是原生菜单**：
`attach()` 在 `forwardMouseInput: true` 时注册 `RIDEV_INPUTSINK`，
把**全系统鼠标事件** `PostMessageA` 塞进壁纸窗口；原生弹出菜单只要收到
「菜单外的一次按下」就关 —— 点托盘图标那一下就同时被塞进壁纸窗口，
**菜单刚出来就被自己关掉**。而且这个转发是 Rust 侧全局装的、JS 关不掉。

**两个补偿机制**（对抗时序问题）：

1. **120ms 兜底显示**：页面那边「高度没变就不回报」，
   所以显示不能绑在 `trayMenu:ready` 上 —— 只装一次的话第一次右键能弹，
   第二次开始高度没变、页面不回报，**菜单再也不出现**。
2. **400ms 失焦看光标位置**：壁纸模式鼠标转发下，用户按下鼠标时
   库会往壁纸窗口塞合成 `WM_LBUTTONDOWN`，Chromium 随即 `SetCapture` 抢激活 →
   菜单立刻 blur；直接 hide 会让按键还没抬起菜单就没了，
   真实 mouseup 落不到菜单项上，表现为「点了没反应」。

**`KEEP_MENU_OPEN`**：`seek`/`volume`/`toggleMute`/`playControl`/`prev`/`next`/`toggleMode`
这些**不会被连续使用**的动作**不收起菜单**。
判据是「这个动作会不会被连续使用」—— 进度条/音量拖动是连续的
（踩过：鼠标一碰音量条菜单就没了），上/下一首/暂停/循环是连点场景；
而设置歌单/壁纸/退出登录/退出程序是一次性跳转或命令，执行完就该收起。

## 11. 配置（setting）的读写与广播

**单一数据源在主进程**，渲染层只有一份响应式副本。

```
启动：getStore 读盘 → migrateSetting（版本闸门）
     → mergeSetting（默认值 + 用户值，含类型校验）
     → structuredClone 隔断与 defaultSetting 的共享引用
     → 内存单例 appSetting
       ↓
渲染层 setting:get → 填 Pinia → 挂 setting:update 广播监听
       ↓
任何改动：setting:update → updateSetting
     防御 → 类型校验 → structuredClone 后 mergeSetting
     无变化 → 返回 {}（不写盘不广播）
     有变化 → 更新内存 + 300ms 防抖落盘 + 通知主进程 listener
              + broadcast 给**所有** webContents
```

**只把变化的那部分广播**，避免整包配置来回传；
**没有变化就不写盘不广播**，避免无意义 IO 与多窗口抖动。

**`resetSetting` 要显式深拷贝三个嵌套结构**（`tagBonus` / `filterKeywords` /
`customAspectRatios`）—— 见 `setting.ts` 那条踩坑。

## 12. 缓存与过期

**位置**：`utils/cache.ts` + `utils/db.ts`。

**★ `search_key` 存的是「歌名-歌手」，不是 `songs.id`**（这点容易搞混）：

| 表 | 键 | 值 | 为什么 |
| --- | --- | --- | --- |
| `videos` / `song_meta` | `search_key` | `歌名-歌手` | 这两张表要拿键**去搜 B站** —— 用 `tx_1828354` 那种 id 搜不出任何东西 |
| `songs` / `playlist_songs` | `id` / `song_id` | `平台_平台id` | 只用于「标识同一首歌」，让多歌单共用一行 |

它们**没有关系**，各用各的键。渲染层传的 `songName`（`getSongName`）就是前者。

**过期语义（重要）**：只有**播放地址那一批列**会过期
（`durl_url` / `dash_video` / `dash_audio` / `dash_duration` / `playurl_at`），
标题 / 封面 / 收藏 / 顺序**永不过期**，所以清理**只把这些列置 NULL、绝不删行**。

**`dash_tried` 和 `playurl_login_state` 刻意不清** —— 它们不是「地址」：

- `dash_tried` 的作用是「试过 dash 但没拿到，下次别反复重取」，
  清了就等于每轮过期都把「这个视频没有 dash」这件事忘掉，然后一直重试。
- `playurl_login_state` 描述的是**取地址时的账号权限**，这个结论不随时间过期
  （用户没退出登录它就一直成立），清了「登录后才该重取」的判断就失效。

**设置项**：`cache.searchResultExpireMs`（**0 = 永久**，界面上显示成「永久」）。
清理入口：启动后设置变化时、以及设置里那个「清理过期」按钮。

**为什么元数据不过期**（这是设计上的一次修正）：
旧 JSON 实现把「整个搜索结果包」当一个条目，到期连标题/封面/收藏一起删；
而播放直链实测寿命只有约 2 小时 —— 用 2 小时的寿命决定 3 天的元数据寿命，
结果就是「隔一天回来，**收藏位置全乱、标题也没了**」。

## 13. 打包与代码保护

```
build:only（electron-vite 三个目标）→ out/     ← 保护前必须是干净明文（脚本会检查）
   ↓
protect（scripts/protect.mjs）**就地改写 out/**
   1. 主进程 / 预加载 → V8 字节码（bytenode）
   2. 渲染层 js → 混淆（javascript-obfuscator）
   3. 渲染层 html/js/css → AES-256-GCM 加密
   ↓
electron-builder（asar）→ 打包 out/
```

**运行时**：主进程注册 `blmv://` 协议，页面请求哪个资源就解密哪个，只解密到内存；
页面地址从 `file://` 变成 `blmv://app/index.html`。

**为什么 `protect` 必须先检查 `out/` 是不是干净明文（踩出来的）**：
保护是**就地改写**，所以它既不能在已经保护过的产物上再跑一遍，
也不能在**混合态**上跑。混合态是这么来的：`out/renderer` 还留着上一轮的密文，
而 main 被重新构建成明文 —— 这时候启动应用，明文主进程没有解密协议，
直接把密文当 HTML 加载，**用户看到满屏乱码**（真发生过）。

**验收方式**（改这块照这个来）：

1. `npm run build:protected` 后做**字节级**检查
   （密文头 `BLMV1` + `.jsc` 存在 + 加载器只有几百字节）
2. 用 `BLMV_FORCE_PROTECT=1` 跑开发态验证：
   页面 URL 是 `blmv://app/`、DOM 完整、`electronAPI` 可用、能搜到歌、能起播 ——
   **并且要断言音频真解码**（只看 `duration` 会漏掉 CORS 问题）
3. `npx electron-builder --dir` 后用 `@electron/asar` 抽文件看头是不是 `BLMV1`
4. 直接启动 `release/win-unpacked/BLMV.exe`，看窗口标题出不出来
   （标题来自渲染层，等于「解密 + 混淆后仍能跑」的端到端证明）

---

## 附：一张总览图

```
┌─────────────────────────── 渲染进程（src/） ───────────────────────────┐
│  App.vue（中枢：播放业务 + 全部状态）                                   │
│    ├── components/  纯展示 + $emit 上报（不持有业务状态）                │
│    ├── stores/      Pinia 副本（不持久化）                              │
│    └── utils/       dashPlayer / uiTheme / image / title / plain        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ window.electronAPI（preload 类型化）
┌───────────────────────────────┴────────────────────────────────────────┐
│                        主进程（electron/main/）                         │
│  index.ts（入口 + 窗口/壁纸/托盘状态机）                                 │
│    ├── ipc/*            按领域拆分的 handler（依赖注入 IpcContext）      │
│    ├── biliApi.ts       B站接口（WBI 签名 / dash 与 durl）              │
│    ├── music/           多平台歌单解析（移植自 LX）                      │
│    ├── utils/           db(SQLite) / cache / playlist / setting / store │
│    ├── winWallpaper.ts  koffi 直调 Win32                                │
│    └── protection.ts    blmv:// 解密协议                                │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   blmv.db（SQLite）      setting.json（原子写）    %APPDATA%/BiLiMusicVideo/
   5 表 + 1 视图           temp + rename            或便携版 exe 同级 blmvdata/
                                                      （portable.ts 决定）
```

**两级 id 是数据的骨架**（都由主进程拼，渲染层只做透传）：

| 主键 | 形态 | 谁拼 | 用在哪 |
| --- | --- | --- | --- |
| `playlists.id` | `平台_平台歌单id`（`tx_8153225605`）；手动建的是 `pl_<uuid>` | `playlistKey()`（`ipc/music.ts`） | 歌单身份；重复导入命中同一行 |
| `songs.id` | `平台_平台歌曲id`（`tx_1828354`）；手动歌是 `歌名-歌手` | `songId()`（`writePlaylistsToDb`） | `playlist_songs.song_id`；同一首歌多歌单只占一行 |

**另一条数据纽带是 `search_key`**（`toSearchKey(song)` = `"歌名-歌手"`）：
它是 `videos` 复合主键的前半段、`song_meta` 的主键。
> ⚠️ **它跟上面两个 id 是两回事**：`videos` / `song_meta` 要拿键去**搜 B站**，
> 用 `tx_1828354` 那种 id 搜不出任何东西 —— 所以那两张表存的是**歌名**。
> 渲染层、缓存、`findSongDuration` 共用同一个 `toSearchKey`，
> 所以「这首歌是谁」的判定完全一致。
