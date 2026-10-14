/**
 * 网易云音乐歌单解析
 *
 * 移植自 lx-music-desktop 的 src/renderer/utils/musicSdk/wy/songList.js
 *
 * 走 linuxapi 加密通道（AES-128-ECB），接口：
 *   POST https://music.163.com/api/linux/forward
 *   params: linuxapi({ method, url: 'https://music.163.com/api/v3/playlist/detail', params: { id, n, s } })
 *
 * 精简说明：
 *  - LX 在 `trackIds.length != privileges.length` 时会改用 weapi 的 song/detail 逐个补全。
 *    本项目只需要 歌名/歌手/时长，而 playlist/detail 的 `tracks` 已包含这些字段，
 *    所以直接用 tracks；只有在 tracks 为空时才回退到 song/detail（该接口用旧版明文 API，无需加密）。
 *  - 支持 `链接###token` 形式注入 MUSIC_U（部分歌单如「私人雷达」需要）。
 */
import type { MusicSource, ParsedSong, PlaylistDetail } from '@common/types/musicSdk'
import { musicFetchJson, resolveRedirect } from '../http'
import { decodeName, formatPlayTime, formatSingerName, toParsedSong, withRetry } from '../utils'
import { linuxapi, weapi } from './wyCrypto'

const SOURCE: MusicSource = 'wy'
const LIMIT_SONG = 100000

// #region 响应类型

interface WySong {
  id?: number | string
  name?: string
  /** 新版字段名 */
  ar?: Array<{ name?: string }>
  al?: { name?: string; picUrl?: string; id?: number | string }
  dt?: number
  /** 部分返回体使用旧字段名 */
  artists?: Array<{ name?: string }>
  album?: { name?: string; picUrl?: string; id?: number | string }
  duration?: number
}

interface WyTrackId {
  id?: number | string
}

interface WyPlaylistDetailResponse {
  code: number
  playlist?: {
    name?: string
    coverImgUrl?: string
    description?: string
    playCount?: number
    creator?: { nickname?: string }
    tracks?: WySong[]
    trackIds?: Array<WyTrackId | number | string>
  }
}

interface WySongDetailResponse {
  code: number
  songs?: WySong[]
}

// #endregion

/** 取时长（毫秒 -> mm:ss），兼容 dt / duration 两种字段名 */
const getInterval = (song: WySong): string | null => {
  const ms = song.dt ?? song.duration
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  return formatPlayTime(ms / 1000)
}

const getSingers = (song: WySong): string => {
  const list = song.ar ?? song.artists
  return Array.isArray(list)
    ? formatSingerName(list)
    : ''
}

const getAlbumName = (song: WySong): string | undefined => song.al?.name ?? song.album?.name

/** 网易云专辑封面 */
const getCover = (song: WySong): string | null =>
  song.al?.picUrl ?? song.album?.picUrl ?? null

/** 把网易云的歌曲项转成 ParsedSong */
const toSong = (song: WySong): ParsedSong | null =>
  toParsedSong(SOURCE, {
    name: song.name,
    singer: getSingers(song),
    interval: getInterval(song),
    albumName: getAlbumName(song),
    cover: getCover(song),
    /** 网易云的歌曲 id —— 取歌词（以及落月 API 的 `id` 参数）都要它 */
    platformId: song.id ?? null,
  })

const mapSongs = (songs: WySong[] | undefined): ParsedSong[] => {
  if (!Array.isArray(songs)) return []
  const result: ParsedSong[] = []
  for (const item of songs) {
    const song = toSong(item)
    if (song) result.push(song)
  }
  return result
}

/** 歌单链接 / ID -> 纯数字歌单 id（并拆出可选 token） */
const getListId = async (
  rawInput: string,
): Promise<{ id: string; token: string | null }> => {
  let input = rawInput.trim()
  let token: string | null = null

  // 私人雷达等歌单需要 `链接###token` 注入 MUSIC_U
  if (input.includes('###')) {
    const [url, ...rest] = input.split('###')
    input = url.trim()
    token = rest.join('###').trim() || null
  }

  // https://music.163.com/#/playlist?id=11332&userid=123456
  const idParam = /^.+(?:\?|&)id=(\d+)(?:&.*$|#.*$|$)/.exec(input)
  if (idParam) return { id: idParam[1], token }

  // https://music.163.com/playlist/123/456/
  const pathId = /^.+\/playlist\/(\d+)\/\d+\/.+$/.exec(input)
  if (pathId) return { id: pathId[1], token }

  if (/[?&:/]/.test(input)) {
    // 短链：先跟随跳转，再从最终地址里取 id
    const resolved = await resolveRedirect(input)
    const fromResolved = /^.+(?:\?|&)id=(\d+)(?:&.*$|#.*$|$)/.exec(resolved)
    if (fromResolved) return { id: fromResolved[1], token }
    const fromResolvedPath = /^.+\/playlist\/(\d+)\/\d+\/.+$/.exec(resolved)
    if (fromResolvedPath) return { id: fromResolvedPath[1], token }
    if (/^\d+$/.test(resolved)) return { id: resolved, token }
    throw new Error('无法从该链接中解析出网易云歌单 ID，请直接粘贴歌单 ID')
  }

  if (!/^\d+$/.test(input)) {
    throw new Error('网易云歌单 ID 应为纯数字')
  }
  return { id: input, token }
}

/**
 * 通过 weapi 加密通道请求歌单详情
 *
 * 用这条通道的原因：新版 `/weapi/v6/playlist/detail` 会返回**全量** tracks
 * （含歌名/歌手/时长），而 linuxapi 的 `/api/v3/playlist/detail`
 * 在未登录时经常只给 10 首精简数据，导致歌单被截断。
 */
const fetchPlaylistDetailWeapi = async (
  id: string,
  token: string | null,
): Promise<WyPlaylistDetailResponse> => {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://music.163.com/',
    Origin: 'https://music.163.com',
  }
  // 与 LX 一致：默认带一个空的 MUSIC_U，注入 token 时替换成真实值
  headers.Cookie = `MUSIC_U=${token ?? ''}`

  return musicFetchJson<WyPlaylistDetailResponse>(
    'https://music.163.com/weapi/v6/playlist/detail',
    {
      method: 'POST',
      headers,
      // weapi 要求 params + encSecKey 两个字段
      form: weapi({
        id,
        n: LIMIT_SONG,
        s: 8,
        csrf_token: '',
      }),
    },
  )
}

/** linuxapi 通道（兜底） */
const fetchPlaylistDetailLinux = async (
  id: string,
  token: string | null,
): Promise<WyPlaylistDetailResponse> => {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
    Referer: 'https://music.163.com/',
    Origin: 'https://music.163.com',
  }
  headers.Cookie = `MUSIC_U=${token ?? ''}`

  return musicFetchJson<WyPlaylistDetailResponse>(
    'https://music.163.com/api/linux/forward',
    {
      method: 'POST',
      headers,
      form: linuxapi({
        method: 'POST',
        url: 'https://music.163.com/api/v3/playlist/detail',
        params: { id, n: LIMIT_SONG, s: 8 },
      }),
    },
  )
}

/** 先走 weapi，拿不到有效数据再退 linuxapi */
const fetchPlaylistDetail = async (
  id: string,
  token: string | null,
): Promise<WyPlaylistDetailResponse> => {
  try {
    const viaWeapi = await fetchPlaylistDetailWeapi(id, token)
    if (viaWeapi.code === 200 && viaWeapi.playlist) return viaWeapi
  } catch {
    /* 落到 linuxapi */
  }
  return fetchPlaylistDetailLinux(id, token)
}

/**
 * 兜底：用旧版明文 song/detail 接口按 id 批量补全歌曲信息
 *
 * 该接口不需要加密，因此可以独立于 linuxapi 通道使用。
 */
const fetchSongDetail = async (ids: string[]): Promise<ParsedSong[]> => {
  if (ids.length === 0) return []
  const bodies: ParsedSong[] = []
  // 接口对 ids 长度有限制，分批取，每批 500
  const BATCH = 500
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const params = new URLSearchParams({
      ids: `[${batch.join(',')}]`,
      br: '128000',
    })
    const body = await musicFetchJson<WySongDetailResponse>(
      'https://music.163.com/api/song/detail',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://music.163.com/',
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
        },
        body: params.toString(),
      },
    )
    if (body.code !== 200) throw new Error('网易云歌曲详情接口返回异常')
    bodies.push(...mapSongs(body.songs))
  }
  return bodies
}

/** 对外入口 */
export const getListDetail = async (
  rawInput: string,
  page = 1,
): Promise<PlaylistDetail> => {
  const { id, token } = await getListId(rawInput)

  return withRetry(
    async () => {
      const body = await fetchPlaylistDetail(id, token)
      if (body.code !== 200 || !body.playlist) {
        throw new Error(`网易云歌单接口返回异常（code=${body.code}）`)
      }

      const playlist = body.playlist
      let songs = mapSongs(playlist.tracks)

      /**
       * 关键兜底：网易云在未登录/被裁剪时，`tracks` 可能只有 10 首，
       * 而 `trackIds` 才是完整的曲目清单。
       * （实测 linuxapi 通道就是这种情况，所以数量对不上时必须按 trackIds 补全，
       *   否则会把 200 首的歌单静默截断成 10 首。）
       */
      const trackIds = playlist.trackIds ?? []
      if (songs.length < trackIds.length) {
        const ids = trackIds
          .map((item) =>
            typeof item === 'object' && item !== null
              ? String((item as WyTrackId).id ?? '')
              : String(item),
          )
          .filter((value) => /^\d+$/.test(value))
        try {
          const full = await fetchSongDetail(ids)
          // 只有在补全结果更完整时才采用，避免接口异常反而把数据变少
          if (full.length > songs.length) songs = full
        } catch {
          // 补全失败就沿用已拿到的部分，至少不是完全失败
        }
      }

      if (songs.length === 0) {
        throw new Error('该网易云歌单没有解析到任何歌曲（歌单可能为空、已失效或需要 Token）')
      }

      return {
        info: {
          name: decodeName(playlist.name ?? ''),
          img: playlist.coverImgUrl ?? null,
          desc: playlist.description ?? null,
          author: playlist.creator?.nickname ?? null,
          playCount: playlist.playCount ?? null,
        },
        songs,
        total: trackIds.length || songs.length,
        page,
        limit: LIMIT_SONG,
        source: SOURCE,
      }
    },
    2,
    '网易云歌单解析',
  )
}
