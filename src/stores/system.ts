/**
 * System store —— 系统集成：SMTC、任务栏进度、托盘状态同步、播放位置落盘、定时同步。
 *
 * 状态与动作都只属于这一个业务域；跨域访问通过 getters 里那几个 `xxxStore`
 * 指针拿到别的 store 实例（惰性求值，所以模块之间可以互相 import 而不成环）。
 */
import { defineStore } from 'pinia';
import type { SyncResult } from '@common/types/playlist';
import type { AppData } from '../types/app';
import { ElMessage } from 'element-plus';
import electronApi from '../api/electron';
import type { AppSetting } from '@common/types/app_setting';
import { PLAY_LOOP_MODES } from '@common/constants';
import { titleOf, subtitleOf, isSongItem } from '../types/playItem';

import { usePlaybackStore } from './playback';
import { usePlaylistStore } from './playlists';
import { useQueueStore } from './queue';
import { useSessionStore } from './session';
import { useSettingStore } from './setting';
import { useSleepStore } from './sleep';
import { useVideoListStore } from './videoLists';

/** ===== state ===== */
export type SystemState = Pick<
  AppData,
  'removeTrayPlayControl' | 'removeTrayPrev' | 'removeTrayNext' | 'removeTrayToggleMode' | 'removeTrayShowPlaylist' | 'removeTrayShowSleepTimer' | 'removeTrayShowLogoutConfirm' | 'removeTrayUnlock' | 'removeTraySeek' | 'removeTrayVolume' | 'removeTrayToggleMute' | 'removeTrayMenuListener' | '_lastPersistAt' | '_lastMediaPosAt' | '_lastTaskbarKey' | '_lastTraySyncAt' | '_syncTimer' | '_syncKey'
>;

export const systemState = (): SystemState => ({
  removeTrayPlayControl: null,

  removeTrayPrev: null,

  removeTrayNext: null,

  removeTrayToggleMode: null,

  removeTrayShowPlaylist: null,

  removeTrayShowSleepTimer: null,

  removeTrayShowLogoutConfirm: null,

  /** 左键点托盘图标 -> 解锁 */
  removeTrayUnlock: null as null | (() => void),

  removeTraySeek: null,

  removeTrayVolume: null,

  removeTrayToggleMute: null,

  removeTrayMenuListener: null,

  /** 上次写入播放进度的时间戳（节流用） */
  _lastPersistAt: 0,

  /** 上次同步 SMTC 进度的时间戳（节流用） */
  _lastMediaPosAt: 0,

  /** 上次发给任务栏的进度指纹（百分比 + 暂停态），避免每次 timeupdate 都发 IPC */
  _lastTaskbarKey: '',

  /** 上次给托盘菜单推状态的时间（菜单开着时按 300ms 节流） */
  _lastTraySyncAt: 0,

  /** 定时自动同步的定时器 */
  _syncTimer: null as ReturnType<typeof setInterval> | null,

  /** 定时器对应的「策略指纹」，用来避免被无关的配置广播反复重建 */
  _syncKey: '',
});

/** ===== getters ===== */
export interface SystemGetters {
  readonly playbackStore: ReturnType<typeof usePlaybackStore>;
  readonly playlistsStore: ReturnType<typeof usePlaylistStore>;
  readonly queueStore: ReturnType<typeof useQueueStore>;
  readonly sessionStore: ReturnType<typeof useSessionStore>;
  readonly settingStore: ReturnType<typeof useSettingStore>;
  readonly sleepStore: ReturnType<typeof useSleepStore>;
  readonly videoListsStore: ReturnType<typeof useVideoListStore>;

}

export type SystemGetterFns = { [K in keyof SystemGetters]: () => SystemGetters[K] };

export const systemGetters: ThisType<SystemContext> = {
  playbackStore: () => usePlaybackStore(),
  playlistsStore: () => usePlaylistStore(),
  queueStore: () => useQueueStore(),
  sessionStore: () => useSessionStore(),
  settingStore: () => useSettingStore(),
  sleepStore: () => useSleepStore(),
  videoListsStore: () => useVideoListStore(),

};

/** ===== actions ===== */
export interface SystemActions {
  runStartupSync(): Promise<void>;
  reportSyncResults(results: SyncResult[], label: string, silentWhenUnchanged?: boolean): Promise<void>;
  setupSyncTimer(): void;
  clearSyncTimer(): void;
  runIntervalSync(): Promise<void>;
  updateMediaSession(): void;
  updateMediaPosition(): void;
  setupMediaSessionActions(): void;
  persistPlaybackState(): Promise<void>;
  recordPlayPosition(): void;
  persistPlaybackStateThrottled(): void;
  updateMediaPositionThrottled(): void;
  updateTaskbarProgress(): void;
  syncTrayState(): void;
}

export type SystemContext = SystemState & SystemGetters & SystemActions;

export const systemActions: ThisType<SystemContext> = {
  /**
   * 启动时按各自策略自动同步（歌单 + 视频列表）
   *
   * 两边**串行**跑：同时开两串请求只会更快撞某站风控，而启动同步本来就是
   * 后台任务（`void runStartupSync()`），慢一点不影响续播。
   * 失败只提示，不打断启动。
   */
  async runStartupSync(): Promise<void> {
    try {
      const playlistResults = await this.playlistsStore.syncOnStartupIfNeeded();
      await this.reportSyncResults(playlistResults, '自动同步');
    } catch (err) {
      console.warn('[sync] 启动同步（歌单）失败', err);
    }
    try {
      const videoResults = await this.videoListsStore.syncOnStartupIfNeeded();
      await this.reportSyncResults(videoResults, '自动同步');
    } catch (err) {
      console.warn('[sync] 启动同步（视频列表）失败', err);
    }
  },

  /**
   * 统一处理同步结果：提示 + 曲目变化后重载当前播放列表
   *
   * 启动同步与定时同步共用，避免两处逻辑漂移。
   */
  async reportSyncResults(
    results: SyncResult[],
    label: string,
    silentWhenUnchanged = false,
  ): Promise<void> {
    if (!results || results.length === 0) return;
    const failed = results.filter((r) => !r.ok);
    const okList = results.filter((r) => r.ok);
    const changed = okList.filter((r) => (r.added ?? 0) > 0 || (r.removed ?? 0) > 0);
  
    if (okList.length > 0) {
      if (changed.length === 0 && silentWhenUnchanged) {
        // 定时同步无变化时不打扰用户，只留控制台记录
        console.log(`[sync] ${label}：${okList.length} 个歌单无变化`);
      } else {
        const detail = changed
          .map((r) => `${r.name} +${r.added ?? 0}/-${r.removed ?? 0}`)
          .join('，');
        ElMessage.success(
          `${label}完成 ${okList.length} 个` + (detail ? `（${detail}）` : '，无变化'),
        );
      }
    }
    for (const r of failed) {
      ElMessage.warning(`${r.name} ${label}失败：${r.error ?? '未知错误'}`);
    }
    // 曲目列表变了：重载当前播放列表，保证播放的不是过期数据
    if (changed.length > 0 && this.queueStore.songs.length > 0) {
      await this.queueStore.reloadCurrentPlaylistSongs();
    }
  },

  /**
   * 启动 / 重设「定时自动同步」定时器
   *
   * 策略完全来自每个歌单自己的 sync 配置（设置界面已不再提供全局开关）：
   *  - 只要存在「定时同步」的歌单，就按它们中最小的间隔做心跳
   *  - 每次心跳只同步真正到点的歌单，所以各歌单周期可以不同
   *  - 没有定时歌单时不装定时器，避免空转
   */
  setupSyncTimer(): void {
    this.clearSyncTimer();
    /**
     * 歌单和视频列表共用**一个**心跳
     *
     * 心跳间隔取两边「最小的那个周期」，每次心跳只同步真正到点的那边 ——
     * 各列表的周期可以不同，但只需要一个定时器，不会因为多一类列表就多一个 timer。
     */
    const intervals = [
      this.playlistsStore.hasIntervalSync ? this.playlistsStore.minSyncInterval : 0,
      this.videoListsStore.hasIntervalSync ? this.videoListsStore.minSyncInterval : 0,
    ].filter((ms) => ms > 0);
    if (intervals.length === 0) return;
    // 兜底 5 分钟，避免配置成极小值导致疯狂请求
    const interval = Math.max(5 * 60 * 1000, Math.min(...intervals));
    this._syncTimer = setInterval(() => {
      void this.runIntervalSync();
    }, interval);
    console.log(`[sync] 定时自动同步已启用，心跳间隔 ${Math.round(interval / 60000)} 分钟`);
  },

  clearSyncTimer(): void {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  },

  /** 定时心跳：只同步到点的歌单和视频列表 */
  async runIntervalSync(): Promise<void> {
    // 已有同步在跑就跳过这一轮，避免请求叠加
    if (this.playlistsStore.isSyncing) return;
    if (this.videoListsStore.syncing.length > 0) return;

    const duePlaylistIds = this.playlistsStore.getDueSyncIds();
    if (duePlaylistIds.length > 0) {
      try {
        const results = await this.playlistsStore.sync(duePlaylistIds);
        // 无变化时静默，避免每次心跳都弹提示
        await this.reportSyncResults(results, '定时同步', true);
      } catch (err) {
        console.warn('[sync] 定时同步（歌单）失败', err);
      }
    }

    const dueVideoIds = this.videoListsStore.getDueSyncIds();
    if (dueVideoIds.length > 0) {
      try {
        const results = await this.videoListsStore.syncMany(dueVideoIds);
        await this.reportSyncResults(results, '定时同步', true);
      } catch (err) {
        console.warn('[sync] 定时同步（视频列表）失败', err);
      }
    }
  },

  /**
   * 更新 Windows 系统媒体控件（SMTC）
   *
   * 渲染进程用的是标准 Media Session API，Electron 在 Windows 上会把它桥接到
   * 系统的 SMTC：系统音量弹窗 / 锁屏界面 / 键盘媒体键都会用到这里的信息。
   * artwork 就是「歌曲图片 / 视频图片」在系统那边的呈现。
   */
  updateMediaSession(): void {
    const ms = navigator.mediaSession;
    if (!ms) return;
    /**
     * 名字统一走 `titleOf` / `subtitleOf`：歌是「歌名 / 歌手」，视频是「标题 / UP 主」
     *
     * ⚠️ 兜底**不能**用 `currentKey` —— 那是缓存键（歌 `tx_7062415`、视频 `BV1xx…`），
     * 它会被 Windows 音量弹窗 / 锁屏界面显示出来，用户看到一串 ID。
     * 以前这里只认 `getSong()`（只对歌有效），播视频时就走到了那个兜底。
     */
    const item = this.queueStore.currentItem;
    const title = titleOf(item) || '某站音乐视频';
    /**
     * 变量按项目惯例叫 `singer`
     *
     *（MediaMetadata 那个字段叫 `artist`，是**它的** API 名字 ——
     * 下面构造时才写成 `artist: singer`，不让它污染我们的变量名）
     */
    const singer = subtitleOf(item) || this.sessionStore.userName || '未知歌手';
    /** 视频没有专辑字段，用「来自哪个列表」顶上 —— 系统那边正好占一行 */
    const album = ((item && isSongItem(item) ? item.album : this.queueStore.listName) || '');
  
    // 封面：平台专辑图 -> 视频缩略图，两个尺寸都给，系统会挑合适的
    const cover = this.playbackStore.currentCover();
    const artwork = cover
      ? [
          { src: cover, sizes: '256x256', type: 'image/jpeg' },
          { src: cover, sizes: '512x512', type: 'image/jpeg' },
        ]
      : [];
  
    try {
      ms.metadata = new MediaMetadata({
        title,
        /** `artist` 是 MediaMetadata 的字段名 —— 值取我们的 `singer` */
        artist: singer,
        album,
        artwork,
      });
      // 同步播放/暂停状态，否则系统控件按钮会显示错
      ms.playbackState = this.playbackStore.paused ? 'paused' : 'playing';
    } catch (err) {
      console.warn('[smtc] 更新媒体信息失败', err);
    }
  },

  /** 同步播放进度到系统控件（有则显示进度条） */
  updateMediaPosition(): void {
    const ms = navigator.mediaSession;
    if (!ms || typeof ms.setPositionState !== 'function') return;
    if (!Number.isFinite(this.playbackStore.duration) || this.playbackStore.duration <= 0) return;
    try {
      ms.setPositionState({
        duration: this.playbackStore.duration,
        position: Math.min(Math.max(0, this.playbackStore.currentTime), this.playbackStore.duration),
        playbackRate: 1,
      });
    } catch {
      /* 进度参数不合法时忽略（例如刚切歌 duration 还是 0） */
    }
  },

  /** 注册系统媒体键的处理（播放/暂停/上下曲） */
  setupMediaSessionActions(): void {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => { if (this.playbackStore.paused) this.playbackStore.playControl(); }],
      ['pause', () => { if (!this.playbackStore.paused) this.playbackStore.playControl(); }],
      ['nexttrack', () => this.playbackStore.next()],
      ['previoustrack', () => this.playbackStore.prev()],
      ['seekbackward', () => this.playbackStore.changeTime(Math.max(0, this.playbackStore.currentTime - 10))],
      ['seekforward', () => this.playbackStore.changeTime(Math.min(this.playbackStore.duration || 0, this.playbackStore.currentTime + 10))],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* 个别 action 不支持时跳过 */
      }
    }
  },

  /**
   * 记录当前播放信息（歌单 / 歌曲下标 / 视频 / 进度）
   *
   * 触发点：切歌、切视频、视频加载完成、时间更新（节流）。
   */
  async persistPlaybackState(): Promise<void> {
    const hasVideoList = !!this.videoListsStore.activeId;
    if (!hasVideoList && !this.playlistsStore.current) return;
    const patch: Partial<AppSetting> = {
      'player.resumeTime': Math.floor(this.playbackStore.currentTime || 0),
    };
    void this.settingStore.update(patch);
    // 当前播放源播到第几首（切歌单 / 切列表时用于回到各自的位置）
    this.recordPlayPosition();
  },

  /**
   * 记录「当前播放源播到第几条」
   *
   * 两个来源各记各的表：音乐歌单 → `playlists.last_index`，
   * 视频列表 → `videolists.last_index`（那张表在同步时按 bvid 重定位）。
   * 写错表不会报错，只会表现成「重启后位置回到第一条」，所以集中在这里一处。
   */
  recordPlayPosition(): void {
    const videoListId = this.videoListsStore.activeId;
    if (videoListId) {
      void this.videoListsStore.setIndex(videoListId, this.queueStore.currentIndex);
      return;
    }
    /**
     * 视频列表被删了但视频还在播：**不能**写 `playlists.last_index` ——
     * 那是音乐歌单的下标，写进去只会让下次从歌单续播时跳到一个莫名其妙的第 N 首。
     */
    if (this.queueStore.songs[this.queueStore.currentIndex]?.bvid) return;
    void this.playlistsStore.setLastIndex(this.queueStore.currentIndex);
  },

  /** 节流记录进度，避免 timeupdate 每秒写多次 */
  persistPlaybackStateThrottled: function (): void {
    const now = Date.now();
    if (now - this._lastPersistAt < 5000) return;
    this._lastPersistAt = now;
    void this.persistPlaybackState();
  },

  /** 节流同步系统媒体控件的进度（每秒调用太频繁） */
  updateMediaPositionThrottled: function (): void {
    const now = Date.now();
    if (now - this._lastMediaPosAt < 3000) return;
    this._lastMediaPosAt = now;
    this.updateMediaPosition();
    this.updateTaskbarProgress();
  },

  /**
   * 任务栏进度条（Windows 任务栏图标上的那条）
   *
   * 只在「百分比或暂停状态真的变了」时才发 IPC：`timeupdate` 一秒好几次，
   * 每次都发会把主进程喊爆。
   */
  updateTaskbarProgress(): void {
    const total = this.playbackStore.duration || 0;
    const progress = total > 0 ? (this.playbackStore.currentTime || 0) / total : -1;
    // 设置里关掉、或者没有在播 -> 清掉进度条
    const enabled = this.settingStore.setting['common.taskbarProgress'];
    const value = !enabled || (!this.playbackStore.videoUrl && !this.playbackStore.dashSource) ? -1 : progress;
    const key = value < 0 ? 'none' : `${Math.round(value * 200)}|${this.playbackStore.paused}`;
    if (key === this._lastTaskbarKey) return;
    this._lastTaskbarKey = key;
    void electronApi.setProgress(value, this.playbackStore.paused);
  },

  syncTrayState(): void {
    /**
     * 托盘显示「名字 - 副标题」：歌是「歌名 - 歌手」，视频是「标题 - UP 主」
     *
     * ⚠️ 不能只认歌。以前这里 `getSong(currentIndex)`（只对 `PlaylistSong` 有效），
     * 视频拿不到就兜底成 `currentKey` —— 那是缓存键，视频的形态是 `BV1xx…`，
     * 于是播视频时托盘顶上是一串 bvid。取值统一走 `titleOf` / `subtitleOf`，
     * 两种条目各自取对字段，不再有「一种形状才算数」的假设。
     */
    const title = [titleOf(this.queueStore.currentItem), subtitleOf(this.queueStore.currentItem)]
      .filter(Boolean)
      .join(' - ');
    electronApi.trayUpdateState({
      paused: this.playbackStore.paused,
      // 托盘契约用字符串枚举的循环模式（与持久化的 player.loopMode 一致）
      loopMode: PLAY_LOOP_MODES[this.queueStore.currentMode] || 'listLoop',
      title,
      // 托盘菜单是个迷你控制台：进度条与音量跟着实时走
      position: this.playbackStore.currentTime || 0,
      duration: this.playbackStore.duration || 0,
      volume: this.playbackStore.currentVolume,
      muted: this.playbackStore.isMuted,
      // 登录态一起带上，防主进程那份和这边不一致
      isLoggedIn: this.sessionStore.isLoggedIn,
      /**
       * 工作区（在播视频列表 / 在播歌单）一起带上
       *
       * 托盘菜单那一项按它显示「歌单管理」还是「视频管理」。主进程算不出来 ——
       * 它只看得到 `player.activeVideoListId`，而「当前这条本身是不是视频」
       * （列表被删后视频还在放的那种情况）只有渲染层知道。
       */
      mode: this.queueStore.mode,
      /**
       * 定时倒计时（托盘菜单里那一项要显示）
       *
       * 用 `ceil` 是为了和界面上的 `formatRemain` 对齐：剩 0.4 秒时两边都显示 `00:01`，
       * 不会出现「弹窗还有 1 秒、托盘已经 00:00」。
       */
      sleepActive: this.sleepStore.sleepState.active,
      sleepRemainSec: Math.ceil(Math.max(0, this.sleepStore.sleepState.remainMs) / 1000),
    });
  }
};

export const useSystemStore = defineStore<
  'system',
  SystemState,
  SystemGetterFns,
  SystemActions
>('system', {
  state: systemState,
  getters: systemGetters as never,
  actions: systemActions as SystemActions,
});

/** 组件侧需要标注 store 类型时用它 */
export type SystemStore = ReturnType<typeof useSystemStore>;
