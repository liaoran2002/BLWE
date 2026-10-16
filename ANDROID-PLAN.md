# Android 手机 / TV 端方案（调研存档）

> **状态：调研结论，未开始实施。**
>
> 本文是一次架构调研的存档，回答一个问题：
> **「BLMV 能不能再做一个 Android 手机 / TV 端，功能全复刻、UI 按手机重设计？」**
>
> 结论是**能**，路线是 **Kotlin 原生（Compose + ExoPlayer）**。
> 本文记录评估依据、复用清单、风险与分期步骤 —— 供将来真要动手时直接拿来用。
>
> 写作时间：评估基于当时仓库状态（主进程 ~9,200 行、渲染层 ~7,900 行、`main/utils/videoRank` 已重构）。

---

## 目录

- [一、结论摘要](#一结论摘要)
- [二、为什么不做 iOS / 不用 React Native](#二为什么不做-ios--不用-react-native)
- [三、复用清单：哪些能直接用](#三复用清单哪些能直接用)
- [四、必须重写的部分（Kotlin）](#四必须重写的部分kotlin)
- [五、UI：功能全复刻，呈现重设计](#五ui功能全复刻呈现重设计)
- [六、播放器：Android 的 ExoPlayer 怎么做](#六播放器android-的-exoplayer-怎么做)
- [七、功能对照表（113 个方法）](#七功能对照表113-个方法)
- [八、风险清单](#八风险清单)
- [九、分期实施步骤](#九分期实施步骤)
- [十、前置改造：把主进程的 Electron 依赖抽掉](#十前置改造把主进程的-electron-依赖抽掉)
- [附：评估依据与实测数据](#附评估依据与实测数据)

---

## 一、结论摘要

| 问题 | 结论 |
| :--- | :--- |
| **能不能做** | ✅ 能 |
| **技术路线** | **Kotlin 原生**（Jetpack Compose + ExoPlayer（Media3）） |
| **做哪些端** | **Android 手机 + Android TV**；**不做 iOS**（见第二节） |
| **功能范围** | **全部复刻**（播放 / 多歌单 / 高画质 / 收藏 / 同步 / 设置 / 续播…） |
| **UI** | **重写**（不是缩放桌面版）—— 呈现形式按手机/电视重新设计 |
| **高画质** | ✅ **能到 1080P / 4K**（ExoPlayer 合双流，比 WebView+MSE 更稳） |
| **代码量估算** | 约 **9,400 行 Kotlin**（逻辑 3,650 + UI 4,180 + 播放器 800 + 平台层 800） |
| **工期估算** | 熟练 Kotlin/Compose 单人 **8–12 周** |

**一句话**：这份 App 的**核心资产在主进程**（搜索签名、过滤排序、缓存、歌单），而它们**大多与 Electron 无关** —— 所以 Android 端的成本主要在 **UI 重写 + 播放器**，不在业务逻辑。

---

## 二、为什么不做 iOS / 不用 React Native

### 2.1 不做 iOS：因为 dash 播不了

桌面端高画质的实现是 **dash 双轨 + MSE 合成**：

```
B站 playurl 返回两条裸 fMP4 流（**不给 MPD 清单**）：
  videoUrl   video/mp4   codecs: avc1.xxxxx
  audioUrl   audio/mp4   codecs: mp4a.40.2
       ↓ 桌面端
MediaSource + 两个 SourceBuffer 合成 → 一个 <video> 播放
```

| 平台 | 能否合双流 | 结果 |
| :--- | :--- | :--- |
| **Android**（ExoPlayer / Media3） | ✅ `MergingMediaSource(video, audio)` | **1080P / 4K 完整可用** |
| **iOS**（AVPlayer） | ❌ 不支持"两条 URL 手动合并"，只吃 HLS | 只能退回 **durl 混流 = 720P 封顶** |
| **浏览器**（手机 WebView） | ✅ `MediaSource` 可用 | 可用，但手机上 MSE 不如原生硬解稳 |

**关键**：B站**不提供 HLS**，所以 iOS 没有高画质路径。既然**不上架 App Store**、目标只是自用，**iOS 直接不做**，问题消失。

> 顺带记：`durl` 是渐进式 mp4 混流，代码里明确写着**封顶 720P**（`biliApi.ts` 注释：实测 `fnval: 1` 这条通道封顶 720P）。
> 所以 iOS 即便退守 durl，也只有 720P。

### 2.2 不用 React Native：因为高画质仍要写原生模块

RN 听起来能"UI 用 React、逻辑复用"，但实际上：

| RN 的好处 | 现实 |
| :--- | :--- |
| UI 用 React 写 | ⚠️ 但你的 UI 是 **Vue**，迁 React 等于**全量重写**（template 1,359 行 + script 4,823 行 + style 1,657 行） |
| 逻辑复用 | ⚠️ 你的逻辑是 **TypeScript 跑在 Node/Electron 里**，RN 里要跑 JS 就得解决 `better-sqlite3`、`koffi`（原生模块）的 Android 编译问题 |
| 播放 | ❌ `react-native-video` 接**单个 source**，**不支持两条流合并** → 高画质**仍然要写 Kotlin 原生模块** |

**结论**：RN 会在"高画质"这一项上退回原生模块，等于**多绕一层**。
Kotlin 原生反而**更直接**：ExoPlayer 本来就支持，UI 用 Compose，逻辑用 Kotlin 重写（没有 JS 运行时负担）。

---

## 三、复用清单：哪些能直接用

### 3.1 ✅ 设计可整搬（语言无关）

| 资产 | 说明 |
| :--- | :--- |
| **SQLite schema** | `playlists` / `songs` / `playlist_songs` / `videos` / `song_meta` 五张表的 DDL **直接搬进 Room** |
| **两级 id 设计** | `playlists.id = 平台_平台歌单id`（`tx_8153225605`）、`songs.id = 平台_平台歌曲id`（`tx_1828354`）—— **两端主键一致**，将来做云同步/互通时是关键前提 |
| **设计令牌**（CSS 变量） | `--glass-rgb` / `--glass-alpha` / `--glass-radius` / `--glass-shadow-size`… **全是纯数值**，直接搬进 Compose theme（全项目 144 处 `var(--…)` 引用都走这套，没有散落硬编码） |
| **清晰度档位表** | `VIDEO_QUALITY_OPTIONS`（qn: **127/126/125/120/116/112/80/74/64/32/16/6** —— 8K / 杜比视界 / HDR / 4K / 1080P60…）、`AUDIO_QUALITY_OPTIONS`（30280/30250/30251…）**原样搬** |
| **判据逻辑** | `videoRank.ts` 的硬过滤 + 打分规则、搜索词四级降级、简繁归一（opencc 的 `t2cn` 字典 Android 有对应库） |

### 3.2 ✅ 纯逻辑，零 Electron 依赖（可逐行翻译成 Kotlin）

已逐文件确认**不 import electron** 的模块，共 **22 个文件**：

| 模块 | 行数 | 用途 |
| :--- | ---: | :--- |
| `main/utils/cache.ts` | 1125 | 搜索缓存 + 收藏 + 播放地址 + 过期清理 |
| `main/ipc/biliApiHandlers.ts` | 877 | 搜索/解析的**编排**（缓存命中判断、合并收藏、写库前排序） |
| `main/utils/playlist.ts` | 749 | 多歌单（增删改查、同步、按歌重算 `lastIndex`） |
| `main/music/sources/wy.ts` | 321 | 网易云歌单解析 |
| `main/music/sources/tx.ts` | 261 | QQ 音乐歌单解析 |
| `main/music/http.ts` | 208 | HTTP 层（自写，替代 LX 的 needle） |
| `main/music/utils.ts` | 202 | 各音源字段归一 |
| `main/music/sources/kw.ts` | 156 | 酷我歌单解析 |
| `main/utils/quality.ts` | 140 | 清晰度档位选择 |
| `main/utils/store.ts` + `atomicJson.ts` | 148 | 原子写 JSON |
| `main/music/index.ts` | 85 | 音源分发 + host 自动识别 |
| `main/music/sources/wyCrypto.ts` | 67 | 网易云加密（AES/RSA） |
| `common/utils/duration.ts` | 60 | 时长解析（`"4:03"` → 秒） |
| `common/types/playlist.ts` | 273 | 类型 + `songId` / `playlistKey` / `sourceOfSongId` 等纯函数 |
| `common/types/app_setting.ts` | 168 | 设置类型 |
| **小计** | **~4,000** | |

> ⚠️ `common/utils/videoRank.ts`（600 行）**也没依赖**，上面表里漏列了，一并算进去。它在两边**必须行为一致**（判据漂移会导致两端搜出不同结果）。

### 3.3 🔸 依赖 Electron，但耦合**很浅**，抽象后可共用

| 文件 | 行数 | 依赖什么 | 抽象方式 |
| :--- | ---: | :--- | :--- |
| **`main/biliApi.ts`** | **1317** | **只有 3 个 `net.fetch` 调用点 + 1 处读 cookie** | 抽成两个接口（见第十节） —— **这是最核心的资产** |
| `main/utils/db.ts` | 456 | `app.getPath('userData')` | 换成平台路径 + Room/SQLite 驱动 |
| `main/utils/setting.ts` | 224 | `app.getPath` | 换成 Android `DataStore` |

**`biliApi.ts` 的依赖清单**（这是全部）：

```
import { net, session } from 'electron'     ← 唯一一行

net.fetch(NAV_API)          ← 读 nav 接口（拿 img_key/sub_key 算 WBI 签名）
net.fetch(url)              ← biliGet：所有 B站请求
net.fetch(url)              ← 短链跟随（b23.tv → BV 号）
session.cookies.get({})     ← 读登录 cookie（SESSDATA 等）
```

**只要把这两个概念抽象出去，这 1317 行（含 WBI 签名、四级降级搜索、dash 解析）就能全平台共用。**

---

## 四、必须重写的部分（Kotlin）

| 功能块 | 桌面行数 | Kotlin 估算 | 说明 |
| :--- | ---: | ---: | :--- |
| **B站 API**（签名/搜索/解析地址） | 1317 | ~900 | WBI 签名、`searchSongFiltered`（四级降级）、`extractDashStreams`、`readQualityOptions` |
| **过滤排序**（`videoRank`） | 600 | ~450 | 纯逻辑逐行翻译（**必须与桌面行为一致**） |
| **缓存**（`cache.ts`） | 1125 | ~600 | 桌面那套防抖/预热日志可省 |
| **多歌单**（`playlist.ts`） | 749 | ~500 | 含同步、`lastIndex` 按歌重算 |
| **DB 层** | 456 | ~250 | DDL 搬 Room，DAO 重写 |
| **歌单解析**（`music/*`） | 1092 | ~700 | 3 个音源 + 网易云加密 |
| **清晰度档位** | 140 | ~100 | |
| **设置** | 224 | ~150 | 手机版只需音量/清晰度/过滤词/容差等 |
| **小计** | | **~3,650** | |

**不需要的**（桌面专属，约 2,400 行）：

```
main/index.ts          1798 行  ← 窗口/托盘/快捷键/单实例
main/winWallpaper.ts    450 行  ← koffi 直调 Win32 挂桌面壁纸层
main/protection.ts      153 行  ← V8 字节码保护（Android 有 R8）
main/portable.ts         93 行  ← 便携版数据目录判定
```

---

## 五、UI：功能全复刻，呈现重设计

### 5.1 桌面 UI 的实际构成（实测）

```
文件                     总计  template  script  style
App.vue                 3692    203     3070    411
SettingsDialog.vue      1418    450      723    237
PlaylistManager.vue      902    229      373    292
showList.vue             718    150      303    257
biliVideoControls.vue    709    203      215    283
AddVideoDialog.vue       248     72       88     80
AboutDialog.vue          148     39       36     65
PlaylistPanel.vue         68     13       15     32
─────────────────────────────────────────────────────
总计                    7903   1359     4823   1657
```

> **注意 `App.vue`**：模板只有 203 行（标题栏 + 视频容器 + 控制栏引用），但 **script 有 3070 行、113 个方法** ——
> 这就是为什么"UI 重写"的工作量主要不在模板，而在**编排逻辑的重新组织**。

### 5.2 手机端 UI 重写估算

| 桌面 UI | 行数 | 手机端 | 为什么 |
| :--- | ---: | ---: | :--- |
| `App.vue` 模板 | 203 | ~600 | 标题栏→顶栏、控制栏→底部条、全屏→沉浸式 |
| `biliVideoControls.vue` | 709 | ~700 | 进度条/音量/清晰度角标 → 手机版交互 |
| `showList.vue` | 718 | ~650 | 视频列表 → 底部抽屉 / 独立列表页 |
| `PlaylistManager.vue` | 902 | ~800 | **功能全复刻**：切/增/删/改名/同步/曲目浏览/曲目搜索 |
| `SettingsDialog.vue` | 1418 | ~1100 | **功能全复刻，但导航模型必须改**（见下） |
| `AddVideoDialog.vue` | 248 | ~150 | 粘贴链接加视频 |
| `AboutDialog.vue` | 148 | ~80 | |
| `PlaylistPanel.vue` | 68 | ~100 | 歌单入口 → 顶栏下拉 |
| CSS | 1657 | ~800 | Compose 样式（**令牌能搬，写法重来**） |
| **小计** | **6071** | **~4,180** | |

### 5.3 「呈现形式不一样」的典型例子

**`SettingsDialog.vue`（1418 行）** 在桌面是「**左栏目录 + 右栏一页到底**」：

```
┌─────────┬──────────────────────┐
│ 播放    │  最高视频清晰度  [▼]  │
│ 界面    │  最高音质        [▼]  │
│ 通用    │  ……（一直滚）         │
│ 搜索    │                      │
└─────────┴──────────────────────┘
   点左栏平滑滚到对应位置
```

**手机上必须改成多级页面**（这是"呈现形式不一样"的核心）：

```
设置列表页            点「搜索」→        搜索设置页
┌──────────────┐                    ┌──────────────┐
│ 播放      >  │                    │ 时长容差      │
│ 界面      >  │                    │ 降级阈值      │
│ 通用      >  │                    │ 关键词加权  > │
│ 搜索      >  │                    │ 过滤关键词    │
└──────────────┘                    └──────────────┘
```

**功能一个不少，但导航从"同一页滚动"变成"多级跳转"。**

### 5.4 手机端不适用的 CSS（数量都很小，不是阻塞）

| 特性 | 桌面处数 | 手机端 |
| :--- | ---: | :--- |
| `:hover` | 29 | **删掉**（手机没有指针，等于少写） |
| `backdrop-filter`（毛玻璃） | **12** | `BlurView`（RN 系）/ Android 用 `RenderEffect`(API 31+)，或**只保留 `rgba` 半透明底**（视觉差异很小，因为底色本身就是 `rgba(...,0.3)`） |
| `transition` / `@keyframes` / `animation` | 33 | Compose `animateXxx` |
| `box-shadow` | 11 | Compose `shadow` / `elevation` |
| `position: fixed` | 7 | Compose 布局 |
| `overflow-y` | 6 | `LazyColumn` / `ScrollState` |

**毛玻璃的真实结构**（拆自真实 CSS）：

```css
background: var(--glass-bg);              /* rgba 半透明 → 直接支持 */
backdrop-filter: blur(var(--glass-blur)); /* ← 只有这一条需要替代 */
border: 1px solid var(--glass-border);
border-radius: var(--glass-radius);
box-shadow: var(--glass-shadow);
```

四条里三条原生支持，**只有一条需要替代，而且只有 12 处**。

---

## 六、播放器：Android 的 ExoPlayer 怎么做

### 6.1 核心：两条裸流合并

B站**不给 MPD 清单**，只有两条裸 fMP4 URL。Android Media3 的接法：

```kotlin
// 两条裸 URL 各自当 ProgressiveMediaSource，再合并成一个
val videoSource = ProgressiveMediaSource.Factory(videoDataSourceFactory)
    .createMediaSource(MediaItem.fromUri(videoUrl))

val audioSource = ProgressiveMediaSource.Factory(audioDataSourceFactory)
    .createMediaSource(MediaItem.fromUri(audioUrl))

val merged = MergingMediaSource(videoSource, audioSource)   // ← 关键
player.setMediaSource(merged)
```

### 6.2 防盗链：给 ExoPlayer 设置 Referer

桌面端靠 **Electron session 全局改写请求头**实现（`main/index.ts` 里的 `onBeforeSendHeaders` 塞 `Referer: https://www.bilibili.com/`），所以渲染层的 `fetch` 不带 header 也能成功。

Android 端对应做法：

```kotlin
val factory = DefaultHttpDataSource.Factory()
    .setDefaultRequestProperties(mapOf(
        "Referer" to "https://www.bilibili.com/",
        "User-Agent" to UA_CHROME
    ))
```

### 6.3 为什么 Android 高画质反而**比 WebView 更好**

| | WebView + MSE | ExoPlayer |
| :--- | :--- | :--- |
| 解码 | JS 喂 SourceBuffer，软/硬解看实现 | **`MediaCodec` 硬解** |
| 4K / 8K | 手机上容易掉帧、内存爆 | ✅ 硬解支持 |
| 后台播放 | 困难 | `MediaSessionService` 原生支持 |
| 通知栏控制 | 无 | 原生 |

### 6.4 播放器功能的对应关系（vs 桌面 `dashPlayer.ts` 381 行）

| 桌面实现 | Android |
| :--- | :--- |
| `MediaSource` + 两个 `SourceBuffer` | `MergingMediaSource` |
| `pump()` 并行拉两条流 | ExoPlayer 内部 |
| `waitForRoom()` 处理 SourceBuffer 配额 | ExoPlayer 内部缓冲管理 |
| `startWatchdog()` 停滞检测 | `Player.Listener` + 自定义超时 |
| duration 补 `ms.duration` | `MediaItem` 的 `MediaMetadata` |
| `fallbackToDurl()` 退 720P | 同样的兜底逻辑 |
| 清晰度/音质切换（重新 resolve） | 同样（重新解析 playurl 再 setMediaSource） |

---

## 七、功能对照表（113 个方法）

> `App.vue` 的 script 里有 113 个方法。下表按功能归类，标注手机端怎么做。
> **实施时对着这张表打勾**，保证"功能全复刻"不漏。

### 7.1 ✅ 直接复刻（逻辑一样，呈现重设计）—— 约 70 个

| 功能块 | 方法 | 手机端呈现 |
| :--- | :--- | :--- |
| **播放控制** | `playControl` `next` `prev` `toggleMode` `getRandomNext` `getRandomPrev` `resetRandomList` `changeTime` `changeVolume` `toggleMute` | 底部控制条 + 手势 |
| **视频切换** | `changeVideo` `switchQuality` `applyVideoSource` `fallbackToDurl` `videoEnded` `videoError` `videoUpDate` | 播放器全屏 |
| **歌单** | `loadPlaylist` `onPlaylistSwitch` `onPlayFromManager` `reloadCurrentPlaylistSongs` | 顶栏下拉 / 侧滑抽屉 |
| **切歌编排** | `changeSong` `restoreSongVideo` `tryResume` | 逻辑原样 |
| **搜索** | `refreshVideoList` `onListRefresh` `notifyFilteredEmpty` `notifySearchEmpty` | 下拉刷新 / Toast |
| **收藏 / 加视频** | `onToggleFavorite` `onAddVideo` `favoriteBvids` | 心形按钮 + 长按 |
| **同步** | `runStartupSync` `reportSyncResults` `setupSyncTimer` `clearSyncTimer` `runIntervalSync` | 后台 + 通知（Android 有对应机制） |
| **续播** | `rememberSeekPoint` `persistPlaybackState` | `MediaSession` + 前台服务 |
| **预热** | `warmApi` `warmMedia` `warmElement` `maybeWarm` `clearWarm` `clearAllWarm` `stopWarmMedia` `dropWarmIfCurrent` `indexForDir` | 逻辑原样（ExoPlayer 预加载） |
| **缓冲状态** | `onVideoBuffering` `onVideoPlaying` `syncBufferState` `bufferedAhead` `bufferSubText` `startBufferTicker` `stopBufferTicker` `scheduleBufferOverlay` `clearBufferOverlayTimer` | 加载圈 + 百分比 |
| **停滞看门狗** | `checkPlaybackStall` `checkEndOfStream` `startEndWatch` `lastBufferedEnd` `stopDashSession` | 逻辑原样 |
| **登录** | `loadUserInfo` `onLoggedIn` `startLogin` `doLogout` `handleLogoutConfirm` | WebView 登录页 |
| **数据获取** | `getSongParts` `getSongName` `getSong` `currentSong` `currentVideoCover` `currentCover` `currentVideoQn` `currentAudioId` `formatTime` `errMsg` `favoriteBvids` `videoEl` | 逻辑原样 |
| **状态派生** | `controlsSubtitle` `videoQualityDetail` `audioQualityDetail` `ringLength` `ringOffset` `loopModeToIndex` | Compose state |

### 7.2 🔸 需要换机制（同样功能，平台不同）

| 桌面方法 | Android 对应 |
| :--- | :--- |
| `updateMediaSession` / `setupMediaSessionActions` / `updateMediaPosition` | **`MediaSession` + 通知栏**（机制几乎一致） |
| `updateTaskbarProgress` | 通知栏进度条 |
| `onAudioDeviceChange` / `setupAudioDeviceWatch` | `AudioManager` 设备回调 |
| `onBeforeUnload` | Activity `onStop` / `onPause` |
| `handleKeydown` | 遥控器 / 媒体按键 |
| `toggleFullscreen` / `isFullscreen` | 沉浸式全屏（TV 上恒为全屏） |
| `init` / `clearNowPlaying` / `syncVideoQuality` / `onVideoLoaded` / `onVideoPlayStateChange` | 生命周期适配 |

### 7.3 ❌ 手机端不需要（桌面专属）

| 桌面方法 | 原因 |
| :--- | :--- |
| `toggleWallpaper` `initWallpaperState` `wallpaperEnabled` | 手机没有桌面壁纸层 |
| `onTitlebarMouseDown` `onTitlebarDblClick` `onDocMouseMove` `onDocMouseUp` | 窗口拖拽（手机没有标题栏） |
| `winMinimize` `winMaximize` `winClose` | 同上 |
| `onTrayMenuGuard` `syncTrayState` | 托盘 |
| `toggleLock` | 桌面"锁定界面" |
| `anyDialogOpen` | 桌面弹窗管理 |

### 7.4 全部设置项（也要复刻）

| 分组 | 桌面设置 | 手机端 |
| :--- | :--- | :--- |
| 播放 | 最高清晰度 / 最高音质 / 记住进度 / 设备变化暂停 / 全屏锁定 | ✅ 全要（全屏锁定改"沉浸式"） |
| 界面 | 主题色 / 字体色 / 透明度 / 模糊 / 阴影 / 宽高比 | 🔸 前 5 项要（宽高比→手机没有）；模糊改 `BlurView` |
| 通用 | 启动进壁纸 / 关闭到托盘 / 任务栏进度 / 结果过期 | ❌ 前 3 项不要（壁纸/托盘/任务栏）；**过期时间要** |
| 搜索 | 时长容差 / 降级阈值 / 关键词加权 / 过滤关键词 | ✅ 全要 |
| — | 搜索缓存（占用 + 清理） | ✅ 要 |

---

## 八、风险清单

| 风险 | 说明 | 应对 |
| :--- | :--- | :--- |
| **B站风控** | 手机 App 请求比桌面更容易被识别（无浏览器指纹） | UA 伪装 + `OkHttp` 的 `ConnectionSpec`/TLS 配置；必要时复用 `curl_cffi` 式指纹（Android 可用 `okhttp-tls` 自定义） |
| **WBI 签名** | 需 `md5` + 参数按 key 排序 + 混入 `img_key`/`sub_key` | Kotlin `MessageDigest` 直接翻译；**注意 `tids` 必须在签名前设置**（桌面端踩过：顺序反了导致 `w_rid` 不覆盖 `tids`，搜索全挂） |
| **网易云加密** | `wyCrypto.ts`（67 行）涉及 AES/RSA | `javax.crypto` 直接翻译 |
| **TV 遥控器** | Compose 的焦点系统与触屏不同 | 用 `TvLazyRow` / `Modifier.focusable`；**TV 与手机 UI 要分开布局**（Compose 可用 `if (isTv)` 切换） |
| **后台播放** | 锁屏 / 切后台要能继续播 | `MediaSessionService` + 前台通知 + `FOREGROUND_SERVICE` 权限 |
| **判据漂移** | `videoRank` 在两端各写一份，行为可能不一致 | **用一个测试集锁住行为**：拿真实搜索结果的 JSON，两端跑同一套断言（桌面已有一批实测数据可用） |
| **不确定项** | ExoPlayer 对 B站 fMP4 的**分片时长/progressive 模式**兼容性未实测 | 实施前先跑 POC：解析一条真实 dash URL，用 `ProgressiveMediaSource` 播 |

---

## 九、分期实施步骤

```
第 1 步：前置改造（桌面端也受益）          1–2 周
  把 biliApi / db / setting 的 Electron 依赖抽成接口
  → 桌面端可单测；这套接口就是 Kotlin 端的"规格说明"

第 2 步：Android 逻辑 + 最小播放            3–4 周
  Kotlin 重写 biliApi（签名/搜索/解析）+ videoRank + cache + playlist
  ExoPlayer 合双流播放
  UI 用最简 Compose（一个列表 + 播放控制）
  → **做完这步就能"打开就播"了**（摆件场景其实这步就够）

第 3 步：UI 功能全复刻                      3–4 周
  补多歌单管理 / 设置 / 视频列表 / 收藏 / 同步
  按「功能对照表」逐项打勾

第 4 步：TV 适配 + 打磨                    1–2 周
  遥控器焦点、大屏布局、后台播放、通知栏
```

**每步都可独立交付** —— 第 2 步结束时已经是个能用的播放器。

---

## 十、前置改造：把主进程的 Electron 依赖抽掉

这是**第 1 步的具体内容**，也是 Android 端能复用 `biliApi.ts`（1317 行核心资产）的前提。

### 10.1 `biliApi.ts` 需要抽象的两个接口

```ts
/** HTTP GET（要能带自定义请求头、自动跟重定向、返回 JSON） */
interface HttpGet {
  json(url: string, headers?: Record<string, string>): Promise<{ data: unknown; url: string }>
}

/** Cookie 存储（读/写，用于登录态） */
interface CookieStore {
  getAll(): Promise<Array<{ name: string; value: string }>>
  set(name: string, value: string): Promise<void>
}
```

| 平台 | `HttpGet` 实现 | `CookieStore` 实现 |
| :--- | :--- | :--- |
| **桌面（现状）** | `electron.net.fetch`（自动带 session cookie） | `session.defaultSession.cookies` |
| **Android** | `OkHttp`（`CookieJar` 挂在 client 上） | `CookieManager` / `SharedPreferences` |
| **测试** | 打桩返回固定 JSON | 内存 Map |

### 10.2 改造范围（除 `biliApi` 外还有两处）

| 文件 | 依赖 | 抽象 |
| :--- | :--- | :--- |
| `utils/db.ts` | `app.getPath('userData')` | 注入 `dbPath: () => string`（桌面给 `userData`，Android 给 `filesDir`） |
| `utils/setting.ts` | `app.getPath('userData')` | 同上（或注入 `readFile`/`writeFile`） |

**改完后桌面端立即受益**：`biliApi` 不再 import electron → **可以写单元测试**（现在因为依赖 `net.fetch` 完全测不了）。

---

## 附：评估依据与实测数据

本文的数字都是**从仓库实测**得来，不是估算：

| 数据 | 来源 |
| :--- | :--- |
| 渲染层 7,903 行（8 个 .vue） | 逐文件统计，含 template/script/style 拆分 |
| `App.vue` script 3,070 行 / 113 个方法 | 逐方法正则提取 |
| 主进程 9,237 行（31 个文件） | 逐文件统计 |
| 22 个文件**不依赖 electron** | 逐文件 grep `from 'electron'` |
| `biliApi.ts` 只有 4 处 electron 调用 | grep `net.fetch` / `session.` |
| `:hover` 29 处 / `backdrop-filter` 12 处 | 全项目 CSS grep |
| 设计令牌 144 处引用 | grep `var(--` |
| Element Plus 30 种组件 | grep `el-xxx` |
| 清晰度档位表（qn 127/126/125/120/116/112/80/74/64/32/16/6） | `common/constants.ts` |
| durl 封顶 720P | `biliApi.ts` 注释（实测结论） |

**未实测的**（实施前需 POC）：

- ExoPlayer 能否直接播 B站 dash 的裸 fMP4（`ProgressiveMediaSource` 兼容性）
- 手机浏览器 / WebView 的 `MediaSource.isTypeSupported()` 对 B站 dash mimeType 的支持情况
- B站对移动端 UA / TLS 指纹的风控强度

---

## 相关文档

- [README.md](README.md) —— 功能特性与使用说明
- [ARCHITECTURE.md](ARCHITECTURE.md) —— 架构、数据流、踩坑记录
- [FILES.md](FILES.md) —— 每个文件的职责与各项功能的实现逻辑
