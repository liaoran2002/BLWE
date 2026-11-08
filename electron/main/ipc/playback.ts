/**
 * 播放状态 IPC
 *
 * 四条：读「上次在播谁」、切源、上报「第几条」（写库）、上报「第几秒」（写文件）。
 * 写进度只有一个入口（`playback:progress`），两条来源（视频列表 / 歌单）共用 ——
 * 以前视频走 `videolists:setIndex`、歌单走 `playlists:save` 全量覆盖，两套写法。
 */
import { mainHandle } from '@common/mainIpc'
import {
  getPlaybackSource,
  saveLastPosition,
  saveProgress,
  setPlaybackSource,
} from '../utils/playback'

export const registerPlaybackHandlers = (): void => {
  mainHandle('playback:get', () => getPlaybackSource())

  mainHandle('playback:setSource', ({ kind, id }) => setPlaybackSource(kind, id))

  mainHandle('playback:progress', (params) => saveProgress(params))

  /** 每秒一次：只写 userData/last_position 那个小文件，不碰库 */
  mainHandle('playback:position', ({ seconds }) => saveLastPosition(seconds))
}
