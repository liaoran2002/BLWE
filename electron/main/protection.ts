/**
 * 渲染层产物加密（**只在打包构建里生效**）
 *
 * 做法：打包脚本把 `out/renderer` 下的 html / js / css 用 AES-256-GCM 就地加密，
 * 所以进了 asar 之后它们是密文；运行时主进程注册一个 `blwe://` 协议，
 * 页面请求哪个文件就解密哪个文件（只解密到内存，不落盘）。
 *
 * 为什么用自定义协议而不是拦 `file://`：
 *  Electron 里覆盖内置的 file 协议要自己重写整套文件服务（MIME、目录穿越、范围请求…），
 *  而 `protocol.handle` + `registerSchemesAsPrivileged` 是官方支持的路子；
 *  注册成 standard + secure 之后，页面的 origin 是 `blwe://app`，
 *  fetch / MSE / CORS 的行为和 https 页面一致（某站 CDN 是 `Access-Control-Allow-Origin: *`，
 *  所以跨域取流不受影响 —— 打包后实测过能正常出画）。
 *
 * 踩坑提醒：
 *  - 密钥从 `bundleKey.ts` 来（会被编译进主进程字节码）；加密脚本读的是同一个常量，
 *    两边不一致的表现是「页面白屏 + 控制台一堆 net::ERR_FAILED」。
 *  - 明文文件（没加密的）会原样返回：开发时、以及 image/font 这类不需要加密的资源都走这条路。
 */
import { app, protocol } from 'electron'
import type { CustomScheme } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLE_KEY } from './bundleKey'

/** 自定义协议名（标准 + 安全上下文） */
export const PROTECTED_SCHEME = 'blwe'
/** 密文文件的标识头，用来区分「加密过的」和「普通文件」 */
const MAGIC = Buffer.from('BLWE1')
const IV_LEN = 12
const TAG_LEN = 16

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/**
 * 这次运行要不要走加密资源
 *
 * 打包后自动开；开发时默认关（`out/renderer` 是明文，改完刷新就能看效果）。
 * `BLWE_FORCE_PROTECT=1` 可以在开发模式下强制打开 —— 验证脚本就靠它跑打包后才有的那条路。
 */
export const protectionEnabled = (): boolean =>
  app.isPackaged || process.env.BLWE_FORCE_PROTECT === '1'

/** 页面地址（打包后用它替代 `loadFile`） */
export const protectedRendererUrl = (page: string): string =>
  `${PROTECTED_SCHEME}://app/${page.replace(/^\/+/, '')}`

const key = (): Buffer => crypto.createHash('sha256').update(BUNDLE_KEY, 'utf8').digest()

/** 是密文就解密，不是就原样返回 */
const maybeDecrypt = (buf: Buffer): Buffer => {
  if (buf.length < MAGIC.length + IV_LEN + TAG_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    return buf
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN)
  const tag = buf.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN)
  const data = buf.subarray(MAGIC.length + IV_LEN + TAG_LEN)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/**
 * 加密资源协议的注册项（没启用保护时返回 null）
 *
 * ⚠️ **这里不再自己调 `registerSchemesAsPrivileged`**
 *
 * Electron 的文档写得很死：`registerSchemesAsPrivileged`「can be called only
 * once」—— 第二次调用会被**静默忽略**，没有任何报错。于是「先注 `blwe://`、
 * 后注 `blwe-media://`」的结果是后者根本没注册成 standard / secure / stream，
 * 表现是本地视频「能导入、点了没画面」，而且控制台一片安静。
 *
 * 所以注册收口到 `main/index.ts` 的**唯一一次**调用里，各模块只交出自己的描述。
 */
export const protectedSchemeDescriptor = (): CustomScheme | null => {
  if (!protectionEnabled()) return null
  return {
    scheme: PROTECTED_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  }
}

/**
 * 装上请求处理器（`app.whenReady()` 之后、创建窗口之前调用）
 */
export const installProtectedProtocol = (): void => {
  if (!protectionEnabled()) return
  const rootDir = path.join(__dirname, '../renderer')

  protocol.handle(PROTECTED_SCHEME, async (request) => {
    const url = new URL(request.url)
    /**
     * 解码要兜底
     *
     * `blwe://app/%` 这种畸形百分号会让 `decodeURIComponent` 抛 URIError，
     * 协议处理器直接 reject —— 请求失败 + 一堆控制台噪音，而原因只是一个坏 URL。
     */
    let rel: string
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    } catch {
      console.warn('[protect] URL 解码失败:', request.url)
      return new Response('bad request', { status: 400 })
    }
    const full = path.normalize(path.join(rootDir, rel))

    // 目录穿越防护：解出来的路径必须还在 renderer 目录里
    if (!full.startsWith(rootDir + path.sep) && full !== rootDir) {
      console.warn('[protect] 拒绝越界请求:', request.url)
      return new Response('forbidden', { status: 403 })
    }

    let buf: Buffer
    try {
      buf = await fs.promises.readFile(full)
    } catch {
      console.warn('[protect] 资源不存在:', rel)
      return new Response('not found', { status: 404 })
    }

    try {
      buf = maybeDecrypt(buf)
    } catch (err) {
      // 解密失败要说出来：静默返回乱码只会看到白屏，查起来更费劲
      console.error('[protect] 解密失败（密钥对不上？）:', rel, err)
      return new Response('decrypt failed', { status: 500 })
    }

    return new Response(buf, {
      headers: { 'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream' },
    })
  })
  console.log('[protect] 渲染层加密资源已启用（blwe://）')
}
