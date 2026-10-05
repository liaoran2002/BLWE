/**
 * 原子写 JSON
 *
 * 先写同目录下的临时文件，再 rename 覆盖目标：rename 在同一分区上是原子的，
 * 所以断电 / 崩溃只会留下「旧内容」或「新内容」，不会留下半个截断的 JSON。
 * 直接 `writeFileSync` 到目标文件就没有这个保证 —— 配置文件被截断一次，
 * 下次启动就是「配置全丢」。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param filePath 目标文件
 * @param data 要写入的内容（会被 JSON.stringify）
 * @param space 缩进，默认不缩进（缓存文件不需要好看）
 */
export const writeJsonAtomic = (
  filePath: string,
  data: unknown,
  space?: string | number,
): void => {
  const dirPath = path.dirname(filePath)
  const tempPath = `${filePath}.${Math.random().toString(36).slice(2, 10)}.temp`
  const json = JSON.stringify(data, null, space)

  const writeTemp = (): void => fs.writeFileSync(tempPath, json, 'utf8')
  try {
    writeTemp()
  } catch (err) {
    // 目录不存在（首次写入）时补建后重试一次
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      fs.mkdirSync(dirPath, { recursive: true })
      writeTemp()
    } else {
      throw err
    }
  }
  try {
    fs.renameSync(tempPath, filePath)
  } catch (err) {
    /**
     * rename 失败（Windows 上被杀软/其它进程占住很常见）要把临时文件清掉
     *
     * 否则残骸会一直堆在 userData 里，而且它的名字以 `.temp` 结尾 ——
     * 缓存那套清理/统计全按 `.json` 过滤，既看不见也清不掉。
     */
    try {
      fs.unlinkSync(tempPath)
    } catch {
      /* 删不掉就算了，别把原始错误盖掉 */
    }
    throw err
  }
}
