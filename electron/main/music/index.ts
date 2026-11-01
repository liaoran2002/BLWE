/**
 * 音乐歌单解析入口（按音源分发）
 *
 * 对应 LX 的 src/renderer/utils/musicSdk/index.js 那张「总表」，
 * 但这里跑在主进程，并通过 IPC 暴露给渲染进程。
 *
 * 与 LX 的一个改进：LX 让用户在「打开歌单」弹窗里手选音源；
 * 本项目只有一个输入框，所以增加了**按分享链接的 host 自动识别音源**，
 * 识别不出来时才要求调用方显式指定。
 */
import type {
  GetPlaylistDetailParams,
  MusicSource,
  ParsedSong,
  PlaylistDetail,
} from '@common/types/musicSdk'
import { detectSource } from './utils'
import * as tx from './sources/tx'
import * as wy from './sources/wy'
import * as kw from './sources/kw'

/** 已接入的音源表 */
const SOURCES = {
  tx,
  wy,
  kw,
} as const

type SupportedSource = keyof typeof SOURCES

/** 当前支持自动/手动解析的音源列表 */
const SUPPORTED_SOURCES = Object.keys(SOURCES) as SupportedSource[]

export { detectSource }

/**
 * 判断音源是否已接入
 *
 * kg(kg) 在类型里是合法音源，但本版本尚未移植其解析实现，
 * 这里显式挡掉，避免传入后抛「undefined is not a function」这种莫名错误。
 */
const isSupported = (source: MusicSource): source is SupportedSource =>
  source in SOURCES

/**
 * 解析歌单
 *
 * @param params.input  歌单分享链接或歌单 ID（wy 支持 `链接###token`）
 * @param params.source 不传则按链接 host 自动识别
 * @param params.page   页码，默认 1
 */
export const resolvePlaylist = async (
  params: GetPlaylistDetailParams,
): Promise<PlaylistDetail> => {
  const input = (params.input ?? '').trim()
  if (!input) throw new Error('歌单链接不能为空')

  let source = params.source
  if (!source) {
    const detected = detectSource(input)
    if (!detected) {
      // 纯数字 ID 无法判断属于哪个平台（各平台的数字 ID 都是纯数字）
      // 这与 LX 的行为一致：LX 也是让用户在弹窗里手选音源
      if (/^\d+$/.test(input)) {
        throw new Error(
          '只填数字 ID 无法判断是哪个音乐平台。请直接粘贴歌单的分享链接，或在链接后面带上平台信息',
        )
      }
      throw new Error(
        `无法识别这个链接属于哪个音乐平台。目前支持 ${SUPPORTED_SOURCES.join(' / ')} 的歌单分享链接`,
      )
    }
    source = detected
  }

  if (!isSupported(source)) {
    // 界面上只用短码（wy / tx / kw），不出现平台全名
    throw new Error(
      `${source} 的歌单解析尚未接入（当前已支持：${SUPPORTED_SOURCES.join(' / ')}）`,
    )
  }

  const page = params.page && params.page > 0 ? params.page : 1
  return SOURCES[source].getListDetail(input, page)
}

// #region 单曲

/**
 * 能解析单曲的音源
 *
 * 和 `SOURCES` 分开是因为**能力不一样**：kw（以及未接入的 kg）只有
 * 「这链接是不是单曲」的判断，没有单曲详情接口 —— 混在一张表里会让
 * `SOURCES[source].getSongDetail` 在类型上变成「可能不存在」。
 */
const SONG_SOURCES = { tx, wy } as const

type SupportedSongSource = keyof typeof SONG_SOURCES

const isSongSupported = (source: MusicSource): source is SupportedSongSource =>
  source in SONG_SOURCES

/**
 * 这个音乐链接是**歌单**还是**单曲**
 *
 * 放在这里而不是 `dropInput.ts`，是因为「怎么认」和「怎么解析」必须是同一份知识：
 * 判断写在识别层、解析写在音源层，两边迟早会漂（`dropInput.ts` 顶部那段注释
 * 讲的就是这件事，只是那次漂在渲染层）。
 *
 * @returns `null` = 不是音乐平台的链接
 */
export const classifyMusicInput = (raw: string): 'playlist' | 'song' | null => {
  const source = detectSource(raw)
  if (!source) return null
  /**
   * 未接入的音源（kg）一律当歌单：真去导入时那边会报「XX 的歌单解析尚未接入」，
   * 比这里说「没认出这是什么」准确 —— 链接明明是认得的，只是还没做。
   */
  if (!isSupported(source)) return 'playlist'
  return SOURCES[source].isSongUrl(raw) ? 'song' : 'playlist'
}

/**
 * 解析**单曲**（拖入单曲链接用）
 *
 * 拿到的只是一首歌的元信息（歌名 / 歌手 / 时长 / 封面）。
 * 播放不走这里 —— 和歌单里的每一首歌一样，真正播的是某站上搜到的那支 MV。
 */
export const resolveSong = async (
  input: string,
): Promise<{ song: ParsedSong; source: MusicSource }> => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('歌曲链接不能为空')

  const source = detectSource(raw)
  if (!source) {
    throw new Error(
      `无法识别这个链接属于哪个音乐平台。目前支持 ${Object.keys(SOURCES).join(' / ')} 的单曲链接`,
    )
  }
  if (!isSongSupported(source)) {
    throw new Error(
      `${source} 的单曲链接还没接入。可以拖歌单链接，或在歌单管理里手动添加这首歌`,
    )
  }

  const id = SONG_SOURCES[source].getSongId(raw)
  const song = await SONG_SOURCES[source].getSongDetail(id)
  if (!song) throw new Error('没取到这首歌的信息（可能已下架、或需要会员）')
  return { song, source }
}

// #endregion
