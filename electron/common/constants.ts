/**
 * 主进程 / 渲染进程共用的常量
 *
 * 参考 LX Music (lyswhut/lx-music-desktop) 的 src/common/constants.ts
 */

/**
 * 配置数据结构版本号
 *
 * 注意：这里不是应用版本号（package.json 的 version），
 * 而是 setting.json 里 `version` 字段的版本。
 * 每当 AppSetting 的结构发生不兼容变更时，都需要 +1，
 * 并在 migrateSetting.ts 中补上对应的迁移逻辑。
 */
export const SETTING_VERSION = '1.0.0'

/** 应用数据目录（userData）下的文件名 */
export const STORE_NAMES = {
  APP_SETTINGS: 'setting',
  /**
   * 旧版单歌单文件 / 歌单集合文件（本项目 ≤1.5.x / 迁移期用）
   *
   * **两者都已不再读写**：歌单现在存 SQLite（`electron/main/utils/db.ts`）。
   * 按用户要求也不做旧文件迁移，这两个名字只是留着不删（删了要动 setting 之外的
   * 引用面，而它们本身没有任何副作用）。
   */
  PLAYLIST: 'playlist',
  PLAYLISTS: 'playlists',
} as const

/** 播放循环模式：列表循环 / 单曲循环 / 随机播放 */
export const PLAY_LOOP_MODES = ['listLoop', 'singleLoop', 'random'] as const

/** 界面颜色（hex）的取值范围与默认值 */
export const DEFAULT_THEME_COLOR = '#ffffff'
export const DEFAULT_FONT_COLOR = '#ffffff'
/** 只接受 `#RGB` / `#RRGGBB`（大小写都行） */
export const COLOR_HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
/**
 * 玻璃底色深浅的分界：亮度低于这个值就当「深色底」
 *
 * 深色底要配白阴影 + Element Plus 暗色，浅色底配黑阴影 + 亮色，
 * 这样用户随便挑颜色都不会出现「白底白字看不出字」。
 */
export const DARK_TINT_LUMINANCE = 0.5

/**
 * 透明度的取值范围与步进
 *
 * 数值就是玻璃底色 `rgba(255, 255, 255, x)` 里的那个 x（百分比）：
 * 30 = `rgba(255,255,255,0.3)`。控制栏、歌单按钮、弹窗、歌单下拉都用它。
 */
export const GLASS_TRANSPARENCY_MIN = 0
export const GLASS_TRANSPARENCY_MAX = 100
/** 滑块一档 5%：默认步进太细，拖起来对不齐 */
export const GLASS_TRANSPARENCY_STEP = 5

/**
 * 模糊强度
 *
 * 界面上的滑块是百分比（0-100%，5% 一档），**存的是 0-20 的像素值**：
 * 百分比 / 5 = px。所以 50% = 10px。
 */
export const GLASS_BLUR_MIN = 0
export const GLASS_BLUR_MAX = 20
export const GLASS_BLUR_PERCENT_STEP = 5
/** 1px 对应界面上 5% */
export const GLASS_BLUR_PERCENT_PER_PX = 5

/**
 * 阴影强度（文字阴影的模糊半径）
 *
 * 和模糊强度一个套路：滑块是百分比（0-100%，5% 一档），**存的是 0-20 的像素值**（百分比 / 5）。
 * 8px 就是默认那套「0 1px 4px + 0 0 8px」。
 */
export const GLASS_SHADOW_MIN = 0
export const GLASS_SHADOW_MAX = 20
export const GLASS_SHADOW_PERCENT_STEP = 5
export const GLASS_SHADOW_PERCENT_PER_PX = 5

// #region 窗口宽高比

/** 「不限制宽高比」的特殊值（用户可以任意拉伸窗口） */
export const ASPECT_RATIO_FREE = 'free'

/**
 * 宽高比预设（界面上是下拉框的固定项）
 *
 * 只有这三项 —— 其它比例（21:9、9:16 竖屏…）由用户自己在设置里输入，
 * 输入后会被**加进下拉列表并持久化**（存在 `common.customAspectRatios`）。
 *
 * `value` 存的就是比例字符串本身，这样「预设」和「用户自定义」在配置里是同一种东西，
 * 消费方（主进程解析、界面回显）都不需要区分来源。
 */
export const ASPECT_RATIO_OPTIONS = [
  { label: '16:9（默认）', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '不限制', value: ASPECT_RATIO_FREE },
] as const

/** 比例字符串允许的最大长度（防脏数据把下拉框撑爆） */
export const ASPECT_RATIO_MAX_LENGTH = 16
/** 自定义比例最多保留几个（同样是防脏数据） */
export const CUSTOM_ASPECT_RATIO_MAX_COUNT = 12

/** 宽高比字符串的格式：`数字:数字`（允许小数，如 `2.35:1`） */
export const ASPECT_RATIO_PATTERN = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/

/**
 * 把宽高比字符串解析成数值
 *
 * @returns 比例值（宽/高）；`'free'` 或非法值返回 `0`（= 不限制，对应 `setAspectRatio(0)`）
 *
 * 主进程和渲染层**共用这一个函数**，避免两边各写一份解析逻辑导致行为不一致
 * （比如渲染层显示「已锁定」而主进程其实没锁）。
 */
export const parseAspectRatio = (value: string | null | undefined): number => {
  if (!value || value === ASPECT_RATIO_FREE) return 0
  if (!ASPECT_RATIO_PATTERN.test(value)) return 0
  const [w, h] = value.split(':').map(Number)
  // 高为 0 或解析出 NaN 一律当作「不限制」，别把非法比例喂给 setAspectRatio
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0 || w <= 0) return 0
  return w / h
}

/** 默认宽高比：16:9（等于改造前的行为，老用户无感） */
export const DEFAULT_ASPECT_RATIO = '16:9'

// #endregion

/**
 * 歌单数据的版本号
 *
 * 改造前它是 `playlists.json` 里的 `version` 字段，用来给迁移逻辑做闸门。
 * 现在歌单存 SQLite，**这个常量只剩「写到内存快照里供渲染层回显」的作用**：
 * 迁移相关的判断已按用户要求整段删除，别再用它去比较磁盘版本。
 */
export const PLAYLIST_DATA_VERSION = '1.0.0'

/**
 * 可选定时同步间隔（毫秒）
 *
 * 界面上以下拉框展示，避免让用户自己填毫秒数。
 */
export const SYNC_INTERVAL_OPTIONS = [
  { label: '每 30 分钟', value: 30 * 60 * 1000 },
  { label: '每 1 小时', value: 60 * 60 * 1000 },
  { label: '每 3 小时', value: 3 * 60 * 60 * 1000 },
  { label: '每 6 小时', value: 6 * 60 * 60 * 1000 },
  { label: '每 12 小时', value: 12 * 60 * 60 * 1000 },
  { label: '每天', value: 24 * 60 * 60 * 1000 },
  { label: '每 3 天', value: 3 * 24 * 60 * 60 * 1000 },
  { label: '每周', value: 7 * 24 * 60 * 60 * 1000 },
] as const

/**
 * 搜索结果（播放直链）过期时间的取值范围与步进
 *
 * 界面上用「天」做单位（`el-input-number` + 左右加减按钮），存的是毫秒，
 * 所以这里同时给出毫秒常量，换算在设置界面里只做一次。
 *
 * **0 = 永久**：表示永远不清理播放直链。它是有意义的选项而不是「关掉设置」——
 * B 站直链本身带签名时效，真的过期了 `isUrlUsable` 照样会重新解析，
 * 所以「永久」只是不再由我们的定时清理去删，不会导致播放死链。
 *
 * 上限取 365 天：再长就等于永久了，而输入框给一个没有上限的数字反而危险
 * （用户敲一堆 9 进去，`cache.searchResultExpireMs` 溢出成 Infinity）。
 */
export const CACHE_EXPIRE_DAYS_MIN = 0
export const CACHE_EXPIRE_DAYS_MAX = 365
export const CACHE_EXPIRE_DAYS_STEP = 1
/** 一天的毫秒数：界面的「天」与存储的毫秒之间的换算系数 */
export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 默认音源显示名（与 musicSdk 的 MusicSource 对应，单独放一份避免循环依赖） */export const SOURCE_LABELS: Record<string, string> = {
  wy: '网易云',
  tx: 'QQ音乐',
  kw: '酷我',
  kg: '酷狗',
}

/**
 * 迁移用：v1.0.0 之前（旧版 App.vue 硬编码）的播放模式为数字 0/1/2
 */
export const LEGACY_PLAY_MODE_MAP = {
  0: 'listLoop',
  1: 'singleLoop',
  2: 'random',
} as const

/** 可选清晰度 / 音质（设置界面与播放器菜单共用） */
export interface QualityOption {
  /** B 站档位代码：视频是 qn，音频是 dash 音频流 id */
  id: number
  /** 短标签，用于角标 */
  label: string
  /** 完整说明，用于菜单 / 悬浮提示 */
  description: string
}

/**
 * 视频清晰度档位表（qn）
 *
 * 只用于**设置里的默认值**和兜底展示；实际可选档位由 playurl 响应的
 * `support_formats` / `accept_quality` 给出（不同视频和账号不一样）。
 */
export const VIDEO_QUALITY_OPTIONS: readonly QualityOption[] = [
  { id: 127, label: '8K', description: '8K 超高清' },
  { id: 126, label: '杜比视界', description: '杜比视界' },
  { id: 125, label: 'HDR', description: 'HDR 真彩' },
  { id: 120, label: '4K', description: '4K 超清' },
  { id: 116, label: '1080P60', description: '1080P 60帧' },
  { id: 112, label: '1080P+', description: '1080P 高码率' },
  { id: 80, label: '1080P', description: '1080P 高清' },
  { id: 74, label: '720P60', description: '720P 60帧' },
  { id: 64, label: '720P', description: '720P 准高清' },
  { id: 32, label: '480P', description: '480P 清晰' },
  { id: 16, label: '360P', description: '360P 流畅' },
  { id: 6, label: '240P', description: '240P 极速' },
]

/**
 * 音质档位表（dash `audio[].id`）
 *
 * B 站的音频流 id 是固定的一组，带宽决定音质；
 * 具体哪些可用同样由响应里的 `dash.audio` 决定。
 */
export const AUDIO_QUALITY_OPTIONS: readonly QualityOption[] = [
  { id: 30280, label: '192K', description: '192K 高音质' },
  { id: 30232, label: '132K', description: '132K 标准' },
  { id: 30216, label: '64K', description: '64K 流畅' },
]

/** 默认清晰度：1080P 60帧 */
export const DEFAULT_VIDEO_QN = 116
/** 默认音质：192K */
export const DEFAULT_AUDIO_ID = 30280

/** 按 id 取档位（查不到返回 undefined） */
export const findQualityOption = (
  list: readonly QualityOption[],
  id: number,
): QualityOption | undefined => list.find((o) => o.id === id)

/** 按 id 取短标签；查不到就退回数字，避免角标空着 */
export const qualityLabelOf = (list: readonly QualityOption[], id: number): string =>
  findQualityOption(list, id)?.label ?? String(id)
