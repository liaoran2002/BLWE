/**
 * 图片地址规整（渲染进程）
 *
 * 踩坑背景：B 站的缩略图字段是**协议相对 URL**（`//i0.hdslb.com/xxx.png`）。
 * 打包后页面是用 `file://` 加载的，相对协议会被解析成 `file://i0.hdslb.com/xxx.png`，
 * 后果是：
 *   1. 图片实际加载不出来
 *   2. 系统媒体控件（SMTC）直接拒绝该 artwork
 *      （报 "MediaImage src can only be of http/https/data/blob scheme"）
 *   3. 把它写进缓存后再拿去解析视频地址会抛 DOMException
 *
 * 所以所有要展示/传出去的图片地址都必须先经过这里规整成绝对 https。
 */
export const normalizeImageUrl = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  const url = String(raw).trim()
  if (!url) return null
  // 协议相对：//host/path -> https://host/path
  if (url.startsWith('//')) return `https:${url}`
  // http 升级到 https，避免混合内容被拦
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`
  // 正常 https 直接用
  if (url.startsWith('https://')) return url
  // data: / blob: 也可以直接给系统用
  if (url.startsWith('data:') || url.startsWith('blob:')) return url
  // 其余（例如已经被错误解析成 file://xxx）尝试补回 https
  const stripped = url.replace(/^file:\/\//, '')
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(stripped)) return `https://${stripped}`
  return null
}
