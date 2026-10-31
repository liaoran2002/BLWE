/**
 * Queue store —— 播放队列：列表数据、当前下标与模式、歌单/视频列表装载、候选视频刷新。
 *
 * 状态与动作都只属于这一个业务域；跨域访问通过 getters 里那几个 `xxxStore`
 * 指针拿到别的 store 实例（惰性求值，所以模块之间可以互相 import 而不成环）。
 */
import { defineStore } from 'pinia';
import { isVideoItem, keyOf, titleOf, isSongItem, subtitleOf } from '../types/playItem';
import type { PlayItem } from '../types/playItem';
import type { PlaylistSong } from '@common/types/playlist';
import type { BiliVideo, AppData } from '../types/app';
import { ElMessage } from 'element-plus';
import electronApi from '../api/electron';
import type { AppSetting } from '@common/types/app_setting';
import { PLAY_LOOP_MODES } from '@common/constants';

import { usePlaybackStore } from './playback';
import { usePlaylistStore } from './playlists';
import { useSettingStore } from './setting';
import { useSystemStore } from './system';
import { useUiStore } from './ui';
import { useVideoListStore } from './videoLists';

/** ===== state ===== */
export type QueueState = Pick<
  AppData,
  'songs' | 'videoList' | 'videoListKeyword' | 'randomList' | 'currentIndex' | 'currentVideoIndex' | 'MODE' | 'currentMode' | 'videoName' | 'currentKey' | 'listName' | '_ovSkipStreak'
>;

export const queueState = (): QueueState => ({
  songs: [] as PlayItem[],

  videoList: [],

  /**
   * `videoList` 属于哪一首歌（缓存键）
   *
   * `changeSong` 会立刻把 `songName` 切成新歌，但 `videoList` 要等搜索
   * 回来才换。用这个字段标明列表的归属，避免拿上一首的视频干新歌的事。
   */
  videoListKeyword: '',

  randomList: [],

  currentIndex: 0,

  currentVideoIndex: 0,

  MODE: { read: 0, single: 1, random: 2 },

  currentMode: 0,

  videoName: '',

  currentKey: '',

  listName: '',

  /** OV 连续取不到地址的条数 */
  _ovSkipStreak: 0,
});

/** ===== getters ===== */
export interface QueueGetters {
  readonly playbackStore: ReturnType<typeof usePlaybackStore>;
  readonly playlistsStore: ReturnType<typeof usePlaylistStore>;
  readonly settingStore: ReturnType<typeof useSettingStore>;
  readonly systemStore: ReturnType<typeof useSystemStore>;
  readonly uiStore: ReturnType<typeof useUiStore>;
  readonly videoListsStore: ReturnType<typeof useVideoListStore>;
  readonly favoriteBvids: string[];
  readonly currentItem: PlayItem | null;
  readonly songDisplayName: string;
  readonly fromVideoList: boolean;
  readonly mode: 'ov' | 'mv';
  readonly controlsSubtitle: string;
}

export type QueueGetterFns = { [K in keyof QueueGetters]: () => QueueGetters[K] };

export const queueGetters: ThisType<QueueContext> = {
  playbackStore: () => usePlaybackStore(),
  playlistsStore: () => usePlaylistStore(),
  settingStore: () => useSettingStore(),
  systemStore: () => useSystemStore(),
  uiStore: () => useUiStore(),
  videoListsStore: () => useVideoListStore(),
  /**
   * 当前这首歌收藏的 bvid 列表（视频列表里显示实心爱心）
   *
   * 直接从 `videoList` 读 `favorites` 字段：收藏状态的主进程那份是权威
   * （`videos.favorites`），而搜索返回的列表已经把它带上来了。
   * 以前是去歌单 store 里翻一份独立的收藏记录 —— 两份数据在「收藏后重排顺序」
   * 这类操作后必然对不上（界面上心是实的，位置却没动）。
   */
  favoriteBvids(): string[] {
    return this.videoList.filter((v) => v?.favorites).map((v) => v.bvid);
  },

  /**
   * 当前在播的那一条（歌 **或** 视频）
   *
   * 没叫 `currentSong`：队列里装的可能是视频条目，叫「song」会让人以为
   * 永远是歌 —— 这个误导正是 `toSongs()` 留下的。要用歌的字段
   * （`name` / `singer`）之前，先 `isVideoItem()` 判一下。
   */
  currentItem(): PlayItem | null {
    return this.songs[this.currentIndex] ?? null;
  },

  /**
   * 当前这条的**显示名**
   *
   * ⚠️ 不能用 `songName` 顶替：那是**缓存键**（`歌名-歌手`，直连条目更是
   * `bv:BV1xx`），贴到界面上就是一行内部标识。显示一律从这里取。
   */
  songDisplayName(): string {
    return titleOf(this.currentItem);
  },

  /** 当前播放源是不是 B 站视频列表（决定「歌手」列叫 UP 主、刷新叫重新同步） */
  fromVideoList(): boolean {
    /**
     * 两个条件都算「在播视频」：
     *  1. `activeId` 有值 —— 列表还在；
     *  2. 正在播的这条**本身就是视频** —— 列表刚被删掉时 activeId 会清空，
     *     但视频还在放。只看 `activeId` 会让控制栏当场从「下一个视频」变回「下一首」。
     */
    const current = this.currentItem;
    return !!this.videoListsStore.activeId || (!!current && isVideoItem(current));
  },

  /**
   * 当前工作区：`ov` = B 站视频列表、`mv` = 音乐歌单
   *
   * ## 它是**播放源的投影**，不是可写的状态
   *
   * 以前这里是读设置项 `ui.mode`，而那个值唯一的写入点是「点开哪个管理弹窗」——
   * 于是点一下「歌单管理」，界面就切成歌单的双列表（哪怕正在播视频）；
   * 反过来拖一个视频进来，界面也不跟着变。模式被按钮绑架，播放说了不算。
   *
   * 现在只按「在播什么」推：
   *  1. 在播视频（列表还在，或这条本身就是视频）→ `ov`；
   *  2. 队列里有内容 → `mv`（在播歌单）；
   *  3. 什么都没有（空库 / 刚装）→ `ov`，视频列表是主形态。
   *
   * 三处代价都算过：换歌单时 `songs` 是整体替换、中间不会变空；
   * 视频列表被删时 `fromVideoList` 靠「当前这条是视频」兜住；
   * 空歌单（0 首）会落到 `ov` —— 那种状态下两边都没东西可看，无所谓。
   */
  mode(): 'ov' | 'mv' {
    if (this.fromVideoList) return 'ov';
    if (this.songs.length === 0) return 'ov';
    return 'mv';
  },

  /** 播放控制栏副标题：歌曲名 - 歌手 · 专辑 */
  controlsSubtitle(): string {
    const item = this.currentItem;
    if (!item) return '';
    /**
     * 视频列表：标题已经在主标题上了，副标题只放 UP 主 + 列表名。
     * 再拼一次标题会出现「《标题》 - 标题」这种重复。
     */
    if (this.fromVideoList) {
      return [subtitleOf(item), this.listName].filter((x): x is string => !!x).join(' · ');
    }
    // 视频条目走到这里说明列表刚被删掉但视频还在放：只显示 UP 主，不编造歌手/专辑
    if (!isSongItem(item)) return subtitleOf(item);
    // 缺失的部分直接不出现，避免留下「- · 」这种空占位
    const head = [item.name, item.singer].filter((x): x is string => !!x).join(' - ');
    return [head, item.album].filter((x): x is string => !!x).join(' · ');
  }
};

/** ===== actions ===== */
export interface QueueActions {
  getSongName(index: number): string | null;
  getSongParts(index: number): { song: string; singer: string } | null;
  getSong(index: number): PlaylistSong | null;
  reloadCurrentPlaylistSongs(): Promise<void>;
  loadPlaylist(): Promise<void>;
  onPlayFromManager(index: number): Promise<void>;
  onPlaylistSwitch(id: string | null): Promise<void>;
  setActiveVideoList(id: string): Promise<void>;
  onBrowsePlay(index: number): Promise<void>;
  onVideoListPlay(id: string, index: number): Promise<void>;
  onToggleFavorite(bvid: string): Promise<void>;
  loopModeToIndex(mode: AppSetting['player.loopMode']): number;
  onListRefresh(): Promise<void>;
  refreshVideoList(): Promise<void>;
}

export type QueueContext = QueueState & QueueGetters & QueueActions;

export const queueActions: ThisType<QueueContext> = {
  /**
   * 第 index 条的**缓存键**（歌是 `歌名-歌手`，视频是 bvid）
   *
   * 名字里的 `Name` 是历史遗留。它只用于「这份候选列表属于哪一条」的标识，
   * **不能拿去搜索** —— 搜索要分开的歌名和歌手，见 `getSongParts()`。
   */
  getSongName(index: number): string | null {
    return keyOf(this.songs[index]) || null;
  },

  /** 第 index 条要搜索的词（视频本身就是视频，不需要搜索 → null） */
  getSongParts(index: number): { song: string; singer: string } | null {
    const item = this.songs[index];
    if (!item || isVideoItem(item)) return null;
    if (!item.name) return null;
    return { song: item.name, singer: item.singer ?? '' };
  },

  /**
   * 第 index 条的「歌」结构化信息
   *
   * 视频条目返回 null —— 它没有歌名 / 歌手 / 专辑这些概念。
   * 以前这里靠 `toSongs()` 把视频伪装成歌，才让调用方敢直接取 `.singer`。
   */
  getSong(index: number): PlaylistSong | null {
    const item = this.songs[index];
    return item && !isVideoItem(item) ? item : null;
  },

  /** 把当前播放源的曲目同步到本地播放列表（保留当前下标，越界则归零） */
  async reloadCurrentPlaylistSongs(): Promise<void> {
    const source = await this.playbackStore.loadPlaybackSource();
    if (!source) return;
    const keepIndex = this.currentIndex;
    this.songs = source.songs;
    this.listName = source.name;
    // 曲目变了，随机播放的下标表必须跟着重建：
    // 否则同步后曲目变少，随机列表里还留着越界下标，「下一首」会拿到 null 静默不动
    this.playbackStore.resetRandomList();
    // 预热槽位按下标算，曲目一变就全部作废
    this.playbackStore.clearAllWarm();
    if (this.songs.length === 0) return;
    if (keepIndex >= this.songs.length) {
      this.currentIndex = 0;
      await this.playbackStore.playCurrent();
    }
  },

  /**
   * 加载当前播放源的曲目
   *
   * 多歌单之后，曲目来源是「当前歌单」或「当前 B 站视频列表」，
   * 不再直接读旧版单歌单文件（那个文件已由主进程迁移进集合）。
   */
  async loadPlaylist(): Promise<void> {
    const source = await this.playbackStore.loadPlaybackSource();
    if (source && source.songs.length > 0) {
      this.listName = source.name;
      this.songs = source.songs;
      /** 回到上次播放的位置（下标由主进程在同步时重算，这里夹进范围） */
      this.currentIndex = Math.min(Math.max(0, source.lastIndex), this.songs.length - 1);
      // 兼顾「播放进度」：走这条兜底路径时（没有已缓存的视频可精确还原）
      // 也要把上次的秒数带上，否则换歌单/首启场景会丢掉进度
      const cfg = this.settingStore.setting;
      const resumeTime =
        cfg['player.resumeOnStart'] ? Number(cfg['player.resumeTime']) || 0 : 0;
      void this.playbackStore.playCurrent(resumeTime > 3 ? resumeTime : 0);
      return;
    }
    // 没有任何来源：**不弹管理器**，只提示一行「从哪开始」（点它才打开管理器）
    await this.uiStore.loadBrowseList();
    this.uiStore.notifyEmptyLibrary();
  },

  /** 从歌单管理弹窗里点某首歌播放
   *
   * 弹窗内部已负责把该歌单设为当前，这里只需加载曲目并起播。
   */
  async onPlayFromManager(index: number): Promise<void> {
    // 从「音乐歌单」里点歌 = 播放源切回音乐歌单（原来在播视频列表就要让位）
    if (this.videoListsStore.activeId) void this.setActiveVideoList('');
    const record = this.playlistsStore.current;
    if (!record || record.songs.length === 0) return;
    this.songs = [...record.songs];
    this.listName = record.name;
    this.currentIndex = Math.min(Math.max(0, index), this.songs.length - 1);
    this.playbackStore.seekAfterLoad = 0;
    this.playbackStore.seekAfterLoadFor = '';
    this.videoList = [];
    this.videoListKeyword = '';
    this.playbackStore.clearNowPlaying();
    this.currentKey = '';
    void this.playbackStore.playCurrent();
  },

  /** 从歌单面板切换歌单 */
  async onPlaylistSwitch(id: string | null): Promise<void> {
    /**
     * 切到音乐歌单 = 播放源从「视频列表」切回来
     *
     * 不清的话 `fromVideoList` 会一直是真：界面按视频列表的文案渲染，
     * 而 songs 已经是音乐歌单的 —— 两边对不上。
     */
    if (this.videoListsStore.activeId) void this.setActiveVideoList('');
    if (!id) {
      // 歌单被删光了
      this.songs = [];
      this.videoList = [];
      this.videoListKeyword = '';
      this.listName = '';
      this.currentIndex = 0;
      this.currentVideoIndex = 0;
      this.currentKey = '';
      this.playbackStore.clearNowPlaying();
      this.uiStore.playlistManagerVisible = true;
      return;
    }
    const record = this.playlistsStore.current;
    if (!record) return;
    // 防御：弹窗有时只想「刷新」却发成了 switch。currentId 没变就说明不是真的切换，
    // 只重载曲目、别把正在听的歌从头重播
    if (id !== this.playlistsStore.currentId) {
      await this.reloadCurrentPlaylistSongs();
      return;
    }
  
    // 换歌单时把进度重置，避免把上一个歌单的秒数带到新歌单
    this.songs = [...record.songs];
    this.listName = record.name;
    this.currentIndex = Math.min(Math.max(0, record.lastIndex), Math.max(0, record.songs.length - 1));
    this.videoList = [];
    this.videoListKeyword = '';
    this.currentVideoIndex = 0;
    this.playbackStore.clearNowPlaying();
    this.currentKey = '';
    this.playbackStore.currentTime = 0;
    this.playbackStore.seekAfterLoad = 0;
    this.playbackStore.seekAfterLoadFor = '';
    await this.settingStore.update({
      'player.resumeTime': 0,
    });
  
    if (this.songs.length === 0) {
      ElMessage.warning(`《${record.name}》还没有曲目，可以先「同步」一下`);
      return;
    }
    ElMessage.success(`已切换到《${record.name}》（${this.songs.length} 首）`);
    void this.playbackStore.playCurrent();
  },

  /**
   * 切换「当前在播的视频列表」（`''` = 切回音乐歌单）
   *
   * 两件事必须一起做：store 里的响应式状态（界面文案、列表高亮靠它）+ 落盘的设置
   * （重启后要知道回哪个来源续播）。**不能只改 store** —— 那样关掉程序就丢。
   */
  async setActiveVideoList(id: string): Promise<void> {
    if (this.videoListsStore.activeId === id) return;
    this.videoListsStore.setActive(id);
    /**
     * 托盘菜单那一项（「歌单管理 / 视频管理」）的文案跟着工作区走，
     * 而工作区现在是 `activeId` 的投影 —— 所以这里推一次，别等别的动作顺手推。
     */
    this.systemStore.syncTrayState();
    try {
      await this.settingStore.update({ 'player.activeVideoListId': id });
    } catch (err) {
      console.warn('[videolist] 记录当前视频列表失败', err);
    }
  },

  /**
   * 列表面板里点了某一条 = 切换播放源并起播
   *
   * `browseSongs` 可以是「不是正在播的那一份」，所以不能直接 `playAt(index)`
   * （那个只改播放队列的下标）。这里按模式各自走一次「换源 + 起播」。
   */
  async onBrowsePlay(index: number): Promise<void> {
    if (this.mode === 'ov') {
      if (!this.uiStore.browseVideoListId) {
        this.uiStore.notifyEmptyLibrary();
        return;
      }
      await this.onVideoListPlay(this.uiStore.browseVideoListId, index);
      return;
    }
    await this.onPlayFromManager(index);
  },

  /**
   * 从视频列表里点某条播放
   *
   * 这是「视频列表 → 播放引擎」的唯一入口：
   * 条目（`VideoListItem`，本来就带 `bvid`）直接塞进 `songs`，
   * 之后切歌 / 下一个 / 续播全部沿用既有链路 —— 引擎按 `isVideoItem()`
   * 分派，视频这条路**不搜索**，直接按 bvid 解析地址。
   */
  async onVideoListPlay(id: string, index: number): Promise<void> {
    const record = this.videoListsStore.find(id);
    if (!record) return;
    await this.setActiveVideoList(id);
  
    const songs = await this.videoListsStore.items(id);
    if (songs.length === 0) {
      ElMessage.warning(`《${record.name}》还没有条目`);
      return;
    }
  
    /**
     * 从这里起它就是「正在看的列表」：面板内容与播放队列保持同一份，
     * 否则点开列表弹窗会停在切换前的那个列表上（看着像点错了）。
     */
    this.uiStore.browseVideoListId = id;
    this.uiStore.ovSongs = songs;
  
    this.songs = songs;
    this.listName = record.name;
    this.currentIndex = Math.min(Math.max(0, index), songs.length - 1);
    this.videoList = [];
    this.videoListKeyword = '';
    this.currentVideoIndex = 0;
    this.playbackStore.clearNowPlaying();
    this.currentKey = '';
    this.playbackStore.currentTime = 0;
    this.playbackStore.seekAfterLoad = 0;
    this.playbackStore.seekAfterLoadFor = '';
    this.playbackStore.resetRandomList();
    this.playbackStore.clearAllWarm();
    // 换列表等于换一首「新歌」，上一份进度（秒数）不能带过来
    await this.settingStore.update({ 'player.resumeTime': 0 });
    ElMessage.success(`正在播放《${record.name}》第 ${this.currentIndex + 1} 个视频`);
    await this.playbackStore.playCurrent();
  },

  /**
   * 收藏 / 取消收藏视频列表里的某一项
   *
   * 顺序完全交给主进程：收藏会把该条挪到第一位（`videos.ord`），
   * 取消收藏**位置不动**。所以这里不自己重排，只按返回值刷新
   * 「哪些是收藏」+ 把变动的那一条挪到本地列表最前面 ——
   * 如果自己重排，就会和库里的 ord 产生两套顺序。
   */
  async onToggleFavorite(bvid: string): Promise<void> {
    /**
     * OV 模式：收藏挂在**条目**上（`videolist_items.favorites`），
     * 而且收藏 = 置顶（事务里改 ord）。所以只需调一次主进程再重排界面，
     * 不能走下面那套「这首歌选哪个 bvid」的逻辑 —— 那是 MV 的语义。
     */
    if (this.mode === 'ov') {
      const listId = this.uiStore.browseVideoListId;
      if (!listId || !bvid) return;
      const current = this.uiStore.ovSongs.find((song) => song.bvid === bvid);
      try {
        await this.videoListsStore.setFavorite(listId, bvid, !current?.favorites);
        await this.uiStore.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error(`收藏操作失败：${this.uiStore.errMsg(err)}`);
      }
      return;
    }
    if (!bvid || !this.currentKey) return;
    const songName = this.currentKey;
    const isFav = this.favoriteBvids.includes(bvid);
    try {
      const { favorites } = await this.uiStore.withNet(() => electronApi.setFavorite(songName, bvid, !isFav));
      /**
       * 用返回值刷新收藏标记（而不是本地取反）：主进程可能因为
       * 「这条已经不在候选列表里」而新建一行，本地取反就与它不一致了。
       */
      const favSet = new Set(favorites);
      this.videoList = this.videoList.map((v) => ({
        ...v,
        favorites: favSet.has(v.bvid),
      }));
  
      if (!isFav) {
        /**
         * 收藏：把该条挪到 videoList 第一位
         *
         * 为什么不等下次搜索：用户点了爱心，界面**当场**就该看到它跳上去，
         * 否则会怀疑没生效。主进程那边同步也做了同样的挪动，两边一致。
         */
        const idx = this.videoList.findIndex((v) => v.bvid === bvid);
        if (idx > 0) {
          const [moved] = this.videoList.splice(idx, 1);
          this.videoList.unshift(moved);
        }
      }
      // 下标跟着列表走（挪动 / 顺序变化后必须重算，否则「正在播放」高亮会错位）
      this.currentVideoIndex = this.videoList.findIndex((v) => v.bvid === this.playbackStore.currentBvid);
    } catch (err) {
      ElMessage.error(`收藏操作失败：${this.uiStore.errMsg(err)}`);
    }
  },

  /** 循环模式：字符串枚举 -> 数字下标（供 VideoControls 使用） */
  loopModeToIndex(mode: AppSetting['player.loopMode']): number {
    const idx = PLAY_LOOP_MODES.indexOf(mode);
    return idx >= 0 ? idx : this.MODE.read;
  },

  /**
   * 左上角刷新（两个列表面板共用一个按钮）
   *
   * 按**面板里装的是什么**分三种，别按面板名硬套 —— 两个工作区的 `videoList`
   * 装的东西不同（OV 是一整个合集，MV 是这首歌的备选），刷新动作也就不一样：
   *  - 歌单（只有 MV）→ 重新同步歌单；
   *  - OV 的视频列表 → 重新拉这个合集 / 收藏夹；
   *  - MV 的视频列表 → 重新搜索这首歌（收藏仍在最前面）。
   */
  async onListRefresh(): Promise<void> {
    /** ① 歌单：重新同步当前歌单（OV 里没有歌单，这个分支只在 MV 走到） */
    if (this.uiStore.listType === 'songList') {
      const id = this.playlistsStore.currentId;
      if (!id) return;
      try {
        const results = await this.playlistsStore.sync([id]);
        await this.systemStore.reportSyncResults(results, '同步');
        await this.reloadCurrentPlaylistSongs();
      } catch (err) {
        ElMessage.error('同步失败：' + this.uiStore.errMsg(err));
      }
      return;
    }
    /**
     * ② OV 的视频列表 = 当前这一列：**重新拉列表**（不是重新搜索）
     *
     * 语义差别很大：这里一条请求打的是 B 站的收藏夹/合集接口，
     * 回来的是「这个列表现在有哪些视频」。搜索结果那套过滤 / 打分
     * 对列表条目完全不适用（见方案 4.4）。
     *
     * 刷的是**正在看的那份**（`browseVideoListId`）而不是「正在播的」——
     * 切模式后两者可能不是同一个，刷错列表会让用户以为同步没生效。
     */
    if (this.mode === 'ov') {
      const videoListId = this.uiStore.browseVideoListId;
      if (!videoListId) return;
      const record = this.videoListsStore.find(videoListId);
      if (record?.kind === 'local') {
        ElMessage.info('本地列表没有远端来源，不需要同步');
        return;
      }
      try {
        const r = await this.videoListsStore.sync(videoListId);
        if (!r.ok) {
          ElMessage.warning(`${r.name || '列表'}：${r.error ?? '同步失败'}`);
        } else {
          ElMessage.success(
            `${r.name}：+${r.added ?? 0}/-${r.removed ?? 0}` +
              (r.skipped ? `（跳过 ${r.skipped} 个）` : ''),
          );
        }
        // 条目可能变了（还可能因置顶重排）：重载浏览列表并按 bvid 重定位播放位置
        await this.uiStore.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('同步失败：' + this.uiStore.errMsg(err));
      }
      return;
    }
    /** ③ MV 的视频列表 = 这首歌的备选：重新搜索 */
    await this.refreshVideoList();
  },

  /**
   * 重新搜索这首歌的候选视频
   *
   * `skipCache` 走主进程真实重搜（同时会与旧条目合并，保住已解析的播放地址）；
   * 不重播当前视频，只是把列表换了 —— 用户要的是「刷新列表」。
   */
  async refreshVideoList(): Promise<void> {
    const parts = this.getSongParts(this.currentIndex);
    /** 缓存键（`歌名-歌手`）—— 只用于给 `videoListKeyword` 打标识，不参与搜索 */
    const songName = this.currentKey;
    if (!parts || !songName) return;
    try {
      const res = await this.uiStore.withNet(() => electronApi.searchSong(parts.song, parts.singer, true));
      const videos = (res.data as { result?: BiliVideo[] } | null)?.result ?? [];
      this.videoList = videos;
      this.videoListKeyword = songName;
      // 当前播放的视频可能还在列表里（下标要跟着更新），也可能被搜没了
      this.currentVideoIndex = this.videoList.findIndex((v) => v.bvid === this.playbackStore.currentBvid);
      ElMessage.success(`已重新搜索《${songName}》，找到 ${this.videoList.length} 个视频`);
    } catch (err) {
      ElMessage.error(`重新搜索失败：${this.uiStore.errMsg(err)}`);
    }
  }
};

export const useQueueStore = defineStore<
  'queue',
  QueueState,
  QueueGetterFns,
  QueueActions
>('queue', {
  state: queueState,
  getters: queueGetters as never,
  actions: queueActions as QueueActions,
});

/** 组件侧需要标注 store 类型时用它 */
export type QueueStore = ReturnType<typeof useQueueStore>;
