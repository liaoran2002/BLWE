/**
 * 便携版（portable）的数据目录
 *
 * 必须在**最早期**调用（app.whenReady 之前，越早越好），
 * 因为 app.getPath('userData') 一旦被读取就可能被缓存，
 * 之后再改 userData 会导致配置/缓存写到两个不同的地方。
 *
 * 规则（按优先级）：
 *  1. `%APPDATA%/<应用名>` 里**已经有本应用的数据** -> 就用它。
 *     这样安装版和便携版会共用同一份配置 / 歌单，换版本不会「数据不见了」。
 *  2. 否则，如果这是 electron-builder 打出来的**便携版**
 *     （运行时带 `PORTABLE_EXECUTABLE_DIR` 环境变量）->
 *     在 exe 同级建一个 `blmvdata` 目录，数据跟着程序走。
 *  3. 再否则（安装版且是全新环境）-> 用默认的 `%APPDATA%/<应用名>`。
 *
 * 判断「已经有数据」看的是我们自己的文件（setting.json / playlists.json / search-cache），
 * 不能只看目录存不存在 —— Electron 一启动就会把 userData 目录建出来，
 * 那样在全新机器上永远判成「有数据」，步骤 2 就永远走不到了。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 便携版数据目录名
 *
 * 早期版本叫 `data`，太通用的名字放在 exe 同级容易和别的软件撞
 * （用户把好几个绿色版丢一个文件夹里就冲突了），所以改成 `blmvdata` 做区分。
 *
 * 注意：**不做旧目录迁移**。旧版本留下的 `data/` 原样放着不动 ——
 * 应用只认 `blmvdata/`，不会再读写那个旧目录。
 */
const PORTABLE_DATA_DIR_NAME = 'blmvdata'

/** 当前是否在用便携目录 */
let portable = false

/** 我们自己的数据文件名 / 目录名：任意一个存在就算「这里已经有数据」 */
const DATA_MARKERS = ['setting.json', 'playlists.json', 'playlist.json', 'search-cache']

const hasOwnData = (dir: string): boolean => {
  try {
    return DATA_MARKERS.some((name) => fs.existsSync(path.join(dir, name)))
  } catch {
    return false
  }
}

export const isPortable = (): boolean => portable

/**
 * 初始化 userData 路径
 *
 * @returns 最终的 userData 路径
 */
export const setupUserDataPath = (): string => {
  if (process.platform === 'win32') {
    try {
      const defaultUserData = app.getPath('userData')
      // electron-builder 的 portable target 会带上这个变量，安装版没有
      const portableExeDir = process.env.PORTABLE_EXECUTABLE_DIR
      if (!hasOwnData(defaultUserData) && portableExeDir) {
        const dataDir = path.join(portableExeDir, PORTABLE_DATA_DIR_NAME)
        fs.mkdirSync(dataDir, { recursive: true })
        // 两个都指过去：只改 userData 的话，Electron 内部仍可能往 Roaming 里写东西
        app.setPath('appData', dataDir)
        app.setPath('userData', dataDir)
        portable = true
      }
    } catch (err) {
      // 便携目录不可用时静默回退到默认 userData，不能因为这里抛错导致应用起不来
      console.error('[portable] setup failed, fallback to default userData:', err)
      portable = false
    }
  }

  const userDataPath = app.getPath('userData')
  // 确保目录存在：setting.json / playlists.json / search-cache 都写在这里
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true })
  return userDataPath
}
