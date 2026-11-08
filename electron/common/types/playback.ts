/**
 * 播放状态（**不是设置**）
 *
 * 「上次在播哪条线的哪个列表」和「那个列表播到第几条第几秒」都属于运行时状态，
 * 所以它们落在数据库里，而不是 `setting.json`：
 *
 *  - `playback_state` 单行表 + `playlists` / `videolists` 各自的 `last_index` 回答「谁、第几条」；
 *  - `userData/last_position` 一个小文件回答「第几秒」（它每秒都变，不值得写库）。
 *
 * 以前这两件事被切成两半：视频列表 id 塞进设置项 `player.activeVideoListId`（会落盘），
 * 而「当前歌单」只存主进程内存（重启就回到第一个歌单）。于是视频能续播、歌不能 ——
 * 这里把它合成一个概念，两条线共用同一套读写。
 */

/** 播放源类型：`ov` = 某站视频列表，`mv` = 音乐歌单 */
export type PlaybackSourceKind = 'ov' | 'mv'

export interface PlaybackSource {
  /** 空串 = 没有在播的源（全新库 / 用户清空过） */
  kind: PlaybackSourceKind | ''
  /** `videolists.id` 或 `playlists.id` */
  id: string
  /**
   * 上次播到第几秒
   *
   * **不在库里**，来自 `userData/last_position` 那个小文件 —— 它是一条全局的
   * 「当前播放位置」，换列表就该被下一次播放覆盖，没必要按列表各存一份。
   */
  seconds: number
}

/**
 * 一次「切到哪一条」的上报
 *
 * 没有秒数：那个每秒都在变，走 `saveLastPosition` 的小文件；
 * 下标只在切歌时变，才值得写库（一行 UPDATE）。
 */
export interface PlaybackProgress {
  kind: PlaybackSourceKind
  id: string
  /** 播到第几条（下标） */
  index: number
}
