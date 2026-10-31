/**
 * 默认配置对象
 *
 * 通过 `satisfies LX.AppSetting` 做 TS 强校验：
 *  - 少写任何一个 key 都会报错
 *  - 写错 key 名或值的类型都会报错
 * 同时 `as const` 语义保留字面量类型，便于推导。
 *
 * 参考 LX Music 的 src/common/defaultSetting.ts
 */
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_AUDIO_ID,
  DEFAULT_FONT_COLOR,
  DEFAULT_IDLE_OPACITY,
  DEFAULT_THEME_COLOR,
  DEFAULT_VIDEO_QN,
  SETTING_VERSION,
} from './constants'
import type { AppSetting } from './types/app_setting'

const defaultSetting = {
  version: SETTING_VERSION,

  // #region common
  'common.wallpaperMode': false,
  /**
   * 开机自动启动，默认**关**
   *
   * 默认关是有意的：改开机启动项属于「动系统」的行为，
   * 应该由用户明确打开，而不是装完就悄悄给自己注册一项。
   */
  'common.autoLaunch': false,
  /**
   * 定时暂停：上次设的小时 / 分钟（都默认 0 = 没定时）
   *
   * 存下来是为了「下次打开面板直接显示上次的值」——
   * 用户多半是重复设同一个时长（比如每天睡前 1 小时）。
   */
  'common.sleepTimerHours': 0,
  'common.sleepTimerMinutes': 0,
  /**
   * 定时暂停：三个复选框的上次选择
   *
   * 默认全不勾（= 到点立刻停止播放，不关程序）—— 这是最保守的行为，
   * 「关闭程序」这种更重的动作该由用户主动勾。
   */
  'common.sleepTimerOptions': {
    pauseCountdown: false,
    waitVideoEnd: false,
    closeApp: false,
  },
  /** 点关闭按钮时最小化到系统托盘（不退出），默认关：保持「点 X 就退出」的习惯 */
  'common.closeToTray': false,
  /** 任务栏图标上显示播放进度，默认开 */
  'common.taskbarProgress': true,
  /** 玻璃底色：默认黑色 */
  'common.themeColor': DEFAULT_THEME_COLOR,
  /** 浮层文字颜色：默认白色 */
  'common.fontColor': DEFAULT_FONT_COLOR,
  /**
   * 透明度：玻璃底色 `rgba(255,255,255,x)` 里的 x（百分比）
   * 30 = `rgba(255,255,255,0.3)`，和加这个设置之前的观感一致
   */
  'common.glassTransparency': 30,
  /**
   * 控制栏闲置透明度（0-100），默认 10
   *
   * 10% = 改造前写死的 `--ui-idle-opacity: 0.1`，所以老用户观感不变。
   * 鼠标悬停时会变成完全不透明，这个值只管「闲着的时候淡到多透明」。
   */
  'common.idleOpacity': DEFAULT_IDLE_OPACITY,
  /**
   * 模糊强度：`backdrop-filter: blur(Npx)` 的 N（0-20）
   * 界面上显示成百分比（50% = 10px），存的是这个 px 值
   */
  'common.glassBlur': 10,
  /**
   * 阴影强度：文字阴影的模糊半径（0-20 px，界面显示成百分比：8px = 40%）
   * 8 就是原来的「0 1px 4px + 0 0 8px」
   */
  'common.glassShadow': 8,
  /**
   * 窗口宽高比：'16:9' / '4:3' / 自定义比例 / 'free'（不限制）
   *
   * 默认 16:9 就是改造前写死的那个值，所以老用户升级后行为不变。
   * 注意**壁纸模式下它不起作用**（壁纸要铺满整屏）。
   */
  'common.windowAspectRatio': DEFAULT_ASPECT_RATIO,
  /**
   * 用户自己输入过的宽高比（下拉框 = 固定预设 + 这一份）
   *
   * 默认空数组：老用户升级后下拉框里只有那三个固定项，跟改造前无差别。
   */
  'common.customAspectRatios': [],
  // #endregion

  // #region player
  'player.volume': 70,
  'player.isMute': false,
  'player.loopMode': 'listLoop',
  /**
   * 记住播放进度：下次打开回到上次的歌单 / 歌曲 / 播放位置
   *
   * 原来拆成「自动续播」+「恢复播放进度」两个开关，实际用起来没人会只开一个
   * （回到那首歌却不回进度，或者反之），已经合并成一个。
   */
  'player.resumeOnStart': true,
  /** 上次播放到的秒数 */
  'player.resumeTime': 0,
  /** 当前在播的 B 站视频列表 id；空 = 在播音乐歌单 */
  'player.activeVideoListId': '',
  /**
   * 默认列表的 id（拖入单条视频的落点）
   *
   * 空 = 还没定过（第一次启动时会自动建一个「默认列表」并写进来）。
   * 它**删不掉**（可以改名）：拖视频进来总要有个地方放，删了下次还得再建一个，
   * 不如把「哪个是默认的」记死在这里，而不是靠名字去猜。
   */
  'player.defaultVideoListId': '',
  /** 声音输出设备变化时暂停，默认开（避免声音跑到刚插上的设备上） */
  'player.pauseOnDeviceChange': true,
  /**
   * 全屏时自动锁定界面，默认关
   *
   * 锁定 = 标题栏 / 控制栏全隐藏，只留左下（锁定）和右下（全屏）两个按钮。
   */
  'player.lockOnFullscreen': false,
  /** 默认视频清晰度：1080P 60帧（实际会按登录态/会员/视频可用档位降级） */
  'player.videoQuality': DEFAULT_VIDEO_QN,
  /** 默认音质：192K */
  'player.audioQuality': DEFAULT_AUDIO_ID,
  /**
   * 卡顿自动降低清晰度，默认**关**
   *
   * 关掉时卡顿仍会自动「换备用源」和「降 durl」（那两步不损失清晰度体验），
   * 只是**不自动降清晰度**，改成提示用户「建议降到 XXX」。
   */
  'player.autoDowngradeOnStall': false,
  /**
   * 标题关键词加权（**只用于层内细分**，见 `@common/utils/videoRank`）
   *
   * 先按「歌手名是否命中」分层（命中 `+100`），同层内再用它细分。
   * 命中后**逐条累加、没有上限**（早先会 clamp 到 ±10，已取消）。
   */
  'player.tagBonus': {
    '20': [
      'MV',
      'Official',
      '官方',
      '原唱版',
      '华语MV',
      '原版',
      '蓝光',
      '超清',
      '4K',
	  '8K',
	  '120FPS',
    ],
    '5': [
      'Live',
      '高清',
      '无损',
      'Hi-Res',
      'Hi-Fi',
      '高音质',
      '录音棚',
      '动态歌词',
      '微电影',
      '音乐现场',
      '演唱会',
      '舞台',
      '原画',
      '60FPS',
      '2K',
      '1080P',
      '杜比音效',
      '全景声',
      'DTS',
      '母带音质',
      '现场版',
      '巡演',
      '音乐节',
      '录音室',
      '动态频谱',
	  '可视化',
	  'MTV',
	  'KTV'
    ],
    '-5': [
      '翻唱',
      '合唱',
      '阿卡贝拉',
      '书本打击',
      '录屏',
      '歌单',
      '电台',
      '改编',
      '录屏版',
      '分享',
      '推荐',
      '混剪',
      '卡点',
    ],
    /**
     * -10：乐器演奏类压分
     *
     * ⚠️ **这里不能放「已在 `player.filterKeywords` 里的词」**（踩过）
     *
     * `passHardFilter` 在**打分之前**就把命中过滤词的标题丢掉了 ——
     * 也就是说那些视频根本走不到 `scoreVideo`，放在这里**永远不会生效**，
     * 两处规则互相抵消、还看不出报错。
     *
     * 已剔除的重复词（它们仍在 `filterKeywords` 里，命中即丢）：
     * `演奏` / `口琴` / `萨克斯` / `架子鼓` / `非洲鼓` / `古筝` /
     * `小提琴` / `大提琴` / `二胡` / `琵琶` / `竹笛`
     * 以及被过滤词包含而无法独立命中的：`纯音乐演奏` / `即兴演奏`（被「演奏」罩住）、
     * `乐器独奏`（「独奏」）/ `乐器合奏`（「合奏」）/ `指弹吉他`（「指弹」）。
     *
     * 留下的这些**不在**过滤词里，所以压分是真的在起作用。
     */
    '-10': [
      '吉他',
      '钢琴',
      '打击乐',
      '扬琴',
      '贝斯',
      '电子琴',
      '手鼓',
      '马林巴',
    ],
    /**
     * -20：教学 / 谱类压分
     *
     * 同样**不能**放已被过滤词覆盖的词。
     * 已剔除（仍在 `filterKeywords` 里）：`鼓谱` / `吉他谱` / `动态鼓谱` /
     * `钢琴谱` / `简谱` / `五线谱` / `动态谱`。
     */
    '-20': [
      '教学',
      '教程',
      '卡拉OK',
      '歌词排版',
      '素材',
      '零基础教学',
      '进阶教程',
      '字幕排版',
      '循环素材',
      '背景音乐',
    ],
    '-50': ['伴奏', '纯伴奏', '无和声', '消音', 'instrumental'],
  },
  /**
   * 命中即**丢弃**的关键词（默认是谱类 / 演奏类）
   *
   * 和 `player.tagBonus` 是两套东西：那个用来「微调排序」，
   * 这个用来「绝对不要」。谱类内容在搜索结果里占比很高，
   * 而用户要的是能跟着唱的原曲，所以直接丢而不是降权。
   */
  'player.filterKeywords': [
    '吉他谱',
    '钢琴谱',
    '简谱',
    '五线谱',
    '鼓谱',
    '动态谱',
    '动态鼓谱',
    '指弹',
    '演奏',
    '独奏',
    '合奏',
    '口琴',
    '萨克斯',
    '古筝',
    '二胡',
    '琵琶',
    '竹笛',
    '小提琴',
    '大提琴',
    '架子鼓',
    '非洲鼓',
  ],
  /** 时长容差（秒）：视频与歌单时长允许差这么多 */
  'player.durationToleranceSec': 300,
  /** 过滤后少于这么多条就**降级重搜**；`0` = 从不降级 */
  'player.minSearchResults': 30,
  // #endregion

  // #region cache
  'cache.enable': true,
  /**
   * 已废弃：改造前是「整个缓存条目的寿命」
   *
   * 保留默认值是为了不动用户已有配置的形状（删掉要连带改迁移与界面回显），
   * 主进程现在**不再读它**。过期语义见下面的 `cache.searchResultExpireMs`。
   */
  'cache.maxAge': 3 * 24 * 60 * 60 * 1000,
  /**
   * 搜索结果（播放直链）过期时间，默认 3 天
   *
   * 取 3 天是为了**和改造前的行为对齐**：改造前 `cache.maxAge` 就是 3 天，
   * 老用户升级后不会觉得「怎么突然老在重新解析地址」。
   * 注意它只管直链，元数据（标题/封面/收藏/顺序）永不过期。
   */
  'cache.searchResultExpireMs': 3 * 24 * 60 * 60 * 1000,
  // #endregion
} satisfies AppSetting

export default defaultSetting
