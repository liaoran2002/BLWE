/**
 * 按 `<video>` 实际解码出的分辨率推断清晰度标签
 *
 * 只是**兜底**：正常路径用的清晰度来自某站 playurl 响应自己报的档位
 * （见 `electron/main/utils/quality.ts`），那个更准，还能区分 60 帧 / 高码率。
 * 只有响应里拿不到档位时才退回这里，避免角标空着。
 *
 * 取长边而不是短边，避免竖屏视频（1080x1920）被判成 480P。
 */
export const qualityLabelOf = (width: number, height: number): string => {
  const long = Math.max(Number(width) || 0, Number(height) || 0)
  if (long <= 0) return ''
  if (long >= 7680) return '8K'
  if (long >= 3840) return '4K'
  if (long >= 2560) return '2K'
  if (long >= 1920) return '1080P'
  if (long >= 1280) return '720P'
  if (long >= 854) return '480P'
  if (long >= 640) return '360P'
  return '240P'
}
