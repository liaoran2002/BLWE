/**
 * 标题净化
 *
 * B 站搜索接口会在标题里用 `<em class="keyword">` 高亮命中的关键词，这个高亮要保留，
 * 所以界面上用的是 `v-html`。但标题本身是**第三方数据**（视频标题由 UP 主随便写），
 * 直接 v-html 等于给了一个注入点 —— `<img src=x onerror=...>` 这类能直接跑脚本。
 *
 * 做法：先把整串转义，再把**仅有的 `<em>` / `</em>`** 还原回去。
 * 这样既留住高亮，其余一切标签都会被当作文本显示。
 *
 * 注意：转义后属性里的引号会变成 `&quot;`，所以匹配属性时**必须允许 `&`**
 * （用 `[\s\S]*?`），否则 `<em class="keyword">` 这种带属性的开标签会匹配不上，
 * 只剩闭标签被还原，反而产生破损 HTML。
 *
 * 之前这份逻辑只写在 `SongVideoListDialog.vue` 里（那个文件是净化过的），控制栏的跑马灯标题
 * 却直接用 `v-html="videoName"` —— 同一个数据两种待遇，等于留了个洞。
 * 现在抽到这里，两个地方共用一份。
 */

/** 把文本里的 HTML 特殊字符全部转义 */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** 去掉所有标签，得到纯文本（用于 title 提示 / alt） */
export const stripTags = (html: string): string => html.replace(/<[^>]*>/g, '')

/** 净化标题 HTML：只保留 `<em>` 高亮 */
export const sanitizeTitleHtml = (raw: string): string => {
  const escaped = escapeHtml(raw)
  return escaped
    .replace(/&lt;em(?:\s[\s\S]*?)?&gt;/gi, '<em>')
    .replace(/&lt;\/em&gt;/gi, '</em>')
}
