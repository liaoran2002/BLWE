/**
 * Ui store —— 界面状态：弹窗开关、列表面板、错误文案、网络忙标记与清晰度冷却。
 *
 * 状态与动作都只属于这一个业务域；跨域访问通过 getters 里那几个 `xxxStore`
 * 指针拿到别的 store 实例（惰性求值，所以模块之间可以互相 import 而不成环）。
 */
import { defineStore } from 'pinia';
import { keyOf } from '../types/playItem';
import type { PlayItem } from '../types/playItem';
import type { VideoListItem } from '@common/types/playlist';
import type { ListType, AppData } from '../types/app';
import { ElMessage, ElNotification } from 'element-plus';
import electronApi from '../api/electron';
import type { ParsedVideoInfo } from '@common/types/ipc';
import { QUALITY_COOLDOWN_MS, NET_BUSY_HINT_MS } from './constants';

import { usePlaybackStore } from './playback';
import { usePlaylistStore } from './playlists';
import { useQueueStore } from './queue';
import { useSessionStore } from './session';
import { useVideoListStore } from './videoLists';

/** ===== state ===== */
export type UiState = Pick<
  AppData,
  'listType' | 'playlistManagerVisible' | 'videoListVisible' | 'browseVideoListId' | 'ovSongs' | '_emptyNotified' | 'settingsVisible' | 'aboutVisible' | 'addVideoVisible' | '_netBusyCount' | '_qualityCooldownUntil' | '_qualityCooldownTimer' | '_lastNetBusyHintAt'
>;

export const uiState = (): UiState => ({
  listType: 'none',

  /** 歌单管理弹窗（新建/编辑/同步/曲目浏览都在里面） */
  playlistManagerVisible: false,

  /** B 站视频列表弹窗（收藏夹 / 合集 / 系列的导入与浏览） */
  videoListVisible: false,

  /** 视频管理页当前浏览的列表（≠ 正在播的那个） */
  browseVideoListId: '',

  /** 视频管理页当前浏览列表的条目 */
  ovSongs: [] as VideoListItem[],

  /** 空库提示只弹一次 */
  _emptyNotified: false,

  /** 设置弹窗 */
  settingsVisible: false,

  /** 关于弹窗 */
  aboutVisible: false,

  /** 「添加视频」弹窗（视频列表右上角的加号） */
  addVideoVisible: false,

  /**
   * ★ **当前有几个网络请求在飞**（搜索 / 解析播放地址）
   *
   * 用于把控制栏里**会再发请求**的控件禁掉（切歌、清晰度/音质切换）——
   * 用户狂点切歌会让请求成倍打出去，B站直接 412 风控。
   *
   * 用**计数器**而不是布尔：搜索和解析会并发（切歌时先搜索、再解析地址），
   * 布尔会被先结束的那个提前清掉，于是「解析还没完」时按钮已经解禁了。
   */
  _netBusyCount: 0,

  /**
   * ★ **清晰度 / 音质切换后的冷却截止时间戳**（毫秒）
   *
   * 切换清晰度会 `changeVideo(skipCache: true)` **重新解析地址**（发请求），
   * 所以它本来就被 `_netBusyCount` 盖住。但那个计数在请求结束时立刻归零，
   * 用户马上又能点下一次 —— 连点几下就是连着几个重新解析请求。
   *
   * 所以额外加一道**固定 3 秒冷却**：改完清晰度/音质的 3 秒内，
   * 那两个下拉保持禁用（`0` = 没有冷却）。
   */
  _qualityCooldownUntil: 0,

  /** 上面那个冷却的定时器句柄（重复调用时先清掉旧的，避免堆定时器） */
  _qualityCooldownTimer: null as ReturnType<typeof setTimeout> | null,

  /**
   * 上次提示「正在加载，先别点」的时间戳（毫秒）
   *
   * 用于给 `notifyNetBusy()` 节流 —— 连点时别让 toast 刷屏。
   */
  _lastNetBusyHintAt: 0,
});

/** ===== getters ===== */
export interface UiGetters {
  readonly playbackStore: ReturnType<typeof usePlaybackStore>;
  readonly playlistsStore: ReturnType<typeof usePlaylistStore>;
  readonly queueStore: ReturnType<typeof useQueueStore>;
  readonly sessionStore: ReturnType<typeof useSessionStore>;
  readonly videoListsStore: ReturnType<typeof useVideoListStore>;
  readonly netBusy: boolean;
  readonly qualityBusy: boolean;
  readonly browseSongs: PlayItem[];
  readonly browseName: string;
  readonly browseIndex: number;
  readonly panelIsBrowse: boolean;
  readonly panelTitle: string;
  readonly panelList: PlayItem[];
  readonly panelIndex: number;
}

export type UiGetterFns = { [K in keyof UiGetters]: () => UiGetters[K] };

export const uiGetters: ThisType<UiContext> = {
  playbackStore: () => usePlaybackStore(),
  playlistsStore: () => usePlaylistStore(),
  queueStore: () => useQueueStore(),
  sessionStore: () => useSessionStore(),
  videoListsStore: () => useVideoListStore(),
  /*
   * `tagBonusConfig`（关键词加权表）也已搬走 —— 它唯一的用途是喂给
   * `tagBonus()` 打分，而打分现在在主进程（`@common/utils/videoRank`，
   * 直接读主进程的设置）。渲染层不再需要这份配置。
   */
  /**
   * ★ **有网络请求在飞**（传给控制栏禁用「会发请求」的控件）
   *
   * 见 `_netBusyCount` 的注释。这里只做 `> 0` 的转换，
   * 真正的加减在 `beginNet()` / `endNet()` 里。
   *
   * ⚠️ 它**不含**清晰度冷却 —— 那个单独由 `qualityBusy` 表达，
   * 因为「切歌按钮」没必要因为「刚改过清晰度」被禁 3 秒。
   */
  netBusy(): boolean {
    return this._netBusyCount > 0;
  },

  /**
   * ★ **清晰度 / 音质下拉是否该禁用**
   *
   * 两个来源任一成立就禁：
   *  - `netBusy`：正在解析地址（切换本来就要重新解析，等它做完）；
   *  - **固定 3 秒冷却**：`_qualityCooldownUntil` 还没到
   *    （改动完成后 3 秒内不许再改，防止连点打出一串解析请求）。
   *
   * ⚠️ 冷却**到点时有 `setTimeout` 把它清成 0**（见 `startQualityCooldown`）——
   * 光靠「现在时间 < 截止时间」这个比较，时间流逝本身不会触发重渲染，
   * 3 秒后界面会一直卡在禁用状态。
   */
  qualityBusy(): boolean {
    return this.netBusy || Date.now() < this._qualityCooldownUntil;
  },

  /**
   * 列表面板在看的那份条目（可能 ≠ 播放队列：切模式时播放不打断）
   *
   * OV 是视频条目（原样的 `VideoListItem`），MV 是歌单曲目 —— 所以是联合类型。
   */
  browseSongs(): PlayItem[] {
    if (this.queueStore.mode === 'ov') return this.ovSongs;
    return this.playlistsStore.current?.songs ?? [];
  },

  /** 列表面板标题 */
  browseName(): string {
    if (this.queueStore.mode === 'ov') {
      return this.videoListsStore.find(this.browseVideoListId)?.name ?? '';
    }
    return this.playlistsStore.current?.name ?? '';
  },

  /**
   * 播放项在「正在看的列表」里的下标（-1 = 不在其中，就不高亮）
   *
   * 切模式后播放的是另一边的条目，此时不该在列表里点亮任何一行 ——
   * 拿 `currentIndex` 直接当高亮用的后果是「在 MV 列表里点亮了第 3 首，
   * 而实际在播的是 OV 的第 3 条」。
   */
  browseIndex(): number {
    const current = this.queueStore.currentItem;
    if (!current) return -1;
    /** 视频是 `bv:<bvid>`、歌是 `歌名-歌手` —— 拼法收在 `cacheKeyOf()` 里 */
    const key = keyOf(current);
    return this.browseSongs.findIndex((item) => keyOf(item) === key);
  },

  /**
   * 列表面板装的是「当前这一列」，还是「当前这条的备选」
   *
   *  | 面板 | 工作区 | 里面是什么 |
   *  | --- | --- | --- |
   *  | `songList`  | MV | 当前歌单的曲目 → **这一列** |
   *  | `videoList` | OV | 当前合集 / 收藏夹的条目 → **这一列** |
   *  | `videoList` | MV | 这首歌的 B 站搜索结果 → **备选** |
   *
   * 两个 `videoList` 装的东西确实不同（一个是一整个合集，一个是同一首歌的几个版本），
   * 但对外都是「一行一个视频」，所以**面板名不变，只在这里落一次来源** ——
   * 这是 OV / MV 唯一消不掉的差别，收在这一处，别再散回模板和子组件。
   */
  panelIsBrowse(): boolean {
    return this.listType === 'songList' || this.queueStore.mode === 'ov';
  },

  /** 面板标题：看一整列时用列表名，看备选时用当前这条的名字 */
  panelTitle(): string {
    return this.panelIsBrowse ? this.browseName : this.queueStore.songDisplayName;
  },

  /** 面板数据 */
  panelList(): PlayItem[] {
    // videoList 是搜索/收藏接口回的裸视频条目，形状上就是 VideoListItem
    return this.panelIsBrowse ? this.browseSongs : (this.queueStore.videoList as unknown as PlayItem[]);
  },

  /** 面板里高亮哪一行（-1 = 不在其中，不高亮） */
  panelIndex(): number {
    return this.panelIsBrowse ? this.browseIndex : this.queueStore.currentVideoIndex;
  }
};

/** ===== actions ===== */
export interface UiActions {
  errMsg(err: unknown): string;
  showList(event: ListType): void;
  openManager(page?: 'mv' | 'ov'): Promise<void>;
  closeManagers(): void;
  loadBrowseList(): Promise<void>;
  onVideoListBrowse(id: string): Promise<void>;
  refreshBrowseAfterEdit(): Promise<void>;
  isLibraryEmpty(): boolean;
  notifyEmptyLibrary(): void;
  onAddVideo(info: ParsedVideoInfo): Promise<void>;
  beginNet(): void;
  endNet(): void;
  withNet<T>(fn: () => Promise<T>): Promise<T>;
  startQualityCooldown(): void;
  notifyNetBusy(): void;
  notifyFilteredEmpty(songName: string): void;
  notifySearchEmpty(songName: string): void;
}

export type UiContext = UiState & UiGetters & UiActions;

export const uiActions: ThisType<UiContext> = {
  /**
   * 统一把 unknown 类型的 catch 错误转成**可读文案**
   *
   * ## ⚠️ 这里是「所有错误显示给用户」的**收口**，所以要做一道过滤
   *
   * 主进程抛的 message 多半是人话（我们各处都在注意措辞），但**不能假设**：
   * 将来任何一处 `throw new Error('HTTP 500')` / 接口原文透传，都会经这里
   * 显示到界面上 —— 用户看不懂，而且可能把内部实现写进截图里。
   *
   * 所以这里做一次**兜底替换**：认出「明显是技术文案」的就换成通用人话，
   * 原文只进控制台。判定故意写得宽松（宁可多换一次，也别漏出去）。
   */
  errMsg(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? '');
    /**
     * 技术文案的特征：状态码 / 全大写错误码 / 常见内部术语。
     * 命中就替换成通用文案（真实内容打进控制台，排查不受影响）。
     */
    const looksTechnical =
      /^(HTTP|ERR_|NAV_FAILED|AUTH_FAILED)/.test(raw) ||
      /SourceBuffer|MediaSource|SetParent|WorkerW|fnval|wbi|SourceBuffer/i.test(raw) ||
      /\b(4\d{2}|5\d{2})\b/.test(raw);
    if (looksTechnical) {
      console.warn('[ui] 错误文案含技术细节，已替换为通用提示。原文：', raw);
      return '操作失败，请稍后再试';
    }
    return raw;
  },

  showList(event: ListType): void {
    this.listType = this.listType == event ? 'none' : event;
  },

  /**
   * 打开「管理器」
   *
   * 两个管理器（歌单管理 / 视频管理）共用一个弹窗位置：`page` 决定弹出哪一页，
   * 不传就按**当前工作区**（= 正在播哪一边）打开。
   *
   * ⚠️ **只开弹窗，不切工作区**。以前这里会顺手把 `ui.mode` 改掉，于是
   * 点一下「歌单管理」主界面就切成歌单的双列表 —— 哪怕正在播视频。
   * 工作区现在只由播放源决定（见 `queue.mode`），这里不参与。
   */
  async openManager(page?: 'mv' | 'ov'): Promise<void> {
    const target = page ?? this.queueStore.mode;
    this.playlistManagerVisible = target === 'mv';
    this.videoListVisible = target === 'ov';
    /** 弹窗里要看的那份列表按需重读一次（切歌会改 lastIndex，store 那份是旧值） */
    if (target === 'ov') await this.loadBrowseList();
  },

  /** 关掉两个管理弹窗（拖入导入前调用：弹窗挡着，用户看不到画面） */
  closeManagers(): void {
    this.playlistManagerVisible = false;
    this.videoListVisible = false;
  },

  /**
   * 载入「视频管理页正在看的那个列表」的条目
   *
   * 优先用上次选中的；它被删了/从没选过就退回「正在播的列表」，再退回第一个。
   * 纯读库，不联网。
   */
  async loadBrowseList(): Promise<void> {
    if (this.videoListsStore.lists.length === 0) {
      this.browseVideoListId = '';
      this.ovSongs = [];
      return;
    }
    const exists = this.videoListsStore.find(this.browseVideoListId);
    if (!exists) {
      this.browseVideoListId =
        this.videoListsStore.activeId || this.videoListsStore.lists[0]?.id || '';
    }
    if (!this.browseVideoListId) {
      this.ovSongs = [];
      return;
    }
    try {
      this.ovSongs = await this.videoListsStore.items(this.browseVideoListId);
    } catch (err) {
      console.warn('[videolist] 读取列表条目失败', err);
      this.ovSongs = [];
    }
  },

  /** 视频管理页左侧选中了另一个列表（只换浏览，不动播放） */
  async onVideoListBrowse(id: string): Promise<void> {
    this.browseVideoListId = id;
    await this.loadBrowseList();
  },

  /**
   * 视频管理的条目被改过（加/删/收藏/重命名/同步）后重新对齐界面
   *
   * 关键在**置顶会重排**：收藏或手动加一条会把它挪到最前，全体下标 +1。
   * 只重读列表不重算下标的话，正在播的那条在 `songs` 里就换了位置 ——
   * 用户点一下「下一个视频」会跳到意料之外的一条。
   */
  async refreshBrowseAfterEdit(): Promise<void> {
    await this.loadBrowseList();
    if (this.queueStore.mode !== 'ov') return;
    if (!this.videoListsStore.activeId ||
        this.videoListsStore.activeId !== this.browseVideoListId) {
      return;
    }
    const bvid = this.queueStore.songs[this.queueStore.currentIndex]?.bvid;
    const index = bvid ? this.ovSongs.findIndex((song) => song.bvid === bvid) : -1;
    this.queueStore.songs = this.ovSongs;
    if (index >= 0) this.queueStore.currentIndex = index;
    // 顺序变了：随机表与预热槽位都按下标算，必须一起作废
    this.playbackStore.resetRandomList();
    this.playbackStore.clearAllWarm();
  },

  /**
   * 库是不是「空的」（没有任何可播内容）
   *
   * ⚠️ **不能只看「有几个列表」**：启动时会自动建一个「默认列表」，
   * 列表数量从第一次打开起就是 1，用旧判据那句话永远不出现。
   * 现在按**条目**算：视频侧看所有列表的条目加起来是不是 0，音乐侧看有没有歌单。
   */
  isLibraryEmpty(): boolean {
    if (this.queueStore.mode === 'mv') return this.playlistsStore.playlists.length === 0;
    const lists = this.videoListsStore.lists;
    if (lists.length === 0) return true;
    return lists.every((item) => (item.itemCount ?? 0) === 0);
  },

  /**
   * 空库提示（不弹窗）
   *
   * 用户明确要求：没有数据时**不要**自动打开管理器，一行字告诉他从哪开始。
   * 点这条提示直接打开管理器 —— 不然「告诉我要导入」却不给入口，等于废话。
   *
   * 文案以**拖入**为首选路径（这是最省事的一条），弹窗入口作为兜底；
   * 点提示仍然打开管理器。
   */
  notifyEmptyLibrary(): void {
    if (this._emptyNotified || !this.isLibraryEmpty()) return;
    this._emptyNotified = true;
    ElNotification({
      title: '还没有任何内容',
      message:
        this.queueStore.mode === 'ov'
          ? '把 B 站视频 / 合集 / 收藏夹链接拖进窗口就能直接播放；也可以登录 B 站账号导入收藏夹'
          : '把网易云 / QQ音乐的歌单链接拖进窗口就能直接播放；也可以新建歌单、按行填写「歌名-歌手」',
      type: 'info',
      duration: 10000,
      onClick: () => {
        void this.openManager(this.queueStore.mode);
      },
    });
  },

  /** 「添加视频」确认：加进候选列表并收藏（收藏 = 排在最前面） */
  async onAddVideo(info: ParsedVideoInfo): Promise<void> {
    if (!this.queueStore.currentKey) return;
    const songName = this.queueStore.currentKey;
    if (!this.queueStore.videoList.some((v) => v.bvid === info.bvid)) {
      this.queueStore.videoList = [
        {
          bvid: info.bvid,
          title: info.title,
          pic: info.pic,
          author: info.author,
          duration: info.duration,
        },
        ...this.queueStore.videoList,
      ];
    }
    try {
      /**
       * 走 `setFavorite` 而不是新增一个「加视频」接口：
       * 添加的语义就是「这首歌多一个我一定要用到的候选」，也就是收藏。
       * 主进程会在库里补插这一行（搜索没搜到的 bvid 本来不在 videos 表里），
       * 并把它挪到第一位 —— 与收藏完全同一条路径，不需要另写一套。
       */
      const { favorites } = await this.withNet(() => electronApi.setFavorite(songName, info.bvid, true));
      const favSet = new Set(favorites);
      this.queueStore.videoList = this.queueStore.videoList.map((v) => ({
        ...v,
        favorites: favSet.has(v.bvid),
      }));
      const idx = this.queueStore.videoList.findIndex((v) => v.bvid === info.bvid);
      if (idx > 0) {
        const [moved] = this.queueStore.videoList.splice(idx, 1);
        this.queueStore.videoList.unshift(moved);
      }
    } catch (err) {
      ElMessage.error(`添加视频失败：${this.errMsg(err)}`);
      return;
    }
    this.queueStore.currentVideoIndex = this.queueStore.videoList.findIndex((v) => v.bvid === this.playbackStore.currentBvid);
    ElMessage.success(`已添加《${info.title || info.bvid}》`);
  },

  /**
   * ★ 标记「开始一个网络请求」（会让控制栏里发请求的控件禁用）
   *
   * ## 为什么必须配对使用
   *
   * `beginNet()` / `endNet()` 用**计数器**而不是布尔：
   * 切歌时「搜索 → 解析地址」是两段连续的请求，中间还可能并发别的。
   * 用布尔会被先结束的那个提前清掉，于是「解析还没完」时按钮已经解禁，
   * 用户又能点下一首 —— 正是我们要拦掉的场景。
   *
   * ## 用法（务必 try/finally）
   *
   * ```ts
   * this.beginNet()
   * try { await electronApi.searchSong(...) } finally { this.endNet() }
   * ```
   *
   * `finally` 是必须的：请求抛错时如果不减，计数器永远 > 0，
   * **控制栏会一直禁着**（比风控还糟）。所以下面所有调用点都写成
   * `try/finally` 而不是「成功后 endNet」。
   */
  beginNet(): void {
    this._netBusyCount += 1;
  },

  /** 标记「一个网络请求结束」（配对 `beginNet`，必须在 finally 里调） */
  endNet(): void {
    this._netBusyCount = Math.max(0, this._netBusyCount - 1);
  },

  /**
   * ★ 包住一个**会发网络请求**的调用：期间禁用控制栏里发请求的控件
   *
   * ```ts
   * const res = await this.withNet(() => electronApi.searchSong(song, singer))
   * ```
   *
   * 为什么不每处手写 `try/finally`：调用点有近十个，漏一个 `endNet`
   * 就会让**控制栏永久禁着**（比风控还糟）。收成一个包装器，
   * 所有调用点写法一致，`finally` 只在这一个地方出现。
   *
   * 泛型保留原返回值类型（`electronApi` 那些方法的返回值形状不变）。
   */
  async withNet<T>(fn: () => Promise<T>): Promise<T> {
    this.beginNet();
    try {
      return await fn();
    } finally {
      this.endNet();
    }
  },

  /**
   * ★ 启动「清晰度 / 音质」改完后的**3 秒冷却**
   *
   * 期间那两个下拉保持禁用，防止连点 —— 每点一次都会
   * `playCandidate(bvid, { skipCache: true })` 重新解析地址，连点就是连着几个请求。
   *
   * ## 为什么用 `setTimeout` 清标记，而不是每次渲染时算
   *
   * 光判「`Date.now() < 截止时间`」的话，时间流逝**不会触发 Vue 重渲染** ——
   * 3 秒后界面会一直停在禁用状态，直到别的原因让它重渲染一次。
   * `setTimeout` 到点把标记清成 0，那个赋值本身就会触发重渲染，界面自然解锁。
   *
   * 重复调用是安全的：前一个定时器会被记下来并清掉（`_qualityCooldownTimer`），
   * 所以不会堆一串定时器。
   */
  startQualityCooldown(): void {
    this._qualityCooldownUntil = Date.now() + QUALITY_COOLDOWN_MS;
    if (this._qualityCooldownTimer !== null) clearTimeout(this._qualityCooldownTimer);
    this._qualityCooldownTimer = setTimeout(() => {
      this._qualityCooldownTimer = null;
      this._qualityCooldownUntil = 0;
    }, QUALITY_COOLDOWN_MS);
  },

  /**
   * ★ 提示「正在加载，先别点」——**必须给反馈**，否则用户以为按钮坏了
   *
   * 请求在飞的时候，控制栏的切歌按钮被灰掉、托盘/媒体键被忽略。
   * 但「点了没反应」和「按钮坏了」在用户看来是一样的 —— 所以补一条提示。
   *
   * 用 `$message`（顶部一闪而过的 toast）而不是 `$notify`（右上角浮层）：
   *  - 这事**不需要用户做什么**，只是告诉他「等一下，不是坏了」；
   *  - 而且它可能被连续触发（用户连点），浮层会叠一屏 —— toast 只有一条。
   *
   * 加**节流**（`NET_BUSY_HINT_MS`）：连点时别刷屏。
   */
  notifyNetBusy(): void {
    const now = Date.now();
    if (now - this._lastNetBusyHintAt < NET_BUSY_HINT_MS) return;
    this._lastNetBusyHintAt = now;
    /**
     * ⚠️ 文案**不提技术细节**（别说「限流」「请求被拦」）——
     * 用户会截图。只说「在加载、等一下」就够，这也是他需要知道的全部。
     */
    ElMessage.info('正在加载中，请稍候……');
  },

  /**
   * **结果被过滤规则全部挡掉**时的提示
   *
   * 和 `notifySearchEmpty`（搜索真失败）是两件事，所以提示也要分开：
   * 这里搜索是成功的，问题出在**过滤规则太严**，解决办法是去设置里放宽。
   * 说成「网络有问题」会让用户白折腾半天。
   */
  notifyFilteredEmpty(songName: string): void {
    ElNotification({
      title: `《${songName}》的结果都被过滤掉了`,
      message:
        '搜索是成功的，但结果都不符合当前的过滤规则（标题不含歌名 / 时长差太多 / 命中过滤关键词）。' +
        '可以去「设置 → 搜索」里放宽时长容差或删掉一些过滤关键词。',
      type: 'warning',
      duration: 9000,
    });
  },

  /**
   * 搜索没结果时的提示
   *
   * 分两种情况说，因为**解决办法完全不同**：
   *  - 未登录：提示去登录（登录后能搜到的确实更多）；
   *  - 已登录：更可能是本机网络 / 代理的问题，提示检查网络。
   *
   * ⚠️ 文案里**不要提「重试了几次」**（现在的代码根本不重试，
   * 说重试过是假话）；也**不要描述 B 站的返回机制**
   * （「只返回部分结果」这种说法把内部行为写在用户屏幕上，没必要）——
   * 只说「登录后通常能找到」就够了。
   *
   * 用 `$notify`（右上角浮层）而不是 `$message`（一闪而过的 toast）：
   * 这两句话都带操作指引，用户需要时间读，而且要点右上角头像去登录。
   */
  notifySearchEmpty(songName: string): void {
    if (!this.sessionStore.isLoggedIn) {
      ElNotification({
        title: `《${songName}》没有找到视频`,
        message: '登录后再试一次，通常就能找到了。点右上角头像登录。',
        type: 'warning',
        duration: 8000,
      });
      return;
    }
    ElNotification({
      title: `《${songName}》没有找到视频`,
      message: '请检查一下网络连接（或代理 / VPN）是否正常，稍后再试。',
      type: 'error',
      duration: 8000,
    });
  }
};

export const useUiStore = defineStore<
  'ui',
  UiState,
  UiGetterFns,
  UiActions
>('ui', {
  state: uiState,
  getters: uiGetters as never,
  actions: uiActions as UiActions,
});

/** 组件侧需要标注 store 类型时用它 */
export type UiStore = ReturnType<typeof useUiStore>;
