/**
 * 音乐歌单解析共用工具
 *
 * 对应 LX 的：
 *   src/renderer/utils/musicSdk/utils.ts -> formatSingerName
 *   src/renderer/utils/index.ts          -> formatPlayTime / decodeName
 *
 * 注意 decodeName：LX 用的是渲染进程的 `new DOMParser().parseFromString(str, 'text/html')`，
 * 主进程没有 DOM，所以这里改用一份手写的 HTML 实体解码（覆盖常见实体 + 数字实体），
 * 不再引入第三方依赖。
 */
import type { MusicSource, ParsedSong } from '@common/types/musicSdk'

/**
 * 秒 -> mm:ss
 *
 * @param time 秒数
 * @returns mm:ss；无效输入返回 null
 */
export const formatPlayTime = (time: number | string | null | undefined): string | null => {
  const seconds = Number(time)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const m = Math.trunc(seconds / 60)
  const s = Math.trunc(seconds % 60)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${pad(m)}:${pad(s)}`
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}

/**
 * 解码 HTML 实体（替换 LX 里的 DOMParser 实现）
 *
 * 覆盖 `&amp;` `&#39;` `&#x27;` 这类常见写法；
 * 不认识的实体原样保留，避免把内容改坏。
 */
export const decodeName = (str: string | null | undefined): string => {
  if (str == null) return ''
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X'
      const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(code)) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()]
    return named ?? match
  })
}

/**
 * 格式化歌手名（对应 LX 的 formatSingerName）
 *
 * 兼容多种入参形态：
 *  - 字符串：直接解码
 *  - `[{ name }]`（网易/QQ/kg 的常见形态）
 *  - `['张三', '李四']`（纯字符串数组）
 *  - `[{ name: '' }]`：空名会被跳过
 *
 * @param singers 歌手数组或字符串
 * @param join 多个歌手的连接符
 */
export const formatSingerName = (
  singers: unknown,
  join = '、',
  nameKey = 'name',
): string => {
  if (Array.isArray(singers)) {
    const names: string[] = []
    for (const item of singers) {
      if (item == null) continue
      if (typeof item === 'string') {
        if (item) names.push(item)
        continue
      }
      if (typeof item === 'object') {
        const name = (item as Record<string, unknown>)[nameKey]
        if (typeof name === 'string' && name) names.push(name)
      }
    }
    return decodeName(names.join(join))
  }
  return decodeName(singers == null ? '' : String(singers))
}

/** 从 URL 里安全取出 host（取不到返回空串） */
const getHost = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 根据分享链接自动识别音源
 *
 * 注意：不能只看 `id=` 参数 —— wy 和 kw 的链接都带 `id=`，
 * QQ 的移动端分享链接也带 `id=`，所以必须以 host 为准来判定。
 *
 * @returns 识别到的音源；无法识别返回 null
 */
export const detectSource = (input: string): MusicSource | null => {
  const text = input.trim()
  /**
   * kw 的 `digest-<n>__<id>` 是「链接被压缩过」的形式（分享出来的短串），
   * 它既不含 `?&:/` 也不以字母开头以外的东西为线索，但前缀能确定是 kw：
   * 不特判的话下面那行会直接 return null，kw 那条已经写好的解析分支永远走不到。
   */
  if (/^digest-\d+__\d+$/.test(text)) return 'kw'
  // 纯数字 / 其它 digest 形式：信息不足，交给调用方指定音源
  if (!/[a-zA-Z]/.test(text) || !/[?&:/]/.test(text)) return null

  const host = getHost(text)
  if (!host) return null

  if (host.endsWith('music.163.com') || host.endsWith('163cn.tv')) return 'wy'
  if (host.endsWith('y.qq.com') || host.endsWith('qq.com') || host.endsWith('qqmusic.qq.com')) {
    return 'tx'
  }
  if (host.endsWith('kuwo.cn')) return 'kw'
  if (host.endsWith('kugou.com')) return 'kg'
  return null
}

/**
 * 把各音源解析出的原始字段归一化成 ParsedSong
 *
 * 只保留歌单导入需要的 歌名 / 歌手 / 时长。
 */
export const toParsedSong = (
  source: MusicSource,
  raw: {
    name?: unknown
    singer?: unknown
    interval?: unknown
    albumName?: unknown
    cover?: unknown
    /** 平台侧歌曲 id —— 取歌词要用它精确定位（见 ParsedSong.platformId 的注释） */
    platformId?: unknown
  },
): ParsedSong | null => {
  const name = decodeName(raw.name == null ? '' : String(raw.name)).trim()
  if (!name) return null
  const cover =
    typeof raw.cover === 'string' && raw.cover.trim() ? raw.cover.trim() : null
  return {
    name,
    singer: formatSingerName(raw.singer),
    interval: typeof raw.interval === 'string' ? raw.interval : null,
    albumName: raw.albumName == null ? undefined : decodeName(String(raw.albumName)),
    cover,
    source,
    platformId:
      raw.platformId == null || raw.platformId === '' ? null : String(raw.platformId),
  }
}

/**
 * 统一的重试封装
 *
 * LX 里每个源都写了 `if (tryNum > 2) return this.xxx(++tryNum)`，
 * 这里抽成一个工具，语义保持一致。
 */
export const withRetry = async <T>(
  task: (attempt: number) => Promise<T>,
  maxRetry = 2,
  label = 'request',
): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await task(attempt)
    } catch (err) {
      lastError = err
      // 最后一次失败不再等待，直接抛出
      if (attempt < maxRetry) await new Promise((r) => setTimeout(r, 300))
    }
  }
  throw new Error(`${label} 重试 ${maxRetry} 次后仍失败: ${(lastError as Error)?.message ?? ''}`)
}
