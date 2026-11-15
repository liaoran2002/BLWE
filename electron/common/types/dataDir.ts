/**
 * 「配置文件（userData）放哪」的类型
 *
 * 三种来源：
 *  - `appdata`  —— 默认的 `%APPDATA%/<应用名>`（安装版 / 便携版共用一份）
 *  - `portable` —— exe 同级的 `blwedata/`（数据跟着程序走）
 *  - `custom`   —— 用户自己挑的文件夹
 *
 * ## 为什么这个选择不放在 setting.json 里
 *
 * 它是**元配置**：`setting.json` 本身就住在 userData 里，回答「userData 在哪」
 * 不能靠一个住在 userData 里的文件（自指）。所以单独存一份几字节的
 * `%APPDATA%/BLWE/data-dir.json`，在 `setupUserDataPath()` 之前读。
 *
 * 同理也不能放进数据目录：用户一旦换目录，指针会被「留在旧目录里」直接失联。
 */

/** 数据目录的来源 */
export type DataDirMode = 'appdata' | 'portable' | 'custom'

/** 落盘的指针文件内容 */
export interface DataDirChoice {
  mode: DataDirMode
  /** `mode === 'custom'` 时的绝对路径；其余模式为空串 */
  customPath: string
}

/** 「配置文件位置」这一项在设置界面要显示的东西（一次给全，省得界面算路径） */
export interface DataDirInfo {
  /** 当前**生效**的模式；没手动选过时是按便携规则自动判出来的那个 */
  mode: DataDirMode
  /** 用户手动指定过没有（`false` = 一直在自动判定） */
  hasChoice: boolean
  /** 上次选过的自定义路径（切回「自定义」时 radio 上还看得见）；从未选过时是空串 */
  customPath: string
  /** 本次运行真正在用的目录 */
  currentPath: string
  /** 默认目录：`%APPDATA%/<应用名>` */
  appdataPath: string
  /** 便携目录：exe 同级的 `blwedata` */
  portablePath: string
}
