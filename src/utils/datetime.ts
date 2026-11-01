/**
 * 时间显示
 *
 * 目前只有「上次同步」用得到，但它是两个管理器里逐字重复的两份实现
 * （歌单那边收 `PlaylistRecord`、视频那边收时间戳，展开方式完全一样）。
 */

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))

/**
 * 时间戳（毫秒）→ `2026-11-01 15:20`
 *
 * `null` / `0` 一律当「从未」：这两个字段的空值语义是「没发生过」，
 * 而不是 1970 年 —— 直接格式化会显示成 `1970-01-01 08:00`，比不显示还怪。
 *
 * 刻意不用 `toLocaleString`：它跟着系统区域走，同一个界面在别人机器上会变成
 * `11/1/2026, 3:20 PM`，和旁边「上次同步：」这种中文标签拼在一起很违和。
 */
export const formatSyncTime = (at: number | null | undefined): string => {
  if (!at) return '从未'
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
