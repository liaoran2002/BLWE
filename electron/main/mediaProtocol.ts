/**
 * `blwe-media://` —— 把本地视频文件喂给播放器
 *
 * ## 为什么必须有这一层
 *
 * 渲染层的 origin 是 `blwe://app`（打包）或 `http://localhost`（开发），
 * **两种都读不了 `file:///D:/x.mp4`** —— 直接给 `<video src="file://…">`
 * 会被 Chromium 当成跨源本地文件拒掉（`Not allowed to load local resource`）。
 *
 * 所以在主进程开一个自己的协议：`blwe-media://local/<bvid>` → 查库拿到路径 →
 * 流式吐回去。渲染层看到的仍然是一个**普通 URL**，播放链路（`<video src>`）
 * 一行都不用改。
 *
 * ## 为什么手写 Range 而不是 `net.fetch(pathToFileURL(...))`
 *
 * 视频拖进度条时 Chromium 会发 `Range: bytes=N-`。`net.fetch` 对 `file://`
 * 只给整份 200，没有 206 —— 表现是「每次 seek 都从第 0 字节重读」，
 * 几百 MB 的文件一拖就卡死，而且 CPU 直接跑满。所以这里必须自己实现 206。
 *
 * ## 安全边界
 *
 * URL 里只有 bvid，路径是**回查库**得到的 —— 这个协议只放得出去
 * 「用户自己拖进来登记过的文件」，不是一个任意文件读取器。
 * 就算渲染层被注入了脚本，也没法拿它读 `C:\Users\x\.ssh\id_rsa`。
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import type { CustomScheme } from 'electron'
import { LOCAL_MEDIA_SCHEME, bvidOfMediaUrl, getLocalVideo } from './utils/localVideo'

/** 扩展名 → MIME。Chromium 主要靠容器嗅探，但这个头给对了能省一轮猜测 */
const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.3gp': 'video/3gpp',
}

const mimeOf = (filePath: string): string =>
  MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'

/**
 * 协议的注册项（交给 `main/index.ts` 和 `blwe://` **一起**注册）
 *
 * `standard` / `secure` 只有在 `app.whenReady()` 之前注册才生效；
 * `stream` 是视频流必需（没有它 `<video>` 会按「一次性缓冲」对待响应，
 * seek 和边下边播都会退化）。
 *
 * ⚠️ 不在这里自己调 `registerSchemesAsPrivileged` —— 那个方法
 * **一生只能调一次**，第二次会被静默忽略（见 `protection.ts` 同名注释）。
 */
export const mediaSchemeDescriptor = (): CustomScheme => ({
  scheme: LOCAL_MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
})

/** 把 Node 的 Readable 包成 fetch 的 BodyInit（Electron 主进程跑在 Node 20+，有 toWeb） */
const bodyOf = (stream: fs.ReadStream): ReadableStream =>
  Readable.toWeb(stream) as unknown as ReadableStream

/**
 * 解析 `Range: bytes=…`
 *
 * 三种形态都要认（Chromium 拖进度条时用的就是第二种）：
 * ```
 * bytes=0-1023      指定区间
 * bytes=2048-       从这里到文件末尾   ← 最常见
 * bytes=-1024       末尾 1024 字节（一般只有取尾部的场景会用）
 * ```
 * 解析失败一律返回 null，调用方**退回整份 200** —— 比 416 友好：
 * 播放器拿到 200 会自己重新算区间，而 416 在某些实现里会直接判成致命错误。
 */
const parseRange = (
  header: string,
  total: number,
): { start: number; end: number } | null => {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (!rawStart && !rawEnd) return null

  if (!rawStart) {
    // 后缀区间：最后 N 字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, total - suffix), end: total - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= total) return null
  const end = rawEnd ? Math.min(Number(rawEnd), total - 1) : total - 1
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}

/**
 * 装上请求处理器（`app.whenReady()` 之后）
 *
 * 和 `installProtectedProtocol()` 一样要在 `createMainWindow()` 之前 ——
 * 窗口一开就可能立刻起播，那时协议必须已经在了。
 */
export const installMediaProtocol = (): void => {
  protocol.handle(LOCAL_MEDIA_SCHEME, async (request) => {
    const bvid = bvidOfMediaUrl(request.url)
    const record = bvid ? getLocalVideo(bvid) : null
    if (!record) {
      return new Response('没有登记过这个本地视频', { status: 404 })
    }

    let total: number
    try {
      const stat = await fsp.stat(record.filePath)
      if (!stat.isFile()) return new Response('不是文件', { status: 404 })
      total = stat.size
    } catch {
      /**
       * 文件被移走 / 改名 / 删掉了。
       *
       * 这里**不删库里的那一行**：用户可能只是插拔了移动硬盘，过两天又插回来。
       * 界面上这一条播不了，OV 的连续失败刹车会接住并停下，不会一路跳过去。
       */
      return new Response('本地文件不存在', { status: 404 })
    }

    const type = mimeOf(record.filePath)
    const rangeHeader = request.headers.get('Range')
    const range = rangeHeader ? parseRange(rangeHeader, total) : null

    /** 空文件：给个合法的 200 就行，媒体元素会自己报错 */
    if (total === 0) {
      return new Response(null, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': '0', 'Accept-Ranges': 'bytes' },
      })
    }

    if (!range) {
      return new Response(bodyOf(fs.createReadStream(record.filePath)), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(total),
          // 声明了 Chromium 才会在 seek 时改用 Range 请求
          'Accept-Ranges': 'bytes',
        },
      })
    }

    return new Response(
      bodyOf(fs.createReadStream(record.filePath, { start: range.start, end: range.end })),
      {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
          'Accept-Ranges': 'bytes',
        },
      },
    )
  })

  console.log(`[media] 已注册 ${LOCAL_MEDIA_SCHEME}:// 协议（本地视频流）`)
}
