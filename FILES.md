# 文件职责与实现逻辑

> 这份文档回答两个问题：**每个文件负责什么**、**每项功能是怎么实现的**。
>
> - 想看架构 / 数据流 / 踩坑记录 → [ARCHITECTURE.md](ARCHITECTURE.md)
> - 想看怎么用 → [README.md](README.md)
>
> 阅读顺序建议：先看 [第一部分（文件职责）](#%E7%AC%AC%E4%B8%80%E9%83%A8%E5%88%86%E6%AF%8F%E4%B8%AA%E6%96%87%E4%BB%B6%E8%B4%9F%E8%B4%A3%E4%BB%80%E4%B9%88) 建立地图，
> 再看 [第二部分（功能实现）](#%E7%AC%AC%E4%BA%8C%E9%83%A8%E5%88%86%E6%AF%8F%E9%A1%B9%E5%8A%9F%E8%83%BD%E6%80%8E%E4%B9%88%E5%AE%9E%E7%8E%B0%E7%9A%84) 把跨文件的链路串起来。

---

## 目录

**第一部分：每个文件负责什么**

- [1. 主进程（electron/main/）](#1-%E4%B8%BB%E8%BF%9B%E7%A8%8Belectronmain)
- [2. 主进程与渲染层共用（electron/common/）](#2-%E4%B8%BB%E8%BF%9B%E7%A8%8B%E4%B8%8E%E6%B8%B2%E6%9F%93%E5%B1%82%E5%85%B1%E7%94%A8electroncommon)
- [3. 预加载（electron/preload/）](#3-%E9%A2%84%E5%8A%A0%E8%BD%BDelectronpreload)
- [4. 渲染层（src/）](#4-%E6%B8%B2%E6%9F%93%E5%B1%82src)
- [5. 构建与打包](#5-%E6%9E%84%E5%BB%BA%E4%B8%8E%E6%89%93%E5%8C%85)

**第二部分：每项功能怎么实现的**

- [1. 歌单导入与解析](#1-%E6%AD%8C%E5%8D%95%E5%AF%BC%E5%85%A5%E4%B8%8E%E8%A7%A3%E6%9E%90)
- [2. 搜索：从歌名到候选视频列表](#2-%E6%90%9C%E7%B4%A2%E4%BB%8E%E6%AD%8C%E5%90%8D%E5%88%B0%E5%80%99%E9%80%89%E8%A7%86%E9%A2%91%E5%88%97%E8%A1%A8)
- [3. 搜索结果排序（硬过滤 + 打分）](#3-%E6%90%9C%E7%B4%A2%E7%BB%93%E6%9E%9C%E6%8E%92%E5%BA%8F%E7%A1%AC%E8%BF%87%E6%BB%A4--%E6%89%93%E5%88%86)
- [4. 播放地址解析（dash / durl 两条路）](#4-%E6%92%AD%E6%94%BE%E5%9C%B0%E5%9D%80%E8%A7%A3%E6%9E%90dash--durl-%E4%B8%A4%E6%9D%A1%E8%B7%AF)
- [5. dash + MSE 播放](#5-dash--mse-%E6%92%AD%E6%94%BE)
- [6. 切歌预热（为什么切歌几乎无感）](#6-%E5%88%87%E6%AD%8C%E9%A2%84%E7%83%AD%E4%B8%BA%E4%BB%80%E4%B9%88%E5%88%87%E6%AD%8C%E5%87%A0%E4%B9%8E%E6%97%A0%E6%84%9F)
- [7. 收藏与「添加视频」](#7-%E6%94%B6%E8%97%8F%E4%B8%8E%E6%B7%BB%E5%8A%A0%E8%A7%86%E9%A2%91)
- [8. 续播](#8-%E7%BB%AD%E6%92%AD)
- [9. 桌面壁纸模式](#9-%E6%A1%8C%E9%9D%A2%E5%A3%81%E7%BA%B8%E6%A8%A1%E5%BC%8F)
- [10. 系统托盘（含自绘菜单）](#10-%E7%B3%BB%E7%BB%9F%E6%89%98%E7%9B%98%E5%90%AB%E8%87%AA%E7%BB%98%E8%8F%9C%E5%8D%95)
- [11. 配置（setting）的读写与广播](#11-%E9%85%8D%E7%BD%AEsetting%E7%9A%84%E8%AF%BB%E5%86%99%E4%B8%8E%E5%B9%BF%E6%92%AD)
- [12. 定时暂停 / 定时关闭](#12-%E5%AE%9A%E6%97%B6%E6%9A%82%E5%81%9C--%E5%AE%9A%E6%97%B6%E5%85%B3%E9%97%AD)
- [13. 缓存与过期](#13-%E7%BC%93%E5%AD%98%E4%B8%8E%E8%BF%87%E6%9C%9F)
- [14. 打包与代码保护](#14-%E6%89%93%E5%8C%85%E4%B8%8E%E4%BB%A3%E7%A0%81%E4%BF%9D%E6%8A%A4)
- [15. B 站视频列表（导入 → 播放 → 续播）](#15-b-%E7%AB%99%E8%A7%86%E9%A2%91%E5%88%97%E8%A1%A8%E5%AF%BC%E5%85%A5--%E6%92%AD%E6%94%BE--%E7%BB%AD%E6%92%AD)

---

# 第一部分：每个文件负责什么

## 1. 主进程（electron/main/）

### `index.ts` —— 主进程入口与总装配

**职责**：编排启动顺序，持有主窗口 / 登录窗口 / 自绘托盘菜单窗口的生命周期，
维护「应用层模拟全屏」与「桌面壁纸模式」两套状态机，管理托盘，
响应显示器变化，响应配置变化（宽高比 / 过期清理 / 开机启动），退出前 flush 配置与歌单。

**启动顺序即契约**（顺序错了会出真问题）：

```
① setupUserDataPath()          ← 必须最早期，改 userData
② requestSingleInstanceLock()  ← ★ 单实例锁。拿不到就 app.quit()，另一个实例
                                  监听 second-instance → restoreWindow() 把窗口拉到前台
                                  （必须在 ① 之后：便携版改写了 userData 路径，
                                    锁要跟着同一个路径；也必须在 ③ 之前：别白开库）
③ registerProtectedScheme()    ← 必须在 whenReady 之前，privileges 才生效
④ whenReady → if (!lockHeld) return → initSetting() + initPlaylists()
⑤ applyAutoLaunch()            ← 按设置写系统启动项（每次启动都重写，见下）
⑥ installProtectedProtocol()   ← 必须在建窗之前
⑦ registerIpcHandlers({...20 个能力})
⑧ createMainWindow() + createTray()
⑨ watchDisplayChanges() + grabCookiesSilently()
```

> ⚠️ **② 和 ④ 里的守卫缺一不可**：`app.quit()` 是**异步**的，不会中断执行流 ——
> 光在 ② 调 quit，排队的 `whenReady` 回调照样跑完、照样 `initSetting` /
> `initPlaylists()`，第二个实例还是会把数据库打开一遍（实测日志里能看到
> `[playlist] 已加载 0 个歌单`）。所以 ④ 开头必须再 `if (!singleInstanceLockHeld) return`。

整条链末尾挂了 `.catch()` → `dialog.showErrorBox` + `app.exit(1)`，
避免 `initSetting` 抛错时进程静默停在「没有窗口」状态（用户只看到双击没反应）。

**关键设计**：

- **全屏是应用层模拟**：`applyFullScreenGeometry()` = `setAspectRatio(0)` →
  （最大化先 `unmaximize()`）→ `setResizable(true)` → `setBounds(所在屏 bounds)` →
  `setResizable(false)` → `setAlwaysOnTop(true)`。
  `isFullScreen` 由主进程自维护，**绝不从原生状态回读**（`resize` 处理器明确不回写它）。
  历史原因见 `transparent` 那条，但**现在主窗口已经不透明了**，模拟仍保留。
- **★ 顺序是硬要求，两处都踩过**：
  1. `setBounds` 的语义随 `resizable` 变：可缩放时按**客户区**解释（`1920x1080` → 客户区
     `1920x1080`，正好铺满）；不可缩放时按**外框**解释（同样的参数 → 客户区 `1904x1072`，
     右边和下边各留 8px 缝，外框右缘停在 `x=1912`）。所以必须**先开缩放、铺满、再关缩放**，
     反过来就是「全屏右边没盖住」。
  2. 最大化窗口不接受 `setBounds`（Windows 规则），不先 `unmaximize()` 的话「全屏」实际停在
     工作区尺寸（`1920x1040`），任务栏那一条露在外面。还原点由 `captureFullScreenRestore`
     提前记好，退出时 `exitFullScreen` 会先 `setBounds(还原点)` 再 `maximize()` ——
     不写回的话 `rcNormalPosition` 已被整屏那次 `setBounds` 污染，
     「向下还原 / 拖离最大化」会还原成整屏。
- **全屏下不可拖动、不可缩放**（用户要求，和原生全屏一致）：
  - 缩放：`setResizable(false)` 去掉 `WS_THICKFRAME`，四个边都没有热区。
    不关的话那圈**不可见**的 8px 边框能拖小窗口，而 `isFullScreen` 仍是 true ——
    状态和几何脱节。顺带解释了「全屏下只有顶边能拖、侧边拖不动」的现象：
    窗口外框铺满后左右/下的边框被推到屏幕外，只有顶边留在屏内。
    退出全屏（`exitFullScreen` / `exitWallpaperGeometry`）会恢复 `setResizable(true)`，
    **顺序必须在 `maximize()` 之前** —— 不可缩放的窗口没有 `WS_MAXIMIZEBOX`，最大化会失效。
  - 拖动：`startWindowDrag` 在 `isFullScreen` 时直接返回 `null`，
    渲染层 `onTitlebarMouseDown` / `onTitlebarDblClick` 也跳过全屏，
    `win:maximize` 在全屏下不再响应。退出全屏只走 F / Esc / 右下角按钮。
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
- **开机自动启动 `applyAutoLaunch()`**（设置 `common.autoLaunch`，默认关）：
  用 Electron 内建的 `app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: [] })`，
  **不需要额外原生依赖**。三个刻意决定：
  ① **每次启动都重写**（不是只写一次）—— 便携版注册的是当前 exe 路径，
     用户挪动文件夹后旧路径会**静默失效**（Windows 找不到就跳过，无提示），重写能自动纠正；
  ② **开发模式一律关掉**（`isDev` 时主动写 `false`）—— 免得把 `electron.exe` 注册进启动项；
  ③ **`args` 传空**—— 不传 `--wallpaper-mode`（那是「这次直接进壁纸」，由
     `common.wallpaperMode` 自己决定，传参数会让两个开关打架）。
  改设置时由 `onSettingChange` 立刻应用（否则要等下次启动才生效，用户会以为没用）。

**踩过的坑（举几个最重的）**：

| 坑 | 后果 |
| :--- | :--- |
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
| `videolists.ts` | ★ **B 站视频列表**：`api:parseListInput` / `api:myFavFolders` / `api:mySubLists` / `api:classifyDrop` + `videolists:list/ add/ remove/ sync/ getItems/ setIndex/ addItemToDefault/ importLocal` + **本地文件善后三条** `local:pickVideo` / `local:relocate` / `local:exists`，见下 |
| `music.ts` | `music:getPlaylistDetail` + `music:importPlaylist` —— ★ 前者是**唯一的加工点**：归一化曲目字段 + 拼好歌单主键，见下 |
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

**`music:importPlaylist` 和 `getPlaylistDetail` 为什么要分成两条**：
前者**会写库**（拖入链接 = 导入，已有则只刷新曲目），后者是纯读 ——
「弹窗里填链接」那条老路径上，用户还要在表单里改名 / 调同步策略，
导入时机由他自己点「保存」决定，不能一路解析一路落库。

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
- **`searchSongFiltered`**：搜索 + **五轮降级重搜**（见
  [功能实现 §2](#2-%E6%90%9C%E7%B4%A2%E4%BB%8E%E6%AD%8C%E5%90%8D%E5%88%B0%E5%80%99%E9%80%89%E8%A7%86%E9%A2%91%E5%88%97%E8%A1%A8)）。入参是
  `(song, singer, songDurationSec, minResults, toleranceSec, filterKeywords, tagBonus, firstPage?)`
  —— **歌名与歌手分开传**，不是一个 `歌名-歌手` 拼串。

  > 拼串再拆是**有歧义**的：歌名本身可能含 `-`（`下坠Falling` / `R.` / `若是明仔载`），
  > 按 `-` 切会切错。而且两者本来就是两个独立字段，只有拼搜索词那一刻才需要同时在场。
- **`searchSong(keyword, page = 1, tids = 全站)`**：**单次尝试，失败就抛**。
  没有 `retryCount`、没有递归重试（那是被风控的元凶）。
  发请求前先过 `throttleSearch()`（**500ms 节流**，模块级时间戳跨调用共享）。
- **`RateLimitError` / `isRateLimitError`**：B站返回 **HTTP 412**（风控拦截页）
  时抛的专用错误。`biliGet` 里单独识别 412，上层靠 `isRateLimitError` 分辨
  「被限流」和「普通网络错误」—— 前者**必须停手**，后者才谈重试。

  > 为什么要单独一个类型：412 和「网络断了」的**处理方式完全相反**。
  > 网络错误等一等重试是合理的；风控 412 再发只会让封禁更久 ——
  > 必须立刻停手并让用户知道「是你切歌太快了」。
- **第 1 轮返回 0 条 = 被风控**，`searchSongFiltered` 直接抛 `RateLimitError`
  （**不再跑第 2/3/4 轮**）。判据：B站搜索**不会**对一首正常存在的歌返回「0 条」。
- **降级轮遇到 412 整轮中止**：catch 里 `if (isRateLimitError(err)) throw err`；
  其它错误才当「这一轮没成」继续。
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

#### B 站视频列表相关（本轮新增）

| 导出 | 作用 |
| :--- | :--- |
| `fetchBiliList(kind, id, { mid, max })` | 拉一个列表（内部自己分页 + 限速，三种来源共用一个返回形状 `BiliListItem[]`） |
| `fetchMyFavFolders()` | 「我创建的收藏夹」列表（新建列表 → 收藏夹，**需要登录**）；带 `cover` 供界面的封面网格用 |
| `fetchMySubscribedLists()` | 「订阅合集」：`x/v3/fav/folder/collected/list` → 只留 `type = 21`（合集），拿 `id`（season_id）+ **作者** `mid` + `cover`；`mid = 0` 的失效合集跳过 |
| `parseListInput(text)` | 从粘贴的链接里认出「类型 + id」（收藏夹 / 合集 / 系列；识别不出返回 `null`） |

- **三种来源写在一个函数里**：它们的返回形状必须一致，差异只在「打哪个接口、字段叫什么」；
  拆成三个函数的话「分页 / 限速 / 跳过不支持条目 / 归一字段」要在三处各写一遍。
- **必须限条数**：`max` 默认 500（13 个请求，够用且不容易触发风控）。
- **`type=21`（合集）/ 番剧 / 课程条目会被跳过并计数**（第一版不支持），
  跳过的数量回传给界面提示，而不是静默少几条。
- **时长有两种形状**：有的接口给数字、有的给 `"04:03"`，统一在 `readDuration()` 里转成秒。

### `utils/db.ts` —— SQLite schema

**职责**：数据层的唯一入口 —— 连接、PRAGMA、建表 SQL、schema 指纹闸门、事务包装。

**八表两视图四索引**：

| 表 / 视图 | 内容 |
| :--- | :--- |
| `playlists` | 歌单（id / name / url / sync_mode / sync_interval_ms / last_sync_at / created_at / updated_at / last_index） |
| `songs` | **歌曲实体，全局唯一**（id / name / singer / album / cover / duration）；**duration 存秒** |
| `playlist_songs` | 歌单 ⨯ 歌曲的**成员关系 + 顺序**，PK `(playlist_id, ord)`，只有 `song_id` |
| `song_videos` | **候选关系**：哪首歌的候选里有它 / 排第几 / 收藏没有；PK `(search_key, bvid)`；另有 `title_hl` 存带 `<em>` 的标题 |
| `videos` | **视频实体 + 播放地址**，PK `bvid`，全局一份（同一个 bvid 被两首歌引用也只存一份 dash） |
| `song_meta` | 每首歌的 `selected_bvid` + `search_login_state`，PK `search_key` |
| `videolists` | **B 站视频列表**（`bv_fav_123` / `bv_season_789`）：kind / source_id / mid / name / item_count / last_index |
| `videolist_items` | 列表成员 + 顺序，PK `(list_id, ord)` |
| `song_videos_view` | **视图**：把 `song_videos` ⨯ `videos` 还原成**旧 `videos` 的 15 列形状**（旧读路径一行不用改） |
| `videos_meta` | **视图**：`song_videos_view` 去掉全部地址列的只读投影（列表类读取走它，省 27 KB/行） |

索引：`song_videos(search_key, ord)`、`song_videos(bvid)`、`videos(playurl_at)`、
`playlist_songs(song_id)`、`videolist_items(bvid)`。

> **`videos` 为什么从 `(search_key, bvid)` 复合主键改成 `bvid` 单主键**：
> `ord` / `favorites` / 高亮标题是**每首歌独立**的，而地址只跟 bvid 有关。
> 混在一行里 → 同一个 bvid 在两首歌的候选里各存一份约 27 KB 的 dash、过期还要刷两遍。
> 新增的 B 站视频列表让这种重复从「很少见」变成常态（列表条目经常同时出现在音乐候选里），
> 所以必须拆。代价用 `song_videos_view` 抵掉 —— 列名与顺序和旧表**逐字一致**。
>
> **老库不会丢数据**：`migrateVideosSplit()` 先 checkpoint + 备份 → `RENAME TO videos_old`
> → 建新表 → 搬数据（实体按 bvid 去重，挑「有 dash 优先、`playurl_at` 最新」那行；
> 关系逐行搬）→ DROP 旧表 → 最后写指纹。顺序反了会「下次启动判定版本一致而跳过迁移」。

**`songs` 与 `playlist_songs` 为什么要分开**（参考 lx-music 的
`my_list_music_info` + `my_list_music_info_order`，但做得更彻底）：

|  | 旧做法（曲目信息塞在关系表里） | 现在 |
| :--- | :--- | :--- |
| 同一首歌在 2 个歌单 | **存 2 行**，歌名/歌手/专辑/封面/时长全重复 | `songs` 表 **1 行**，`playlist_songs` 2 行 |
| 改一次歌名的后果 | 两个歌单里可能一个新名一个旧名 | 一处改、处处一致 |

lx 的 `my_list_music_info` 仍然**按歌单各存一份**（实测 684 行 / 623 首不同的歌），
只有「顺序」被拆了出去；这里把**曲目信息与歌单彻底分开**。

**id 的形态（两张表都不是随机 id）**：

| 表 | id 形态 | 例 |
| :--- | :--- | :--- |
| `playlists` | `平台_平台歌单id` | `tx_8153225605` |
| `playlists`（手动新建） | `pl_<uuid>` | `pl_7f3a…`（没有平台链接可拼） |
| `songs` | `平台_平台歌曲id` | `tx_1828354` |
| `songs`（手动添加的歌） | `歌名-歌手` | `手写的歌-某人` |

> **为什么歌单 id 不用随机 UUID**：同一个歌单**重复导入会命中同一行**，
> 而不是攒出一堆副本；重启 / 换机器后靠 `sourceUrl` 也能推出同一个 id。
> `pl_` 前缀是刻意加的 —— 一眼能看出「这不是平台 id」。
> 拼装统一由主进程做（`playlistKey()`），见 [功能实现 §1](#1-%E6%AD%8C%E5%8D%95%E5%AF%BC%E5%85%A5%E4%B8%8E%E8%A7%A3%E6%9E%90)。

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
  > - **视图必须先于表 drop**（表被删后视图就悬空了，SQLite 不会自动清），
  >   所以按 `type` 排序把 `view` 排前面；
  > - `sqlite_%` 开头的（`sqlite_sequence` / `sqlite_stat1`）是 SQLite 自己维护的，
  >   **绝不能被 drop**。
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

**本轮改造（拆表之后）**：

- **读走视图**：列表类读取一律查 `videos_meta`（不含地址列）；只有「解析前要判断地址
  还能不能用」那条路查 `song_videos_view` 的全列（`getVideoAddress` / `getVideoRow`）。
  两者差 15 倍（9.6 ms vs 0.64 ms，300 行候选）。
- **写拆两张**：展示字段 + `ord` / `favorites` / `title_hl` 写 `song_videos`，
  标题 / 封面 / 作者 / 时长 / 地址写 `videos`（`ON CONFLICT(bvid)` 更新）。
- **`clearAll` 不动 `videolists`**：那是「用户导入的列表」，不是缓存；
  清缓存只清 `song_videos` / `videos` / `song_meta`。
  > 里面那句 `DELETE FROM song_videos` 会**顺带清掉历史遗留的 `bv:` 假关系行** ——
  > 视频条目以前在 `song_videos` 里占一行 `bv:<bvid>`，这套设计已经删了，但老库里可能还有残行。
- **孤儿 GC**：删关系行后，`videos` 里没有任何 `song_videos` 引用的实体由 GC 回收
  （但现在多了一层保险：被 `videolist_items` 引用的**绝不回收**）。

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
| :--- | :--- |
| `toPlaylistSongs(songs)` | ★ **音源 `ParsedSong[]` → `PlaylistSong[]`** 的唯一转换入口 |
| `findSongByCacheKey(cacheKey)` | 按 `songId` 查歌曲完整信息（拼搜索词要歌名+歌手） |
| `findSongDuration(cacheKey)` | 查歌曲时长；内部改为调 `findSongByCacheKey` |
| `getPlaylists()` / `savePlaylists()` / `syncPlaylists()` | 集合的读 / 写 / 同步 |
| `initPlaylists()` / `flushPlaylists()` | 启动加载 / 退出兜底落盘 |
| `ensureDefaultPlaylist()` | 保证默认歌单（`pl_default`）在，没有就建 |
| `appendSongToDefaultPlaylist(song)` | 拖入单曲的落点：两层去重后追加，并把 `lastIndex` 挪到它 |
| `convertPlaylistToLocal(id)` | **平台歌单 → 本地歌单**：换新 id、清链接与同步，一个事务里改两张表 |
| `DEFAULT_PLAYLIST_ID` | 固定主键 `pl_default` —— 「是不是默认歌单」只看这一个字符串 |

**两类歌单的分界**（详见 [ARCHITECTURE](ARCHITECTURE.md#10b-本地歌单与平台歌单)）：

| | 平台歌单（`tx_8153225605`） | 本地歌单（`pl_default` / `pl_<uuid>`） |
| :--- | :--- | :--- |
| 链接 | 身份，用来重新解析 | 只做一次性导入，导完不留 |
| 同步 | 有 | 没有这个概念 |
| 曲目 | 只读（去平台上改） | 随便增删 |

- `applyLocalInvariant()` 把本地歌单的 `source` / `sourceUrl` / `sync` / `lastSyncAt` 清空，
  **`normalizeRecord`（写库前）和 `toRecord`（读库后）各调一次**，绕过界面也造不出脏数据；
- `syncPlaylist` 对本地歌单直接返回「本地歌单不参与同步」，不靠「没有链接」那条兜底报错；
- 平台歌单同步时名字**无条件以远端为准**（以前是「本地名为空才更新」，那样在平台上改名这边永远跟不上）。

**默认歌单的三道闸**（行为和视频那边的「默认列表」一致，实现更简单）：

| 层 | 做法 |
| :--- | :--- |
| 界面 | `PlaylistManager` 按 `isDefault` 禁用删除按钮 |
| store | `removePlaylist` 命中默认歌单直接返回 `false` |
| 主进程 | `savePlaylists` 发现集合里没有 `pl_default`，把它补回去（曲目以内存为准） |

第三道不是多余的：这边的持久化是**整份覆盖**，绕过 store 直接改数组也能删掉。
`isDefault` **不落库**，由 `withDefaultFlag()` 在 `getPlaylists` / `savePlaylists` 两个出口现贴 ——
它是从 id 派生的状态，存下来只会多一处可能不一致的地方。

**★ `toPlaylistSongs` 为什么不写在渲染层**（这是本轮改动的要害）：

音源给的字段名/单位跟库里**不一样**：

| 音源给的 | 库里要的 |
| :--- | :--- |
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
  | :--- | :--- |
  | 那首歌还在 | 用它的**新下标**（按 `songId` `findIndex`，不能用歌名 —— 同步可能改名） |
  | **那首歌被删了** | 保留原下标并夹进范围 → 效果是「下一首顶上来」（播放器的标准行为） |
  | 旧列表本来就是空的 | `0` |

### `utils/videolist.ts` —— B 站视频列表服务（新）

**职责**：`videolists` / `videolist_items` 的 CRUD + 导入 + 同步 + 播放进度。
**它不碰搜索、不碰打分** —— 条目本来就是视频。

| 导出 | 作用 |
| :--- | :--- |
| `videoListIdOf(kind, sourceId)` | 列表主键：`bv_<kind>_<平台 id>`（重复导入命中同一行） |
| `getVideoLists()` | 侧边栏用（按 `created_at` 排序，顺序必须稳定） |
| `findVideoList(id)` | 按 id 找一条（同步时要用 `kind` / `source_id` / `mid` 重打接口） |
| `getVideoListItems(id)` | 条目（**纯读库，不联网**，LEFT JOIN `videos` 取标题封面） |
| `addVideoList(kind, sourceId, mid)` | 拉取 + 落库（**一个事务**，见下） |
| `syncVideoList(id)` | 重新同步 + `last_index` 按 bvid 重定位 |
| `removeVideoList(id)` | 删列表 + 条目关系（`videos` 实体留给 GC 判断，被别的列表引用的不动） |
| `setVideoListIndex(id, index)` | 记录播到第几条 |
| `ensureDefaultVideoList({create})` | 取「默认列表」：设置 → 最早的本地列表 → 新建（见下） |
| `addItemToDefaultList(input)` | 拖入单条视频：加进默认列表并返回 `listId` 供播放 |

**导入为什么必须一个事务**：中途失败不能留下「列表有 500 条、但只有前 200 条能播」
这种半截状态 —— 那种状态用户完全看不出原因。

**导入只写两样东西，**都**很窄**：

```
videos           500 行（只有 bvid / 标题 / 封面 / UP 主 / 时长，**没有地址**）
videolist_items  500 行（list_id, ord, bvid, favorites, origin）
```

> 以前还要往 `song_videos` 里写 500 行 `'bv:<bvid>'` 假关系（让播放走「搜索」那条路），
> 现在视频条目**根本不进搜索链路**，那 500 行连同它带来的一堆 `NOT LIKE 'bv:%'`
> 判断一起删了。

**地址一律等第一次播放时由 `cache.updateVideoResult()` 补**：500 条 × dash 是几十 MB +
500 次请求，必被风控。

**`syncVideoList` 的 `last_index` 重定位**（和音乐歌单同一个坑）：
同步前记住「现在播的那条的 **bvid**」→ 同步后在新列表里找它的下标；
找不到（被移出列表）就保留原下标并夹进范围。

**删除时 `videos` 实体不直接删**：同一个视频可以同时在两个收藏夹里，删 A 列表不能把
B 还在用的实体一起删掉 —— 实体由 `clearAll` 里的孤儿 GC 判断（`NOT IN (SELECT bvid
FROM videolist_items)`）。

**默认列表（拖入单条视频的落点）**：身份记在设置项 `player.defaultVideoListId` 里，
不靠名字匹配，所以**改名不影响**；`removeVideoList` 开头就拿它比一下，命中直接拒删
（界面上按 `toRecord` 填的 `isDefault` 禁用按钮）。三级兜底是
「设置里的 id → 最早的本地列表 → 新建『默认列表』」—— 老库升级上来会认已有的那个本地列表。

**`addVideoList` 现在多返回一个 `existed`**：主键 `bv_<kind>_<平台id>` 是拼出来的，
重复导入必然命中同一行（走的是同步那套合并规则），
这个布尔只用于提示语「已导入」还是「已同步」。

### `utils/dropInput.ts` —— 拖入识别（新）

**职责**：一段文本 → `DropInputTarget`（`music` / `song` / `list` / `video` / `none`）。
**只识别，不联网、不写库** —— 拖入时先要知道「切成哪个工作区」，这一步必须快到松手就出结果。

```
① classifyMusicInput(text) → music / song（按 host 判平台，再看路径像不像单曲页）
② parseListInput(text)     → list（收藏夹 / 合集 / 系列）
③ BV_PATTERN / b23.tv      → video（`input` 原样带走，交给 parseVideoInput 去跟随短链）
④ 其余                     → none
```

**「歌单还是单曲」不在这里判**：三个平台的单曲页形态完全不同（网易云 `/song?id=`、
QQ `songDetail/<mid>`、酷我 `/play_detail/<id>`），这套知识必须和解析待在同一个模块
（`music/index.ts` 调各音源的 `isSongUrl`），否则会出现「识别说单曲、解析当歌单」的漂移。
未接入的平台（酷狗）一律归 `music`，让导入那一步去报「尚未接入」。

**为什么不在渲染层写正则**：这三套规则本来就都在主进程（`music/utils.detectSource`、
`biliApi.parseListInput`、`parseVideoInput` 的短链跟随）。抄一份出去，迟早出现
「粘贴能导入、拖进来认不出」。

**为什么 `video` 只返回 `input` 不返回 `bvid`**：`b23.tv` 短链要跟 302 才知道是哪个视频，
那套逻辑已经在 `parseVideoInput` 里，这里重复一遍就是第二处会漂的实现。

### `utils/localVideo.ts` + `mediaProtocol.ts` —— 本地视频文件

**职责**：给拖进来的 mp4 发一个「长得像 bvid」的身份（`lf_` + 路径哈希），
并用 `blwe-media://local/<bvid>` 把文件流给播放器。

```
localBvidOfPath(p)  → 'lf_' + sha1(规范化绝对路径)[0:16]
getLocalVideo(bvid) → { filePath, title, duration }
localVideoExists / markLocalItemsMissing → 文件还在不在（异步，给界面用）
relocateLocalVideo(bvid, newPath) → 只改 durl_url，**bvid 不变**
```

| 要点 | 为什么 |
| --- | --- |
| 路径存 `videos.durl_url`，不加列 | 语义相同（「能直接塞给 `<video src>` 的地址」），且**指纹不变 → 不触发整库重建** |
| 库里存路径、不存 URL | 路径是事实、URL 是派生；文件名里的 `#` / `?` / `%` 塞进 URL 要 encode，二次编码会播错文件 |
| `blwe-media://` 自实现 `Range` → 206 | `net.fetch(file://)` 只给整份 200，一拖进度条就从第 0 字节重读 |
| URL 里只放 bvid，路径回查库 | 这个协议只放得出去「用户登记过的文件」，不是任意文件读取器 |
| 重新定位**不改 bvid** | 列表位置 / 收藏 / 续播指针全引着 bvid；迁移主键要逐个改引用，漏一处就是孤儿数据 |
| `missing` 只在 IPC 层异步算、不落库 | 同步 `stat` 掉线网络盘会冻住主进程；文件可能只是暂时不在（拔了硬盘），状态不该写进数据 |

**`markLocalItemsMissing` 只 stat `lf_` 条目**：一个 500 条的列表里绝大多数是 B 站视频，
逐个摸盘既无意义又慢。B 站条目的 `durl_url` 是带签名、几分钟过期的直链，
所以在 `getVideoListItems` 里也只给本地条目带 `localPath`。

### `utils/playlistImport.ts` —— 拖入音乐 → 导入/追加（新）

**职责**：两个入口，落点不同：

| 函数 | 干什么 |
| :--- | :--- |
| `importMusicPlaylist(url)` | 拖入**歌单**：解析 → 已有则同步、没有则新建 → 设为当前 |
| `importSongToDefault(url)` | 拖入**单曲**：解析 → 追加进默认歌单（去重）→ 把 `lastIndex` 挪到它 |

单曲不新建歌单，是因为拖一首歌进来的意图是「我想听这首」，不是「帮我建个歌单」——
否则歌单列表里迟早攒出一堆只有一首歌的歌单。
**为什么单开一个文件**：它同时依赖 `music/index.ts` 和 `utils/playlist.ts`，
而后者已经在用音乐那边的同步逻辑 —— 塞进任何一边都会变成循环依赖。

**「已有就同步」的判据**：主键相同（`平台_平台歌单id`）**或** `sourceUrl` 相同。
命中后**只刷新曲目**，名字 / 同步策略 / `lastIndex` 全部保留 ——
拖一下就把用户改过的名字还原成平台名，会让人以为出了 bug。

**和 `savePlaylists` 的关系**：它是**全量覆盖**写库，所以这里必须先
`getPlaylists()` 拿全量、改一条、再整体写回（渲染层随后 `load()` 一次对齐）。

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
- **`fitWallpaperWindow`（唯一改几何的地方）**：`GetClientRect(父窗口)` 取桌面层客户区，
  和窗口自己的客户区比，不一致才 `SetWindowPos(..., SWP_NOZORDER|SWP_NOACTIVATE|
  SWP_NOSENDCHANGING)`。幂等，所以可以每秒调。**不走 Electron 的 `setBounds`**：
  挂到 WorkerW 之后是父客户区坐标系，混用会让窗口在任务栏/分辨率变化后对不上
  （「一圈白边」）。
  **注意 `SetWindowPos` 的 `cx/cy` 是外框尺寸**：frameless 窗口仍有 8px 不可见边框
  （左/右/下 8、上 0，随 DPI 变），直接传父客户区尺寸会漏出「两侧 + 下面」的白边。
  所以位置要减 `(左边框, 上边框)`、尺寸要加边框总量，边框每次现读（`GetWindowRect` −
  `GetClientRect` + `ClientToScreen`）。对齐判据 = 客户区尺寸相等 **且** 客户区原点在父
  客户区的 `(0,0)`。
- **`findWorkerWQuiet`**：不发 `0x052C` 的只读查找，给守护轮询用 ——
  高频路径不能再顺手动 Explorer 重建壁纸层。

### `winShowState.ts` —— 窗口显示状态的原生还原

**职责**：`restoreFromMaximized(win)` —— 把最大化的窗口还原成普通窗口，
**在鼠标左键按着的时候也能生效**（拖动路径必须用它）。

**为什么不能直接用 `unmaximize()`**：`BrowserWindow.unmaximize()` 在
**左键按着**的状态下是**空操作** —— 返回成功、`isMaximized()` 仍为 `true`，
松手也不补。而「拖离最大化」这个动作恰好就发生在左键按着的时候，于是
窗口留在最大化状态，后续每帧 `setPosition` 被 Windows 忽略，
表现是「最大化之后窗口拖不动」。

实测对照（`frame:false` 窗口，同机同进程）：

| 场景 | `unmaximize()` | `ShowWindow(SW_RESTORE)` |
| :--- | :--- | :--- |
| 没按鼠标键 | ✅ 立即生效 | ✅ |
| **左键按着** | ❌ 仍是 true，250ms 后、松手后都仍是 true | ✅ 立即生效 |

所以这里走原生 `ShowWindow(hwnd, 9)`，并用 `IsZoomed` 校验（系统眼里是否最大化，
比 `isMaximized()` 更接近「`setBounds` 能不能生效」的真相）。koffi 加载失败时
退回 Electron API 并返回 `via: 'electron'`，由调用方判断（`startWindowDrag`
拿不到 `restored: true` 就返回 `null`，绝不用错误的偏移量继续拖）。

> ⚠️ 退出壁纸的还原（`exitWallpaperGeometry`）**仍然用 `unmaximize()`**：
> 那里窗口是 `hide()` 的，而 `ShowWindow(SW_RESTORE)` 会顺带**显示**窗口，
> 正好破坏「退出时不闪一下」。


### `portable.ts` —— 便携版数据目录

**职责**：判定数据目录 + 改写 `userData`。导出 `setupUserDataPath()` / `isPortable()`。

**三条优先级规则**：

| 情况 | 用哪个目录 |
| :--- | :--- |
| `%APPDATA%/BiLiWallpaperEngine` 里**已经有数据** | 就用它（安装版 / 便携版共用一份） |
| 没有数据，且当前是便携版 | exe 同级的 **`blwedata/`**（`PORTABLE_DATA_DIR_NAME`） |
| 没有数据，且是安装版 | 默认的 `%APPDATA%/BiLiWallpaperEngine` |

> ⚠️ **目录名的准确值是 `BiLiWallpaperEngine`** ——
> `app.getPath('userData')` 等于 `%APPDATA%/<package.json 的 name>`，
> 而 `name` 就是 `BiLiWallpaperEngine`。
> （README 里曾写成 `-desktop`，那是**错的**，排查时按那个路径去找会**一无所获**。）
>
> 实际路径：`C:\Users\<用户>\AppData\Roaming\BiLiWallpaperEngine\blwe.db`

**关键设计**：

- **必须最早期调用**：`app.getPath('userData')` 一旦被读取就可能被缓存，
  之后再改会导致配置/缓存写到两个不同的地方。
- **判「有数据」必须看自家文件而非目录是否存在**：Electron 一启动就会把
  userData 目录建出来，那样在全新机器上永远判成「有数据」。
- **`blwe.db` 必须在标记列表里**：换成 SQLite 之后真正承载用户数据的就是它；
  漏掉的话，「只有库文件」的目录会被判成没有数据，
  便携版就会去 exe 同级再建一个空库 —— 用户看到的是「**歌单全没了**」。
- **两个 `setPath` 都要改**（`appData` + `userData`）：只改 userData 的话，
  Electron 内部仍可能往 Roaming 里写东西。

### `protection.ts` + `bundleKey.ts` —— 资源解密

**职责**：注册 `blwe://` 协议，页面请求哪个文件就解密哪个，**只解密到内存、不落盘**。

**关键设计**：

- **为什么用自定义协议而不是拦 `file://`**：覆盖内置 file 协议要自己重写
  整套文件服务（MIME、目录穿越、范围请求…），而 `protocol.handle` +
  `registerSchemesAsPrivileged` 是官方支持的路子。注册成 standard + secure 之后
  页面 origin 是 `blwe://app`，fetch / MSE / CORS 行为与 https 页面一致。
- **明文文件原样返回**：加密是**按需可选**的（开发态、image/font 等不需要加密）。
- **`decodeURIComponent` 要兜底**：`blwe://app/%` 这种畸形百分号会让它抛 `URIError`，
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

- `TrayMenuState` 等共享形状。

**关键设计**：所有 handler 经 `mainHandle(channel, payload => ...)` 注册，
channel → `{params, result}` 的契约集中在这里，
**漏写参数或返回错类型会在编译期报错**。
注释明确批评过「清单拆成两处」的旧做法。

**两处本轮改过契约的通道**：

| 通道 | 变化 |
| :--- | :--- |
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

- **`player.activeVideoListId`**（本轮新增）：当前在播的 B 站视频列表 id，
  空串 = 在播音乐歌单。存在的理由：播放层只有一个 `songs` 数组，
  「这次打开该从哪个来源续播」必须有落盘的地方；没有它，用户今天导入的收藏夹
  明天开机又回到音乐歌单。

- **`player.defaultVideoListId`**（本轮新增）：默认列表的 id（拖入单条视频的落点）。
  存在这里而不是靠「名字叫默认列表」：改名之后它还是默认列表，而且**禁止删除**
  （`removeVideoList` 第一道闸就是拿它比）。

- **`ui.mode`**：**已删除**。工作区不再是一个可写的设置项 —— 它是播放源的投影
  （`queue.mode`：在播视频列表 → `ov`，在播歌单 → `mv`，什么都没有 → `ov`）。
  以前它由「点开哪个管理弹窗」写入，导致点一下按钮界面就换边、而播放还在原地。

- **`tagBonus` 与 `filterKeywords` 的区别**（注释里用表格写死了）：

  |  | tagBonus | filterKeywords |
  | :--- | :--- | :--- |
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
| :--- | :--- |
| `rankVideos(videos, options)` | 一站式入口：过滤 + 打分 + 排序 |
| `passHardFilter(...)` | 单条硬过滤判定 |
| `scoreVideo(video, singer, tagBonus)` | 打分（歌手命中 +100；关键词累加**无上限**） |
| `splitSongName(name)` | ★ 拆歌名 → `{ name, tail }`：`name` 是**第一个括号之前**的正名，`tail` 是**括号及其后**的全部内容。见下面「歌名怎么拆」 |
| `baseSongName(name)` | 取正名（= `splitSongName(name).name`）。**搜索词与过滤判据共用这一个** |

> `splitCacheKey`（把 `"歌名-歌手"` 拆回两个字段）**已删除** ——
> 它零调用：`song` / `singer` 从头到尾都是两个独立入参，没有任何地方需要拆串。
> 解析旧 JSON 数据用的是 `parseCacheKey`（在 `common/types/playlist.ts`）。

**`RankOptions` 收的是 `song` + `singer` 两个独立字段**（不再是拼串）——
理由见 `biliApi.ts` 那节「拼串再拆有歧义」。

**内部还有几件不导出的实现细节**（都在 §3 展开）：`titleHasSongName`（硬过滤核心）、
`TRAILING_FORM_WORDS`（形式词表）、`flattenWithMap`（去空格比对但保留索引映射）、
`toSimplified`（opencc 简繁归一）。

详见 [功能实现 §3](#3-%E6%90%9C%E7%B4%A2%E7%BB%93%E6%9E%9C%E6%8E%92%E5%BA%8F%E7%A1%AC%E8%BF%87%E6%BB%A4--%E6%89%93%E5%88%86)。

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
- **`durationToSeconds` 用 `split(':')`，不用正则**：
  曾经用 `^(\d{1,2}):(\d{2})(?::(\d{2}))?$` 卡「分钟只能 1-2 位」，结果
  **≥100 分钟的时长解析失败**：

  ```
  "100:00"  → 正则不匹配 → 退回 Number("100:00") = NaN → null
  ```

  而平台的时长文案本来就允许总分钟超过 99（长串烧、全场 live 音频），
  我们写库用的 `formatPlayTime` 产出的也正是 `"100:00"` 这种形态 ——
  等于**自己写出去的值自己读不回来**。那首歌的时长会存成 NULL，
  于是**时长过滤整段跳过**（5 分钟的歌会放进 50 分钟的合集）。

  改成 `split` 后位数多长都认：2 段 = 分:秒、3 段 = 时:分:秒，
  4 段及以上非法。每段必须是纯数字（拦住 `"1::3"` 这种）。
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

### `App.vue` —— ★ 装配图

**职责**：模板装配 + 生命周期挂载。**这里没有业务逻辑，也没有样式。**

| 段 | 内容 |
| :--- | :--- |
| 模板 | 12 个组件按层摆好 + `<video>` 的 13 个事件直接绑到 store 的 action；**没有 props、没有 emit** |
| `onMounted` | `attachVideo(el)` 把 `<video>` 交给 store → `bootstrap()` 起引擎、挂全部监听 |
| `beforeUnmount` | `teardown()` 摘监听（17 个托盘事件等） |

> **以前这里是 5587 行的「界面中枢」**：117 个 data、17 个 computed、150 个方法全挤在
> 这一个文件里，UI 状态和播放状态缠在一起 —— 任何一处改动都要先通读全文。
> 现在拆进 `stores/` 下的 8 个独立 store（见下），播放器交互收进 `utils/playbackEngine.ts`。
>
> **新增功能别往这个文件里加**：先问它属于哪个域，落到 `stores/` 下对应的 store
> 或 `utils/playbackEngine.ts` 里；只有「模板 / 挂载」才属于这里。样式落点是 `styles/`。

### `styles/` 目录 —— 全局样式

| 文件 | 职责 |
| :--- | :--- |
| `theme.css` | 主题令牌：`--glass-*`（浮在视频上的毛玻璃）/ `--panel-*`（有实底的面板）/ 强调色 / `--ui-idle-opacity`。值由 `utils/uiTheme.ts` 按设置写进来，浅底与深底的阴影靠 `html[data-tint='dark']` 切换 |
| `global.css` | 不随设置变化的骨架与第三方覆盖：`#app` / `#biliVideo` 定位、`el-dialog` 面板化、遮罩上的「点击空白位置关闭」、`.wm-hidden`（壁纸模式隐藏标题栏与控制栏） |

**为什么必须放在 `main.ts` 里 import**：这些规则从来不属于某个组件 ——
`el-dialog` 是 teleport 到 `body` 的，`#app` / `#biliVideo` / `.wm-hidden` 作用于全局节点
或跨组件，组件的 scoped 样式够不到。以前它们是 App.vue 末尾一个非 scoped 的
`<style>`（161 行），让「装配壳」兼任全局样式表。

**顺序**：在 `element-plus/dist/index.css` **之后**引入，否则对 el-dialog 的覆盖不生效。

### `utils/playbackEngine.ts` —— ★ 把「队列里的一条」变成「`<video>` 上的流」

| 块 | 内容 |
| :--- | :--- |
| **分派** | `resolve()` 是唯一的岔路口：`isVideoItem()` → `resolveVideoItem()`（bvid 已在手里，**不搜索**）；否则 → `resolveSongItem()`（搜索 → 挑候选 → 解析） |
| **对外** | `playAt(index)` / `playCandidate(bvid, opts)` / `reload()` / `recover()` / `next()` / `prev()` / `stop()` / `fallbackToDurl()` / `retargetDash(url)` |
| **竞态** | **一条** `token`：切走就 `++`，回调回来对不上就丢弃（以前是 `_songToken` / `_videoToken` 两条，该谁失效靠人记） |
| **挂载** | dash → `DashSession`（MSE 双轨）；durl → `video.src`；dash 连续失败两次 → 本会话放弃 dash |
| **降级** | `fallbackToDurl()` 的决策（失败计数、是否放弃 dash、记进度）全在引擎里，界面只清显示状态 |
| **宿主** | `PlaybackHost` 回调：`queue` / `index` / `videoEl` / `onSwitch` / `onStream` / `onEmpty` / `onError` / `onLocalMissing` / `withNet` / `stepIndex` / `isPaused` / `qualityOverride` / `rememberSeek` |

**关键设计**：这个文件**不 import Vue、不 import Pinia、不读任何组件字段**。
需要外界的信息全走 `PlaybackHost` 回调 —— 所以换个宿主（比如以后的托盘小窗）也能直接复用。

### `types/playItem.ts` —— 队列条目类型与取值器

```ts
type PlayItem = PlaylistSong | VideoListItem
isVideoItem(item)   // 'title' in item
```

配上 `titleOf` / `subtitleOf` / `coverOf` / `durationOf` / `bvidOf` / `keyOf`。
**判别字段是 `title`**：`VideoListItem.title` 必有、`PlaylistSong` 永远没有；
而 `bvid` 在歌上也曾是可选字段，用它判别会重叠。

> **以前不是这样**：`toSongs()` 把视频映射成歌的形状（`title→name`、`author→singer`），
> 于是下游只能靠 `if (item.bvid)` 猜这是不是视频，类型系统完全帮不上忙。
> 现在两者各保各的字段，判断是**显式**的类型守卫。

**`keyOf(item)` 只是本进程内的标识键**（视频 = bvid、歌 = `歌名-歌手`），
用于「这个错误 / 这次定位是不是当前这条的」比较。**不要写进数据库，也不要当搜索词** ——
以前那个 `bv:` 前缀就是为了让搜索接口认得出来，那套已经删了。


### `stores/` 目录 —— ★ 按业务域拆开的独立 store

一个 `defineStore` 只管一个域；跨域访问写 `this.queueStore.playAt()`，
那个指针是 getters 里的一个条目（`queueStore: () => useQueueStore()`），
惰性求值 —— 所以模块之间可以互相 import 而不成环。

| 文件 | 职责 | 规模 |
| :--- | :--- | :--- |
| **`playback.ts`** | 引擎装配、dash / durl 挂载、`<video>` 全部事件、缓冲圈、卡顿恢复链、清晰度切换、下一首预热 | 67 个 action |
| **`queue.ts`** | 列表数据（`songs` / `videoList`）、当前下标、播放模式、歌单与视频列表装载、候选视频刷新、收藏 | 14 |
| **`ui.ts`** | 弹窗开关、列表面板（浏览 / 候选）、错误文案、网络忙计数、清晰度冷却 | 18 |
| **`window.ts`** | 最大化 / 全屏 / 壁纸模式 / 锁定 / 标题栏拖拽 / 快捷键 / 托盘菜单守卫 | 12 |
| **`system.ts`** | SMTC、任务栏进度、托盘状态同步、播放位置落盘、定时同步 | 14 |
| **`session.ts`** | 登录态、用户信息、扫码登录、退出确认 | 5 |
| **`sleep.ts`** | 定时暂停 / 定时关闭（含每秒推的状态快照） | 4 |
| **`drop.ts`** | 拖入导入：分类 → 四路分派（歌单 / 单曲 / B 站列表 / 单条视频）→ 本地文件探针 | 12 |
| **`bootstrap.ts`** | **不是 store**：`boot.attachVideo()` / `bootstrap()` / `teardown()` / `init()`，只做编排、不留状态 | 9 |
| `constants.ts` | 缓冲 / 预热 / 卡顿 / 冷却的常量（playback 与 ui 共用） | — |
| `setting.ts` | 配置的响应式副本（主进程那份是权威） | — |
| `playlists.ts` | 歌单集合 + 同步编排 + 收藏 | — |
| `videoLists.ts` | B 站视频列表副本（列表 / 条目 / 同步 / 收藏） | — |

**为什么 `playAt` / `next` / `prev` 在 `playback` 而不是 `queue`**：它们要跟引擎令牌、
降级链、续播点打交道，搬进 queue 就变成 queue → playback → queue 的双向流程调用。
queue 只回答「列表里有什么」。依赖方向因此是 `playback → queue → ui`。

**三个类型坑**（细节见 [ARCHITECTURE](ARCHITECTURE.md#播放引擎与状态分层渲染层怎么拆的)）：

1. `ThisType<>` 指向本 store 的 `XxxContext`（`State & Getters & Actions`），
   不能写 `ReturnType<typeof useXxxStore>` —— 会和 `defineStore` 的泛型成环。
   **代价：签名写两遍**（实现 + `interface XxxActions`），改签名要同步。
2. getters 双形态：`XxxGetters` 声明成属性（`this.xxx` 要解包后的值），
   `XxxGetterFns` 派生函数表给 `defineStore` 泛型，装配处 `getters: xxxGetters as never`。
3. 跨 store 指针必须写成 getter，不能在模块顶层 `useXxxStore()` —— 循环 import 时
   那一刻对方还没初始化完。

### `components/` 目录

| 文件 | 职责 |
| :--- | :--- |
| `AppTitlebar.vue` | 标题栏：左上歌单入口、中间拖拽区、右侧定时 / 壁纸 / 头像 / 设置 / 窗口按钮。**直接读 store、直接调 action**（没有 props、没有 emit）；壁纸模式与锁定态用 class 隐藏（`v-if` 会卸载、丢内部状态） |
| `BufferOverlay.vue` | 缓冲圈：`percent` + SVG 圆环周长/偏移 + 「已缓冲 x 秒」副标题，全部来自 store 的 getter |
| `CornerButtons.vue` | 右下角全屏 + 左下角锁定（两个直接调用）；锁定时只留这两个按钮，图标字体里没有锁所以用内联 SVG |
| `VideoControls.vue` | 播放控制栏；`mode` 只影响文案（上一个视频 / 下一首）与「歌曲列表」按钮是否渲染；两个列表按钮的图标与名字**固定**，不随模式变；壁纸 / 锁定时整条 `wm-hidden` 也在这里判 |
| `SettingsDialog.vue` | 设置弹窗（**左栏目录 + 右栏一页到底**） |
| `SleepTimerPanel.vue` | 定时暂停弹窗（时长草稿 + 三个复选框，**只有确认才写回 store**） |
| `PlaylistManager.vue` | 歌单管理（左列表 + 右「内联表单 / 曲目列表」）；表单内容**原样**交给主进程、不做字段转换（见下）；**表单按歌单类型分流**（平台歌单只给同步方式 + 「转成本地歌单」，本地歌单给改名 + 链接导入器）；本地歌单带「本地」标签、不同步；默认歌单带「默认」标签、删除按钮禁用；左下角第二行是「视频管理 →」（= 切模式） |
| `VideoListManager.vue` | **视频管理**：左列表 + 右条目预览；**「新建列表」一张表单收口四种来源**（空列表 / 粘贴链接 / 收藏夹 / 订阅合集，后两者是**封面网格**选片、选中高亮）+ 添加视频 / 收藏（置顶）/ 移除 / 重命名；**本地文件丢失的条目置灰 + 「文件丢失」标 + 「定位」重选路径**；左下角第二行是「← 歌单管理」 |
| `SongVideoListDialog.vue` | 列表面板，两种形态按 `listType` 切换：`songList` 歌单（MV）/ `videoList` 视频列表（MV = 这首歌的备选，OV = 当前合集）；点一行 / 刷新 / 爱心 / 加号都直接调 store |
| `DropOverlay.vue` | 拖入遮罩（整窗虚线框 + 「松手即可导入并播放」），`dropActive` / `dropBusy` 来自 store |
| `AddVideoDialog.vue` | 「添加视频」弹窗（粘贴链接 → 解析 → 收藏） |
| `AboutDialog.vue` | 关于弹窗 |
| `PlaylistPanel.vue` | 左上角歌单入口 |

**`SleepTimerPanel.vue` 的关键设计**：

- **`el-dialog` + `v-model`**，和歌单管理 / 设置同一套形态（不是锚点面板）。
- **时长与三个复选框是本地 `draft`**，编辑只改草稿，点「确认 / 更新定时」才
  `player.applySleepTimer({hours, minutes, options})`。这是被逼出来的：原来编辑时立刻
  向定时器上报 → 定时器 `emit()` → 那时还没启动、`active` 为 false →
  订阅回调里的「没在倒计时就关面板」直接生效，**点一下加号弹窗就自己关了**。
  （定时器上那个「实时同步选项」的方法**零调用，已删** —— 见第 12 节的说明。）
- **`confirm()` / `onCancel()` 里仍自己置 `visible = false`**：
  早期只 emit 给父组件、指望它改 `sleepPanelVisible` 时**弹窗不会关**
  （`v-model` 是 getter/setter，父组件改值时 setter 又 emit 回来形成来回覆盖）。
  现在组件直接写 store，setter 不再 emit，回环已经不存在；这句留着是为了「点了确认框就该消失」的确定性。
- **时/分用 `el-input-number`（`:controls="false"`）**，可以直接打字 ——
  要 59 分钟不该按 59 下加号。`+` / `−` 保留做微调，并且**分满 60 进一位到小时**
  （59 点 `+` → 时 +1、分变 0；0 点 `−` → 时 −1、分变 59）。

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

- **★ 分值档的交互（本轮改过两轮）**：

  **现在的形态**：

  ```
  第一行： [+] [ 分值 ] [−] …………  删除分值档      ← 加号在左、减号在右，删除推最右
  第二行： 「关键词」 「标签」 [+]                     ← 标签多了自动换行
  ```

  - **分值是 `el-input-number`（`:controls="false"`）**，可以**直接打字**
    改成任意分值（比如把 `3` 打成 `-50`）。原来是个不可聚焦的 `span`，
    只能按 `←` / `→` 一点点挪。
  - **两个入口共用同一套「换键」逻辑**：`shiftTagBonusScore(score, ±1)` 做增减，
    `applyTagBonusScore(score, value)` 直接设值 —— 内部都是把键 `"5"` 换成 `"6"`、
    **关键词跟着搬过去**（`player.tagBonus` 的**键就是分值**）。
  - **删除要二次确认**：点「删除分值档」后那一行原地换成
    「确认删除？」+「确认」（红）/「取消」（蓝）。待确认的分值记在 `deletingScore`，
    所以同时只有一档处于待确认状态。理由：一档可能配了很多关键词，误点一次就全没了。
  - **`+` / `−` 和「删除分值档」在同一行**，删除靠 `margin-left: auto` 推最右
    —— 让它和微调按钮拉开距离，避免误点。

  两个细节没变：

  - **保持键的顺序**：重建对象时按当前显示顺序放新键，
    否则这一档会**跳到最后一行**（按一下 `+` 就往下一行跳，很别扭）；
  - **撞到已存在的档就不动**并提示 —— 合并会**丢信息**（用户本来分了两档不同权重），
    悄悄合并会不知不觉改变打分结果。

- **★ 分值上限已去掉**（`addTier` 不再校验 ±10，`TAG_BONUS_SCORE_MIN/MAX` 常量已删）：
  关键词加权不再被 clamp，用户想给「伴奏」配 `-50` 是完全合理的。

  > `addTier` 现在只校验「是整数」和「不重复」。
  > 数字输入框有一个**很宽的**安全范围（`TAG_BONUS_SCORE_HARD_MIN/MAX = ±10000`）——
  > 那不是业务上限，只是防手滑多打几个 0，正常使用永远碰不到。

- **「歌手名命中 +100」那句说明已删掉**（用户要求），小标题行现在是
  「关键词加权」靠左、「添加分值档」靠右（`.st-sub--split` + `space-between`）。

**`PlaylistManager.vue` 的关键设计 —— ★「凡是主进程能算的，渲染层一律不碰」**：

解析歌单后它只做**原样透传**，两样东西：

```ts
songs = detail.songs as unknown as PlaylistSong[]   // 已经是库里形态（带 platformId）
presetId = detail.id                                // 已经是 tx_8153225605
```

| 它**不碰** | 原因 |
| :--- | :--- |
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

### `setting.ts` / `playlists.ts` / `videoLists.ts` —— 数据层三个 store

这三个是**纯数据副本**（都不碰界面）：

| 文件 | 职责 |
| :--- | :--- |
| `setting.ts` | 配置的**响应式副本**（持久化在主进程，见「配置的读写与广播」） |
| `playlists.ts` | 歌单副本 + 同步编排；**默认歌单删不掉**（`removePlaylist` 返回 `false`）；`updatePlaylist` 按类型剔字段（平台只留 `sync`、本地不留链接与同步）；`convertToLocal` 换 id 并重映射 `currentId` |
| `videoLists.ts` | **B 站视频列表副本**：列表 / 条目 / 同步 / 本地列表 / 收藏，以及 `activeId`（当前在播哪个列表，`''` = 音乐歌单） |

**`videoLists.ts` 与 `playlists.ts` 是并列的**（不是一个 store 里加个 `kind` 字段）：
两者的表、id、同步方式都不同，混在一起会让「当前是哪种来源」变成一堆
`if (kind === 'video')`。播放层只认 `songs`，来源差异在 `loadPlaybackSource()` 里抹平。

**`activeId` 自己不持久化**：落盘的是设置项 `player.activeVideoListId`，
由 `player/actions/library.ts` 的 `setActiveVideoList()` 读写 ——
store 保持「只做数据」，不碰设置。

**`add(kind, sourceId, mid)` 返回 `existed`**：主键重复即「这次走的其实是同步」，
调用方据此说「已导入」还是「已同步」。
**`addItemToDefault(input)`**：拖入单条视频的落点，`listId` 由主进程决定
（哪个是默认列表 / 没有时现建，都不是渲染层该知道的事）。

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
| `sleepTimer.ts` | ★ 定时暂停 / 定时关闭：倒计时 + 冻结 + 「播到 0-3 秒」判定 |
| `uiTheme.ts` | 主题令牌（CSS 变量）：颜色 / 毛玻璃 / **闲置透明度** / 深浅判定 |
| `image.ts` | 图片地址规整 |
| `plain.ts` | 深度解包（去响应式，写盘前） |
| `title.ts` | 标题净化（只留 `<em>`） |
| `mediaProbe.ts` | 本地视频探针（`<video preload="metadata">` 读时长 + 实测能否解码） |
| `videoQuality.ts` | 按解码分辨率兜底清晰度标签 |

**`sleepTimer.ts` 的关键设计**：

- **为什么在渲染层**：三个执行条件里有两个只有渲染层知道 —— 「视频播到第几秒」
  要读 `<video>.currentTime`、「暂停时冻结」要读 `paused`。主进程看不到这些。
  只有「退出应用」那一步走 IPC（`win:quit`）。
- **三个选项是叠加的**（`pauseCountdown` / `waitVideoEnd` / `closeApp`），不是三选一。
- **`inFireWindow(t) = t > 0 && t <= 3`**：不能用 `currentTime === 1`，
  `timeupdate` 约 250ms 一次且给的是浮点数，严格等于必然错过。
- **冻结/恢复的顺序坑**（详见 ARCHITECTURE）：恢复判断必须在
  `if (!deadlineAt) return` **之前**，否则「暂停会冻结、恢复后不再走」。
- **`syncNow()`**：由 `<video>` 的 `play`/`pause` 事件调用，
  解决「点暂停后倒计时还多跑一秒」（原来只在每秒 tick 里判断）。
- **`snapshot().active` 把 `pending` 也算进去**：归零后 `deadlineAt` 已是 `null`，
  只看它界面会误以为「没定时」。

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
   否则从「歌单管理 / 视频管理」滑到「退出程序」松手会**直接把应用退掉**。

另：列表**只在启动时建一次 DOM**，之后只改文案
（300ms 推一次状态时重建 DOM 会让 mouseup 落不到同一元素 = 点不动）。

**管理项文案是动态的**：`showPlaylist` 那一项的 `label` 读 `TrayMenuState.mode`，
`mv` 显示「歌单管理」、`ov` 显示「视频管理」（默认 `ov`）。点下去发的是同一个
`tray:showPlaylist`，落地页由渲染层 `openManager()` 按当前工作区决定 ——
文案和落地页共用同一份 `queue.mode`，不会说一套做一套。这个值由渲染层随
`trayUpdateState` 推上来（`TrayState.mode`），主进程不自己推算。

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
| :--- | :--- |
| **只引子路径 `opencc-js/t2cn`** | 主入口（`require('opencc-js')`）是 **1.1 MB** 全量包（含简→繁、日文新字体、台湾/香港变体 —— 我们一个都不用）；`t2cn` 子路径只有 **106 KB**，正是「繁→简」这一件事。**体积差 10 倍** |
| **不需要 `asarUnpack`** | `dist/umd/t2cn.js` 是**自包含**的（字典全内联、文件内**零 `require`**），所以直接从 asar 里加载即可 |

> 实测：`npm run pack` 之后 asar 里有 `node_modules/opencc-js/dist/umd/t2cn.js`，
> 跑打包后的 `BLWE.exe` **无 opencc 告警**（退化时会打印
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
| :--- | :--- | :--- |
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

**入口**：`player/engine.ts` 的 `playAt(index)` → `resolveSongItem()` →
`getSongParts(index)` 取**歌名 + 歌手两个字段** → `electronApi.searchSong(song, singer)`
→ `ipc/biliApiHandlers.ts` 的 `api:searchSong`。
（视频条目走 `resolveVideoItem()`，**不经过搜索**，见第 15 节。）

**完整流程**（★ 注意「缓存键」与「搜索词」是两回事）：

```
入参：song（歌名）+ singer（歌手）+ skipCache     ← **两个独立字段**
  ↓
主进程拼出两个东西（拼装只在这里做一次）：
  cacheKey       = joinCacheKey(song, singer)          = "歌名-歌手"   ← 缓存主键（用**原始**歌名）
  primaryKeyword = buildPrimaryKeyword(
                     splitSongName(song).name, singer) = "歌名 歌手"   ← 发给 B站（用**正名**）
   ↓
  ※ `splitSongName(song).tail`（括号及其后的内容）留给第 4 轮
  ※ 过滤判据也走 `baseSongName`（= `.name`）—— 搜索与过滤必须同一个名字
  ↓
① 读缓存 cacheManager.get(cacheKey)
     命中 → **原样返回**（库里存的就是搜索时已过滤+排好序的那份，不再重过滤）
     缓存是空表 → 当作没命中，往下真搜
  ↓
② 真实搜索
     findSongDuration(cacheKey)            ← 遍历主进程内存，不查库
     biliApi.searchSong(primaryKeyword)    ← 第 1 轮（全站），WBI 签名
     searchSongFiltered(song, singer, ...) ← 补齐 + 降级（见下）
     setSearchLoginState(cacheKey, ...)
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
⑥ cacheManager.save(cacheKey, {...})  ← DELETE + INSERT
  ↓
⑦ 返回 { result, selectedBvid? }
```

> ### ★ 缓存命中**不做任何过滤/排序**
>
> 库里存的就是**搜索时已经过滤并排好序**的那份（`save` 收到的 `finalList`，
> 顺序按 `ord` 落库；`cacheManager.get` 内部 `ORDER BY ord ASC`）。
> 所以读路径原样返回 —— 在这里再调一次 `rankVideos` 是把同一批数据按同一套规则
> **再算一遍**，纯属多余。
>
> **曾经的错误做法**（别改回去）：读缓存时「按当前规则重过滤」一遍，
> 理由是「用户改了过滤设置要立刻生效」。那个理由站不住：
>  - 改设置后**本来就该重搜**（`skipCache`），拿旧结果套新规则等于用一份过期的
>    候选集去猜「新规则下该显示什么」；
>  - 而且**过滤结果不回写**（`save` 是 DELETE+INSERT，回写会把被挡的行永久删掉），
>    于是「库里 40 条、界面 35 条」这种不一致会一直存在；
>  - 用户看到条数莫名变少（日志「剔除 N 条」），却没有任何操作导致它。
>
> ⚠️ **副作用（用户已知并接受）**：改了过滤设置后，**已经搜过的歌仍是旧结果**，
> 要看到新规则的效果必须点视频列表的**刷新**按钮（`skipCache`）。

> **为什么歌名和歌手要分开传，而不是一个 `歌名-歌手` 拼串**：
> 拼串再拆是**有歧义**的 —— 歌名本身可能含 `-`
> （`下坠Falling` / `R.` / `若是明仔载`），按第一个 `-` 切会切错。
> 而且两者本来就是两个独立字段（歌单里、界面上都分开存），
> 只有**拼搜索词**那一刻才需要同时在场 —— 而那一刻也不必拼串。
>
> 拼串仍然存在，但只在**主进程内部拼一次**（`joinCacheKey`），
> 作为缓存键用；渲染层不再产生它。

**`searchSongFiltered` 的补齐与降级（★ 五轮）**：

| 轮次 | 搜索词 | 分区（`tids`） | 说明 |
| :--- | :--- | :--- | :--- |
| 1 | `歌名 歌曲 歌手` | **全站**（`''`） | 不限制分区，拿到基础候选 |
| 2 | `歌名 歌曲 歌手` | **音乐区**（`3`） | **同一句话换个分区再搜一轮** |
| 3 | `歌名 歌曲 歌手 MV` | 音乐区 | 加后缀 |
| 4 | `歌名 歌曲 歌手 <括号内容>` | 音乐区 | 没括号时退回 `歌名 歌曲 歌手 可视化` |
| 5 | `歌名 歌曲` | 音乐区 | **去掉歌手名**，救「B 站没有这个歌手的版本」 |

**形态约定**：**不带引号、不带书名号**，纯空格分隔（用户明确要求）。
用空格就是普通的「与」语义。歌名后面缀一个**独立词** `歌曲`；
歌手名里的括号换成空格（`甲（乙）` → `甲 乙`）。

> ⚠️ **不要用 `-`**：B站搜索把 `-` 当**排除语法**
> （"A -B" = 搜 A 并排除含 B 的结果），写成 `歌名 - 歌手` 会变成
> 「搜歌、**排除**这个歌手」，正好和意图相反。

**为什么第 1、2 轮搜同一句话、只换分区**：音乐区（`tids=3`）里是
「正经 MV / 官方投稿」，但**翻唱、饭制、动态歌词排版**这类常发在别的区
（生活 / 鬼畜 / 影视）。只搜音乐区会漏掉它们，只搜全站又容易被无关视频淹没 ——
所以**各搜一轮，取并集**。

> 实测数据（`歌颂-梦然`）：第 1 轮全站 82 条、第 2 轮音乐区 81 条，
> 两轮**净新增 71 条**，几乎不重叠 —— 证明这个设计是有效的。

**★ 第 4 轮为什么用「括号里的内容」**：括号里往往是**副标题**
（`九重楼 (不敢独上九重楼)` → `不敢独上九重楼`）或版本说明（`(Live)`）。
拿它当独立关键词搜一次，能捞到标题里**只写副标题、不写正名**的视频。
没有括号时退回 `可视化`（覆盖「动态歌词排版 / 可视化」这类标题）。

> **多段括号**：全部**拼接**进去（用户明确要求），但**同一段只留一次**：
>
> ```
> Going Home (回家) (萨克斯版)              →  回家 萨克斯版
> Going Home (回家) (萨克斯版) (萨克斯版)   →  回家 萨克斯版   ← 重复的去重
> ```
>
> 去重是必要的：歌单里出现过「同一个后缀写两遍」的数据，不去重搜索词会变成
> `… 回家 萨克斯版 萨克斯版`，重复词不增加信息量、却让搜索词变长变怪
> （搜索词越长 B站越可能匹配不到）。
>
> ⚠️ 早期版本只取**第一段**，于是 `(回家) (萨克斯版)` 的第 4 轮只搜 `回家`，
> 丢掉了「萨克斯版」这个有效信息 —— 所以改成全拼。

> ⚠️ 判重必须用**「搜索词 + 分区」的组合键**（`usedKeys` 里的 `${kw}@${tids}`）：
> 第 1、2 轮**搜索词完全相同**，只有分区不同。只比搜索词的话第 2 轮会被当成
> 「重复」直接跳过 —— 那整个「全站 + 音乐区各搜一轮」的设计就白做了。

**★ 每轮只搜第 1 页（**不再翻页**）**：

```
每一轮：只搜第 1 页（B站一页 42 条）
        → 过滤后 < minSearchResults（默认 30）→ 换下一轮
        （minResults = 0 时不降级，只搜第 1 轮）
```

> **翻页为什么去掉**：一首歌要跑 4 轮，每轮再翻页就是最多 8 个请求；
> 再加上原来渲染层的 3 次重试，最坏能打出二十多个请求 ——
> 这正是 B站返回 **412 风控**的主因（见下面「风控」一节）。
> 五轮降级本来就覆盖了「换词再找」的需求，翻页的边际收益不值得。
>
> 连带去掉的：`searchRounds` 原来那个「够不够、要不要翻第二页」的判断
> 以及它需要的 `relax` 参数 —— 函数现在只剩「搜一次 + 提取」两件事。

**降级是「累加合并」，不是「替换」** —— 每一轮结果按 `bvid` 去重后**追加**到结果池。

> 用户原话：「降级的意思是降级搜索，**不是要把之前的结果不要啊**」。
> 原实现是「哪一轮过滤后更多就用哪一轮」，于是第 1 轮的 10 条会被降级轮的
> 36 条**整个顶掉**（`10 + 36` 去重后 ≈ 46 条才是应有的结果）。
>
> 去重是必须的（各轮结果**一定会重合**），同一 bvid 只留**第一次出现**的 ——
> 那批来自更靠前的轮次，元数据（带 `<em>` 高亮的标题）更贴合。

**★★ 风控（412）—— 三层防护**

B站对搜索请求的密度很敏感。**实测**（同一个 IP、前后两个请求）：一个正常返回
`200`，下一个直接 `412`（响应体是一整页 HTML 拦截页，不是 JSON）。
流量密度就是触发条件。

```
① 请求**节流 500ms**（throttleSearch）
     每次发请求前，距上次不足 500ms 就等够再走 —— 模块级时间戳，
     所以「第一轮 4 个请求」自然被拉开成 ~1.5 秒。

② 第 1 轮返回 0 条 → 认定**被风控**，立刻停手
     判据很硬：**B站搜索不会对一首正常存在的歌返回「0 条」**。
     所以「第 1 轮就空」几乎只有被拦这一种解释 → 抛 `RateLimitError`，
     **不再往下跑第 2/3/4 轮**（风控状态下每轮都会被打回，连打只会更久）。

③ 降级轮中途遇到 412 → **整轮中止**
     降级循环的 catch 里判 `isRateLimitError(err)` → 直接 `throw`；
     只有其它错误（网络抖动）才当「这一轮没成」继续。

④（渲染层）**不做重试**
     原来空结果会重试 3 次，每次又走完整 4 轮 —— 那是灾难性的叠加。
     现在没有重试，由主进程把 `RateLimitError` 抛上来，界面给一句
     「切歌太快太频繁，等一两分钟再试」。
     （用户原话：「B站不会返回空结果的」—— 所以空就是风控，重试没意义。）
```

**`searchSong` 因此变成「单次尝试，失败就抛」**：没有 `retryCount` 参数、
没有递归重试。真正的重试只发生在渲染层点「刷新」时（用户主动）。

**★ 请求期间禁用会发请求的控件（防止用户连点）**

请求在飞时（`SearchApp.netBusy`），下面这些**点不动**：

| 控件 | 为什么 |
| :--- | :--- |
| **上一首 / 下一首** | 切歌 = 重新搜索 + 解析地址（两个请求）；连点就是请求成倍叠加 |
| **托盘菜单的上一首 / 下一首** | 同一件事，托盘也走 `prev()` / `next()` |
| **系统媒体键的上一首 / 下一首** | 同上（`MediaSession` handler）|
| **清晰度 / 音质下拉** | 切换会 `playCandidate()` 重新解析；**而且改完还有 3 秒冷却** |

**不禁用**（它们是**本地功能**，请求期间照常可用）：播放 / 暂停、音量、
进度、静音、两个列表开关、循环模式。

> **守卫放在哪**：`prev()` / `next()` **函数内部**（不是每个调用点）——
> 会调它们的有控制栏、托盘、媒体键、将来的快捷键，逐个补漏迟早会漏。
> 模板里那句 `@click="busy ? null : ..."` 只负责给用户「点不动」的**视觉反馈**
> （灰掉 + `not-allowed`），不承担拦截职责。
>
> **为什么要给提示**：拦截了却在界面上毫无反应，用户会以为按钮坏了。
> 所以 `notifyNetBusy()` 弹一句 `$message`（「正在加载中，请稍候……」
> + 一句「切太快会被 B 站限流」），**2 秒节流**（连点不刷屏）；
> 控制栏那两个按钮还带 `title`（悬停也能看到原因）。

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

> ⚠️ `relaxed` 只要**搜过降级轮**就置位（哪怕那一轮的新增为 0）：判据是
> 「池子里有没有来自降级轮的条目」，而不是「这一轮有没有新增」。
> 降级轮的结果是用**放宽上限**搜回来的，最终过滤就必须跟着放宽，
> 否则那些条目会被「用严格上限」重新挡掉。
> 至于「还要不要继续降级」由循环开头的 `countPassing` 决定，与它无关。

**渲染层：搜索为空时**没有重试**（已删）**

原来空结果会重试 3 次（每次 `skipCache`、间隔 800ms）。现在**全部删掉**：

- 用户原话：「别搞什么重试了，搜索结果为空就提醒用户不要切歌太频繁，
  B站不会返回空结果的」—— 所以「空」本身就是**被限流**的信号，
  重试只是在风控状态下继续打请求（每次重试又走完整 4 轮，最坏二十多个请求）；
- 主进程会直接抛 `RateLimitError`，渲染层 `catch` 里按消息内容识别
  （IPC 会把 `Error` 序列化，丢掉 `name` / 原型，所以只能按文案判），
  弹一句「切歌太快太频繁，B 站把请求拦下来了，过一两分钟再试」。

**两种「没结果」的提示是分开的**（解决办法完全不同）：

| 情况 | 提示 | 用户该做什么 |
| :--- | :--- | :--- |
| `filtered: true` | 「结果都被过滤规则挡掉了」| 去设置放宽规则（过滤词 / 时长容差）|
| 被限流 | 「被 B 站限流了，切歌太快」| **等一两分钟**，别连续切歌 |
| 其它搜索失败 | 「搜索失败」+ 原始错误 | 检查网络 / 登录 |

用 `$notify`（右上角浮层）而不是 `$message`：这些提示**带操作指引**，要留时间读。


## 3. 搜索结果排序（硬过滤 + 打分）

**位置**：`electron/common/utils/videoRank.ts`（主/渲染共用，纯函数）。

**一句话逻辑**：**标题里歌名必须独立出现、时长必须对得上；
歌手名命中给 +100 的断层分，之后用关键词微调。**

**① 硬过滤**（三条，任一命中直接丢）

| 规则 | 说明 |
| :--- | :--- |
| **歌名没独立出现** | 见下面「歌名怎么算命中」—— 这是本文件改动最大的地方 |
| 时长超出容差 | 下限 `max(时长−容差, 时长×0.3)`、上限 `时长+容差`。标题含 `MV/官方/Live/现场` 时上限放宽 **×1.7**。**歌曲时长未知、或视频时长取不到 → 不过滤**（不因缺数据误杀） |
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
| :--- | :--- |
| **形式词豁免**（`TRAILING_FORM_WORDS`：歌词排版 / 字幕 / 伴奏 / 完整版 / mv / live…） | 歌名右边紧跟这些词时**算独立** —— 它们说的是「这个视频是什么形式」，不是歌名的一部分。<br>`刘惜君 - 聊表心意歌词排版透明通道` 该**留**；而 `童话镇` 里的「镇」不在表里，照样**丢** |
| **在保留空格的原串上判边界**（`flattenWithMap` 记「去空格后索引 → 原串下标」的映射） | 比对要去空格（`Shape of You` ↔ `shapeofyou`），但判边界必须回**原串**。<br>踩过：先 `normalize`（去空格）再判边界，于是「童话 光良」变成「童话光良」、右邻成了「光」→ **被误杀**（其实中间明明有空格） |
| **`丨` `・` `｜` 当分隔符**（`SEPARATOR_CHARS`） | 它们在标题里的实际作用等于竖线，但码位落在汉字区，不特判会被当成汉字 |
| **★ 简繁归一**（`toSimplified`，opencc `tw→cn`） | 否则「旧」会把 `不夠 - 舊『…』`（**正是用户要的那首**，只是繁体）也杀掉 —— **简繁不同不是"另一首歌"** |

**已知代价**（字符串规则解决不了）：`光良童话KTV纯享版`（同曲不同歌手、无分隔符）
会被判丢 —— 它与「童话镇」在**字符层面完全同构**（歌名后紧邻汉字）。
这是「宁可漏掉也不能放错」的必然取舍。

**`splitSongName` / `baseSongName`：歌名怎么拆**

歌单里的歌名经常夹着括号说明，甚至括号后面还跟着合作信息：

```
溯(Reverse)feat.马吟吟     ← 真正的歌名只有「溯」
九重楼 (不敢独上九重楼)      ← 副标题
起风了 (Live)             ← 版本说明
```

所以 `splitSongName` 把歌名拆成**两半**，各有用处：

| 字段 | 内容 | 谁用 |
| :--- | :--- | :--- |
| `name` | **第一个括号之前**的全部内容 | 第 1~3 轮搜索词 + 硬过滤判据（`baseSongName` 就是取它） |
| `tail` | **第一个括号及其之后**的全部内容（括号符号去掉、重复词去掉）| 第 4 轮搜索词 |

```
溯(Reverse)feat.马吟吟      → { name: '溯',        tail: 'Reverse feat.马吟吟' }
九重楼 (不敢独上九重楼)       → { name: '九重楼',    tail: '不敢独上九重楼' }
起风了 (Live)               → { name: '起风了',    tail: 'Live' }
Going Home (回家) (萨克斯版)  → { name: 'Going Home', tail: '回家 萨克斯版' }
晴天                        → { name: '晴天',      tail: '' }
```

**两条特殊规则**：

1. **括号在最前面**（`(Intro)` / `【伴奏】晴天`）：`name` 退回用**括号里的内容**
   （否则歌名空着就没法搜）。
2. ★ **`tail` 没有新信息时置空**：规则 1 生效时 `name` 本来就是由 `tail` 撑起来的，
   再拿它去搜等于把第 1 轮的词原样发一次 —— 纯浪费一次请求：

   ```
   (Intro)     → tail='Intro'      ← 和 name 一样，置空
   【伴奏】晴天  → tail='伴奏 晴天'   ← 同上，置空
   ```

   判定用**词集包含**（`isCoveredBy`），词序不同也算重复。
   置空后第 4 轮退回 `可视化` 兜底（和「没有括号」一致）。

> ⚠️ **搜索、过滤必须用同一个歌名**（都走 `baseSongName`）——
> 否则「搜的是 A、过滤却要求标题含 B」，会一条都过不了（踩过：
> 140 条候选全被挡）。

> **代价**：`(Don't) Stop` 这类「括号属于歌名本身」的会变成 `Stop` 去匹配。
> 这是为了救「括号里是副标题/合作信息」那一大类而付的代价（后者更常见）。

**★ 带空格的歌名：整串匹配不上就按词分别匹配**

`name` 可能是多词串 —— 最典型的来自上面「括号在最前面」那条：
`【伴奏】晴天` → `伴奏 晴天`。而 `normalize` 会去掉空格变成 `伴奏晴天`，
要求标题里**连着**出现这 5 个字。实际标题是「伴奏 - 晴天」或「晴天（伴奏）」，
**连不起来，必然全被挡**。

所以 `passHardFilter` 里：

```
① 先试整串（`伴奏晴天`）—— 普通歌名走这条，行为与以前完全一致
② 不中，且歌名是多词 → 拆词分别判，每个词都要独立出现才算通过
```

| 歌名 | 标题 | 结果 |
| :--- | :--- | :--- |
| `伴奏 晴天` | `晴天 - 伴奏版` | ✅ 通过 |
| `伴奏 晴天` | `伴奏 晴天` | ✅ 通过 |
| `伴奏 晴天` | `晴天` | ❌ 挡（缺「伴奏」）|
| `晴天`（单词）| `晴天镇` | ❌ 挡（**行为不变**，紧邻汉字照样挡）|

比整串连着出现宽松（容纳分隔符 / 调换顺序），又比「只匹配一个词」严格。

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
>
> ```
> 初始:               D1, D2
> 回写过滤后的列表后:  D1          ← D2 从库里消失了
> ```
>
> 后果：用户把容差从 30 调回 90（或删掉一个过滤词）想找回那些结果时，
> **它们已经不在库里了**，必须重新联网搜索才回得来。

缓存路径**一律放宽时长上限**：缓存里存的是已经取回来的结果，
而它当初是用哪一档容差、有没有走降级轮取的 —— 这里无从得知（那份信息没落库）。
用严格上限重过滤可能把合法结果**藏起来**（用户看到「我什么都没改，列表怎么少了」），
所以**宁可多留，不可误藏**。歌名 / 屏蔽词那两条照常严格。

## 4. 播放地址解析（dash / durl 两条路）

**入口**：`playCandidate(bvid, opts)` → `electronApi.resolveVideoUrl(bvid, keyword, …)`
→ `ipc/biliApiHandlers.ts` 的 `api:resolveVideo`。
（`keyword` 只有音乐传，视频条目传空串 —— 见 `player/engine.ts` 的 `resolveVideoItem`。）

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

**★ 切换清晰度 / 音质**：`stores/playback.ts` 的 `switchQuality` →
`playCandidate(bvid, { qn })` —— **不传 `skipCache`**（这里改过一次）。

```
switchQuality(新档位)
  → 记下 selectedQn / selectedAudioId
  → 启动 3 秒冷却（那两个角标期间点不动，防连点）
  → playCandidate(bvid, { qn })（**不传 skipCache**）
        ↓
      api:resolveVideo 的判定链：
        地址有效 且 缓存里有目标档位 → extractDashStreams(缓存的 playurl, 新qn)
                                       ↑ **从同一份 playurl 里按新档位重新挑一条流，不联网**
        地址**已过期**               → resolvedFresh = true → 联网重新解析
        缓存里没有那个档位            → needDashUpgrade → 联网重新解析
        登录态变了（解锁更高档）        → loginChanged → 联网重新解析
```

> ⚠️ 原来传的是 `skipCache: true`（「我改了清晰度，快重新取」）—— 那是**多余**的：
> B站一条 dash 流里**本来就带全部候选档位**，我们库里存的 `playurl_result` 是
> **整个 playurl 响应**，所以换档位只需从同一份响应里重新挑一条流。
> `skipCache` 会把「地址明明还没过期」这条快路径也一起废掉，白打一次请求 ——
> 而每一次多余的请求都在推高被 412 的概率。

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

**位置**：`stores/playback.ts` 的 `warmApi` / `maybeWarm` + `_warm` 系列状态。

**能「几乎无感」是四层叠加**：

1. **本地信息先切**（引擎在发请求前调 `onSwitch()`，store 先切 `currentIndex` / `currentKey`）
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

**`warmApi` 的挑选规则必须与 `resolveSongItem` 逐字一致**（也必须问 `getSelectedBvid`），
否则预热好的地址切歌时会被换掉。

## 7. 收藏与「添加视频」

**收藏**：`api:setFavorite` → `cache.setFavorite`。

- **收藏**：**其余所有条目的 `ord` 各 +1、自己占住 0**（**同一事务** ——
  中间态被读到会出现两个 `ord = 0`，排序结果不确定）
- **取消收藏**：只把 `favorites` 置 0、**位置不动**
- **返回完整列表**：顺序由主进程的 `ord` 决定，只有主进程知道权威结果；
  返回 void 的话渲染层只能自己猜「现在排第几」，迟早和库里不一致

> ⚠️ 「库里**没有**这一行」时（「添加视频」的场景）走的也是**同一套置顶动作**，
> 不分叉 —— 详见第 13 节「收藏的 `ord` 语义」。
> 曾经那里插到 `maxOrd + 1`（末尾），于是「添加」进来的条目
> **界面上在第一、库里在最后**，任何按 `ord` 重取列表的地方都会把它甩到末尾。

**「添加视频」复用 `setFavorite`**：
「添加的语义就是这首歌多一个我一定要用的候选，也就是收藏」——
主进程会补插行 + 挪到第一位，不需要另写一套。

**收藏前要回源补齐元数据**：粘贴的 BV 号很可能**不在**搜索结果里，
`setFavorite` 会补插一行但那时标题/封面是空的，
不写进去下次刷新列表就成了一条只有 BV 号的空壳。
（这一步走 `upsertVideoMeta`：先插一行 `favorites = 0`、`ord` 排末尾，
紧接着 `setFavorite` 把它置顶。一个函数只做一件事 ——
`upsertVideoMeta` 也用于「更新已存在行的信息」，那时完全不该动顺序。）

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
  ④ playCandidate(bvid)
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
③ setAspectRatio(0)                ← 比例约束会改写几何，壁纸要的是盖满
   isMinimized() → restore()       ← 最小化的窗口挂上去画不出来
④ 先置 wallpaperAttached = true    ← 宁可多摘一次，不能漏摘
⑤ attachWallpaper()                ← SetParent + 回读验证（此时窗口还是小尺寸）
     失败 → rollbackWallpaperAttach()（必含 detach）
     成功 → ⑥
⑥ fitWallpaperWindow()             ← 原生 SetWindowPos 撑满桌面层客户区
⑦ setSkipTaskbar(true) + isFullScreen = true
   窗口不可见（从托盘进来的）→ showInactive()
⑧ startWallpaperFitGuard()         ← 每秒贴合、每 5 秒校验父窗口
```

**退出**：`hide()` → `detachWallpaper()` → `resetWallpaper()` →
**确认成功才清 `wallpaperAttached`** → `await 80ms` → 还原几何 → `show()`。

**★ 退出还原时必须先写回「最大化前尺寸」**：壁纸里用原生 `SetWindowPos` 撑满，
Windows 会把那次尺寸记进窗口的**还原尺寸**（`rcNormalPosition`）。不写回去的话，
退出后拖离最大化 / 点还原按钮都会回到**整屏大小** —— 表现为「还原不了原尺寸」
和「拖不动」（窗口一直是满屏，移动看不出位移）。`exitWallpaperGeometry` 的做法是
`unmaximize() → setBounds(还原点) → maximize()`（全在 `hide()` 状态下做，无视觉影响）。

还原点本身也要体检：`sanitizeRestoreBounds` 在「最大化时的 normalBounds ≥ 整块工作区」
时判定为被写坏，改用工作区 80%（否则老状态会一直传染下去）。`startWindowDrag`
的最大化分支有同样的兜底，保证「拖离最大化」永远有可感知的结果。

**★ 「拖离最大化」必须用原生 `ShowWindow(SW_RESTORE)`**：`unmaximize()` 在
**左键按着**的时候是空操作（返回成功但不生效，松手也不补），而拖动恰好发生在
左键按着的状态下 —— 窗口留在最大化，后面每帧 `setPosition` 全被系统忽略，
用户看到的就是「最大化之后拖不动」。改用 `winShowState.restoreFromMaximized()`
（原生 + `IsZoomed` 校验），拿不到 `restored: true` 就直接返回 `null`，
不让错误的偏移量把窗口甩飞。详见 `winShowState.ts` 顶部那张实测对照表。

**应用退出（含定时关闭 / 关机）也必须走「先隐藏再摘」**：`app.on('before-quit')` 里
先 `hide()` + `setAlwaysOnTop(false)` 再 `detachWallpaper()`。`detach` 的瞬间窗口就
变回顶层窗口，而壁纸模式里它是整屏、还可能带着进壁纸前留下的 `alwaysOnTop` ——
那一下会**闪在最前面**（打全屏游戏时会直接把游戏挤出独占全屏）。同理，进入壁纸时
也要 `setAlwaysOnTop(false)`，让任何摘层路径都不会出现「一帧置顶整屏窗口」。

**为什么「先挂载再撑满」「先隐藏再摘下」**：

- 旧顺序是「先 `setBounds` 铺满 + 置顶，等 120ms，再 `SetParent`」——
  那 120ms 里窗口是个盖住任务栏和桌面图标的普通窗口，就是**进入时闪一下全屏**。
  现在窗口以小尺寸沉到图标层后面（视觉上等于原地消失），再在壁纸层里撑满，
  全程被图标层挡着。
- 退出时反过来：`detach` 之后窗口立刻变回顶层窗口，若此时还是整屏尺寸，
  会再闪一次。隐藏状态下做完再 `show`，只剩「小窗口出现」这一帧。

**为什么壁纸几何不用 `setBounds`**：窗口挂到 WorkerW 之后坐标系是**父客户区**，
而 Electron 仍按「屏幕坐标」理解 bounds。任务栏 / 分辨率 / 缩放一变，两边就对不上，
多出来的那块露宿主层底色 —— 就是「一圈白边、盖不住任务栏」。
`fitWallpaperWindow` 用 `GetClientRect(父)` + `SetWindowPos` 走单一坐标系，幂等。

**为什么串行 + 合并**：连点（标题栏按钮 + 托盘项）或与「开机即壁纸」的启动
apply 相撞时，两次 apply 会交错 —— 先进壁纸那次在 attach 前后被退出那次抢跑，
最后 `wallpaperEnabled = false` 但窗口真的挂在桌面层、任务栏按钮也没了，
**状态与实际长期漂移**。

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
而歌单管理·视频管理/定时/壁纸/退出登录/退出程序是一次性跳转或命令，执行完就该收起。

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
新增的两个设置项都是**标量**（布尔 / 数字），`{...defaultSetting}` 浅拷贝即可，不用额外处理。

### 两类「设置改了要立刻做点什么」的键

大部分设置项是**读的时候才用**（比如清晰度上限），所以只需要存下来。
但有两个**必须在改动的当下就执行动作**，否则用户会以为没生效 ——
它们都在 `electron/main/index.ts` 的 `onSettingChange` 里处理：

| 设置项 | 改动的当下要做什么 | 不做的后果 |
| :--- | :--- | :--- |
| `cache.searchResultExpireMs` | 立刻跑一次 `clearExpiredPlayurl(maxAge)` | 把 365 天改成 0 天，**看不到任何变化**（既没地址被清、也没日志） |
| `common.windowAspectRatio` | 立刻 `applyAspectRatio()` | 要重启才看到新比例（全屏 / 壁纸模式下跳过，那两种状态另有几何管理） |
| `common.autoLaunch` | 立刻 `applyAutoLaunch()`（写系统启动项） | 打开开关后要等下次重启才生效 |

> `common.wallpaperMode` 是**反例**：它**故意什么都不做** —— 它是「下次开机进不进壁纸」的开关，
> 不该在打开/关闭的瞬间改变当前状态（用户明确要求）。当前状态只由按钮/托盘切换。

### 本轮新增的设置项

| 设置项 | 存什么 | 落到哪 | 要点 |
| :--- | :--- | :--- | :--- |
| `common.idleOpacity`（控制栏闲置透明度） | **百分比 0-100**（步进 **10**） | `src/utils/uiTheme.ts` → `--ui-idle-opacity`（**除 100**，`opacity` 收小数） | 只管**闲置态**；悬停时 CSS 写死 `opacity: 1`（`VideoControls.vue`）。与 `glassTransparency` 是两回事：那个管玻璃**底色**、悬停前后都一样 |
| `common.autoLaunch`（开机自动启动） | 布尔，默认 `false` | 系统启动项（`app.setLoginItemSettings`） | **不落 CSS**；每次启动重写一遍（便携版挪位置后能自动纠正）；开发模式强制关 |
| `player.autoDowngradeOnStall`（卡顿自动降低清晰度） | 布尔，默认 `false` | **不落 CSS**，只在 `App.vue` 的 `recoverFromStall` 里读 | **只管「降清晰度」那一步**；换备用源 / 降 durl 始终自动做。关着时提示「建议降到 XXX」而不是硬降 |

## 12. 定时暂停 / 定时关闭

**位置**：`src/utils/sleepTimer.ts`（逻辑）+ `src/components/SleepTimerPanel.vue`（弹窗）
+ `App.vue`（接线）。主进程只提供 `win:quit`。

**数据流**：

```
标题栏「定时」按钮 → sleepPanelVisible = true
        ↓
弹窗里编辑【本地草稿】：draftHours / draftMinutes / draftOptions
        ↓ 点「确认 / 更新定时」
player.applySleepTimer({ hours, minutes, options })
        ↓
  ├─ settingStore.update(三个 settings 键)     ← 记住，下次打开直接显示
  └─ sleepTimer.start(h, m, options)          ← 启动倒计时
        ↓
每秒 tick()：判定 冻结 / 恢复 / 归零 / 等视频
        ↓ 命中执行条件
handlers.fired()  → 关弹窗
handlers.quit()   → electronApi.winQuit()    ← 勾了「关闭程序」
  或 handlers.stop() → video.pause()           ← 没勾
```

**为什么计时器在渲染层**：见 ARCHITECTURE 同名章节 —— 两个判定条件
（`currentTime` / `paused`）只有渲染层拿得到。

**★ 「等视频播完」必须给「视频停着不走」留出路**（踩过）：

等待的实现是「每秒看一次 `currentTime` 是否落在 0-3 秒窗口」。
而视频**暂停**时 `currentTime` 永远不动 —— 于是这个等待**永远不会结束**：
面板一直显示「计时已结束，等待视频播放完毕…」，除了点「取消定时」没有任何出路，
用户会以为定时器坏了。

```
勾了「等视频播放完毕」但没勾「暂停时暂停倒计时」
到点那一刻视频正好是暂停的（手动暂停 / 元素被 pause() 停在中段）
→ pending 永远等不到（currentTime 不动）
```

所以 `pending` 分支里加一条：**`!video || video.paused` 时直接执行**。
判据用 `paused` 而不是「这一秒没动」—— 后者可能只是缓冲 / 卡顿，等一会儿会恢复；
`paused` 才是明确的「不会再往下播了」。没有视频元素时同理（没有任何东西会「播完」）。

**★ 面板是「草稿模式」，定时器那边没有 `setOptions()`**：

编辑时只改本地 `draftXxx`，**点「确认 / 更新定时」才 `player.applySleepTimer(...)` 写一次**。
定时器上曾经有个 `setOptions()`（实时同步选项）但**从未被调用**，已删 ——
留着它的注释会让人以为选项是实时生效的。

> 为什么改成草稿：编辑时若立刻上报 → 触发定时器 `emit()` → 那一刻定时还没启动，
> 之前按 `active` 判断就会「点一下加号弹窗就关了」。

**`0 时 0 分` 时未定时的「确认」按钮是禁用的**：否则会走到
`applySleepTimer` 弹 warning 并 return，而面板的 `confirm()` 紧接着自己关掉弹窗 ——
用户看到「警告一闪 + 面板关了 + 什么也没设定」。
> 注意**定时中**不禁用：那时 0/0 是「取消定时」的语义（`apply` 走取消分支），
> 不是错误输入。

**三个设置项**：

| 键 | 作用 |
| :--- | :--- |
| `common.sleepTimerHours` / `common.sleepTimerMinutes` | 上次设的时长（打开面板时初始化草稿） |
| `common.sleepTimerOptions` | 三个复选框的上次选择（对象，一起读写） |

> 三个选项存一个对象而不是三个布尔字段：它们**总是一起读写**，
> 以后加第四个选项不用再动 schema。

**`win:quit` 为什么单独加**：`winClose` 走窗口 `close` 事件，
`common.closeToTray` 打开时会被拦成「隐藏到托盘」—— 用它做定时关闭会关不掉。
`win:quit` 直接 `app.quit()`，`before-quit` 会把 `isQuitting` 置位，拦截逻辑自动放行。

## 13. 缓存与过期

**位置**：`utils/cache.ts` + `utils/db.ts`。

**★ `search_key` 存的是「歌名-歌手」，不是 `songs.id`**（这点容易搞混）：

| 表 | 键 | 值 | 为什么 |
| :--- | :--- | :--- | :--- |
| `videos` / `song_meta` | `search_key` | `歌名-歌手` | 这两张表要拿键**去搜 B站** —— 用 `tx_1828354` 那种 id 搜不出任何东西 |
| `songs` / `playlist_songs` | `id` / `song_id` | `平台_平台id` | 只用于「标识同一首歌」，让多歌单共用一行 |

它们**没有关系**，各用各的键。渲染层传的 `songName`（`getSongName`）就是前者。

**过期语义（重要）**：只有**播放地址那一批列**会过期
（`durl_url` / `dash_video` / `dash_audio` / `dash_duration` / `playurl_at`），
标题 / 封面 / 收藏 / 顺序 / 时长**永不过期**，所以清理**只把这些列置 NULL、绝不删行**。

**★ 读缓存时不过滤**：`videos` 里存的就是**搜索时已经过滤并排好序**的那份
（`save` 收到的 `finalList`，`ord` = 数组下标）。`cacheManager.get` 内部
`ORDER BY ord ASC` 取出来就是最终顺序，所以读路径**原样返回**，不再调 `rankVideos`。

> 详细理由（以及为什么"读时重过滤以让设置立刻生效"是错的）见上面第 2 节里
> 那个「缓存命中不做任何过滤/排序」的说明。
>
> ⚠️ 顺带一个必须知道的副作用：改了过滤设置后，**已搜过的歌仍是旧结果**，
> 要点列表的**刷新**按钮才会用新规则重搜。

**★ 收藏的 `ord` 语义**（收藏/取消/添加视频都走这里）：
`setFavorite` 的动作是**「其余所有条目 `ord` +1，自己占住 0」**，不分
「库里有没有这一行」：

| 操作 | 行为 |
| :--- | :--- |
| 收藏**已有行** | `ord` 置 0，原来排在它前面的各 +1 |
| 收藏**库里没有的**（「添加视频」）| 先在元数据那步插一行，随后同样**置顶**（其余 +1、自己 0）|
| 取消收藏 | **只把 `favorites` 置 0，位置不动**（不跳回搜索结果中间）|

> 这样 `ord` 恒为 **0..n-1 连续**。
> ⚠️ 曾经用过「取当前最小值 − 1」：`ord` 会变负数且不连续
> （来回收藏几十次就到 −50），而且 `save()` 按数组下标从 0 重写，
> 那些负数**活不过一次重新搜索**。
>
> ⚠️ 「库里没有这一行」时**不能**插到 `maxOrd + 1`（末尾）：那会让
> 「添加视频」加进来的条目**界面上在第一、库里在最后** ——
> 任何按 `ord` 重取列表的地方都会把它甩到末尾。
>
> 整个函数体在 `tx()` 事务里：中途进程被杀会整体回滚，
> **不会**留下「其他都 +1 了、自己还没置 0」的中间态（那会出现两个 `ord = 0`）。

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

## 14. 打包与代码保护

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

**运行时**：主进程注册 `blwe://` 协议，页面请求哪个资源就解密哪个，只解密到内存；
页面地址从 `file://` 变成 `blwe://app/index.html`。

**为什么 `protect` 必须先检查 `out/` 是不是干净明文（踩出来的）**：
保护是**就地改写**，所以它既不能在已经保护过的产物上再跑一遍，
也不能在**混合态**上跑。混合态是这么来的：`out/renderer` 还留着上一轮的密文，
而 main 被重新构建成明文 —— 这时候启动应用，明文主进程没有解密协议，
直接把密文当 HTML 加载，**用户看到满屏乱码**（真发生过）。

**验收方式**（改这块照这个来）：

1. `npm run build:protected` 后做**字节级**检查
   （密文头 `BLWE1` + `.jsc` 存在 + 加载器只有几百字节）
2. 用 `BLWE_FORCE_PROTECT=1` 跑开发态验证：
   页面 URL 是 `blwe://app/`、DOM 完整、`electronAPI` 可用、能搜到歌、能起播 ——
   **并且要断言音频真解码**（只看 `duration` 会漏掉 CORS 问题）
3. `npx electron-builder --dir` 后用 `@electron/asar` 抽文件看头是不是 `BLWE1`
4. 直接启动 `release/win-unpacked/BLWE.exe`，看窗口标题出不出来
   （标题来自渲染层，等于「解密 + 混淆后仍能跑」的端到端证明）

---

## 附：一张总览图

```
┌─────────────────────────── 渲染进程（src/） ───────────────────────────┐
│  App.vue（装配图：模板 + 挂载，无业务逻辑、无样式）                      │
│    ├── stores/      playback / queue / ui / window / system / session    │
│    │                sleep / drop（一域一 store）+ bootstrap 编排         │
│    ├── components/  直接读写 store（没有 props / emit，不另存业务状态）  │
│    ├── styles/      theme.css（令牌）+ global.css（骨架 / 弹窗覆盖）     │
│    ├── types/       app（AppData）+ playItem（PlayItem 联合）            │
│    └── utils/       playbackEngine / dashPlayer / uiTheme / title …      │
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
│    ├── winShowState.ts  原生还原（拖离最大化）                          │
│    └── protection.ts    blwe:// 解密协议                                │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   blwe.db（SQLite）      setting.json（原子写）    %APPDATA%/BiLiWallpaperEngine/
   8 表 + 2 视图           temp + rename            或便携版 exe 同级 blwedata/
                                                      （portable.ts 决定）
```

**两级 id 是数据的骨架**（都由主进程拼，渲染层只做透传）：

| 主键 | 形态 | 谁拼 | 用在哪 |
| :--- | :--- | :--- | :--- |
| `playlists.id` | `平台_平台歌单id`（`tx_8153225605`）；手动建的是 `pl_<uuid>` | `playlistKey()`（`ipc/music.ts`） | 歌单身份；重复导入命中同一行 |
| `songs.id` | `平台_平台歌曲id`（`tx_1828354`）；手动歌是 `歌名-歌手` | `songId()`（`writePlaylistsToDb`） | `playlist_songs.song_id`；同一首歌多歌单只占一行 |

**另一条数据纽带是 `search_key`**（`toCacheKey(song)` = `"歌名-歌手"`）：
它是 `song_videos` 复合主键的前半段、`song_meta` 的主键。
**只有音乐有这个概念** —— 视频条目按 `bvid` 直接解析地址，不进这两张表。

> ⚠️ **它跟上面两个 id 是两回事**：`song_videos` / `song_meta` 要拿键去**搜 B站**，
> 用 `tx_1828354` 那种 id 搜不出任何东西 —— 所以那两张表存的是**歌名**。
> 渲染层、缓存、`findSongDuration` 共用同一个 `toCacheKey`，
> 所以「这首歌是谁」的判定完全一致。
>
> ⚠️ 它**也不是搜索词**：真正发给 B站的是 `歌名 歌曲 歌手`（**剥过括号**、
> 歌手名的括号已换成空格，见 `buildPrimaryKeyword`）。歌名带括号时两者会不一致 ——
> 拿缓存键当搜索词看会完全误解。

---

## 15. B 站视频列表（导入 → 播放 → 续播）

音乐歌单是「歌名 → 搜索 → 候选」，视频列表是「条目本来就是视频」。
这条链路的关键是**播放层只写一遍**：队列统一成 `PlayItem`，引擎按
`isVideoItem()` 一处分派 —— 视频不搜索、不评分、不进候选表，直接按 bvid 解析地址。

### 导入

```
用户粘贴链接
  → api.parseListInput(text)            // 认类型 + id（收藏夹 / 合集 / 系列）
  → api.addVideoList({ kind, sourceId, mid })
  → biliApi.fetchBiliList(...)          // 分页 + 限速（380ms/页）、跳过 type=21/番剧、时长归一成秒
  → utils/videolist.addVideoList(...)   // 一个事务里写三张表：
        videolists 1 行
        videolist_items N 行
        videos N 行（只有元数据，**没有地址**）
  → videoListsStore.load() → 侧边栏出现这个列表
```

> 以前这里还要往 `song_videos` 写 N 行 `'bv:<bvid>'` 假关系（让播放借道「搜索」）。
> 那套已经删了 —— 视频条目只活在 `videolist_items` + `videos` 里。

**为什么不预取地址**：500 条 × dash ≈ 几十 MB + 500 次请求，必被风控；
而且大部分条目用户根本不会播。

### 播放

```
列表里点第 N 条
  → library.onVideoListPlay(id, N)
       setActiveVideoList(id)                 // store + 设置 player.activeVideoListId
       videoListsStore.items(id)              // VideoListItem[]（本来就带 bvid）
       this.songs = 它们；this.currentIndex = N
  → playCurrent() → playAt(N) → engine.playItem()
       isVideoItem(item) === true → resolveVideoItem()
  → api.resolveVideoUrl(bvid, '', ...)       // keyword 传空 = 「按 bvid 直接取地址」
  → 挂源：dash（MSE）或 durl
```

**视频这条路一次搜索都不发**。以前是 `getSongParts()` 返回 `{ song: 'bv:BV1xx…' }` →
`api:searchSong` 认出前缀后原样吐回那一条，于是「播一条已知 bvid 的视频」要先跑一趟
搜索接口，还白拿 `ord` / `favorites` / 高亮标题这些毫无意义的列。
删掉之后，`song_videos` 只剩音乐的真候选。

### 两个工作区（OV / MV）与「在看 ≠ 在播」

```
queue.mode = 播放源的投影（不是可写状态）
           = 在播视频列表 ? 'ov' : songs 有内容 ? 'mv' : 'ov'（空库默认 ov）
入口：管理弹窗左下角（歌单管理 ⇄ 视频管理）= openManager(page)
openManager = 打开该页管理器          // 不碰工作区，不换播放源
```

渲染层因此有**两份列表**：

| 字段 | 是什么 | 谁改它 |
| :--- | :--- | :--- |
| `songs` | **播放队列**（切歌/预热/续播全按它算） | 点列表条目、切歌、同步 |
| `browseSongs` | **列表面板在看的那份**（`ovSongs` 或当前歌单曲目） | `loadBrowseList()` |
| `browseVideoListId` | 视频管理页在看哪个列表 | 选中 / 导入 / 删除 |

- `browseIndex` 用 `keyOf(item)`（视频 = `bvid`、歌 = `歌名-歌手`）在 `browseSongs` 里找正在播的那一项，
  找不到就 `-1`（不高亮）。直接拿 `currentIndex` 会在「在看 A、在播 B」时点亮错行。
- 置顶（收藏 / 添加视频）会重排 `ord`：`refreshBrowseAfterEdit()` 重读后按 **bvid**
  把 `currentIndex` 修正回正在播的那条，并重建随机表与预热槽位。
- 空库：**不弹管理器**，只 `notify` 一行（点它才打开管理器）。

### OV 下的播放控制

- `next()` / `prev()` 结构不变，仍然环绕；只是文案变成「上一个视频 / 下一个视频」，
  且控制栏的「视频列表」按钮隐藏。
- **预热降级**：只提前解析地址，不建隐藏 MSE 会话拉流（`maybeWarm()` 里 OV 直接 return）。
- **失效刹车**：连续 `OV_MAX_AUTO_SKIP = 5` 条取不到地址就停止自动跳过并提示，
  计数在 `onVideoPlaying` 归零。理由是每条失效会触发两次解析，整片失效必踩 412。

### 续播

```
启动 init()
  → videoListsStore.load()
  → 读 player.activeVideoListId
       有且列表还在 → setActive(id)
       有但列表已被删 → 把设置清回 ''（否则 fromVideoList 永远为真）
  → tryResume()
       loadPlaybackSource()  // 视频列表 → videolists.last_index；音乐歌单 → playlists.last_index
       songs = 该来源的条目；index = lastIndex
       restoreSongVideo(index, resumeTime)   // 只有歌走这里（视频没有「上次播哪个」这个概念）
  → 续播失败 / 视频来源 → loadPlaylist()
       playCurrent(resumeTime) → playAt(currentIndex)
       ↑ 视频条目到这一步就够了：bvid 在条目里，直接解析地址即可
```

`recordPlayPosition()` 是唯一的写入口：按来源分别写 `videolists.last_index` /
`playlists.last_index`。写错表不会报错，只会「重启后回到第一条」。

### 重新同步（左上角刷新 / 列表弹窗里的同步）

```
syncVideoList(id)
  → 记住当前在播那条的 bvid
  → fetchBiliList 重新拉
  → 事务内：删旧 videolist_items → 重建 → 按 bvid 重定位 last_index
  → 被移出列表的 videos 实体不立刻删（可能被别的列表 / 歌曲候选引用）

```

### 踩过的坑（都写进代码注释了）

| 坑 | 现象 | 原因 |
| :--- | :--- | :--- |
| 用 `favorites = 1` 标记「唯一候选」 | 用户点一下爱心，条目就没了 | 取消收藏会把 `favorites` 置 0，清理逻辑顺手把它删掉 |
| 复用 `rankVideos` | 列表一条都放不出来 | 标题不含「歌名」、时长窗口 ±90s 会判死长视频 |
| `last_index` 按下标记 | 新收藏一条后，重启播的是上一条 | 收藏夹倒序，全体下标 +1，必须按 bvid 重定位 |
| 只删 `song_videos` 就删 `videos` | 另一个列表的地址缓存被连坐删掉 | `videos` 是全局共享的，必须 `gcOrphanVideos()` 同时看两张引用表 |
| `SongVideoListDialog` 只认 `title/pic/author` | 视频列表行标题空、封面兜底、UP 主空 | 面板里装的形状比类型还多一种（MV 的视频面板是裸 `BiliVideo`、OV 的是列表条目）→ 统一走 `fieldsOf()` 按字段兜底 |
| 切模式时清 `activeId` | 进度写到错的表、续播回到第一条 | `activeId` 是「在播哪个来源」，不是「在看哪个工作区」；浏览位置单独用 `browseVideoListId` |
| 拿 `currentIndex` 当列表高亮 | 在看 A、在播 B 时点亮错的那一行 | 两边的下标含义不同，必须按 `keyOf()`（`bvid` / `歌名-歌手`）在 `browseSongs` 里查 |
| 收藏 / 添加视频后不重定位 `currentIndex` | 点「下一个视频」跳到意料之外的一条 | 置顶会把 `ord` 归零、其余 +1，下标全体漂移 → 按 bvid 修正 |
| 失效条目无条件 `next()` | 整片失效时连环跳几十条，触发 412 | 每条失效要两次解析请求，必须加「连续 5 条就停」的刹车 |
