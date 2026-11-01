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
        <div class="mgr-side-list">
          <div
            v-for="item in lists"
            :key="item.id"
            class="mgr-row"
            :class="{ sel: item.id === selectedId, cur: item.current }"
            @click="$emit('update:selectedId', item.id)"
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

          <div class="mgr-items">
            <div
              v-for="row in filtered"
              :key="row.key"
              class="mgr-item"
              :class="{ playing: row.playing, missing: row.missing }"
              @click="$emit('play', row)"
            >
              <div class="mgr-idx">{{ row.index + 1 }}</div>
              <div class="mgr-thumb">
                <img
                  v-if="row.cover && !broken[row.cover as string]"
                  :src="row.cover as string"
                  alt=""
                  referrerpolicy="no-referrer"
                  loading="lazy"
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
import type { ManagerDetail, ManagerList, ManagerMode, ManagerRow } from '../types/manager';

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
    loadingRows: { type: Boolean, default: false },
    searchPlaceholder: { type: String, default: '搜索' },
    emptyListText: { type: String, default: '还没有内容' },
    emptyMainText: { type: String, default: '从左边选一个查看' },
    emptyRowsText: { type: String, default: '这里还没有条目' },
    emptySearchText: { type: String, default: '没有匹配的结果' },
  },
  emits: ['update:visible', 'update:selectedId', 'create', 'sync-all', 'switch', 'play'],
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
