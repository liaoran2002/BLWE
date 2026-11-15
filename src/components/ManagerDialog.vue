<!--
  管理器弹窗 —— 「歌单管理」和「视频管理」共用的那套东西

  ## 合的是什么

  两个弹窗原本各写一遍：el-dialog + 标题栏 + 左列表 + 右侧三态 + 搜索 + 条目行。
  逐块对下来，除表单内容和行尾按钮外**没有第三处不同**（连 CSS 都是同一套数值）。
  所以合成这一个组件，它负责整块界面，两个管理器只提供数据与表单：

    · 标题 / 统计 / 按钮文案 / 空态文案   → props（纯字符串）
    · 左列表、详情头                     → 归一化数据（`src/types/manager.ts`）
    · 表单（新建 / 编辑）                → `#form` slot
    · 详情头右侧的动作按钮               → `#actions` slot
    · 行尾按钮（视频的收藏 / 定位 / 移除）→ `#row-actions` slot

  条目行**就写在这里**，不再单独抽组件：它是这个弹窗的一部分，
  再拆一层只会多一个文件、多一层 props 传递，维护时要在三个文件之间跳。

  于是两个管理器只剩「数据从哪个 store 来」和「按钮点了干什么」，
  界面、行、搜索、空态都只有一份实现。

  ## 样式为什么不 scoped

  `#form` / `#actions` / `#row-actions` 的内容由**父组件**渲染（带父组件的
  scope id），这里 scoped 的 `.mgr-field` 之类命中不了它们，父组件就得把
  同一套表单样式再抄一遍 —— 那正好是要消灭的重复。

  所以这里用非 scoped 样式，类名统一 `mgr-` 前缀（全项目独此一份）。
  父组件写 `<div class="mgr-field">` 就自动长出正确的间距和字号。

  ## 尺寸

  统一按歌单管理那边：960 宽、内容区 62vh、「默认」标签带底色、同步中的行尾用转圈图标
  （视频原先是「同步中…」文字 + 900 宽，用户要求以歌单那边为准）。
-->
<template>
  <el-dialog
    v-model="shown"
    :width="width"
    :show-close="false"
    :append-to-body="appendToBody"
    align-center
  >
    <template #header>
      <div class="mgr-head">
        <span class="mgr-title">{{ title }}</span>
        <span class="mgr-summary">{{ summary }}</span>
      </div>
    </template>

    <div class="mgr-body">
      <!-- 左：列表 -->
      <div class="mgr-side">
        <div class="mgr-side-list" @dragover="onListZoneDragOver" @drop="onListZoneDrop">
          <div
            v-for="(item, listIndex) in lists"
            :key="item.id"
            class="mgr-row"
            :class="{
              sel: item.id === selectedId,
              cur: item.current,
              dragging: dragList === listIndex,
              'drop-before': dropEdgeAt(listIndex, dragOverList, dropAfterList, 'before'),
              'drop-after': dropEdgeAt(listIndex, dragOverList, dropAfterList, 'after'),
            }"
            title="拖动可调整顺序"
            draggable="true"
            @click="$emit('update:selectedId', item.id)"
            @dragstart="onListDragStart(listIndex, $event)"
            @dragover="onListDragOver(listIndex, $event)"
            @dragend="onListDragEnd"
            @drop="onListDrop(listIndex, $event)"
          >
            <div class="mgr-row-main">
              <div class="mgr-row-name" :title="item.name">
                <span v-if="item.current" class="mgr-dot" :title="currentHint"></span>
                {{ item.name }}
              </div>
              <div class="mgr-row-meta">
                <span>{{ item.countText }}</span>
                <span
                  v-for="tag in item.tags"
                  :key="tag.text"
                  class="mgr-tag"
                  :class="{ 'mgr-tag-default': tag.tone === 'default' }"
                  :title="tag.title || ''"
                >
                  {{ tag.text }}
                </span>
              </div>
            </div>
            <span v-if="item.syncing" class="mgr-spin" title="同步中">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3.5H10"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </div>

          <div v-if="lists.length === 0" class="mgr-empty">{{ emptyListText }}</div>
        </div>

        <div class="mgr-side-actions">
          <div class="mgr-side-row">
            <el-button size="small" type="primary" @click="$emit('create')">
              {{ createLabel }}
            </el-button>
            <el-button
              size="small"
              :disabled="syncAllDisabled"
              :loading="syncAllLoading"
              @click="$emit('sync-all')"
            >
              {{ syncAllLabel }}
            </el-button>
          </div>
          <!-- 切换器视觉上比动作按钮弱一档：它不是「操作这个列表」，是「换个管理器」 -->
          <el-button class="mgr-side-switch" size="small" @click="$emit('switch')">
            {{ switchLabel }}
          </el-button>
        </div>
      </div>

      <!-- 右：表单 / 详情 / 空态 -->
      <div class="mgr-main">
        <!--
          表单（新建 或 编辑）整块交给父组件：两种管理器的字段差得太远
          （歌单是名称+链接+同步间隔，视频是名称+四种来源或同步方式），
          公共的字段样式由本组件的非 scoped 样式提供。
        -->
        <slot v-if="mode === 'form'" name="form" />

        <template v-else-if="mode === 'detail' && detail">
          <div class="mgr-main-head">
            <div class="mgr-main-info">
              <div class="mgr-main-name">{{ detail.name }}</div>
              <div class="mgr-main-sub">
                <span>{{ detail.countText }}</span>
                <span
                  v-for="tag in detail.tags"
                  :key="tag.text"
                  class="mgr-tag"
                  :class="{ 'mgr-tag-default': tag.tone === 'default' }"
                  :title="tag.title || ''"
                >
                  {{ tag.text }}
                </span>
                <span v-for="(text, i) in detail.meta" :key="i">{{ text }}</span>
              </div>
            </div>
            <div class="mgr-main-actions">
              <slot name="actions" />
            </div>
          </div>

          <div class="mgr-search">
            <el-input v-model="keyword" size="small" :placeholder="searchPlaceholder" clearable />
            <span class="mgr-search-count">{{ filtered.length }} / {{ rows.length }}</span>
          </div>

          <div class="mgr-items" @scroll="onItemsScroll" @dragover="onItemsZoneDragOver" @drop="onItemsZoneDrop">
            <div
              v-for="row in filtered"
              :key="row.key"
              class="mgr-item"
              :class="{
                playing: row.playing,
                missing: row.missing,
                locked: row.locked,
                dragging: dragRow === row.index,
                'drop-before': dropEdgeAt(row.index, dragOverRow, dropAfterRow, 'before'),
                'drop-after': dropEdgeAt(row.index, dragOverRow, dropAfterRow, 'after'),
              }"
              :draggable="canReorderRows && !row.locked"
              :title="row.locked ? '收藏的条目固定在顶部，不能拖动' : ''"
              @click="$emit('play', row)"
              @dragstart="onRowDragStart(row, $event)"
              @dragover="onRowDragOver(row, $event)"
              @dragend="onRowDragEnd"
              @drop="onRowDrop(row, $event)"
            >
              <div class="mgr-idx">{{ row.index + 1 }}</div>
              <div class="mgr-thumb">
                <img
                  v-if="row.cover && !broken[row.cover as string]"
                  :src="row.cover as string"
                  alt=""
                  referrerpolicy="no-referrer"
                  loading="lazy"
                  draggable="false"
                  @error="onImgError(row.cover as string)"
                />
              </div>
              <div class="mgr-item-info">
                <div class="mgr-item-name" :title="row.titleTooltip || row.title">
                  {{ row.title }}
                </div>
                <div class="mgr-item-more">
                  <span class="mgr-item-sub">{{ row.subtitle }}</span>
                  <span v-if="row.extra" class="mgr-item-extra" :title="row.extra">
                    {{ row.extra }}
                  </span>
                  <!-- 失效标记：红框小角标，和副行其它文字抢不到注意力 -->
                  <span v-if="row.missing" class="mgr-missing-tag" :title="row.missingHint || ''">
                    文件丢失
                  </span>
                </div>
              </div>
              <!-- 来源平台标记（本地歌单才有），放在时长左边 -->
              <div v-if="row.tag" class="mgr-item-tag">{{ row.tag }}</div>
              <div class="mgr-item-dur">{{ formatDuration(row.duration) }}</div>
              <div v-if="$slots['row-actions']" class="mgr-item-actions">
                <slot name="row-actions" :row="row" />
              </div>
            </div>

            <div v-if="loadingRows" class="mgr-empty">正在读取条目…</div>
            <div v-else-if="filtered.length === 0" class="mgr-empty">
              {{ rows.length === 0 ? emptyRowsText : emptySearchText }}
            </div>

            <!--
              懒加载占位行

              平台列表只先拉第 1 页，这里是「还没拉下来的部分」。滚到底会自动加载，
              点这一行也加载 —— 自动是为了顺手，手动是为了能控制（也方便验证）。
            -->
            <div
              v-if="hasMore && !keyword"
              class="mgr-loadmore"
              :class="{ busy: loadingMore }"
              @click="requestMore"
            >
              {{
                loadingMore
                  ? '正在加载…'
                  : remainingCount > 0
                    ? `还有 ${remainingCount} 条未加载 · 点击加载`
                    : '继续加载下一页 · 点击加载'
              }}
            </div>
          </div>
        </template>

        <div v-else class="mgr-empty big">{{ emptyMainText }}</div>
      </div>
    </div>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import type { PropType } from 'vue';
import { formatDuration } from '@common/utils/duration';
import { markInternalDrag } from '../utils/dnd';
import type { ManagerDetail, ManagerList, ManagerMode, ManagerRow } from '../types/manager';

/**
 * 拖动落点 → 目标下标
 *
 * `to` 用的是**先移出、再插入**的口径（store 那边就是 `splice(from,1)` 之后 `splice(to,0,x)`），
 * 所以不能直接把「被悬停那一行的下标」当 `to` 交出去：
 *
 * | 落点 | `from < over` | `from > over` |
 * | :--- | :--- | :--- |
 * | 插在 over **之前** | `over - 1` | `over` |
 * | 插在 over **之后** | `over` | `over + 1` |
 *
 * 前两种差一位，是因为被拖走的那一条在 from < over 时把 over 往前顶了一格。
 * 也算出「等于 from」的情况（悬在自己上下半、或者本来就是那个位置）—— 调用方据此跳过，
 * 免得白跑一次写库。
 */
const resolveDropIndex = (from: number, over: number, after: boolean): number => {
  if (after) return over + (from < over ? 0 : 1);
  return over + (from < over ? -1 : 0);
};

export default defineComponent({
  name: 'ManagerDialog',
  props: {
    /** 弹窗开关（`v-model:visible`） */
    visible: { type: Boolean, default: false },
    /** 左栏选中项（`v-model:selectedId`） */
    selectedId: { type: String, default: '' },
    title: { type: String, required: true },
    summary: { type: String, default: '' },
    width: { type: String, default: '960px' },
    /**
     * 挂到 body 上
     *
     * 视频管理要开它：那个弹窗上面还会再叠「添加视频」确认框，
     * 留在父容器的层叠上下文里会被盖住。
     */
    appendToBody: { type: Boolean, default: false },

    lists: { type: Array as PropType<ManagerList[]>, default: () => [] },
    /** 圆点的悬浮提示（「当前播放歌单」/「正在播放」） */
    currentHint: { type: String, default: '正在播放' },
    createLabel: { type: String, default: '新建' },
    /** 传空字符串 = 不显示「全部同步」 */
    syncAllLabel: { type: String, default: '全部同步' },
    syncAllDisabled: { type: Boolean, default: false },
    syncAllLoading: { type: Boolean, default: false },
    switchLabel: { type: String, default: '' },

    mode: { type: String as PropType<ManagerMode>, default: 'empty' },
    detail: { type: Object as PropType<ManagerDetail | null>, default: null },
    rows: { type: Array as PropType<ManagerRow[]>, default: () => [] },
    /**
     * 条目能不能拖动排序
     *
     * 只有**本地**的列表 / 歌单才允许：平台那边的条目是远端投影，
     * 排了下次同步就被覆盖。由父组件按当前选中项的类型传。
     */
    rowsReorderable: { type: Boolean, default: false },
    loadingRows: { type: Boolean, default: false },
    searchPlaceholder: { type: String, default: '搜索' },
    emptyListText: { type: String, default: '还没有内容' },
    emptyMainText: { type: String, default: '从左边选一个查看' },
    emptyRowsText: { type: String, default: '这里还没有条目' },
    emptySearchText: { type: String, default: '没有匹配的结果' },
    /** 远端还有没拉下来的条目（平台列表的懒加载） */
    hasMore: { type: Boolean, default: false },
    /** 还有多少条没加载（用于占位行文案） */
    remainingCount: { type: Number, default: 0 },
    loadingMore: { type: Boolean, default: false },
  },
  emits: [
    'update:visible',
    'update:selectedId',
    'create',
    'sync-all',
    'switch',
    'play',
    'load-more',
    /** 左栏列表被拖动排序（传原始下标） */
    'reorder-lists',
    /** 条目被拖动排序（传原始下标；收藏行不会发） */
    'reorder-rows',
  ],
  data() {
    return {
      keyword: '',
      /**
       * 坏掉的封面（按行键记）
       *
       * 记「哪一行」，不是记「哪个地址」：行是按业务键渲染的，
       * 切列表时行本身会被替换，所以按行记不会串到另一个列表去。
       */
      broken: {} as Record<string, boolean>,
      /** 正在拖的左栏下标 / 悬停的落点下标（`null` = 没在拖） */
      dragList: null as number | null,
      dragOverList: -1,
      /** 落点在下半部分？（决定插到那一行之前还是之后） */
      dropAfterList: false,
      /** 正在拖的条目下标 / 悬停的落点下标（都是 `row.index`，即原始下标） */
      dragRow: null as number | null,
      dragOverRow: -1,
      dropAfterRow: false,
    };
  },
  computed: {
    shown: {
      get(): boolean {
        return this.visible;
      },
      set(v: boolean) {
        this.$emit('update:visible', v);
      },
    },
    /**
     * 条目能不能拖动排序
     *
     * 搜索时 `filtered` 只是原数组的子集，拖动它算出来的 from/to 与真实下标对不上，
     * 挪过去会得到「看起来跳了一段」的结果。所以搜索状态下直接关掉拖动。
     *
     * 平台列表 / 平台歌单的条目也不给拖（`rowsReorderable` 由父组件判断）。
     */
    canReorderRows(): boolean {
      return this.mode === 'detail' && this.rowsReorderable && !this.keyword.trim();
    },
    filtered(): ManagerRow[] {
      const kw = this.keyword.trim().toLowerCase();
      if (!kw) return this.rows;
      return this.rows.filter(
        (r) =>
          r.title.toLowerCase().includes(kw) ||
          (r.subtitle || '').toLowerCase().includes(kw) ||
          (r.extra || '').toLowerCase().includes(kw),
      );
    },
  },
  watch: {
    /**
     * 换列表：搜索词和坏图记录一起清
     *
     * 关键词留着会让新列表一片空白，看着像坏了；
     * 坏图记录虽然按地址记了，换列表也顺手清一次 —— 上一份列表里坏掉的地址
     * 多半在这份里也坏，但白白留着只占内存。
     */
    selectedId() {
      this.keyword = '';
      this.broken = {};
    },
    visible(v: boolean) {
      if (!v) this.keyword = '';
    },
  },
  methods: {
    formatDuration,
    /**
     * 滚到接近底部就预加载
     *
     * 留 80px 余量：等真正贴底才发请求，用户会看到一次明显停顿。
     * 加载中不再触发（父组件那边也会有 `loadingMore` 挡住重复请求）。
     */
    // #region 拖动排序
    /** 左栏开始拖 */
    onListDragStart(index: number, event: DragEvent): void {
      this.dragList = index;
      this.dragOverList = -1;
      this.dropAfterList = false;
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      /** 标记成「界面内排序」：全局拖入监听靠它放过这次拖动（见 `utils/dnd.ts`） */
      markInternalDrag(event.dataTransfer);
    },
    onListDragOver(index: number, event: DragEvent): void {
      if (this.dragList === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      /** 拖回自己身上没有落点可言：插到自己前/后都是原地 */
      if (index === this.dragList) {
        this.dragOverList = -1;
        return;
      }
      this.dropAfterList = this.isLowerHalf(event);
      this.dragOverList = index;
    },
    onListDragEnd(): void {
      this.dragList = null;
      this.dragOverList = -1;
      this.dropAfterList = false;
    },
    onListDrop(index: number, event: DragEvent): void {
      /**
       * 不是「拖左栏」这条路（比如从资源管理器拖个视频落在列表上）：
       * 什么都别做，尤其**不要 preventDefault** —— 那会让全局拖入以为这次松手没人要，
       * 文件就静悄悄地不导入了。
       */
      if (this.dragList === null) return;
      event.preventDefault();
      const from = this.dragList;
      const to = resolveDropIndex(from, index, this.isLowerHalf(event));
      this.onListDragEnd();
      if (to === from) return;
      this.$emit('reorder-lists', { from, to });
    },

    /** 条目开始拖（收藏行 `draggable` 已经是 false，这里再挡一道） */
    onRowDragStart(row: ManagerRow, event: DragEvent): void {
      if (row.locked) return;
      this.dragRow = row.index;
      this.dragOverRow = -1;
      this.dropAfterRow = false;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        /** Firefox 不设数据就不发 drag 事件 */
        event.dataTransfer.setData('text/plain', String(row.index));
        markInternalDrag(event.dataTransfer);
      }
    },
    onRowDragOver(row: ManagerRow, event: DragEvent): void {
      if (this.dragRow === null) return;
      /**
       * 收藏行不能当落点：允许它的话，普通条目会插到收藏区里，
       * 而主进程排序时又会把收藏整体提到最前 —— 用户看到的是「拖了没反应」。
       */
      if (row.locked) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (row.index === this.dragRow) {
        this.dragOverRow = -1;
        return;
      }
      this.dropAfterRow = this.isLowerHalf(event);
      this.dragOverRow = row.index;
    },
    onRowDragEnd(): void {
      this.dragRow = null;
      this.dragOverRow = -1;
      this.dropAfterRow = false;
    },
    onRowDrop(row: ManagerRow, event: DragEvent): void {
      /** 同 `onListDrop`：外部拖进来的东西要留给全局拖入，这里不能 preventDefault */
      if (this.dragRow === null) return;
      if (row.locked) return;
      event.preventDefault();
      const from = this.dragRow;
      const to = resolveDropIndex(from, row.index, this.isLowerHalf(event));
      this.onRowDragEnd();
      if (to === from) return;
      this.$emit('reorder-rows', { from, to });
    },

    /**
     * 事件是不是落在某一行**里面**（行自己的 dragover / drop 会先处理）
     *
     * 事件从行冒泡到这里时 `target` 还是行里的某个元素；落在行下面的空白处
     * 或者「还有 N 条未加载」那条占位行上时，`closest` 就找不到了。
     */
    isInsideRow(event: DragEvent, selector: string): boolean {
      const target = event.target as HTMLElement | null;
      return !!target && typeof target.closest === 'function' && !!target.closest(selector);
    },

    /**
     * 落在**列表末尾的空白处**：算作「放到最后一条后面」
     *
     * 没有这一段的话有个很坑的手感：内容比容器矮时，最后一条下面是一片空地，
     * 拖到底部松手其实没落在任何一行上 —— 落点不处理，条目就弹回原位；
     * 而高亮还亮着（`dragOverRow` 停在最后一条上没清），看起来像「明明亮了却没生效」。
     */
    onListZoneDragOver(event: DragEvent): void {
      if (this.dragList === null) return;
      if (this.isInsideRow(event, '.mgr-row')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragOverList = this.lists.length - 1;
      this.dropAfterList = true;
    },
    onListZoneDrop(event: DragEvent): void {
      /** 行自己处理过的松手已经把 `dragList` 清空了，这里自然就不接手 */
      if (this.dragList === null) return;
      if (this.isInsideRow(event, '.mgr-row')) return;
      event.preventDefault();
      const from = this.dragList;
      const to = this.lists.length - 1;
      this.onListDragEnd();
      if (to === from || to < 0) return;
      this.$emit('reorder-lists', { from, to });
    },

    /** 条目区同理（见 `onListZoneDragOver`） */
    onItemsZoneDragOver(event: DragEvent): void {
      if (this.dragRow === null) return;
      if (this.isInsideRow(event, '.mgr-item')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragOverRow = this.rows.length - 1;
      this.dropAfterRow = true;
    },
    onItemsZoneDrop(event: DragEvent): void {
      if (this.dragRow === null) return;
      if (this.isInsideRow(event, '.mgr-item')) return;
      event.preventDefault();
      const from = this.dragRow;
      const to = this.rows.length - 1;
      this.onRowDragEnd();
      if (to === from || to < 0) return;
      this.$emit('reorder-rows', { from, to });
    },

    /**
     * 鼠标是不是在事件目标的下半部分
     *
     * 决定「插到这一行之前」还是「之后」：上半 → 之前，下半 → 之后。
     * `currentTarget` 一定是挂了监听的整行（事件可能从缩略图 / 标题冒泡上来）。
     */
    isLowerHalf(event: DragEvent): boolean {
      const el = event.currentTarget as HTMLElement | null;
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      const rect = el.getBoundingClientRect();
      return event.clientY > rect.top + rect.height / 2;
    },

    /**
     * 某一行该不该亮「上部分 / 下部分」
     *
     * 落点画在两条**之间的缝**上，所以一个插入点要让两行同时亮：
     * 插在 k 和 k+1 中间时，k 的下半 + k+1 的上半一起亮；
     * 插在最后一条之后时，只有最后那条的下半亮（下面没有行了）。
     *
     * @param index 行下标
     * @param over  鼠标正悬停的那一行（`-1` = 没在拖 / 没有落点）
     * @param after 鼠标悬停在这一行的下半部分
     */
    dropEdgeAt(index: number, over: number, after: boolean, side: 'before' | 'after'): boolean {
      if (over < 0) return false;
      if (side === 'after') return (over === index && after) || (over === index + 1 && !after);
      return (over === index && !after) || (over === index - 1 && after);
    },
    // #endregion

    onItemsScroll(event: Event): void {
      if (!this.hasMore || this.loadingMore) return;
      const el = event.target as HTMLElement;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return;
      this.$emit('load-more');
    },
    requestMore(): void {
      if (this.loadingMore) return;
      this.$emit('load-more');
    },
    /**
     * 记下「这个地址的封面加载不出来」
     *
     * 记的是**地址**而不是行键：歌单的行键是下标（同一首歌可以出现两次，没有稳定 id），
     * 删掉中间一行之后后面所有行都会挪位，按行键记的坏图标记就会盖到别人头上 ——
     * 表现为「删了一行，另一行的封面突然空了」。
     */
    onImgError(cover: string): void {
      if (Object.keys(this.broken).length > 2000) this.broken = {};
      this.broken[cover] = true;
    },
  },
});
</script>

<!--
  非 scoped：`#form` / `#row-actions` 的内容由父组件渲染，
  scoped 规则命中不了它们（见文件头说明）。类名全部 `mgr-` 前缀。
-->
<style>
.mgr-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.mgr-title {
  font-size: calc(16px * var(--fs));
  font-weight: 600;
}
.mgr-summary {
  font-size: calc(12px * var(--fs));
  opacity: 0.55;
}
.mgr-body {
  display: flex;
  gap: 14px;
  height: 62vh;
}

/* 左侧列表 */
.mgr-side {
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--panel-divider);
  padding-right: 12px;
}
.mgr-side-list {
  flex: 1;
  overflow-y: auto;
}
.mgr-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 7px;
  cursor: pointer;
  margin-bottom: 2px;
}
.mgr-row:hover {
  background: var(--panel-hover);
}
.mgr-row.sel {
  background: var(--panel-active);
}
/* 拖动排序：拖起来的那行淡一点，落点画在两条之间的缝上（见文件末尾 .drop-before/.drop-after） */
.mgr-row.dragging {
  opacity: 0.45;
}
.mgr-row.cur .mgr-row-name {
  font-weight: 600;
}
.mgr-row-main {
  flex: 1;
  min-width: 0;
}
.mgr-row-name {
  font-size: calc(13px * var(--fs));
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgr-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}
.mgr-row-meta {
  display: flex;
  gap: 6px;
  font-size: calc(11px * var(--fs));
  opacity: 0.55;
  margin-top: 2px;
}
.mgr-tag {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-hover);
}
/* 「默认」标签：和来源标签（wy / QQ）区分开 —— 它是身份，不是来源 */
.mgr-tag-default {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.mgr-spin {
  flex: none;
  color: var(--accent);
}
.mgr-spin svg {
  animation: mgr-rotate 0.9s linear infinite;
}
@keyframes mgr-rotate {
  to {
    transform: rotate(360deg);
  }
}
.mgr-side-actions {
  display: flex;
  /* 竖排：上面一行是列表自己的动作，下面一行是「换个管理器」 */
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--panel-divider);
}
.mgr-side-row {
  display: flex;
  gap: 6px;
}
.mgr-side-actions .el-button {
  flex: 1;
  margin-left: 0;
}
/* 「← 歌单管理」：它是切换器，视觉上要比动作按钮弱一档 */
.mgr-side-switch {
  opacity: 0.85;
}

/* 右侧主区 */
.mgr-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.mgr-main-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 9px;
}
.mgr-main-info {
  flex: 1;
  min-width: 0;
}
.mgr-main-name {
  font-size: calc(14px * var(--fs));
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgr-main-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: calc(11px * var(--fs));
  opacity: 0.55;
  margin-top: 3px;
}
.mgr-main-actions {
  display: flex;
  gap: 6px;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.mgr-main-actions .el-button {
  margin-left: 0;
}
.mgr-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.mgr-search-count {
  font-size: calc(11px * var(--fs));
  opacity: 0.55;
  flex: none;
}

/* 条目行 */
.mgr-items {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--panel-divider);
  border-radius: 8px;
}
.mgr-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 9px;
  cursor: pointer;
  border-bottom: 1px solid var(--panel-hover);
}
.mgr-item:last-child {
  border-bottom: none;
}
.mgr-item:hover {
  background: var(--panel-hover);
}
.mgr-item.playing {
  background: var(--panel-active);
}
/* 拖动排序（条目）：收藏行 `draggable` 为 false，光标也保持普通样式，别暗示能拖 */
.mgr-item[draggable='true'] {
  cursor: grab;
}
.mgr-item.dragging {
  opacity: 0.45;
}
.mgr-item.locked {
  cursor: default;
}
.mgr-item.playing .mgr-item-name {
  color: var(--accent-strong);
  font-weight: 600;
}
.mgr-idx {
  width: 28px;
  flex: none;
  text-align: right;
  font-size: calc(11px * var(--fs));
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.mgr-thumb {
  /* 只管高度，宽度按原图比例自适应，图片居中 */
  height: 32px;
  min-width: 32px;
  flex: none;
  border-radius: 5px;
  overflow: hidden;
  background: rgba(128, 128, 128, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mgr-thumb img {
  height: 32px;
  width: auto;
  max-width: 84px;
  object-fit: contain;
  display: block;
}
.mgr-item-info {
  flex: 1;
  min-width: 0;
}
.mgr-item-name {
  font-size: calc(13px * var(--fs));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgr-item-more {
  display: flex;
  gap: 7px;
  font-size: calc(11px * var(--fs));
  opacity: 0.6;
  margin-top: 1px;
  overflow: hidden;
}
.mgr-item-sub {
  flex: none;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgr-item-extra {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgr-item-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  /* 比正文小一号，和「文件丢失」角标同一档 */
  font-size: calc(10px * var(--fs));
  line-height: 16px;
  letter-spacing: 0.04em;
  opacity: 0.7;
  background: var(--panel-hover);
}
/*
 * 行尾图标按钮（`.mgr-row-btn`）
 *
 * 内容由父组件通过 `#row-actions` 渲染，但样式放在这里 —— 视频的「移除」和歌单的
 * 「移除」长得必须一样，各写一份就会各飘各的（一个 24px 一个 22px 这类）。
 * `--x` 是那个「×」字号，非 scoped，父组件的 slot 内容直接吃到。
 */
.mgr-row-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  opacity: 0.45;
  transition:
    opacity 0.15s,
    background 0.15s,
    color 0.15s;
}
.mgr-row-btn:hover {
  background: var(--panel-hover);
  opacity: 1;
}
.mgr-row-btn--x {
  font-size: calc(16px * var(--fs));
  line-height: 1;
}

.mgr-item-dur {
  flex: none;
  font-size: calc(11px * var(--fs));
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.mgr-missing-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: calc(10px * var(--fs));
  line-height: 15px;
  color: var(--accent-danger);
  border: 1px solid var(--accent-danger);
}
.mgr-item-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

/*
 * 失效的本地文件条目
 *
 * 「压暗 + 保留点击」而不是「禁用」：点它不会播放（播了必然失败），
 * 而是直接弹重新定位 —— 用户看到一行灰的，第一反应就是「怎么修」，
 * 这时让他点了没反应是最糟的。
 */
.mgr-item.missing .mgr-idx,
.mgr-item.missing .mgr-item-name,
.mgr-item.missing .mgr-item-dur {
  opacity: 0.45;
}
.mgr-item.missing .mgr-thumb {
  opacity: 0.4;
}
/* 副行里的角标是警告，不能被父级的 0.6 透明度一起压掉 */
.mgr-item.missing .mgr-item-more {
  opacity: 1;
}
.mgr-item.missing .mgr-item-sub {
  opacity: 0.5;
}

/* 空态 */
.mgr-loadmore {
  margin: 8px 2px 2px;
  padding: 9px 10px;
  text-align: center;
  font-size: calc(12px * var(--fs));
  color: var(--accent);
  border: 1px dashed var(--panel-divider);
  border-radius: 6px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.mgr-loadmore:hover {
  background: var(--panel-hover);
  border-color: var(--accent);
}
.mgr-loadmore.busy {
  cursor: default;
  opacity: 0.6;
  color: inherit;
}
.mgr-empty {
  padding: 24px 8px;
  text-align: center;
  font-size: calc(12px * var(--fs));
  opacity: 0.5;
}
.mgr-empty.big {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/*
 * 拖动排序的落点：**画在两条之间的缝上**
 *
 * 一个插入点要横跨相邻两行：上面那条的下部分 + 下面那条的上部分，各画一段
 * 从缝往里渐隐的色带。两条贴在一起时，两段合成一条以缝为中心、两侧渐隐的宽线 —
 * 眼睛看到的是「插在这里」，而不是「插在某一行的顶上」。
 *
 * 落在最后一条之后时只有它自己的下部分亮（下面没有行了），这条规则自动成立：
 * 只有 `.drop-after`，没有下一行的 `.drop-before`。
 */
.mgr-row.drop-before::before,
.mgr-row.drop-after::after,
.mgr-item.drop-before::before,
.mgr-item.drop-after::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  height: 12px;
  border-radius: 3px;
  pointer-events: none;
}
.mgr-row.drop-before::before,
.mgr-item.drop-before::before {
  top: 0;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--accent) 55%, transparent),
    transparent
  );
}
.mgr-row.drop-after::after,
.mgr-item.drop-after::after {
  bottom: 0;
  background: linear-gradient(
    to top,
    color-mix(in srgb, var(--accent) 55%, transparent),
    transparent
  );
}

/*
 * 表单（新建 / 编辑）的公共字段样式
 *
 * 放在这里而不是各管理器里：两边表单长得一样（一列 label + 控件 + 灰色说明），
 * 父组件渲染时直接套 `mgr-field` / `mgr-hint` / `mgr-readonly` / `mgr-form-actions`。
 */
.mgr-form {
  padding: 2px 4px;
  overflow-y: auto;
}
.mgr-form-title {
  font-size: calc(14px * var(--fs));
  font-weight: 600;
  margin-bottom: 10px;
}
.mgr-field {
  margin-bottom: 12px;
}
.mgr-field label {
  display: block;
  font-size: calc(12px * var(--fs));
  opacity: 0.7;
  margin-bottom: 5px;
}
.mgr-readonly {
  font-size: calc(13px * var(--fs));
  padding: 5px 2px;
  opacity: 0.75;
  word-break: break-all;
}
.mgr-hint {
  font-size: calc(11px * var(--fs));
  opacity: 0.55;
  margin-top: 6px;
  line-height: 1.5;
}
.mgr-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--panel-divider);
}
.mgr-form-actions .el-button {
  margin-left: 0;
}
</style>
