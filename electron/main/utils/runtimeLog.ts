/**
 * 运行日志（`userData/runtime.log`）
 *
 * ## 为什么需要它
 *
 * 打包之后没有控制台：用户遇到「卡在缓冲 95%」这种情况，能给我的只有一张截图，
 * 而真正有用的信息（哪一首、解析到哪一步、看门狗有没有触发、渲染层报了什么）
 * 全在 console 里 —— 屏幕上什么都看不到。
 *
 * 所以把 **主进程 + 渲染层** 的 console 一起落到一个文件里，出问题让用户直接把
 * 文件发过来就行，不用教他开 DevTools（打包版默认也开不了）。
 *
 * ## 几个约定
 *
 * - **每次启动清空重写**（`flags: 'w'`）：只保留「这一次运行」的日志。否则跑一个月
 *   之后文件几百兆，而且真正要看的永远是最新那一段；
 * - 上限 8MB：正常一天也就几百 KB，超了说明有东西在疯狂刷日志（那种情况本身要修），
 *   这里只是防止把用户的磁盘写满；
 * - 行首统一 `时间 [main|renderer] 级别`，多行日志按行加前缀，方便 grep / 直接看；
 * - 渲染层日志走 `webContents.on('console-message')` 转发 —— 引擎、缓冲、看门狗全在
 *   渲染层，不收这一路等于什么都没记到。
 */
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { app } from 'electron'

const FILE_NAME = 'runtime.log'
/** 单次运行最多写这么多（正常远到不了） */
const MAX_BYTES = 8 * 1024 * 1024

let fd: number | null = null
let written = 0
let capped = false

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

const stamp = (): string => {
  const now = new Date()
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
    `${pad(now.getMilliseconds(), 3)}`
  )
}

/**
 * 渲染层 console 的 `%c` 样式串清理
 *
 * 三方库（以及 Vue 的彩色日志）会这样打：
 *
 * ```
 * console.log('%c bili-fe-mirror %c v2.1.0', 'padding: 2px 6px; ...', 'color: #fff; ...')
 * ```
 *
 * `console-message` 只把**拼好的整串**递过来，`%c` 和后面那一大坨 CSS 会原样落进
 * 文件 —— 一行能占好几屏，真正想看的那句话被挤到最后。这里把 `%c` 与样式声明去掉。
 *
 * 两个保险：只在真的出现 `%c` 时才动手；且「独立成串」的样式**至少两组声明**才算
 * （单组 `a: 1;` 很可能是正文内容）。
 */
/** 紧跟在 `%c` 后面的样式（Electron 自己的安全警告就是这种形态） */
const STYLE_AFTER_TOKEN = /%c\s*(?:[-\w]+\s*:\s*[^;{}]+;\s*)+/g
/** 被当成独立参数传进来的样式串：至少两组声明 */
const STYLE_RUN = /(?:\s*(?:[-\w]+\s*:\s*[^;{}]+;)){2,}/g

const stripConsoleStyles = (text: string): string => {
  if (!text.includes('%c')) return text
  return text
    .replace(STYLE_AFTER_TOKEN, ' ')
    .replace(/%c/g, '')
    .replace(STYLE_RUN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 落一行（多行文本按行拆开，每行都带时间与前缀，读起来才不乱） */
const write = (scope: 'main' | 'renderer', level: string, text: string): void => {
  if (fd === null || capped) return
  const body = (scope === 'renderer' ? stripConsoleStyles(text) : text).replace(/\r/g, '')
  const chunk = body
    .split('\n')
    .map((line) => `${stamp()} [${scope}] ${level.padEnd(5)} ${line}\n`)
    .join('')
  written += Buffer.byteLength(chunk, 'utf8')
  if (written > MAX_BYTES) {
    capped = true
    const note = `${stamp()} [main] WARN   日志超过 ${MAX_BYTES / 1024 / 1024}MB，后续不再记录\n`
    try {
      fs.writeSync(fd, note)
      fs.closeSync(fd)
    } catch {
      // 写不进去就算了
    }
    fd = null
    return
  }
  /**
   * 用 `writeSync` 而不是 `createWriteStream`
   *
   * 日志量不大（一天几百 KB），但退出路径 `process.on('exit')` 里只能做同步操作 ——
   * 流式写的话最后几十行会丢，而那几十行往往正是崩溃前的现场。
   */
  try {
    fs.writeSync(fd, chunk)
  } catch {
    fd = null
  }
}

/** 日志文件的绝对路径（设置界面上要显示 / 用户要发过来时用得到） */
export const runtimeLogPath = (): string => path.join(app.getPath('userData'), FILE_NAME)

/** 渲染层的 `level` 有两种形态：老签名是数字（0 verbose / 1 info / 2 warning / 3 error），新签名是字符串 */
const levelName = (level: unknown): string => {
  if (typeof level === 'number') return ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] ?? 'LOG'
  const text = String(level ?? 'log').toLowerCase()
  if (text === 'warning') return 'WARN'
  if (text === 'verbose') return 'DEBUG'
  return text.toUpperCase()
}

/**
 * 装上日志（**必须在拿到单实例锁之后调用**）
 *
 * 放太早会有个坑：第二个实例被 `app.quit()` 之前也会走到这里，
 * 而它以 `'w'` 打开同一个文件 —— 第一个实例正在写的日志会被清空。
 */
export const initRuntimeLog = (): void => {
  /**
   * dev 也写，不区分打包与否
   *
   * 两个环境本来就是**两个 userData 目录**（dev 是 `%APPDATA%/BiLiWallpaperEngine`，
   * 便携版是旁边的 `blwedata`），不会互相覆盖。都写的好处是同一个问题可以在
   * 「dev 复现」和「打包版复现」两份日志之间对着看。
   */
  const file = runtimeLogPath()
  try {
    /** `'w'`：每次启动清空重写，只保留这一次运行 */
    fd = fs.openSync(file, 'w')
    written = 0
    capped = false
  } catch {
    // 日志是辅助手段，写不了不能影响程序启动
    fd = null
    return
  }

  /**
   * 包住 console：现有代码里所有 `console.log/warn/error` 不用改一行就都进文件
   *
   * `console` 在 Node 里是可变对象，但类型定义是只读的 —— 用一层 Record 断言绕过。
   */
  const patched = console as unknown as Record<string, (...args: unknown[]) => void>
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    patched[level] = (...args: unknown[]) => {
      original(...args)
      /** `util.format` 遇到奇怪对象也可能抛；日志坏了不能反过来影响业务 */
      try {
        write('main', level.toUpperCase(), util.format(...args))
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 渲染层 console 一起收
   *
   * 用 `browser-window-created` 而不是在主窗口里挂：登录窗、壁纸窗各有自己的
   * webContents，漏一个就会在「只在壁纸模式下复现」的问题上抓瞎。
   */
  app.on('browser-window-created', (_event, win) => {
    /**
     * 两套签名都兜住
     *
     * Electron 35 起第二个参数从 `level: number` 换成了 `details: { level, message }`，
     * 但项目锁定版本的 `@types` 还是老签名 —— 只按类型写，某次升级就会静默收不到
     * 渲染层日志（文件照样生成，只是里面全是主进程的）。
     */
    const listener = (...params: unknown[]): void => {
      const second = params[1]
      if (second && typeof second === 'object') {
        const detail = second as { level?: string; message?: string }
        write('renderer', levelName(detail.level), detail.message ?? '')
        return
      }
      write('renderer', levelName(second), String(params[2] ?? ''))
    }
    win.webContents.on('console-message', listener as never)
  })

  /**
   * 这行**不要再写 `[main]` 前缀**
   *
   * `write()` 已经会加 `[main]` / `[renderer]` 这一列，消息里再写一遍就是
   * `[main] LOG   [main] 运行日志：…`，白占两列宽度。
   */
  console.log(`运行日志（每次启动重写）：${file}`)
}

/** 退出前关掉文件句柄（`writeSync` 已经落盘，这里只是别留个 dangling fd） */
export const closeRuntimeLog = (): void => {
  if (fd === null) return
  try {
    fs.closeSync(fd)
  } catch {
    // 退出路径上不抛
  }
  fd = null
}
