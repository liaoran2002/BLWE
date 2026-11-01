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
 *    本项目的歌单只用来喂某站搜索，所以全部砍掉，只保留 歌名/歌手/时长。
 */

/** 支持的音源（与 LX 的 source key 保持一致） */
export type MusicSource = 'wy' | 'tx' | 'kw' | 'kg'

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
   * **平台侧歌曲 id**（QQ 的数字 id / wy 的 id / kw 的 rid…）
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

/** 歌单解析结果（**音源原始形态**：`songs` 里是 `ParsedSong`） */
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
  /**
   * ★ **平台侧歌单 id**（QQ 的 `disstid` / wy 的 `id` / kw 的 `rid`）
   *
   * 用途：让上层拼出歌单主键 `平台_平台歌单id`（如 `tx_8153225605`）。
   *
   * ⚠️ 为什么主键不用随机 UUID：
   *  - 同一个歌单重复导入会**命中同一行**，而不是攒出一堆副本；
   *  - 重启 / 换机器后靠 `sourceUrl` 能推出同一个 id，不会认成新歌单。
   *
   * 几个音源都在 `getListId()` 里解析过它 —— 这里把它带出来。
   *
   * ⚠️ **不要把这个字段直接交给渲染层去拼主键** ——
   * 拼装由主进程做（见 `music:getPlaylistDetail` 返回的 `id`）。
   */
  listId: string
}

/** IPC 入参 */
export interface GetPlaylistDetailParams {
  /** 歌单链接或歌单 ID；wy 支持 `链接###token` 形式 */
  input: string
  /** 不传则根据链接自动识别音源 */
  source?: MusicSource
  /** 页码，从 1 开始 */
  page?: number
}
