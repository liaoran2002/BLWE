/**
 * 酷我音乐歌单解析
 *
 * 移植自 lx-music-desktop 的 src/renderer/utils/musicSdk/kw/songList.js
 *
 * 无加密。歌单详情走 nplserver.kuwo.cn/pl.svc，
 * 支持三种输入：歌单链接、纯数字歌单 ID、`digest-<digest>__<id>` 形式。
 *
 * 精简说明：LX 还处理「波点(BD)」链接（h5app.kuwo.cn/m/bodian/...）与专辑(digest 13)，
 * 这两类在本项目用不到，故未移植；遇到时会给出明确报错而不是静默失败。
 */
import type { MusicSource, ParsedSong, PlaylistDetail } from '@common/types/musicSdk'
import { musicFetchJson } from '../http'
import { decodeName, formatPlayTime, formatSingerName, toParsedSong, withRetry } from '../utils'

const SOURCE: MusicSource = 'kw'
const LIMIT_SONG = 1000

interface KwListDetailResponse {
  result?: string
  title?: string
  pic?: string
  info?: string
  uname?: string
  playnum?: string | number
  total?: string | number
  rn?: string | number
  musiclist?: KwRawSong[]
}

interface KwRawSong {
  id?: string | number
  name?: string
  artist?: string
  album?: string
  duration?: string | number
  /** 形如 `level:ff,bitrate:2000,format:flac,size:30.5MB;...` */
  N_MINFO?: string
}

/** 链接里的歌单 id */
const LIST_DETAIL_LINK = /^.+\/playlist(?:_detail)?\/(\d+)(?:\?.*|&.*$|#.*$|$)/

/** 把 `digest-5__123456` 拆成 { digest, id } */
const parseDigestId = (input: string): { digest: string; id: string } | null => {
  if (!input.startsWith('digest-')) return null
  const [head, id] = input.split('__')
  if (!id) return null
  return { digest: head.replace('digest-', ''), id }
}

/**
 * 歌单链接 / ID -> 纯数字歌单 id
 */
const getListId = (rawInput: string): string => {
  const input = rawInput.trim()

  // 波点分享链接：本项目未移植，明确报错
  if (/\/bodian\//.test(input)) {
    throw new Error('暂不支持酷我「波点」类型的分享链接，请改用普通歌单链接或歌单 ID')
  }

  const digest = parseDigestId(input)
  if (digest) {
    if (digest.digest === '13') {
      throw new Error('暂不支持酷我专辑链接，请改用歌单链接')
    }
    // digest 5 / 8 都能落到同一个歌单详情接口
    return digest.id
  }

  if (/[?&:/]/.test(input)) {
    const match = LIST_DETAIL_LINK.exec(input)
    if (!match) {
      throw new Error('无法从该链接中解析出酷我歌单 ID，请直接粘贴歌单 ID')
    }
    return match[1]
  }

  if (!/^\d+$/.test(input)) {
    throw new Error('酷我歌单 ID 应为纯数字')
  }
  return input
}

const getListDetailUrl = (id: string, page: number): string =>
  'http://nplserver.kuwo.cn/pl.svc?op=getlistinfo' +
  `&pid=${id}&pn=${page - 1}&rn=${LIMIT_SONG}` +
  '&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1'

const mapSongs = (songs: KwRawSong[] | undefined): ParsedSong[] => {
  if (!Array.isArray(songs)) return []
  const result: ParsedSong[] = []
  for (const item of songs) {
    const song = toParsedSong(SOURCE, {
      name: decodeName(item.name),
      // 酷我返回的 singer 字段名是 artist
      singer: formatSingerName(decodeName(item.artist)),
      interval: formatPlayTime(parseInt(String(item.duration ?? ''), 10)),
      albumName: decodeName(item.album),
      // 酷我列表接口不返回封面，这里留空（播放时用视频封面兜底）
      cover: null,
      /** 酷我的歌曲 rid —— 取歌词要用它 */
      platformId: item.id ?? null,
    })
    if (song) result.push(song)
  }
  return result
}

/** 对外入口 */
export const getListDetail = async (
  rawInput: string,
  page = 1,
): Promise<PlaylistDetail> => {
  const id = getListId(rawInput)

  return withRetry(
    async () => {
      const body = await musicFetchJson<KwListDetailResponse>(getListDetailUrl(id, page), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      })

      if (body.result !== 'ok') {
        throw new Error('酷我歌单接口返回异常')
      }

      const songs = mapSongs(body.musiclist)
      if (songs.length === 0) {
        throw new Error('该酷我歌单没有解析到任何歌曲（歌单可能为空或已失效）')
      }

      return {
        info: {
          name: decodeName(body.title ?? ''),
          img: body.pic ?? null,
          desc: body.info ?? null,
          author: body.uname ?? null,
          playCount: body.playnum ?? null,
        },
        songs,
        total: Number(body.total ?? songs.length),
        page,
        limit: Number(body.rn ?? LIMIT_SONG),
        source: SOURCE,
      }
    },
    2,
    '酷我歌单解析',
  )
}
