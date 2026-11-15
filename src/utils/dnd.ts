/**
 * 拖拽的一个小约定：怎么分辨「界面内拖动排序」和「从外面拖东西进来」
 *
 * ## 为什么需要它
 *
 * 全局拖入（`stores/drop.ts`）在 `document` 上挂了 dragenter / dragover / drop：
 * 任何一次拖动都会被当成「用户往窗口里拖了东西」，于是弹出「松手导入」遮罩；
 * 更糟的是它在 `dragover` 里写 `dropEffect = 'copy'`，而排序拖动在 `dragstart`
 * 里声明的是 `effectAllowed = 'move'` —— 两者不兼容时浏览器把 `dropEffect`
 * 归零成 `none`，**按规范 `dropEffect` 为 none 的松手不会派发 `drop` 事件**。
 * 表现就是：拖着条目时遮罩乱闪，松手什么也没发生。
 *
 * ## 为什么用 DataTransfer 上的自定义类型，而不是一个全局布尔
 *
 * 布尔开关依赖 `dragstart` / `dragend` 成对出现；一旦拖到一半源元素被重渲染
 * 掉（排序、列表刷新都会），`dragend` 不一定来，开关就永久卡在「正在拖动」，
 * 之后从资源管理器拖进来的文件全被忽略 —— 这种坏法比原来的 bug 更难查。
 *
 * 自定义类型跟着**这一次拖动**走：`dragstart` 时写进 `dataTransfer`，
 * 拖动过程（dragenter / dragover / drop）里 `dataTransfer.types` 都读得到
 * （浏览器只藏数据、不藏类型名），拖动结束它自然消失，没有需要清理的状态。
 */

/** 排序拖动的标记类型；不是标准 MIME，只在本应用内部用 */
export const INTERNAL_DRAG_TYPE = 'application/x-blwe-reorder';

/** 在 `dragstart` 里调用：把这次拖动标记成「界面内的排序」 */
export const markInternalDrag = (dt: DataTransfer | null): void => {
  if (!dt) return;
  try {
    dt.setData(INTERNAL_DRAG_TYPE, '1');
  } catch {
    /* 极少数环境禁止写自定义类型：退化成「不标记」，也不该让拖动本身失败 */
  }
};

/** 这个拖拽事件是不是界面内的排序拖动 */
export const isInternalDrag = (event: DragEvent): boolean => {
  const dt = event.dataTransfer;
  if (!dt) return false;
  return Array.from(dt.types).includes(INTERNAL_DRAG_TYPE);
};
