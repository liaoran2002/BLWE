/**
 * 在线更新：**只做「检查 + 提示」**，不自动下载安装
 *
 * ## 为什么比指纹而不是版本号
 *
 * 版本号要手动改、容易忘；这个项目的代码天天动，`1.0.0` 却一直不变。
 * 所以比的是 `app.asar` 的 sha256：**打包内容有任何变化，指纹就变**。
 * 详见 `common/types/update.ts` 的说明（为什么不是比 exe 的哈希）。
 *
 * ## 为什么连不上就一声不吭
 *
 * GitHub 在国内经常连不上（域名污染 / 超时）。如果失败也弹一句「检查更新失败」，
 * 用户每次开机都被打扰一次，而且他什么也做不了。所以：
 *  - **自动检查**：网络 / 解析 / 资源缺失，任何一步失败都直接返回，不弹任何东西；
 *  - **手动检查**（「关于」里的按钮）：失败要把原因说出来，否则用户以为按钮坏了。
 *
 * ## 发布侧要做什么
 *
 * 每次 `npm run dist` 之后跑 `npm run fingerprint` 算出 `release/fingerprint.json`
 * （`{ sha256, size, builtAt }`），工作流把它**压成一行写进发布说明正文**：
 *
 * ```
 * 20e320887805c6f33c714eb1418d83f0196f13d8b837e3b463ad5d4efc1fb0d6/11843413/1794118330860
 * ```
 *
 * 就是 `sha256/字节数/构建时间戳`。应用按 `/` 切开取第一段比对，后两段给人对账。
 * 不上传附件 —— 正文和安装包属于同一次发布，够用了，还省掉一次下载请求。
 * 本地打出来的包想手算也一样：`npm run fingerprint` 后看那个 json。
 */
import { app, net, Notification, shell } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { broadcast } from '@common/mainIpc'
import type {
  UpdateAvailablePayload,
  UpdateCheckResult,
  UpdateInfo,
} from '@common/types/update'
import { getSetting, updateSetting } from './utils/setting'

/** 仓库（发布页 / API 都从这里派生） */
const REPO = 'liaoran2002/BLWE'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases`
/** 单次请求超时：国内连 GitHub 经常是一直挂着不回，等 8 秒就够了 */
const TIMEOUT_MS = 8000
/** 自动检查的间隔：6 小时内不重复查 */
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 启动后等一会儿再查：别和启动时的首屏 / 播放抢网络 */
const START_DELAY_MS = 12_000
/** 心跳间隔：睡一觉回来也能补上一次检查 */
const HEARTBEAT_MS = 60 * 60 * 1000

interface ReleaseInfo {
  tag_name?: string
  html_url?: string
  /** 发布说明正文，指纹就写在里面 */
  body?: string
}

/** app.asar 的绝对路径（打包后才有） */
const asarPath = (): string => path.join(process.resourcesPath, 'app.asar')

/**
 * 本地构建指纹 = `app.asar` 的 sha256
 *
 * ## 必须临时关掉 asar 补丁
 *
 * Electron 把 `fs` 换成了「能读 asar 包内部」的版本：路径落在 asar 里时它去查包内索引。
 * 而我们要读的是 **asar 文件本身**，补丁会把它当成包内路径去查，直接报
 * `ENOENT, not found in …app.asar`（实测过，不是猜的）。
 * 所以读之前把 `process.noAsar` 打开、读完立刻还原 —— 这是 Electron 官方给的口子。
 *
 * 直接 `readFileSync`：这个文件十几 MB，只在**检查更新**时算一次（「关于」里不显示指纹了，
 * 不再为看个版本号白读一遍它）。
 */
export const localFingerprint = (): string | null => {
  if (!app.isPackaged) return null
  const file = asarPath()
  const previous = process.noAsar
  try {
    process.noAsar = true
    if (!fs.existsSync(file)) return null
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch (err) {
    console.warn('[update] 计算本地指纹失败:', err)
    return null
  } finally {
    process.noAsar = previous
  }
}

/** 发布说明里那一行：`<sha256>/<字节数>/<构建时间戳（毫秒）>` */
interface RemoteBuild {
  sha256: string
  size: number
  builtAt: number
}

/**
 * 从发布说明正文里抠出构建信息
 *
 * 工作流写的就是一行三段、斜杠分隔：
 *
 * ```
 * 20e320887805c6f33c714eb1418d83f0196f13d8b837e3b463ad5d4efc1fb0d6/11843413/1794118330860
 * ```
 *
 * 只认 sha256（比它就能判断新旧），`size` / `builtAt` 是给人对账用的 ——
 * 比如怀疑「提示有新版但下下来还是旧的」时，拿这两个和本地 `app.asar` 比一眼就看出来。
 *
 * 兜底：老格式是 `sha256: <hash>` 单独一行，手写说明也可能只留一串哈希，
 * 所以找不到斜杠格式时退一步按标签 / 首个 64 位十六进制认。
 */
const parseRemoteBuild = (body: string): RemoteBuild | null => {
  const spec = /([0-9a-f]{64})\/(\d+)\/(\d+)/i.exec(body)
  if (spec) {
    return { sha256: spec[1].toLowerCase(), size: Number(spec[2]), builtAt: Number(spec[3]) }
  }
  const labelled = /sha256[ \t]*[:：=]?[ \t]*([0-9a-f]{64})/i.exec(body)
  const bare = labelled ?? /\b([0-9a-f]{64})\b/i.exec(body)
  if (!bare) return null
  return { sha256: bare[1].toLowerCase(), size: 0, builtAt: 0 }
}

/**
 * 常见失败原因 → 一句人话
 *
 * 这些码分两套：`net.fetch`（Chromium）给的是 `net::ERR_*`，全局 `fetch`（undici）
 * 给的是 `ENOTFOUND` / `CERT_*` 这类 errno。两套都认，省得以后换回来又要改一遍。
 */
const HINTS: Array<{ test: RegExp; hint: string }> = [
  {
    test: /ERR_CERT|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|AUTHORITY_INVALID|DEPTH_ZERO/i,
    hint: '本机有代理或安全软件在替换 HTTPS 证书，系统不认它',
  },
  {
    test: /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    hint: '域名解析不出来，检查 DNS 或代理',
  },
  { test: /ERR_INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH/i, hint: '没有网络' },
  { test: /ERR_CONNECTION_REFUSED|ECONNREFUSED/i, hint: '连接被拒绝，代理端口是不是没开' },
  { test: /ERR_TIMED_OUT|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT/i, hint: '连接超时' },
  { test: /ERR_PROXY|ERR_TUNNEL/i, hint: '代理连不上' },
]

/**
 * 把失败原因挖到底
 *
 * - undici 的 `fetch failed` 是个空壳，真正的原因（`ENOTFOUND` / `CERT_*`）在 `err.cause` 里；
 * - Chromium 的 `net.fetch` 直接把 `net::ERR_*` 写在 message 上。
 *
 * 两条都收，再配一句人话 —— 否则界面上那句「检查失败：fetch failed」等于什么都没说。
 * ⚠️ 这是**间歇性**的：同一台机器上代理开着 / 关着、切了节点，结果就可能不一样，
 * 所以提示里不能写死「你没网」。
 */
const describeError = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err)
  /** `AbortSignal.timeout` 抛的是 `TimeoutError`：说人话，别把 "The operation was aborted" 丢给用户 */
  if (err.name === 'TimeoutError' || /aborted/i.test(err.message)) {
    return `请求超时（${TIMEOUT_MS / 1000} 秒）`
  }

  const cause = (err as { cause?: unknown }).cause
  const detail =
    cause instanceof Error
      ? [((cause as { code?: string }).code ?? ''), cause.message].filter(Boolean).join(': ')
      : typeof cause === 'string'
        ? cause
        : ''

  const all = `${err.message} ${detail}`
  const hint = HINTS.find((item) => item.test.test(all))?.hint
  const base = detail ? `${err.message}（${detail}）` : err.message
  return hint ? `${base} —— ${hint}` : base
}

/**
 * 一次请求的 init（两条路共用）
 *
 * `AbortSignal.timeout` **必须每次新建**：signal 一旦 abort 就不能复用，
 * 拿同一个给第二次请求会立刻抛错。
 */
const requestInit = (): RequestInit => ({
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BLWE' },
  signal: AbortSignal.timeout(TIMEOUT_MS),
})

interface FetchAttempt {
  /** 日志 / 报错里怎么称呼这条路 */
  name: string
  run: () => Promise<Response>
}

/**
 * 取远端最新发布里的构建信息
 *
 * **一次请求就够**：那一行写在发布说明正文（`body`）里，不再另传附件。
 * 早先把 `{ sha256, size, builtAt }` 传成 `fingerprint.json` 附件，那是多此一举 ——
 * 应用为了三个字段要额外发一次下载请求，用户还会在资源列表里看到个不知用途的 json。
 *
 * 跟 release 绑定这件事没变（正文也是这次发布的一部分），所以不会出现
 * 「提示有新版本、下到的却还是旧的」。可信度上也一样：能改正文的人同样能换附件。
 *
 * ## 两条路都试，都挂了才报错
 *
 * 这两条不是重复，它们看的是**两套不同的网络配置**：
 *
 * | 路 | 走什么 | 它什么时候才通 |
 * | :--- | :--- | :--- |
 * | `net.fetch` | Chromium：系统代理 + 系统证书库 + Chromium 的 DNS 缓存 | 机器上开着代理（「浏览器能开」的那种状态） |
 * | `fetch` | Node undici：直连 + 自带 CA 列表 | 代理关了 / 系统代理指向一个没开的端口，但直连能出去 |
 *
 * 只留一条都会出现「明明能上网，它就是说失败」：
 *  - 只走 `fetch`：代理 + TLS 中间人的机器上挂在证书（踩过 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，
 *    而浏览器正常）；
 *  - 只走 `net`：系统代理开着但代理软件退了的机器上，Chromium 会老老实实去连那个死端口。
 *
 * 所以两条都留着，**任一条拿到响应就算成功**（哪怕 404 —— status 是另一回事，不该换路重试）。
 * 代价是最坏等两轮超时（8 + 8 秒）；真实失败大多是毫秒级（DNS / 证书 / 连接被拒），
 * 只有「黑洞连接」才会等满。
 */
const fetchRemoteBuild = async (): Promise<RemoteBuild & { url: string }> => {
  const attempts: FetchAttempt[] = []
  /** `net` 必须等 app ready；没 ready 就只剩直连这一条（正常流程走不到这里） */
  if (app.isReady()) {
    attempts.push({ name: '代理', run: () => net.fetch(RELEASE_API, requestInit()) })
  }
  attempts.push({ name: '直连', run: () => fetch(RELEASE_API, requestInit()) })

  const failures: string[] = []
  let res: Response | null = null

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i]
    try {
      res = await attempt.run()
      break
    } catch (err) {
      failures.push(`${attempt.name}：${describeError(err)}`)
      if (i < attempts.length - 1) {
        console.log(`[update] ${attempt.name}这一路失败，换另一条重试：`, describeError(err))
      }
    }
  }

  if (!res) throw new Error(`两路都失败 —— ${failures.join('；')}`)
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`)

  const release = (await res.json()) as ReleaseInfo
  const build = parseRemoteBuild(release.body ?? '')
  if (!build) throw new Error('发布说明里没有构建信息')

  return { ...build, url: release.html_url || RELEASES_PAGE }
}

/**
 * 检查一次（自动 / 手动共用）
 *
 * **不弹任何东西**，只把结果返回给调用方 —— 提示由调用方决定用弹窗还是系统通知，
 * 这样「自动检查静默失败」和「手动检查要报错」两份策略不会写两遍。
 */
export const checkForUpdate = async (): Promise<UpdateCheckResult> => {
  const local = localFingerprint()
  const empty: UpdateCheckResult = {
    ok: false,
    local,
    remote: null,
    different: false,
    url: null,
  }

  if (!app.isPackaged) return { ...empty, ok: true, skipped: '开发模式不检查更新' }
  if (!local) return { ...empty, error: '读不到本地构建指纹' }

  try {
    const remote = await fetchRemoteBuild()
    /** 只记成功的检查时间：失败不写，下次启动还会再试 */
    updateSetting({ 'update.lastCheckAt': Date.now() })
    return {
      ok: true,
      local,
      remote: remote.sha256,
      different: remote.sha256 !== local,
      url: remote.url,
    }
  } catch (err) {
    /**
     * 失败就到这里为止：**不 log 成 error**，因为国内连不上是常态，
     * 每次启动刷一条红字只会让用户以为程序坏了。
     *
     * 但原因要留下来（`describeError` 会带上 `ENOTFOUND` / `CERT_*` 这类码），
     * 否则「检查失败：fetch failed」看不出是没网、被墙，还是证书不认。
     */
    const reason = describeError(err)
    console.log('[update] 检查更新失败（已静默）:', reason)
    return { ...empty, error: reason }
  }
}

/**
 * 本机信息（「关于」里显示）
 *
 * 只回版本号：指纹不往界面上摆，算它还要把十几 MB 的 `app.asar` 整个读一遍，
 * 每次打开「关于」白花这个钱不值。
 */
export const getUpdateInfo = (): UpdateInfo => {
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
  }
}

/** 用户点「以后再说」：这一份指纹不再主动弹 */
export const dismissUpdate = (sha256: string): void => {
  if (!sha256) return
  updateSetting({ 'update.dismissedSha': sha256 })
}

export interface UpdateWatchDeps {
  /** 当前是否在壁纸模式（窗口被嵌进桌面，弹窗用户看不见） */
  isWallpaperMode: () => boolean
  /** 取主窗口（判断界面此刻是否可见） */
  getMainWindow: () => import('electron').BrowserWindow | null
}

/**
 * 告诉用户「有新版本」
 *
 * 界面看得见 -> 广播给渲染层弹对话框（能带「去下载 / 以后再说」两个按钮）；
 * 壁纸模式 / 关到托盘 -> 系统通知（点一下打开发布页）。
 * 两条路都只用这一个函数，避免「壁纸模式下永远不提示」这种死角。
 */
const announce = (payload: UpdateAvailablePayload, deps: UpdateWatchDeps): void => {
  const win = deps.getMainWindow()
  const visible =
    !!win && !win.isDestroyed() && win.isVisible() && !deps.isWallpaperMode()

  if (visible) {
    broadcast('update:available', payload)
    return
  }

  try {
    const notification = new Notification({
      title: 'BLWE 有新版本',
      body: '点这里打开发布页下载。',
    })
    notification.on('click', () => void shell.openExternal(payload.url))
    notification.show()
  } catch (err) {
    console.warn('[update] 系统通知发不出去:', err)
  }
}

/**
 * 启动自动检查
 *
 * 只在**打包版**里跑：开发模式下 `app.asar` 不存在，指纹无从谈起。
 * 失败全程静默（见文件头）。用户已经在「关于」里关不关？——目前没有开关，
 * 因为检查只是读一个公开文件，不上报任何东西。
 */
export const startUpdateWatcher = (deps: UpdateWatchDeps): void => {
  if (!app.isPackaged) return

  const tick = async (): Promise<void> => {
    const last = Number(getSetting()['update.lastCheckAt'] ?? 0)
    if (Date.now() - last < AUTO_INTERVAL_MS) return

    const result = await checkForUpdate()
    if (!result.ok || !result.different || !result.remote || !result.url || !result.local) return
    if (getSetting()['update.dismissedSha'] === result.remote) return

    announce(
      { local: result.local, remote: result.remote, url: result.url },
      deps,
    )
  }

  setTimeout(() => void tick(), START_DELAY_MS)
  setInterval(() => void tick(), HEARTBEAT_MS)
}
