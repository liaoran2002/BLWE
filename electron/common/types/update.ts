/**
 * 「检查更新」的类型
 *
 * 这个项目**不用版本号判断新旧**：`package.json` 的 version 一年可能都不动一次，
 * 但代码天天在改。所以比的是**构建指纹** —— `app.asar` 的 sha256。
 * 指纹不同 = 打包出来的东西不是同一份 = 有新版。
 *
 * 为什么不比 exe 的哈希：安装版用户跑的是安装目录里的 `BLWE.exe`，
 * 而发布出来的是 NSIS 安装包（`BLWE Setup 1.0.0.exe`），两者根本不是同一个文件，
 * 哈希永远对不上。`app.asar` 在两种产物里是同一份，才有可比性。
 */

/** 一次检查的结果（手动检查时会把 `error` 显示出来） */
export interface UpdateCheckResult {
  /** 检查流程本身跑完了吗（网络失败时为 false） */
  ok: boolean
  /** 本地构建指纹（app.asar 的 sha256）；开发模式或读不到时为 null */
  local: string | null
  /** 远端最新发布里的指纹 */
  remote: string | null
  /** 指纹不同 = 有新版 */
  different: boolean
  /** 发布页地址（点「去下载」打开它） */
  url: string | null
  /**
   * 失败原因
   *
   * 自动检查**不显示**它（国内经常连不上 GitHub，静默失败就是设计的一部分）；
   * 用户手动点「检查更新」时才把这句话给他看，否则他会以为按钮坏了。
   */
  error?: string
  /** 跳过检查的原因（开发模式等） */
  skipped?: string
}

/** 「关于」里显示的本机信息 */
export interface UpdateInfo {
  /** 应用版本号（只用于展示，不参与新旧判断） */
  version: string
  /** 是否打包版（开发模式不检查更新） */
  packaged: boolean
}

/** 主进程发现新版本时广播给界面的内容 */
export interface UpdateAvailablePayload {
  /** 本地指纹（完整 sha256） */
  local: string
  /** 远端指纹（完整 sha256） */
  remote: string
  /** 发布页 */
  url: string
}
