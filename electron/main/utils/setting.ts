/**
 * 主进程配置服务
 *
 * 这是本次改造的核心：setting 不再由渲染进程（localStorage / Pinia）持有，
 * 而是**主进程唯一持有**，渲染进程只拿一份响应式副本。
 *
 * 职责：
 *  1. 启动时读取 setting.json -> 版本迁移 -> 与 defaultSetting 合并补全缺项
 *  2. 内存常驻一份完整配置（global 级单例），读写都走内存，磁盘只做持久化
 *  3. 防抖写入磁盘，避免用户拖音量条时疯狂写文件
 *  4. 对外只接受 Partial<AppSetting> 局部更新
 *  5. 更新后返回**变化的那部分**，供上层广播给所有窗口，实现多窗口同步
 */
import { app } from 'electron'
import path from 'node:path'
import { SETTING_VERSION, STORE_NAMES } from '@common/constants'
import defaultSetting from '@common/defaultSetting'
import migrateSetting from '@common/utils/migrateSetting'
import { mergeSetting } from '@common/utils/mergeSetting'
import { debounce, compareVer } from '@common/utils/common'
import type { AppSetting } from '@common/types/app_setting'
import { getStore } from './store'

/** 落盘节流时间：用户连续操作（如拖音量）时只在停下来后写一次 */
const WRITE_DEBOUNCE_MS = 300

/** setting.json 的实际结构 */
interface SettingFileShape extends Record<string, unknown> {
  version: string
  setting: AppSetting
}

/** 内存常驻的完整配置 */
let appSetting: AppSetting = { ...defaultSetting }
let store: ReturnType<typeof getStore<SettingFileShape>> | null = null

/** 配置变更监听（主进程内部使用，例如托盘菜单、窗口行为） */
type ChangeListener = (
  updatedSetting: Partial<AppSetting>,
  keys: Array<keyof AppSetting>,
) => void
const changeListeners = new Set<ChangeListener>()

/** 订阅配置变更，返回取消订阅函数 */
export const onSettingChange = (listener: ChangeListener): (() => void) => {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

const getSettingPath = (): string => path.join(app.getPath('userData'), `${STORE_NAMES.APP_SETTINGS}.json`)

/** 真正落盘 */
const writeToDisk = (): void => {
  if (!store) return
  store.override({ version: appSetting.version, setting: appSetting })
}

/** 防抖落盘 */
const writeDebounced = debounce(writeToDisk, WRITE_DEBOUNCE_MS)

/** 立即把待写入的内容刷到磁盘（退出前调用） */
export const flushSetting = (): void => {
  writeDebounced.flush()
}

/**
 * 从磁盘读取配置，并完成「迁移 -> 合并默认值 -> 补全缺项」
 *
 * @returns 是否存在需要回写磁盘的修正
 */
const readFromDisk = (): { setting: AppSetting; needSave: boolean } => {
  store = getStore<SettingFileShape>(getSettingPath())

  const rawSetting: unknown = store.get('setting')
  let needSave = rawSetting == null

  // 1) 版本迁移：入参不可信，交给 migrateSetting 按版本闸门逐级抬升
  const migrated = migrateSetting(rawSetting)

  // 2) 与默认配置合并：以 defaultSetting 的 key 全集为准，
  //    这样新增配置项会自动获得默认值，废弃的 key 会被丢弃
  const { setting: merged, updatedSettingKeys } = mergeSetting(defaultSetting, migrated)
  if (updatedSettingKeys.length > 0) needSave = true

  /**
   * 深拷一份再用。
   *
   * mergeSetting 只做一层浅合并：如果用户配置里还没有 `player.tagBonus`
   * （老用户首次升级就是这样），合并结果里那个对象**和模块级 defaultSetting 是同一引用**。
   * 以后任何原地修改都会污染默认值，连「恢复默认设置」都会跟着变脏，这里隔断掉。
   */
  const setting = structuredClone(merged)

  // 3) 版本号始终对齐当前代码里的版本
  if (compareVer(setting.version, SETTING_VERSION) !== 0) {
    setting.version = SETTING_VERSION
    needSave = true
  }

  return { setting, needSave }
}

/**
 * 初始化配置（必须在 app.whenReady 之后、创建窗口之前调用）
 */
export const initSetting = (): void => {
  const { setting, needSave } = readFromDisk()
  appSetting = setting
  if (needSave) writeToDisk()
  console.log(
    `[setting] loaded, version=${setting.version}, volume=${setting['player.volume']}`,
  )
}

/**
 * 更新配置
 *
 * 只接收局部更新，返回**实际发生变化**的部分。
 *
 * @param partial 局部配置
 * @returns 变化的部分（渲染进程/广播只需要这部分）
 */
export const updateSetting = (partial?: Partial<AppSetting> | null): Partial<AppSetting> => {
  // 防御：IPC 入参来自渲染进程，可能是 null / 数组 / 原始值
  if (partial == null || typeof partial !== 'object' || Array.isArray(partial)) {
    return {}
  }

  /**
   * 轻量 schema 校验：只接受「已知 key + 与默认值同类型」的项
   *
   * `mergeSetting` 已经会丢掉未知 key，但**不校验值的类型** —— 渲染层一个类型 bug
   * （或以后做「导入配置」）就能把 `player.tagBonus` 写成字符串、`player.volume` 写成对象，
   * 而且会被下次启动当成权威值直接信任（`App.vue` 里 `Object.entries(tagBonusConfig)` 会炸）。
   * `version` 一律不接受渲染层写入，它由迁移逻辑自己维护。
   */
  const defaults = defaultSetting as unknown as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
    if (key === 'version') continue
    const expected = defaults[key]
    if (expected === undefined) continue
    if (typeof expected !== typeof value) {
      console.warn(`[setting] 忽略类型不符的配置项 ${key}:`, value)
      continue
    }
    safe[key] = value
  }
  if (Object.keys(safe).length === 0) return {}

  // 关键：必须先对当前值做深拷贝再合并。
  // 否则 updateSetting({...}) 只改引用相同的嵌套对象（如 player.tagBonus），
  // mergeSetting 会因为引用相等而判定"没有变化"，导致更新静默丢失。
  const current = structuredClone(appSetting)
  const { setting, updatedSetting, updatedSettingKeys } = mergeSetting(current, safe)

  // 没有任何变化就不写盘、不广播，避免无意义的 IO 与多窗口抖动
  if (updatedSettingKeys.length === 0) return {}

  appSetting = setting
  writeDebounced()

  for (const listener of changeListeners) {
    try {
      listener(updatedSetting, updatedSettingKeys)
    } catch (err) {
      console.error('[setting] change listener error:', err)
    }
  }

  return updatedSetting
}

/**
 * 恢复默认配置
 */
export const resetSetting = (): AppSetting => {
  const current = structuredClone(appSetting)
  const { setting, updatedSetting } = mergeSetting(current, {
    ...defaultSetting,
    // tagBonus 是整体替换的对象，必须显式深拷贝一份，
    // 否则会把 defaultSetting 里的对象直接共享给运行时，被意外修改
    'player.tagBonus': structuredClone(defaultSetting['player.tagBonus']),
    /**
     * `player.filterKeywords` 是**数组**，同样必须深拷贝
     *
     * 理由和 `common.customAspectRatios` 完全一样：`{...defaultSetting}` 只做浅拷贝，
     * 数组成员和 `defaultSetting` 是同一个引用。用户在设置页加一个过滤词，
     * 就会把模块级的 defaultSetting 改脏 —— 表现是「恢复默认」之后那个词还在。
     */
    'player.filterKeywords': [...defaultSetting['player.filterKeywords']],
    /**
     * `customAspectRatios` 是**数组**，同样要深拷贝
     *
     * 原因和上面 tagBonus 一样：`{...defaultSetting}` 只做浅拷贝，
     * 数组/对象成员和 `defaultSetting` 是**同一个引用**。用户之后往下拉列表里
     * 加一个自定义比例，就会把模块级的 defaultSetting 一起改脏 ——
     * 表现是「恢复默认设置」之后自定义比例还在（甚至越攒越多）。
     */
    'common.customAspectRatios': [...defaultSetting['common.customAspectRatios']],
  })
  appSetting = setting
  writeToDisk()

  for (const listener of changeListeners) {
    try {
      listener(updatedSetting, Object.keys(updatedSetting) as Array<keyof AppSetting>)
    } catch (err) {
      console.error('[setting] change listener error:', err)
    }
  }

  return structuredClone(appSetting)
}

/**
 * 给 IPC / 其它进程用的完整配置快照
 *
 * 返回深拷贝：跨 IPC 会被结构化克隆，但本地调用方（如托盘）拿到引用
 * 可能会不小心改到内存里那份常驻配置，所以这里统一给副本。
 */
export const getSetting = (): AppSetting => structuredClone(appSetting)
