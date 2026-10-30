/**
 * 「从外面拖进窗口的东西是什么」—— 识别（主进程）
 *
 * ## 为什么识别必须在这里
 *
 * 三类链接各有各的规矩，而且这些规矩**本来就都写在主进程**：
 *  - 音乐歌单：`music/utils.ts` 的 `detectSource`（按 host 判平台，`digest-…` 特判）；
 *  - B 站列表：`biliApi.ts` 的 `parseListInput`（收藏夹 / 合集 / 系列各有几种地址形态）；
 *  - B 站单视频：`biliApi.ts` 的 `BV_PATTERN` + 短链跟随。
 *
 * 渲染层再抄一份正则，就会出现「粘贴能导入、拖进来认不出」这种两边不一致的 bug。
 * 所以这里只做识别（**不联网、不写库**），真正的导入由渲染层接着调对应的一个接口。
 *
 * ## 顺序为什么是「音乐 → 列表 → 视频」
 *
 * 三类互斥（host 不同），顺序其实只影响「一条文本同时像两种」的极端情况：
 * 音乐平台的分享文案里可能带数字 id，B 站列表链接里也可能含 BV 号
 * （`?bvid=` 之类）。先按平台判，再按列表判，最后才当单视频 ——
 * 越具体的规则越先跑。
 */
import { parseListInput, BV_PATTERN } from '../biliApi'
import { detectSource } from '../music'
import type { DropInputTarget } from '@common/types/playlist'

/** 短链域名：拖进来时本身看不出是什么，只能先当视频，由 `parseVideoInput` 去跟随跳转 */
const SHORT_LINK = /(?:b23\.tv|bili2233\.cn)/i

export const classifyDropInput = (text: string): DropInputTarget => {
  const raw = String(text ?? '').trim()
  if (!raw) return { type: 'none' }

  /**
   * ① 音乐歌单
   *
   * `detectSource` 认不出「酷狗」以外的平台会返回 null，而酷狗返回 `kg`
   * —— 这里**不拦**：拦截的理由（「哪个平台没接」）属于导入那一步，
   * 那边报错比这里说「没认出来」准确得多。
   */
  if (detectSource(raw)) return { type: 'music', url: raw }

  /**
   * ② B 站列表（收藏夹 / 合集 / 系列）
   *
   * 合集点开播放页时地址是 `/list/{mid}?sid=…`，和单视频页 `/video/BV…`
   * 长得完全不一样，所以「先列表后视频」不会互相抢。
   */
  const parsed = parseListInput(raw)
  if (parsed) {
    return { type: 'list', kind: parsed.kind, id: parsed.id, mid: parsed.mid }
  }

  /** ③ 单条视频：文本里直接带 BV 号（粘的是链接、分享文案或裸 BV 号都行） */
  if (BV_PATTERN.test(raw)) return { type: 'video', input: raw }

  /**
   * ④ 短链：只有 `b23.tv` 这种才知道是 B 站的，但**看不出是视频还是列表**。
   * 交给「单视频」那条路 —— `parseVideoInput` 会跟随 302 再抠 BV 号；
   * 万一它其实是个列表链接，那边会报「没有识别出 BV 号」，提示也算清楚。
   */
  if (SHORT_LINK.test(raw)) return { type: 'video', input: raw }

  return { type: 'none' }
}
