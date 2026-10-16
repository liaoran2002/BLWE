/**
 * 缓存统计类型（主 / 渲染共用）
 *
 * 数据层换成 SQLite 之后口径变了：不再是「缓存文件数」，
 * 而是 `videos` 表里的**视频条数**与按文本长度估算的占用。
 * 字段名保持不变是为了不动界面那几处调用。
 */
export interface CacheStats {
  /** 缓存里的视频条数（不是关键词个数 / 文件数） */
  count: number
  /**
   * 占用字节数（**近似值**）
   *
   * 按播放地址那几列（`durl_url` / `dash_video` / `dash_audio`）的字符数估算：
   * SQLite 的真实占用要查 `dbstat`（需要编译选项），代价高且不稳；
   * 而这里只需回答「缓存有多大」。
   *
   * ⚠️ `quality` / `support_formats` 两列已在 schema v4 删除，
   * 所以不在估算范围内（这两列本来就很小，影响可忽略）。
   */
  bytes: number
}
