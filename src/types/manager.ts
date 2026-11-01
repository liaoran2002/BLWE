/**
 * `ManagerDialog`（两个管理器共用的那个弹窗组件）的数据契约
 *
 * 为什么在这单独一个文件：
 * 它只认「归一化之后」的数据 —— 不知道歌单和视频的区别，
 * 只知道「左边一列列表、右边一列条目」。两个管理器各自把自己那份
 * （`PlaylistRecord` / `VideoListRecord`）映射成下面这几个形状。
 *
 * 映射很薄（十几行 computed），换来的是一条链路的唯一实现：
 * 左栏列表行、详情头、搜索框、条目行、空态、底部按钮。
 */

/** 列表行 / 详情头上的一个小标签 */
export interface ManagerTag {
  text: string
  /**
   * `default` = 身份标记（「默认」这种），用强调色描出来；
   * 不填 = 来源 / 类型标签（wy、QQ、合集、本地…）
   */
  tone?: 'default'
  /** 悬浮说明 */
  title?: string
}

/** 左栏的一个列表 */
export interface ManagerList {
  id: string
  name: string
  /** 数量文案（「12 首」/「38 条」） */
  countText: string
  tags: ManagerTag[]
  /** 是不是「正在播放的那个」—— 名字前面点亮一个小圆点 */
  current: boolean
  /** 同步中：行尾转圈 */
  syncing: boolean
}

/** 右侧详情头（选中列表之后那一块） */
export interface ManagerDetail {
  name: string
  countText: string
  tags: ManagerTag[]
  /** 副行里的纯文本补充，如歌单的「手动同步」「上次同步：09:31」 */
  meta: string[]
}

/**
 * 右侧列表里的一行
 *
 * 歌和视频在这里长得一样：标题 / 副标题 / 第二副项 / 封面 / 时长。
 * `index` 必须是**原始下标**（不是过滤后的），点第 N 行要播列表里的第 N 条。
 */
export interface ManagerRow {
  /** 行唯一键（歌用下标，视频用 bvid） */
  key: string | number
  index: number
  title: string
  /** 歌是歌手，视频是 UP 主 */
  subtitle: string
  /** 歌是专辑名，视频一般不用 */
  extra?: string
  /** 标题的悬浮提示（视频用本地路径） */
  titleTooltip?: string
  /**
   * 时长前面那个小标记
   *
   * 目前只有本地歌单用：混了多平台的歌，久了记不清哪首来自哪个平台，
   * 标一个 `wy` / `tx` / `kw`。视频列表不传。
   */
  tag?: string
  cover?: string | null
  /** 秒 */
  duration?: number | null
  playing: boolean
  /** 本地文件不在了：压暗 + 出「文件丢失」角标 */
  missing?: boolean
  missingHint?: string
}

/** 右侧主区当前处于哪一态 */
export type ManagerMode = 'form' | 'detail' | 'empty'
