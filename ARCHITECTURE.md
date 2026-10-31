# 实现笔记（架构 / 踩坑记录）

> 这份文档讲的是**为什么这么写**：数据流、类型链路、边界处理，以及一路踩过的坑。
> 只想用这个播放器的话看 [README](README.md) 就够了；
> 想改代码 / 想知道某个诡异行为为什么存在，就翻这里。

**大概分四块**

| 想看什么 | 看哪几节 |
| --- | --- |
| 代码怎么组织的 | 架构设计（目录结构 / 播放引擎与状态分层 / 配置数据流 / 类型链路 / 别名） |
| 界面怎么拼的 | 界面布局、图标（iconfont）、界面颜色与毛玻璃（CSS 令牌） |
| 播放链路怎么走的 | 清晰度 / 音质切换、清晰度角标、dash + MSE、缓冲提示、缓存里的播放地址 |
| B 站视频列表（第二条进料管） | B 站视频列表：收藏夹 / 合集 / 系列（四张表、按 bvid 直达、为什么不打分） |
| 几个难搞的状态 | 登录态、切歌后播放器信息不刷新、续播、全屏与桌面壁纸 |
| 数据与打包 | 数据存储、歌单解析、便携版数据目录、图标路径、为什么用 JSON、搜索缓存策略 |

---

## 架构设计

整体参照 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) 的核心思想：
**主 / 渲染共用一套类型，配置由主进程唯一持有，渲染进程只做响应式副本。**

### 目录结构

```
├── electron/
│   ├── common/                     # ★ 主进程与渲染进程共用（LX 的 src/common）
│   │   ├── types/
│   │   │   ├── app_setting.ts      #   AppSetting 全量配置 TS 接口（扁平点号键）
│   │   │   ├── ipc.ts              #   IPC 频道契约 ChannelMap（入参/返回值）
│   │   │   ├── api.ts              #   preload 暴露给 window 的 api 契约
│   │   │   ├── playlist.ts         #   歌单 / 曲目 / 收藏视频的类型与搜索键
│   │   │   ├── musicSdk.ts         #   多平台音源的类型
│   │   │   └── cache_stats.ts      #   缓存占用统计的返回结构
│   │   ├── defaultSetting.ts       #   默认配置对象（satisfies 强校验）
│   │   ├── constants.ts            #   配置版本号、存储名等常量
│   │   ├── ipcNames.ts             #   广播事件名（invoke 频道名走 types/ipc.ts 的类型）
│   │   ├── mainIpc.ts              #   主进程侧类型化 IPC 包装 + 广播
│   │   ├── rendererIpc.ts          #   渲染进程（preload）侧类型化 IPC 包装
│   │   └── utils/
│   │       ├── migrateSetting.ts   #   配置版本迁移（版本闸门逐级抬升）
│   │       ├── mergeSetting.ts     #   默认值 + 用户值合并，并算出变化的 key（含类型校验）
│   │       ├── duration.ts         #   时长归一化（"4:03" / 秒 / 脏数据 → 秒）
│   │       ├── videoRank.ts        #   ★ 硬过滤 + 分层打分 + 排序（主进程写 ord 前调用）
│   │       └── common.ts           #   compareVer / debounce
│   ├── main/
│   │   ├── index.ts                # 入口：便携模式 → 初始化配置/歌单 → 注册 IPC → 建窗口
│   │   ├── ipcHandlers.ts          # 组装各领域 handler（IpcContext 依赖注入）
│   │   ├── protection.ts           # ★ 打包后渲染层资源的 blwe:// 解密协议
│   │   ├── bundleKey.ts            # 打包加密用的对称密钥（会被编进主进程字节码）
│   │   ├── winWallpaper.ts         # ★ 桌面壁纸层（koffi 直调 Win32：WorkerW / SetParent）
│   │   ├── portable.ts             # 便携版数据目录（%APPDATA% 优先，否则 exe 同级 blwedata/）
│   │   ├── biliApi.ts              # B站 API（搜索/视频解析/WBI 签名/登录态）
│   │   ├── music/                  # ★ 多平台歌单解析（移植自 LX 的 musicSdk）
│   │   │   ├── index.ts            #   音源总表 + 按链接自动识别平台
│   │   │   ├── http.ts             #   请求层（跟随重定向 / 超时 / 解压）
│   │   │   ├── utils.ts            #   时长格式化、HTML 实体解码、歌手名拼接
│   │   │   └── sources/
│   │   │       ├── wy.ts           #   网易云（weapi 加密通道）
│   │   │       ├── wyCrypto.ts     #   网易云 weapi / linuxapi 加密
│   │   │       ├── tx.ts           #   QQ音乐（musicu.fcg）
│   │   │       └── kw.ts           #   酷我音乐（pl.svc）
│   │   ├── utils/
│   │   │   ├── setting.ts          # ★ 配置服务：内存常驻 + 防抖落盘 + 变更通知
│   │   │   ├── playlist.ts         # ★ 歌单集合服务：迁移 / 增删改 / 同步 / 收藏
│   │   │   ├── db.ts               # ★ SQLite 单库 schema（4 表 + 1 视图 + schema 指纹）
│   │   │   ├── store.ts            # 原子写入的 JSON 存储
│   │   │   ├── atomicJson.ts       # 公共的「temp + rename」原子写
│   │   │   ├── cache.ts            # ★ 搜索缓存（存 SQLite，按 ord 拼回列表）
│   │   │   └── quality.ts          # ★ 读出「实际在播」的档位（dash 靠 URL 比对、durl 从 URL 反推）
│   │   └── ipc/                    # 按领域拆分的 handler：app / auth / window / wallpaper /
│   │                               #   tray / setting / playlist / cache / music / biliApi
│   ├── preload/
│   │   ├── index.ts                # contextBridge 暴露类型化 api
│   │   └── index.d.ts              # window.electronAPI 全局声明
├── src/                            # 渲染进程
│   ├── main.ts                     # 挂载前先拉配置 + 挂广播监听
│   ├── App.vue                     # ★ 装配图：模板 + 把 <video> 交给 store（没有样式、没有业务）
│   ├── stores/                     # ★ Pinia：11 个独立 store + 1 个启动编排
│   │   ├── playback.ts             # ★ 播放：引擎挂载 / <video> 事件 / 缓冲 / 卡顿链 / 预热
│   │   ├── queue.ts                # ★ 队列：列表数据 / 当前下标 / 模式 / 装载
│   │   ├── ui.ts                   # ★ 界面：弹窗开关 / 列表面板 / 提示 / 网络忙
│   │   ├── window.ts               #   窗口 / 全屏 / 壁纸 / 锁定 / 拖拽 / 快捷键
│   │   ├── system.ts               #   SMTC / 任务栏 / 托盘 / 落盘 / 定时同步
│   │   ├── session.ts              #   登录态与用户信息
│   │   ├── sleep.ts                #   定时暂停 / 定时关闭
│   │   ├── drop.ts                 #   拖入导入（四路分派）
│   │   ├── bootstrap.ts            #   不是 store：boot.attachVideo / bootstrap / teardown
│   │   ├── constants.ts            #   播放常量（缓冲 / 预热 / 卡顿 / 冷却）
│   │   ├── setting.ts              # ★ 配置的响应式副本
│   │   ├── playlists.ts            # ★ 歌单集合 + 同步编排 + 收藏
│   │   └── videoLists.ts           # ★ B 站视频列表副本（列表 / 条目 / 同步 / 收藏）
│   ├── api/electron.ts             # 直接透出 window.electronAPI（已带类型）
│   ├── assets/                     # 图标字体 + 头像（avatar.jpg / avatar-fish.jpg）
│   ├── styles/                     # ★ 全局样式（由 main.ts 引入，不在任何组件里）
│   │   ├── theme.css               #   主题令牌：--glass-* / --panel-* / 强调色 / 深浅底阴影
│   │   └── global.css              #   骨架（#app / #biliVideo）+ el-dialog 覆盖面化的覆盖
│   ├── trayMenu/main.ts            # ★ 自绘托盘菜单页逻辑（独立窗口 / 独立构建入口）
│   ├── types/
│   │   ├── app.ts                  # 组件数据类型（AppData 等）
│   │   └── playItem.ts             # ★ PlayItem 联合类型 + isVideoItem / titleOf / keyOf
│   ├── utils/
│   │   ├── playbackEngine.ts       # ★ 播放引擎：队列条目 → <video> 上的流
│   │   ├── dashPlayer.ts           # ★ MSE（dash）分片调度
│   │   ├── videoQuality.ts         # 按解码分辨率兜底一个清晰度标签
│   │   ├── image.ts                # 图片地址规整
│   │   ├── plain.ts                # 去响应式（写盘前）
│   │   ├── title.ts                # 窗口标题拼装
│   │   ├── sleepTimer.ts           # 定时暂停 / 定时关闭
│   │   ├── mediaProbe.ts           # 本地视频探针
│   │   └── uiTheme.ts              # 主题令牌（颜色/模糊/阴影）
│   └── components/
│       ├── AppTitlebar.vue         #   标题栏（纯展示：歌名 / 模式 / 窗口按钮 / 置顶）
│       ├── BufferOverlay.vue       #   缓冲圈（纯展示：percent + 文案）
│       ├── CornerButtons.vue       #   右下角按钮组（壁纸 / 锁定 / 列表 / 定时 …）
│       ├── PlaylistPanel.vue       # ★ 左上歌单入口（点一下直接开管理弹窗）
│       ├── PlaylistManager.vue     # ★ 歌单管理弹窗（新建 / 编辑 / 同步 / 曲目）
│       ├── VideoListManager.vue    # ★ 视频管理弹窗（四种来源 / 封面网格 / 本地文件丢失）
│       ├── SettingsDialog.vue      # ★ 设置弹窗
│       ├── AboutDialog.vue         # ★ 关于弹窗（仓库地址 / 作者与 DeepSeek·大肥鱼头像）
│       ├── AddVideoDialog.vue      # ★ 「添加视频」弹窗（粘贴链接 → 解析 → 收藏）
│       ├── SleepTimerPanel.vue     #   定时暂停弹窗
│       ├── VideoControls.vue       #   播放控制栏
│       ├── SongVideoListDialog.vue #   歌曲/视频列表弹窗（放大镜搜索 / 刷新 / 爱心收藏）
│       └── DropOverlay.vue         #   拖入遮罩（「松手即可导入并播放」）
├── scripts/protect.mjs             # ★ 打包保护流水线：字节码 + 混淆 + 资源加密
├── index.html / tray-menu.html     # 两个渲染入口
└── electron.vite.config.ts
```

### 播放引擎与状态分层（渲染层怎么拆的）

`App.vue` 曾经有 5587 行：模板、150 多个方法、117 个 data 字段全挤在一个文件里。
问题不在于「文件大」，而在于**两种状态缠在一起** —— UI 状态（面板开合、拖拽、全屏、
悬浮窗可见性）和播放状态（当前条目、进度、清晰度、续播点）混在同一批字段里，
于是「切一条视频」要横跨十几个方法，任何一处改动都要先读完整份文件。

现在分三层，**依赖方向只允许单向**：

```
components/*.vue        只做展示 + 直接读写 store        ← 没有 props，也没有 emit
      ↕ usePlayerStore()
stores/player/*         播放状态 + 业务编排（谁该响了、该写哪张表）
      ↑ host 回调
player/engine.ts        只把「队列里的一条」变成「<video> 上的流」
```

**组件那一层不再是「纯展示 + 上报」**，这是拆完之后又往前走的一步：
`App.vue` 曾把 store 的字段一个个 `:prop` 下去、再把 11 个 `$emit` 接回来调同一个
action —— 那层中转没有任何信息量，只是让「加一个按钮」要改两个文件。
现在每个组件自己 `usePlayerStore()`：显示什么从 store 读，点一下直接叫对应的方法。
`App.vue` 因此只剩**十二行标签**，`components/` 下 13 个组件里 `$emit` 的出现次数是 0。

代价要写清楚：**组件与 store 绑死了，不能拿去别处复用**。这个项目里每个弹窗、
每条控制栏都只服务于这一个播放器，复用是伪需求；换来的是「一处状态只有一个主人」
—— 以前 `sleepPanelVisible` 有两个写入方（组件 emit 上去、App 再写下来），
`el-dialog` 的 `v-model` 会在两边来回覆盖，`SleepTimerPanel` 里那段
「为什么必须自己先关掉」的注释就是这么来的。现在 setter 直接写 store，那个回环消失了。

**引擎是唯一跟播放器打交道的地方。** 它不知道 Vue、不知道 Pinia、不读任何组件字段 ——
需要外界的信息全部走 `PlaybackHost` 的回调（`queue()` / `index()` / `videoEl()` /
`withNet()` / `stepIndex()` …）。这么做不只是为了好测：**换一个宿主（比如托盘小窗）
也能直接复用**，不必把组件那套状态搬过去。

**切歌只有两个入口，没有第三个**：

| 入口 | 什么时候用 | 走哪条路 |
| --- | --- | --- |
| `playAt(index)` | 换队列里的另一条（切歌 / 切视频 / 上一个 / 下一个 / 随机） | 歌：搜索 → 挑候选 → 解析；视频：直接按 bvid 解析 |
| `playCandidate(bvid, opts)` | **不换条目**，只换这一条里的视频 | 换清晰度 / 音质、dash 退 durl、卡顿后跳缓存重试、登录后重取、续播按 `selected_bvid` 起播 |

以前是 `changeSong`（221 行）和 `changeVideo`（194 行）并存，两者各有一份令牌、
各写一遍「清状态 / 续播 / 预热 / 落盘」，9 处调用点互相穿。现在两者都收敛成
引擎里的 `playItem()`，竞态只剩**一条** `token`：切走就 `++`，回调回来对不上就丢弃。
（以前是 `_songToken` / `_videoToken` 两条令牌，该谁失效靠人记。）

**队列条目是联合类型，不做形状伪装。**

```ts
type PlayItem = PlaylistSong | VideoListItem
isVideoItem(item)   // 'title' in item
```

以前 `toSongs()` 把视频映射成歌的形状（`title→name`、`author→singer`），
于是下游只能靠 `if (item.bvid)` 猜这是不是视频 —— 类型系统完全帮不上忙，
每加一个视频功能都要先绕过这个假设一次。判别字段选 `title` 是因为
`VideoListItem.title` 必有、`PlaylistSong` 永远没有，而 `bvid` 在歌上也曾是可选字段、
用它判别会重叠。

**store 按域拆成 8 个独立 store。** 一个 `defineStore` 只管一个业务域，跨域访问写
`this.queueStore.playAt()` —— 那个指针是 getters 里的一个条目，返回另一个 store 的实例
（惰性求值，所以模块之间可以互相 import 而不成环）。

| store | 管什么 |
| :--- | :--- |
| `playback` | 引擎、dash/durl 挂载、`<video>` 全部事件、缓冲圈、卡顿恢复链、清晰度切换、下一首预热 |
| `queue` | 列表数据（`songs` / `videoList`）、当前下标、播放模式、歌单与视频列表装载、候选视频刷新 |
| `ui` | 弹窗开关、列表面板、错误文案、网络忙标记与清晰度冷却 |
| `window` | 最大化 / 全屏 / 壁纸模式 / 锁定 / 标题栏拖拽 / 快捷键 |
| `system` | SMTC、任务栏进度、托盘状态同步、播放位置落盘、定时同步 |
| `session` | 登录态与用户信息 |
| `sleep` | 定时暂停 / 定时关闭 |
| `drop` | 拖入导入四路分派（歌单 / 单曲 / B 站列表 / 单条视频） |

`playlists` / `videoLists` / `setting` 本来就是独立的（只做数据，不碰界面）。
`bootstrap.ts` 里的 `boot` **不是 store** —— 它只做启动编排（`attachVideo` / `bootstrap` /
`teardown`），自己不留任何状态，所以不占一个 store 的位置。

**`playAt` / `next` / `prev` 留在 `playback` 而不是 `queue`**，尽管它们改的是队列下标：
它们要跟引擎令牌、降级链、续播点打交道，搬进 queue 就变成 queue → playback → queue 的
双向流程调用。queue 只回答「列表里有什么」。依赖方向因此是 `playback → queue → ui`。

**代价**：跨域调用从 `this.playAt()` 变成 `this.queueStore.playAt()`，链路长了一截；
换来的是一条清晰的边界 —— 读 `ui.ts` 不用同时记住另外 4000 行。

**拆的时候踩了三个坑，都不是「写法选择」而是必须这么写**：

1. **`ThisType<>` 要指向本 store 的 `Context`，不能指向 store 实例。**
   每个文件自己声明 `XxxState` / `XxxGetters` / `XxxActions`，再合成
   `XxxContext = State & Getters & Actions`，对象上标 `ThisType<XxxContext>`。
   ⚠️ 不能写 `this: ReturnType<typeof useXxxStore>` —— 那会和 `defineStore` 的泛型
   形成类型循环，编译器直接爆栈。
   代价是**签名写了两遍**（实现 + `interface XxxActions`），改方法签名要同步改；
   这份签名是从原代码脚本生成的（154 个方法），不是手抄的。

2. **getters 是双形态的。** Pinia 的 `defineStore` 参数要**函数表**（它靠这个把每个
   getter 包成 computed），而 `this.xxx` 拿到的必须是**解包后的值**。从同一份声明派生：

   ```ts
   export type PlaybackGetterFns = { [K in keyof PlaybackGetters]: () => PlaybackGetters[K] }
   ```

   `defineStore` 的泛型用 `XxxGetterFns`，装配处写 `getters: playbackGetters as never`
   —— 那个 `as never` 只是骗过「对象形状」检查，真正的类型由泛型参数给出。

3. **跨 store 的指针必须写成 getter，不能在模块顶层 `useXxxStore()`。**
   `playback.ts` import 了 `queue.ts`，`queue.ts` 也 import 了 `playback.ts` ——
   ESM 允许这种循环，前提是**求值时对方已经初始化完**。写成
   `queueStore: () => useQueueStore()`（getter 体里才调用）就绕开了：
   第一次访问必然发生在 store 已经建好之后。

**`App.vue` 现在剩什么**：模板装配（12 个组件 + `<video>` 的 13 个事件绑到 store）、
`onMounted` 里 `attachVideo()` + `bootstrap()`、`beforeUnmount` 里 `teardown()`。
**没有任何业务逻辑** —— 新增播放相关的东西，先问它属于哪个域，落点是
`stores/` 下对应的那个 store 或引擎，不是这个文件。

全局样式也不在这个文件：主题令牌在 `src/styles/theme.css`，骨架（`#app` / `#biliVideo`）
与 Element Plus 弹窗覆盖在 `src/styles/global.css`，由 `main.ts` 在 element-plus 的 css
之后引入。它们从来不属于 App 组件 —— `el-dialog` 是 teleport 到 body 的，scoped 够不到。

### 配置（setting）数据流

配置**由主进程唯一持有**，渲染进程的 Pinia 只是一份副本：

```
主进程启动
  └─ portable.ts      判断便携模式，改写 app.getPath('userData')
  └─ initSetting()    读 setting.json → migrateSetting 版本迁移
                      → mergeSetting 与 defaultSetting 合并补全缺项
  └─ 内存常驻一份完整配置，写入磁盘走 300ms 防抖

渲染进程
  页面加载   api.getSetting()             → 填充 Pinia
  用户改表单 api.updateSetting(partial)   → 主进程合并/落盘
  主进程广播 'setting:update'（只含变化的 key）→ 所有窗口的 Pinia 自动同步
```

关键设计点：

1. **扁平点号键**（`'player.volume'`、`'common.wallpaperMode'`）
   与 LX 一致。好处是「默认值 ↔ 用户值」只需一层浅合并，
   并且能精确算出到底哪些 key 变了 —— 广播和写盘都只处理变化的部分。
2. **只接收 `Partial<AppSetting>` 局部更新**，避免整包配置来回传。
3. **Pinia 不持久化**：更新后不要自己赋值，统一等主进程广播回来，
   保证单一数据源，也天然支持多窗口同步。

### TypeScript 类型链路

```
electron/common/types/ipc.ts  IpcChannelMap（频道 → 入参/返回值）
        │
        ├─ electron/main/ipc/*        mainHandle('setting:update', params => …)  ← 参数自动有类型
        │
        └─ electron/preload/index.ts  rendererInvoke/rendererOn 自动推导
                 │  satisfies RendererAPI（契约校验，漏实现会编译报错）
                 └─ src/global.d.ts 扩展 window
                        └─ src/api/electron.ts → 组件里 window.electronAPI.xxx 全量提示
```

### 别名的配置（容易踩坑）

`@common/*` 被三端共用，因此别名必须在**两处同时配置**：

- `electron.vite.config.ts` 的 `main` / `preload` / `renderer` 三个 `resolve.alias`（给构建器用）
- `tsconfig.node.json` / `tsconfig.web.json` 的 `paths`（给 tsc / IDE 用）

只配一处会出现「构建能过但编辑器报红」或反之。

### 界面布局

标题栏只保留必要入口，避免按钮堆积：

```
┌──────────────────────────────────────────────────────────────────┐
│ [☰ 歌单名] │          拖拽区（双击切换最大化）          │ [壁纸] [头像] [设置] [关于] [—][□][×] │
└──────────────────────────────────────────────────────────────────┘
```

> 中间是纯拖拽区：`-webkit-app-region: drag` 那套在无边框窗口里不好使，
> 所以拖拽是自己在 `onTitlebarMouseDown` 里算偏移再 `win:moveWindow` 的，
> 双击走最大化 / 还原。

- **左上「歌单」**：显示当前歌单名，**点一下直接打开歌单管理弹窗**
  （切换 / 同步 / 新建编辑 / 曲目全在那边）。
  这里原来挂了个快捷下拉菜单，已经去掉：两个入口容易状态打架，而且用户点开基本只为了进管理。
  hover 表现和标题栏其它按钮一致：只换背景，不动透明度（值也照抄 `.titlebar-btn`：圆角 8px、内边距 0 12px）。
- **右上「设置」**：紧挨头像右侧，打开设置弹窗。只放**需要用户决策且没有其它入口**的项：
  - 播放：最高视频清晰度 / 最高音质（自动播放遵守的上限）、记住播放进度、声音输出设备变化时暂停、
    **全屏自动锁定**（默认关：进全屏时自动收起界面）
  - 界面：主题色 / 字体颜色（都是「16 进制输入框 + 取色盘」）、透明度、模糊强度、阴影强度
  - 通用：启动进入壁纸模式、关闭窗口时最小化到托盘、任务栏显示播放进度、搜索缓存清理、恢复默认设置
  - 「记住播放进度」是原来的「自动续播」+「恢复播放进度」合并来的（只用一个 key
    `player.resumeOnStart`，旧 key 已删）：实际用起来没人会只开一个 —— 回到那首歌却不回进度，
    或者反过来，都没有意义。
- **右上「关于」**：紧跟设置右边（图标 `icon-guanyu`），打开关于弹窗：
  仓库地址 <https://github.com/liaoran2002/BiLiMusicVideo>（点击用系统浏览器打开）、
  一句话介绍、以及作者与大肥鱼（DeepSeek）的头像。
  头像都是静态资源：`src/assets/avatar.jpg` 和 `src/assets/avatar-fish.jpg` —— **换文件即换头像**。

> 打开外链走的是 `app:openExternal` 这个 IPC，主进程只放行 `http` / `https`，
> `file:` / `javascript:` 一律拒绝并打日志。渲染进程能发起的「外部动作」就这一个口子，
> 所以校验必须留在主进程，不能只在界面上做。

设置界面的两条约定：

- **只写名字 + 控件 + 当前值**。不要在界面里写「实际哪一档由平台按登录态决定」「循环模式请去控制栏调」
  这类话 —— 那是给写代码的人理思路用的，用户不需要知道。当前值必须**常显**（滑块右边一个数字，
  别只靠悬停 tooltip 才看得到）。
- **不在设置里重复出现的项**（避免两处状态打架）：

| 项 | 在哪里改 |
| --- | --- |
| 循环模式、音量 | 底部播放控制栏，改完自动记录、下次启动自动恢复 |
| 歌单同步策略 | 每个歌单自己的「新建 / 编辑」弹窗里（手动 / 启动时 / 定时 + 间隔） |

歌曲 / 视频列表这两个弹窗的头部有「刷新」与「加号」、行尾有收藏爱心，
详见 [视频列表：刷新 / 收藏 / 添加视频](#视频列表刷新--收藏--添加视频踩坑记录)。

**弹窗的关闭方式**（设置 / 歌单管理 / 歌曲·视频列表 / 添加视频 / 关于**五个**都一样）：
不要右上角的叉号（`show-close=false`），点弹窗外面的空白处关闭。
提示「点击空白位置关闭」写在**遮罩**上、弹窗下面 —— 用 `.el-overlay-dialog::after`
（在 App.vue 的全局样式里），一处生效**五个**弹窗都有；字大加粗，
`pointer-events: none` 所以点它等于点遮罩、照样能关。
Element Plus 的 `close-on-click-modal` 要求 mousedown/mouseup 都落在遮罩上，
所以**拖滑块时把鼠标甩到弹窗外再松手不会误关**。

歌曲 / 视频列表（`SongVideoListDialog.vue`）也从「自己写的 fixed 浮层 + 遮罩」换成了 `el-dialog`：
外框（底色 / 圆角 / 模糊 / 白字 + 阴影）复用全局 `.el-dialog` 样式，组件里只管列表内容。

歌单同步策略挂在歌单上而不是全局，是为了避免「明明给歌单设了自动同步，却被全局开关关掉」这种困惑。
应用启动时会按各歌单自己的策略同步；定时同步按所有定时歌单里**最小的间隔做心跳**，每次心跳只同步真正到点的歌单，所以各歌单周期可以不同而只需一个定时器。

> **一次性升级（老用户能看到的行为变化）**：同步策略原有一半由全局设置
> `playlist.syncOnStartup` 控制，改成「完全由每个歌单自己决定」时，那些「有分享链接但还是手动同步」
> 的歌单会被自动改成「启动同步」（否则它们会突然完全不再自动同步）。
> 这一步**只在从更老的数据版本升上来时执行一次**（当时用 `playlists.json` 里的 `version` 做闸门）——
> 不然你每次启动手动设的「手动同步」都会被无声推翻，还会顺手联网同步覆盖曲目。
>
> ⚠️ 改用 SQLite 之后这个闸门随 `playlists.json` 一起废弃了（且**不做迁移**），
> 所以这个一次性升级现在**不会**再执行。见「数据存储（SQLite）」。

底部的播放控制栏（播放、进度、音量、循环模式）由 `VideoControls` 负责，鼠标移上去才显现。
音量按钮悬停时会弹出竖向音量条，**此时滚轮可调音量**（上滚 +5、下滚 −5）—— 滚轮监听挂在 `.audio-control` 上，判据就是「音量条显示着」，不用另外判断（那个 `.audio-control:hover` 同时决定条子显示和滚轮生效）。
信息区两行：上行是 B 站视频标题，下行是 `歌曲名 - 歌手 · 专辑`，
**行尾是清晰度和音质两个角标，点开即可切换**。

**两个角按钮 + 界面锁定**：

```
┌───────────────────────────────┐
│ 标题栏（锁定/壁纸模式下隐藏）    │
│                               │
│            画面                │
│                               │
│ []                    [⛶]   │  ← 左下=锁定（S）  右下=全屏（F）
└───────────────────────────────┘
```

- 两个角按钮共用 `.corner-btn` 外观（毛玻璃令牌 + 平时 `opacity: .2`、悬停到 1），
  只是 `left: 16px` / `right: 16px`。图标字体里没有锁，**用内联 SVG**（开锁/闭锁两种画法）。
- **锁定 = 复用 `.wm-hidden`**：给标题栏和 `<VideoControls>` 加同一个 `display: none !important`
  的类（壁纸模式也是这套），组件不卸载、内部状态（音量拖动等）不丢。
- 踩过的坑：

| 坑 | 现象 | 怎么修 |
| --- | --- | --- |
| **两个角按钮不能一起藏** | 锁定后界面上什么都没有，唯一的解锁入口也没了 | 隐藏类只加在标题栏和控制栏上；`.lock-btn` / `.fullscreen-btn` 永远不隐藏（锁定态给锁定按钮 `opacity: .75`，否则半透明太淡找不到） |
| **`S` 会被当成打字** | 在搜索框/设置输入框里打 `s` 就把界面锁了 | `handleKeydown` 里先挡 `INPUT` / `TEXTAREA`；`KeyS` 再额外挡「有弹窗开着」（弹窗是模态遮罩，锁了会在弹窗背后藏界面，而且那时锁定按钮本来也点不到） |
| **退出全屏把手动锁也解开** | 用户自己按 S 锁的，退出全屏后被自动解开 | 只有「因全屏而自动锁」的那次才跟着解开：`_lockedByFullscreen` 记着来源，手工解锁时清掉这个标记 |
| **锁定提示没人看见** | 锁完屏幕一片干净，用户不知道发生了什么、也不知道怎么回去 | 锁定/解锁都用 `$message.info` 弹一条，文案照全屏那条的结构：「已锁定,按S键或点左下角按钮可以解锁」 |

`player.lockOnFullscreen`（设置 → 播放 → 「全屏自动锁定」）默认 `false`，
渲染层监听 `isFullscreen`：进全屏时按设置锁上、退出时（且确实是自动锁的那次）解开。

控制栏那几个图标按钮的尺寸约定：**高度固定 `10vh`，字形 `7vh`** ——
想调大小只改 `font-size`，别动 `height`。这里必须同时写 `display: inline-flex`：
`sound` 那个图标在 `.audio-control`（inline-block）里面，行内元素的 `height` 不生效，
盒子高度会跟着字号一起缩，点击区域就比别的按钮小一圈。

### 图标（iconfont）

标题栏 / 控制栏 / 全屏按钮的图标统一走 `src/assets/iconfont`（iconfont 导出的
`iconfont.css` + 字体文件），模板里不再各写一份内联 `<svg>`：

| 位置 | 类名 |
| --- | --- |
| 控制栏 · 歌曲列表（播放队列） | `icon-bofangduilie`，面板打开时换 `icon-cuowu` |
| 控制栏 · 视频列表（播放列表） | `icon-bofangliebiao`，面板打开时换 `icon-cuowu` |
| 控制栏 · 上一首 / 下一首 | `icon-1_music83` / `icon-1_music82` |
| 控制栏 · 播放 / 暂停 | `icon-play` / `icon-pause` |
| 控制栏 · 音量 | `icon-sound-on` / `icon-sound-off` |
| 控制栏 · 循环模式 | `icon-danquxunhuan` / `icon-suijibofang` / `icon-liebiaoxunhuan` |
| 标题栏 | `icon-shezhi` / `icon-zuixiaohua` / `icon-chuangti-zuidahua` / `icon-xiangxiahuanyuan` / `icon-guanbi` |
| 全屏按钮 | `icon-full-screen` / `icon-suoxiao` |

换图标**只改类名**：字体里没有的旧类名（`icon-yinleliebiao`、`icon-play-previous`、
`icon-play-next`、`icon-ziyuanldpi`）留在模板里就是一个空白按钮。
（仓库里**没有**自动化检查脚本，这类问题靠人工看界面；真要做就自己写一个临时脚本去 grep 类名。）

### 界面颜色与毛玻璃（CSS 令牌）

配色不写在组件里，也不再用「黑白主题」两套写死的颜色 —— 全部由设置里的两个取色器决定，
`src/utils/uiTheme.ts` 的 `applyUiTheme()` 把它们写成 HTML 根节点上的变量：

| 设置项 | 界面 | 作用 |
| --- | --- | --- |
| 主题色 | `#RRGGBB` 输入框 + 取色盘 | 玻璃 / 面板的**底色**（默认 `#000000`） |
| 字体颜色 | 同上 | 浮层上的**文字颜色**（默认 `#ffffff`） |

落到 CSS 的是「通道 + alpha」，这样 CSS 里能用同一个底色拼出各种透明度：

```css
--glass-rgb: 255, 255, 255;   /* 主题色，uiTheme 写入 */
--text-rgb: 255, 255, 255;    /* 字体颜色，uiTheme 写入 */
--glass-alpha: 0.3;           /* 「透明度」设置，uiTheme 写入（存百分比，除 100） */
--ui-idle-opacity: 0.1;       /* 「控制栏闲置透明度」设置，uiTheme 写入（同样除 100） */
--glass-bg: rgba(var(--glass-rgb), var(--glass-alpha));
--panel-bg: rgba(var(--glass-rgb), var(--glass-alpha));
--glass-text: rgb(var(--text-rgb));
--panel-hover: rgba(var(--text-rgb), 0.16);   /* 各种 hover/边框都由文字色派生 */
```

| 变量族 | 用在哪 |
| --- | --- |
| `--glass-*` | **浮在视频上**的毛玻璃：控制栏、左上角歌单入口按钮、标题栏、全屏按钮 |
| `--panel-*` | **面板**：歌单下拉、设置 / 歌单管理 / 关于弹窗、歌曲/视频列表 |

#### 分隔线有两级粗细

设置页里横线很多，全用同一个值会显得"一屏全是线、看不出层级"。所以分两级：

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--panel-divider` | `rgba(text, 0.18)` | **设置项之间**（`.st-row`），2px —— 表示"不同的设置" |
| `--panel-divider-fine` | `rgba(text, 0.09)` | **同一块里的细分**：滑块行（透明度/闲置透明度/模糊/阴影）、关键词加权标题下方、各分值档之间，1px |

层次是「分组 > 分项 > 子项」。滑块那四行虽然也是独立的设置项，但它们**是一组同类参数**、
行高又矮，所以用 fine 让它们看起来是"一组"而不是四个独立项。

#### 分值档的交互（`SettingsDialog.vue`）

```
第一行： [+] [ 分值 ] [−] …………  删除分值档      ← 加号在左、减号在右，删除推最右
第二行： 「关键词」 「标签」 [+]                     ← 标签多了自动换行
```

- **分值是 `el-input-number`（`:controls="false"`）**，可直接打字 —— 要 `-50` 不用按 30 次减号。
- **两个入口共用「换键」逻辑**：`shiftTagBonusScore(score, ±1)` 增减、
  `applyTagBonusScore(score, value)` 直接设值 —— 内部都是把键 `"5"` 换成 `"6"`，
  **关键词跟着搬过去**（`player.tagBonus` 的**键就是分值**）。
- **删除要二次确认**：点「删除分值档」后原地换成「确认删除？」+「确认」(红) /「取消」(蓝)，
  待确认的分值记在 `deletingScore`。理由：一档可能配了很多关键词，误点一次就全没了。
- **提示文字不设颜色**（跟面板文字走）；只有两个按钮用实心色
  （`type="danger"` / `type="primary"`）—— 文字型按钮的彩色字在玻璃底上常常看不清。

**深浅是算出来的，不是选的**：`uiTheme` 按主题色的亮度决定给 `html` 加什么属性 ——

| 底色亮度 | `data-tint` | 文字阴影 | Element Plus |
| --- | --- | --- | --- |
| 偏亮（≥ 0.5） | `light` | 黑阴影（白底白字看得清） | 亮色 |
| 偏暗（< 0.5） | `dark` | 白阴影（黑底白字看得清） | 暗色（`html.dark`） |

这样用户把主题色拖到任意颜色，都不会出现「白底白字看不出字」；
文字颜色是用户自己选的，阴影只跟**底色**走，所以「浅底配黑阴影、深底配白阴影」这一条永远成立。

**几个毛玻璃 / 阴影参数也是全局的**：

| 设置项 | 界面 | 存的值 | 落到 CSS |
| --- | --- | --- | --- |
| 透明度 | 0-100%，步进 5 | 百分比本身 | `--glass-alpha = 透明度 / 100`（就是底色里的 alpha） |
| 控制栏闲置透明度 | 0-100%，**步进 10** | 百分比本身 | `--ui-idle-opacity = 闲置 / 100`（`opacity` 收小数） |
| 模糊强度 | 0-100%，步进 5 | **0-20 的 px**（百分比 ÷ 5） | `--glass-blur: Npx`，即 `backdrop-filter: blur(Npx)` |
| 阴影强度 | 0-100%，步进 5 | **0-20 的 px**（百分比 ÷ 5） | `--glass-shadow-size: Npx`，文字阴影的模糊半径 |

后两个都是「显示百分比、实际 0-20」：50% = 10px，100% = 20px（阴影默认 8px = 40%）。
**闲置透明度的步进是 10**（不是 5）—— 它只有「淡出到多明显」这一个含义，10% 一档够用，
而且**整十的数字更好记**。
`--glass-shadow` 用 `calc()` 从 `--glass-shadow-size` 派生出「近影 + 远影」两段：

```css
--glass-shadow:
  0 1px calc(var(--glass-shadow-size) * 0.5) rgba(0, 0, 0, 0.9),
  0 0 var(--glass-shadow-size) rgba(0, 0, 0, 0.5);
```

注意阴影强度只管**文字阴影**（压在视频上的字靠它看清），不是弹窗的投影
（`--panel-shadow` 固定）。

`--glass-bg-strong`（悬停 / 展开态）的 alpha 是常态 +0.12，所以这些设置管着
控制栏、歌单按钮、歌单下拉、四个弹窗和歌曲列表。

**字体颜色要铺满**：所有压在视频/玻璃上的字都得用 `--glass-text` / `--panel-text`
（以及它们的 dim 版本），不能写死 `#fff` / `rgba(255,255,255,…)` ——
控制栏的副标题（歌曲名 - 歌手 · 专辑）、清晰度/音质角标、进度条与音量条、
封面的兜底图标、弹窗外的「点击空白位置关闭」提示，统统跟着设置走。
角标的底色 / 边框用 `rgba(var(--text-rgb), 0.22)` 这样从文字色派生，换个颜色整体就协调了。

别把「玻璃底的透明度」和「整个控件的淡出」混成一个设置：

| | 是什么 | 谁控制 |
| --- | --- | --- |
| 透明度 | 玻璃**底色**有多透（文字始终清晰） | 设置项 `common.glassTransparency` → `--glass-alpha` |
| 闲置透明度 | 鼠标**不悬停**时整个控件（含文字）淡到多透明；移上去变 1 | 设置项 `common.idleOpacity` → `--ui-idle-opacity`（**0-100%，五步一进**） |

> 这两项**曾经**是「一个可调、一个写死」的：`--ui-idle-opacity` 原来硬编码 `0.1`
> （注释还写着"固定行为"），后来按用户要求开放成设置项 `common.idleOpacity`，
> 默认仍是 `10`（= 原来的 `0.1`），所以老用户观感不变。
>
> 存的是**百分比**，写进 CSS 时除 100（`opacity` 收小数）；悬停时 CSS 直接写死
> `opacity: 1`（见 `VideoControls.vue`），所以这个设置只管闲置态。

唯一不受淡出影响的是**左上角歌单按钮**：它常显（`opacity: 1`），悬停只让玻璃底实一点，
不做透明度变化 —— 那个位置忽明忽暗很烦人。

> 踩坑一：`--panel-*` 的面板里绝不能引用 `--glass-*` 的实底变量。歌单下拉曾经写成
> `background: var(--glass-panel-solid)`，而这个变量**从来没定义过** —— `var()` 解析失败会让
> 整条声明失效（不是回退到默认色，是直接没有），于是面板既没底色也没阴影，
> 浅色主题下白字浮在视频上基本看不清。面板内部本来就是 `--panel-text` / `--panel-hover`，
> 容器也必须是同一族。
>
> 踩坑二：滑块的值别只靠 Element Plus 的悬停 tooltip。用户要的是**一直看得见**，
> 所以 `SettingsDialog` 里用 `.st-slider-box` 把滑块和一个等宽数字（`.st-value`）并排，
> 拖动时数字跟着变。

### 窗口宽高比（设置项，踩坑记录）

**结论：比例存成一个字符串**（`'16:9'` / `'4:3'` / `'21:9'` / `'free'`），
由 `parseAspectRatio()` 解析成数值喂给 `setAspectRatio()`。

设置里有三项固定预设，加上**用户自己输入过的比例**：

| 下拉项 | 含义 |
| --- | --- |
| `16:9（默认）` | 锁 16:9（= 改造前的写死行为） |
| `4:3` | 锁 4:3 |
| `不限制` | 不锁比例（`parseAspectRatio` 返回 `0` → `setAspectRatio(0)`） |
| 用户输入（如 `21:9`） | `allow-create` 放进来的，**加进列表并持久化**到 `common.customAspectRatios` |

**解析函数必须主进程和渲染层共用**（放在 `@common/constants`）：
两边各写一份迟早会不一致（界面显示「已锁定」而主进程其实没锁）。
非法值一律返回 `0`（当作不限制），并有 15 条用例的实测覆盖：
`abc` / `16/9` / `16:` / `:9` / `0:9` / `16:0` / `-16:9` / 空串 / `null` 全部安全回落。

**踩坑一：`setAspectRatio` 绝不能写死。**
原来是一个模块级常量 `FULLSCREEN_ASPECT = 16/9`，散在**三处**：
建窗口、退出全屏、退出壁纸。只改建窗口那处的话，
用户选了 4:3，一退出全屏就被**悄悄改回 16:9**。现在三处统一走 `applyAspectRatio()`（读设置）。

> 历史上还有第四处「从全屏拖出窗口」—— 那条路径已经去掉：
> 全屏下拖动不再退出全屏（见下面全屏那节）。

**踩坑二：只给 `width` 不给 `height`，宽度会被覆盖（实测）。**
`setAspectRatio` 会**按高度反推宽度**。不给高度时 Electron 用默认 600，
于是你指定的 1138 变成了 1069 —— 「按屏幕宽 0.8」直接失效。**所以高必须自己算。**

**踩坑三：只按宽度算高，会让窗口高过屏幕（实测）。**
在 1423×771 的可用区域上量出来：

| 比例 | 只按宽算 | 问题 |
| --- | --- | --- |
| 16:9 | 1138×640 | ok |
| **4:3** | 1138×**854** | ⚠️ 已经超出 771 |
| **9:16** | 1138×**2023** | ⚠️ 屏幕高的 2.6 倍 |
| 21:9 | 1138×488 | ok |

**4:3 是内置预设就会超标**，不是极端情况。所以两条边都按可用区域的 0.8 封顶，
超了**等比缩回来**（比例不能动，否则和 `setAspectRatio` 打架）。修完实测：

```
16:9  1097x617  ✅不超屏 ✅比例对
4:3    823x617  ✅不超屏 ✅比例对
9:16   347x617  ✅不超屏 ✅比例对
21:9  1138x488  ✅不超屏 ✅比例对
free  1097x617  ✅不超屏 ✅比例对
```

**踩坑四：数组型设置项在 `resetSetting` 里必须深拷贝。**
`{...defaultSetting}` 只做浅拷贝，数组/对象成员和模块级的 `defaultSetting`
是**同一个引用**（`player.tagBonus` 早就因此显式深拷贝过）。
新加的 `common.customAspectRatios` 也是数组 —— 漏了的话，用户往下拉列表加比例
会把默认值一起改脏，表现是**「恢复默认设置」之后自定义比例还在**。

**和壁纸 / 全屏的关系**：这两种状态要铺满屏幕，都由 `applyFullScreenGeometry()`
里的 `setAspectRatio(0)` 临时解除约束；退出时再 `applyAspectRatio()` 按设置恢复。
所以「全屏 → 壁纸 → 窗口模式」回来时，比例还是用户选的那个。
运行中改设置也会**立刻生效**（`onSettingChange` 里判断 key），
但在全屏 / 壁纸状态下**故意不动** —— 那会跟 `setBounds` 铺满的逻辑打架。

### 清晰度 / 音质切换

这两处**不是一回事**，别把它们做成同一份数据：

| 在哪 | 作用 | 选项从哪来 | 是否持久 |
| --- | --- | --- | --- |
| 设置 → 播放 | **自动播放时遵守的上限**（"最多播到哪一档"） | **完整档位表**（12 档清晰度 / 3 档音质） | 是（`setting.json`） |
| 控制栏角标菜单 | 针对**当前这一首**临时切换 | **playurl 响应里真正能拿到的档位** | 否，换歌即失效（`onEngineSwitch()` 里清掉 `selectedQn` / `selectedAudioId`，下一条回到设置里的上限） |

所以设置页就该铺全表 —— 它是「你愿意播到多高」，和音量 / 循环模式那种「当前值」性质不同；
能不能拿到是平台按登录态 / 会员等级 / 视频可用档位决定的事，不该拿它来限制你选什么。
而角标菜单列的是「这个视频此刻能选什么」，自然只列 playurl 给得出的，
并且**不受上限约束**（手动切换是用户明确要求，设了上限也照样能选上去）。

上限具体生效在两处：`pickDashVideo` 挑「不超过上限里最高的一条」，
`pickDashAudio` 优先 id 精确匹配、否则挑带宽不超过它且最大的那条
（所以选了 64K 不会因为响应里没有 30216 就悄悄给成 192K）。

菜单里档位的取值：
1. 用 `dash.video[]` / `dash.audio[]` 的 `id` —— 这才是实际能播的流；
2. 展示名一律用 `@common/constants` 的内置档位表。

> **schema v4 之后这里不再读 `accept_quality` 与 `support_formats`**：
> 前者只说明账号**有权限**（实测列出 1080P、durl 通道却只回 720P），
> 而 `dash.video[].id` 更权威 —— **按 id 分 URL，没有 URL 就放不出来**；
> 后者是静态映射，内置表已覆盖全部 12 档，每行存一份纯属冗余，所以两列都删了。
>
> 因此**没有 dash 时这个菜单就是空的**（durl 兜底通道只有一条流、没什么可切）——
> 这是刻意的：宁可菜单空着，也不要列出切不过去的档位。

实现上切换就是**带 `qn` / `audioId` 重新解析一次**（`skipCache: true`），
解析前后把播放进度记到 `seekAfterLoad` 里，切完接着播。

**必须把 `qn` / `audioId` 一路传到 `resolveVideoUrl`**：主进程里算出 `wantQn` / `wantAudioId`
却只喂给「读缓存」那一步、忘了传给真正的解析调用，会让它悄悄用回默认值
（这个坑实际踩过：菜单点了没反应，因为解析始终用默认的 30280）。

### 清晰度角标：数据从哪来（踩坑记录）

角标内容出自 `electron/main/utils/quality.ts`，两条链路取法不同：

| 链路 | 档位从哪来 |
| --- | --- |
| **dash** | 取「地址和实际播放地址一致」的那条流的 `id`（用 `baseUrl === videoUrl` 比对） |
| **durl** | 从 `durl_url` **反推**：`URL 数字 - 128`（见下） |

展示名一律走 `@common/constants` 的内置档位表（`1080P` / `1080P 高清` 这类）。

**durl 档位为什么能从 URL 反推**（schema v4 删掉 `quality` 列的依据）：

```
...-1-192.mp4  ->  quality 64   (64 + 128)
...-1-208.mp4  ->  quality 80   (80 + 128)
```

实测 **24/24 样本成立，且映射唯一**（`quality=64` 只对应 192、`80` 只对应 208）。
所以 v4 去掉了 `videos.quality` 列 —— 从 `durl_url` 反推即可，不丢信息。

> ⚠️ 这是 B 站的 **URL 命名约定，不是契约**：它可能变。所以反推失败时
> `qualityFromDurlUrl()` 返回 `null`（角标空着），**绝不猜一个值** ——
> 宁可没有档位，也不要显示一个错的清晰度。

**不要用请求参数里的 `qn`，但也不要用分辨率硬推。** 实测（`qn` 是请求参数、
`quality` 是响应）：

| 请求 `qn` | 响应 `quality` | `accept_quality` | 实际解码 |
| --- | --- | --- | --- |
| 64 | 64（720P） | `[64, 16]` | 1280×720 |
| 64 | 64（720P） | `[116, 80, 64, 16]` | 1280×720 / 720×1280（竖屏） |
| **120** | **64（720P）** | `[116, 80, 64, 16]` | 1280×720 |

最后一行是关键：请求 4K 也回 720P，说明 `quality` **如实报告平台降级后的实际档位**，不是回显请求参数。
而按分辨率反推会在两种情况下出错 —— 竖屏（720×1280）和裁掉黑边的宽银幕（1280×533、960×720）——
所以分辨率只作为**兜底**（`src/utils/videoQuality.ts`）和悬浮提示里的交叉印证。

> **播放清晰度的天花板在 dash 上，不在 `qn` 上。**
> `fnval: 1`（渐进式 mp4 / durl）通道**无论 `qn` 填多少、无论是否登录，都封顶 720P**；
> 1080P / 4K 只存在于 dash 通道，而 dash 的音视频是**两条独立的流**。
> 实测（同一视频、已登录）：

| 请求 | 响应 `quality` | 拿到的东西 |
| --- | --- | --- |
| `platform=html5` + `fnval=1` + `qn=116` | 64（720P） | durl mp4，1280×720 |
| 去掉 html5 + `fnval=1` + `qn=80` | 64（720P） | durl mp4，1280×720 |
| 去掉 html5 + `fnval=1` + `qn=116` | 64（720P） | durl mp4，1280×720 |
| 去掉 html5 + `fnval=1` + `qn=120` | 64（720P） | durl mp4，1280×720 |
| 去掉 html5 + **`fnval=16`** + `qn=116` | **80（1080P）** | **dash：`80(1920x1080)` + 独立音轨 `30280`** |

所以现在 `resolveVideoUrl` 是 **dash 优先、durl 兜底**：
拿到 dash 双轨就交给渲染层用 MSE 合成；dash 不可用（或渲染层播放失败）才退回 durl 720P。

> **地址要在 `baseUrl` 和 `backupUrl` 里挑「常规 CDN 域」（真踩过）**：
> playurl 给每条流一个 `baseUrl` + 若干 `backupUrl`，而 `baseUrl` 有时指向
> **P2P / 边缘节点**（实测见过 `*.mountaintoys.cn:4483`、`*.szbdyd.com`）——
> 那种地址只对官方客户端有效，普通 HTTP 请求直接 **403**。
> 现象极具迷惑性：**别的视频都能放，只有某一个怎么也放不出来，也不报错**（画面永远 readyState=0、
> 进度停在 99% 的缓冲圈上）。现在 `pickNormalCdnUrl()`（`biliApi.ts`）在
> `baseUrl` + `backupUrl`（durl 则是 `url` + `backup_url`）里**优先挑
> `*.bilivideo.com` / `*.bilivideo.cn` / `*.bilibili.com` / `*.hdslb.com` / `*.akamaized.net`**，
> 都不常规时才退回第一个。缓存里的老地址也走同一套规则（`extractDurl` 复用它），
> 所以不用清缓存，重开就换到正常节点。

平台偶尔会出现「报 720P、帧却是 1920×1080」这类元数据与实际流不一致的情况，
角标按平台档位显示，真实分辨率放在悬浮提示里，不藏着。

### dash + MSE 播放（`src/utils/dashPlayer.ts`）

dash 的视频轨和音频轨是两个 URL，而 `<video>` 一次只能播一个，
所以用 MSE 把两轨塞进同一个 MediaSource 的两个 SourceBuffer 里 ——
对外仍然只有一个媒体元素，进度 / 音量 / 续播 / SMTC 这些现有逻辑一行都不用改。

**默认清晰度**取设置里的 `player.videoQuality`（默认 116 = 1080P 60帧，常量是
`@common/constants` 的 `DEFAULT_VIDEO_QN`；渲染层没传时用它兜底，见 `biliApi.resolveVideoUrl`）。
它只是「尽量达到」的目标：dash 响应一次会回来**所有**档位（实测最高 4K），
由 `pickDashVideo` 挑「不超过它里最高的一条」，并且优先 H.264（`avc1`）——
AV1 / HEVC 在部分机器上 `MediaSource.isTypeSupported` 会返回 false。
不这么挑的话默认会播 `dash.video[0]`，也就是一上来拉满 4K，流量和内存都很夸张。

**内存 / 配额是这里最容易踩的坑**：1080P60 的 4 分钟视频整条流约 150MB，
正好顶到 Chromium 单个 SourceBuffer 的配额，`appendBuffer` 会抛 `QuotaExceededError`；
一旦不处理，之后再也塞不进任何数据、**播放直接卡死**。所以做了两件事：

1. **限流**：只往播放位置前面缓冲 `MAX_AHEAD_S`（30 秒），超了就等播放推进；
2. **裁剪**：配额超限时丢掉播放位置之前的数据（保留 `KEEP_BEHIND_S` 秒供回拖），
   并按 `KEEP_BEHIND_STEPS` 逐级加大丢弃幅度再重试。

> 代价：拖动进度只在**已缓冲的区间**内是瞬时的。往回拖超过保留窗口、
> 或往前拖很远处，都要等数据到达（顺序下载，不是按需分片）。
> 想彻底解决要给 dash 分片做 `sidx` 解析 + Range 请求，目前没做。

**失败兜底**：`DashSession.start()` 只有在**两条流都取完**时才 resolve，
任何一条失败都抛错 —— 只拿到音频是「黑屏有声」，只拿到视频是「哑巴」，
都不如退回 720P 的混流 durl。渲染层收到失败后会重新解析一次（`noDash: true`），
连续失败两次就认为这台机器上 dash 不可用，本会话不再尝试。

> 注意：走 dash 时主进程回的 `videoUrl` 是 `null`（没有额外去要 durl），
> 所以渲染层的兜底**必须重新解析**，不能指望本地有个 durl 地址可以顶上。

### 切歌预热（为什么切歌几乎看不到加载提示）

切歌那一下的卡顿来自两段：**搜索 + 播放地址解析**（缓存未命中时 1~3 秒网络往返）和
**MSE 起播**（要拉到第一个分片才能出画）。所以两个方向都提前做，分两层：

1. **接口层（一直做）**：歌一开始播就去备「上一首 / 下一首」的搜索 + 播放地址，
   结果存进两个槽位（`_warm.next` / `_warm.prev`）。很便宜（几 KB），
   命中之后主进程直接走缓存，切歌就只剩本地换源。
   下标规则与 `next()` / `prev()` **完全一致**（含随机模式那张顺序表），
   保证预热的就是待会儿真正会播的那个。
2. **媒体层（打开头）**：再往后把两首的**开头两秒真的拉起来** —— 隐藏的静音 `<video>`
   复用同一个 `DashSession`。这样 DNS / TLS / HTTP2 连接是热的，能进 HTTP 缓存的分片也在本地。

几个刻意的取舍：

- **不调用 `play()`**：会占用系统媒体控件（SMTC 面板可能被隐藏元素顶掉），
  而 MSE 的分片本来就是 JS 灌进去的，`start()` 自己会拉数据，不需要真的播。
- 只拉 **2 秒**就停（元素留着复用），绝不把整条片子下下来。
- 自己这边缓冲不够（`bufferSeconds < 5`）时不做媒体预热；
  **一旦出现 `waiting` / `stalled`，立刻停掉两个方向的预热流** ——
  预热是「为了更顺」，不能反过来把当前播放挤卡。
- 曲目变化（换歌单 / 同步出新列表）会让槽位按下标失效，所以直接全部作废重来。

效果（本地实测，连点四下）：出画 **432 / 873 / 459 / 327 ms**，四次都没有出现加载提示。

### 缓冲提示（为什么必须有）

换源（切歌 / 切清晰度 / 回退 durl）时 MSE 要重新拉流，**这段本来什么反馈都没有**，
看着和「卡死」完全一样 —— 用户第一反应就是「是不是坏了 / 电脑的问题」。
所以加了一个居中的缓冲提示：圆环进度 + 百分比 + 阶段说明。

百分比的含义是**「离能播还差多少」**，不是「整条视频下载了多少」：

```ts
need = min(duration, max(currentTime + LEAD_S, START_BUFFER_S))  // 需要缓冲到第几秒
percent = lastBufferedEnd / need
```

- 分子取**最后一段缓冲的末尾**，而不是「播放点所在那一段」：
  切歌 / 续播时播放点常常落在已缓冲区间之外（比如定位到 12.7 秒、只下到 5 秒），
  这时要按「正朝播放点下载」来算，否则会一直显示 0%；
- 分母用「播放点 + 余量」而不是「整条视频时长」：后者在限流之后会长时间停在很小的
  数字上，看着更像卡死；
- 但分母**必须再夹一次 `duration`**（踩坑，见下）。

**踩坑：播到还剩一秒会弹一个 98% 的圈不动。**
分母原来是 `max(播放点 + 3, 5)`，越接近片尾这个数越大（`duration - 1 + 3`），
而缓冲末尾最多只能到 `duration` —— 播放器不可能缓冲到片子后面。于是比例永远差一点点：

```
need = 311 - 1 + 3 = 313      lastBufferedEnd = 311      311 / 313 = 98%
```

夹到 `duration` 之后片尾的比例就是真实的下载进度（缓冲到底即 100%）。
同时「够播了」的判定也要放宽：正常播放要求留 ≥1 秒余量，
但**已经缓冲到片尾**时不存在「余量」这回事，这时只要解码器就绪、还剩一点数据就撤提示。

**另一半：MSE 偶尔不触发 `ended`。** 缓冲已经到底、画面也播到最后一秒，
`ended` 就是不来的话，自动下一首永远不会发生 —— 表现同样是「卡在片尾 + 一个不动的圈」。
所以加了一个片尾看门狗（每秒检查一次），判定条件卡得很死，避免把「尾巴还在下载」误判成播完：

- 已进入最后 2 秒，且缓冲末尾真的到了片尾；
- 没有暂停、没有在 seek；
- 播放位置连续一段时间没有前进：`readyState >= 3` 时等 3 秒（还有后手数据，说明只是慢），
  `readyState <= 2`（等着数据但没来）多给一点，等 5 秒。

命中就按「播完了」处理（单曲循环重播，其余模式下一首）。

副标题分三段说明状态，避免「0% 不动」和「99% 卡住」被当成故障：
`正在获取视频流…`（还没拿到数据）→ `已缓冲 N 秒` → `即将开始播放…`（数据够了、解码器还没就绪）。

显示时机只由 `<video>` 自己的信号决定（`waiting` / `stalled` / `seeking` / 换源），
**不用 `readyState` 主动点亮**，否则正常播放时也会闪一下；隐藏则由「够播了」判定。
数字每 250ms 刷新一次 —— `progress` 事件在 MSE 下不一定持续触发，
只靠事件会让百分比停住。

实测（往前跳到接近片尾，顺序下载要追很久）：

```
32 → 51 → 77 → 91 → 92 → 93 → 94 → 95 → 96 → 97 → 98 → 播放
```

（这是「尾巴还在下载」时的正常爬升；下载完了比例会直接到 100%，不会再停在使用 98%）

### 登录态（踩坑记录）

**结论：登录态以 nav 接口的 `isLogin` 字段为唯一权威；cookie 存在只当触发器，不当结论。**

**失败 ≠ 没登录**（后来补的一条）：`getUserInfo()` 现在把两种情况分开抛 ——
nav 明确回 `isLogin: false` 才抛 `未登录`；nav 请求本身失败（网络抖动 / 风控）抛 `NAV_FAILED`。
以前两种情况都抛「未登录」，渲染层就一律把界面切成未登录：托盘菜单显示「登录」、
解析视频按未登录档位取流并把 `loginState: false` 写进缓存，
于是明明登录着却「每次都要重新解析」。现在渲染层收到 `NAV_FAILED` 会保持原状态。
另外 `syncTrayState` 会把渲染层认定的登录态一起带给主进程，避免两边漂移。

原来「登录之后要重启一次才生效」，根因有三个叠在一起：

1. **登录成功只靠 `did-navigate` 判断**。B 站登录可能走 SPA 内部跳转，
   用户也可能登录完直接手动关窗 —— 这两条路都不触发导航事件，
   于是「登录成功」没人告诉主进程。
   现在改成 **cookie 变化当触发器 + 接口裁定**：
   - 打开登录窗口时先记下当前 SESSDATA 的值；
   - 登录窗口存活期间每秒轮询一次，`closed` 时再查一次；
   - 只有 SESSDATA **变了**（避免把本来就有的过期 cookie 当成登录成功）才清 nav 缓存、
     问一次 `isLogin`，以接口为准。

2. **nav / wbi / 用户信息缓存没有失效**。`cachedUserInfo`、`cachedMixinKey` 是启动时
   （多半是未登录）取的，登录后没人清，`isLoggedIn()` 一直是 `false`。
   现在登录成功的收尾里显式 `biliApi.clearNavData()`。

3. **判断缓存能不能用时读的是过期状态**。`resolveVideo` 里原来直接 `biliApi.isLoggedIn()`，
   拿到的是启动时那份陈旧结论。现在换成 `await biliApi.ensureLoginState()`：
   登录态未知或超过 60 秒就重新拉一次 nav（`electron/main/biliApi.ts`）。

`loginState` 用 `null` 表示「还不知道」，和 `false` 区分开 —— 拿不准时必须问接口，
不能沿用旧结论，否则登录完那一刻的判断一定是错的。

### 缓存里的播放地址什么时候该重新解析

`resolveVideo` 现在有三个独立的失效条件，命中任意一个就重新解析：

| 条件 | 判据 |
| --- | --- |
| 缓存数据不完整 | 这一行**没有解析过的地址**（`playurl` 为空，即 `durl_url` 和 `dash_video` 都为空） |
| **地址过期** | `isUrlUsable()`：直链带签名时效（`deadline`），提前 5 分钟算过期 |
| **登录态变了** | `playurl_login_state` **明确是 `0`**（当时确实未登录）+ 现在已登录 → 这地址是低清晰度时期取的，必须重取 |
| **想要 dash 但缓存里没有** | `dash_tried` 还是假 + 没有 dash 流 → 重取一次试试高清；试过之后写 `dash_tried = 1`，之后不再反复试 |

**「地址过期」有多常见**：直链签名寿命**实测中位正好 120 分钟**（最大也是 120，
即同一批地址都是 2 小时），而搜索缓存默认保留 3 天。真实缓存统计过一次：
296 条地址里 **272 条（92%）已过期** —— 所以「隔一阵再听」基本上必然碰到，
每首歌**本次运行内第一次**用到时重解析一次。这是平台签名机制，不是故障；
不重解析反而会拿死链去播、报「视频加载失败，已跳过」。

> 这条日志**每次过期都会打印**（一行短句，原因写在代码注释里）—— 属于预期内现象，
> 不做闸门、也不逐条解释：那样反而要在日志里维护一套「说没说过」的状态。

### 播放停滞看门狗（「打开就卡在 99%」的真正原因）

用户反馈：**偶尔一打开就显示 99% 的缓冲圈卡住，点一下下一首就好了**，
而且**时长那里是 `0:00`** —— 最后这条信息才是关键。

现场还原：MSE 已经有分片进来了（所以 `buffered.end()` 有值，进度能算到 99%），
但整条的 `duration` 一直没确定、`readyState` 也上不去。于是：

- `syncBufferState` 的隐藏条件是 `readyState >= 3` 且余量够 1 秒 —— 永远不满足，圈一直挂着；
- 百分比的分母是「播放点 + 余量」，没下完就不会到 100，所以显示停在 **99%**；
- 时长那一栏因为 `duration` 为 0/NaN，显示 **0:00**。

原来没有任何兜底：`checkEndOfStream` 只管「播到片尾不动」，而这里连时长都没有，
所以只能靠用户手动点下一首重建整条管线。

现在 `checkPlaybackStall()`（挂在同一个 1 秒心跳上，`STALL_MS = 8s`）：

| 判据 | 说明 |
| --- | --- |
| 有源（`currentSrc` 非空） | 起播前本来就该等，不算停滞 |
| 没暂停、没在 seek | 这些情况下不动是正常的 |
| **允许 `duration === 0`** | 这正是要救的场景（原来写的是「没时长就直接返回」，等于把它排除在外） |
| 不在最后 2 秒 | 片尾交给 `checkEndOfStream`，别两边同时动手 |
| 位置连续 **8 秒**没前进 | `_lastProgressAt` 由 `timeupdate` 维护，留 2 秒宽限 |

> 8 秒是用户定的（原来是 12 秒）—— 卡了 12 秒人已经想点下一首了。

### 卡顿恢复链（换源 → 降档 → durl → 提示）

命中停滞阈值后**不再是「重解析 / 跳歌」两下**，而是一条**分级链**，
由一个计数器（`_stallUrlIndex` / `_stallQualityDrops`）推进：

```
命中 8 秒
  ↓ ① 换同一清晰度的**备用源**
  ↓ ② 备用源都用完 → 降一档清晰度（回到 ①）
  ↓ ③ 降了 3 档还卡 → 降 durl（720P 混流）
  ↓ ④ durl 还卡 → 暂停 + notify「请检查网络状况」
```

**关键设计**：

- **① 换源能成立，靠的是 `dashUrlsOf()`**。B 站每条 dash 流除了 `baseUrl` 还有多个
  `backupUrl`（不同 CDN 节点）。**原来的实现只挑一个地址**给渲染层，备用源全丢了 ——
  于是卡顿时只能干等到降 durl。现在 `DashStreams` 带上 `videoUrls[]` / `audioUrls[]` 全量列表
  （去重 + 常规 CDN 优先），渲染层换 URL 而不重建会话。
- **开关只管「降清晰度」那一步**（`player.autoDowngradeOnStall`，默认关）。
  「换源」和「降 durl」**无条件自动做** —— 它们不损失清晰度体验，没必要问用户；
  而画面变糊是降级，应该让用户决定：开着就自动降并提示，关着就只提示「建议降到 XXX」。
- **关掉时「不一级级降」**：备用源试完直接跳 durl。既然用户选了保住清晰度，
  就别拿一串中间档位烦他。
- **提示文案不能自相矛盾**：降到 durl 时如果**当前本来就不是 720P**，说
  「已切换到 720P 混流，可以试试 XXX」；如果**当前就是 720P 或更低**，只说
  「已切换到 720P 混流」—— 不能出现「已切换到 720P，可以切换到 720P 试试」这种废话。
- **计数器归零的时机：只在「换了一条新的条目」时** ——
  `onEngineSwitch()`（引擎决定换条，在发请求之前）、`clearNowPlaying`（没有在播的东西了）。
  **不在 `onEngineStream()` 里归零** —— 它是「解析完成、马上挂源」的回调，
  换源 / 降 durl / 换清晰度**也会走这里**，在那里归零会让链条永远停在第一个备用源上打转。
  （`_stallGivenUp` 是例外：它就该在每次换源时复位，见下面那条。）
- **⚠️ 切条时必须在 `onEngineSwitch` 里归零**（这里踩过）：
  原来只在 `onVideoLoaded` 复位，于是有个盲区 ——
  新歌若在 `loadeddata` **之前**就卡住（`checkPlaybackStall` 的 `neverStarted`
  分支正是为这个场景写的），那次复位永远不会发生。带着上一首的旧计数执行恢复链：

  ```
  _stallUrlIndex=1     → 直接跳到第 3 个备用源，跳过本首歌自己的第 2 个候选
  _stallQualityDrops=3 → 已到 MAX_QUALITY_DROPS，自动降清晰度对本首**永不生效**
  ```

  表现就是「第二首新歌莫名比第一首差很多」。
- **⚠️ 那条常驻通知同时只允许有一条**（这里踩过）：
  步骤 ④ 用的是 `$notify({ duration: 0 })`（不自动消失，要手动关）。而
  `_stallGivenUp` 会在**每次换源**时被复位（`onEngineStream`）—— 于是用户
  手动切个清晰度、或再 fallback 一次之后，8 秒又能弹一条**同样的**常驻通知，
  旧的那条还挂在右上角 → **通知叠加**（原意图「单曲歌单反复停滞时别再周期性告警」
  只对「同一源」成立）。现在用一个 `_stallNoticeOpen` 标记：还开着就不新弹，
  用户在 `onClose` 里把标记清掉 —— 「同时最多一条」成了硬保证，不再依赖
  复位时机。

实测（断网黑洞地址模拟「有源但永远不来数据」）：正常播放 20 秒无误报；
`duration=0 readyState=0` 的卡死现场 8 秒命中，按链推进。

最后一条是 `/api/resolveVideo` 里新加的：登录能解锁更高档位（实测同一视频
匿名 `accept_quality=[64,16]`，登录后 `[116,80,64,16]`），不重取的话
登录完还得等切歌（甚至重启）才生效。另外渲染层在登录成功后会主动
用 `skipCache` 重取**当前正在播**的那个视频（`onLoggedIn`），并保留播放进度。

这几条都是靠缓存里的两个标记工作的，各有各的坑：

- **`playurl_login_state` 只在「明确为 0」时才算过期**。`ensureLoginState()` 返回
  `boolean | null`（`null` = 这次 nav 没问到），写库时 `null` 就**不覆盖已有值** ——
  以前把「没问到」写成「未登录」，于是每次解析都判定
  「未登录时取的，现已登录」，白重取一遍（用户看到的日志是
  `缓存的地址是未登录时取的，现已登录，重新解析`，而且他并没有退出过登录）。
- **`dash_tried` 决定要不要「升级到 dash」**，所以它必须真的落盘：
  `(!noDash || 旧值) ? 1 : 0`（durl 兜底那次不算「试过」，但**也不会把已记的 1 清回 0**）。
  判断「要不要升级」时还要求**缓存里确实有播放数据**（`hasValidData`），
  否则某首歌的首次解析也会走这条分支并打日志，
  看起来就像「每切一首歌都在重新解析」。
- 日志文案要跟事实一致：以前一律打印「缓存只有 720P 的 durl」，
  实际可能是「只有旧数据」甚至「根本没有数据」，误导排查。

### 定时暂停 / 定时关闭（`src/utils/sleepTimer.ts`）

标题栏的「定时」按钮 → 弹窗设时长（时 + 分）→ 到点停止播放；勾了「关闭程序」就退出应用。

**为什么逻辑在渲染层**：三个执行条件里有两个**只有渲染层知道** ——
「视频播到第几秒」要读 `<video>.currentTime`、「暂停时冻结」要读 `paused`。
主进程完全看不到这些，所以计时器在渲染层跑，只有「退出应用」那一步走 IPC。

#### 三个选项是**叠加**的，不是互斥

| 复选框文案 | 字段 | 作用 |
| :--- | :--- | :--- |
| 暂停时停止倒计时 | `pauseCountdown` | 视频暂停 → 倒计时**冻结** |
| 视频播放完毕后停止播放 | `waitVideoEnd` | 到点不立刻停，等**某个视频播到 0-3 秒** |
| 停止播放后关闭程序 | `closeApp` | 把「停止播放」升级成「关闭程序」 |

| pauseCountdown | waitVideoEnd | closeApp | 行为 |
| :---: | :---: | :---: | :--- |
| ☐ | ☐ | ☐ | 到点**立刻**停止播放 |
| ☐ | ☑ | ☐ | 到点后等视频播到 0-3 秒 → 停止播放 |
| ☐ | ☐ | ☑ | 到点**立刻**关闭程序 |
| ☑ | 任意 | 任意 | 暂停时倒计时**冻结**（另外两条照旧） |

#### 「等视频播完」的判定：`> 0 && <= 3`

```ts
const inFireWindow = (t: number) => t > 0 && t <= 3
```

**不能用 `currentTime === 1`**：`timeupdate` 约 250ms 一次、浏览器给的是浮点数
（`0.998` / `1.004` / `1.253`），严格等于某个值几乎必然错过。所以取区间。
用户定的区间是「大于 0 小于等于 3」—— 从开播第一帧起就能命中。

#### ⚠️ 等待必须给「视频停着不走」留一条出路（踩过）

等待的实现是「每秒看一次 `currentTime` 是否落在 0-3 秒窗口」。
而视频**暂停**时 `currentTime` 永远不动 —— 于是这个等待**永远不会结束**：
面板一直显示「计时已结束，等待视频播放完毕…」，除了点「取消定时」没有任何出路，
用户会以为定时器坏了。

```
勾了「等视频播放完毕」但没勾「暂停时暂停倒计时」
到点那一刻视频正好是暂停的（手动暂停 / 元素被 pause() 停在中段）
→ pending 永远等不到（currentTime 不动）
```

修法：`pending` 分支里加一条 **`!video || video.paused` → 直接执行**。

> 判据用 `paused` 而不是「这一秒没动」：后者可能只是缓冲 / 卡顿，等一会儿会恢复；
> `paused` 才是明确的「不会再往下播了」。
> 没有视频元素时同理 —— 没有任何东西会「播完」，再等就是死等。

#### 两个踩过的坑（都是执行顺序问题）

**坑一：点暂停后倒计时还会多跑一秒**

冻结判断原来只在每秒的 `tick()` 里做：

```
用户在 xx:59.1 点暂停 → 下一次 tick 在 xx:00.0 才切成冻结
                      → 那一刻剩余已经从 59 掉到 58
```

修法：`<video>` 的 `play` / `pause` 事件里调 `sleepTimer.syncNow()`，
冻结就发生在**事件那一刻**。

**坑二：点播放后倒计时不继续**

冻结的实现是「记下剩余毫秒 + 把 `deadlineAt` 置 `null`」，恢复时按剩余重算。
但原来的 `tick()` 里：

```ts
if (this.deadlineAt === null) return   // ← 冻结时它就是 null，这里直接返回了
...
if (this.frozenRemainMs !== null) {    // ← 恢复分支永远走不到
  this.deadlineAt = Date.now() + this.frozenRemainMs
}
```

**恢复判断必须在那个提前返回之前**。现在顺序是：
`pending` → `冻结/恢复` → `没在倒计时就返回` → `碰到暂停就冻结` → `正常推进/归零`。

#### 界面的三个状态

| 状态 | 按钮显示 |
| --- | --- |
| 没定时 | 「定时」 |
| 倒计时中 | 剩余时间（有小时 `1:23:45`、没有 `23:45`），强调色 |
| **已归零、等视频播完** | **`00:00`，红色**（`--accent-danger`）|

`snapshot().active` **要把 `pending` 也算进去** —— 归零后 `deadlineAt` 已经是 `null`，
只看它的话界面会误以为「没有定时」而把按钮变回「定时」。

#### 时长是本地草稿，只有确认才落盘

面板里的时长和三个复选框是**本地 `draft`**，编辑只改 draft，
点「确认 / 更新定时」才 `player.applySleepTimer({hours, minutes, options})`。

**这是被逼出来的**：原来编辑时立刻向定时器上报 → 触发 `emit()` →
那一刻定时还没启动、`active` 是 false → 而订阅回调里有
`if (!state.active) 关面板` → **点一下加号弹窗就自己关了**。

> ⚠️ 定时器上曾经有个 `setOptions()`（「三个复选框被改时同步」）但它**从未被调用**，
> 已删 —— 它的文档描述的是面板**故意不做**的实时同步行为，
> 留着只会让后来的人以为选项是实时生效的。

#### `0 时 0 分` 时未定时的「确认」是禁用的

否则会走到 `applySleepTimer` 弹 warning 并 `return`（不写设置、不启动定时），
而面板的 `confirm()` 紧接着**自己**把弹窗关掉 ——
用户看到「警告一闪 + 面板关了 + 什么也没设定」。

> **定时中**不禁用：那时 0/0 是「取消定时」的语义（`apply` 走取消分支），
> 不是错误输入。

#### `win:quit` —— 为什么不能复用 `winClose`

定时关闭必须**真退出**。`winClose` 走窗口的 `close` 事件，
而 `common.closeToTray` 打开时那个事件会被拦成「隐藏到托盘」——
用它做定时关闭会关不掉（定时到了只是藏进托盘）。

所以单独加了 `win:quit` → `app.quit()`：`before-quit` 会把 `isQuitting` 置位，
于是那个拦截逻辑自动放行。

#### `el-dialog` 的坑：确认后弹窗不关

面板里 `confirm()` 曾经只 `$emit('apply')`，然后指望父组件把 `sleepPanelVisible` 置 false ——
**实测弹窗不会关**（定时确实启动了，框还在）。
原因是 `v-model="visible"` 绑的是 getter/setter，父组件改值时 setter 又会 emit
`update:modelValue` 回来，形成来回覆盖。

修法分两步：当时是面板在 `confirm()` 里**自己先 `this.visible = false`**；
后来组件改成直接读写 store（`visible` 的 setter 就是 `player.sleepPanelVisible = v`），
那个 emit 回环从根上没了 —— 现在这句 `this.visible = false` 留着只是为了语义清楚。

> 另外：`el-dialog` 关闭后 **DOM 不移除**，只把 `.el-overlay` 设成 `display: none`。
> 所以测「弹窗关没关」不能查 DOM 存在性，要看 `overlayDisplay` / `offsetParent`。

### 全屏与桌面壁纸（踩坑记录）

**结论：「全屏」用应用层模拟，不要调用 `setFullScreen()`，也不要读 `isFullScreen()`。**

这一套最初是因为**主窗口当时是 `transparent: true`**，而 Windows 上透明窗口的原生全屏是失效的。
实测（Electron 42 / Windows，`setFullScreen(true)` 后 600ms 读回）：

| 窗口配置 | `isFullScreen()` |
| --- | --- |
| 普通窗口 | `true` |
| `frame: false` | `true` |
| `transparent: true` | **`false`** |
| `transparent: true` + `frame: false`（当时的本项目） | **`false`** |
| 同上 + `thickFrame:false` / `roundedCorners:false` / `hasShadow:false` / `resizable:true` | **`false`** |
| 同上，但先 `setBounds` 到整屏再 `setFullScreen` | **`false`** |

透明窗口下 `setFullScreen(true)` 只会把窗口撑到屏幕大小，`isFullScreen()` 永远返回 `false`
（参见 [electron#27286](https://github.com/electron/electron/issues/27286)）。老代码拿它当唯一真相，
于是产生了一整套连环 bug：

- 全屏标志被原生值回写 → 渲染进程的 `isFullscreen` 永远是 `false`，按钮一直显示「全屏」；
- 再点「全屏」时 `!isFullScreen` 依然为 `true` → 只会一路「进入全屏」，**退不出去**；
- 从全屏切到壁纸时，还原点记到的是「非全屏」，退出壁纸就掉回普通窗口，
  而**挂壁纸层时窗口还是普通尺寸** → 「进了壁纸模式但没在壁纸层全屏」。

> **⚠️ 前提已经变了**：主窗口现在**不透明**（原因见下面「壁纸层」那节里 `WS_EX_LAYERED` 的坑），
> 所以「透明导致原生全屏失效」这个前提**不再成立**。
> 但**应用层模拟继续保留**，不换回原生 API：它已经过大量验证，
> 而且 `fullScreenRestore` 那套还原逻辑完全建立在它之上，换回去是纯风险、没有收益。

现在的做法（`electron/main/index.ts`）：

- `applyFullScreenGeometry()`：`setAspectRatio(0)`（免得宽高比约束改写 `setBounds`）
  → 若当前最大化先 `unmaximize()` →
  `setResizable(true)` → `setBounds(窗口所在屏的 bounds)`（用 `screen.getDisplayMatching()` 取，
  写死主屏会把副屏上的窗口拽回主屏）→ `setResizable(false)` →
  `setAlwaysOnTop(true)`（不置顶的话任务栏会压在窗口上面）。
- **★ 这个顺序是硬要求，两个坑都实测过**：
  - `setBounds` 的语义随 `resizable` 变。可缩放时按**客户区**解释（传 `1920x1080`，客户区就是
    `1920x1080`）；不可缩放时按**外框**解释（同样参数 → 客户区 `1904x1072`）。
    先关缩放再 `setBounds`，右边和下边各留 8px（外框右缘停在 `x=1912`）——
    用户看到的就是「全屏右边没覆盖」。所以必须「开缩放 → 铺满 → 关缩放」。
  - 最大化窗口不接受 `setBounds`（Windows 规则，只会改还原尺寸）。不先 `unmaximize()`
    的话「全屏」实际停在**工作区**尺寸 `1920x1040`，任务栏那条露在外面。
    还原点 `fullScreenRestore` 在 `enterFullScreen` 里**先记后改**，所以还原不丢；
    退出时 `exitFullScreen` 要 `setBounds(还原点)` 再 `maximize()`，否则
    `rcNormalPosition` 已被整屏那次 `setBounds` 污染，「向下还原」会还原成整屏。
- **全屏下不能拖、不能缩放**（和原生全屏一致）：
  - 窗口是 `frame: false`，但仍带 `WS_THICKFRAME`，那圈**不可见**的 8px 边框就是缩放热区。
    全屏时 `setResizable(false)` 把它去掉 —— 否则能拖小窗口而 `isFullScreen` 仍为 true，
    状态和几何脱节。这也解释了「只有顶边能拖、侧边不行」：外框铺满屏幕后，
    左右/下的边框落到屏幕外，只有顶边还在屏内。
  - `startWindowDrag` 在 `isFullScreen` 时返回 `null`（老实现是「拖动 = 退出全屏」，
    全屏下标题栏可见，顺手一拖就掉出全屏，太容易误触）。渲染层的
    `onTitlebarMouseDown` / `onTitlebarDblClick` 和主进程的 `win:maximize`
    在全屏下也都不响应。退出全屏只走 F / Esc / 右下角按钮。
  - 恢复顺序：退出全屏时先 `setResizable(true)` 再 `maximize()` ——
    不可缩放的窗口没有 `WS_MAXIMIZEBOX`，顺序反了最大化会失效。
- 全屏状态由主进程的 `isFullScreen` 变量持有，`win:isFullscreen` 直接返回它，
  **不再**是 `mainWindow.isFullScreen()`；`resize` 事件也不再回写这个变量。
- 两层还原点，互不污染：
  - `fullScreenRestore`：进入全屏前的普通窗口尺寸 / 最大化状态，退出全屏时用；
  - `wallpaperRestore`：进入壁纸**之前**的状态（含「当时是不是全屏」），退出壁纸时用。
    所以「全屏 → 壁纸 → 窗口模式」会回到全屏，且此时依然能正常退出全屏。
- **先 `attachWallpaper()`，再用原生 `SetWindowPos` 撑满**（顺序见下面「壁纸层」那节的表）。
  旧做法是「先 `setBounds` 铺满 + 等 120ms + 再挂载」，既能闪一下全屏，又把坐标系搞混了。
- 壁纸模式下 `win:toggleFullscreen` 直接返回（几何由壁纸层接管）。
- **壁纸模式 = 纯背景**：标题栏和控制栏都挂 `.wm-hidden`（`display: none`），窗口里没有可点的东西，
  所以原生层**不做鼠标 / 键盘转发**（那本来是为了把系统事件合成进壁纸窗口，现在没有可点的东西）。
  操作全部走托盘菜单；「歌单管理 / 视频管理」「退出登录」这类需要窗口的项会先 `restoreWindow()` 再执行。
  另外进入时 `setSkipTaskbar(true)`、退出时恢复 `false`：壁纸是「桌面的一部分」，
  任务栏上不该多一个按钮（和最小化到托盘一样干净），要回窗口就左键点托盘图标。
- **进壁纸模式先收掉所有弹窗**：壁纸模式下标题栏/控制栏都隐藏了，弹窗留在那儿既点不动也关不掉
  （用户只能先回窗口模式关掉它、再重新进壁纸）。所以渲染层监听 `wallpaperEnabled` 变 `true`，
  把列表 / 歌单管理 / 设置 / 关于 / 添加视频一起关掉。

#### 壁纸层用 koffi 自己调 Win32（不再依赖 `electron-as-wallpaper`）

**结论：那个库不能用，换成 `electron/main/winWallpaper.ts`（koffi 直接调 Win32，约 330 行）。**

为什么弃用它 —— 两个原因，一个是**工具链**，一个是**致命 bug**：

| 问题 | 说明 |
| --- | --- |
| **要 Rust 工具链** | 它的原生模块靠 `cargo build` **现场编译**（`scripts.install` = `npm run neon:release` → `cargo build`）。没装 cargo 的机器 `npm i` 直接失败；而主进程里那个 `require` 被空 `try/catch` 吞掉 → **点了壁纸按钮毫无反应、也没有任何日志**，用户完全不知道是环境问题还是程序坏了 |
| **`attach` 不是原子操作（致命）** | 顺序是「先 `SetParent(hwnd, WorkerW)`（不可逆，窗口已离开正常窗口层）→ 再 `toggle_window_transparent`」，而后者内部是「先 `SetWindowLongA` 打上 `WS_EX_LAYERED` → 再 `SetLayeredWindowAttributes(...).unwrap()`」。**这两句之间就是一个「窗口已被摘出正常层、又被打成 layered 但属性还没生效」的中间态 —— 按 Win32 规则这个窗口不显示。** 一旦第二步 panic，JS 层 `window.wallpaperState = { isAttached: true }` 执行不到，调用方以为「没挂上」 |
| **回滚漏了 detach（把上面的失败变成永久故障）** | 老代码的回滚只还原了几何 / 任务栏 / 置顶，**没有 `SetParent` 回来**。于是窗口留在桌面层且不可见，任务栏按钮也没有；而 `wallpaperEnabled` 已被翻回 `false`，`restoreWindow()` 又只看这个标志 → **永远不会去 detach，点「恢复窗口」也救不回来**，只能杀进程 + 重启 Explorer |
| **`isTransparent` 报的是错的对象** | 它写的是模块级默认值 `attachOptions.transparent`（`false`），而不是调用方传的 `true`。于是 `detach()` 里读到的永远是 `false`，**`WS_EX_LAYERED` 样式再也不会被清掉** |
| **`isAttached` 不是成功信号** | 它在 `neon.attach()` 正常返回后**无条件**置 `true`，只能反映「有没有抛异常」，检测不到静默失败 |

现在的做法（`winWallpaper.ts`）：

1. **完全不碰 `WS_EX_LAYERED`** —— 只做 `SetParent`。库那个标志设的 alpha 是 `255`
   （完全不透明，视觉上等于没做事），唯一效果就是加个 `WS_EX_LAYERED`，
   却是整条崩溃路径的唯一来源。去掉它，那个中间态**根本不存在**。
2. **`SetParent` 之后回读真实父窗口来验证**（不是靠「有没有抛异常」猜）。
3. **失败不抛异常**，返回结构化 `{ok, reason}`，由调用方决定怎么回滚 —— 调用方必须能在
   「原生层可能已经挂上」的前提下无条件 `detach`。
4. **koffi 是预编译的 N-API 包**（`@koromix/koffi-win32-x64` 带现成 `.node`），**不需要 Rust 工具链**。

#### ⚠️ 透明窗口 + 没有 GPU 加速 = 壁纸模式「有声音没画面」（踩坑记录）

**这是比上面那条更隐蔽的坑，因为它跟我们的代码无关 —— 是 Chromium 自己去设的 `WS_EX_LAYERED`。**

现象：**在虚拟机里进壁纸模式，声音还在、画面没了**；物理机上完全正常。

排查过程（每一步都实测过，值得记下来）：

| 步骤 | 做法 | 结果 |
| --- | --- | --- |
| 1 | 加诊断日志，打印挂载前后的窗口状态 | 挂载**成功**（`parent` 正确）、`visible=1`、`rect=0,0 1920x1080`、`dwmComposition=1` —— 系统眼里一切正常 |
| 2 | 对比物理机与虚拟机的 `exstyle` | 物理机 `0x0`，虚拟机 **`0x80008`（`layered=1`）** ← 差异在这里 |
| 3 | 本机复现：同一份代码加 `--disable-gpu` | **复现！`layered` 从 0 变成 1** |

也就是说：**虚拟机只是「没有 GPU 加速」最常见的一种场景**。这条链条是：

```
transparent: true
   ↓
Chromium 要合成一个透明窗口
   ↓
有 GPU  → 走 DWM 硬件合成        → 正常 ✅
没 GPU  → 退回 GDI「分层窗口」    → 给自己设上 WS_EX_LAYERED
              ↓
         SetParent 到 WorkerW（桌面层）
              ↓
         桌面层的合成路径画不出分层子窗口 → 画面出不来
              ↓
         音频走独立线程，不受影响 → 声音还在
```

**会中招的远不止虚拟机**：远程桌面（RDP）、显卡驱动损坏或用的微软基本显示适配器、
老显卡、以及任何 `--disable-gpu` 启动的场合。所以「只有虚拟机有问题」是错觉。

**修法：主窗口不要透明。** `transparent: false` + `backgroundColor: '#000000'` 之后，
Chromium 不需要分层，`exstyle` 干净（实测 `0x100`，**无 `WS_EX_LAYERED`**），从根上绕开。

> **为什么这个修法不会伤到界面毛玻璃**：`--glass-bg` + `backdrop-filter` 模糊的是
> **页面内部**渲染的视频画面，跟「窗口能不能透出桌面」完全是两件事。
> 窗口透明影响的是最外层那一圈底色（原来是透出桌面，现在是不透明黑），
> 而标题栏 / 控制栏 / 弹窗的毛玻璃照旧。
>
> 顺带：这个改动**对壁纸模式是纯收益** —— 壁纸模式铺满整屏、界面全隐藏，
> 那点「透出桌面壁纸」的角反而是噪音；不透明之后画面从边到边，更干净。

**诊断日志保留在代码里**（`winWallpaper.ts` 的 `describeWindow`），挂载前后各打一行：

```
[wallpaper] 挂载前: parent=65552  visible=1  iconic=0  style=0x14030000(child=0,visibleBit=1)  exstyle=0x0(layered=0,transparent=0)  rect=0,0 1920x1080  dwmComposition=1
[wallpaper] 挂载后: parent=1049636(期望 1049636)  visible=1  ...  exstyle=0x80008(layered=1,...)  ...
```

以后再有「画面看不见」的反馈，先看这两行的 `layered` 和 `dwmComposition`，
一眼就能定位是「透明降级」还是「DWM 合成没开」——不用再像这次一样来回猜。

**⚠️ 壁纸几何必须用原生 `SetWindowPos`，不能用 `setBounds`（「一圈白边」的根源）：**

窗口被 `SetParent` 挂到 WorkerW 之后，它的坐标原点是**父窗口客户区**，不再是屏幕左上角。
而 Electron 侧仍按「顶层窗口 + 屏幕坐标」理解 `bounds` —— 两套坐标系各说各话，
只要桌面层的大小变了（任务栏改位置 / 改高度 / 自动隐藏、改分辨率、改缩放、Explorer 重建
WorkerW），「窗口尺寸」和「父客户区」就会对不上。**子窗口不会跟着父窗口自动改尺寸**，
多出来或缺失的那块露的是宿主层底色，看起来就是「一圈白边，而且盖不住任务栏那一条」。

修法（`fitWallpaperWindow`）：问 `GetClientRect(父窗口)` 要目标尺寸，和窗口自己的客户区比，
不一致才走 `SetWindowPos`。这条路径只有一个坐标系，而且幂等（已对齐时什么都不做）。

**★ `SetWindowPos` 的 `cx/cy` 是「外框」尺寸，不是客户区尺寸**

`frame: false` 不等于零边框 —— Windows 上它仍带 `WS_THICKFRAME`（支持边缘拖拽缩放），
那圈边框只是不可见。实测一台 135% 缩放的机器：

```
窗口  windowRect 1935x1048   clientRect 1919x1040
边框  左 8  上 0  右 8  下 8
```

所以「把父客户区尺寸直接传给 `SetWindowPos`」会让窗口客户区被边框吃掉一圈，
露出的正是**两侧 + 下面各 8px 的白边**（上边框为 0，所以上面没有）。
必须反推外框：

- 位置 = 目标客户区原点 − (左边框, 上边框)
- 尺寸 = 目标客户区尺寸 + (左+右边框, 上+下边框)

边框宽度每次现读（`GetWindowRect` − `GetClientRect`；左右/上下的分布用
`ClientToScreen` 反推），DPI 变化时自动跟着变。对齐后的判据也不能只看尺寸，
还要看客户区原点是否落在父客户区的 `(0,0)`。

配套一个**贴合守护**（`index.ts` 的 `startWallpaperFitGuard`）：壁纸模式下每秒对一次尺寸，
父窗口每 5 秒校验一次（父窗口不一致 = 桌面层被重建过，要重新 `SetParent`）。
`display-metrics-changed` 触发时立刻对一次。

> 为什么轮询而不用 `WM_SETTINGCHANGE`：子类化 Chromium 的窗口过程要跟它的
> `HWNDMessageHandler` 抢着处理消息，风险远大于收益；而每秒两次 `GetClientRect`
> 的开销可以忽略。真出问题时日志会打出 `1920x1040 → 1920x1080` 这种前后尺寸，
> 一眼能看出「是谁把窗口改小了」。

**进入 / 退出不闪屏，靠的是顺序而不是特效：**

| 时机 | 顺序 | 为什么 |
| :--- | :--- | :--- |
| 进入 | `SetParent` → 原生撑满 → `setSkipTaskbar` | 窗口以小尺寸沉到图标层后面（视觉上等于原地消失），再在壁纸层里撑满，全程被图标层挡着。旧顺序是「先 `setBounds` 铺满 + 置顶，等 120ms，再 `SetParent`」——那 120ms 是个盖住任务栏和桌面图标的普通窗口，就是「闪一下全屏」 |
| 退出 | `hide` → `detach` → 还原几何 → `show` | `detach` 之后窗口立刻变回顶层窗口，若此时还是整屏尺寸，用户会再看到一次全屏闪现。隐藏状态下做完再一次性 `show`，只剩「小窗口出现」这一帧 |

**⚠️ 校验父窗口不能用 `GetParent`（实测踩过，卡了一整轮）：**

`GetParent` 的语义是「**子窗口**返回 parent，**带 `WS_POPUP` 的顶层窗口**返回 owner」——
而 `SetParent` **不会**把窗口样式改成 `WS_CHILD`。所以窗口挂到 WorkerW 之后，
它在 `GetParent` 眼里仍然是顶层窗口，返回的是 **owner（NULL）**，永远拿不到 WorkerW。

实测（挂载成功后同时读三个 API，窗口确实已经在壁纸层）：

```
SetParent(hwnd, worker) -> 返回 65552（旧父窗口，不是错误码）
GetParent(hwnd)               = 0        ← 会误判成「没挂上」
GetWindowLongPtr(hwnd, -8)    = 788750   ← 真实父窗口
GetAncestor(hwnd, GA_PARENT)  = 788750   ← 真实父窗口
```

用错这个 API 的后果：**校验永远失败 → 每次进壁纸都被回滚 detach → 壁纸模式完全进不去**，
而日志上只看到一句 `SetParent 没有生效（期望父窗口 788750，实际 0）`，从字面完全看不出是校验写错了。
现在用 `GetAncestor(GA_PARENT)`（`GWLP_HWNDPARENT` 兜底）。

顺带：`SetParent` 的**返回值是旧父窗口**、`GetLastError` 也可能是上一次调用的残留（实测拿到 87），
两者都**不能**当成功/失败依据，只有回读父窗口算数。

**两个标志必须分开：`wallpaperEnabled` vs `wallpaperAttached`**

这是「窗口回不来」那个 bug 的根因，也是这次改造的核心：

| 变量 | 含义 | 谁读它 |
| --- | --- | --- |
| `wallpaperEnabled` | **应用意图**：用户当前是不是「壁纸模式」 | 界面按钮文案、托盘菜单、渲染层 `.wm-hidden` |
| `wallpaperAttached` | **物理事实**：窗口是不是**真的**挂到了桌面层 | `restoreWindow()` / `before-quit` |

`attach` 里的 `SetParent` 是不可逆动作：**只要执行过，窗口就已经离开正常窗口层了。**
所以 `wallpaperAttached` 在调 `attachWallpaper()` **之前**就置位（宁可多摘一次，不能漏摘），
只有 `detachWallpaper()` 成功后才清除。`restoreWindow()` 与 `before-quit` 都改判它
（外加 `isAttachedToWallpaper()` 直接问系统），**不再只看 `wallpaperEnabled`**。

**「窗口模式」就是唯一入口，不另设「强制…」那一项（踩坑记录）**

一开始加过一个单独的逃生口「强制回到窗口模式」。两个问题：

1. **文案吓人**：用户看到「强制」会以为出了故障（用户原话：「用户看见什么强制还以为咋了呢」）；
2. **和切换项重名**：壁纸模式下切换项本来就显示「窗口模式」，再加一项就是两个「窗口模式」，更懵。

所以**合并成一项**，壁纸模式下点「窗口模式」直接走 `restoreWindow()`：

- 它三个条件**取或**判断「窗口是不是真的挂在桌面层」——`wallpaperEnabled`（意图）、
  `wallpaperAttached`（事实）、`isAttachedToWallpaper()`（问系统）。
  所以状态漂移时它也能救回来，**本身就已经是最稳的那条路径**，不需要额外的逃生口动作；
- `setWallpaperMode(false)` 没确认成功时，它还会**再硬 `detach` 一次**；
- 最后 `show()` + `focus()` —— 点「窗口模式」本来就该看到窗口。

一句话：**逃生口的能力被并进了「窗口模式」这个正常入口**，而不是留一个单独的动作
（见 `src/trayMenu/main.ts` 里 `action` 的注释）。

**失败要出声**：`toggleWallpaper()` 在原生层不可用时广播 `wallpaper:unavailable`（带原因），
渲染层弹一条提示。以前是空 `catch` 静默 —— 「点了没反应」没有任何线索，这是排查困难的主因。

**「启动时进入桌面壁纸模式」这个设置的边界（踩坑记录）**：

它**只管下次开机**，是纯粹的启动开关；当前是不是壁纸由按钮/托盘决定（`wallpaperEnabled`）。
两者必须分开，合成一个键就会互相打架：

| 坑 | 现象 | 怎么修 |
| --- | --- | --- |
| **运行期切换顺手改写设置** | `toggleWallpaper()` 原来每次都 `updateSetting({ 'common.wallpaperMode': wallpaperEnabled })`；于是用按钮/托盘切一下，设置里那个开关就跟着自己翻，而且在**壁纸模式下退出程序**后配置留着 `true` —— 下次启动直接进壁纸、开关还显示「已打开」，用户觉得「我没动它，它自己开了，还关不掉」 | 按钮/托盘只改 `wallpaperEnabled`（本次运行的状态），**不落盘** |
| **设置被当成实时开关** | 顺手做「改了就立刻应用」是错的：用户明确要求**打开这个开关也不要立刻进壁纸**（它只是「下次开机进」）。反过来同样别做：关掉它也不该把当前壁纸模式踢掉 | `onSettingChange` 里**不处理**这个 key（只刷新托盘），当前状态一律由按钮/托盘切 |

> 一句话：**「下次开机进壁纸」和「现在是不是壁纸」是两件事**，各管各的，谁也别去写对方。

**为什么托盘菜单是自绘的，不是原生 `Menu.popup`**（结论来自当时那个库的 Rust 源码，不是猜的）：

`electron-as-wallpaper` 的 `attach()` 除了 `SendMessageTimeout(Progman, 0x052C, …)` 让 Explorer 生成 WorkerW、
`SetParent(hwnd, worker_w)` 把窗口挂到桌面图标后面，还会在 `forwardMouseInput: true` 时
注册 `RIDEV_INPUTSINK` 原始输入 —— 后者会把**全系统的鼠标事件**都
`PostMessageA(壁纸窗口, WM_LBUTTONDOWN/UP, …)` 塞进去。

原生弹出菜单的规矩是「菜单外发生一次按下就关掉」。于是点托盘图标的那一下
同时被塞进壁纸窗口，**菜单刚弹出来就被自己关掉**；就算弹出来了，点菜单项时也会被同样打断。
这个转发在 Rust 侧是全局装的，JS 这层没法「只在菜单开着时关掉」。
结论：开着鼠标转发时，**任何原生弹出菜单都活不下来**。

> 现在壁纸层换成自己写的 `winWallpaper.ts`，**压根不实现输入转发**（界面全隐藏，没什么可点的），
> 所以这一整类问题在壁纸模式下不复存在；下面那些防护留着当保险。
> 自绘菜单本身**照旧保留** —— 它现在是个完整的迷你控制台（进度条 / 音量 / 播放控制），
> 原生菜单画不出这些控件，换回 `Menu.popup` 反而是功能倒退。

所以托盘菜单自己画，跑在一个**独立的置顶窗口**里（`tray-menu.html` + `src/trayMenu/main.ts`）。
它是个**迷你控制台**：

```
歌名 - 歌手名
────────── 进度条（可拖动跳转） ──────────
已播时长                视频时长        ← 两端对齐，中间不加 `/`
[音量(悬停出横向条)] [上一首] [播放/暂停] [下一首] [模式切换]
──────────
歌单管理·视频管理（按当前工作区显示）/ 定时（有定时时显示倒计时）/ 壁纸模式·窗口模式 / 退出登录 / 退出程序
```

> 菜单里所有文字**居中**（`.now` 与 `.item`）；「定时」那一项在倒计时期间是**蓝字**，
> 归零（`00:00`，正在等视频播完那一段）是**红字** —— 和面板里的显示保持一致。

| 要点 | 做法 |
| --- | --- |
| 为什么独立窗口就行 | 它**不是**壁纸窗口，收的是真实鼠标消息；又能 `setAlwaysOnTop(true, 'screen-saver')` 盖在任务栏之上 |
| 位置 | `tray.getBounds()` 拿到托盘图标矩形，再按**任务栏所在的那条边**决定弹出方向：底部 → 图标上方（放不下翻下方）；顶部 → 图标下方；左侧 → 图标右边；右侧 → 图标左边（竖排任务栏时菜单底边与图标底边齐平）。最后统一夹进 `workArea` |
| **任务栏在哪边不用问系统** | 判据是「屏幕 `bounds` 减 `workArea`」：`workArea` 是系统扣掉任务栏后剩下的区域，哪边差值最大任务栏就在哪边（不用走 `SHAppBarMessage`，也不用自己处理多屏）。四边差值都 < 2px = 这块屏没有可见任务栏（自动隐藏 / 副屏），回落到「贴图标上方、放不下翻下方」的启发式 |
| 尺寸 | 页面渲染完自己量高度，**高度变了才**回报 `trayMenu:ready` → 主进程 `setBounds` 后再 `show()` |
| 状态 | 主进程 `trayMenu:state` 推送；菜单开着时渲染层每 300ms 推一次进度，菜单里那条进度条才会动 |
| 动作 | `trayMenu:action`（带 `value`，进度用 0~1、音量用 0~100）→ 主进程转成 `tray:*` 广播，不重复实现播放逻辑 |
| DOM 稳定性 | 进度条、音量条、控制按钮、下面那几项**只建一次**，之后只改文案/样式 —— 菜单开着时状态每 300ms 推一次，重建 DOM 会让「按下与抬起之间元素被换掉」从而点不动 |
| 音量 | 按钮点了静音（菜单**不收起**，方便接着调）；悬停出**横向**条，数字在条左边，拖动实时生效。**悬停时滚轮也能调**（上滚 +5、下滚 −5，和控制栏、键盘 ↑↓ 同一个步长）—— 监听挂在 `.volume` 外层，和「横条显示」的 `:hover` 范围完全重合，`passive: false` 才能 `preventDefault` |
| **哪些动作不收起菜单** | 判据是「**这个动作会不会被连续使用**」，见下面单独一条 |
| **悬停条不能竖着放** | 竖条会伸出面板、被窗口边界裁掉（窗口高度是按 `#menu` 量的，绝对定位的弹出条不算进去）。所以弹出条做成**横向**、留在面板内部 |
| 收起 | 下面那几项（歌单管理·视频管理 / 定时 / 壁纸模式 / 退出登录 / 退出程序）执行后收起；另外 `Esc`、失焦且**光标已经不在菜单上**、主窗口关闭时一起销毁 |
| 顶部一行 | 显示 `歌曲名 - 歌手名`（不是视频标题：B 站标题又长又带 `【4K】` 这类前缀） |
| **定时的倒计时** | 计时器在渲染层（要读 `<video>` 判断暂停冻结 / 等视频播完），主进程**不自己算时间**：渲染层把 `sleepActive` + `sleepRemainSec` 随 `tray:updateState` 一起送上来，主进程原样塞进 `TrayMenuState`。菜单开着时渲染层每秒（`SleepTimer` 的订阅回调）推一次，暂停时也能跳 |
| 关闭到托盘 | 菜单里「壁纸模式」那一项在窗口被藏起来时变成**「恢复窗口」**，动作也跟着换 |
| **管理项文案跟工作区走** | 那一项按 `TrayMenuState.mode` 显示「歌单管理」或「视频管理」，点下去渲染层统一走 `openManager()` 打开当前工作区的弹窗 —— 文案与落地页由**同一个** `queue.mode` 决定，不会出现"写着视频管理、打开的是歌单"。工作区算在渲染层，随 `trayUpdateState` 一起推给主进程（`TrayState.mode`）；主进程只照着显示，不自己读设置 |
| **动作必须跟着状态走** | 踩过：登录那一项的文案会随登录态变成「退出登录」，但动作写死成 `'login'` —— 点「退出登录」发的还是 login，用户看到的就是「点了又登录上了」。凡是文案会变的项，`action` 也要是函数 |
| **每次弹出都要装兜底显示** | 踩过：页面「高度没变就不回报」，而显示这件事绑在 `trayMenu:ready` 上 —— 第一次右键能弹（高度 0→N），第二次开始不再回报，菜单就再也不出现（「进了壁纸模式后右键弹不出来」）。现在 `showTrayMenu` 每次都装兜底显示：**高度已知**（第二次以后）等 120ms 抢速度，**首次**（`trayMenuHeight` 还是 0、页面正在加载）等 1s，让页面先回报高度 |
| **首屏不能抢跑 + 已显示也要能自纠** | 踩过：首次右键时兜底用了硬编码 `300`，而菜单真实高度约 240，内容是**从窗口顶部往下排**的，多出来的 60px 全是底部透明 → 第一次右键菜单像悬在半空、离任务栏很远，从第二次起才对（那时 `trayMenuHeight` 已是真实值）。根因不止常量写错：`sizeTrayMenu` 里原来是 `if (trayMenuShown) return`，**已显示就再也不重定位**，真实高度回报来也被吃掉。现在改成「高度变了就重定位」（1px 以内当没变，免得取整差造出假变化白挪一次），兜底常量取 `TRAY_MENU_DEFAULT_HEIGHT`（272，实测页面回报 271），首次多等 1s |
| **`showTrayMenu` 必须幂等** | 踩过：右键后菜单**闪两下**。Windows 上同一次右键可能让 `right-click` 触发两次，「菜单开着再右键图标」也会再进来一趟；原实现每进来一次都把 `trayMenuShown` 置回 false 并重装兜底定时器 → 120ms 后又跑一遍 `setBounds` + `show()`。现在开头判断「已显示就直接 return」（顺带清掉失焦收起，否则那一下右键会被 400ms 后的光标判断当成点了别处） |
| **只 show 一次，重定位只挪位置** | `placeAndShowTrayMenu` 在自纠路径上会被二次调用，那时窗口已经可见 —— 再 `show()` / `focus()` 等于让它重新出场一次。现在按 `win.isVisible()` 分支：已可见只 `setBounds` |
| **窗口必须不透明** | 踩过：右键后菜单「显示一下、消失、再出现」，而日志里定位只跑了一次 —— 不是逻辑跑两遍，是透明窗口每次 `show()` 都要重建分层表面，首帧常常是空的/背景没采样。现在 `transparent: false` + `backgroundColor: '#232329'`（页面底色同色），不透明窗口直接由 DWM 合成，没有那一帧 |
| **必须 `thickFrame: false`** | 踩过：菜单**侧边和下边偶尔有一条白边，顶部没有**。这个形状就是指纹 —— 无边框窗口默认仍带 `WS_THICKFRAME`（Electron 的 `thickFrame` 默认 `true`），它附带一圈**不可见缩放边框**：实测物理像素 **左 8 / 上 0 / 右 8 / 下 8**（`GetWindowRect` / `GetClientRect` / `ClientToScreen` 对比）。Chromium 只往客户区里画，那几像素由 DWM 用系统窗框色填 → 左/右/下各露一条浅线，顶上 0px 所以正常。`thickFrame: false` 后四边差值全为 0，窗口矩形 == 客户区矩形：白边消失、`setBounds` 的矩形就是看得见的面板、页面回报的高度也不再被切掉一截。代价（拖边缩放、DWM 投影）这个固定尺寸菜单都用不上 |
| **没有圆角是确认接受的取舍** | 不透明窗口看不见 CSS 圆角的外侧弧 → 四角变直角。试过两条补圆角的路，都不可取：① DWM `DWMWA_WINDOW_CORNER_PREFERENCE`（Win11 的系统圆角）—— **这台机器是 Windows 10 build 19045，调用直接返回 `0x80070057`**，DWM 在 Win10 上根本没这个能力；② `SetWindowRgn` + `CreateRoundRectRgn` 裁窗口区域 —— 能裁，但 GDI 区域是二值的，8px 圆角会有肉眼可见的锯齿（还有区域要在窗口坐标里、且客户区被 8px 不可见缩放边框内缩，每次都得分 `GetWindowRect` / `GetClientRect` / `ClientToScreen` 重算）。为一个菜单的角不值得，保持直角 |
| **面板不能有 `backdrop-filter`** | 透明窗口上 `blur()` 要在每次显示时重新采样窗口背后的内容，Windows 上第一帧常常采不到。改成不透明窗口后它也没意义了 |
| **高度回报要能被收起的菜单忽略** | 页面加了 `ResizeObserver`（字体的行高变化不会触发任何状态推送，只靠「收到状态量一次」会漏），于是菜单**收起后**页面仍可能回报。`trayMenuOpenRequested`（`showTrayMenu` 置真 / `hideTrayMenu` 置假）用来区分「本次弹出还开着」：收起后的回报只更新高度缓存，绝不 `show()`，否则菜单会自己冒出来 |
| **图标矩形要防 0 尺寸** | `tray.getBounds()` 在图标刚注册、任务栏重排时可能给 `{0,0,0,0}`，按它算 y 会落到屏幕顶部（菜单弹到左上角）。`width/height <= 0` 时改用光标位置兜一个 32×32 的近似矩形 |
| **合成点击防护** | 已注释。它本来是挡「鼠标转发把点菜单这一下同时合成到壁纸窗口」，而现在壁纸层（`winWallpaper.ts`）**根本不实现输入转发**（界面也全隐藏），不会再有合成点击。`trayMenuOpen` 标志留着 —— 菜单开着时要把进度推给菜单里的进度条 |
| 左键语义 | 直接显示窗口（`restoreWindow`）：壁纸模式下先切回窗口模式，窗口在托盘里就恢复并前置；**同时广播 `tray:unlock` 让界面解锁** |
| **左键要顺带解锁** | 踩过：窗口模式 + 锁定状态下界面只剩左下右下两个角按钮，用户会很自然地去点托盘图标 —— 以前那一下什么都不发生（窗口本来就可见），看着像卡死。现在左键在 `restoreWindow()` 之后广播 `tray:unlock`，渲染层用幂等的 `toggleLock(false)` 处理（没锁就什么都不做、也不多弹提示）。锁定态只在渲染层，主进程不猜也不存 |
| **提示文案必须跟着行为走** | 踩过：左键从「播放 / 暂停」改成「回到窗口」之后，壁纸模式的 tooltip 还写着旧文案，用户照提示点了一下，结果窗口直接跳出来 —— 提示与行为不一致比没有提示更糟。tooltip 两种模式各写各的（应用模式「单击：显示窗口」/ 壁纸模式「单击：回到窗口」），菜单里每个按钮的 `title` 也随状态更新（播放/暂停、当前模式、静音/取消静音） |
| 退出 | 主窗口 `closed` 时一并 `destroy` 菜单窗口，否则那个隐藏窗口会让 `window-all-closed` 永不触发、点 X 退不掉 |

**哪些动作执行后不收起菜单（判据 + 踩坑记录）**

`runTrayMenuAction` 开头原来是「无条件 `hideTrayMenu()`」，只有 `volume` / `toggleMute`
被特判放过。结果是**控制栏那四个按钮和进度条点一下就关菜单**，很难用：

- 想连着切两首 → 每切一次都要重新右键托盘图标；
- 暂停后想顺手换个循环模式再播 → 菜单已经关了；
- 拖完进度条想接着调音量 → 也得重新开菜单。

现在收敛成一个集合 `KEEP_MENU_OPEN`，判据是「**这个动作会不会被连续使用**」：

| 不收菜单（连续操作） | 收起（一次性命令） |
| --- | --- |
| `seek`（拖动进度） | `showPlaylist`（歌单管理 / 视频管理，要切回窗口） |
| `volume` / `toggleMute` | `toggleWallpaper`（切模式） |
| `playControl` / `prev` / `next` / `toggleMode` | `login` / `logout` / `quit` |

> 注意 `volume` / `toggleMute` 当初就是因为这个原因被特判的（注释原话：
> 「鼠标一碰音量条菜单就没了」），但当时只补了音量两个，**控制栏和进度条漏了**。
> 现在改成集合，再加动作时按「会不会连点」判断即可，不会再漏。

**菜单不收起时怎么关**（三条路都保留，没有新增负担）：

- `Esc`（页面里 `trayMenuClose()`）；
- 点菜单外面 —— 失焦 → `scheduleHideAfterBlur` 判断光标不在菜单矩形内 → 收起；
- 左键点托盘图标 —— `restoreWindow()` 里会收起。

**副作用是好事**：菜单一直开着，`trayMenu:state` 每 300ms 推一次，所以
暂停后播放按钮会**立刻**变成播放图标、切歌后标题也会跟着变 —— 反馈比原来更清楚。

**鼠标转发开着时「菜单能出现但点了没反应」的原因**（真机用 `WindowFromPoint` + 合成真实点击一步步测出来的）：

```
按下鼠标 → 库往壁纸窗口塞一个合成 WM_LBUTTONDOWN
        → Chromium 在 mousedown 时会 SetCapture（鼠标捕获），同时窗口抢走激活
        → 真实的 mousedown 被壁纸窗口吃掉，菜单页面只收到 mouseover + mouseup
        → down / up 不在同一个元素上，浏览器不合成 click → 菜单项永远不触发
        → 菜单还因为失焦被立刻隐藏，mouseup 都没地方落
```

当时做了两处针对性处理，现在仍然保留：

1. **菜单项用 `mouseup` 触发**（校验左键）。按下可能被抢走，但抬起一定收得到。
2. **失焦不立刻收起**：先看光标是不是还在菜单矩形里（`screen.getCursorScreenPoint()` 与
   `getBounds()` 比一下）。还在 = 这一下正是在点菜单，继续等；移开了 = 真的点了别处，收起。

> 早期版本是干脆 `tray.destroy()`，退出壁纸再重建 —— 图标会消失一下，而且壁纸模式下就没有托盘了。
> 也试过「壁纸模式下只留 tooltip + 单击播放」的方案，但那样菜单就废了，所以最后还是把自绘菜单做通。

### 切歌后播放器信息不刷新（踩坑记录）

现象：切歌时底部控制栏的**歌曲封面、歌曲名、视频标题**都停在上一首不变。

原因是两条独立的坑叠在一起：

**1. 本地就能确定的信息却排在网络请求后面**

歌曲名、专辑封面、歌单高亮全都来自本地歌单数据，但换条的那段逻辑原来把它们放在
`await searchSong()` **之后**。搜索缓存未命中时这是一次真网络请求（1~3 秒），
搜索失败时就永远不回来了 —— 于是「切了歌，名字和封面还是上一首的」。

现在引擎在**发请求之前**就调 `onSwitch()`，store 收到后先同步切好本地信息：

```ts
this.currentIndex = index      // 歌单高亮 + 专辑封面（currentCover 优先取 song.cover）
this.currentKey = keyOf(item)  // 副标题「歌手 · 专辑」/ 错误归属判断都用它
this.videoName = ''            // 清掉上一条的视频标题
```

视频标题暂时空白时，模板用 `:videoName="videoName || songName"` 兜底显示歌名占位，
等搜索返回再换成真正的视频标题 —— 绝不会出现「新歌配旧视频标题」。
实测刷新延迟从 550+ms 降到 60ms 左右。

**2. `api:resolveVideo` 把搜索缓存里的条目写坏了**

`resolveVideo` 原来这样更新缓存条目：

```ts
targetVideo = { bvid, view_result, playurl_result }   // ← 整个替换
```

搜索结果条目里的 `title` / `pic` / `author` / `duration` 全被丢掉，
而这个数组会被写回搜索缓存。后果是：

- 下次 `searchSong` 拿到的这一项没有标题和封面 → 播放器标题空白、视频封面回退不出来；
- 由于 `selectedBvid` 指向的正是「你上次播的那个视频」，**切回同一首歌必然命中这条坏数据**；
- 还会把 `title: ''` / `cover: null` 一路写进 `videos` 行，续播也一起坏掉。

现在改成「合并」而不是替换 —— 解析只**补上地址列**，展示字段一律保留：

```ts
// 展示字段（title / pic / author / duration）来自搜索结果，原样留着；
// 地址列由 updateVideoResult 单独写。
```

> 换 SQLite + 拆列之后这条更不容易踩了：地址和展示字段在**同一行的不同列**上，
> 写地址的语句 `UPDATE ... SET durl_url = ?, dash_video = ? ...` 根本不碰 title / pic。
> 而旧实现是「整包对象替换」，一不小心就把别的字段带没了。

`api:resolveVideo` 仍然直接回传正在解析的那个视频的 `title` / `pic`，
渲染层不必再依赖「`videoList` 里能不能找到这个 bvid」——
`selectedBvid` 是历史选择，完全可能不在本次搜索结果里，那时列表查不到，
标题和封面就只能空着。

> **标题与封面刻意来自不同来源**：标题取**搜索结果**里的（里面带
> `<em class="keyword">` 关键词高亮，界面上用 `sanitizeTitleHtml` 净化后 `v-html` 渲染）；
> 封面取 **view 响应**里的（尺寸比搜索结果里的大）。两者在 handler 里分开取。

### 续播：为什么每次都重新搜索、重新解析地址

`restoreSongVideo` 不做「在本地存一份播放列表」那套，就是老老实实两件事：

1. `api:searchSong(歌名)` —— 这首歌上次本来就是「正在播」的那首，搜索结果必然已经在缓存里，
   主进程直接回磁盘缓存（秒回，不是一次真网络请求），换来的是一份**完整的候选列表**；
2. `api:resolveVideo(歌单里记住的 bvid)` —— 播放地址**每次都重新挑**。

两点都有原因：

- **不要为了省这一趟请求搞特殊**。早期版本为了「省掉一次搜索」，续播时只把歌单里记住的那条
  塞进 `videoList`，再后台补一次搜索；结果是刚启动点开视频列表只有孤零零一行。
  现在直接搜完再起播：列表一直是整份候选，正在播的那条正常高亮；万一记住的视频已经不在
  搜索结果里（被删 / 换源），就把它补成列表第一项，而不是让「正在播的」在列表里找不到。
- **搜索结果里带的直链不能直接播**。B 站地址带签名时效（实测缓存里 38 条有 21 条已过期），
  拿旧的直接播就是 `error` -> 「视频加载失败，已跳过」。所以不管列表从哪来，真正播放一律
  交给 `api:resolveVideo`，由主进程判断时效，过期就重新解析。

结果就是：歌单里只记**用户选定的 bvid + 标题 + 封面**，一个字节的直链都不存 —— 反正存了也会过期。

### 视频列表：刷新 / 收藏 / 添加视频（踩坑记录）

视频列表（`src/components/SongVideoListDialog.vue`）现在是一套「候选视频管理」：

```
[刷新]      歌名 / UP 主        []        ← 歌曲列表：右上角是放大镜（点开变输入框）
[刷新]      歌名 / UP 主        [加号]      ← 视频列表：右上角是「添加视频」
────────────────────────────────────
1  封面  标题                   04:03  ♡   ← 行：序号/封面/标题+UP主/时长/收藏
```

- **刷新**（头部左侧，两种列表共用一个按钮）：歌曲列表 → 重新同步歌单；
  视频列表 → 重新搜索这首歌。点了图标转 360°、0.5s 作为反馈。
- **加号**（头部右侧，只有视频列表有）→ 「添加视频」弹窗：粘贴链接 / BV 号 → 解析 → 看封面标题
  → 确认 → 进这首歌的收藏（也就是列表第一位）。
- **搜索**（头部右侧，只有歌曲列表有）→ 平时是个**放大镜图标**，点开才展开输入框（并自动聚焦，
  输入框里按 `Esc` 只收起搜索、不会关掉弹窗）；按歌名 / 歌手 / 专辑实时过滤，计数变成「命中 / 总数」。
  在结果里点一首歌之后 → 播放它、**清空搜索框并收回放大镜**（立刻回到完整列表，当前这首已高亮）；
  关掉弹窗时同样清空。匹配规则和歌单管理里的过滤是同一套。
- **爱心**（行尾，只有视频列表有）→ 收藏 / 取消收藏，空心得实心。

**数据存在哪**：SQLite 的 `song_videos` 表一行一个**候选关系**（哪首歌的候选里有它、排第几、
收藏没有），视频本身和播放地址在 `videos`（`bvid` 主键，全局只有一份）。
收藏就是关系行上的 `favorites = 1` 标记（详见「数据存储（SQLite）」一节）。

- **没有这个字段就是 false** —— 只有收藏的条目才带这个标记，不浪费空间给每条都写
  （库里落成 `0`/`1` 整数，IPC 出去是 `boolean`）。
- 收藏一条 = `favorites` 置 1 **且 `ord` 挪到最小**（所以要排到第一位）；
  **取消收藏只把 `favorites` 置 0、位置不动**。
- 于是**列表顺序就是库里的 `ord` 顺序**，渲染层直接照用，不再自己排一遍
  （旧实现在 `playlists.json` 里有 `favorites` / `videoCache` 两张表、
  渲染层还有 `applyFavoriteOrder` 重排，两处各排一次必然对不上 —— 已全部删除）。

踩过的坑，都是真踩过的：

| 坑 | 现象 | 怎么修 |
| --- | --- | --- |
| **grid 三列塞了四个元素** | 加号跑到**左上角**（第二行第一列） | 左右各自包一层 `.lt-side`，正好三格：左按钮 / 中标题 / 右按钮 |
| **时长的两种形状** | 点过「刷新」之后，视频列表的时长**整列消失** | 搜索接口的 `duration` 是 `"4:03"` **字符串**，view 接口是**秒数**。原来只认数字；现在 `durationText` 两种都收（数字/数字串格式化，`mm:ss` 直接用）。库里统一 `durationToSeconds` 存秒 |
| **重搜会冲掉已解析的地址** | 刷新后每首歌都要重新解析 dash | `api:searchSong` 重写 `videos` 时**不碰地址列**（`durl_url` / `dash_*` / `quality` / `support_formats` / `playurl_at` / `dash_tried` / `playurl_login_state`），它们从旧行读出来再写回去 —— 新搜索结果里根本没有地址，反而旧地址还有效 |
| **收藏项在搜索结果里消失** | 下架 / 排序变化后收藏的视频就没了 | `api:searchSong` 合并时**保留 `favorites = 1` 的条目并置于最前**；新结果里没有的那些，再用 `parseVideoInput(bvid)` 回源刷新标题/封面（**必须在拼装完顺序之后**做，否则列表要等网络才定得下来） |
| **搜索接口会给重复项** | 列表里出现同一个视频两遍 | 按 bvid 去重：新结果里同 bvid 的**覆盖**元数据但**保留 `favorites` 标记** |
| **点爱心会顺带切视频** | 想取消收藏结果换了个视频 | 爱心上 `@click.stop` |
| **连点刷新动画不重播** | 第二次点没有转圈 | 先把 `spinning` 置 false、`$nextTick` 再置 true（CSS 动画重加类名才会重播），500ms 后自动复位 |
| **图标字体里没有这些图标** | 刷新/加号/爱心画不出来 | 这三个用**内联 SVG**（和 `np-cover-fallback` 一致，不引 @element-plus/icons-vue 这种传递依赖） |
| **过滤后下标必须还是原始的** | 搜索「出现」之后点结果里的第 1 行，本该播《出现又离开》，结果播了整张歌单的第 1 首 | `rows` 计算属性返回 `{ item, index }`，模板里点击、高亮、「第几首」**一律用 `row.index`**（过滤只是少渲染几行，不改下标）；行内所有取值都改成 `row.item` |
| **过滤到空要说话** | 输入查不到的词，列表空白，看着像歌单没了 | 渲染一行 `.empty`：「没有匹配的歌曲」（列表本来就空时说「列表是空的」），并且加 `cursor: default` 去掉可点的假象 |
| **过滤词不能留到下次** | 上次筛过，这次打开只看到几首，还以为歌单被删了 | 弹窗关掉（`listType` 变 `none`）时清空 `keyword` |

**「添加视频」怎么解析链接**（`biliApi.parseVideoInput`）：

1. 先从文本里抠 `BV[0-9A-Za-z]{10}`（用户可能粘整段分享文案，不只是裸链接）；
2. 抠不到就把文本当链接 `net.fetch` 跟随跳转（`b23.tv` 短链 → `www.bilibili.com/video/BVxxx`），
   从**最终 URL** 里再抠一次；
3. 拿到 bvid 后请求 view 接口取标题 / 封面 / UP 主 / 时长，返回给弹窗预览。

### B 站视频列表：收藏夹 / 合集 / 系列（第二条进料管）

音乐歌单的链路是「歌名 + 歌手 → **搜索** → 一堆候选 → 选一个」。
视频列表的链路是「条目**本来就是视频**（带 `bvid`）」。两者在数据层是**两组不相交的表**，
但**共用同一个播放引擎** —— 这一节讲怎么做到「播放层一行分支都不加」。

#### 1. 按 bvid 直达：视频条目**根本不经过搜索**

两条进料管的接口数量根本不同：

```
歌：   searchSong（联网 1~3 秒）→ getSelectedBvid → resolveVideo（联网）
视频： resolveVideo(bvid)            ← bvid 早就在手里了
```

分派点只有一处 —— 引擎里的 `resolve()`，按 `isVideoItem()` 岔开，再往下各是一条直线。
**视频这条路一次搜索请求都不发**，也不碰 `song_videos`：它没有「候选」这个概念。

> **这里以前有一整套 `bv:<bvid>` 直连键，已经拆干净了。**
> 做法是：每个视频条目在 `song_videos` 里占一行 `search_key = 'bv:<bvid>'`，
> 渲染层的 `getSongParts()` 看到条目有 `bvid` 就返回 `{ song: 'bv:xxx', singer: '' }`，
> 主进程的 `api:searchSong` 认出 `bv:` 前缀就原样返回那一条 ——
> 于是「播一条已知 bvid 的视频」要先跑一趟搜索接口。
>
> 三个代价：
>
> 1. **请求是纯消耗**：那次搜索的结果恒等于它自己，`ord` / `favorites` /
>    高亮标题这些列对视频毫无意义，却要跟着写和维护；
> 2. **一张表两种语义**：`song_videos` 既装「真候选」又装「假关系」，
>    所有「清理候选」的语句都得额外写 `NOT LIKE 'bv:%'` 才不误删收藏夹条目；
> 3. **`搜索词` 这个变量里混进了 bvid**：下游每个用法都得先想「这会不会是视频」。
>
> 现在 `song_videos` 只剩真候选。老库里可能还留着 `bv:` 行 ——
> `cache.clearAll()` 里那句 `DELETE FROM song_videos` 会顺带清掉这些残行，那是清理历史数据，不是活代码。

**`keyword` 参数因此只剩音乐在用**：`api:resolveVideo` 的第二个参数现在是「缓存键」，
歌传 `歌名-歌手`（用于读候选缓存、解析后回写 `song_meta.selected_bvid`），
**视频传空串**（主进程据此走「按 bvid 直接取地址」那条路）。

#### 2. 四张表各管什么

| 表 | 一行代表 | 关键列 |
| --- | --- | --- |
| `videolists` | 一个列表 | `id`（`bv_fav_123` / `bv_local_xxx`）、`kind`（`fav`/`season`/`series`/**`local`**）、`source_id`、`mid`、`last_index` |
| `videolist_items` | 列表里的第 N 条 | PK `(list_id, bvid)`；`ord`、`favorites`、`origin`（`sync`/`local`） |
| `videos` | 视频实体 + 播放地址 | `bvid` 主键，全局一份 |

**列表归属只看 `videolist_items`**，和 `song_videos`（音乐的候选关系）没有任何交集 ——
同一个 bvid 可能既是某首歌的候选视频、又是某个收藏夹的条目，这两件事互不影响。

**OV 里的收藏挂在 `videolist_items.favorites` 上**：同一个 bvid 可以同时在收藏夹 A
和本地列表 B 里，在 A 收藏了不该让 B 也变实心。
收藏 = 置顶（事务里 `ord` 归零、其余 +1），取消收藏位置不动 —— 与 `cache.setFavorite` 同一套。

`origin = 'local'` 是「手动添加」，同步时**必须保留**（B 站上根本没有它，删了就再也找不回来）。
合并规则：`保留 = favorites=1 OR origin='local'`，其后接本次拉到的新条目。

**导入只写关系、不写地址**：500 条 = 500 行很窄的条目 + 500 行很窄的实体，
**不是** 500 份 dash（那是几十 MB + 500 次请求，必被风控）。地址在第一次播放时
由 `cache.updateVideoResult()` 自动补。

#### 3. 硬过滤 / 打分必须绕过

`rankVideos` 里三条规则对视频条目全是致命的：

- 「标题必须含歌名」→ 收藏夹里的标题和「歌名」毫无关系；
- 「时长窗口 ±90s」→ 一条 45 分钟的游戏录播直接判死；
- 「歌手名命中 +100」→ 视频没有「歌手」这个概念。

现在这不是「绕过」而是**结构上碰不到**：`rankVideos` 只在 `api:searchSong`
写库前调用，而视频条目压根不走搜索接口。
**不要**为了「统一入口」把视频塞回搜索链路 —— 那等于把音乐场景的规则硬套到视频上。

#### 4. `last_index` 必须按 bvid 重定位

`videolists.last_index` 是**下标**。收藏夹按收藏时间倒序，用户新收藏一条，全体原点 +1 ——
不同步的话下次打开就在播「上一条」。

`syncVideoList()` 的做法：同步前记住「现在播的那条的 **bvid**」，
同步后在**新列表**里找它的下标；找不到（被移出列表）就保留原下标并夹进范围
（效果是「下一条顶上来」）。这与音乐歌单 `syncPlaylist` 里那段是同一个坑，
只是那边靠 `toCacheKey` 反查、这边靠 bvid（更简单，条目天然唯一）。

#### 5. 「当前在播哪个来源」落在设置里

`songs` 只有一个数组，所以「这次打开该从哪个来源续播」必须有落盘的地方：
`player.activeVideoListId`（`''` = 音乐歌单）。启动时：

```
读设置 → 找到那个列表 → videoListsStore.setActive(id) → tryResume() 走同一条路
                        ↘ 列表已被删 → 把设置清回 ''（否则 fromVideoList 永远为真，
                                        界面会按视频列表的文案渲染一个空来源）
```

store 里两件事因此必须**成对**做：`setActiveVideoList()`（`actions/library.ts`）
同时改 store 与设置；`recordPlayPosition()`（`actions/system.ts`）按来源分别写
`playlists.last_index` / `videolists.last_index`。
写错表不会报错，只会表现成「重启后位置回到第一条」—— 所以都收敛在一个函数里。

#### 6. 渲染层：两种条目共用一套展示

`songs` 是 `PlayItem[]`，里面可能是歌（`PlaylistSong`：`name`/`singer`/`album`），
也可能是视频（`VideoListItem`：`title`/`author`/`pic`）。列表面板（`SongVideoListDialog.vue`）
拿到的是同一批东西，**它不关心是哪一种** —— 取值统一走一套「谁有算谁」：

```ts
const fieldsOf = (item) => item as unknown as ListItemFields
nameOf  → f.title ?? f.name ?? ''
singerOf → f.author ?? f.singer ?? ''      // 视频用 author，歌用 singer
coverOf → normalizeImageUrl(f.pic ?? f.cover)
```

**为什么不直接 `if (isVideoItem(item))` 分叉**：面板里装的形状比类型还多一种 ——
MV 的「视频列表」面板装的是搜索接口回来的裸 `BiliVideo`（`title`/`pic`/`author`），
OV 的面板装的是列表条目。按字段兜底一份，比在模板里分三种情况少写一半代码；
**类型判别留给业务层**（`player/items.ts` 的守卫），展示层只负责把能显示的显示出来。

漏了「两种字段都收」这条会表现成「视频列表里所有行标题空白 / 封面兜底图标 / UP 主为空」
—— 因为 `PlaylistSong` 上没有 `title` / `pic` / `author` 三个字段。
过滤同理：`haystackOf()` 把 `title/name/singer/author/album` 全拼进去，
否则搜视频条目一条都搜不到。

#### 7. 界面入口：两个工作区共用一个管理器位置

工作区（`queue.mode`）是**播放源的投影**，不是可写的状态：

```
mode = fromVideoList      ? 'ov'   // 在播视频列表（列表还在，或这条本身就是视频）
     : songs.length > 0   ? 'mv'   // 在播音乐歌单
     :                      'ov'   // 什么都没有（空库 / 刚装）→ 默认视频列表
```

它决定三件事：管理弹窗默认停在哪一页、主界面列表面板显示哪一份、控制栏有没有「歌曲列表」按钮
（OV 里没有「歌」这一层，那个按钮不渲染；「视频列表」按钮两个工作区都有，
只是装的东西不同：OV 是合集条目，MV 是这首歌的备选）。

```
openManager(page) = 打开该页的管理器（不碰工作区）   // 不传 = 按当前工作区
```

- **打开弹窗不改工作区**：点「歌单管理」只是弹窗换页，主界面仍然跟着正在播的那一边。
  改工作区的唯一途径是**播放**（拖入 / 点列表条目 / 切歌单）。
  早期这里是 `switchMode(page)` 顺手写设置项 `ui.mode`，结果点一下按钮就把界面切成
  另一边、而播放还在原地 —— 两套状态打架，那个设置项已经删掉。
- **播放不打断**：`songs`（播放队列）不动，只有点新列表里的一条才会换源。
  因此渲染层有**两份列表**：`songs`（在播）与 `browseSongs`（在看）。
  `browseIndex` 用 `keyOf(item)`（视频 = `bvid`，歌 = `歌名-歌手`）在 `browseSongs` 里
  找正在播的那一项，找不到就返回 -1 —— 直接拿 `currentIndex` 当高亮会点亮错的那一行。
- **浏览哪个列表**单独记在 `browseVideoListId`，与「正在播哪个列表」（`activeVideoListId`）分开：
  打开弹窗只换「在看哪个」，播放源不动。

左上角入口（`PlaylistPanel`）显示的名字按模式走，点开的管理页也跟着模式走。

**「新建列表」是视频管理唯一的建列表入口**（和歌单管理的「新建歌单」对称）：
一张内联表单，选「内容来源」四选一，其余字段跟着变。

| 来源 | 走哪条路 | 是否需要登录 |
| --- | --- | --- |
| 空列表 | `videolists:createLocal` | 否 |
| 粘贴链接 | `api:parseListInput` → `videolists:add(kind, sourceId, mid)` | 否 |
| 收藏夹 | `api:myFavFolders` → `videolists:add('fav', fid)` | 是（只读自己的收藏夹） |
| 订阅合集 | `api:mySubLists` → `videolists:add(kind, id, mid)` | 是 |

**「收藏夹」和「订阅合集」的清单是封面网格，不是下拉菜单**：两个清单的标题高度同质
（「默认收藏夹」「我的收藏」「收藏夹1」…），下拉里只剩一行字，选一次得逐行读；
封面能一眼认出来。所以两个接口都额外带一个 `cover`（协议相对地址原样返回，
渲染层用 `normalizeImageUrl` 补协议 —— 和 `upsertVideoMeta` 存封面同一套分工）。
选中项加边框 + 底色 + 标题变强调色，和左边列表行的 `.sel` 是同一套观感。

**为什么「收藏夹」和「订阅合集」是两个来源而不是一个**：它们是 B 站上**两件不同的事**，
接口也不同（一个是「我创建的」，一个是「我收藏的」）：

```
我创建的收藏夹   x/v3/fav/folder/created/list-all?up_mid={自己}   → data.list[] { id, title, media_count }
我收藏的（别人做的）列表
                 x/v3/fav/folder/collected/list?up_mid={自己}&pn&ps&platform=web
                                                                  → data.list[] { id, fid, mid, title, media_count, type }
```

**`collected/list` 一个接口带回两种东西，靠 `type` 分**：

| `type` | 是什么 | 怎么用 |
| --- | --- | --- |
| `21` | 视频合集（UGC season） | `id` = season_id，`mid` = **原作者** mid → 走 `videolists:add('season', id, mid)` |
| `11` | 收藏的收藏夹 | `id` 是全局 fav id、`fid` 是收藏夹 id，media_id 语义和合集不同 —— **不收** |

⚠️ **这里踩过一个坑，记下来别再犯**：一开始按名字猜了两个路径
（`x/space/fav/season/list`、`x/space/fav/series/list`），前者返回 `-404 啥都木有`，
后者直接是一个 HTML 404 页面 —— 于是「订阅合集」整个入口点开就是 404。
真实的入口就是上面那个 `x/v3/fav/folder/collected/list`（`Bili23-Downloader_B站接口清单.md` 3.2）。
**猜接口路径的代价是「功能看起来做了、其实没通」，而单测和 typecheck 都发现不了。**

**失效的合集（`mid = 0` / `media_count = 0`）不进清单**：收藏夹里被删掉的合集仍留在列表里
（标题就叫「该合集已失效」），它的 `mid` 是 0，导进来只会得到「读取合集失败」。

**`mid` 必须是作者 mid，不是自己的**：拉合集内容（`seasons_archives_list` / `series/archives`）
要的是**作者**的 mid，而这个值只有主进程拉清单时才知道。所以渲染层拿到的是
`{ kind, id, mid, title, count }` 整套，不能只回传一个 id —— 补不出 mid 就等于拉不到内容。

**下拉的 value 带 kind 前缀**（`season_456`）：现在只会出现 `season`，但前缀留着 ——
将来若真接上「系列」，两套 id 是不同命名空间、会撞号。

#### 8. OV 下的播放控制：只换文案 + 一道刹车

`next()` / `prev()` 的**结构没有第二套**，仍是「算下标 → `playAt(index)`」，
环绕规则也一样（最后一条再点下一个回到第一条）。差别只有三处：

| 位置 | MV | OV |
| --- | --- | --- |
| 控制栏文案 | 上一首 / 下一首 | 上一个视频 / 下一个视频 |
| 歌曲列表按钮 | 显示（打开歌单） | **不渲染**（没有「歌」这一层） |
| 视频列表按钮 | 显示（当前这首歌的备选） | 显示（当前合集 / 收藏夹的全部条目） |
| 预热 | 搜索 + 解析 + 拉起开头两秒 | **只解析地址**，不开隐藏流 |

**失效刹车**（`OV_MAX_AUTO_SKIP = 5`）：列表条目是外部数据，已删除 / 私享 /
充电专属 / 地区限制很常见，而 `videoError` 的既有行为是「失败两次 → `next()`」。
整片失效时会一条接一条地跳、每条发两次解析请求，几轮就踩 412。
所以 OV 下连续 5 条取不到地址就停下，留一条提示（点它继续）。
计数在 `onVideoPlaying` 里归零 —— 只要有一条真的播起来，就说明不是连片失效。

**置顶重排后必须按 bvid 重新定位**：收藏 / 手动添加会把条目挪到 `ord = 0`，
全体下标 +1。`refreshBrowseAfterEdit()` 重读列表后，按 bvid 找回正在播的那一条并
修正 `currentIndex`，同时重建随机表与预热槽位（它们都按下标算）。
不做这一步，用户点「下一个视频」会跳到意料之外的一条。

#### 9. 拖入导入（把链接扔进窗口）

拖进来的东西有四种可能，各自对应一条**不同的进料管**，所以第一步必须是「认出它是什么」：

```
drop → api:classifyDrop（主进程，只读不联网）
        ├─ music  : 音乐**歌单**链接 → 切 MV → music:importPlaylist → 导入/同步 → 播第一首
        ├─ song   : 音乐**单曲**链接 → 切 MV → music:importSong → 追加进默认歌单 → 播它
        ├─ list   : parseListInput() 认得收藏夹/合集/系列 → 切 OV → videolists:add → 从 last_index 播
        └─ video  : 文本里有 BV 号 / b23.tv 短链        → 切 OV → videolists:addItemToDefault → 播第 1 条
```

**「歌单还是单曲」由 `classifyMusicInput` 判**，不是 `dropInput.ts` 自己写正则：
三个平台的单曲页形态完全不同（网易云 `/song?id=`、QQ `songDetail/<mid>`、酷我 `/play_detail/<id>`），
这套知识必须和「怎么解析」放在同一个模块（`music/index.ts` + 各音源的 `isSongUrl`），
否则又会出现「识别说单曲、解析当歌单」的漂移 —— 这正是识别放在主进程的原因，同一个理由。

**为什么识别放主进程**：三类链接的规则本来就都在那边（`detectSource` 按 host 判平台、
`parseListInput` 认七八种地址形态、`parseVideoInput` 处理短链跳转）。
渲染层再抄一份正则，迟早会出现「粘贴能导入、拖进来认不出」。

**顺序**：音乐 → 列表 → 视频。越具体的规则越先跑：B 站列表链接里也可能带 `?bvid=`，
而音乐平台的分享文案里也可能有纯数字 id。各类 host 互斥，实际不会抢。

**渲染层只做三件事**：拦事件、给遮罩、按 `type` 调一个接口。

| 事情 | 做法 |
| --- | --- |
| 为什么必须 `preventDefault` | `dragover` 不拦，Electron 会把拖进来的链接当**页面导航** → 窗口白屏 |
| 遮罩 `pointer-events: none` | 它只是提示；吃掉鼠标事件就连 `drop` 都收不到 |
| `_dragDepth` 计数 | `dragenter` 在**子元素之间移动**时也触发，只用布尔值会在第一次 `dragleave` 就误判「离开窗口」，遮罩一闪一闪 |
| `drop` 里才读 `getData` | `dragover` 阶段浏览器出于安全把内容清空，只留 `types` |
| 取文本顺序 | `text/uri-list` → `text/plain` → 从 `text/html` 抠第一个 `href` |
| 本地文件 | **不支持**：播放链是围着「bvid → dash → MSE」建的，多一条本地文件源要动缓存键 / 封面 / 续播 / 托盘媒体信息，留给单独一期 |

**「已有就同步」不另写一套**：视频列表的主键是 `平台kind_平台id` 拼出来的，
`addVideoList` 天然幂等（`ON CONFLICT(id) DO UPDATE` + `applyRemoteItems` 的合并规则），
所以重复拖同一个收藏夹 = 先同步再切过去播。音乐歌单靠 `music:importPlaylist`
在**主进程**里按「主键或 sourceUrl」找已有记录，只刷新曲目、保留名字 / 同步设置 / 播放位置。

#### 10. 默认列表与默认歌单（拖入的落点）

单条视频进来总得有个列表放。每次问「放哪个」太啰嗦，随手新建又会攒一堆「本地列表N」，
所以固定一个落点：

```
ensureDefaultVideoList():
  ① 设置 player.defaultVideoListId 有值且那一行还在 → 就是它
  ② 没有 / 失效 → 认「最早的本地列表」（老库升级上来就是这条），并把 id 写回设置
  ③ 一个本地列表都没有 → 建一个「默认列表」（create:false 时跳过）
```

- **启动时**：只在 `videolists` 彻底为空（第一次打开）时 `create: true` ——
  老用户已经有列表了，不该被硬塞一个。
- **删不掉**：`removeVideoList` 里先比 `defaultListId()`，命中直接返回 false；
  界面上按 `VideoListRecord.isDefault`（主进程填）把删除按钮禁用。
  删了它下次拖视频还得悄悄再建一个，用户看到的是「刚删又冒出来」。
- **改名不影响身份**：标记存在设置项里，不是靠名字匹配 —— 改叫「我的片子」它还是默认列表。
- **`isDefault` 不是在 SQL 里算的**：`toRecord` 拿调用方传进来的 `defId` 比对，
  `getVideoLists` 只读一次设置（否则每行都 `structuredClone` 一遍整个配置）。

#### 10b. 本地歌单与平台歌单

歌单分两类，**类型在创建时就定下，之后不变**：

| | 平台歌单 | 本地歌单 |
| :--- | :--- | :--- |
| id | `平台_平台歌单id`（`tx_8153225605`） | `pl_default` / `pl_<uuid>` |
| 怎么认 | — | `isLocalPlaylistId()`：`pl_` 前缀 |
| 链接 | 身份，用来重新解析 | **只是导入器**，导完不留 |
| 同步 | 有 | **没有这个概念** |
| 曲目 | 只读（去平台上改） | 随便增删 |
| 应用内能改什么 | 只有同步方式 | 名字 + 曲目 |

**为什么用 id 前缀判定、不加 `kind` 字段**：id 在这个项目里本来就是身份
（`songs.id` 带音源前缀是同一个理由）。加一个字段，就等于允许
「id 说是 QQ 歌单、字段说是本地」这种自相矛盾的状态存在。

**本地歌单里的链接 = 一次性导入**。贴链接保存 → 解析 → `mergePlaylistSongs` 合并
（先按 `songId()`、再按 `toCacheKey()`，命中就跳过）→ **不保存链接**。
这就是复合歌单的实现方式：不是「同时同步多个源」，而是「每个源各导一次，攒进同一个列表」。
如果保存了链接，它就会跟着同步、下次用远端曲目**整体替换** —— 手动加的歌静默消失，
那正是要避免的第三种状态。

**平台歌单在应用内不能改曲目**：编辑表单里曲目只读，`updatePlaylist` 也会把 `songs` 剔掉。
要加减歌请去平台操作，否则下次同步会被覆盖回来。名字同理 —— 而且同步时**无条件以远端为准**，
用户在平台上改了名，这边同步一次就跟上，列表里不会挂着旧名字。

**平台 → 本地是单向的**（`convertPlaylistToLocal`）：换新 id（`pl_<uuid>`）、
`url` / `sync` 清零，曲目与 `lastIndex` 保留。换 id 是因为「是不是本地」看前缀，
留着 `tx_xxx` 会造出自相矛盾的记录。两条 UPDATE 在同一个事务里
（`playlist_songs` 没声明外键，不会级联，必须手动把 `playlist_id` 指过去）；
同步进行中不允许转换 —— 否则 `syncPlaylist` 回来时会写到已经不存在的 id 上。
反方向（本地 → 平台）不做：本地歌单没有平台身份可以去对齐。

**本地歌单的不变量**（`source` / `sourceUrl` 为空，`sync` 为 off，`lastSyncAt` 为 null）
在 `normalizeRecord`（写库前）和 `toRecord`（读库后）各强制一次；
界面与 store 只是前两道栅栏，绕过它们也造不出脏数据。

##### 默认歌单（拖入单曲的落点）

音乐这边也有一个，但**实现比视频那边简单一档** —— 关键差别是「默认的那一个是不是用户已有的」：

| | 视频列表 | 音乐歌单 |
| :--- | :--- | :--- |
| 身份存在哪 | 设置项 `player.defaultVideoListId` | 固定主键 `pl_default` |
| 怎么认 | 拿设置项和每行比 | `id === 'pl_default'`，一次字符串比较 |
| 兜底 | 三级（设置 → 最早的本地列表 → 新建） | 一级（没有就建） |
| 标记怎么来 | `toRecord` 里比对设置项 | `withDefaultFlag()` 在两个出口贴 |

视频那边必须记设置项，是因为默认列表**可能是用户已有的任意一个列表**（老库升级时认「最早的本地列表」）；
歌单这边默认歌单是我们自己建的、只有这一个，钉死主键就没有「设置项指向一个已经被删掉的 id」这种漂移。
**「和列表那边一样」指的是行为一样，不是实现逐行照抄。**

**它作为本地歌单，只有一条特殊规则：删不掉。** 三道闸：界面按钮 `:disabled="isDefault"` →
`playlists` store 的 `removePlaylist` 返回 `false` → 主进程 `savePlaylists` 发现集合里没有
`pl_default` 就把它补回去（曲目以内存那份为准）。第三道不是多余的：这边的持久化是
**整份覆盖**，绕过 store 直接改数组也能把它删掉。
（改名、填链接导入、拖入单曲这些它和普通本地歌单一样，没有额外限制。）

**去重是两层的**，不能只比 `songs.id`：

| 怎么进来的 | `songs.id` |
| :--- | :--- |
| 从平台拖单曲 | `wy_347230` |
| 歌单管理里手动填 `海阔天空-Beyond` | `海阔天空-Beyond` |

同一首歌会有两种 id。只比 id 的话拖一次就多一行，所以先按 id 精确命中，再按缓存键（`歌名-歌手`）兜一层，
命中了就**定位过去**（把 `lastIndex` 挪到它），不重复插。

**本地歌单导入走的是同一套判重**（`mergePlaylistSongs`，在 `common/types/playlist.ts`）——
两处规则要是各写一遍，早晚会出现「拖进来不重复、导入进重复」这种说不清的行为。
代价是同一个名字同一歌手的 live 版和原版会被判成重复，这是刻意选的：宁可少一行，
也不要在复合歌单里出现两条一模一样的歌名。

**单曲解析只接了网易云和 QQ**：

- 网易云复用歌单解析里那个明文 `api/song/detail`（`fetchSongDetail([id])`），不引入 LX 的 weapi 加密 ——
  少一层加密就少一处会在平台改版后失效的东西；
- QQ 照 LX 的 `musicSdk/tx/musicInfo.js`：`music.pf_song_detail_svr` 的 `get_song_detail_yqq`，
  返回的 `track_info` 和列表接口的歌曲项同构，直接复用 `toSong()`，保证两条路产出的 `platformId` 一致；
- 酷我**只判断不解析**（`isSongUrl` 有、`getSongDetail` 没有），导入时明确报「酷我的单曲链接还没接入」——
  比让它当歌单去解析、最后报「无法解析出歌单 ID」清楚。

**混平台对播放没有影响**：`songs.id` 带音源前缀（QQ 的 `123` 和酷我的 `123` 是两首不同的歌），
而播放跟音源平台**无关** —— 搜的是 B 站 MV，音乐平台只提供「这首歌叫什么、谁唱的、多长」。
所以一个歌单里混三个平台的歌是安全的。

**空库提示的判据跟着改了**：原来是「列表数量 = 0」，现在自动建了默认列表，这个条件永远不成立。
改成按**条目**算（OV：所有列表的 `itemCount` 加起来是不是 0；MV：有没有歌单），
文案也换成了「把链接拖进窗口」为首选路径。

#### 11. 本地视频文件（拖自己的片子进来）

这一节的结论一句话：**本地文件被当成「一条 bvid 长得像 `lf_xxx` 的视频」**，
所以播放、收藏、置顶、续播、托盘媒体信息全部继承现成的链路，一条分支都没加。

```
拖入 mp4 → webUtils.getPathForFile() 拿真实路径
        → videolists:importLocal（主进程：登记 + 挂进默认列表）
        → bvid = 'lf_' + sha1(规范化路径)[0:16]
        → 起播（走的是和「拖单条 B 站视频」完全相同的那条路）
```

**身份为什么是路径哈希，不是文件名 / 大小 / inode**：用户心里的「这个是同一个片子」
就是那个文件。路径哈希天然满足「重复拖不会攒出两条」，而 inode 换个盘就变、
文件名可以撞。Windows 上还先转小写（`D://A.mp4` 和 `d://a.mp4` 是同一个文件）。

**路径存在 `videos.durl_url`，不新增列**。`durl_url` 的语义本来就是「一个能直接塞进
`<video src>` 的完整地址」，本地文件是同一语义，只是地址由我们自己的协议生成。
这一条换来的是：**表结构不变 → 指纹不变 → 不触发整库重建**，现有歌单 / 列表 / 收藏无损。
代价是「`durl_url` 里可能是路径」这件事必须让三处知道，见下。

**库里存路径、不存 URL**：路径是事实、URL 是派生的（换协议名不该让全库数据失效）；
文件名里可能有 `#` / `?` / `%` / 中文，塞进 URL 要 encode，存进去再读出来容易二次编码 ——
而 `#` 之后会被当成 fragment，直接播错文件。

**地址怎么给播放器：`blwe-media://local/<bvid>`**

渲染层 origin 是 `blwe://app`（打包）或 `http://localhost`（开发），两种都读不了
`file:///D:/x.mp4`。所以主进程开一个自己的协议，查库拿路径、流式吐回去：

| 要点 | 为什么 |
| --- | --- |
| 自己实现 `Range` → 206 | 拖进度条时 Chromium 发 `Range: bytes=N-`；`net.fetch(file://)` 只给整份 200，每次 seek 都从第 0 字节重读 |
| URL 里只放 bvid，路径回查库 | 这个协议只放得出去「用户登记过的文件」，不是任意文件读取器 |
| 声明 `Accept-Ranges: bytes` | 不声明的话 Chromium 连 Range 都不发，直接整份读 |
| `standard + secure + stream` | `stream` 是视频流必需；前两个让它的行为等价于 https 页面 |
| 文件不存在 → 404，**不删库里的行** | 可能只是拔了移动硬盘；界面上的「重新定位」见下一节 |

⚠️ **踩过的坑：`protocol.registerSchemesAsPrivileged` 一生只能调一次**，第二次会被
**静默忽略**（不报错、不警告）。原来 `blwe://` 是在 `protection.ts` 里自己注册的，
新的 `blwe-media://` 再调一次的话，后者根本没注册成 standard / secure / stream ——
表现是「能导入、点了没画面」，控制台一片安静。现在各模块只交出 `*SchemeDescriptor()`，
`main/index.ts` 里**合并成唯一一次**注册。

**三处必须让路**（都不改 schema，只是加判据）：

| 位置 | 不改会怎样 |
| --- | --- |
| `cache.clearExpiredPlayurl` | 本地文件没有 `playurl_at` → 每轮清理都把路径当过期地址抹掉 |
| `cache.clearAll`（设置里「全部清除」） | 无条件清地址列 → 一点就把所有本地条目的路径洗掉；现在按 `lf_` 前缀豁免 |
| `api:resolveVideo` 开头 | 不短路的话会先 `ensureLoginState()`（打 B 站 nav）、再把 `lf_` 的 bvid 当 B 站视频去解析；并且 `updateVideoResult` 会把路径覆盖成 B 站直链 |

短路位置**必须在 `ensureLoginState()` 之前**：本地文件跟账号无关，
断网 / 未登录时播自己硬盘上的片子不该先卡一次网络。

**时长与「能不能播」：不用 ffmpeg，用探针**

`<video preload="metadata">` 挂上 `blwe-media://` 等 `loadedmetadata`，一次拿到时长，
顺便**实测**容器能不能解。不引 `ffmpeg-static` 的理由：

- **它换不来格式支持**：播放器是 Chromium，ffmpeg 在不在，mkv / HEVC 该播不了还是播不了
  （要做「转封装」那是另一整套后台任务）；
- 体积：单平台 ~80MB，三平台两三百 MB，而整个依赖才 4 个轻包；
- **一致性**：探针用的就是待会儿真播放的那个解码器，结论必然一致；
  ffmpeg 说「没问题」不代表 Chromium 能播。

探针在渲染层（媒体元素只在渲染层），但它只**测量**：时长通过现成的
`api:fillVideoDuration` 回写主进程。用完必须 `removeAttribute('src')` + `load()` ——
Windows 上媒体元素只要还持有文件句柄，用户就删不掉 / 改不了名。

**拖入取路径必须走 preload**：Electron 32 起 `File.path` 已移除，
渲染层拿到的是个没有任何路径信息的 File。preload 里 `webUtils.getPathForFile(file)`
同步换一下即可（无 IPC）。

**格式认不认得出 ≠ 能不能播**：扩展名白名单（`VIDEO_EXTS`）只用来别把 zip / jpg 当视频，
真正的判据是探针。所以 `mkv` / `avi` / `ts` 也照收 —— 解不出来时提示编码不支持，
比「连列表都进不去、且不知道为什么」好。

#### 12. 本地文件被删 / 移走了怎么办

本地文件的地址是**用户硬盘上的一个路径**，所以「播不了」是常态而非异常：删了、
改名了、移动硬盘没插、网络盘掉线，全会让同一个 `lf_xxx` 从能播变成播不了。
这一节的原则只有两条：

1. **永远不自动删库里的行** —— 文件暂时不在 ≠ 用户不要这条。删不删由用户点。
2. **给得出退路** —— 「重新定位」是主路径，「从列表移除」是备选，
   而不是「弹个红条然后让用户自己去视频管理删掉重拖」。

**三个时机，三层处理**：

| 时机 | 谁发现 | 用户看到什么 |
| --- | --- | --- |
| 打开视频管理 / 切列表 | `videolists:getItems` 顺手 `stat` 一遍，回填 `missing` | 那一行压暗 + 红色「文件丢失」标 + 「定位」按钮 |
| 点开播 / 自动切到它 | `api:resolveVideo` 的 `stat` 失败 → 回 `code: 'LOCAL_MISSING'` | 弹「重新定位文件 / 从列表移除」确认框 |
| 播放中途文件被删 / 移走 | `blwe-media://` 404 → `<video>` 报错 → `videoError` | 先问一次 `local:exists` 再决定弹哪个（见下） |

**为什么「丢失」要单独一个错误码，而不是看错误文案**：界面要靠它决定弹哪个框。
拿中文字符串当契约，改一次文案就断一处逻辑，而且 `typecheck` / `build` 一个字都不会提醒。
`code: 'LOCAL_MISSING'` 也顺便让它**不占用 OV 的连续失败刹车** ——
那个刹车是给「B 站条目失效（已删 / 私享 / 充电专属）」用的，文件丢了跟它不是一回事，
混在一起只会让「跳 5 条就停」的规则被本地文件提前触发。

**播放中失败必须再问一句 `local:exists`**，因为 `<video>` 的 `error` 事件分不清两种原因：

- 文件**不在了** → 弹重新定位；
- 文件**还在** → 是解码不支持（HEVC / 10bit / mkv 在 Chromium 里就是黑的），
  这时弹「重新定位」是误导，用户会去挑另一个文件，问题依旧。所以只报一句编码不支持。

顺带一个连带结论：**本地条目不走 `videoError` 那条「跳过缓存重试一次 → 跳下一条」**。
对本地文件，重试是纯粹浪费（没有缓存、没有签名过期），跳下一条更糟 ——
用户要的是把文件指回去，不是绕过它。

**重新定位只改 `durl_url`，不改 bvid**

bvid 是身份的锚点：`videolist_items.bvid`（列表位置）、`videolist_items.favorites`（收藏）、
`videos.bvid`（视频实体与播放地址）、`song_meta.selected_bvid`（续播）全都引着它。
为了「路径变了身份也变」去做一次主键迁移，就要把这些引用逐个跟着改 —— 漏一处就是一条孤儿数据。
而用户的语义本来就是「**同一条**记录，文件换了个位置」，不是「换了一条视频」。
所以路径只是记录的一个属性，改它就行：列表顺序、收藏、播放进度**一处都不用动**。

**代价（已知取舍）**：bvid 是路径哈希，所以同一份文件如果**再次从新位置被拖进来**，
会算出另一个 bvid，得到第二条记录（老那条也指向同一文件）。这个无法在重定位那一刻
消除（老记录的列表引用还在），因此只回报 `duplicate: true` 让界面提一句，不影响播放。
真要做合并，得先把两个 bvid 的列表引用 / 续播指针统一，那是另一个量级的改动。

**为什么 `missing` 只在 IPC 层异步算、不落库**：

- `getVideoListItems()` 是**同步**函数，内部还有同步流程在用。`stat` 一个掉线的网络盘
  能阻塞好几秒，同步版会直接把主进程冻住（连带界面卡死）。所以在
  `videolists:getItems` 这层 `Promise.all` 并发摸一遍，B 站条目一次 IO 都不做。
- **不落库**：文件可能只是暂时不在（拔了硬盘、盘符没挂上），落库就要维护一套
  「什么时候重算」的逻辑，而且一次误判会把「这条坏了」永久写进数据里。
  现在这一屏的标记只活在这一屏，插回来重新打开列表就自动恢复了。

**没有做「文件系统监听」**（`fs.watch` / `chokidar`）：跨盘 / 网络盘不稳，
几百个文件的监听器开销也不小，而收益只是「不用重新打开列表就能看到状态变化」。
失效判定放在「用户要看的时候」已经够了。

### 数据存储（SQLite）

> **⚠️ 字段仍在调整中** —— 这份 schema 是当前实现，用户（本人）后续还要再看一遍字段设计。
> 改字段时**不需要**手动升版本号：`user_version` 存的是建表语句的**哈希指纹**（见下），
> 改了 `CREATE_TABLES_SQL` 指纹就变，重启即自动重建。但记得同步这一节。

数据层是 **SQLite 单库**（`better-sqlite3`），库文件在 `userData/blwe.db`，
连接 / 建表 / 事务都在 `electron/main/utils/db.ts`。

**为什么从 JSON 换成 SQLite**：原来的数据被拆在「一堆 `search-cache/*.json`」和
`playlists.json` 两处，于是要用「文件级 TTL + LRU 淘汰」来模拟数据库的过期，
还要靠「读-改-写整个文件」来做部分更新 —— 而这些正是 SQLite 一句话能解决的事。
换掉之后最直接的收益是**过期语义能落到字段级**（只清播放地址，见下）。

**五张表 + 一个视图 + 三个索引**（用 `PRAGMA user_version` 存**建表语句的哈希指纹**当闸门）：

```sql
-- 歌单
--
-- id = 平台_平台歌单id（如 tx_8153225605），**不是随机 UUID** ——
-- 这样同一个歌单重复导入会自然命中同一行，而不是攒出一堆副本。
-- 手动新建（没有分享链接）的歌单没有平台 id，那时用 pl_<uuid> 兜底。
CREATE TABLE IF NOT EXISTS playlists (
  id               TEXT PRIMARY KEY,
  name             TEXT    NOT NULL,
  url              TEXT,              -- 歌单分享链接；自动同步靠它重新解析（原 source_url）
  sync_mode        TEXT    NOT NULL DEFAULT 'off',   -- off | startup | interval
  sync_interval_ms INTEGER NOT NULL DEFAULT 0,
  last_sync_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_index       INTEGER NOT NULL DEFAULT 0        -- 上次播到第几首（**下标**，见下）
);

-- 歌曲实体（**全局唯一**，与歌单无关）
--
-- 同一首歌在 2 个歌单 = songs 表 **1 行** + playlist_songs **2 行**。
-- id = 平台_平台歌曲id（如 tx_1828354）；手动添加的歌退化成 歌名-歌手。
--
-- ⚠️ 它**只在这里用**。videos.search_key / song_meta.search_key 存的是**歌名**
-- （歌名-歌手）—— 那些表要拿键去搜 B 站，用 id 搜不出任何东西。
-- ⚠️ **没有 source / platform_id 两列**：两者都编码在 id 前缀里。
CREATE TABLE IF NOT EXISTS songs (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  singer      TEXT    NOT NULL DEFAULT '',
  album       TEXT,
  cover       TEXT,
  duration    INTEGER               -- ★ 秒（原为音乐平台原样给的 "4:03" 字符串）
);

-- 歌单 ⨯ 歌曲 的**成员关系 + 顺序**（不存曲目信息）
CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id TEXT    NOT NULL,
  ord         INTEGER NOT NULL,
  song_id     TEXT    NOT NULL,      -- 指向 songs.id
  PRIMARY KEY (playlist_id, ord)
);

-- 按 song_id 反查歌单（「这首歌在哪些歌单里」）
CREATE INDEX IF NOT EXISTS idx_playlist_songs_song ON playlist_songs(song_id);

-- 每首歌的候选视频 = 搜索结果 + 收藏 + 顺序 + 解析结果
CREATE TABLE IF NOT EXISTS videos (
  search_key     TEXT    NOT NULL,   -- ★ "歌名-歌手"，**不是 songs.id**
  bvid           TEXT    NOT NULL,
  ord            INTEGER NOT NULL DEFAULT 0,  -- 顺序权威（0 起连续）
  title          TEXT,               -- 来自【搜索结果】：含 <em class="keyword"> 高亮
  pic            TEXT,               -- 来自【view 响应】：尺寸比搜索结果里的大
  author         TEXT,
  duration       INTEGER,            -- 秒
  favorites      INTEGER NOT NULL DEFAULT 0,  -- 0/1；「没有这个字段就是 false」在此落成 0

  -- ↓ 解析结果（v2 起拆成结构化列，原来是整包 JSON）
  durl_url            TEXT,          -- 渐进式 mp4；走 dash 时为 NULL
                                     -- ★ durl 的档位编码在这个 URL 里（URL 数字 - 128）
  dash_video          TEXT,          -- 视频轨【完整数组】JSON（含 baseUrl + backupUrl）
                                     -- ★ 同时是档位列表的来源（dash.video[].id）
  dash_audio          TEXT,          -- 音频轨【完整数组】JSON
  dash_duration       INTEGER,       -- dash 总时长（秒）
  -- v4 删掉了 quality（durl 档位从 durl_url 反推）与 support_formats（静态映射，内置表已覆盖）
  playurl_login_state INTEGER,       -- 这份【地址】取时的登录态：0/1/NULL(未知)
  dash_tried          INTEGER NOT NULL DEFAULT 0,
  playurl_at          INTEGER,       -- 上面那批地址的写入时刻（过期判定）
  PRIMARY KEY (search_key, bvid)
);

-- 每首歌的元信息
CREATE TABLE IF NOT EXISTS song_meta (
  search_key         TEXT PRIMARY KEY,
  selected_bvid      TEXT,           -- 这首歌上次播的是哪个视频
  search_login_state INTEGER,        -- ★ 这份【搜索结果】取时的登录态：0/1/NULL(未知)
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_key_ord ON videos(search_key, ord);
CREATE INDEX IF NOT EXISTS idx_videos_playurl_at ON videos(playurl_at);

-- ★ 元数据视图：不含任何地址列
CREATE VIEW IF NOT EXISTS videos_meta AS
  SELECT search_key, bvid, ord, title, pic, author, duration, favorites,
         playurl_login_state, dash_tried, playurl_at
    FROM videos;
```

> **⚠️ `CREATE_TABLES_SQL` 里绝对不能出现反引号**
>
> 上面那段 SQL 是**模板字符串**，而在 SQL 注释里用反引号包标识符（`` `bvid` ``）
> 会**提前终止字符串**，于是后面所有 SQL 都变成 JS 代码 → 一串
> `TS1005` / `TS1443` 语法错误，而报错行指向 SQL 中间，
> **完全看不出根因是"注释里多了个反引号"**。
>
> `db.ts` 里有一条**模块求值阶段**的自检断言（`includes('\u0060')` 就 throw），
> 就是为了让后来者一眼看到真正的原因。这个错作者犯过三次，所以用代码根治。

**★ 为什么把 `songs` 与 `playlist_songs` 拆开**

原来曲目信息直接塞在 `playlist_songs` 里，于是**同一首歌在 2 个歌单就存 2 份**
（歌名 / 歌手 / 专辑 / 封面 / 时长全重复一遍）。现在拆成两张表：

| 表 | 存什么 | 同一首歌在两个歌单里 |
| --- | --- | --- |
| `songs` | 曲目**实体**（歌名/歌手/专辑/封面/时长） | **只有 1 行** |
| `playlist_songs` | `(playlist_id, ord, song_id)` —— 只存「哪个歌单的第几位是它」 | 2 行 |

顺带解决「改一次歌名要改多处」：信息只有一份来源，不会出现 A 歌单显示旧名、
B 歌单显示新名。

**代价是写库变复杂了** —— `writePlaylistsToDb` 不能无脑 `DELETE FROM songs`：
那张表是**全局共享**的，而这里保存的是「歌单集合」，无脑清会把**别的歌单引用的曲目**
一起删掉（关系表还有记录、实体没了 → 读的时候全是悬空引用 → 曲目整片消失）。

所以它这么做：

```ts
// ① 曲目实体用 upsert：同一个 id 可能被多个歌单引用，第二次遇到就覆盖
INSERT INTO songs (...) VALUES (...)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, singer = excluded.singer, ...

// ② 记下本次保存用到的全部 song id
keepIds.add(id)

// ③ 最后只删「没人再引用」的那些
if (keepIds.size === 0) {
  DELETE FROM songs                              // 歌单全删了就整体清空
} else {
  DELETE FROM songs WHERE id NOT IN (?, ?, ...)  // 一条语句，而不是逐个 DELETE
}
```

> 为什么用 `NOT IN (...)` 而不是「查出来逐个比对」：`keepIds` 可能上千个，
> 逐个 `DELETE` 就是上千次语句执行。这里只有一条语句。
>
> `keepIds` 为空时 `NOT IN ()` 是**语法错误**，所以那种情况（歌单全删了）
> 单独走 `DELETE FROM songs` 全清分支。

实测验证过（19 项断言全过）：两歌单共有 1 首歌时 `songs` 表 3 行 / 关系表 4 行；
删掉一个歌单后，**只有它独有的歌被清掉、共用的那首保留**。

**★ `songs.id = 平台_平台id`（`songId()`），但它只用于 `songs` 表**

- `songs.id` → `tx_1828354`（有平台 id 时）/ `手写的歌-某人`（手动添加、没有平台 id 时退化）
- 带音源前缀是**必须的**：各平台 id 空间独立，QQ 的 `123` 和酷我的 `123` 是两首不同的歌
- **`videos.search_key` / `song_meta.search_key` 存的是「歌名-歌手」**，不是这个 id ——
  因为那些表要拿键**去 B 站搜索**（`-` 会被换成空格），用 `tx_101104624` 搜不出任何东西

```
songs.id          tx_1828354              ← 只在 songs 表内部标识「同一首歌」
videos.search_key 泪海-许茹芸               ← 拿去搜 B 站、当缓存主键
```

两张表**各用各的键**，这是刻意的。

> 踩过的坑（代价很大）：曾经把 `videos.search_key` 也改成平台 id，
> 于是搜索词变成 `《tx_101104624》 歌曲`、分层打分也拿它比对标题 →
> **所有结果全被当"标题不含歌名"挡掉**（日志表现为 `取回231 → 过滤0`）。
> 平台 id 是给数据库用的，不是给人搜的。

**★ `playlists.id = 平台_平台歌单id`（`playlistKey()`）**

| 场景 | id | 说明 |
| --- | --- | --- |
| 有分享链接 | `tx_8153225605` | 重复导入同一歌单**命中同一行**，不会攒副本 |
| 手动新建（无链接） | `pl_<uuid>` | 没有平台 id 可拼，只能兜底 |

`source` **不再单独存列** —— 从 id 前缀反推（`sourceOfSongId()`），
不可能出现「id 是 `tx_` 但 `source` 写了 `wy`」这种自相矛盾。

> ⚠️ 反推时**只认 wy / tx / kw / kg 这几个已知音源**，前缀不认识就返回 `null`。
> 否则 `pl_xxx` 会被解析成音源 `pl` —— 那是个不存在的平台，下游拿去用会静默出错。

**★ schema 闸门是「哈希指纹」，不是手写的版本号**

`PRAGMA user_version` 里存的是 `sha256(CREATE_TABLES_SQL).readUInt32BE(0) & 0x7fffffff`。

原来靠手写的 `SCHEMA_VERSION` 常量当闸门：改表结构就得手动 +1，**忘了 +1**
就会出现「旧库带着旧列结构跑起来、然后在某个查询上报错」—— 而那是**运行时才炸**
的错，最难查。改成指纹之后：

- `CREATE_TABLES_SQL` 有一个字符变了指纹就变 → 自动重建；
- **忘了"升版本"这件事不可能再发生**（根本没有版本号要维护）；
- 开发阶段反复改 schema 不用管版本，改完重启就生效。

代价是**每次改 schema 都会清库**（开发期无所谓）。指纹不匹配时的处理是
**丢弃重建**，绝不写逐字段迁移 —— 理由：本项目只有一个用户、数据层从未发布过，
「升级」只发生在开发机上；而逐字段搬运要处理「旧列可能不存在 / 类型变了 /
JSON 要重新拆成列」三种情况，出错面远大于丢掉重来。

> **副作用要说清楚**：重建会清空**收藏、顺序、选中视频，以及歌单本身**。
> 要保留就得自己先备份 `blwe.db`。

> ⚠️ **DROP 列表必须是动态的，不能手写**
>
> 手写清单会**漂移**：删掉一个功能时很容易忘了把它从 DROP 列表里去去掉
> （或者反过来 —— 新表忘了加）。**踩过**：歌词功能整体移除后，`lyrics` /
> `subtitles` 两张表从建表语句里删了，但 DROP 列表里没有它们，于是
> **每次指纹不匹配重建时都清不掉**，一直留在库里当垃圾。
>
> 现在改成「查 `sqlite_master` 拿全部表名再逐个 drop」：
>
> ```sql
> SELECT type, name FROM sqlite_master
>  WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
>  ORDER BY type DESC   -- 视图先于表：表被删后视图就悬空了，SQLite 不会自动清
> ```
>
> `sqlite_%` 开头的（`sqlite_sequence` / `sqlite_stat1`）是 SQLite 自己维护的，
> **绝不能 drop**。实测清掉了 10 个旧表/视图（含那两个删歌词时漏掉的残留）。

**★ `last_index` 是下标，但同步时会「按歌重算」**

`last_index` 存的是**下标**（不是「哪首歌的 id」）。下标本身是脆弱的：
歌单重新同步后曲目会增删，第 110 个位置可能已经是**另一首歌**了 ——
用户续播会听到莫名其妙的东西。

所以 `syncPlaylist` 在同步时会**把它重算成新列表里的位置**（此刻旧列表和新列表
都在手上，正是做这件事的时机）：

```
① 那首歌还在    → 用它的新下标（位置可能变了）
② 那首歌被删了  → 保留原下标并夹进范围（效果是「下一首顶上来」——
                 播放器的标准行为；干瞪眼或跳回第一首都不如它合理）
③ 旧列表本来为空 → 0
```

匹配用 `songId` 而不是歌名 —— 同步可能同时改了歌名。

**为什么只有一个视图，而且它必须是「元数据」那个**

一行候选的 `dash_video` + `dash_audio` 约 **27 KB**（10 档视频轨、每档 4 个 backupUrl，
签名参数很长），300 行候选就是 **7.5 MB**。而绝大多数读（列候选、合并收藏项、
给渲染层的整包）**只要元数据**。实测（300 行）：

| 读法 | 耗时 |
| --- | --- |
| 全列 `SELECT` | 9.6 ms |
| **`SELECT * FROM videos_meta`** | **0.64 ms**（快 15 倍） |

视图在 SQLite 里是**查询重写**而不是物化，所以它和手写列清单**一样快**
（实测差 0.07 ms，噪声级），但调用方不用记列清单、加列时也不用改多处 SQL。
另一个好处是**视图默认只读**（SQLite 拒绝 `UPDATE` 视图），写操作只能走明确的 `UPDATE`。

> **⚠️ 为什么不再建第二个视图（`videos_playurl`）—— 实测过，不值得**
>
> 直觉上「地址也拆个视图」很对称，但那条读路径**本来就只取一行**
> （`getVideoAddress(key, bvid)`，按主键查）。它必须读 27 KB 的 dash，
> 而省掉的 4 个小列（title/pic/author/duration）加起来不到 200 字节 ——
> **跳过 200 字节不影响 27 KB 的读取**。实测：单行 0.0363 ms → 0.0283 ms（省 0.008 ms），
> 20 行 0.4813 → 0.4790（省 0.002 ms）。**都是噪声级。**
>
> **真正有效的优化不是视图，而是「按 bvid 取一行」本身** ——
> 它把「读 300 行的地址」变成「读 1 行」。这已经由 `getVideoAddress()` 做了。
>
> 同理，`playlists` / `playlist_songs` / `song_meta` **都不需要视图**：
> 行数少、读取低频、列都很小。唯一有点分量的是 `playlist_songs.cover`
> （2000 首时占 0.42 ms），但**封面正是列表要显示的** ——
> 去掉它还得再查一次，反而更慢。

**v2 相对 v1 的四处改动**（都是「字段定稿」时定的）：

| # | 改动 | 原因 |
| --- | --- | --- |
| 1 | **删 `video_details` 表**，解析结果合回 `videos` | 拆表只为省「同 bvid 多键重复」，而那个重复很少见；代价却是每次查询要 `LEFT JOIN`（还得是 LEFT，用内连接会丢掉未解析的候选）、`clearAll` 清三张表、补插记录写两张表 |
| 2 | **删 `view_result`** | 它唯一的用途是取 `title` / `pic`，而这两列本来就有。**注意 view 接口仍然每次都要调** —— 因为 `playurl` 必须带 `cid`，而 `cid` 只能从 view 拿，只是拿完不用存 |
| 3 | **`playurl_result` 拆成结构化列** | 体积大幅下降（原响应含全部 durl 段落、账号权限等一堆用不到的东西）；`playurl_at` / `login_state` 变成可查询的真列 |
| 4 | **`playlist_songs.duration` 改秒** | 原来歌单侧是 `"4:03"` 字符串、候选视频侧是秒，两种形状在下游到处判断 |

**v3 的改动**：

| # | 改动 | 原因 |
| --- | --- | --- |
| 1 | 加 `videos_meta` 视图 | 元数据读取不再拖上 7.5 MB 的 dash JSON，实测快 15 倍（见下） |
| 2 | `getVideoAddress(key, bvid)` | 解析前只读**一行**的地址，而不是从整份列表里翻 |
| 3 | `song_meta.search_login_state` 真正被写入 | v2 只建了列，v3 才在 `api:searchSong` 里记录（未登录时 B 站只返回部分结果，靠它判断要不要重搜） |
| 4 | 收藏置顶改成「前面 +1、自己置 0」 | 原来的 `MIN(ord) - 1` 会让 `ord` 变成负数且不连续（见下） |

**v4 的改动**（用户对字段的最后一轮精简）：

| # | 改动 | 原因 |
| --- | --- | --- |
| 1 | **删 `quality` 列** | durl 的档位编码在 `durl_url` 里：`URL 数字 = quality + 128`（实测 24/24 成立、映射唯一），所以能从 URL 反推，**不丢信息**。反推失败时返回 `null`（角标空着），绝不猜 |
| 2 | **删 `support_formats` 列** | 那是**静态映射**（档位 id → 显示名），`@common/constants` 的内置档位表已覆盖全部 12 档。每行存一份 JSON 纯属冗余 |
| 3 | **不加 `accept_quality`** | `dash.video[].id` 更权威 —— **按 id 分 URL，没有 URL 就放不出来**。而 `accept_quality` 只说明「账号有权限」（实测列出 1080P、durl 却只回 720P） |

净效果：`videos` 从 17 列降到 **15 列**，每行少存约 0.7 KB 的 `support_formats` JSON。

**`dash_video` / `dash_audio` 为什么仍然存 JSON，而且存完整数组**

不能只存「正在播的那一条」，因为**渲染层切换清晰度时是拿缓存里这份全量重新挑一条**
（`extractDashStreams(playurl, wantQn, wantAudioId)`）—— 只存播过的那条，每次切档位
都得重新联网。保留全量还顺带把 **`backupUrl` 留了下来**：原来的提取逻辑
（`dashUrlOf` → `pickNormalCdnUrl`）当场就把备用地址挑掉了，只留一个选中的 URL，
于是某个 CDN 返回 403 时**没法换备用**（代码注释里记着 P2P 边缘节点会 403 的坑）。

> 也就是说：这里的 JSON **不是**「懒得拆字段」，而是「形状由 B 站决定、
> 且必须保全部档位」。能当查询条件或能反推的（登录态 / 时间 / 清晰度代码）
> 都已经拎成了真列或从 URL 反推 —— 见 v4 的改动。

**登录态为什么拆成两个字段**

`search_login_state` 与 `playurl_login_state` 是**不同时刻、不同请求**的快照：
搜索可能几小时前就做了，而播放地址是刚刚解析的。合并成一个字段必然互相覆盖。

而它们各自都**必须用 NULL 表示「未知」**，不能和 `0`（未登录）混为一谈 ——
`ensureLoginState()` 会因为网络抖动返回 `null`，此时把它当成「未登录」，
下次登录后就会判定「这份缓存是未登录时取的」并**白重解析一遍**。
这正是「没退出登录却老在重新解析」的来源之一。

**`ord` 的语义是不变量：0 起、连续**

收藏一条时用一个事务做「**原来排在它前面的依次 +1，自己置 0**」：

```sql
BEGIN;
  UPDATE videos SET ord = ord + 1 WHERE search_key = ? AND ord < :原ord;
  UPDATE videos SET favorites = 1, ord = 0 WHERE search_key = ? AND bvid = ?;
COMMIT;
```

取消收藏**只把 `favorites` 置 0，`ord` 不动**（位置不跳回原处）。

两条 UPDATE 必须在**同一个事务**里：中间态（前面的都 +1 了、自己还没置 0）如果被别处
读到，会出现「有两个 `ord = 0`」的瞬时重复，排序结果不确定。

> **踩过的坑（v2 的实现是错的）**：曾经用 `MIN(ord) - 1` 来置顶，那会让 `ord`
> 变成**负数且不连续**（来回收藏几十次就到 `-50`），`SELECT` 出来根本看不出
> 「哪个是第几」。更糟的是 `save()` 是**按数组下标从 0 重写**的，
> 那些负数**活不过一次重新搜索** —— 等于说那种编码只在两次搜索之间有意义。
> v3 改成上面的写法后，`ord` 恒为 `0..n-1`。
>
> 实测（真实 `cache.ts`）：收藏后 `BV9(ord=0,fav=1) | BV1(ord=1,fav=0)` ✅ 连续。

**收藏与顺序都由 `videos` 承担**（不再是 `playlists.json` 里的 `favorites` / `videoCache`）：

- 收藏一条 = 该行 `favorites = 1` 且 `ord` 挪到最小；
- **取消收藏只把 `favorites` 置 0，位置不动**；
- 于是**数组顺序本身就是用户顺序**，渲染层直接按返回顺序用，不再自己排一遍
  （旧实现在渲染层还有个 `applyFavoriteOrder`，和主进程各排一次必然对不上）。

**排序在写库之前做 —— `ord` 就是最终显示顺序**

排序原来住在渲染层的 `sortSearchedVideos()`，而主进程写 `ord` 时只按
「收藏 + B 站返回顺序」，于是**界面顺序和库里顺序是两套**：

| | 之前 | 现在 |
| --- | --- | --- |
| 库里的 `videos.ord` | 收藏 + 其余按**B 站顺序** | 收藏 + 其余按**过滤 + 打分排序** |
| 界面显示 | 收藏 + 其余按**打分排序**（渲染层再排一次） | 直接照用 `ord`，**不再排序** |

两套顺序的危害不只是「看着不一致」：任何**依赖持久化顺序**的用法都会在刷新后失效，
因为库里的那份顺序根本没被排序影响过。

修法是把这套逻辑抽到 **`electron/common/utils/videoRank.ts`**（主 / 渲染共用一份），
由 `api:searchSong` 在 **`cacheManager.save()` 之前**调用：

```ts
const merged = await mergeWithFavorites(freshItems, oldRows)
// ★ 必须在 save 之前：save 是按数组下标写 ord 的
const finalList = rankVideos(merged, {
  // ★ song / singer 是**两个独立入参**（不是 "歌名-歌手" 拼串）
  song: songName,
  singer: singerName,
  songDurationSec: findSongDuration(cacheKey),
  tagBonus: getSetting()['player.tagBonus'],
  filterKeywords: getSetting()['player.filterKeywords'],
  durationToleranceSec: getSetting()['player.durationToleranceSec'],
  // 与「取结果时」用同一套时长上限（降级轮放宽过，这里要跟着放宽）
  relaxUpperBound: relaxedBound,
})
if (cacheEnabled()) await cacheManager.save(cacheKey, { ...result, data: { ...result.data, result: finalList } })
return { data: { ...result.data, result: finalList } }
```

> **★ `RankOptions` 收的是 `song` + `singer` 两个独立字段，不是一个拼串**
>
> 早先是 `"歌名-歌手"` 拼串，用的时候再拆开 ——
> 那是「先合并再拆开」的多余往返：
>
> - 歌名和歌手本来就是**两个独立字段**（歌单里、界面上都分开存）；
> - 而拼串**天生有歧义** —— 歌名本身可能含 `-`
>   （`下坠Falling` / `R.` / `若是明仔载`），按 `-` 切会切错。
>
> 现在只有 `joinCacheKey()` 还拼串，但那只是**缓存键**（数据库主键），
> **不是搜索词**。拆串那个函数（`splitCacheKey`）零调用，已经删了；
> 解析旧 JSON 里遗留的字符串用 `parseCacheKey`。
>
> 同理 `scoreVideo()` 也**不再需要 `song` 参数** —— 硬过滤已经保证标题含歌名了，
> 在那里再判一次「歌名命中」永远是 true，没有信息量。

- **为什么抽成共享模块而不是在主进程重写一份**：两处各写一份必然漂移，
  而它的返回值直接决定用户看到什么。
- **渲染层的排序函数已经彻底删掉**：搬主进程时先留了一版恒等的
  `sortSearchedVideos()`（调用点散在续播 / 预热 / 重试 6 处，逐个删容易漏），
  后来调用点清零就连它一起删了。现在渲染层**没有任何排序代码**，
  `matchScore` / `nameBonus` / `tagBonus` 三个旧函数也早就没了。
- **`Array.prototype.sort` 是稳定排序**，所以同分候选保持 B 站返回顺序，不会被随机打乱。

### 排序方案（现行）：硬过滤 → 歌手断层 → 关键词细分

**一句话**：标题里的歌名必须**独立出现**，时长必须对得上；**歌手名命中给 +100 断层分**，
之后按用户配的关键词加权细分；找不到就降级换搜索词。

**① 硬过滤**（三条，任一命中直接丢）

| 规则 | 说明 |
| --- | --- |
| 标题里歌名**没有独立出现** | 见下面「歌名必须独立出现」一节 —— 这是本方案最讲究的一条 |
| 时长超出容差 | 下限 `max(时长−容差, 时长×0.3)`、上限 `时长+容差`。标题含 `MV/官方/Live/现场` 时上限放宽 **×1.7**（那些版本带前奏画面/片尾，用同一套容差会误杀真的官方 MV）。歌曲时长未知、或视频时长取不到 → **不过滤**（不因缺数据误杀） |
| 命中过滤关键词 | 默认是一组谱类/演奏类词（吉他谱、钢琴谱、指弹、口琴……），命中即丢 |

**歌名必须独立出现**（`titleHasSongName()` —— 本方案最讲究的一条）

简单判「标题含歌名」会放进**别的歌**（实测踩过）：

```
搜「童话」→ 放进《童话镇》             ← 不是同一首歌
搜「旧」  → 放进《红颜旧》《旧梦一场》  ← 不是同一首歌
```

因为「童话」在「童话镇」里只是**词的一部分**。所以规则是：

| # | 规则 | 说明 |
| --- | --- | --- |
| 1 | 标题里有 `《…》` / `〈…〉`，任一段**等于**歌名 | **通过**（书名号指向的就是它）|
| 1' | 书名号**不匹配** | **不因此否决** —— 继续走规则 2 |
| 2 | 歌名前后是**符号 / 空格 / 串首尾** | 通过（`光良 - 童话`、`童话 光良`、`【罗艺恒】童话`）|
| 2' | 歌名紧邻汉字 | 丢弃（`童话镇`、`哥本哈根的童话`、`红颜旧`）|
| 3 | 歌名**右边**紧跟「形式词」（`歌词排版`/`伴奏`/`完整版`/`mv`/`live`…）| 也算独立（`聊表心意` + `歌词排版`）|

> **⚠️ 书名号只放行、不否决**（这里改过一次）
>
> 标题里的书名号也可能指向**电视剧 / 专辑 / 栏目**，而不是歌名：
>
> ```
> 【许茹芸】泪海（《真爱一世情》电视剧主题曲）   ← 《…》是剧名，歌名"泪海"在别处
> ```
>
> 早先写的是「有书名号但都不等于歌名 → 丢弃」，于是上面这条**被误杀**。
> 现在改成：不匹配就继续走规则 2（它靠「泪海」前后是 `】` 和 `（` 通过）。
>
> ⚠️ **但 `titleHasSongName()` 顶部的 JSDoc 还留着旧描述**（第 1 条写着
> 「有书名号但都不等于歌名 → **丢弃**」），与实现不符 —— 实现里那条分支
> **直接往下走规则 2**，并不 return false。以**实现和本节为准**；
> 下次改这个文件时顺手把那段 JSDoc 改掉。

> **⚠️ 判边界必须在「保留空格的原串」上做**（踩过）
>
> 比对时要去空格（`Shape of You` ↔ `shapeofyou`），但判「前后是不是符号」
> 必须回**原串**看邻居 —— **空格本身就是关键的分隔符**，压缩后它已经没了。
>
> 踩过的坑：先 `normalize`（去空格）再判边界，于是「童话 光良」变成「童话光良」，
> 右邻成了「光」→ 被判成"紧邻汉字"而**误杀**（其实中间明明有空格）。
>
> 实现是 `flattenWithMap()`：既给出「去空格串」，又给出
> **「去空格后索引 → 原串索引」的映射**，判边界时按映射回原串取邻居。

> **⚠️ 必须配简繁归一**（`toSimplified()`，opencc）
>
> B 站标题**大量用繁体**，而歌单里的歌名是简体：
>
> ```
> 歌名（歌单）：旧
> 标题（B站）：不夠 - 舊『也許是舊的道理 虛情假意，卻總說得很堅定。』
>                                     ↑ 繁体「舊」≠ 简体「旧」→ 匹配不上 → 误杀
> ```
>
> 而这**不是"另一首歌"** —— 它就是用户要的那首，只是字不同。
> 不归一的话这条规则会把**正确的候选**也杀掉。

**已知代价**：`光良童话KTV纯享版`（同曲不同歌手、无分隔符）会被判丢 ——
它与「童话镇」在**字符层面完全同构**（歌名后紧邻汉字），纯字符串规则无法区分。
这是「宁可漏掉也不能放错」的必然取舍。

**② 歌手断层：歌手名命中 `+100`**

| 层级 | 条件 | 基础分 |
| --- | --- | --- |
| 第一层 | 标题里命中**歌手名** | **+100** |
| 第二层 | 没命中 | 0 |

硬过滤已经保证了「标题含歌名」，所以打分阶段**还是 0 分的那一批，
就等价于「只有歌名、歌手对不上」**（同曲不同歌手的翻唱 / 别的版本）。

用户的要求很明确：**歌手名要先拉开档次**，所以给 100 ——
一个「只有歌名」的候选哪怕把正分词全命中，也很难靠堆词追平这 100 分。

歌手名可能带多个（`A、B`），按 `、,，/&` 拆开逐个试，命中任意一个就算命中。

**③ 关键词细分：直接累加，没有上限**

```ts
for (const [score, keywords] of Object.entries(tagBonus)) {
  for (const kw of keywords) {
    if (title.includes(normalize(kw))) bonus += Number(score)
  }
}
return layer + bonus     // ← 不 clamp
```

> **⚠️ 这里取消过一个 `±10` 上限**
>
> 早先层内加权被 `clamp` 到 `[-10, +10]`，而断层分定成 `+50` ——
> 那个 50 是**由 clamp 上限倒推出来的**（保证两层数值区间不重叠：
> `[40,60]` vs `[-10,10]`，`40 > 10` 所以永不重叠）。
>
> 但那个上限有个副作用：**堆几个关键词就能顶满**。用户把 `-20` 档给「伴奏」
> 就是为了把伴奏压下去，结果被夹到 -10，与 `-4` 档的乐器演奏**只差 6 分**，
> 表达不出「伴奏要重罚」的意图。
>
> 现在**去掉 clamp**：用户配 `-50` 就是 `-50`。代价是「断层分不再有数学上的保证」——
> 理论上堆够多正分词可以超过 100 分。但那是**用户自己配的**，
> 他配那么多正分词就是想让它们起作用；替他夹一个上限反而更不透明。

**④ 排序**：收藏整段置顶（相对顺序不变、不参与打分）→ 其余按总分降序 → 同分保持 B 站原序。

**⑤ 降级重搜：五轮递进**（`searchSongFiltered`，在主进程网络层）

| 轮 | 搜索词 | 分区（`tids`） | 拼法 |
| --- | --- | --- | --- |
| 1 | `歌名 歌曲 歌手` | **全站**（`''`） | `buildPrimaryKeyword(baseSongName(song), singer)` |
| 2 | `歌名 歌曲 歌手` | **音乐区**（`3`） | 同上（**同一句话换个分区**）|
| 3 | `歌名 歌曲 歌手 MV` | 音乐区 | `buildFallbackKeyword(song, singer, 'MV')` |
| 4 | `歌名 歌曲 歌手 <括号内容>`；没括号则 `可视化` | 音乐区 | `buildFallbackKeyword(song, singer, lastSuffix)` |
| 5 | `歌名 歌曲`（**不带歌手**） | 音乐区 | `buildPrimaryKeyword(song, '')` |

代码里是 `plan` 数组（第 2~4 轮），第 1 轮在它之前单独搜（`primaryKeyword`），
因为那次响应还要当作「本轮的第 1 页」复用给 `searchSongFiltered`（省一次网络往返）。

**★ 搜索词形态：不带引号、不带书名号，纯空格分隔；歌名后加一个独立词 `歌曲`，歌手名里的括号换成空格**

```
buildPrimaryKeyword('歌名', '歌手')            →  歌名 歌曲 歌手
buildPrimaryKeyword('歌名', '歌手（别名）')    →  歌名 歌曲 歌手 别名
buildPrimaryKeyword('歌名', '')                →  歌名 歌曲
buildFallbackKeyword('歌名', '歌手', 'MV')     →  歌名 歌曲 歌手 MV
```

**★ 为什么第 1、2 轮搜同一句话、只换分区**

音乐区（`tids=3`）里是「正经 MV / 官方投稿」，但**翻唱、饭制、
动态歌词排版**这类常发在别的区（生活 / 鬼畜 / 影视）。只搜音乐区会漏掉它们，
只搜全站又容易被无关视频淹没 —— 所以**各搜一轮，取并集**。

实测（`歌颂-梦然`）：第 1 轮全站 82 条、第 2 轮音乐区 81 条，
两轮**净新增 71 条**，几乎不重叠。

> ⚠️ 判重必须用**「搜索词 + 分区」的组合键**（`usedKeys`，`${kw}@${tids}`）。
> 第 1、2 轮搜索词完全相同 —— 只比搜索词的话第 2 轮会被当成「重复」直接跳过，
> 整个设计就白做了。

**★ 为什么第 4 轮用「歌名以外的那部分」**

歌名里常夹着括号说明，有时括号后面还跟着合作信息：

```
溯(Reverse)feat.马吟吟     ← 真正的歌名只有「溯」
九重楼 (不敢独上九重楼)      ← 副标题
起风了 (Live)             ← 版本说明
```

所以歌名被 `splitSongName` 拆成两半：**正名**（第一个括号之前）给前 3 轮搜索
和硬过滤用，**尾巴**（括号及其后的全部内容）给第 4 轮用。两者互补，
一个负责正名、一个负责「括号 + 后面那串说明」。

> 只取「括号里的内容」的话，`feat.马吟吟` 那段就永远搜不到；
> 而把它留在歌名里又会让前 3 轮的搜索词变成 `溯feat.马吟吟 马吟吟`
> （还和歌手名撞了，B站很难匹配）。

没有括号时退回 `可视化`（覆盖「动态歌词排版 / 可视化」这类标题）。

> ⚠️ **尾巴没有新信息时要置空**（用户指出来的）：
> `(Intro)` → `name='Intro'`、`tail='Intro'`，`【伴奏】晴天` → 两者都是
> `伴奏 晴天`。这时第 4 轮的搜索词会和第 1 轮**一模一样**，纯属白发一次请求
> （还会推高被限制的概率）。所以 `tail` 的每个词都在 `name` 里时置空，
> 第 4 轮退回 `可视化`。判定用**词集包含**（不是整串相等），词序不同也算重复。

**★ 每一轮只搜第 1 页（翻页已取消）**

```
searchRounds 内部：
  只搜一次第 1 页 → return { items: extract(first), pages: 1 }
  不再有 needSecond / countPassing 的「要不要翻第二页」判断
```

**曾经的行为**（现在作废，但值得记着）：原来是「一页不够就翻第二页、两页不够就降级」
—— 用户当时明确纠正过一次「**不是「降级就搜两页」，而是「一页不够就两页」**」。

**为什么现在连翻页都不要了**：一首歌 4 轮，每轮再翻页 = 最多 8 个请求；
再加上渲染层的重试，就是被 412 的主因（见后面「B站风控」一节）。
五轮降级本来就覆盖了「换词再找」的需求，**翻页的边际收益不值得**。

> 连带去掉的：`searchRounds` 的 `relax` 参数（它只服务于「够不够、要不要翻页」
> 那个判断）—— 函数现在只剩「搜一次 + 提取」两件事。

**★ 降级轮一律放宽时长上限**（`relax = true` → `容差 × 1.7`）

降级时搜出来的结果更杂（大量合集 / 全场 / 串烧），用第一轮那套上限会把
本来能找到的砍掉。

> ⚠️ 这里曾经是**死代码**：`relaxUpperBound` 这个参数**声明了、注释了，
> 却从来没有被传成 `true`**，等于那条规则根本没生效（降级轮只享受到
> 「标题含 MV/Live」那条常规放宽）。是代码审查时靠全仓 grep 才发现的 ——
> 它是个**永远走不到的分支**。

> ⚠️ `relaxed` 只要**搜过降级轮**就置位（哪怕那一轮净新增为 0）：
> 判据是「池子里有没有来自降级轮的条目」，而不是「这一轮有没有新增」。
> 降级轮的结果是用放宽上限搜回来的，最终过滤就必须跟着放宽，否则会被
> 「用严格上限」重新挡掉。「还要不要继续降级」由循环开头的 `countPassing`
> 决定，与它无关。

**★ 结果是「累加合并」，不是「哪一轮胜出就替换哪一轮」**

用户的原话：**「降级的意思是降级搜索，不是要把之前的结果不要」**。
所以每轮结果按 `bvid` 去重后**追加**到结果池：

```
第1轮: 10 条  ┐
              ├─ 正确：10 + 36 去重合并 = 46 条
降级轮: 36 条 ┘

（我原来的实现是「比大小 → 用 36 条」→ 第 1 轮的 10 条被整个顶掉 ❌）
```

各轮搜出来的往往是**另一批**视频，两批重合度并不高，
合起来才是「能挑的候选」。

**★ 「够不够」判的是「过滤之后」的条数**

用户设的 `minResults`（默认 30）是「**过滤完**还剩几条才算够」。

> ⚠️ 这里踩过两次：
>
> 1. 原实现用的 `roughFilter` 把歌名和过滤词都传空，实际只做了时长过滤，
>    于是判断数字虚高、降级**永远不触发**。现在用 `countPassing`，
>    跑的是与 `rankVideos` 完全相同的规则。
> 2. **`countPassing` 必须先把 B 站返回的 `favorites` 字段置为 `false`**。
>    B 站的搜索结果里**本来就有个 `favorites`**（「这条视频被多少人收藏」，
>    一个几乎总是 truthy 的数字），而 `rankVideos` 用它判断「是不是用户在我们
>    这儿收藏的」并**豁免收藏项不参与过滤**。不清掉的话：
>
>    ```
>    39 条搜索结果 → 38 条被当成"收藏" → 全部豁免过滤 → countPassing = 39
>    判定「39 >= 30 够了」→ 不补第 2 页、不降级
>    而 mergeWithFavorites 之后 favorites 规范化成 false → 真过滤 → 只剩 24 条
>    ```
>
>    表现就是日志里两个数字对不上：`取回 39 条（1 页）` 但 `过滤后 24 条`。

**★ 搜索词里不加 `-`**

B站搜索把 `-` 当**排除语法**（`A -B` = 搜 A 并排除含 B 的结果），
写成 `歌名 - 歌手` 会变成「搜歌、**排除**这个歌手」，正好反了。
用空格分隔就是普通的「与」语义。

> 搜索**词**（发给 B 站的）与**缓存键**（数据库主键）是两回事：
>
> | | 形态 | 用途 |
> | --- | --- | --- |
> | 搜索词 | `歌名 歌曲 歌手`（**剥过括号**，歌手名的括号换成空格）| 发给 B 站 |
> | 缓存键 | `歌名-歌手`（`joinCacheKey`）| `videos.search_key` / `song_meta.search_key` |
>
> ⚠️ 两者会**不一致**：歌名带括号时，搜索词是剥过括号的版本，
> 缓存键保持原始歌名 —— 拿缓存键当搜索词看会完全误解。
>
> `-` 只出现在**搜索键**里（它只是个数据库主键，不参与 B 站查询），
> **不出现在搜索词**里。

**⑥ ⚠️ 过滤只作用于「非收藏项」**（这里改过一次）

收藏是**用户自己挑的**（点收藏，或者手动「添加视频」粘的链接）——
它不该被「标题里有没有歌名」「时长对不对」这类**搜索匹配规则**判掉。

我第一版把收藏也一起过滤了，后果是：用户手动添加的视频（标题往往是自己起的、
不含歌名）**直接从列表消失**，而且刷新也找不回来。

```
rankVideos 里的顺序：
  ① 先把收藏摘出来（不参与过滤，顺序也不动）
  ② 只对 !favorites 的做硬过滤
  ③ 只对 !favorites 的按分数排序
  ④ 拼起来：[...收藏, ...排好序的其余]
```

**⑦ 过滤后为空 → 返回空 + `filtered: true`，**不搞「回退」**

```ts
if (finalList.length === 0) {
  return { data: { ...result.data, result: [], filtered: true } }
}
```

渲染层看到 `filtered` 就**跳过那 3 次重试** —— 那是合法结果（搜索成功了，
只是全被规则挡掉），不是搜索失败。提示也分开说：「结果都被过滤掉了，
去设置里放宽规则」，而不是「检查网络」（那会把人引到错误方向）。

> **为什么不「回退成不过滤」**（我第一版就是这么写的）：那会把
> **标题不含歌名**的条目一起放回列表里 —— 用户看到列表里混着一堆不相关的视频。
> 歌名是「是不是同一首歌」的唯一硬判据，它没有「回退」这个选项。

### 缓存路径**不做任何过滤/排序**（这里改过两次，最终结论）

库里存的就是**搜索时已经过滤并排好序**的那份（`save` 收到的 `finalList`，
`ord` = 数组下标；`cacheManager.get` 内部 `ORDER BY ord ASC`）。
所以读路径**原样返回** —— 在这里再调一次 `rankVideos` 是把同一批数据
按同一套规则**再算一遍**，纯属多余。

```
读缓存 → 取出 result（已按 ord 排好）→ 直接返回，不调 rankVideos
```

**曾经的错误做法**（改过两轮，别改回去）：

```
第一版：读缓存时"按当前规则重过滤"，并把过滤后的结果**回写**缓存
        → save 是 DELETE+INSERT，回写等于把被挡的行从库里**永久删除**
        → 用户把容差调回去想找回那些结果时，它们已经不在库里了

第二版：读缓存时"重过滤"但**只读不写**
        → 理由是「用户改了过滤设置要立刻生效」
        → 但库里 40 条、界面 35 条的不一致会一直存在
          （日志打「剔除 N 条」，用户却没有任何操作导致它）
```

**为什么"改设置立刻生效"这个理由站不住**：

- 改设置后**本来就该重搜**（`skipCache`）—— 拿一份**过期候选集**去套新规则，
  等于用旧数据猜「新规则下该显示什么」，本来就不对；
- 而且过滤结果不回写，所以「显示 35 条」和「库里 40 条」会一直对不上；
- 用户看到条数莫名变少，找不到原因。

> ⚠️ **必须知道的副作用**：改了过滤设置后，**已经搜过的歌仍是旧结果**，
> 要看到新规则的效果必须点视频列表的**刷新**按钮（它会 `skipCache` 真重搜）。
> 这是用户明确选择的行为（「改了过滤不要动已经搜过的」）。

> 顺带一个实测结论：`save` 的 `orphans` 逻辑**确实会保住真收藏** ——
> 「不在传入列表里、且 `favorites = 1`」的行会被补在列表最后。
> （我一度以为收藏会丢，实测证明不会；那次测试失败是因为我在第一次 `save` 时
> 就传了 `favorites: true`，而 `save` 里写的是 `old?.favorites ?? 0` ——
> 全新条目的收藏标记**永远取自旧行**，所以那个 `true` 根本没生效。）

实测（用真实数据跑现行 `videoRank`）：

```
歌名独立出现：书名号=歌名 保留 / 书名号≠歌名（但歌名在别处独立）保留 ✅
              歌名紧邻汉字 丢弃（童话镇 / 哥本哈根的童话 / 红颜旧 / 旧梦一场）✅
              歌名前后是空格/符号 保留（童话 光良 / 光良 - 童话 / 【罗艺恒】童话）✅
              书名号指向剧名 不误杀（【许茹芸】泪海（《真爱一世情》…））✅
简繁归一：     不夠 - 舊『…』 保留（繁体「舊」= 简体「旧」）✅
              一笑傾城 / 我走後 / 紅色高跟鞋 同样保留 ✅
形式词豁免：   聊表心意 + 歌词排版 / 伴奏 保留（歌名后紧接形式词）✅
时长：         差 89s 保留 / 差 91s 丢弃 / 低于 max(时长-容差, 时长×0.3) 丢弃 ✅
               MV/Live/官方 的 6:30 保留，翻唱的 6:30 丢弃 ✅
歌手断层：     歌手名命中 +100，压在「只有歌名」之上 ✅
关键词无上限： 堆满正面词可以超过 100（不再被夹到 ±10）✅
排序：         收藏置顶 → 歌手命中在前 → 同分保持原序 → 负分垫底 ✅
收藏豁免：     三个收藏（含手动添加的不含歌名项）全部保留 ✅
```

> 真实数据体检（用户自己那个 221 首歌单）：`童话` 71 条里**精确丢掉 17 条**
> 别的歌（`童话镇` / `哥本哈根的童话` / `妈妈画的童话` / `夜之童话` /
> `童话不骗人` / `草原童话` / `五环童话` / `平安夜童话` …），
> 而 `泪海` 45 条**零误杀**、`只字不提` 40 条只丢 2 条。
> 规律：**歌名越短（尤其单字），边界规则砍得越多** —— 因为单字太容易
> 出现在别的词里（「旧」会命中「红颜旧」「旧梦一场」「旧朋友」）。
> 这是「宁可漏掉也不能放错」的代价。

> **⚠️ 仍未解决的：「收藏再取消来提升顺序」过不了重新搜索**
>
> 这次改动**只统一了「显示顺序」与「库里顺序」**，并**没有**让「已取消收藏」的条目
> 在重新搜索后保住位置。原因在 `save()`：`ord` 是**按传入数组的下标重写**的
> （`insert.run(..., index, ...)`），而 `mergeWithFavorites` 只把 **`favorites = 1`**
> 的条目提到数组前面 —— 取消收藏后它 `favorites` 变 0，就成了普通新结果，按下标重排。
>
> 也就是说：**收藏**能保住位置，**取消收藏**不能。想实现「手工排序」需要另加机制
> （例如给 `videos` 加一个「用户指定过顺序」的标记，让 `save` 对这类行也保留 `ord`），
> 这属于字段设计的事，等定稿时一起做。

**「上次播的是哪个视频」= `song_meta.selected_bvid`**：
由 `api:resolveVideo` 在**每次真正切到某个视频时**落库（一行 upsert）。
换 SQLite 之前之所以要攒到「切歌 / 退出」才写，是因为旧实现是 JSON 文件 ——
每写一次都要把整份候选列表 stringify 再 rename，切视频那么频繁根本受不了；
现在按主键更新一行就够了，语义反而更准（不必担心「切了视频但没切歌就退出」会丢）。

**过期语义（重要）**：只有**播放地址那一批列**会过期
（`durl_url` / `dash_video` / `dash_audio` / `dash_duration` / `quality` /
`support_formats` / `playurl_at`），标题 / 封面 / 收藏 / 顺序**永不过期**，
所以清理**只把这些列置 NULL、绝不删行**。

> **`dash_tried` 和 `playurl_login_state` 不在清理范围内** —— 它们不是「地址」。
> `dash_tried` 尤其不能清：它的作用是「试过 dash 但没拿到，下次别反复重取」，
> 清了就等于每轮过期都把「这个视频没有 dash」这件事忘掉，然后一直重试。

时长取设置项 `cache.searchResultExpireMs`（**0 = 永久**，界面上显示成「永久」）。
清理入口：启动后设置变化时、以及设置里那个「清理过期」按钮。

> `cache.maxAge` 是**旧实现留下的死键**：主进程已完全不再读它。
> 语义被 `cache.searchResultExpireMs` 取代（前者过期=删整个缓存文件，
> 后者过期=只清播放地址）。保留键名只是为了不动 `AppSetting` 的形状。

**「全部清除」= 两张表全清**（`videos` + `song_meta`）：
收藏、选中视频、播放地址一起没了。界面上按钮的文案也是「全部清除」，两边必须一致。
（v1 那张 `video_details` 已经合掉，所以现在是两张表；合表之前必须三张一起清 ——
只清 `videos` 会留下一堆没人引用的解析结果，磁盘占用压根不降，
而用户点这个按钮就是为了腾空间。）

**不做旧数据迁移**：JSON 时代的 `setting.json` / `playlists.json` / `search-cache/`
不再被读取，也不写任何导入代码。用户（只有一个）明确要求过不做迁移。

**schema 升级也是「丢弃重建」，不做逐字段搬运**：
`db.ts` 的 `migrateSchema()` 发现 `user_version`（**建表语句的哈希指纹**）
与当前不一致时，就会把**全部表 / 视图** `DROP`（动态查 `sqlite_master`，见上文），
再按新结构重建。理由：

- SQLite 数据层**从未发布过**，所以「升级」实际只发生在开发机上，重搜一次即可；
- 逐字段搬运要处理「旧列可能不存在 / 类型变了 / JSON 要重新拆成列」三种情况，
  代码量和出错面都远大于丢掉重来，而收益只是省几次重新解析。

> **副作用要说清楚**：重建会清空**收藏、顺序、选中视频，以及歌单本身**
> （都在同一个库里）。要保留就得自己先备份 `blwe.db`。
>
> 本轮就真的清过一次库（`playlists.id` 的语义从随机 UUID 改成
> `平台_平台歌单id`，属于 schema 变化）—— 用户明确要求「不用管我，不要迁移，直接清库」。

续播相关的信息存在 `setting.json` 里：`player.resumeOnStart`（记住播放进度）、`player.resumeTime`
（上次播放到第几秒）；**播到第几首由每个歌单自己的 `lastIndex` 决定**（`player.playIndex` 是历史遗留、
只写不读，已经删掉）。
界面相关的：`common.themeColor` / `common.fontColor`（hex）、`common.glassTransparency`（0-100）、`common.glassBlur`（0-20）、`common.glassShadow`（0-20）。
记录时机：切歌、切视频、视频加载完成、播放进度变化（节流 5 秒）、关闭窗口前。

> `setting.json` 是**唯一还留在 JSON 上的数据**（约 2KB、整体替换语义，没有按行查询的需求）。
> 歌单 / 视频 / 收藏 / 选中视频都已经在 SQLite 里。

**「这首歌播哪个视频」的存储**：`song_meta.selected_bvid`（只存 bvid，
标题封面在 `videos` 行上）。**它按「歌」（`search_key`）记，不按歌单** ——
因为 `videos` 里那批候选就是按歌存的，同一首歌在哪个歌单里都是同一批候选，
给每个歌单各挑一个是没意义的。

> **不存播放直链** —— B 站地址带签名时效，存下来很快就失效；
> 续播时按 bvid 重新解析，见上面的「续播：为什么每次都重新搜索、重新解析地址」。

### 歌单解析（对应 LX 的 musicSdk）

用户粘贴分享链接 → 自动识别平台 → 解析出 `歌名 / 歌手` → 逐首到 B站 搜索播放。

```
渲染进程  window.electronAPI.getPlaylistDetail({ input })
   └─ IPC 'music:getPlaylistDetail'
        └─ 主进程 handler（electron/main/ipc/music.ts）
             ├─ electron/main/music/index.ts   按链接 host 自动识别音源（wy / tx / kw）
             │    └─ sources/<source>.ts       各平台自己解析自己格式的链接
             │         └─ 返回 { info, songs: ParsedSong[], total, source, listId }
             └─ ★ 出口加工成「成品」：
                  toPlaylistSongs(detail.songs)   ← 字段归一 + 带上 platformId
                  playlistKey(detail.source, detail.listId)  ← 拼好歌单主键
             └─ 返回 { info, songs: PlaylistSong[], total, page, limit, source, id }
```

支持的链接形式：

| 平台 | 链接示例 |
| --- | --- |
| 网易云音乐 | `https://music.163.com/#/playlist?id=xxx`（也支持 `xxx###token` 注入 MUSIC_U） |
| QQ音乐 | `https://y.qq.com/n/ryqq/playlist/xxx` 或 `.../playlist/xxx.html` |
| 酷我音乐 | `https://www.kuwo.cn/playlist_detail/xxx` |

**★★ 核心设计原则：凡是主进程能算的，渲染层一律不碰**

`resolvePlaylist`（解析）和 `writePlaylistsToDb`（写库）**都在主进程**，
所以两者之间**根本不需要绕渲染层**。而现实是：

```
resolvePlaylist 拿到 ParsedSong[]（有 platformId、有 listId）
     ↓ 返回给渲染层展示（用户会看到曲目列表）
渲染层 savePlaylists({ playlists })  ← 回传
writePlaylistsToDb → songId(song)    ← 此刻要 platformId，但它已经不在了
```

于是主进程在 **IPC 出口**就把结果加工成**最终形态**，渲染层只负责
「展示 + 原样回传」：

| 加工项 | 做什么 | 为什么必须在主进程 |
| --- | --- | --- |
| `toPlaylistSongs()` | `interval:"4:03"` → `duration:243`（秒）；`albumName` → `album`；**带上 `platformId`** | 渲染层不需要认识音源字段；而且它**不知道 `platformId` 有用** |
| `playlistKey()` | 拼歌单主键 `tx_8153225605` | 只有主进程知道音源给的 `listId` |

> **⚠️ 踩过的坑（代价很大，一定要写）**
>
> 这段字段转换**原本写在渲染层** `PlaylistManager.vue`。后果是
> **`platformId` 被丢掉**（渲染层根本不知道它有用）→ `songs.id` 全部退化成
> `歌名-歌手`。实测库里 **221 条无一例外、带平台前缀 0 条** ——
> 白拆了 `songs` / `playlist_songs` 两张表，整个重设计等于没做。
>
> 后来还犯过一次同类错误：让渲染层调 `playlistKey(detail.source, detail.listId)`
> 自己拼主键。**同样错** —— 那是主进程的事。

`toPlaylistSongs()` 由 **IPC 出口和 `syncPlaylist` 共用** ——
保证「解析 → 渲染层 → 回传」和「同步（直接在主进程改内存）」两条路径
**产出形状完全一致**（实测：同一首歌两条路径的 `duration` / `platformId` /
`songId()` 全一致，8 项断言通过）。

**★ 平台歌单 id 怎么带出来的**

三个音源的 `getListId()` 本来就在解析它，现在通过 `PlaylistDetail.listId` 带出来：

| 音源 | 字段 | 例 |
| --- | --- | --- |
| QQ音乐 | `disstid` | `8153225605` |
| 网易云 | `id` | `11332` |
| 酷我 | `rid` | `xxx` |

> ⚠️ **`listId` 不透出给渲染层** —— 它只用于主进程拼 `id`。
> 返回给渲染层的 `id` 是**拼好的成品**（`tx_8153225605`），
> 渲染层直接拿来当 `PlaylistRecord.id` 用。

**★ 三个音源的 `songs` 里带的平台歌曲 id**

`sources/<source>.ts` 里都填了 `ParsedSong.platformId`（tx: `item.id ?? item.mid`，
wy: `song.id`，kw: `item.id`）。它是 `songs.id` 的来源，**不能丢**。

移植时与 LX 的几处有意差异：

1. **跑在主进程**：LX 的 `musicSdk` 在渲染进程里直接用 `crypto`/`Buffer`/`needle`
   （靠 webpack `target: 'electron-renderer'`）。本项目是 `contextIsolation: true` +
   `nodeIntegration: false`，所以解析逻辑放在主进程，只通过 IPC 把结果给渲染进程。
2. **请求层用 Node `http`/`https`**：实测在主进程用 Electron `net.request` 请求腾讯域名会稳定
   返回 `net::ERR_BLOCKED_BY_CLIENT`（网易云/酷我正常），换成 Node 内建模块后稳定可用；
   而且 Node 默认不跟随重定向，能直接读到 `location` 头，正好解决短链解析。
3. **自动识别音源**：LX 让用户在弹窗里手选音源，本项目按链接 host 自动判断，
   体验更省事；纯数字 ID 因无法判断平台会给出明确提示。
4. **返回结构精简**：LX 的歌曲对象还带 `qualitys`/`typeUrl` 等取播放地址用的字段，全部砍掉；
   本项目保留的是 `name / singer / interval / albumName / cover / platformId`
   （结构化曲目要展示专辑与封面，见 `ParsedSong`），同步与手动新建都会把
   专辑 / 封面一起写进歌单。

**★ `songId()` 与 `playlistKey()`：两个拼 id 的纯函数**

都在 `electron/common/types/playlist.ts`（主 / 渲染共用，但**渲染层一个都不该调**）：

| 函数 | 形态 | 用途 |
| --- | --- | --- |
| `songId(song)` | `tx_1828354` / 退化成 `歌名-歌手` | `songs.id`、`playlist_songs.song_id` |
| `playlistKey(source, listId)` | `tx_8153225605` / 参数不全返回 `null` | `playlists.id` |
| `joinCacheKey(song, singer)` | `歌名-歌手` | `videos.search_key` / `song_meta.search_key` |
| `sourceOfSongId(id)` | `tx` / **不认识的前缀返回 `null`** | 从 id 反推音源 |
| `platformIdOfSongId(id)` | `1828354` | 从 id 反推平台歌曲 id |
| `baseSongName(name)` | `九重楼 (不敢独上九重楼)` → `九重楼`；`溯(Reverse)feat.马吟吟` → `溯` | 取**第一个括号之前**的正名（= `splitSongName(name).name`）|
| `splitSongName(name)` | `{ name, tail }` | 拆歌名：`name` 给搜索/过滤，`tail` 给第 4 轮降级 |

> `sourceOfSongId()` **只认 wy / tx / kw / kg** —— 否则 `pl_<uuid>`（手动歌单的
> 兜底 id）会被解析成音源 `pl`，那是个不存在的平台，下游拿去用会静默出错。
>
> ⚠️ **命名约定**：函数名用 `CacheKey`（`joinCacheKey` / `toCacheKey` /
> `parseCacheKey`），**变量 / 参数**用 `cacheKey`；数据库列名仍是 `search_key`
> （改列名要清库）。三者指的是同一个东西，别再引入第四种叫法。

> **`baseSongName()` 现在不是「按版本词选择性剥」了**（这是第三个版本，别照着旧注释理解）：
>
> 1. 第一版：全留着（`九重楼 (不敢独上九重楼)` 导致 140 条候选全被挡）
> 2. 第二版：**只剥含版本词**的括号（`(Live)` 剥、`(不敢独上九重楼)` 不剥）——
>    结果括号里带副标题的歌照样搜不到
> 3. **现在**：`splitSongName` 直接**在第一个括号处劈开** —— 前面是正名、
>    后面（含括号内和括号后的字）是尾巴。不判断「像不像版本词」，
>    因为它根本不需要知道那是不是版本词：只要是括号，就说明**歌名在括号之前**。
>
> 用途：硬过滤比对、拼前 3 轮搜索词。**搜索与过滤必须用同一个名字**，
> 否则「搜的是 A、过滤却要求标题含 B」，一条都过不了。

---

## 数据与运行期

### 便携版（portable）的数据放在哪

`electron/main/portable.ts` 里按优先级三选一（必须在 `app.whenReady` 之前跑）：

| 情况 | 用哪个目录 |
| --- | --- |
| `%APPDATA%/BiLiWallpaperEngine` 里**已经有本应用数据** | 就用它（安装版 / 便携版共用一份，换版本不会「数据不见了」） |
| 没有数据，且当前是便携版（运行时带 `PORTABLE_EXECUTABLE_DIR`） | exe 同级的 **`blwedata/`**（自动创建，数据跟着程序走） |
| 没有数据，且是安装版（全新环境） | 默认的 `%APPDATA%/BiLiWallpaperEngine` |

> **⚠️ 目录名是 `BiLiWallpaperEngine`**
>
> Electron 的 `app.getPath('userData')` = `%APPDATA%/<app name>`，
> 而 app name 取自 `package.json` 的 **`name`**（= `BiLiWallpaperEngine`）。
> `build.productName` 是 `BLWE`，但那是 **electron-builder** 的字段，**Electron 不读它**。
> 代码里也没有 `app.setName(...)`，所以目录就跟着 `name` 走。
>

判断「已经有数据」看的是我们自己的文件（`setting.json` / `playlists.json` / `playlist.json` /
`search-cache` / **`blwe.db`**），**不能只看目录存不存在** —— Electron 一启动就会把 userData
目录建出来，那样全新机器上永远走不到便携分支。

> `blwe.db` 也在标记列表里，因为**现在真正承载用户数据的就是它**
> （歌单、收藏、选中视频）。少了它，一个「只有 SQLite 数据」的目录会被判成「没有数据」，
> 于是在便携版里又去 exe 同级建一个空库，用户会看到歌单全没了。

**目录名是 `blwedata` 而不是 `data`**：`data/` 太通用，绿色版常被丢在同一个文件夹里，容易和别的软件撞。

> **刻意不做旧目录迁移**：早期版本用的是 `data/`，改名后旧目录原样留着、不读不写也不删。
> 用户如果需要老数据，手动把 `setting.json` / `playlists.json` 拷进 `blwedata/` 就行。
> 这是有意的取舍 —— 自动 `rename` 一个可能正在被占用 / 权限受限的目录，
> 失败路径（改名失败、跨盘、部分成功）比「让用户手动拷一次」麻烦得多，
> 而且一旦出错就是数据事故。

### 关闭到托盘 / 任务栏进度 / 输出设备变化 / 开机自动启动

- **关闭到托盘**（`common.closeToTray`）：`mainWindow.on('close')` 里 `preventDefault()` + `hide()`。
  关键是 `isQuitting` 标志 —— `before-quit` 里置位，否则「退出应用」菜单项和系统关机也会被拦下来，
  变成永远退不掉。窗口藏起来后托盘那一项要显示「恢复窗口」（靠 `windowHidden` 状态）。
- **主窗口关掉 `backgroundThrottling`**：窗口一藏，Chromium 会把隐藏窗口的定时器压到约 1 次/分钟，
  片尾看门狗、缓冲刷新、任务栏进度就全失灵了。音乐播放器缩到托盘还得照常放，所以关掉节流。
- **任务栏进度**（设置：`common.taskbarProgress`，默认开）：主进程 `setProgressBar(0~1, { mode })`，
  暂停时用 `paused` 样式（Windows 上是黄色）。渲染层按「百分比 + 暂停态」算指纹，只有变了才发 IPC
  —— `timeupdate` 一秒好几次，全发会把主进程喊爆。开关关掉时立刻发 `-1` 清掉进度条。
- **输出设备变化暂停**（设置：`player.pauseOnDeviceChange`，默认开）：渲染层听 `navigator.mediaDevices`
  的 `devicechange`，正在播就先暂停（插拔耳机 / 切默认扬声器时，声音可能跑到别的设备上）。
  注意这个事件不区分输入输出设备，这是渲染进程能拿到的唯一信号。
- **开机自动启动**（设置：`common.autoLaunch`，默认**关**）：用 Electron 内建的
  `app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: [] })` ——
  **不需要额外的原生依赖**（对比托盘 / 壁纸那些都得自己调 Win32）。
  它在 Windows 上写注册表 `Run` 键，macOS 用 `LaunchAgents`。

  三个刻意决定：

  | 决定 | 为什么 |
  | --- | --- |
  | **默认关** | 改系统启动项属于「动系统」的行为，应该由用户明确打开，而不是装完就悄悄注册一项 |
  | **每次启动重写一遍**（`whenReady` 里调 `applyAutoLaunch`） | 便携版注册的是**当前 exe 的完整路径**，用户把文件夹挪走后启动项里还是旧路径、开机时**静默失效**（Windows 找不到 exe 就跳过，没有任何提示）。重写一次能自动纠正 |
  | **开发模式一律关掉**（`isDev` 时主动写 `false`） | 开发时 `execPath` 是 `node_modules/electron/dist/electron.exe`，注册它没意义，还会污染用户的启动项（顺便把之前调试留下的残留清掉） |

  **改了要立刻生效**：`onSettingChange` 里判断 `keys.includes('common.autoLaunch')` 就调 `applyAutoLaunch()`
  —— 否则那个值只在下次启动时被读，用户打开开关后看不到任何变化，会以为没用。

  **`args` 传空数组是刻意的**：不传 `--wallpaper-mode`。那是「这次启动直接进壁纸」的意思，
  而壁纸模式要不要进由 `common.wallpaperMode` 自己决定（见 `createMainWindow`）——
  在这里再传一个参数会让两个开关打架。

### 图标（窗口 / 托盘）放在哪

`bili.ico` 在三种环境里的位置不同，`electron/main/index.ts` 的 `resolveAsset()` 按顺序找：

1. `process.resourcesPath/icons/` —— 打包后由 `extraResources` 放进来（**不在 asar 里**，真实文件路径）；
2. `public/` —— 开发期；
3. `out/renderer/` —— 兜底（Vite 会把 `public/` 整个拷到渲染产物里）。

> 踩坑：打包后原来直接拼的是 `app.getAppPath()/bili.ico`（= `resources/app.asar/bili.ico`），
> 这个路径根本不存在 —— 表现就是 **portable 版托盘没图标、窗口图标也是空的**。
> 现在 `loadIcon()` 在图标解不出来时会 `console.warn('[icon] 图标加载失败…')`，不再静默变空白。
> 图标文件本身也要记得在 `build.extraResources` 里声明，只写 `files` 是打不进包的。

### 关于存储：为什么最终换成了 SQLite

> 这一节原来是「**为什么用 JSON 而不是 SQLite**」，结论已经完全反过来，保留标题
> 是为了让「当初为什么不用」和「后来为什么必须用」都能查到 —— 免得下次又有人
> 觉得「才几 KB 的数据用 SQLite 是过度设计」。

**当初不用 SQLite 的理由**（针对当时的形状，其实是成立的）：
`setting.json` 约 2KB、`playlists.json` 约 5KB，写入是「整体替换」语义，
没有部分更新 / 并发写 / 按行查询的需求；而 SQLite 是原生模块，要额外处理
`asarUnpack` / ABI / 跨平台重编译。为一个 5KB 的文件引入这些，确实不划算。

**为什么后来必须换**：数据形状变了，上面那些前提一条条都不成立了。

| 需求 | JSON 时代 | SQLite |
| --- | --- | --- |
| 「收藏」「选中视频」「搜索结果」都要持久化 | 拆在两类文件里（`playlists.json` 与 `search-cache/*.json`） | 同一个库，按 `search_key` 关联 |
| 过期语义要落到**字段级**（只清播放地址） | 做不到 —— 文件级 TTL 只能整份删 | `UPDATE videos SET durl_url = NULL, dash_video = NULL ...` |
| 收藏要能改「列表顺序」 | 顺序只存在于渲染层，刷新就散 | `videos.ord` 是权威 |
| 部分更新（改一行的一个字段） | 读-改-写整个文件（几 MB） | 一条 `UPDATE` |
| 解析结果要能查询（登录态 / 过期时间） | 埋在 JSON 里，判断得先 `JSON.parse` | 真列，可直接 `WHERE` |

**原生模块这件事也解决了**：`better-sqlite3@13` 起是**预编译分发**
（`gypfile: false`，`prebuilds/*.node` 直接带在包里），装的时候不编译、
用的时候不需要 `electron-rebuild`（实测 Electron 42 / ABI 146 直接可用）。
打包只需要在 `files` 里白名单保留 `prebuilds/win32-x64.node`（1.9MB）并
`asarUnpack`，其余 7 个平台的 prebuild 和 `deps/`、`src/` 全部排除 ——
这套做法参考了 LX Music（它的 `build-config/deps.js` 会把 prebuild
拷到 `build/Release/`，并用 `beforePack` 把 `binding.gyp` 改名以阻止现场编译）。

**`node:sqlite` 其实也能用**（实测 Electron 42 内置的 Node 24 里可用，
零原生模块、零打包配置），但它标注为 experimental、API 可能变；
`better-sqlite3` 只多 1.9MB 且行为稳定，所以最终选了后者。

**`opencc-js`（简繁归一）的打包 —— 已实跑验证**

依赖表是 `better-sqlite3` / `bytenode` / `koffi` / **`opencc-js`**。

用途只有一个：硬过滤里的**简繁归一**（B 站标题大量用繁体，见「排序方案」那节）。
代码里引的是 **`opencc-js/t2cn` 子路径**，不是主入口：

| 入口 | 体积 | 内容 |
| --- | --- | --- |
| `require('opencc-js')` | **1.1 MB** | 简→繁、繁→简、日文新字体、台湾/香港变体…… **我们一个都不用** |
| `require('opencc-js/t2cn')` | **106 KB** | 只有「繁→简」，正是需要的那一件事 |

体积差 **10 倍**，而程序里只用得到一个方向。

> **为什么不用 `asarUnpack`**：`t2cn.js` 是**自包含**的 —— 106 KB、
> **文件内零 `require`**，字典全内联，所以能直接在 `asar` 里跑，
> 不需要摊到磁盘上。
>
> 已实跑验证：`npm run pack` 生成 `release/win-unpacked` → 用
> `@electron/asar` 确认 `node_modules/opencc-js/dist/umd/t2cn.js` 在里面 →
> 跑 `BLWE.exe` **无 opencc 告警**（拿不到 opencc 时 `videoRank` 会打
> `[videoRank] opencc 不可用…` 的 warn，所以「没有这条告警」= 加载成功）。

> `toSimplified()` 有**退化路径**：`require` 失败只打一行 warn、
> 退回「不转换」，而不是让整个过滤崩掉 —— 代价是繁体标题的歌候选变少，
> 但程序仍然可用。另外启动时会自检一次（`convert('舊') === '旧'`），
> 转换器坏了要立刻知道，而不是让过滤结果悄悄变错。

### 搜索缓存策略（SQLite 之后）

缓存内容就是 `videos` + `song_meta` 两张表，**没有独立的缓存文件了**。
旧实现「一个关键词一个 JSON 文件」的那套（文件级 TTL、文件数上限 300、
内存 LRU 索引）已经整体删掉 —— 那些机制存在的唯一目的是模拟数据库能力。

- **过期**：只清**地址那一批列**（`durl_url` / `dash_video` / `dash_audio` /
  `dash_duration` / `playurl_at`；`quality` / `support_formats` 两列已删，
  见 v4 改动），时长取 `cache.searchResultExpireMs`（**0 = 永久**）。**不删任何行**
- **容量**：不再有文件数上限 / LRU 淘汰。留着的行只有标题封面这类短文本，
  体积由 `dash_video` / `dash_audio` 那两段 JSON 主导，而它们会被上面的过期清理收敛
- **空结果不写缓存**（见下）
- 设置里可查看占用、手动「清理过期」或「全部清除」

> `cache.enable` 与旧 `cache.maxAge` 在早期版本里只是声明了却从未被读取，属于「死设置」。
> 现在 `cache.searchResultExpireMs` 是唯一权威的过期设置（界面上叫「搜索结果过期时间」），
> `cache.maxAge` 保留键名但**主进程完全不读**。

**空搜索结果不写缓存（踩坑记录）**

`cacheManager.save()` 本身不做任何空值判断，而 `api:searchSong` 原来是无条件写盘的。
于是「搜到 0 个」这个结果会被**当成正常缓存存 3 天**，后果是：

- 省不下任何东西（下次还是得联网才知道有没有）；
- 把一次**偶发失败**（断网、风控、接口抽风、登录态刚好过期）**固化**成
  「这首歌 3 天内永远找不到视频」；
- 更糟的是读的时候走缓存、**连网络都不会碰一下**，日志里什么都看不到，
  用户只能手动点「刷新」才有救。

现在在写入端收口：**过滤掉非视频条目之后条数为 0 就不写缓存**。
判断依据是**过滤后的视频条数**而不是 `code` —— B 站有时正常返回 `code: 0`，
但 `result` 里全是番剧 / 专栏，对播放器来说等于空。

**★ 搜索结果为空 = 被风控（这里改过一轮，结论反了）**

原来是「空结果不落盘 → 渲染层放心重试最多 3 次（间隔 800ms）」。
现在**重试全部删掉**，理由是用户点破的一句：

> **「B 站不会返回空结果的」**

这句是对的：一首正常存在的歌，只要搜索词里有歌名，B站总能搜到点东西
（哪怕不相关）。**「第 1 轮就返回 0 条」几乎只有一种解释 —— 请求被风控拦了。**

所以现在的做法是**把「空」当成错误信号**，而不是「再试一次」：

```
第 1 轮返回 0 条
  → 抛 RateLimitError（不再跑第 2/3/4 轮）
  → 渲染层 catch 里按文案识别（IPC 会把 Error 序列化，丢掉 name / 原型）
  → 弹「切歌太快太频繁，等一两分钟再试」
```

**两种「没结果」的提示是分开的**，因为解决办法完全不同：

| 情况 | 提示 | 用户该做什么 |
| --- | --- | --- |
| `filtered: true` | 「结果都被过滤规则挡掉了」| 去设置放宽规则 |
| 被限流 | 「被 B 站限流了，切歌太快」| **等一两分钟**，别连续切歌 |
| 其它失败 | 「搜索失败」+ 原始错误 | 检查网络 / 登录 |

> 为什么未登录要单独一句：B 站对未登录用户只放出一部分结果，
> 「没有」在未登录状态下很可能只是权限问题，说「未找到视频」会让用户
> 以为歌名写错了。
>
> 全部用 `$notify`（右上角浮层）而不是 `$message`（一闪而过）：
> 这些提示都**带操作指引**，用户需要时间读完。

### B站风控（412）—— 三层防护 + 一层 UI 防护

这是「切歌切着切着突然一首歌都搜不到了」的真正原因，值得单独记一节。

**怎么发现的**（用最朴素的裸请求验证，不涉及我们的签名逻辑）：

```
同一个 IP、前后两个请求：
  请求 1「飞鸟和蝉 任然」   → HTTP 200, code 0, 返回 20 条  ✅
  请求 2「修炼爱情 林俊杰」 → HTTP 412（响应体是一整页 HTML 拦截页）❌
```

**结论**：不是被永久封，也不是代码坏了 —— 是**请求密度**触发了 B站风控。
而当时的请求密度是这样的：

```
一首歌：4 轮降级（全站 / 音乐区 / MV / 括号内容）
        × 每轮「一页不够就翻第二页」= 最多 8 个请求
        × 渲染层空结果再重试 3 次
        = 最坏二十多个请求
再连续切几首歌 → 上百个请求 → 412
```

**现在的四层收敛**：

| 层 | 做法 |
| :--- | :--- |
| ① 节流 | 发请求前过 `throttleSearch()`，**500ms**（模块级时间戳跨调用共享）|
| ② 不翻页 | 每轮只取第 1 页（B站一页 42 条）—— 五轮降级已覆盖「换词再找」，翻页边际收益不值得 |
| ③ 空了就停 | 第 1 轮 0 条 → 抛 `RateLimitError`，**不再跑后面三轮** |
| ④ 412 整轮中止 | 降级循环 catch 里 `isRateLimitError(err)` → 直接 `throw`（其它错误才继续）|

**为什么风控必须单独一个错误类型**：412 和「网络断了」的**处理方式完全相反**。
网络错误等一等重试是合理的；**风控 412 再发只会让封禁更久**。
原来的 `biliGet` 把它们混成一个 `Error('HTTP 412')`，上层只会傻等 1 秒重试 ——
恰好是风控最不希望发生的事。

**第五层：请求期间禁用会发请求的 UI**

除了「少发请求」，还要防「用户连点」。请求在飞时（`netBusy`）：

| 禁用 | 不禁用（本地功能）|
| :--- | :--- |
| 控制栏的上一首 / 下一首 | 播放 / 暂停 |
| **托盘菜单**的上一首 / 下一首 | 音量 / 静音 / 进度 |
| **系统媒体键**的上一首 / 下一首 | 两个列表开关 |
| 清晰度 / 音质下拉（**外加 3 秒冷却**）| 循环模式 |

> **守卫放在 `prev()` / `next()` 函数内部**，不是每个调用点：
> 会调它们的有控制栏、托盘、媒体键、将来的快捷键 —— 逐个补漏迟早会漏。
> 模板里那句 `@click="busy ? null : ..."` 只负责**视觉反馈**（灰掉 +
> `not-allowed`），不承担拦截职责。
>
> **必须给提示**：拦了却没反应，用户会以为按钮坏了。所以 `notifyNetBusy()`
> 弹一句「正在加载中，请稍候……（切太快会被 B站限流）」，**2 秒节流**；
> 按钮加 `title`，悬停也能看到原因。
>
> **`netBusy` 用计数器不用布尔**：切歌时「搜索 → 解析地址」是两段连续请求，
> 布尔会被先结束的那个提前清掉，于是「解析还没完」按钮已经解禁了。
>
> **预热不参与 `netBusy`**：它是后台行为（用户什么都没点），
> 不该因此看到按钮变灰；防叠加靠它入口处的「有请求在飞就让路」。


---

---

## 打包与代码保护（V8 字节码 / 混淆 / asar 加密）

`npm run pack`（免安装目录）与 `npm run dist`（安装包）会走保护流水线，**开发完全不受影响**：

```
build:only（electron-vite 三个目标）→ out/            ← 保护前必须是干净明文（脚本会检查）
   ↓
protect（scripts/protect.mjs）**就地改写 out/**
   1. 主进程 / 预加载 → V8 字节码（bytenode）      index.js 变成几百字节加载器 + index.jsc
   2. 渲染层 js → 混淆（javascript-obfuscator）     字符串数组 + 十六进制标识符
   3. 渲染层 html/js/css → AES-256-GCM 加密         文件头 BLWE1
   ↓
electron-builder（asar）→ 打包 out/
```

运行时：主进程注册 `blwe://` 协议（`electron/main/protection.ts`），页面请求哪个资源就解密哪个，
只解密到内存；页面地址从 `file://` 变成 `blwe://app/index.html`。
密钥在 `electron/main/bundleKey.ts`（会被编进主进程字节码，不是明文躺在 asar 里），
打包时可用 `BLWE_BUNDLE_KEY` 覆盖。

> **为什么 `protect` 必须先检查 `out/` 是不是干净明文（这是踩出来的）**：保护是**就地改写**，
> 所以它既不能在已经保护过的产物上再跑一遍（会把加载器当源码再编、把密文再加密一层），
> 也不能在**混合态**上跑。混合态是这么来的：`out/renderer` 还留着上一轮的密文，
> 而 main 被重新构建成明文（一次部分重建就会这样）—— 这时候启动应用，
> 明文主进程没有解密协议，直接把密文当 HTML 加载，**用户看到满屏乱码**（真发生过）。
> 现在脚本一进来就查 `index.jsc` / 加载器 / 密文 HTML 的痕迹，发现任何一样就**直接报错**
> 让人先 `npm run build:only`；宁可报错，也不要闷头做出一份坏产物，
> 更不要（早期写法）静默「跳过」，把混合态留在磁盘上。
>
> 另外：`out/` 被保护之后**不要直接跑 `npm run dev` / `electron .`**（会加载密文页）；
> 先 `npm run build:only` 还原明文。

> **老实说**：客户端加密只是提高门槛，不是不可破解 —— 密钥必须在客户端才能解密。
> 想真正拦住人得靠服务端，而本项目是纯本地播放器。这一步的实际效果是
> 「不能直接打开 asar 读源码 / 改一行就跑」，而不是「绝对安全」。

踩过的坑（每一个都真踩了）：

| 坑 | 现象 | 怎么修 |
| --- | --- | --- |
| **模块模式字节码不能用 `runBytecodeFile`** | 加载器执行了、`require` 也返回成功，但**窗口永远不出现**，而且不报任何错（`compileAsModule: true` 编出来的只是模块包装函数，没被调用） | 加载器写成 bytenode 官方那种 CommonJS 形式：`require('bytenode')` + `module.exports = require('./index.jsc')` —— `.jsc` 的模块扩展由 bytenode 挂上，这样才会真正执行 |
| **环境里的 `ELECTRON_RUN_AS_NODE=1`** | bytenode 要拉起 Electron 自己来编译（必须同一套 V8），命令形如 `ELECTRON_RUN_AS_NODE=1 electron.exe --no-sandbox …`；环境里本来就带着这个变量时 Electron 退化成纯 Node，报 **`bad option: --no-sandbox`**（完全看不出真因） | 脚本开头 `delete process.env.ELECTRON_RUN_AS_NODE` |
| **保护脚本崩了却没人发现** | 改加载器时在**模板字符串里用了反引号**，脚本直接语法报错；而 `build:only` 已经把明文写进 `out/`，于是「保护后的 asar」里全是明文。更糟的是**验证是瞎的**：解密函数对明文原样返回，`blwe://` 那条路照跑不误、测试全绿 | ①别用管道把 stderr 和退出码一起吞掉；②验收改成**字节级**：`out/renderer/index.html` 头必须是 `BLWE1`、`out/main/index.js` 只有几百字节且存在 `index.jsc` |
| **`registerSchemesAsPrivileged` 的时机** | 必须在 `app.whenReady()` **之前**调用，否则 `blwe://` 不是标准/安全上下文，fetch、MSE、CORS 全按普通自定义协议处理 | 放在模块顶层（`setupUserDataPath()` 之后、`whenReady` 之前） |
| **换协议把跨域取流搞挂** | 页面 origin 从 `file://` 变成 `blwe://app` 后 dash 音视频流的 `fetch` 开始报 CORS；实测 B 站 CDN 会把**第一个请求者的 Origin** 写进 `Access-Control-Allow-Origin` 并按 URL 缓存（报错原话：`has a value 'http://localhost:5173' that is not equal to the supplied origin`） | 在 `onHeadersReceived` 里对媒体域**统一改**成 `*`（并删掉 `Access-Control-Allow-Credentials`）。**必须大小写不敏感地先删再加**：CDN 回的是小写键，直接赋值等于又加一条，浏览器看到 `ACAO: blwe://app, *` 两个值会判非法（第一版就这么写的，报错从 1 条变 20 条） |
| **asar 本身没有加密** | `asar` 只打包不加密；`asarUnpack` 更是把文件原样摊在磁盘上 | 自己加密 + 自定义协议解密。`bytenode` 必须进 `dependencies`（加载器运行时要用）；koffi 的原生二进制走 `asarUnpack`（见下面「打包体积」） |

**验收方式**（以后改这块照这个来）：

1. `npm run build:protected` 后做字节级检查（密文头 + `.jsc` 存在 + 加载器只有几百字节）；
2. 用 `BLWE_FORCE_PROTECT=1` 跑开发态验证：页面 URL 是 `blwe://app/`、DOM 完整、`electronAPI` 可用、
   能搜到歌、能起播 —— **并且要断言音频真解码**（只看 `duration` 会漏掉 CORS 问题）；
3. `npx electron-builder --dir` 后用 `@electron/asar` 抽文件看头是不是 `BLWE1`；
4. 直接启动 `release/win-unpacked/BLWE.exe`，看窗口标题出不出来
   （标题来自渲染层，等于「解密 + 混淆后仍能跑」的端到端证明）。

### 打包体积（踩坑记录：一个 `**` 通配符让安装包多了 47 MB）

**结论：`asarUnpack` 里的 `**` 会把整个包（含构建中间产物）原样摊到磁盘上，必须精确到文件。**

原来写的是：

```json
"asarUnpack": ["**/node_modules/electron-as-wallpaper/**"]
```

而 `electron-as-wallpaper` 安装后**带着 Rust 的 `target/` 目录**（`cargo build` 的中间产物，
`.rlib` / `.rmeta` / build-script `.exe`）。实测：

| 项 | 实测值 |
| --- | --- |
| `electron-as-wallpaper` 整包 | 302 文件 / **105.5 MB** |
| └ 其中 `target/`（Rust 构建垃圾） | 286 文件 / **105.3 MB** |
| └ 其中 `build/neon.node`（**唯一真正需要的**） | **214 KB** |
| `app.asar.unpacked`（被 `**` 全量解包） | **134 MB** |
| `app.asar`（真正的业务代码） | 仅 3.9 MB |

也就是说：**134 MB 的解包目录里，99.8% 是纯垃圾**，是业务代码的 34 倍。
这些文件在 asar 里（会被压缩）本来不占多少，一旦被 `asarUnpack` 摊到磁盘就全部实体化。

改成 koffi 之后，连带这 105 MB 一起消失（koffi 是预编译包，没有构建目录）。
现在只需要解包**一个 `.node` 文件**：

```json
"asarUnpack": ["**/node_modules/@koromix/**/*.node"]
```

`electronLanguages` 是第二笔（Electron 默认带 55 个语言包）：

```json
"electronLanguages": ["zh-CN", "en-US"]
```

实测收益（同一份代码，`--dir` + portable 目标）：

| 项 | 之前 | 之后 |
| --- | --- | --- |
| `app.asar.unpacked` | 134 MB | **1.0 MB** |
| `locales` | 49.5 MB（55 个 .pak） | **1.1 MB**（2 个） |
| `win-unpacked` 总计 | 492 MB | **314 MB** |
| **portable 安装包** | **130.8 MB** | **83.9 MB（−36%）** |

剩下的 314 MB 里，Electron 内核自己占约 307 MB（`BLWE.exe` 一个就 221 MB，
带 ICU + V8 snapshot），**这才是硬成本** —— 想再降只能换运行时（见下面「框架选型」）。

> **别把 Element Plus 当体积元凶**：实测它的产物约 2.4 MB JS + 0.4 MB CSS，
> 在 314 MB 里占 0.9%。按需引入能省约 0.4 MB，但会引入插件和回归风险，
> 性价比远低于上面那两行配置。

### 关于框架选型：为什么留在 Electron，不迁 Tauri

评估过一次（Tauri 2 + WebView2），结论是**不迁**。理由按重要性：

1. **成本比悬殊**：触发这次评估的壁纸 bug 是十几行修复；而 Tauri 要重写整个主进程
   （约 5750 行 Rust，扣除与渲染层共用的 common 类型），估算 6–12 周达到功能对等 + 2–4 周稳定期。
2. **Tauri 唯一真正的收益（摆脱 Rust 工具链）用 koffi 就拿到了** —— koffi 是预编译 N-API 包，
   约 330 行 TS 就替掉了那个 105 MB 的原生包，还顺带拿到真实的 `GetLastError()`。
3. **Tauri 会新增两个当前不存在的真实阻塞点**：
   - **改请求头的能力没了**。本项目靠 `session.webRequest.onBeforeSendHeaders`（注入
     `Referer: https://www.bilibili.com/`）和 `onHeadersReceived`（把 CDN 的 ACAO 一律覆盖成 `*`）
     让渲染层直接 `fetch()` B 站媒体直链。Tauri 的 `on_web_resource_request` 官方文档明确写着
     **对外部 URL 不生效** —— 要么在 Rust 侧做媒体代理（视频流全过一遍 Rust 进程），要么关 web security。
     这是**架构级障碍**，不是工作量问题。
   - **MSE 编解码从「自带」变成「看系统」**。Electron 自带 `ffmpeg.dll`，H.264/AAC 支持由应用保证；
     WebView2 依赖系统 Edge 运行时 + OS 媒体组件（Win10 N 版没有 Media Feature Pack 就没 H.264）。
     本项目核心是 MSE 播视频，这等于把「解码可用性」从应用可控变成机器相关。
4. **体积优势在离线自包含的前提下会消失**：依赖系统 WebView2 时安装包约 5–10 MB，
   但目标机是 Win10，老镜像不保证有 WebView2；要保证离线可用得用 `OfflineInstaller`（+127 MB）
   或 `FixedRuntime`（+180 MB），**跟现在的 84 MB 相比没有优势**。
5. **内存优势被夸大**：WebView2 同样是多进程架构（`msedgewebview2.exe` 会拉起 browser/renderer/GPU），
   实际空载大概从 150–250 MB 降到 80–150 MB，约 30–40% 而非数量级。
6. **反直觉但重要的一条**：迁移会**放大**「某台机器上不行」这类问题。
   Electron 自带 Chromium，所有机器行为一致；WebView2 版本随机器变化。
   对于核心是 MSE 视频播放的应用，把运行时从「自带」换成「随机器变化」是**可预测性上的净降级**。

**什么条件下才值得迁**（满足任意两条再考虑）：需要跨平台（注意壁纸模式是 Windows 独有技巧，
跨平台收益有限）；体积成为硬约束且愿意接受依赖系统 WebView2 的兼容性风险；
想摆脱 Chromium CVE 的升级节奏；**本来就要重写主进程**；或已累积更多 Electron 生态的坑。

**需要实测验证的点**（当时没验，别当已知事实）：WebView2 上透明窗口 + `backdrop-filter` 的表现、
`navigator.mediaSession` 是否桥接到 Windows SMTC、H.264 在所有目标机的可用性、
JS 侧托盘 API 是否暴露图标矩形、`SetParent` 到 WorkerW 后 WebView2 子窗口的渲染是否与 Tauri 窗口管理器冲突。

---

## 一次代码审查修掉的东西

给自己留个记录：下面这些不是「设计」，是**真的漏掉 / 写错**的地方，改动都带了注释说明原因。

**渲染进程**

| 问题 | 根因 | 现在的做法 |
| --- | --- | --- |
| 定时自动同步永远不触发 | `watch(setting, deep)` 里无条件 `setupSyncTimer()`，而播放中每 5 秒就广播一次 `player.resumeTime`，定时器一直被重建 | 只 watch「有没有定时歌单 + 最小间隔」这个指纹（`_syncKey`），不变就不重建 |
| 单曲循环播完不重播 | 只改了 `this.currentTime`，没碰 `<video>`；`this.paused` 也从不跟随元素 | `videoEnded` 里 seek 回 0 再 `play()`；`onVideoPlayStateChange` 同步 `this.paused` |
| 解析失败被当成成功 | 主进程失败时**不抛异常**，回 `{videoUrl:null, error}`，渲染层不看 `error` | 判 `res.error` 走失败分支；`AUTH_FAILED` 单独提示「登录已失效」 |
| 切歌窗口期旧视频报错算到新歌头上 | 为了修缓存 key，把 `videoListKeyword` 提前设成了新歌，破坏了 `videoError` 的守卫 | 恢复「解析成功才更新」的语义；换清晰度 / 退 durl 统一用 `this.songName` |
| 切歌失败或搜不到时旧视频还在放 | 失败分支没有清播放状态 | 两个分支都 `clearNowPlaying()`（含停掉 `<video>`、复位进度与失败计数） |
| 切歌瞬间进度还是上一首的 | `currentTime` / `duration` 未复位 | `onEngineSwitch()` 里一起复位，`playCurrent` 不会再写错 `resumeTime` |
| 同步后随机播放可能卡住 | 曲目变了但 `randomList` 没重建，随机下标越界 → `getSongName` 返回 null 静默 return | `reloadCurrentPlaylistSongs` 里 `resetRandomList()` |
| 编辑「非当前」歌单会把正在听的歌从头重播 | 弹窗保存后无条件发 `switch`，而 App 只看 `currentId` | 弹窗改用 `reload` 事件；App 侧再加一道 `id !== currentId` 的防御 |
| 封面坏一张，其它歌单同一行永远空白 | `onImgError` 写内联 `display:none`，而列表 `:key` 是 index，DOM 会被复用 | 改成按 URL 记 `failedCovers`（与 `SongVideoListDialog` 一致） |
| 改「字体颜色」有些字不变 | 一堆写死的 `#fff` / `rgba(255,255,255,…)` | 全部换成 `--glass-*` / `--panel-*` 或从 `--text-rgb` 派生；新增 `--accent*` 收纳功能色 |
| **改「控制栏闲置透明度」没反应** | `main.ts` 的 `watch` 数组列了主题色/模糊/阴影，**唯独漏了 `common.idleOpacity`**，而 `uiTheme` 确实会读它写 `--ui-idle-opacity` | 把这个键加进那个数组（数组必须与 `applyUiTheme` 实际读取的键保持一致）|
| **第二首歌的卡顿恢复比第一首差** | `_stallUrlIndex` / `_stallQualityDrops` 只在 `onVideoLoaded` 复位，而新歌若在 `loadeddata` **之前**就卡住，那次复位不会发生 → 带着上一首的计数：跳过备用源、降清晰度直接判满 | 在 `onEngineSwitch` / `clearNowPlaying` 两处归零（换条与停播是仅有的入口）|
| **「所有源都卡住」的常驻通知能重复叠加** | 它 `duration: 0`（要手动关），而 `_stallGivenUp` 每次换源都被复位 → 8 秒后又弹一条同样的 | 用 `_stallNoticeOpen` 记「那条还开着没有」，开着就不新弹，`onClose` 清标记 |
| **定时「等视频播完」会永久挂起** | `pending` 分支只看 `currentTime` 是否落在 0-3 秒，而视频**暂停**时它永远不动 | `pending` 里加：`!video \|\| video.paused` → 直接执行（`paused` 才是「不会再往下播」的明确信号）|
| **0 时 0 分点确认：弹完警告却关了面板** | `applySleepTimer` 弹 warning 并 return（什么都没设），而面板 `confirm()` 紧接着自己 `visible = false` | 未定时且 0/0 时**禁用确认按钮**（定时中不禁用 —— 那是「取消定时」的语义）|
| **「添加视频」加进来的排在库里最后** | `setFavorite` 里「库里没有这一行」的分支插到 `maxOrd + 1`（末尾），与渲染层「立刻显示在第一位」相反 | 两种情况统一：其余全部 `ord + 1`、自己占 0（同一事务）|
| **分值档里的词永远不生效** | `-10` / `-20` 档塞了 18 个**和过滤关键词完全相同**的词 + 5 个被包含的，而 `passHardFilter` 在打分**之前**就把它们丢了 | 从 `tagBonus` 删掉这些重复词（留在 `filterKeywords` 里「命中即丢」）|
| **补时长对「不在列表里」的视频整段跳过** | 判据是 `video && !video.duration`，而 `video` 来自 `findIndex`（可能 `-1`），此时 `res.duration` 已在手上却不用 | 判据改成「时长确实还缺」：`!video \|\| !video.duration` |
| **≥100 分钟的歌曲，时长过滤整段失效** | `formatPlayTime` 产出 `"100:00"`（分钟 3 位），而 `durationToSeconds` 的正则只认 1-2 位 → 解析成 `null` → 该曲目时长存 NULL → 没参照物就不过滤 | `durationToSeconds` 改用 `split(':')`（2 段=分:秒、3 段=时:分:秒，位数不限）|
| **连续切歌把 B站惹毛了（412 风控）** | 一首歌 4 轮降级 × 每轮翻 2 页 + 渲染层空结果再重试 3 次 = 最坏二十多个请求打出去。实测同一个 IP 前后两个请求：一个 200、下一个直接 412 | 四层收敛：① 请求**节流 500ms**；② **不翻页**（每轮只取第 1 页）；③ **第 1 轮返回 0 条就认定被限流**，抛 `RateLimitError` 不再往下跑；④ 降级轮遇到 **412 整轮中止**。渲染层的 3 次重试**全删**（空 = 风控，重试只会更久）|
| **风控和网络错误被当成一回事** | `biliGet` 把 412 和其它非 2xx 一起 `throw new Error('HTTP 412')`，上层只会「等 1 秒重试」—— 而风控**最不该做的就是重试** | 单独定义 `RateLimitError`，`biliGet` 里识别 412；上层用它区分「该停手」和「该重试」|
| **用户点了没反应，以为按钮坏了** | 请求期间把切歌按钮禁掉（防连点）却没有任何反馈 | 拦截时弹 `$message`「正在加载中，请稍候……（切太快会被 B站限流）」，**2 秒节流**；按钮加 `title`，悬停也能看到原因 |
| **「多个括号」只取了第一段** | `bracketContentOf` 只 `push` 第一次匹配 | 多段全部拼接（`回家 萨克斯版`），但**同一段去重**（歌单里出现过 `(萨克斯版) (萨克斯版)` 这种数据，不去重搜索词会变长变怪）。<br>※ 该函数后来**整体换成 `splitSongName().tail`**（它只取括号内、漏掉括号后的 `feat.xxx`），去重逻辑搬到了 `stripBracketChars` |
| **`溯(Reverse)feat.马吟吟` 这种歌名搜不准** | 旧逻辑「剥掉括号、**保留括号后面的文字**」→ 歌名变成 `溯feat.马吟吟`，配上歌手名就成 `溯feat.马吟吟 马吟吟`（还撞名了）。而第 4 轮只取**括号内**的 `Reverse`，`feat.马吟吟` 那段永远搜不到 | 改成**在第一个括号处劈开**：前面是正名（`溯`）、后面（括号内 + 括号后）是尾巴（`Reverse feat.马吟吟`）。两半互补，各管一轮 |
| **第 4 轮的词和第 1 轮一模一样** | 括号在最前面时（`(Intro)` / `【伴奏】晴天`），正名是退回用括号内容撑起来的，而 `tail` 又是同一串 → 第 4 轮把第 1 轮的搜索词原样再发一次，纯浪费请求 | `tail` 的每个词都在 `name` 里时**置空**（`isCoveredBy`，按词集判而不是整串，词序不同也算重复），第 4 轮退回 `可视化` |
| **带空格的歌名几乎必然被挡** | `【伴奏】晴天` 的正名是 `伴奏 晴天`，`normalize` 去掉空格后变成 `伴奏晴天`，要求标题里**连着**出现这 5 个字 —— 而实际标题是「伴奏 - 晴天」「晴天（伴奏）」，连不起来 | `passHardFilter` 里「**整串不中且是多词 → 拆词分别判**」，每个词都要独立出现。普通歌名（单词）行为完全不变 |
| **换清晰度白打一次请求** | `switchQuality` 传了 `skipCache: true`，把「地址还没过期」这条快路径也废掉了 | 去掉 `skipCache`：B站一条 dash 流本来就带全部候选档位，库里存的 playurl 是**整个响应**，所以换档位只需 `extractDashStreams(缓存的 playurl, 新qn)` —— **不联网**。地址过期 / 没那个档位 / 登录态变了时，主进程自己会重新解析 |

**主进程**

| 问题 | 现在的做法 |
| --- | --- |
| 「登录失效」被拍成「解析失败」 | `AUTH_FAILED` 原样回传，界面提示重新登录 |
| 全屏 / 壁纸写死主屏，副屏会跳屏 | `screen.getDisplayMatching(window.getBounds())` |
| 拖动还原窗口在副屏算错（少了 `bounds.x`） | 相对位置改成 `(cursor - bounds.origin) / size` |
| 搜索缓存「读-改-写」丢更新 | 换成 SQLite 后按主键更新一行，整类问题消失 |
| ~~缓存落盘非原子 / 文件名会撞（`A/B` vs `AB`）~~ | **已作废**：`search-cache/` 那套「每键一文件 + md5 命名 + 原子写」整体删掉了，现在过期的粒度是字段而不是文件 |
| 同一个视频被两首歌引用时地址存两份 | v1 曾为此拆出 `video_details`（按 bvid 唯一），**v2 又合回 `videos`** —— 那个重复很少见，而拆表让每次查询都要 `LEFT JOIN`、`clearAll` 清三张表，不划算 |
| 登录成功可能派发两次 | `finishLoginIfReady` 加 in-flight + finished 标记 |
| 登录页每次导航都重复注入关闭按钮 / 倒计时 | 注入前先探测元素是否已存在 |
| 酷我 `digest-5__123` 永远走不到 | `detectSource` 先特判这个前缀 |
| 拔屏 / 改分辨率后全屏几何不更新 | `display-*` 事件里重算（**必须等 app ready 再注册**，否则主进程直接起不来） |
| 托盘 / 窗口图标在打包后是空白 | `resolveAsset` 按 `resources/icons → public → out/renderer` 找；`extraResources` 带进包 |
| 启动失败静默留一个没窗口的进程 | `whenReady().catch` → 弹错误框 + 退出 |
| 主窗口可能被导航到站外（preload 会跟过去） | `will-navigate` 白名单 + `setWindowOpenHandler` 拒绝 |
| 打开外链没有白名单 | `app:openExternal` 只放行 http/https |
| **用户可见文案里写满了内部细节** | 提示语原来长这样：「被 B 站限流了」「B 站把请求拦下来了」「SourceBuffer 配额超限」「无法获取视频 CID」「HTTP 500」。用户会**截图**，等于把「我们在按接口规则大量请求 + 怎么实现的」写在屏幕上；而且对用户毫无帮助（他只需要知道「怎么办」）。现在**统一收口**：`errMsg()` 加一道技术文案过滤（状态码 / 全大写错误码 / `SourceBuffer` 等内部词命中就换成「操作失败，请稍后再试」，原文只进控制台）；各处 `throw` 的文案改成人话；`RateLimitError` 的 message 也改成中性措辞，识别靠**类型**而不是靠匹配「风控」这种词 |
| **同时开两个实例 → 第二个窗口里一个歌单都没有** | 原来**没有单实例锁**。第二个实例完整跑起来、也去开同一个 `blwe.db` —— 而 **SQLite 允许多个连接打开同一文件**（`new Database()` 根本不会失败），于是它读到的歌单是空的（WAL 里第一个实例还没 checkpoint 的部分它看不见）。用户看到的就是「再开一个窗口，里面啥都没有」。<br>修法：`app.requestSingleInstanceLock()`，拿不到就 `app.quit()`；第一个实例监听 `second-instance` 用 `restoreWindow()` 把窗口拉到前台（顺带处理「窗口最小化了」「壁纸模式下挂在桌面层」两种状态 —— 裸 `show()` 对 WorkerW 子窗口是无效的）。<br>⚠️ **光 quit 不够**：`app.quit()` 是**异步**的，不会中断执行流，排队的 `whenReady` 回调照样跑完、照样 `initSetting` / `initPlaylists`（实测第二个实例日志里能看见 `[playlist] 已加载 0 个歌单`）。所以 `whenReady` 回调开头还要一道 `if (!singleInstanceLockHeld) return`。<br>⚠️ 顺序：锁必须在 `setupUserDataPath()` **之后**（便携版会改写 userData 路径，锁得跟着用同一个路径，否则便携版和安装版会被当成两个不同实例）、在 `initSetting()` **之前** |

**顺手删掉的死代码**：`common/index.ts`（没人 import 的 barrel）、`wallpaperDetect.ts`
（WorkerW 检测没人调用，当时壁纸走的是 `electron-as-wallpaper`）、三个「声明了但从没被读取」的设置
（`common.startupAutoPlay` / `common.windowSizeId` / `player.isSavePlayIndex`）、四个「三段齐全但零调用」的
IPC（`playlist:get` / `playlist:save` / `auth:reLogin` / `cache:clearSingle`）、`store` 的 `has`/`set`/`all`、
`BROADCAST_EVENT_NAME` 里没用到的成员、一批只为导出而导出的函数，以及 store 里那层
「给每个设置项包一个 computed」的包装（组件统一直接读 `setting['xxx.yyy']`）。

> **注意（后来翻案了）**：当时连 `koffi` 依赖一起删了，因为「WorkerW 检测没人调用」。
> 但现在 `koffi` **回来了**，而且是壁纸模式的主力 —— `winWallpaper.ts` 用它直接调 Win32
> （原因见上面「壁纸层用 koffi 自己调 Win32」）。删它的时候没错，错的是当时选错了实现路径：
> 用 `electron-as-wallpaper` 换来了 Rust 工具链依赖和那个致命 bug。
> 教训：**「暂时没用到」不等于「不需要」，尤其当替代方案会引入外部工具链时。**

**后来又清掉的一批**（一次代码审查的结论）：`player.playIndex`（只写不读，续播用的是歌单的 `lastIndex`）、
`DuplicatePolicy` 的 `'keep'` 与那个从没人传的 `duplicatePolicy` 参数（现在同步固定去重）、
`cache.clearSingle()`（IPC 与函数一起删了）、`ipc.ts` 里的 `PlaylistSong = string` / `Playlist`
（与 `types/playlist.ts` 的结构化同名类型冲突，全项目已无引用）、`BROADCAST_EVENT_NAME` 里 11 个没人
按名字引用的常量（广播事件全集看 `types/ipc.ts` 的 `IpcEventMap`）、`main/utils/quality.ts` 里重抄的
档位标签表（改为从 `VIDEO_QUALITY_OPTIONS` 推导）。

---

## 开发与验证（踩坑记录）

给自己留的操作说明 —— 这个项目很多问题**只有真跑起来才能确认**（透明窗口、壁纸层、
托盘、任务栏、焦点），所以踩过的坑也记一份。

**跑一次真实环境验证**（在仓库根目录）：

```powershell
# 1) 先构建：esbuild 会 spawn 子进程，沙箱下会 EPERM，需要放宽权限
npm run build

# 2) 用 Electron 跑一个临时脚本（脚本里 require('./out/main/index.js')）
cmd /c "set ELECTRON_RUN_AS_NODE=&& node_modules\electron\dist\electron.exe verify-xxx.cjs > verify-xxx.log 2>&1"
```

- **`ELECTRON_RUN_AS_NODE=1` 是个大坑**：这个环境变量被置上时，`electron.exe` 会退化成**纯 Node**
  跑脚本，于是 `require('electron').app` 是 `undefined`，报错是
  `Cannot read properties of undefined (reading 'setName')`。跑之前把它清掉。
- **`npx electron` 也可能被这个变量带偏**，直接用 `node_modules/electron/dist/electron.exe` 最稳。
- **验证脚本必须把 `userData` 指到真实目录**：直接跑 `electron.exe script.js` 时，
  app name 是默认的 `Electron`，于是 `userData` 会指向 `%APPDATA%\Electron` ——
  **那是另一个空库**，读出来当然和真实数据对不上，得出完全不同的结论。
  两种写法都行：
  ```js
  app.setPath('userData', path.join(process.env.APPDATA, 'BiLiWallpaperEngine'))
  // 或： app.setName('BiLiWallpaperEngine')   ← userData 跟着 app name 走
  ```
  **目录名以 `package.json` 的 `name` 为准（= `BiLiWallpaperEngine`）**，
  不是 `build.productName`（`BLWE`，那是 electron-builder 字段，Electron 不读）。
  想验证**便携版**行为时反过来 —— 要显式指到临时目录，别碰真实库。
- **临时插桩**：自绘托盘菜单的「弹出/收起」是模块内私有函数，没法从外部调用。
  验证时**在构建产物 `out/main/index.js` 末尾临时追加** `globalThis.__showTrayMenu = showTrayMenu`
  （只改产物、不碰源码），验完 `npm run build` 覆盖掉，并确认产物里没有 `TEST HOOK` 残留。
- **Win32 命中测试比「真点一下」安全**：想确认「鼠标位置会落到哪个窗口」时，
  用 PowerShell `Add-Type` 调 `WindowFromPoint` + `GetAncestor`，把结果和
  `win.getNativeWindowHandle()` 比对，**不用真的点鼠标**（不会误伤用户其它窗口）。
  真需要点击时用 `SetCursorPos` + `mouse_event`，并且**先把光标位置存下来、结束还原**。
- **界面对不对由用户说了算，不要自己截图判断**：`capturePage()` 能截图，但**不要**拿它当界面验收的
  手段 —— 观感（图标好不好看、间距舒不舒服）由用户反馈决定。自动化只验证**可断言的行为**：
  DOM 状态、索引有没有串位、播的是不是那一首、接口返回值、有没有 `console.error`。
- **用户可能同时在用这个应用**：验证脚本跑的时候，真实鼠标点击会落进来（我遇到过一次
  被并发的 `quit` 打断测试）。所以脚本要幂等、少留可见窗口，结论要看日志而不是只看返回值。

**验证壁纸层（`winWallpaper.ts`）时怎么做**：

壁纸是 Win32 窗口层级操作，**光看应用日志判断不了对错**（这次就栽在这：校验 API 用错，
日志显示「失败」但窗口其实已经挂上去了）。所以做一个**独立探针脚本**，自己建一个临时窗口，
把同一套逻辑跑一遍，并且**同时读多个 API 交叉验证**：

```js
// 关键：一次打印三个 API，任何单个 API 的语义坑都会立刻暴露
SetParentF(hwnd, worker)
log('GetParent              =', GetParentF(hwnd))            // = 0，会误导
log('GWLP_HWNDPARENT       =', GetWindowLongPtrA(hwnd, -8))  // = WorkerW，真实
log('GetAncestor(GA_PARENT) =', GetAncestorF(hwnd, 1))       // = WorkerW，真实
```

几条经验：

- **探针用自建临时窗口，别碰主窗口**：验完 `SetParent(hwnd, 0)` 还原 + `win.destroy()`。
  这样即使逻辑写错，也不会把用户的窗口留在桌面层。
- **判断成功要看「回读」而不是「返回值 / 错误码」**：`SetParent` 成功时返回的是**旧父窗口**
  （顶层窗口就是 0），`GetLastError` 还可能是上一次调用的残留（实测拿到 87）。
- **`EnumWindows` 回调要能改外部变量**：koffi 的 `koffi.proto` 注册回调原型后，
  回调里改闭包变量是可行的（实测枚举到 368 个窗口、成功取到 WorkerW）。
- **`SystemParametersInfoA(SPI_SETDESKWALLPAPER)` 在受限令牌下会失败**（实测返回 0、
  `GetLastError` = 5 拒绝访问）。它只是「让桌面重画一下」，**故意忽略返回值**，
  不要学那个库去 `.unwrap()`。
- 这个环境里跑 Electron 必须**清掉 `ELECTRON_RUN_AS_NODE`**，否则窗口根本起不来
  （症状是 `require('electron').app` 为 `undefined`）。

**复现「没有 GPU 加速」的环境（这次最有用的一个技巧）**：

「虚拟机里壁纸模式有声音没画面」这个 bug 的根因是**透明窗口在无 GPU 时降级成分层窗口**。
不用真的去装虚拟机 —— 在物理机上加一个开关就能复现：

```powershell
# 复现：透明窗口会拿到 WS_EX_LAYERED（layered=1）
node_modules\electron\dist\electron.exe --disable-gpu 你的探针.cjs

# 对照：不加这个开关时，同一份代码 layered=0
node_modules\electron\dist\electron.exe 你的探针.cjs
```

配套用 `app.getGPUFeatureStatus()` 看合成走的是硬件还是软件：

```js
const st = app.getGPUFeatureStatus()
// 有 GPU：gpu_compositing=enabled
// 无 GPU：gpu_compositing=disabled_software  ← 就是会中招的环境
```

以后凡是「只在某台机器上复现」的渲染类问题，先用这个办法试一次 ——
比来回找机器快得多，而且能立刻区分「代码问题」和「环境降级问题」。

**探针脚本的两个坑（都踩过）**：

- **窗口全销毁后 Electron 会自己退出**，脚本只跑到第一个用例就结束了（现象是输出莫名其妙地短）。
  探针里加 `app.on('window-all-closed', () => {})` 顶住。
- **终端输出会被截断**，多用例的结果看不全。**把结果写进文件再 `read`**，
  比在控制台里看可靠得多。


