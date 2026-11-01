/**
 * 把 `catch` 到的任意东西转成能显示的一行文案
 *
 * 两个管理器原先各写一份：视频管理做成方法 `this.errMsg()`，歌单管理则是六处
 * `err instanceof Error ? err.message : String(err)` 直接内联。同一个判断写七遍，
 * 改一次口径（比如以后要剥掉 IPC 前缀）得改七处，所以收成一份。
 *
 * 不判断 `err instanceof Error` 之外的形状：主进程抛回来的就是 Error；
 * 万一拿到字符串/对象，`String()` 也能给出一行，不该让「报错时再报错」。
 */
export const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)
