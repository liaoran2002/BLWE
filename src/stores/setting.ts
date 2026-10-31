/**
 * 配置 store（渲染进程）
 *
 * 核心思想（与 LX 一致）：
 *   Pinia **不负责持久化**，只做渲染进程的一份响应式副本。
 *
 * 数据流：
 *   页面加载   -> api.getSetting()          -> 填充 store
 *   用户改表单 -> api.updateSetting(partial) -> 主进程落盘
 *   主进程广播 -> 'setting:update'           -> 自动同步 store
 *
 * 注意：updateSetting 之后不要自己再赋值！主进程会广播回来，
 * 统一由广播路径写入 store，保证「单一数据源」，也天然支持多窗口同步。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api/electron'
import defaultSetting from '@common/defaultSetting'
import { mergeSetting } from '@common/utils/mergeSetting'
import { toPlain } from '@/utils/plain'
import type { AppSetting } from '@common/types/app_setting'

/**
 * 生成「可结构化克隆」的普通对象副本
 *
 * 踩坑记录：store 里的 state 是 Vue 的响应式 Proxy，
 * 直接 structuredClone(state) 会抛
 *   "Failed to execute 'structuredClone': #<Object> could not be cloned"
 * 而 `toRaw` 只解开最外层，嵌套的数组/对象仍是 Proxy（例如 player.tagBonus）。
 * 所以统一用 utils/plain 里的深度解包版本。
 */

export const useSettingStore = defineStore('setting', () => {
  /** 当前完整配置（响应式副本） */
  const setting = ref<AppSetting>(structuredClone(defaultSetting))
  /** 是否已完成首次拉取 */
  const loaded = ref(false)

  /**
   * 用局部配置合并进本地副本
   *
   * 复用主进程同一套 mergeSetting，保证两端合并语义完全一致。
   * 这里必须传深拷贝，否则 mergeSetting 的引用相等判断会漏掉
   * 嵌套对象（如 player.tagBonus）的更新。
   */
  const applyPartial = (partial: Partial<AppSetting>): void => {
    const current = toPlain(setting.value)
    const { setting: merged, updatedSettingKeys } = mergeSetting(current, partial)
    if (updatedSettingKeys.length === 0) return
    setting.value = merged
  }

  /**
   * 从主进程拉取完整配置
   *
   * 加载时机只有一处（`src/main.ts` 在 mount 之前 await 它），
   * 所以不需要再包一层「幂等 ensureLoaded」—— 那套包装全项目没人调用，已经删掉。
   */
  const load = async (): Promise<void> => {
    const data = await api.getSetting()
    setting.value = toPlain(data)
    loaded.value = true
  }

  /**
   * 更新配置（局部）
   *
   * 只把变化的部分发给主进程；本地副本由主进程广播统一回写。
   * 注意先 toPlain：调用方传进来的可能是响应式对象/ref，
   * 而 IPC 的结构化克隆不能处理 Proxy，会直接抛错。
   */
  const update = async (partial: Partial<AppSetting>): Promise<void> => {
    await api.updateSetting(toPlain(partial))
  }

  /** 恢复默认配置 */
  const reset = async (): Promise<void> => {
    setting.value = await api.resetSetting()
  }

  /**
   * 监听主进程广播并同步本地副本
   *
   * @returns 取消监听函数（组件卸载时调用）
   */
  const startSync = (): (() => void) => {
    return api.onSettingUpdate((partial) => {
      applyPartial(partial)
    })
  }

  /**
   * 配置项太多，组件里统一用 `setting['xxx.yyy']` 直接读，
   * 不再为每一项都包一层 computed（那些包装全项目没人用，已经删掉：
   * volume / isMute / loopMode / playIndex / wallpaperMode / ensureLoaded）。
   */

  /**
   * 配置项统一用 `setting['xxx.yyy']` 直接读，
   * 只有标题关键词加权表留了一个 computed（App 的 `tagBonusConfig` 读它）。
   * 之前为每一项都包了一层 volume / isMute / loopMode / playIndex / wallpaperMode，
   * 全项目没人用，已经删掉。
   */
  const tagBonus = computed(() => setting.value['player.tagBonus'])

  return {
    setting,
    loaded,
    tagBonus,
    load,
    update,
    reset,
    startSync,
    applyPartial,
  }
})
