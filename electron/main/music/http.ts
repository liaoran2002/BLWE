/**
 * 音乐平台请求层
 *
 * 替代 LX 里的 needle（src/renderer/utils/request.js），只保留歌单解析需要的部分。
 *
 * ## 为什么不用 Electron 的 net.request
 *
 * 实测发现：在主进程里用 `net.request` 请求腾讯的 c.y.qq.com / u.y.qq.com 时，
 * 会稳定返回 `net::ERR_BLOCKED_BY_CLIENT`；而同一时刻同样的 URL、同样的请求头，
 * 用 Node 的 `https` 却能正常拿到 100KB+ 数据（wy / kw 也是全程正常）。
 * 因此这里改用 Node 内建 http/https，行为可预期，也不再受 Chromium 网络栈影响。
 *
 * ## 额外好处：彻底解决短链跳转
 *
 * Node 的 http/https 默认**不跟随重定向**，响应里能直接读到 `location` 头。
 * 之前用 fetch / net.request 时拿不到 Location（opaqueredirect）或必须 abort
 * 才能拿到，正是这个坑导致 QQ 接口被误判失败。
 */
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'

export interface MusicResponse {
  statusCode: number
  headers: Record<string, string>
  /** 原始响应文本（已按需解压），调用方自行决定是否 JSON.parse */
  body: string
}

export interface MusicFetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** application/x-www-form-urlencoded 表单 */
  form?: Record<string, string>
  /** 直接塞原始 body（与 form 二选一） */
  body?: string
  timeout?: number
  /** 是否自动跟随重定向，默认 true */
  followRedirect?: boolean
  /** 判断「请求成功」，用于决定要不要重试；默认 200 <= status < 400 */
  validateStatus?: (status: number) => boolean
}

const DEFAULT_TIMEOUT = 20000
const MAX_REDIRECTS = 5

interface RawResult extends MusicResponse {
  location: string | null
}

/** 发起一次请求（单次，不跟随重定向） */
const requestOnce = (
  url: string,
  options: MusicFetchOptions,
): Promise<RawResult> =>
  new Promise((resolve, reject) => {
    let settled = false
    const done = (result: RawResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return fail(new Error(`非法 URL: ${url}`))
    }
    const isHttps = parsed.protocol === 'https:'
    const transport = isHttps ? https : http

    const body = options.form ? new URLSearchParams(options.form).toString() : options.body
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    if (body && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = options.form
        ? 'application/x-www-form-urlencoded'
        : 'text/plain'
    }
    if (body) headers['Content-Length'] = String(Buffer.byteLength(body))
    // 让服务端返回明文，避免自己解压
    headers['Accept-Encoding'] = 'identity'

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? 'GET',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks)
          const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
          let text: string
          try {
            if (encoding.includes('gzip')) text = zlib.gunzipSync(raw).toString('utf8')
            else if (encoding.includes('deflate')) text = zlib.inflateSync(raw).toString('utf8')
            else if (encoding.includes('br')) text = zlib.brotliDecompressSync(raw).toString('utf8')
            else text = raw.toString('utf8')
          } catch {
            text = raw.toString('utf8')
          }

          const responseHeaders: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (value == null) continue
            responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
          }

          done({
            statusCode: response.statusCode ?? 0,
            headers: responseHeaders,
            body: text,
            location: responseHeaders.location ?? null,
          })
        })
        response.on('error', fail)
      },
    )

    request.setTimeout(options.timeout ?? DEFAULT_TIMEOUT, () => {
      request.destroy(new Error(`请求超时（${options.timeout ?? DEFAULT_TIMEOUT}ms）: ${url}`))
    })
    request.on('error', fail)

    if (body) request.write(body)
    request.end()
  })

/**
 * 发请求；默认自动跟随重定向
 *
 * @param options.followRedirect 传 false 时不跟随（用于读取短链的 Location）
 */
export const musicFetch = async (
  url: string,
  options: MusicFetchOptions = {},
): Promise<MusicResponse & { location: string | null }> => {
  const validate = options.validateStatus ?? ((s: number) => s >= 200 && s < 400)
  const follow = options.followRedirect !== false

  let currentUrl = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await requestOnce(currentUrl, options)

    const isRedirect = result.statusCode >= 300 && result.statusCode < 400 && result.location
    if (!isRedirect || !follow) {
      if (!validate(result.statusCode)) {
        throw new Error(`HTTP ${result.statusCode}: ${currentUrl}`)
      }
      return result
    }

    // 相对跳转要基于当前地址解析成绝对地址
    try {
      currentUrl = new URL(result.location as string, currentUrl).toString()
    } catch {
      throw new Error(`无法解析重定向地址: ${String(result.location)}`)
    }
  }

  throw new Error(`重定向次数过多（> ${MAX_REDIRECTS}）: ${url}`)
}

/** 解析 JSON 响应，失败时给出可读错误 */
export const musicFetchJson = async <T>(
  url: string,
  options: MusicFetchOptions = {},
): Promise<T> => {
  const response = await musicFetch(url, options)
  try {
    return JSON.parse(response.body) as T
  } catch {
    const head = response.body.slice(0, 120).replace(/\s+/g, ' ')
    throw new Error(`响应不是合法 JSON: ${url} -> ${head}`)
  }
}

/**
 * 只取一次跳转的目标地址（对应 LX 的 handleParseId）
 *
 * @returns 跳转后的 URL；没有跳转则返回原 URL
 */
export const resolveRedirect = async (url: string): Promise<string> => {
  try {
    const result = await requestOnce(url, { timeout: 10000, method: 'GET' })
    if (result.location && result.location !== url) {
      try {
        return new URL(result.location, url).toString()
      } catch {
        return result.location
      }
    }
    return url
  } catch {
    return url
  }
}
