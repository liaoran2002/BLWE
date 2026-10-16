/**
 * QQ音乐歌单解析
 *
 * 移植自 lx-music-desktop 的 src/renderer/utils/musicSdk/tx/songList.js
 *
 * 无加密，只需要带对 Referer/Origin。优先用新版 musicu.fcg 接口
 * （uniform_get_Dissinfo，返回结构化 songlist），旧接口作为兜底。
 */
import type { MusicSource, ParsedSong, PlaylistDetail } from '@common/types/musicSdk'
import { musicFetchJson, resolveRedirect } from '../http'
import { decodeName, formatPlayTime, formatSingerName, toParsedSong, withRetry } from '../utils'

const SOURCE: MusicSource = 'tx'
const LIMIT_SONG = 100000

/** 旧接口的响应形状（只用得到的字段） */
interface TxCdListResponse {
  code: number
  subcode?: number
  cdlist?: Array<{
    dissname?: string
    logo?: string
    desc?: string
    nickname?: string
    visitnum?: number
    songlist?: TxRawSong[]
  }>
}

/** 新接口 musicu.fcg 里 uniform_get_Dissinfo 的形状 */
interface TxDissInfoResponse {
  code: number
  req_1?: {
    code: number
    data?: {
      dirinfo?: {
        title?: string
        picurl?: string
        desc?: string
        host_nick?: string
        listennum?: number
      }
      songlist?: TxRawSong[]
      total_song_num?: number
    }
  }
}

interface TxRawSong {
  id?: number
  mid?: string
  title?: string
  interval?: number
  singer?: Array<{ name?: string; mid?: string }>
  album?: { name?: string; mid?: string }
}

/**
 * QQ 专辑封面 URL
 *
 * QQ 不直接在歌曲项里给封面地址，而是给专辑 mid，需要用固定的图片前缀拼。
 * 专辑名为空或「空」时退回歌手图（与 LX 的处理一致）。
 */
const getTxCover = (item: TxRawSong): string | null => {
  const albumMid = item.album?.mid
  const albumName = item.album?.name
  if (albumMid && albumName && albumName !== '空') {
    return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
  }
  const singerMid = item.singer?.[0]?.mid
  return singerMid ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${singerMid}.jpg` : null
}

/** 把 QQ 的原始歌曲项转成 ParsedSong */
const toSong = (item: TxRawSong): ParsedSong | null =>
  toParsedSong(SOURCE, {
    name: item.title,
    singer: formatSingerName(item.singer),
    // QQ 的 interval 是秒
    interval: formatPlayTime(item.interval),
    albumName: item.album?.name,
    cover: getTxCover(item),
    /**
     * QQ 的数字 id —— 平台侧的唯一标识
     *
     * 优先用它（`mid` 作为兜底）：有了它就能精确定位「歌单里的是哪一首」，
     * 不必依赖「歌名 + 歌手」这种模糊匹配（同名 live / 翻唱会撞车）。
     */
    platformId: item.id ?? item.mid ?? null,
  })

const mapSongs = (songs: TxRawSong[] | undefined): ParsedSong[] => {
  if (!Array.isArray(songs)) return []
  const result: ParsedSong[] = []
  for (const item of songs) {
    const song = toSong(item)
    if (song) result.push(song)
  }
  return result
}

/** 新版接口：一次拿全量歌单 */
const getListDetailNew = async (id: string): Promise<PlaylistDetail> => {
  const body = await musicFetchJson<TxDissInfoResponse>(
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://y.qq.com',
        Referer: `https://y.qq.com/n/yqq/playsquare/${id}.html`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        comm: {
          cv: 4747474,
          ct: 24,
          format: 'json',
          inCharset: 'utf-8',
          outCharset: 'utf-8',
          platform: 'yqq.json',
          needNewCode: 1,
          uin: 0,
        },
        req_1: {
          module: 'music.srfDissInfo.aiDissInfo',
          method: 'uniform_get_Dissinfo',
          param: {
            disstid: parseInt(id, 10),
            userinfo: 1,
            tag: 1,
            orderlist: 1,
            song_begin: 0,
            song_num: LIMIT_SONG,
            onlysonglist: 0,
            enc_host_uin: '',
          },
        },
      }),
    },
  )

  if (body.code !== 0 || body.req_1?.code !== 0 || !body.req_1.data) {
    throw new Error('QQ音乐歌单接口返回异常')
  }

  const data = body.req_1.data
  const info = data.dirinfo ?? {}
  const songs = mapSongs(data.songlist)

  return {
    info: {
      name: decodeName(info.title ?? ''),
      img: info.picurl ?? null,
      desc: decodeName(info.desc ?? ''),
      author: info.host_nick ?? null,
      playCount: info.listennum ?? null,
    },
    songs,
    total: data.total_song_num ?? songs.length,
    page: 1,
    limit: LIMIT_SONG,
    /** 平台歌单 id —— 拼 playlists.id 用（见 PlaylistDetail.listId） */
    listId: id,
    source: SOURCE,
  }
}

/** 旧接口兜底 */
const getListDetailOld = async (id: string): Promise<PlaylistDetail> => {
  const url =
    'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg' +
    `?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${id}` +
    '&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0'

  const body = await musicFetchJson<TxCdListResponse>(url, {
    headers: {
      Origin: 'https://y.qq.com',
      Referer: `https://y.qq.com/n/yqq/playsquare/${id}.html`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })

  const cdlist = body.cdlist?.[0]
  if (body.code !== 0 || !cdlist) {
    throw new Error('QQ音乐歌单接口返回异常（旧接口）')
  }

  const songs = mapSongs(cdlist.songlist)
  return {
    info: {
      name: decodeName(cdlist.dissname ?? ''),
      img: cdlist.logo ?? null,
      desc: decodeName(cdlist.desc ?? ''),
      author: cdlist.nickname ?? null,
      playCount: cdlist.visitnum ?? null,
    },
    songs,
    total: songs.length,
    page: 1,
    limit: LIMIT_SONG,
    /** 平台歌单 id —— 拼 playlists.id 用（见 PlaylistDetail.listId） */
    listId: id,
    source: SOURCE,
  }
}

/** 歌单链接 / ID -> 纯数字歌单 id */
const getListId = async (rawInput: string): Promise<string> => {
  let id = rawInput.trim()

  if (/[?&:/]/.test(id)) {
    // https://y.qq.com/n/yqq/playlist/7217720898.html
    const linkMatch = /\/playlist\/(\d+)/.exec(id)
    if (linkMatch) return linkMatch[1]

    // 移动端分享短链拿不到 id，先跟随一次跳转再匹配
    if (!/id=(\d+)/.test(id)) {
      id = await resolveRedirect(id)
    }
    const idMatch = /id=(\d+)/.exec(id)
    if (idMatch) return idMatch[1]

    const afterRedirect = /\/playlist\/(\d+)/.exec(id)
    if (afterRedirect) return afterRedirect[1]

    throw new Error('无法从该链接中解析出 QQ音乐歌单 ID，请直接粘贴歌单 ID')
  }

  if (!/^\d+$/.test(id)) {
    throw new Error('QQ音乐歌单 ID 应为纯数字')
  }
  return id
}

/** 对外入口 */
export const getListDetail = async (
  rawInput: string,
  page = 1,
): Promise<PlaylistDetail> => {
  const id = await getListId(rawInput)

  return withRetry(
    async () => {
      try {
        return await getListDetailNew(id)
      } catch (err) {
        // 新接口不灵就退回旧接口；旧接口也失败则把错误抛给 withRetry 重试
        try {
          return await getListDetailOld(id)
        } catch {
          throw err
        }
      }
    },
    2,
    'QQ音乐歌单解析',
  ).then((detail) => ({ ...detail, page }))
}
