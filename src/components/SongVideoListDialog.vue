<template>
  <!--
    歌曲 / 视频列表

    和设置、歌单管理一样是 el-dialog：
    右上角没有叉号（show-close=false），点弹窗外面的空白处关闭；
    「点击空白位置关闭」的提示由 `styles/global.css` 里遮罩的 ::after 统一提供。
  -->
  <el-dialog
    :model-value="listType != 'none'"
    :show-close="false"
    :width="isBrowsePanel ? '56vw' : '50vw'"
    align-center
    @update:model-value="onVisibleChange"
  >
    <template #header>
      <div class="listTitle">
        <!-- 左：刷新（两个列表面板共用一个按钮，动作不同）
             歌单 -> 重新同步歌单；OV 的视频列表 -> 重新拉列表；MV 的视频列表 -> 重新搜索
             点击时图标转 360°、0.5s，作为「点到了」的反馈 -->
        <div class="lt-side">
          <button
            class="lt-icon lt-refresh"
            :class="{ spin: spinning }"
            :title="
              isSongList
                ? '重新同步歌单'
                : mode === 'ov'
                  ? '重新同步列表'
                  : '重新搜索这首歌'
            "
            @click="onRefresh"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13.2 6.2A5.4 5.4 0 1 0 13.4 9.2" />
              <path d="M13.4 2.8v3.5h-3.5" />
            </svg>
          </button>
        </div>
        <!-- 中：标题 + 项数 -->
        <div class="lt-center">
          <span class="lt-name">{{ title }}</span>
          <span class="lt-count">{{ countText }}</span>
        </div>
        <!--
          右：看一整列时是「放大镜 -> 点开搜索框」，看备选时是加号
          选中一条之后会自动清空并收回放大镜（见 onItemClick）
        -->
        <div class="lt-side lt-end">
          <template v-if="isBrowsePanel">
            <el-input
              v-if="searchOpen"
              ref="searchInput"
              v-model="keyword"
              size="small"
              class="lt-search"
              :placeholder="mode === 'ov' ? '搜索标题 / UP 主' : '搜索歌名 / 歌手 / 专辑'"
              clearable
              @keydown.esc.stop="closeSearch"
            />
            <button v-else class="lt-icon" title="搜索" @click="openSearch">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <circle cx="7.2" cy="7.2" r="4.4" />
                <path d="M10.6 10.6L13.6 13.6" />
              </svg>
            </button>
          </template>
          <button v-else class="lt-icon" title="添加视频" @click="ui.addVideoVisible = true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M8 3.2v9.6M3.2 8h9.6" />
            </svg>
          </button>
        </div>
      </div>
    </template>

    <div id="songListPanel" class="listBody" ref="listBody">
      <ul class="lists">
        <li
          v-for="row in rows"
          :key="row.index"
          :ref="(el) => setItemRef(row.index, el)"
          :class="{ active: row.index === currentIndex, missing: row.item.missing }"
          @click="onItemClick(row.item, row.index)"
        >
          <div class="index">{{ row.index + 1 }}</div>

          <!-- 封面：歌单取平台专辑图，视频取某站缩略图 -->
          <div class="cover">
            <img
              v-if="coverOf(row.item) && !failedCovers[coverOf(row.item) as string]"
              :src="coverOf(row.item) as string"
              :alt="nameOf(row.item)"
              referrerpolicy="no-referrer"
              loading="lazy"
              @error="onCoverError($event)"
            />
            <div v-else class="cover-fallback">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M6 12V4l7-1.5V10"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <circle cx="4.5" cy="12" r="1.8" stroke="currentColor" stroke-width="1.2" />
                <circle cx="11.5" cy="10" r="1.8" stroke="currentColor" stroke-width="1.2" />
              </svg>
            </div>
          </div>

          <!-- 文本区 -->
          <div class="meta">
            <div class="title" :title="plainTitleOf(row.item)" v-html="titleHtmlOf(row.item)"></div>
            <div class="sub">
              <span v-if="singerOf(row.item)" class="singer">{{ singerOf(row.item) }}</span>
              <span v-if="albumOf(row.item)" class="album" :title="albumOf(row.item)">
                {{ albumOf(row.item) }}
              </span>
              <!--
                本地文件丢了：列表里**先标出来**，而不是等播到它再报错。
                值来自主进程读条目时的 `stat`（见 VideoListItem.missing），不落库 ——
                文件插回移动硬盘、重新定位之后，下次读列表自然就没了。
              -->
              <span v-if="row.item.missing" class="missing-tag" title="本地文件已不在原位置">
                文件丢失
              </span>
            </div>
          </div>

          <!-- 时长 -->
          <div v-if="durationOf(row.item)" class="duration">{{ durationOf(row.item) }}</div>

          <!--
            收藏（空心爱心 / 实心爱心）

            **只有「视频列表」才有**：收藏的语义是「这条视频我要用」——
              - MV 的备选：收藏 = 「这首歌就播这条」的记忆；
              - OV 的列表：收藏 = 这个列表里的收藏，会置顶（同一套 `ord` 事务）。
            歌单里的歌不需要这个标记，收藏动作在歌单管理那边。
          -->
          <div
            v-if="!isSongList"
            class="fav"
            :class="{ on: isFav(row.item) }"
            :title="isFav(row.item) ? '取消收藏' : '收藏'"
            @click.stop="void queue.onToggleFavorite(bvidOf(row.item))"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              :fill="isFav(row.item) ? 'currentColor' : 'none'"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            >
              <path d="M8 13.1S2.3 9.7 2.3 6.2c0-1.7 1.3-3 3-3 1.2 0 2.2.7 2.7 1.7.5-1 1.5-1.7 2.7-1.7 1.7 0 3 1.3 3 3 0 3.5-5.7 6.9-5.7 6.9z" />
            </svg>
          </div>
        </li>
        <!-- 过滤之后一条都不剩：给个明确交代，别让人以为列表空了 -->
        <li v-if="rows.length === 0" class="empty">
          {{ emptyText }}
        </li>
      </ul>
    </div>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import type { PlaylistSong } from '@common/types/playlist';
import { formatDuration } from '@common/utils/duration';
import { normalizeImageUrl } from '../utils/image';
import { sanitizeTitleHtml, stripTags } from '../utils/title';
import { useUiStore } from '../stores/ui';
import { useQueueStore } from '../stores/queue';
import { usePlaybackStore } from '../stores/playback';

/**
 * 视频列表项（某站搜索结果）
 *
 * 只声明界面真正用到的展示字段。解析结果（播放地址）由主进程单独给出，
 * 不再整包回传到渲染层。
 */
export interface VideoListItem {
  bvid: string;
  title: string;
  /** 某站缩略图 */
  pic?: string | null;
  /** UP 主名 */
  author?: string | null;
  /**
   * 时长**秒数**（`null` / 缺省 = 未知）
   *
   * 某站搜索原始给的是 `"4:03"`，但主进程 `biliApi.extract` 在入口就转成秒了，
   * 所以到渲染层这里**只可能是数字**。
   */
  duration?: number | null;
  /**
   * 本地文件条目：文件此刻不在了
   *
   * 由主进程在读列表条目时顺手 `stat` 得出（**不落库**），只对 `lf_` 条目有意义。
   * 主列表据此把那一行压暗并打标 —— 播到它之前就能看见。
   */
  missing?: boolean;
}

type ListItem = PlaylistSong | VideoListItem;

const isVideoItem = (item: ListItem): item is VideoListItem =>
  typeof (item as VideoListItem).bvid === 'string';

/**
 * 两种「带 bvid 的条目」的公共字段视图
 *
 * 列表里可能混着两种形状，而且**都有 `bvid`**，所以 `isVideoItem` 分不开它们：
 *  - **搜索结果**（`VideoListItem`）：`title` / `pic` / `author`；
 *  - **视频列表条目**（`PlaylistSong`）：`name` / `cover` / `singer`（装的是 UP 主）。
 *
 * 取值时按「先搜索字段、再列表字段」的顺序回落，两个来源共用同一套展示逻辑 ——
 * 否则视频列表那些行会显示空标题、空封面、空 UP 主（踩过）。
 */
type ListItemFields = {
  title?: string
  name?: string
  pic?: string | null
  cover?: string | null
  author?: string | null
  singer?: string
  album?: string
}

const fieldsOf = (item: ListItem): ListItemFields => item as unknown as ListItemFields

/**
 * 一行里能拿来搜的文本：歌名 / 标题 / 歌手 / UP 主 / 专辑
 *
 * 两套字段都收进来（谁有算谁），过滤逻辑就不用再分「这是歌还是视频」——
 * 以前的做法是 `item as PlaylistSong` 之后只认 `name/singer/album`，
 * 换成视频条目（`title/author`）就一条都搜不到。
 */
const haystackOf = (item: ListItem): string => {
  const f = fieldsOf(item)
  return [f.title, f.name, f.singer, f.author, f.album]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()
}

/**
 * 时长文案（**秒 -> `mm:ss`**）
 *
 * ⚠️ 数据源头已经统一成**秒**了：
 *  - 某站搜索给的 `"4:03"` 在 `biliApi.extract` 入口就转成了秒；
 *  - 库里 `videos.duration` 一直是秒；
 *  - 歌单里的 `PlaylistSong.duration` 也是秒。
 *
 * 所以这里**只做一件事**：秒 → `mm:ss`（`formatDuration`）。
 * 不再需要「两种形状都要认」那套兼容逻辑 —— 那是数据格式没统一时代码，
 * 留着反而会让「明明已经从源头修好了，却还在下游各写一份解析」的坏习惯延续。
 */
const durationText = (raw: number | null | undefined): string => formatDuration(raw)

/*
 * 标题的转义 / 净化（`stripTags` / `sanitizeTitleHtml`）已经抽到 `utils/title.ts`，
 * 因为控制栏的跑马灯标题也要用同一套净化 —— 之前这份只在这里，
 * 那边直接用 v-html 渲染原始标题，等于留了个注入点。
 */

export default defineComponent({
  name: 'SongVideoListDialog',
  data() {
    return {
      /** 刷新图标正在转圈（0.5s） */
      spinning: false,
      _spinTimer: null as ReturnType<typeof setTimeout> | null,
      /**
       * 歌曲列表的过滤词（配合 searchOpen 使用）
       *
       * 只在歌曲列表生效（视频列表右上角是加号）；
       * 与歌单管理里的过滤保持一致：匹配 歌名 / 歌手 / 专辑。
       */
      keyword: '',
      /** 搜索框是不是展开着（收起时显示放大镜图标） */
      searchOpen: false,
      itemRefs: {} as Record<number, HTMLElement>,
      /**
       * 加载失败的封面地址集合
       *
       * 不能像原来那样对 `img` 直接写 `style.display = 'none'`：
       * 列表项是 `:key="index"`，切歌单 / 切到视频列表时同一位置的 `<li>`
       * 会被复用，那个内联样式既不会被 Vue 清掉，还会串到后来的歌上 ——
       * 结果是某一行一旦加载失败，那一行的封面就永远是空的。
       * 改成按地址记录，换一个地址就有一次新的机会。
       */
      failedCovers: {} as Record<string, boolean>,
    };
  },
  computed: {
    /**
     * 这些 store（播放状态按域拆成了多个）
     *
     * 这个弹窗**不再向父组件要数据、也不再 emit 意图** —— 面板该显示什么、
     * 点一行该干什么，全在 store 里。父组件（App.vue）只剩 `<SongVideoListDialog />`
     * 一行，连 prop 都不传。
     *
     * 下面那几个同名 computed 是刻意的：模板里还是写 `title` / `list` / `listType`，
     * 但它们现在来自 store 而不是 props —— 模板因此一行都不用改。
     *
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    ui() {
      return useUiStore();
    },
    queue() {
      return useQueueStore();
    },
    playback() {
      return usePlaybackStore();
    },
    /** 面板标题（歌单名 / 「视频列表 · 歌曲名」） */
    title(): string {
      return this.ui.panelTitle;
    },
    /** 面板里的条目：歌单是 PlaylistSong，视频列表是 VideoListItem */
    list(): ListItem[] {
      return this.ui.panelList as ListItem[];
    },
    listType(): string {
      return this.ui.listType;
    },
    /** 当前正在播的那一条在**面板**里的下标 */
    currentIndex(): number {
      return this.ui.panelIndex;
    },
    /** 当前这条已收藏的 bvid（MV 候选视频显示实心爱心） */
    favorites(): string[] {
      return this.queue.favoriteBvids;
    },
    /** 当前工作区：`ov` / `mv` */
    mode(): string {
      return this.queue.mode;
    },
    /** 面板装的是歌单（MV 的播放队列）。OV 里没有歌单这一层 */
    isSongList(): boolean {
      return this.listType === 'songList';
    },
    /**
     * 面板装的是「当前这一列」，还是「当前这条的备选」
     *
     *  - 看一整列（MV 的歌单 / OV 的合集）：能按关键词过滤、点行 = 播这一列的第 N 条；
     *  - 看备选（MV 的视频列表）：没有过滤（右上角是加号）、点行 = 换一个视频版本。
     *
     * `videoList` 在两个工作区里装的东西不同，这个判断就是那处差别**唯一**的落点。
     */
    isBrowsePanel(): boolean {
      return this.isSongList || this.mode === 'ov';
    },
    /**
     * 实际渲染的行
     *
     * 带着**原始下标**一起给模板：列表点击、高亮、「第几首」都必须用原始下标，
     * 否则过滤之后点第 1 行会去播整张歌单里的第 1 首（而不是过滤结果里的第 1 首）。
     */
    rows(): { item: ListItem; index: number }[] {
      const all = this.list.map((item, index) => ({ item, index }));
      if (!this.isBrowsePanel) return all;
      const kw = this.keyword.trim().toLowerCase();
      if (!kw) return all;
      return all.filter(({ item }) => haystackOf(item).includes(kw));
    },
    /** 头部计数：过滤时显示「命中 / 总数」 */
    countText(): string {
      if (this.isBrowsePanel && this.keyword.trim()) {
        return `${this.rows.length} / ${this.list.length} 项`;
      }
      return `${this.list.length} 项`;
    },
    /** 一条都没有时的提示（空库指向入口，过滤无结果只说没匹配） */
    emptyText(): string {
      if (this.isBrowsePanel && this.keyword.trim()) {
        return this.mode === 'ov' ? '没有匹配的视频' : '没有匹配的歌曲';
      }
      if (this.mode === 'ov') {
        return '这里还没有视频 —— 点左上角打开「视频管理」导入收藏夹，或新建一个本地列表';
      }
      return '列表是空的';
    },
  },
  watch: {
    listType(val: string) {
      if (val !== 'none') {
        /**
         * 每次打开都清掉「封面加载失败」的记录
         *
         * 那份记录以 URL 为键、跨整个界面生命周期累积：某张封面一次网络抖动失败后，
         * 该 URL 在**后续任何列表里**都永远显示兜底图标（即使这次已经能加载了），
         * 用户看到的是「封面时好时坏」。重新打开弹窗就是一次新的机会。
         */
        this.failedCovers = {};
        // 弹窗挂载 + 过渡要一点时间，等一拍再滚到当前项
        setTimeout(() => this.scrollToActive(), 120);
      } else {
        // 关掉时收起搜索并清掉过滤词：下次打开是完整列表 + 放大镜
        this.keyword = '';
        this.searchOpen = false;
      }
    },
  },
  methods: {
    setItemRef(index: number, el: unknown) {
      if (el) this.itemRefs[index] = el as HTMLElement;
      else delete this.itemRefs[index];
    },
    /** 歌名 / 视频标题 */
    nameOf(item: ListItem): string {
      const f = fieldsOf(item)
      return f.title ?? f.name ?? '';
    },
    /** 纯文本标题（用于 title 提示与 alt） */
    plainTitleOf(item: ListItem): string {
      return stripTags(this.nameOf(item));
    },
    /**
     * 标题 HTML
     *
     * 视频项保留某站的 `<em>` 关键词高亮（这是原始行为，必须保留）；
     * 歌单项没有搜索词可高亮，但同样走净化，避免曲目名里的 `<` 之类被当成标签。
     */
    titleHtmlOf(item: ListItem): string {
      return sanitizeTitleHtml(this.nameOf(item));
    },
    /** 歌手；视频项显示 UP 主 */
    singerOf(item: ListItem): string {
      const f = fieldsOf(item)
      return f.author ?? f.singer ?? '';
    },
    /** 专辑名（只有音乐歌单的条目才有） */
    albumOf(item: ListItem): string {
      return isVideoItem(item) ? '' : (item.album ?? '');
    },
    /** 封面：歌单用平台专辑图，视频用某站缩略图 */
    coverOf(item: ListItem): string | null {
      const f = fieldsOf(item)
      return normalizeImageUrl(f.pic ?? f.cover);
    },
    /**
     * 时长文案（两种列表项都存在 `duration` 字段，所以不必分支）
     *
     * `VideoListItem.duration` 和 `PlaylistSong.duration` 都是**秒数**
     * （见各自的类型注释），直接喂给 `durationText` 即可。
     */
    durationOf(item: ListItem): string {
      return durationText(item.duration);
    },
    /** 图片挂了就记下这个地址，露出兜底图标（避免一直显示破图） */
    onCoverError(e: Event) {
      const img = e.target as HTMLImageElement;
      const src = img.getAttribute('src');
      if (!src) return;
      // 兜底：长期浏览视频列表会让这张表慢慢变大，超了就整体清掉重来
      if (Object.keys(this.failedCovers).length > 2000) this.failedCovers = {};
      this.failedCovers[src] = true;
    },
    /** 视频项的 bvid（歌单项返回空串，模板里就不用写类型断言了） */
    bvidOf(item: ListItem): string {
      return isVideoItem(item) ? item.bvid : '';
    },
    /** 这一项是不是已收藏
     *
     * 两个来源：
     *  - MV 候选视频：`favorites`（这首歌选中的 bvid 列表）；
     *  - OV 列表条目：条目自己的 `favorites` 标记（同一个 bvid 换个列表就不一样，
     *    所以只能挂在条目上，不能挂在视频上）。
     */
    isFav(item: ListItem): boolean {
      const bvid = this.bvidOf(item);
      if (!bvid) return false;
      if (this.favorites.includes(bvid)) return true;
      return (item as PlaylistSong).favorites === true;
    },
    /**
     * 左上角刷新
     *
     * 先复位再激活，保证连点也能重新播放转圈动画（CSS 动画靠类名重加才会重播）。
     * 真正干什么由 store 按列表类型决定（`onListRefresh`）。
     */
    onRefresh(): void {
      this.spinning = false;
      void this.$nextTick(() => {
        this.spinning = true;
        if (this._spinTimer) clearTimeout(this._spinTimer);
        this._spinTimer = setTimeout(() => {
          this.spinning = false;
          this._spinTimer = null;
        }, 500);
      });
      void this.queue.onListRefresh();
    },
    /** 展开搜索框并聚焦（放大镜点一下） */
    openSearch(): void {
      this.searchOpen = true;
      void this.$nextTick(() => {
        const input = this.$refs.searchInput as { focus?: () => void } | undefined;
        input?.focus?.();
      });
    },
    /** 收起搜索：清空过滤词，回到放大镜状态 */
    closeSearch(): void {
      this.keyword = '';
      this.searchOpen = false;
    },
    onItemClick(item: ListItem, index: number) {
      if (this.isBrowsePanel) {
        void this.queue.onBrowsePlay(index);
        this.closeSearch();
        /**
         * 收回搜索后，滚到**刚点的这首**（不是 currentIndex）
         *
         * 踩过两次：
         *  1. 不滚的话，浏览器保住滚动锚点，点的那行被钉在列表顶部，看着像「它变成了第一首」；
         *  2. 滚 `currentIndex` 也不行 —— 那是 store 里的值，切歌是异步的，
         *     这一刻它还是**上一首**的下标，于是滚到了上一首的位置（用户反馈：没滚到正在播的这首）。
         * 自己点的下标是确定的，直接用它；再补一次延迟滚动，防列表稍后重渲染把位置带偏。
         */
        const scrollToPicked = (): void => this.scrollToIndex(index, false);
        void this.$nextTick(() => {
          scrollToPicked();
          setTimeout(scrollToPicked, 120);
        });
        return;
      }
      void this.playback.playCandidate((item as VideoListItem).bvid);
    },
    /**
     * el-dialog 关掉时（点空白处 / Esc）把 listType 置回 none
     *
     * 以前是 emit('showList', 'none') 让 App.vue 去改 —— 现在这个开关只有
     * 一个落点，直接写 store。
     */
    onVisibleChange(visible: boolean): void {
      if (!visible) this.ui.listType = 'none';
    },
    /** 把第 index 行滚进视野（默认居中、平滑） */
    scrollToIndex(index: number, smooth = true): void {
      const el = this.itemRefs[index];
      if (el) el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    },
    scrollToActive() {
      this.scrollToIndex(this.currentIndex);
    },
  },
});
</script>

<style>
/*
 * 外框（底色 / 圆角 / 模糊 / 白字 + 阴影）由 `styles/global.css` 里 `.el-dialog` 提供，
 * 这里只管列表内部。
 */
.listTitle {
  color: inherit;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  /*
   * 三列：左（刷新）/ 中（标题）/ 右（加号）。
   * 注意左右各自包了一层 `.lt-side`：直接放 4 个元素的话，第四个会被挤到第二行、
   * 也就是跑到左边去（加号「跑到左上角」就是这么来的）。
   */
  padding: 0 2px;
}
.lt-side {
  display: flex;
  align-items: center;
  /* 右列靠右：宽度相同才不会把中间标题挤偏 */
  min-width: 26px;
}
.lt-end {
  justify-content: flex-end;
}
/* 歌曲列表右上角的搜索框（和歌单管理里那个一样的作用） */
.lt-search {
  width: 180px;
}
.lt-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-width: 0;
}
/* 左上角刷新 / 右上角加号：同一种图标按钮 */
.lt-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
  transition: background 0.15s, opacity 0.15s;
}
.lt-icon:hover {
  background: var(--panel-hover);
  opacity: 1;
}
/* 点一下转 360°、0.5s */
.lt-icon.spin svg {
  animation: lt-spin 0.5s ease;
}
@keyframes lt-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
/* 收藏爱心：空心 -> 实心 */
.fav {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  opacity: 0.55;
  color: var(--panel-text);
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}
.fav:hover {
  background: var(--panel-hover);
  opacity: 1;
}
.fav.on {
  opacity: 1;
  color: var(--accent-danger);
}
.lt-name {
  font-weight: 600;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lt-count {
  font-size: calc(12px * var(--fs));
  opacity: 0.55;
}

.listBody {
  max-height: 56vh;
  overflow-y: auto;
  /*
   * 关掉滚动锚定
   *
   * 过滤时行数从 200+ 变成几行、再变回来，浏览器会「保住锚点」自己跳位置，
   * 表现就是被点的那一行顶在列表最上面（看着像它变成了第一首）。定位我们自己做。
   */
  overflow-anchor: none;
}

.lists {
  list-style: none;
  margin: 0;
  padding: 0;
}

.lists li {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  /* 文字颜色/阴影都从 `.el-dialog` 继承（白字 + 主题对应的阴影） */
  color: inherit;
  margin: 1% 0;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.lists li:hover {
  background: var(--panel-hover);
}

.lists .index {
  flex: none;
  width: 32px;
  text-align: center;
  padding: 4px 0;
  border-radius: 4px;
  font-size: calc(12px * var(--fs));
  background: rgba(var(--text-rgb), 0.16);
  border: 1px solid rgba(var(--text-rgb), 0.22);
  color: var(--panel-text);
}

/* 封面：只管高度，宽度按原图比例自适应，两侧留白并居中
   （不要用固定正方形 + cover，那会把长方形封面裁掉） */
.lists .cover {
  flex: none;
  height: 40px;
  min-width: 40px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.lists .cover img {
  height: 40px;
  width: auto;
  max-width: 96px;
  object-fit: contain;
  display: block;
}
.lists .cover-fallback {
  width: 40px;
  height: 40px;
  color: var(--panel-text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 文本区 */
.lists .meta {
  flex: 1;
  min-width: 0;
}
.lists .title {
  font-size: calc(13px * var(--fs));
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*某站搜索结果里的关键词高亮（<em class="keyword">），保留原有观感 */
.lists .title :deep(em),
.lists .title em {
  font-style: normal;
  font-weight: 600;
  color: var(--accent-danger);
}
.lists .sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: calc(11px * var(--fs));
  opacity: 0.7;
  overflow: hidden;
}
.lists .singer {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lists .album {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.lists .album::before {
  content: '· ';
}
/* 本地文件失效：压暗整行 + 一个小红标（点进去仍会尝试播放，失败后弹重新定位） */
.lists li.missing .index,
.lists li.missing .title,
.lists li.missing .cover {
  opacity: 0.45;
}
.lists .missing-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: calc(10px * var(--fs));
  line-height: 15px;
  color: #fff;
  background: var(--accent-danger);
}
.lists .duration {
  flex: none;
  font-size: calc(11px * var(--fs));
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

/* 过滤后一条都不剩 / 列表本身为空 */
.lists li.empty {
  justify-content: center;
  font-size: calc(12px * var(--fs));
  opacity: 0.55;
  cursor: default;
}
.lists li.empty:hover {
  background: transparent;
}

.lists li:nth-child(2n) .index {
  background: rgba(var(--text-rgb), 0.24);
  border-color: rgba(var(--text-rgb), 0.32);
  color: var(--panel-text);
}

.lists li.active {
  background: var(--panel-active);
}
.lists li.active .index {
  background: var(--panel-active);
  border-color: rgba(var(--text-rgb), 0.32);
  color: var(--panel-text);
}
.lists li.active .title {
  font-weight: 600;
}
</style>
