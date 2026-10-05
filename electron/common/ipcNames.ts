/**
 * 广播事件名（主进程 -> 渲染进程）
 *
 * **这里只放真正被按名字引用的那几个**：其它广播（`tray:unlock` / `tray:seek` /
 * `trayMenu:state` …）都直接写字符串字面量，由 `types/ipc.ts` 的 `IpcEventMap` 兜住类型。
 *
 * 踩过：以前这张表列了 12 个常量，实际只有 `settingUpdate` 在用 —— 事件清单被拆成两处，
 * 看这张表会以为别的广播不存在，加事件时也容易只改一半。要看全集请去 `IpcEventMap`。
 */

/** 主进程 -> 渲染进程的广播事件名（当前只有它需要常量引用） */
export const BROADCAST_EVENT_NAME = {
  settingUpdate: 'setting:update',
} as const
