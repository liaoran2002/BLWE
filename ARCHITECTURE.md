# 实现笔记（架构 / 踩坑记录）

> 这份文档讲的是**为什么这么写**：数据流、类型链路、边界处理，以及一路踩过的坑。
> 只想用这个播放器的话看 [README](README.md) 就够了；
> 想改代码 / 想知道某个诡异行为为什么存在，就翻这里。

**大概分四块**

| 想看什么 | 看哪几节 |
| --- | --- |
| 代码怎么组织的 | 架构设计（目录结构 / 配置数据流 / 类型链路 / 别名） |
| 界面怎么拼的 | 界面布局、图标（iconfont）、界面颜色与毛玻璃（CSS 令牌） |
| 播放链路怎么走的 | 清晰度 / 音质切换、清晰度角标、dash + MSE、缓冲提示、缓存里的播放地址 |
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
│   │   │   └── api.ts              #   preload 暴露给 window 的 api 契约
│   │   ├── defaultSetting.ts       #   默认配置对象（satisfies 强校验）
│   │   ├── constants.ts            #   配置版本号、存储名等常量
│   │   ├── ipcNames.ts             #   广播事件名（invoke 频道名走 types/ipc.ts 的类型）
│   │   ├── mainIpc.ts              #   主进程侧类型化 IPC 包装 + 广播
│   │   ├── rendererIpc.ts          #   渲染进程（preload）侧类型化 IPC 包装
│   │   └── utils/
│   │       ├── migrateSetting.ts   #   配置版本迁移（版本闸门逐级抬升）
│   │       ├── mergeSetting.ts     #   默认值 + 用户值合并，并算出变化的 key
│   │       └── common.ts           #   compareVer / debounce
│   ├── main/
│   │   ├── index.ts                # 入口：便携模式 → 初始化配置/歌单 → 注册 IPC → 建窗口
│   │   ├── portable.ts             # 便携版数据目录（%APPDATA% 优先，否则 exe 同级 data/）
│   │   ├── biliApi.ts              # B站 API（搜索/视频解析/WBI 签名）
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
│   │   │   ├── playlist.ts         # ★ 歌单集合服务：迁移 / 增删改 / 同步
│   │   │   ├── store.ts            # 原子写入的 JSON 存储
│   │   │   ├── atomicJson.ts       # 公共的「temp + rename」原子写
│   │   │   └── cache.ts            # 搜索缓存（文件名 = 关键词 md5）
│   │   └── ipc/                    # 按领域拆分的 IPC handler
│   ├── preload/
│   │   ├── index.ts                # contextBridge 暴露类型化 api
│   │   └── index.d.ts              # window.electronAPI 全局声明
├── src/                            # 渲染进程
│   ├── main.ts                     # 挂载前先拉配置 + 挂广播监听
│   ├── App.vue
│   ├── stores/
│   │   ├── setting.ts              # ★ Pinia：配置的响应式副本
│   │   └── playlists.ts            # ★ Pinia：歌单集合 + 同步编排
│   ├── api/electron.ts             # 直接透出 window.electronAPI（已带类型）
│   ├── assets/                     # 图标字体 + 头像（avatar.jpg / avatar-fish.jpg）
│   ├── types/app.ts                # 组件数据类型
│   └── components/
│       ├── PlaylistPanel.vue       # ★ 左上歌单入口（点一下直接开管理弹窗）
│       ├── PlaylistManager.vue     # ★ 歌单管理弹窗（新建 / 编辑 / 同步 / 曲目）
│       ├── SettingsDialog.vue      # ★ 设置弹窗
│       ├── AboutDialog.vue         # ★ 关于弹窗（仓库地址 / 作者与 DeepSeek·大肥鱼头像）
│       ├── biliVideoControls.vue   #   播放控制栏
│       └── showList.vue            #   歌曲/视频列表弹窗（含封面/专辑/歌手）
└── electron.vite.config.ts
```

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
  - 播放：最高视频清晰度 / 最高音质（自动播放遵守的上限）、记住播放进度、声音输出设备变化时暂停
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

**弹窗的关闭方式**（设置 / 歌单管理 / 歌曲·视频列表 / 添加视频四个都一样）：
不要右上角的叉号（`show-close=false`），点弹窗外面的空白处关闭。
提示「点击空白位置关闭」写在**遮罩**上、弹窗下面 —— 用 `.el-overlay-dialog::after`
（在 App.vue 的全局样式里），一处生效三个弹窗都有；字大加粗，
`pointer-events: none` 所以点它等于点遮罩、照样能关。
Element Plus 的 `close-on-click-modal` 要求 mousedown/mouseup 都落在遮罩上，
所以**拖滑块时把鼠标甩到弹窗外再松手不会误关**。

歌曲 / 视频列表（`showList.vue`）也从「自己写的 fixed 浮层 + 遮罩」换成了 `el-dialog`：
外框（底色 / 圆角 / 模糊 / 白字 + 阴影）复用全局 `.el-dialog` 样式，组件里只管列表内容。

歌单同步策略挂在歌单上而不是全局，是为了避免「明明给歌单设了自动同步，却被全局开关关掉」这种困惑。
应用启动时会按各歌单自己的策略同步；定时同步按所有定时歌单里**最小的间隔做心跳**，每次心跳只同步真正到点的歌单，所以各歌单周期可以不同而只需一个定时器。

底部的播放控制栏（播放、进度、音量、循环模式）由 `biliVideoControls` 负责，鼠标移上去才显现。
信息区两行：上行是 B 站视频标题，下行是 `歌曲名 - 歌手 · 专辑`，
**行尾是清晰度和音质两个角标，点开即可切换**。

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
`icon-play-next`、`icon-ziyuanldpi`）留在模板里就是一个空白按钮，验证脚本里专门有一条检查。

### 界面颜色与毛玻璃（CSS 令牌）

配色不写在组件里，也不再用「黑白主题」两套写死的颜色 —— 全部由设置里的两个取色器决定，
`src/utils/uiTheme.ts` 的 `applyUiTheme()` 把它们写成 HTML 根节点上的变量：

| 设置项 | 界面 | 作用 |
| --- | --- | --- |
| 主题色 | `#RRGGBB` 输入框 + 取色盘 | 玻璃 / 面板的**底色**（默认 `#ffffff`） |
| 字体颜色 | 同上 | 浮层上的**文字颜色**（默认 `#ffffff`） |

落到 CSS 的是「通道 + alpha」，这样 CSS 里能用同一个底色拼出各种透明度：

```css
--glass-rgb: 255, 255, 255;   /* 主题色，uiTheme 写入 */
--text-rgb: 255, 255, 255;    /* 字体颜色，uiTheme 写入 */
--glass-alpha: 0.3;           /* 「透明度」设置，uiTheme 写入 */
--glass-bg: rgba(var(--glass-rgb), var(--glass-alpha));
--panel-bg: rgba(var(--glass-rgb), var(--glass-alpha));
--glass-text: rgb(var(--text-rgb));
--panel-hover: rgba(var(--text-rgb), 0.16);   /* 各种 hover/边框都由文字色派生 */
```

| 变量族 | 用在哪 |
| --- | --- |
| `--glass-*` | **浮在视频上**的毛玻璃：控制栏、左上角歌单入口按钮、标题栏、全屏按钮 |
| `--panel-*` | **面板**：歌单下拉、设置 / 歌单管理 / 关于弹窗、歌曲/视频列表 |

**深浅是算出来的，不是选的**：`uiTheme` 按主题色的亮度决定给 `html` 加什么属性 ——

| 底色亮度 | `data-tint` | 文字阴影 | Element Plus |
| --- | --- | --- | --- |
| 偏亮（≥ 0.5） | `light` | 黑阴影（白底白字看得清） | 亮色 |
| 偏暗（< 0.5） | `dark` | 白阴影（黑底白字看得清） | 暗色（`html.dark`） |

这样用户把主题色拖到任意颜色，都不会出现「白底白字看不出字」；
文字颜色是用户自己选的，阴影只跟**底色**走，所以「浅底配黑阴影、深底配白阴影」这一条永远成立。

**三个毛玻璃 / 阴影参数也是全局的**：

| 设置项 | 界面 | 存的值 | 落到 CSS |
| --- | --- | --- | --- |
| 透明度 | 0-100%，步进 5 | 百分比本身 | `--glass-alpha = 透明度 / 100`（就是底色里的 alpha） |
| 模糊强度 | 0-100%，步进 5 | **0-20 的 px**（百分比 ÷ 5） | `--glass-blur: Npx`，即 `backdrop-filter: blur(Npx)` |
| 阴影强度 | 0-100%，步进 5 | **0-20 的 px**（百分比 ÷ 5） | `--glass-shadow-size: Npx`，文字阴影的模糊半径 |

后两个都是「显示百分比、实际 0-20」：50% = 10px，100% = 20px（阴影默认 8px = 40%）。
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
| 透明度 | 玻璃**底色**有多透（文字始终清晰） | 设置里的滑块 |
| 未悬停淡出 | 整个控件（含文字）淡到 0.1，鼠标移上去变 1 | 固定的 `--ui-idle-opacity: 0.1`，不开放给用户 |

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

### 清晰度 / 音质切换

这两处**不是一回事**，别把它们做成同一份数据：

| 在哪 | 作用 | 选项从哪来 | 是否持久 |
| --- | --- | --- | --- |
| 设置 → 播放 | **自动播放时遵守的上限**（"最多播到哪一档"） | **完整档位表**（12 档清晰度 / 3 档音质） | 是（`setting.json`） |
| 控制栏角标菜单 | 针对**当前这一首**临时切换 | **playurl 响应里真正能拿到的档位** | 否，换歌即失效（`changeSong` 里清掉 `selectedQn` / `selectedAudioId`，下一首回到设置里的上限） |

所以设置页就该铺全表 —— 它是「你愿意播到多高」，和音量 / 循环模式那种「当前值」性质不同；
能不能拿到是平台按登录态 / 会员等级 / 视频可用档位决定的事，不该拿它来限制你选什么。
而角标菜单列的是「这个视频此刻能选什么」，自然只列 playurl 给得出的，
并且**不受上限约束**（手动切换是用户明确要求，设了上限也照样能选上去）。

上限具体生效在两处：`pickDashVideo` 挑「不超过上限里最高的一条」，
`pickDashAudio` 优先 id 精确匹配、否则挑带宽不超过它且最大的那条
（所以选了 64K 不会因为响应里没有 30216 就悄悄给成 192K）。

菜单里档位的取值优先级：

1. 有 dash → 用 `dash.video[]` / `dash.audio[]` 的 `id`（这才是实际能播的流）；
2. 没有 dash（durl 兜底）→ 才退回 `accept_quality`；
3. 展示名一律取 `support_formats` 的 `display_desc` / `new_description`，取不到才用内置档位表兜底。

> 菜单里为什么不铺静态全表：`accept_quality` 只说明**账号有权限**，不代表这条链路给得了
> —— 实测它列出 1080P，durl 通道却只回 720P。列一堆选不了的档位只会误导。

实现上切换就是**带 `qn` / `audioId` 重新解析一次**（`skipCache: true`），
解析前后把播放进度记到 `seekAfterLoad` 里，切完接着播。

**必须把 `qn` / `audioId` 一路传到 `resolveVideoUrl`**：主进程里算出 `wantQn` / `wantAudioId`
却只喂给「读缓存」那一步、忘了传给真正的解析调用，会让它悄悄用回默认值
（这个坑实际踩过：菜单点了没反应，因为解析始终用默认的 30280）。

### 清晰度角标：数据从哪来（踩坑记录）

角标内容取自 **playurl 响应的 `quality` 字段**（`electron/main/utils/quality.ts`），
再用 `support_formats` 里的 `display_desc` / `new_description` 取展示名 ——
那正是 B 站自己播放器显示的文字，能区分「1080P 高清 / 1080P 60帧 / 1080P 高码率」这些同分辨率档位。
dash 链路取「地址和实际播放地址一致」的那条流的 `id`，durl 链路取顶层 `data.quality`。

**不要用请求参数里的 `qn`，但也不要用分辨率硬推。** 实测（`qn` 是请求参数）：

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

平台偶尔会出现「报 720P、帧却是 1920×1080」这类元数据与实际流不一致的情况，
角标按平台档位显示，真实分辨率放在悬浮提示里，不藏着。

### dash + MSE 播放（`src/utils/dashPlayer.ts`）

dash 的视频轨和音频轨是两个 URL，而 `<video>` 一次只能播一个，
所以用 MSE 把两轨塞进同一个 MediaSource 的两个 SourceBuffer 里 ——
对外仍然只有一个媒体元素，进度 / 音量 / 续播 / SMTC 这些现有逻辑一行都不用改。

**默认清晰度**由 `electron/main/biliApi.ts` 的 `PREFERRED_QN` 决定（116 = 1080P 60帧）。
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
- 播放位置连续 3 秒没有前进。

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
| 缓存数据不完整 | 缺 `view_result` 或 `playurl_result` |
| **地址过期** | `isUrlUsable()`：直链带签名时效（`deadline`），提前 5 分钟算过期 |
| **登录态变了** | `playurl_result.loginState` **明确是 `false`**（当时确实未登录）+ 现在已登录 → 这地址是低清晰度时期取的，必须重取 |
| **想要 dash 但缓存里没有** | `dashTried` 还是假 + 缓存里没有 dash 流 → 重取一次试试高清；试过之后写 `dashTried: true`，之后不再反复试 |

**「地址过期」有多常见**：直链签名寿命**实测中位正好 120 分钟**（最大也是 120，
即同一批地址都是 2 小时），而搜索缓存默认保留 3 天。真实缓存统计过一次：
296 条地址里 **272 条（92%）已过期** —— 所以「隔一阵再听」基本上必然碰到，
每首歌**本次运行内第一次**用到时重解析一次。这是平台签名机制，不是故障；
不重解析反而会拿死链去播、报「视频加载失败，已跳过」。

> 因此这条日志只在**每次运行的第一条**上说明原因（`expiredHintLogged`），
> 后面就是一行短句 —— 否则一次听五首歌刷五行带解释的长句，看着像出事了。

最后一条是 `/api/resolveVideo` 里新加的：登录能解锁更高档位（实测同一视频
匿名 `accept_quality=[64,16]`，登录后 `[116,80,64,16]`），不重取的话
登录完还得等切歌（甚至重启）才生效。另外渲染层在登录成功后会主动
用 `skipCache` 重取**当前正在播**的那个视频（`onLoggedIn`），并保留播放进度。

这几条都是靠缓存里的两个标记工作的，各有各的坑：

- **`loginState` 只在「明确为 false」时才算过期**。`ensureLoginState()` 现在返回
  `boolean | null`（`null` = 这次 nav 没问到），写缓存时 `null` 就**不写这个字段**、
  或者保留上一份快照 —— 以前把「没问到」写成 `false`，于是每次解析都判定
  「未登录时取的，现已登录」，白重取一遍（用户看到的日志是
  `缓存的地址是未登录时取的，现已登录，重新解析`，而且他并没有退出过登录）。
- **`dashTried` 决定要不要「升级到 dash」**，所以它必须真的落盘：`dashTried: !noDash || prevDashTried`
  （durl 兜底那次不算「试过」）。判断「要不要升级」时还要求**缓存里确实有播放数据**
  （`hasValidData`），否则某首歌的首次解析也会走这条分支并打日志，
  看起来就像「每切一首歌都在重新解析」。
- 日志文案要跟事实一致：以前一律打印「缓存只有 720P 的 durl」，
  实际可能是「只有旧数据」甚至「根本没有数据」，误导排查。

### 全屏与桌面壁纸（踩坑记录）

**结论：主窗口是 `transparent: true`，Windows 上透明窗口的原生全屏是失效的，
所以「全屏」改成应用层模拟，不要调用 `setFullScreen()`，也不要读 `isFullScreen()`。**

实测（Electron 42 / Windows，`setFullScreen(true)` 后 600ms 读回）：

| 窗口配置 | `isFullScreen()` |
| --- | --- |
| 普通窗口 | `true` |
| `frame: false` | `true` |
| `transparent: true` | **`false`** |
| `transparent: true` + `frame: false`（本项目） | **`false`** |
| 同上 + `thickFrame:false` / `roundedCorners:false` / `hasShadow:false` / `resizable:true` | **`false`** |
| 同上，但先 `setBounds` 到整屏再 `setFullScreen` | **`false`** |

透明窗口下 `setFullScreen(true)` 只会把窗口撑到屏幕大小，`isFullScreen()` 永远返回 `false`
（参见 [electron#27286](https://github.com/electron/electron/issues/27286)）。老代码拿它当唯一真相，
于是产生了一整套连环 bug：

- 全屏标志被原生值回写 → 渲染进程的 `isFullscreen` 永远是 `false`，按钮一直显示「全屏」；
- 再点「全屏」时 `!isFullScreen` 依然为 `true` → 只会一路「进入全屏」，**退不出去**；
- 从全屏切到壁纸时，还原点记到的是「非全屏」，退出壁纸就掉回普通窗口，
  而**挂壁纸层时窗口还是普通尺寸** → 「进了壁纸模式但没在壁纸层全屏」。

现在的做法（`electron/main/index.ts`）：

- `applyFullScreenGeometry()`：`setAspectRatio(0)`（免得宽高比约束改写 `setBounds`）+ 
  `setBounds(主屏 bounds)` + `setAlwaysOnTop(true)`（不置顶的话任务栏会压在窗口上面）。
- 全屏状态由主进程的 `isFullScreen` 变量持有，`win:isFullscreen` 直接返回它，
  **不再**是 `mainWindow.isFullScreen()`；`resize` 事件也不再回写这个变量。
- 两层还原点，互不污染：
  - `fullScreenRestore`：进入全屏前的普通窗口尺寸 / 最大化状态，退出全屏时用；
  - `wallpaperRestore`：进入壁纸**之前**的状态（含「当时是不是全屏」），退出壁纸时用。
    所以「全屏 → 壁纸 → 应用程序」会回到全屏，且此时依然能正常退出全屏。
- 先铺满窗口、等 120ms 让系统应用尺寸，**再** `asWallpaper.attach()`，否则挂载拿到的是旧几何。
- 壁纸模式下 `win:toggleFullscreen` 直接返回（几何由壁纸层接管）。
- **壁纸模式 = 纯背景**：标题栏和控制栏都挂 `.wm-hidden`（`display: none`），窗口里没有可点的东西，
  所以 `attach()` 里 `forwardMouseInput: false`（不装全局鼠标转发）。操作全部走托盘菜单；
  「设置歌单」「退出登录」这类需要窗口的项会先 `restoreWindow()` 再执行。
  另外进入时 `setSkipTaskbar(true)`、退出时恢复 `false`：壁纸是「桌面的一部分」，
  任务栏上不该多一个按钮（和最小化到托盘一样干净），要回窗口就左键点托盘图标。

**为什么托盘菜单是自绘的，不是原生 `Menu.popup`**（`electron-as-wallpaper` 的源码结论，不是猜的）：

`attach()` 干了三件事：`SendMessageTimeout(Progman, 0x052C, …)` 让 Explorer 生成 WorkerW、
`SetParent(hwnd, worker_w)` 把窗口挂到桌面图标后面、以及 `forwardMouseInput: true` 时
注册 `RIDEV_INPUTSINK` 原始输入 —— 后者会把**全系统的鼠标事件**都
`PostMessageA(壁纸窗口, WM_LBUTTONDOWN/UP, …)` 塞进去。

原生弹出菜单的规矩是「菜单外发生一次按下就关掉」。于是点托盘图标的那一下
同时被塞进壁纸窗口，**菜单刚弹出来就被自己关掉**；就算弹出来了，点菜单项时也会被同样打断。
这个转发在 Rust 侧是全局装的，JS 这层没法「只在菜单开着时关掉」。
结论：开着鼠标转发时，**任何原生弹出菜单都活不下来**。

> 现在壁纸模式已经把 `forwardMouseInput` 关掉了（界面都隐藏了，没什么可点的），
> 所以这一整类问题在壁纸模式下不复存在；下面那些防护留着当保险。

所以托盘菜单自己画，跑在一个**独立的置顶窗口**里（`tray-menu.html` + `src/trayMenu/main.ts`）。
它是个**迷你控制台**：

```
歌名 - 歌手名
────────── 进度条（可拖动跳转） ──────────
已播时长                视频时长        ← 两端对齐，中间不加 `/`
[音量(悬停出横向条)] [上一首] [播放/暂停] [下一首] [模式切换]
──────────
设置歌单 / 壁纸模式·窗口模式 / 退出登录 / 退出程序
```

| 要点 | 做法 |
| --- | --- |
| 为什么独立窗口就行 | 它**不是**壁纸窗口，收的是真实鼠标消息；又能 `setAlwaysOnTop(true, 'screen-saver')` 盖在任务栏之上 |
| 位置 | `tray.getBounds()` 拿到托盘图标矩形 → 贴在图标上方弹（上方放不下就翻到下方），再夹进 `workArea` |
| 尺寸 | 页面渲染完自己量高度，**高度变了才**回报 `trayMenu:ready` → 主进程 `setBounds` 后再 `show()` |
| 状态 | 主进程 `trayMenu:state` 推送；菜单开着时渲染层每 300ms 推一次进度，菜单里那条进度条才会动 |
| 动作 | `trayMenu:action`（带 `value`，进度用 0~1、音量用 0~100）→ 主进程转成 `tray:*` 广播，不重复实现播放逻辑 |
| DOM 稳定性 | 进度条、音量条、控制按钮、下面那几项**只建一次**，之后只改文案/样式 —— 菜单开着时状态每 300ms 推一次，重建 DOM 会让「按下与抬起之间元素被换掉」从而点不动 |
| 音量 | 按钮点了静音（菜单**不收起**，方便接着调）；悬停出**横向**条，数字在条左边，拖动实时生效 |
| **音量/静音不收起菜单** | 踩过：`runTrayMenuAction` 无条件先 `hideTrayMenu()`，而音量是连续操作 —— 鼠标一碰音量条菜单就关了（也就看不到静音图标变化）。现在 `volume` / `toggleMute` 不收菜单，并且页面对静音做**乐观更新**（先变图标再等主进程回权威状态） |
| **悬停条不能竖着放** | 竖条会伸出面板、被窗口边界裁掉（窗口高度是按 `#menu` 量的，绝对定位的弹出条不算进去）。所以弹出条做成**横向**、留在面板内部 |
| 收起 | 点了会执行动作的项、`Esc`、失焦且**光标已经不在菜单上**、主窗口关闭时一起销毁 |
| 顶部一行 | 显示 `歌曲名 - 歌手名`（不是视频标题：B 站标题又长又带 `【4K】` 这类前缀） |
| 关闭到托盘 | 菜单里「壁纸模式」那一项在窗口被藏起来时变成**「恢复窗口」**，动作也跟着换 |
| **动作必须跟着状态走** | 踩过：登录那一项的文案会随登录态变成「退出登录」，但动作写死成 `'login'` —— 点「退出登录」发的还是 login，用户看到的就是「点了又登录上了」。凡是文案会变的项，`action` 也要是函数 |
| **每次弹出都要装兜底显示** | 踩过：页面「高度没变就不回报」，而显示这件事绑在 `trayMenu:ready` 上 —— 第一次右键能弹（高度 0→N），第二次开始不再回报，菜单就再也不出现（「进了壁纸模式后右键弹不出来」）。现在 `showTrayMenu` 每次都装一个 120ms 的兜底显示，高度真变了再重新定位 |
| **合成点击防护** | 已注释。它本来是挡「鼠标转发把点菜单这一下同时合成到壁纸窗口」，现在壁纸模式 `forwardMouseInput: false`（界面也全隐藏），不会再有合成点击。`trayMenuOpen` 标志留着 —— 菜单开着时要把进度推给菜单里的进度条 |
| 左键语义 | 直接显示窗口（`restoreWindow`）：壁纸模式下先切回窗口模式，窗口在托盘里就恢复并前置 |
| **提示文案必须跟着行为走** | 踩过：左键从「播放 / 暂停」改成「回到窗口」之后，壁纸模式的 tooltip 还写着旧文案，用户照提示点了一下，结果窗口直接跳出来 —— 提示与行为不一致比没有提示更糟。tooltip 两种模式各写各的（应用模式「单击：显示窗口」/ 壁纸模式「单击：回到窗口」），菜单里每个按钮的 `title` 也随状态更新（播放/暂停、当前模式、静音/取消静音） |
| 退出 | 主窗口 `closed` 时一并 `destroy` 菜单窗口，否则那个隐藏窗口会让 `window-all-closed` 永不触发、点 X 退不掉 |

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

歌曲名、专辑封面、歌单高亮全都来自本地歌单数据，但 `changeSong` 原来把它们放在
`await searchSong()` **之后**。搜索缓存未命中时这是一次真网络请求（1~3 秒），
搜索失败时就永远不回来了 —— 于是「切了歌，名字和封面还是上一首的」。

现在 `changeSong` 一进来就先同步切好本地信息：

```ts
this.currentIndex = index      // 歌单高亮 + 专辑封面（currentCover 优先取 song.cover）
this.songName = songName       // 副标题「歌手 · 专辑」
this.videoName = ''            // 清掉上一首的视频标题
```

视频标题暂时空白时，模板用 `:videoName="videoName || songName"` 兜底显示歌名占位，
等搜索返回再换成真正的视频标题 —— 绝不会出现「新歌配旧视频标题」。
实测刷新延迟从 550+ms 降到 60ms 左右。

**2. `api:resolveVideo` 把搜索缓存里的条目写坏了**

`resolveVideo` 原来这样更新缓存条目：

```ts
targetVideo = { bvid, view_result, playurl_result }   // ← 整个替换
```

搜索结果条目里的 `title` / `pic` / `author` 全被丢掉，而这个数组会被写回搜索缓存。
后果是：

- 下次 `searchSong` 拿到的这一项没有标题和封面 → 播放器标题空白、视频封面回退不出来；
- 由于 `selectedBvid` 指向的正是「你上次播的那个视频」，**切回同一首歌必然命中这条坏数据**；
- 还会把 `title: ''` / `cover: null` 写进歌单的 `videoCache`，续播也一起坏掉。

现在改成「合并」而不是替换，并且每次解析都做一次回填：

```ts
targetVideo = { ...targetVideo, bvid, view_result, play_result }  // 保留 title / pic
targetVideo = backfillFromView(targetVideo)                       // 用 view_result 补齐
```

之所以要 `backfillFromView`：缓存**命中**时走的是「地址还能用」分支，
根本不会碰条目，已经写坏的缓存不会自己好。回填后随 `results` 一起写回，坏数据随使用自愈。

同时 `api:resolveVideo` 直接回传正在解析的那个视频的 `title` / `pic`，
渲染层不必再依赖「`videoList` 里能不能找到这个 bvid」——
`selectedBvid` 是历史选择，完全可能不在本次搜索结果里，那时列表查不到，
标题和封面就只能空着。`videoCache` 的写入也改成「非空优先」，不再让空值覆盖已有记录。

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

视频列表（`src/components/showList.vue`）现在是一套「候选视频管理」：

```
[刷新]      歌名 / UP 主        [🔍]        ← 歌曲列表：右上角是放大镜（点开变输入框）
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

**数据存在哪**：`playlists.json` 里每个歌单多一个

```ts
favorites: Record<搜索键, FavoriteVideo[]>   // { bvid, title, cover, author, duration, savedAt }
```

按**歌**存（key 和 `videoCache` 一样是搜索键），主进程 `normalizeFavorites` 做形状校验，
歌单同步后会和 `videoCache` 一起清掉「已经不在歌单里的歌」的分组。

踩过的坑，都是真踩过的：

| 坑 | 现象 | 怎么修 |
| --- | --- | --- |
| **grid 三列塞了四个元素** | 加号跑到**左上角**（第二行第一列） | 左右各自包一层 `.lt-side`，正好三格：左按钮 / 中标题 / 右按钮 |
| **时长的两种形状** | 点过「刷新」之后，视频列表的时长**整列消失** | 搜索接口的 `duration` 是 `"4:03"` **字符串**，view 接口是**秒数**。原来只认数字；现在 `durationText` 两种都收（数字/数字串格式化，`mm:ss` 直接用）。收藏里则统一 `durationToSeconds` 存秒 |
| **重搜会冲掉已解析的地址** | 刷新后每首歌都要重新解析 dash | `api:searchSong` 支持 `skipCache`，并且重搜后**与旧缓存条目按 bvid 合并**：`{ ...old, ...fresh, view_result: old.view_result, playurl_result: old.playurl_result }` —— 展示字段用新的，解析结果留旧的 |
| **收藏项在搜索结果里消失** | 下架 / 排序变化后收藏的视频就没了 | `applyFavoriteOrder` 里，搜索里找不到的收藏项用**收藏时存的快照**补齐（所以 `FavoriteVideo` 要连标题封面一起存） |
| **搜索接口会给重复项** | 列表里出现同一个视频两遍 | 排序后统一按 bvid 去重（收藏优先，其余保持搜索顺序） |
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

### 数据存储

```ts
// playlists.json —— 歌单集合
{
  version, currentId,
  playlists: [{
    id, name, source, sourceUrl,
    songs: [{            // 结构化曲目：可直接展示封面/专辑
      name, singer, album, cover, duration
    }],
    sync: { mode: 'off' | 'startup' | 'interval', intervalMs },
    lastSyncAt, createdAt, updatedAt,
    lastIndex,             // 该歌单上次播放到第几首
    videoCache: {          // key = "歌名-歌手"，续播时精确还原同一个视频
      '歌名-歌手': { bvid, title, cover, pickedAt }
    }
  }]
}
```

曲目从早期的 `"歌名-歌手"` 字符串数组升级为对象：旧数据会在启动时**自动解析迁移**
（按第一个 `-` 切分歌名与歌手），不会丢数据。搜索/匹配链路仍统一用
`toSearchKey(song)` 拼出与旧版完全一致的 `"歌名-歌手"`，所以匹配打分、
搜索缓存 key、`videoCache` key 都不受影响。

> 旧歌单迁移后没有专辑/封面的元信息（原始字符串里本来就没有），
> 对该歌单点一次「同步」即可从音乐平台补齐。

旧版单歌单 `playlist.json` 会在首次启动时**自动迁移**成集合里的第一条记录（迁移后旧文件改名为 `.migrated`，不会丢失）。

续播相关的信息存在 `setting.json` 里：`player.resumeOnStart`（记住播放进度）、`player.resumeTime`
（上次播放到第几秒）、`player.playIndex`，以及每个歌单自己的 `lastIndex`。
界面相关的：`common.themeColor` / `common.fontColor`（hex）、`common.glassTransparency`（0-100）、`common.glassBlur`（0-20）、`common.glassShadow`（0-20）。
记录时机：切歌、切视频、视频加载完成、播放进度变化（节流 5 秒）、关闭窗口前。

`videoCache` 只存 `bvid` + 标题 + 封面，**不存播放直链**（B 站地址带签名时效，存下来很快就失效）；
续播时按 bvid 重新解析，见上面的「续播：为什么每次都重新搜索、重新解析地址」。

### 歌单解析（对应 LX 的 musicSdk）

用户粘贴分享链接 → 自动识别平台 → 解析出 `歌名 / 歌手` → 逐首到 B站 搜索播放。

```
渲染进程  window.electronAPI.getPlaylistDetail({ input })
   └─ IPC 'music:getPlaylistDetail'
        └─ electron/main/music/index.ts   按链接 host 自动识别音源（wy / tx / kw）
             └─ sources/<source>.ts       各平台自己解析自己格式的链接
                  └─ 返回 { info, songs: [{ name, singer, interval }], total }
```

支持的链接形式：

| 平台 | 链接示例 |
| --- | --- |
| 网易云音乐 | `https://music.163.com/#/playlist?id=xxx`（也支持 `xxx###token` 注入 MUSIC_U） |
| QQ音乐 | `https://y.qq.com/n/ryqq/playlist/xxx` 或 `.../playlist/xxx.html` |
| 酷我音乐 | `https://www.kuwo.cn/playlist_detail/xxx` |

移植时与 LX 的几处有意差异：

1. **跑在主进程**：LX 的 `musicSdk` 在渲染进程里直接用 `crypto`/`Buffer`/`needle`
   （靠 webpack `target: 'electron-renderer'`）。本项目是 `contextIsolation: true` +
   `nodeIntegration: false`，所以解析逻辑放在主进程，只通过 IPC 把结果给渲染进程。
2. **请求层用 Node `http`/`https`**：实测在主进程用 Electron `net.request` 请求腾讯域名会稳定
   返回 `net::ERR_BLOCKED_BY_CLIENT`（网易云/酷我正常），换成 Node 内建模块后稳定可用；
   而且 Node 默认不跟随重定向，能直接读到 `location` 头，正好解决短链解析。
3. **自动识别音源**：LX 让用户在弹窗里手选音源，本项目按链接 host 自动判断，
   体验更省事；纯数字 ID 因无法判断平台会给出明确提示。
4. **返回结构精简**：LX 的歌曲对象还带 `qualitys`/`typeUrl` 等取播放地址用的字段，
   本项目只要 歌名/歌手/时长，全部砍掉。

---

## 数据与运行期

### 便携版（portable）的数据放在哪

`electron/main/portable.ts` 里按优先级三选一（必须在 `app.whenReady` 之前跑）：

| 情况 | 用哪个目录 |
| --- | --- |
| `%APPDATA%/BiLiMusicVideo-desktop` 里**已经有本应用数据** | 就用它（安装版 / 便携版共用一份，换版本不会「数据不见了」） |
| 没有数据，且当前是便携版（运行时带 `PORTABLE_EXECUTABLE_DIR`） | exe 同级的 `data/`（自动创建，数据跟着程序走） |
| 没有数据，且是安装版（全新环境） | 默认的 `%APPDATA%/BiLiMusicVideo-desktop` |

判断「已经有数据」看的是我们自己的文件（`setting.json` / `playlists.json` / `playlist.json` / `search-cache`），
**不能只看目录存不存在** —— Electron 一启动就会把 userData 目录建出来，那样全新机器上永远走不到便携分支。

### 关闭到托盘 / 任务栏进度 / 输出设备变化

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

### 图标（窗口 / 托盘）放在哪

`bili.ico` 在三种环境里的位置不同，`electron/main/index.ts` 的 `resolveAsset()` 按顺序找：

1. `process.resourcesPath/icons/` —— 打包后由 `extraResources` 放进来（**不在 asar 里**，真实文件路径）；
2. `public/` —— 开发期；
3. `out/renderer/` —— 兜底（Vite 会把 `public/` 整个拷到渲染产物里）。

> 踩坑：打包后原来直接拼的是 `app.getAppPath()/bili.ico`（= `resources/app.asar/bili.ico`），
> 这个路径根本不存在 —— 表现就是 **portable 版托盘没图标、窗口图标也是空的**。
> 现在 `loadIcon()` 在图标解不出来时会 `console.warn('[icon] 图标加载失败…')`，不再静默变空白。
> 图标文件本身也要记得在 `build.extraResources` 里声明，只写 `files` 是打不进包的。

### 关于存储：为什么用 JSON 而不是 SQLite

`setting.json` 约 2KB、`playlists.json` 约 5KB（217 首），且写入是「整体替换」语义
（先写临时文件再 rename 原子替换），没有部分更新、并发写、按行查询的需求 ——
这些正是 SQLite 的强项而本项目一个都用不到。同时 SQLite 是原生模块，
要额外处理 `asarUnpack` / ABI / 跨平台重编译，为一个 5KB 的文件不值得。

**真正需要淘汰策略的是搜索缓存**，那是文件级 KV，天然适合 TTL + LRU，
用「每键一文件 + 内存索引」实现即可，同样不需要 SQLite。见下。

### 搜索缓存策略

缓存项存的是**整包 B 站搜索响应**（含各候选视频的播放地址），单文件可达数 MB，
所以必须有过期与淘汰，否则只增不减（曾实测到 45MB / 107 文件，88% 已超 3 天）。

- **过期**：`cache.maxAge`（默认 3 天）在**读取时**判定，过期按未命中处理并删除
- **容量**：文件数上限 300，超出时按「最久未使用」淘汰到 80%（240）以下
- **索引**：内存索引记录每个文件的使用时间，并在需要时与磁盘对齐
  （应对外部删文件、上次未正常退出等情况）
- 设置里可查看占用、手动「清理过期」或「全部清除」

> 说明：`cache.enable` 与 `cache.maxAge` 在早期版本里只是声明了却从未被读取，
> 属于「死设置」；现已真正生效。

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
| 切歌瞬间进度还是上一首的 | `currentTime` / `duration` 未复位 | `changeSong` 里一起复位，`playCurrent` 不会再写错 `resumeTime` |
| 同步后随机播放可能卡住 | 曲目变了但 `randomList` 没重建，随机下标越界 → `getSongName` 返回 null 静默 return | `reloadCurrentPlaylistSongs` 里 `resetRandomList()` |
| 编辑「非当前」歌单会把正在听的歌从头重播 | 弹窗保存后无条件发 `switch`，而 App 只看 `currentId` | 弹窗改用 `reload` 事件；App 侧再加一道 `id !== currentId` 的防御 |
| 封面坏一张，其它歌单同一行永远空白 | `onImgError` 写内联 `display:none`，而列表 `:key` 是 index，DOM 会被复用 | 改成按 URL 记 `failedCovers`（与 `showList` 一致） |
| 改「字体颜色」有些字不变 | 一堆写死的 `#fff` / `rgba(255,255,255,…)` | 全部换成 `--glass-*` / `--panel-*` 或从 `--text-rgb` 派生；新增 `--accent*` 收纳功能色 |

**主进程**

| 问题 | 现在的做法 |
| --- | --- |
| 「登录失效」被拍成「解析失败」 | `AUTH_FAILED` 原样回传，界面提示重新登录 |
| 全屏 / 壁纸写死主屏，副屏会跳屏 | `screen.getDisplayMatching(window.getBounds())` |
| 拖动还原窗口在副屏算错（少了 `bounds.x`） | 相对位置改成 `(cursor - bounds.origin) / size` |
| 搜索缓存「读-改-写」丢更新 | 写回前重新读一次，按 bvid 合并 |
| 缓存落盘非原子 / 文件名会撞（`A/B` vs `AB`） | 复用 `writeJsonAtomic`；文件名用关键词 md5，原文存进 entry 校验。**改命名不做旧文件迁移**：`search-cache/` 里全是搜索缓存，重搜一次的成本远低于维护一条兼容分支（想立刻干净就在设置里「全部清除」） |
| 登录成功可能派发两次 | `finishLoginIfReady` 加 in-flight + finished 标记 |
| 登录页每次导航都重复注入关闭按钮 / 倒计时 | 注入前先探测元素是否已存在 |
| 酷我 `digest-5__123` 永远走不到 | `detectSource` 先特判这个前缀 |
| 拔屏 / 改分辨率后全屏几何不更新 | `display-*` 事件里重算（**必须等 app ready 再注册**，否则主进程直接起不来） |
| 托盘 / 窗口图标在打包后是空白 | `resolveAsset` 按 `resources/icons → public → out/renderer` 找；`extraResources` 带进包 |
| 启动失败静默留一个没窗口的进程 | `whenReady().catch` → 弹错误框 + 退出 |
| 主窗口可能被导航到站外（preload 会跟过去） | `will-navigate` 白名单 + `setWindowOpenHandler` 拒绝 |
| 打开外链没有白名单 | `app:openExternal` 只放行 http/https |

**顺手删掉的死代码**：`common/index.ts`（没人 import 的 barrel）、`koffi` 与 `wallpaperDetect.ts`
（WorkerW 检测没人调用，壁纸走的是 `electron-as-wallpaper`）、三个「声明了但从没被读取」的设置
（`common.startupAutoPlay` / `common.windowSizeId` / `player.isSavePlayIndex`）、四个「三段齐全但零调用」的
IPC（`playlist:get` / `playlist:save` / `auth:reLogin` / `cache:clearSingle`）、`store` 的 `has`/`set`/`all`、
`BROADCAST_EVENT_NAME` 里没用到的成员、一批只为导出而导出的函数，以及 store 里那层
「给每个设置项包一个 computed」的包装（组件统一直接读 `setting['xxx.yyy']`）。

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
- **脚本一定要 `app.setName('BiLiMusicVideo-desktop')`**：`userData` 目录跟着 app name 走，
  不设就会去读写 `%APPDATA%\Electron` 那份，得出完全不同的结论。
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


