/**
 * AppSetting 全局类型声明
 *
 * 采用 LX Music 的「扁平 + 点号分隔」键名风格（如 'player.volume'），
 * 这样 mergeSetting 只需要做一层浅合并即可完成「默认值 + 用户值」的合并，
 * 并且能精确算出到底哪些 key 被改动了，便于向渲染进程精确广播。
 *
 * 该文件是纯类型声明，主进程与渲染进程都会引用，保证两边共用同一套类型。
 */

export interface AppSetting {
  /** 配置结构版本号，用于迁移判定 */
  version: string

  // #region common
  /** 是否以桌面壁纸模式启动（等价于命令行 --wallpaper-mode） */
  'common.wallpaperMode': boolean
  /**
   * 开机自动启动
   *
   * 用 Electron 的 `app.setLoginItemSettings()` 写进系统的启动项
   * （Windows 是注册表 `Run` 键 / 启动文件夹，不需要额外的原生依赖）。
   *
   * ⚠️ **便携版也能生效**：`setLoginItemSettings` 的 `path` 传的是
   * 当前 exe 的实际路径（`process.execPath`），所以绿色版放在哪就注册哪。
   * 但如果用户之后**挪动了那个文件夹**，注册项里还留着旧路径 ——
   * 那时开机启动会静默失败。所以打开这个开关时**每次都重写一遍**，
   * 而不是只在第一次写。
   */
  'common.autoLaunch': boolean
  /**
   * 定时暂停：上次设置的小时数（0-23）
   *
   * 打开定时面板时**直接显示这个值**（不是每次归零）—— 用户多半是重复设同一个时长。
   * 0 时 0 分 = 没有定时（面板里的输入框显示 00:00）。
   */
  'common.sleepTimerHours': number
  /** 定时暂停：上次设置的分钟数（0-59） */
  'common.sleepTimerMinutes': number
  /**
   * 定时暂停：三个复选框的状态（上次的选择，下次打开面板自动勾上）
   *
   * 三个选项是**叠加**关系，不是互斥：
   *  - `pauseCountdown`  —— 视频暂停时倒计时也暂停
   *  - `waitVideoEnd`    —— 等视频播完再执行（否则到点立刻执行）
   *  - `closeApp`        —— 执行动作是「关闭程序」（否则只是「停止播放」）
   *
   * 存在一个对象里而不是三个布尔字段：它们**总是一起读写**，
   * 而且以后要加第四个选项时不用再动一次 schema。
   */
  'common.sleepTimerOptions': {
    pauseCountdown: boolean
    waitVideoEnd: boolean
    closeApp: boolean
  }
  /** 点关闭按钮时不退出，最小化到系统托盘 */
  'common.closeToTray': boolean
  /** 在任务栏图标上显示当前视频播放进度 */
  'common.taskbarProgress': boolean
  /** 玻璃底色（hex）：控制栏、弹窗、歌单下拉的那层底 */
  'common.themeColor': string
  /** 浮层上的文字颜色（hex） */
  'common.fontColor': string
  /**
   * 透明度（0-100）
   *
   * 就是玻璃底色 `rgba(255, 255, 255, x)` 里的 x（百分比）：
   * 30 -> `rgba(255,255,255,0.3)`。
   * 控制栏、歌单按钮、设置 / 歌单管理弹窗、歌单下拉全用这一份。
   *
   * 别和浮层的淡出行为搞混：那是 `--ui-idle-opacity`（**设置项
   * `common.idleOpacity`**），管的是「鼠标不悬停时整个控件淡到多透明」。
   */
  'common.glassTransparency': number
  /**
   * 控制栏闲置透明度（0-100）
   *
   * 鼠标**不悬停**时整个控制栏的不透明度；移上去会变成完全不透明（1）。
   *
   * 为什么和「透明度」分开：
   *  - **透明度**（上面的 `glassTransparency`）管**玻璃底有多透**，
   *    是"底色"的属性，悬停前后都那样；
   *  - **这个**管**整个控件淡出到什么程度**，是"整块内容"的属性，
   *    鼠标移上去会恢复。
   *
   * 默认 10（= `0.1`），与改造前写死的 `--ui-idle-opacity: 0.1` 一致，
   * 所以老用户升级后观感不变。
   *
   * 设成 100 等于「不淡出」（控制栏一直实心）。
   */
  'common.idleOpacity': number
  /**
   * 模糊强度：`backdrop-filter: blur(Npx)` 的 N（0-20）
   *
   * 注意**存的是 px，界面上显示的是百分比**（5% 一档，100% = 20px）：
   * 50% -> 10px。0 = 不模糊（透出原始画面）。
   */
  'common.glassBlur': number
  /**
   * 阴影强度：文字阴影的模糊半径（0-20）
   *
   * 也是**存 px、界面显示百分比**（5% 一档，100% = 20px）：8px -> 40%。
   * 只管文字阴影（压在视频上的白字/黑字靠它看清），不是弹窗的投影。
   */
  'common.glassShadow': number
  /**
   * 窗口宽高比
   *
   * 值是一个「比例字符串」：
   *  - `'16:9'` / `'4:3'` / `'21:9'` … 预设或用户自己输入的比例，窗口锁定该比例；
   *  - `'free'` 表示**不限制**（用户可以任意拉伸，对应 `setAspectRatio(0)`）。
   *
   * 注意：**壁纸模式下这个设置不起作用** —— 壁纸要铺满整屏，
   * 进入时会强制 `setAspectRatio(0)`，退出时再按这个设置恢复。
   */
  'common.windowAspectRatio': string
  /**
   * 用户自己输入过的宽高比（`['21:9', '9:16']` 这种）
   *
   * 单独存一份是为了实现「输入的比例加到下拉列表里」：下拉框的内容 = 固定预设 + 这一份。
   * 这里只管存，解析统一走 `parseAspectRatio`（主进程、渲染层共用同一个函数）。
   */
  'common.customAspectRatios': string[]
  // #endregion

  // #region player
  /** 音量大小 0 - 100 */
  'player.volume': number
  /** 是否静音 */
  'player.isMute': boolean
  /** 切歌模式 */
  'player.loopMode': (typeof import('../constants').PLAY_LOOP_MODES)[number]
  /** 记住播放进度：启动时回到上次的歌单 / 歌曲 / 播放位置 */
  'player.resumeOnStart': boolean
  /** 上次播放到的秒数（用于续播） */
  'player.resumeTime': number
  /** 声音输出设备变化（插拔耳机 / 切默认设备）时暂停播放 */
  'player.pauseOnDeviceChange': boolean
  /** 进全屏时自动锁定界面（隐藏标题栏与控制栏，只留左下/右下两个按钮） */
  'player.lockOnFullscreen': boolean
  /** 默认视频清晰度（B 站 qn 档位代码，如 116 = 1080P 60帧） */
  'player.videoQuality': number
  /** 默认音质（dash 音频流 id，如 30280 = 192K） */
  'player.audioQuality': number
  /**
   * 卡顿**自动降低清晰度**（默认关）
   *
   * ## 开关只影响「降清晰度」这一步
   *
   * 卡顿时的恢复链是分级的，**换备用源 / 降 durl 是无条件自动做的**
   * （那两步不会损失清晰度体验，没必要问用户）：
   *
   * ```
   * 卡顿 8 秒
   *   → ① 换同一清晰度的备用源（backupUrl）      ← 无条件
   *   → ② 降一档清晰度（重新试它的源）            ← ★ 只在这一步看开关
   *   → ③ 降了 3 档还卡 → 降 durl                 ← 无条件
   *   → ④ durl 还卡 → 暂停 + 提示检查网络
   * ```
   *
   * - **开**：按上面整条链自动走，每次降档用 `message` 告知
   * - **关**：② 不执行 —— 备用源试完直接降到 durl（不一级级降），
   *   并用 `message` **提示**「建议降到 XXX」（下一级清晰度），让用户自己决定
   *
   * ## 为什么默认关
   *
   * 降清晰度是**降级体验**（画面变糊），该由用户主动选择；
   * 而「换源 / 降 durl」是纯恢复手段，不问也该做。
   */
  'player.autoDowngradeOnStall': boolean
  /**
   * 标题关键词加权配置：score -> 关键词列表
   *
   * **只用于「层内细分」**（见 `@common/utils/videoRank`）：先按
   * 「**歌手名是否命中**」分层（命中 `+100`），同层内再用它细分。
   *
   * 命中后**逐条累加，没有上限** —— 用户给 `-50` 就是 `-50`。
   * （早先会 clamp 到 ±10，已取消：那样 `-20` 档的「伴奏」和 `-4` 档的
   * 「乐器演奏」只差 6 分，压不出轻重。）
   *
   * 该字段是一个整体替换的配置对象，不做逐项深合并。
   */
  'player.tagBonus': Record<string, string[]>
  /**
   * 命中即**丢弃**的关键词
   *
   * 和 `player.tagBonus` 的区别（规格里特意分开的两套）：
   *
   * | | tagBonus | filterKeywords |
   * | --- | --- | --- |
   * | 作用阶段 | 层内细分 | **硬过滤** |
   * | 命中后 | 加/减分 | **直接丢弃** |
   * | 用户场景 | 微调排序偏好 | 绝对不想要的内容 |
   *
   * 默认给一组**谱类 / 演奏类**词（吉他谱、钢琴谱、指弹、口琴……）——
   * 那些搜出来很多、但用户要的是「能跟着唱的原曲」而不是教学。
   */
  'player.filterKeywords': string[]
  /**
   * 时长容差（秒，默认 90）
   *
   * 视频时长与歌单时长的允许差值。规则里 MV / Live 会自动放宽上限
   * （`×1.7`），用户不用管这个细节，只调一个整体宽严。
   */
  'player.durationToleranceSec': number
  /**
   * 过滤后结果**少于多少条就降级重搜**（默认 30）
   *
   * 「降级」= 换更宽松的搜索词再搜一遍（见 `searchSongFiltered`）。
   * 设成 `0` 表示**从不降级**（搜一次就算）。
   */
  'player.minSearchResults': number
  // #endregion

  // #region cache
  /** 是否启用搜索缓存 */
  'cache.enable': boolean
  /**
   * 缓存最长有效时间（毫秒），超过则视为过期
   *
   * **注意：这个键在本次数据层改造后已经不再是权威设置了。**
   * 改造前的语义是「整个缓存条目的寿命」，但缓存里其实混着两种寿命完全不同的数据：
   * 带签名的播放直链（约 2 小时失效）和视频元数据（标题/封面/收藏，永不过期）。
   * 用一个值同时管两者，结果就是「地址还没过期、元数据先被删了」。
   *
   * 现在过期只作用于**播放地址**，由 `cache.searchResultExpireMs` 控制。
   * 这个键保留在配置里不动（删掉会牵动迁移与界面回显），但主进程已经不读它，
   * 属于「留着以防用户配置里有旧值」的兼容占位。
   */
  'cache.maxAge': number
  /**
   * 搜索结果（播放直链）过期时间（毫秒）
   *
   * 过期只清**地址那一批列**（`durl_url` / `dash_video` / `dash_audio` /
   * `dash_duration` / `playurl_at`），**绝不删行**：
   * 标题、封面、收藏、顺序永不过期。所以这是「直链多久后重新解析」，
   * 不是「缓存留多久」。直链实测寿命约 2 小时，默认给 3 天是为了和改造前的
   * 行为对齐（用户不会觉得「升级完怎么老在重新解析」）。
   *
   * ⚠️ `quality` / `support_formats` 两列已在 schema v4 删除，
   * 不在清理清单里（durl 的清晰度从 URL 反推，档位表内置在 constants）。
   * 另：`dash_tried` 与 `playurl_login_state` **刻意不清** —— 它们不是地址，
   * 详见 `cache.ts` 的 `clearExpiredPlayurl`。
   *
   * **0 = 永久**（永远不清理直链，一直用到 `isUrlUsable` 判定它过期为止）。
   */
  'cache.searchResultExpireMs': number
  // #endregion
}
