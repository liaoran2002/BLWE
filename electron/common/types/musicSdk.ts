/**
 * 音乐平台歌单解析 —— 主 / 渲染共用类型
 *
 * 移植自 lx-music-desktop 的 src/renderer/utils/musicSdk/<source>/songList.js
 *
 * 与 LX 的差异（重要）：
 *  - LX 的 SDK 跑在渲染进程并直接用 crypto / Buffer / needle；
 *    本项目是 contextIsolation + nodeIntegration:false，
 *    所以解析逻辑放在**主进程**，渲染进程只通过 IPC 拿结果。
 *  - LX 的歌曲对象里 qualitys/_qualitys/typeUrl 等字段是「取播放地址」用的，
 *    本项目的歌单只用来喂 B 站搜索，所以全部砍掉，只保留 歌名/歌手/时长。
 */

/** 支持的音源（与 LX 的 source key 保持一致） */
export type MusicSource = 'wy' | 'tx' | 'kw' | 'kg'

/** 音源显示名 */
export const MUSIC_SOURCE_NAMES: Record<MusicSource, string> = {
  wy: '网易云音乐',
  tx: 'QQ音乐',
  kw: '酷我音乐',
  kg: '酷狗音乐',
}

/**
 * 解析出来的一首歌（归一化后的精简结构）
 *
 * 只保留歌单导入需要的字段：歌名 + 歌手 + 时长，
 * 外加**平台侧歌曲 id**（见下）。
 */
export interface ParsedSong {
  /** 歌名 */
  name: string
  /** 歌手，多个用「、」连接 */
  singer: string
  /** 时长 mm:ss，拿不到时为 null */
  interval: string | null
  /** 专辑名 */
  albumName?: string
  /** 封面图 URL（各平台专辑封面） */
  cover?: string | null
  /** 来源音源 */
  source: MusicSource
  /**
   * **平台侧歌曲 id**（QQ 的数字 id / 网易云的 id / 酷我的 rid…）
   *
   * 为什么要留它：**取歌词必须要这个 id**。不留的话，取歌词得拿
   * 「歌名 + 歌手」再去平台搜一次 —— 而那是模糊搜索，可能搜到**别的版本**
   * （同名不同编曲、live 版、翻唱），于是显示错误的歌词。
   *
   * 有这个 id 就能精确定位到**用户歌单里那一首**，也省一次搜索。
   */
  platformId?: string | null
}

/** 歌单元信息 */
export interface PlaylistInfo {
  name: string
  img?: string | null
  author?: string | null
  desc?: string | null
  playCount?: string | number | null
}

/** 歌单解析结果 */
export interface PlaylistDetail {
  /** 歌单元信息 */
  info: PlaylistInfo
  /** 归一化后的歌曲列表 */
  songs: ParsedSong[]
  /** 总曲目数（可能大于 songs.length，视分页而定） */
  total: number
  /** 当前页 */
  page: number
  /** 每页数量 */
  limit: number
  /** 来源音源 */
  source: MusicSource
}

/** IPC 入参 */
export interface GetPlaylistDetailParams {
  /** 歌单链接或歌单 ID；网易云支持 `链接###token` 形式 */
  input: string
  /** 不传则根据链接自动识别音源 */
  source?: MusicSource
  /** 页码，从 1 开始 */
  page?: number
}
