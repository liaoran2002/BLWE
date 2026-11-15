/**
 * 配置文件（userData）的定位
 *
 * 必须在**最早期**调用（app.whenReady 之前，越早越好），
 * 因为 app.getPath('userData') 一旦被读取就可能被缓存，
 * 之后再改 userData 会导致配置/缓存写到两个不同的地方。
 *
 * ## 优先级
 *
 * 1. 用户在「设置 → 数据 → 配置文件位置」里手动选过 → **听用户的**
 *    （`%APPDATA%/BLWE/data-dir.json` 里那份选择，见 `common/types/dataDir.ts`）；
 * 2. 没选过时才走自动规则：
 *    a. `%APPDATA%/<应用名>` 里**已经有本应用的数据** -> 就用它。
 *       这样安装版和便携版会共用同一份配置 / 歌单，换版本不会「数据不见了」。
 *    b. 否则，如果这是 electron-builder 打出来的**便携版**
 *       （运行时带 `PORTABLE_EXECUTABLE_DIR` 环境变量）->
 *       在 exe 同级建一个 `blwedata` 目录，数据跟着程序走。
 *    c. 再否则（安装版且是全新环境）-> 用默认的 `%APPDATA%/<应用名>`。
 *
 * 判断「已经有数据」看的是我们自己的文件（`blwe.db` 等），不能只看目录存不存在 ——
 * Electron 一启动就会把 userData 目录建出来，那样在全新机器上永远判成「有数据」，
 * 步骤 b 就永远走不到了。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { DataDirChoice, DataDirInfo, DataDirMode } from '@common/types/dataDir'

/**
 * 便携版数据目录名
 *
 * 早期版本叫 `data`，太通用的名字放在 exe 同级容易和别的软件撞
 * （用户把好几个绿色版丢一个文件夹里就冲突了），所以改成带前缀的目录名做区分。
 * 项目从 BLWE 起，目录名统一用 `blwedata`。
 *
 * 注意：**不做旧目录迁移**。老版本留下的数据目录原样放着不动 ——
 * 应用只认 `blwedata/`，不会再读写它。
 */
const PORTABLE_DATA_DIR_NAME = 'blwedata'

/**
 * 指针文件（用户手动选的数据目录）放在哪
 *
 * **故意不放在数据目录里**：它要回答「数据目录是哪个」，存进去就成了自指，
 * 用户一换目录，指针自己就被留在旧目录里，下次启动读不到、直接失联。
 * 也**不放在 exe 同级**：安装版装在 Program Files 时那里不可写。
 * 所以取 `%APPDATA%/BLWE/data-dir.json` —— 系统级、恒可写、和数据目录无关。
 *
 * 只在用户**真的改过**这一项时才创建；纯绿色版用户不碰它就不会有任何痕迹。
 */
const LOCATION_DIR_NAME = 'BLWE'
const LOCATION_FILE_NAME = 'data-dir.json'

/** 当前是否在用便携目录 */
let portable = false

/** 默认 userData（`%APPDATA%/<应用名>`）：必须在任何 `setPath` 之前抓下来 */
let appdataDir = ''

/**
 * 我们自己的数据文件名 / 目录名：任意一个存在就算「这里已经有数据」
 *
 * `blwe.db` 必须在列表里 —— 换成 SQLite 之后**真正承载用户数据的就是它**
 * （歌单、收藏、选中视频）。漏掉的话，一个「只有库文件」的目录会被判成「没有数据」，
 * 便携版就会去 exe 同级再建一个空库，用户看到的是「歌单全没了」。
 */
const DATA_MARKERS = ['blwe.db', 'setting.json', 'playlists.json', 'playlist.json', 'search-cache']

const hasOwnData = (dir: string): boolean => {
  try {
    return DATA_MARKERS.some((name) => fs.existsSync(path.join(dir, name)))
  } catch {
    return false
  }
}

export const isPortable = (): boolean => portable

/**
 * 把用户选的文件夹**归一化**成真正的数据目录
 *
 * 用户选的是一个「地方」，不是「这个文件夹本身就是数据目录」。便携版的数据目录
 * 固定叫 `blwedata`，所以两种常见情况要认出来，否则会把 setting.json / blwe.db
 * 直接摊在用户选的目录里，和他自己的文件混在一起：
 *
 *  1. 选的就是 `blwedata` 本身（`E:\data\BLWE\blwedata`）→ 用它；
 *  2. 选的是它的上层（`E:\data\BLWE`，里面已经有 `blwedata`）→ 用里面那个，
 *     这样「指着现有数据说我要用这份」能直接生效，不会在旁边再造一个空目录。
 *
 * 其余情况才把选中的目录当数据目录（空文件夹 / 全新的地方）。
 */
const resolveCustomDir = (picked: string): string => {
  if (path.basename(picked).toLowerCase() === PORTABLE_DATA_DIR_NAME) return picked
  const inner = path.join(picked, PORTABLE_DATA_DIR_NAME)
  try {
    if (fs.statSync(inner).isDirectory()) return inner
  } catch {
    /* 不存在 / 不可访问 → 那用户选的就是数据目录本身 */
  }
  return picked
}

/** 便携目录（exe 同级 `blwedata`）；便携版优先用 electron-builder 给的那个真实目录 */
const portablePath = (): string => {
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'))
  return path.join(base, PORTABLE_DATA_DIR_NAME)
}

/** 指针文件路径（读的时候 `appData` 还没被改写，取到的就是系统那个） */
const locationFile = (): string =>
  path.join(process.env.APPDATA || app.getPath('appData'), LOCATION_DIR_NAME, LOCATION_FILE_NAME)

/**
 * 读用户的选择
 *
 * 文件不存在 / 内容坏了 / 模式不认识都返回 `null` —— 那是「没选过」，
 * 走自动规则。不能因为一个坏文件让程序起不来。
 */
const readChoice = (): DataDirChoice | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(locationFile(), 'utf8')) as Partial<DataDirChoice>
    const mode = raw?.mode
    if (mode !== 'appdata' && mode !== 'portable' && mode !== 'custom') return null
    return { mode, customPath: typeof raw.customPath === 'string' ? raw.customPath : '' }
  } catch {
    return null
  }
}

/** 把 userData / appData 一起指过去（只改 userData 的话 Electron 内部仍可能往 Roaming 写） */
const applyDir = (dir: string): boolean => {
  try {
    fs.mkdirSync(dir, { recursive: true })
    app.setPath('appData', dir)
    app.setPath('userData', dir)
    return true
  } catch (err) {
    console.error(`[data] 目录不可用，回退默认：${dir}`, err)
    return false
  }
}

/**
 * 初始化 userData 路径
 *
 * @returns 最终的 userData 路径
 */
export const setupUserDataPath = (): string => {
  /** 先抓默认值：后面 `setPath('appData')` 一改，`getPath` 就再也拿不到它了 */
  appdataDir = app.getPath('userData')

  if (process.platform === 'win32') {
    try {
      const choice = readChoice()
      if (choice?.mode === 'custom' && choice.customPath) {
        /** 再归一化一次：指针可能是手改的 / 老版本写的是上层目录 */
        const dir = resolveCustomDir(choice.customPath)
        if (applyDir(dir)) console.log(`[data] 使用自定义目录：${dir}`)
      } else if (choice?.mode === 'portable') {
        const dir = portablePath()
        if (applyDir(dir)) portable = true
      } else if (choice?.mode === 'appdata') {
        /** 默认就是它，什么都不用做 */
        console.log('[data] 使用 APPDATA 目录（用户指定）')
      } else {
        // 没手动选过 → 自动判定（便携版 / 已有数据 / 全新安装）
        // electron-builder 的 portable target 会带上这个变量，安装版没有
        const portableExeDir = process.env.PORTABLE_EXECUTABLE_DIR
        if (!hasOwnData(appdataDir) && portableExeDir) {
          const dataDir = path.join(portableExeDir, PORTABLE_DATA_DIR_NAME)
          fs.mkdirSync(dataDir, { recursive: true })
          app.setPath('appData', dataDir)
          app.setPath('userData', dataDir)
          portable = true
        }
      }
    } catch (err) {
      // 便携目录不可用时静默回退到默认 userData，不能因为这里抛错导致应用起不来
      console.error('[portable] setup failed, fallback to default userData:', err)
      portable = false
    }
  }

  const userDataPath = app.getPath('userData')
  // 确保目录存在：setting.json / blwe.db / runtime.log 都写在这里
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true })
  return userDataPath
}

/**
 * 当前这一项要显示什么（设置界面用）
 *
 * `mode` 给的是**生效中**的模式，不是「选过的模式」：没选过的时候要能显示
 * 「自动判到了便携版」，否则界面上三个 radio 全是空的。
 */
export const getDataDirInfo = (): DataDirInfo => {
  const choice = readChoice()
  const current = app.getPath('userData')
  const rawCustom = choice?.customPath ?? ''
  return {
    mode: choice?.mode ?? (portable ? 'portable' : 'appdata'),
    hasChoice: Boolean(choice),
    /**
     * 保留上次挑过的路径：切回「自定义」时还能看见它。
     *
     * 同样要归一化 —— 指针可能是手改的、或老版本写的是上层目录，
     * 这时界面显示的和启动时真正用的是两个路径，会让人对不上账。
     */
    customPath: rawCustom ? resolveCustomDir(rawCustom) : '',
    currentPath: current,
    appdataPath: appdataDir || current,
    portablePath: portablePath(),
  }
}

/**
 * 写入用户的选择（**下一次启动才生效**）
 *
 * 只写指针文件，不动当前进程的 userData —— 运行中换目录等于把开着的
 * SQLite 连接和已经读进内存的配置一起搬家，那是另一件工程。
 *
 * 落盘前先试 `mkdir`：目录建不出来（装在 Program Files、U 盘只读）就当场报错，
 * 而不是写进指针、下次启动静默回退，用户以为设置丢了。
 */
export const setDataDir = (
  mode: DataDirMode,
  customPath: string,
): { ok: boolean; error?: string } => {
  if (mode !== 'appdata' && mode !== 'portable' && mode !== 'custom') {
    return { ok: false, error: '未知的目录类型' }
  }
  let picked = ''
  if (mode === 'custom') {
    const raw = (customPath || '').trim()
    if (!raw) return { ok: false, error: '没有选择文件夹' }
    if (!path.isAbsolute(raw)) return { ok: false, error: '需要一个绝对路径' }
    /** 选的是上层目录（里面有 blwedata）时落到那个 blwedata 上，见 `resolveCustomDir` */
    picked = resolveCustomDir(raw)
  }

  /** 试一下这个目录到底能不能用（`appdata` 恒可用，不用试） */
  const target = mode === 'portable' ? portablePath() : mode === 'custom' ? picked : ''
  if (target) {
    try {
      fs.mkdirSync(target, { recursive: true })
      /** 能建不够，还要能写 —— 只读目录 mkdir 可能因为「已存在」而通过 */
      fs.accessSync(target, fs.constants.W_OK)
    } catch (err) {
      return {
        ok: false,
        error: `这个目录不可写：${target}（${err instanceof Error ? err.message : String(err)}）`,
      }
    }
  }

  try {
    const file = locationFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const body = JSON.stringify({ mode, customPath: picked } satisfies DataDirChoice, null, 2)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
