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
 * 每次 `npm run dist` 之后跑 `npm run fingerprint`，把生成的
 * `release/fingerprint.json`（内容 `{ "sha256": "…" }`）作为**发布附件**上传，
 * 文件名必须是 `fingerprint.json` —— 这里靠这个名字在 assets 里找它。
 */
import { app, Notification, shell } from 'electron'
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
/** 发布时附带的指纹文件名（改了这里就得同步改 `scripts/fingerprint.mjs`） */
const ASSET_NAME = 'fingerprint.json'
/** 单次请求超时：国内连 GitHub 经常是一直挂着不回，等 8 秒就够了 */
const TIMEOUT_MS = 8000
/** 自动检查的间隔：6 小时内不重复查 */
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 启动后等一会儿再查：别和启动时的首屏 / 播放抢网络 */
const START_DELAY_MS = 12_000
/** 心跳间隔：睡一觉回来也能补上一次检查 */
const HEARTBEAT_MS = 60 * 60 * 1000

interface ReleaseAsset {
  name?: string
  browser_download_url?: string
}

interface ReleaseInfo {
  tag_name?: string
  html_url?: string
  assets?: ReleaseAsset[]
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
 * 直接 `readFileSync`：这个文件十几 MB，只在检查更新 / 打开「关于」时算一次。
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

/**
 * 取远端最新发布里的指纹
 *
 * 两步：① 问 GitHub 最新 release 有哪些附件；② 下载 `fingerprint.json` 读 `sha256`。
 * 分两步是刻意跟 release 绑定的 —— 指纹和安装包必须是**同一次发布**的，
 * 否则会出现「提示有新版本、下到的却还是旧的」。
 */
const fetchRemoteFingerprint = async (): Promise<{ sha256: string; url: string }> => {
  const releaseRes = await fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BLWE' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!releaseRes.ok) throw new Error(`GitHub 返回 ${releaseRes.status}`)
  const release = (await releaseRes.json()) as ReleaseInfo

  const asset = (release.assets ?? []).find((item) => item.name === ASSET_NAME)
  if (!asset?.browser_download_url) throw new Error(`这次发布没有 ${ASSET_NAME}`)

  const fingerRes = await fetch(asset.browser_download_url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!fingerRes.ok) throw new Error(`下载指纹失败（${fingerRes.status}）`)
  const payload = (await fingerRes.json()) as { sha256?: unknown }
  const sha256 = typeof payload.sha256 === 'string' ? payload.sha256.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${ASSET_NAME} 里的 sha256 不合法`)

  return { sha256, url: release.html_url || RELEASES_PAGE }
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
    const remote = await fetchRemoteFingerprint()
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
     */
    console.log('[update] 检查更新失败（已静默）:', err instanceof Error ? err.message : err)
    return { ...empty, error: err instanceof Error ? err.message : '连接失败' }
  }
}

/** 本机信息（「关于」里显示） */
export const getUpdateInfo = (): UpdateInfo => {
  const fingerprint = localFingerprint()
  return {
    version: app.getVersion(),
    fingerprint: fingerprint ? fingerprint.slice(0, 12) : null,
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
