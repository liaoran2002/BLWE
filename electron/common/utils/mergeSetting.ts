/**
 * 配置合并
 *
 * 参考 LX Music 的 src/main/utils/index.ts 里的 mergeSetting
 *
 * 核心思想：
 *   AppSetting 是「扁平点号键 + 值均为可直接序列化的类型」的结构，
 *   因此「默认配置」与「用户配置」之间只需要做一层浅合并：
 *     - 遍历默认配置的每个 key，用用户配置里存在的值覆盖它
 *     - 顺带算出「哪些 key 真的被改动了」，返回 updatedSetting
 *
 *   这样主进程就能只把**变化的那部分**广播给渲染进程，
 *   渲染进程也只把**变化的那部分**写回主进程，避免整包配置来回传。
 */
import type { AppSetting } from '../types/app_setting'

export interface MergeSettingResult {
  /** 合并后的完整配置 */
  setting: AppSetting
  /** 被改动的 key 列表 */
  updatedSettingKeys: Array<keyof AppSetting>
  /** 被改动的 key 及其新值 */
  updatedSetting: Partial<AppSetting>
}

/**
 * 把 targetSetting 合并到 originSetting 上
 *
 * @param originSetting 基准配置（一般是 defaultSetting 或主进程内存里那份常驻配置）
 * @param targetSetting 用户配置（磁盘读取或渲染进程局部更新，可能是 Partial 或脏数据）
 */
export const mergeSetting = (
  originSetting: AppSetting,
  targetSetting?: Partial<AppSetting> | Record<string, unknown> | null,
): MergeSettingResult => {
  const setting: AppSetting = { ...originSetting }
  const updatedSettingKeys: Array<keyof AppSetting> = []
  const updatedSetting: Partial<AppSetting> = {}

  if (targetSetting == null || typeof targetSetting !== 'object') {
    return { setting, updatedSettingKeys, updatedSetting }
  }

  // 以基准配置的 key 全集为准遍历：
  // 磁盘上多出来的、已废弃的 key 会被自然丢弃，避免脏数据长期残留
  for (const key of Object.keys(originSetting) as Array<keyof AppSetting>) {
    const targetValue = (targetSetting as Record<string, unknown>)[key]
    // undefined 表示「用户没配这一项」，保留默认值
    if (targetValue === undefined) continue

    const originValue = originSetting[key]

    /**
     * ★ **类型校验**：类型和默认值不符就丢掉，用默认值
     *
     * 为什么必须在**这里**也做（`updateSetting` 里已经有一套）：
     * 两处管的是**不同的入口** ——
     *  - `updateSetting` 管「渲染进程写进来的」
     *  - 这里管「**磁盘上读出来的**」
     *
     * 只做前者会留下一个隐蔽的坑（**我踩过**）：某个 key 的默认值从
     * `null` 改成 `number` 之后，**老用户磁盘上那个 `null` 会被原样读回来**，
     * 于是覆盖掉新默认值；而 `updateSetting` 的类型校验要求「与当前默认值同类型」，
     * 结果**这个键从此再也写不进去**（每次写入都被判「类型不符」丢掉）。
     * 表现就是「拖动没反应」——而且日志只报一行 warn，极难查。
     *
     * 修了这里，磁盘上的脏类型会被自动纠正成默认值，写入随即恢复正常。
     */
    if (typeof targetValue !== typeof originValue) {
      continue
    }

    // 数组做一次浅比较，避免每次 getSetting 都因数组引用不同而产生噪声广播
    if (Array.isArray(targetValue) && Array.isArray(originValue)) {
      const targetArr = targetValue as unknown[]
      const originArr = originValue as unknown[]
      if (
        targetArr.length === originArr.length &&
        targetArr.every((v, i) => v === originArr[i])
      ) {
        continue
      }
    } else if (targetValue === originValue) {
      // 标量直接比相等
      continue
    }

    updatedSettingKeys.push(key)
    updatedSetting[key] = targetValue as never
    setting[key] = targetValue as never
  }

  return { setting, updatedSettingKeys, updatedSetting }
}
