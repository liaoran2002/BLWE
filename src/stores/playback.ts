/**
 * Playback store —— 播放引擎与流：解析结果挂到 `<video>`、dash/durl 两条路、缓冲与卡顿恢复链、下一首预热。
 *
 * 状态与动作都只属于这一个业务域；跨域访问通过 getters 里那几个 `xxxStore`
 * 指针拿到别的 store 实例（惰性求值，所以模块之间可以互相 import 而不成环）。
 */
import { defineStore } from 'pinia';
import { isVideoItem, keyOf, titleOf } from '../types/playItem';
import type { PlayItem } from '../types/playItem';
import type { PlaylistSong as StructuredSong } from '@common/types/playlist';
import type { VideoElement, VideoControlAction, BiliVideo, AppData } from '../types/app';
import { ElMessage, ElNotification, ElMessageBox } from 'element-plus';
import defaultSetting from '@common/defaultSetting';
import electronApi from '../api/electron';
import type { QualityOptionsPayload, DashStreamsPayload } from '@common/types/ipc';
import { markRaw, nextTick } from 'vue';
import { VIDEO_QUALITY_OPTIONS, findQualityOption, PLAY_LOOP_MODES } from '@common/constants';
import { qualityLabelOf } from '../utils/videoQuality';
import { START_BUFFER_S, LEAD_S, OV_MAX_AUTO_SKIP, STALL_MS, MAX_QUALITY_DROPS, PREFETCH_AHEAD_S, WARM_MAX_TRIES, WARM_RETRY_DELAY_MS } from './constants';
import { PlaybackEngine } from '../utils/playbackEngine';
import type { LoadOptions, ResolvedStream } from '../utils/playbackEngine';
import { normalizeImageUrl } from '../utils/image';
import { DashSession } from '../utils/dashPlayer';

import { usePlaylistStore } from './playlists';
import { useQueueStore } from './queue';
import { useSessionStore } from './session';
import { useSettingStore } from './setting';
import { useSleepStore } from './sleep';
import { useSystemStore } from './system';
import { useUiStore } from './ui';
import { useVideoListStore } from './videoLists';
import { useWindowStore } from './window';

/** ===== state ===== */
export interface PlaybackState extends Pick<
  AppData,
  'engine' | 'videoPic' | 'videoQuality' | 'videoQualityDesc' | 'videoQualityPixels' | 'audioQuality' | 'audioQualityDesc' | 'qualityOptions' | 'selectedQn' | 'selectedAudioId' | 'videoUrl' | 'dashSource' | 'currentBvid' | 'currentVolume' | 'currentTime' | 'duration' | 'isMuted' | 'paused' | 'lastNonZeroVolume' | '_videoErrorCount' | 'currentBvidIsLocal' | '_missingPrompted' | 'seekAfterLoad' | 'seekAfterLoadFor' | 'buffering' | 'bufferPercent' | 'bufferSeconds' | '_bufferTimer' | '_endWatchTimer' | '_bufferOverlayTimer' | '_warm' | '_warmed' | '_warming' | '_warmTries' | '_warmFailed' | '_warmRetryAt' | '_warmEl' | '_warmSession' | '_warmTimer' | '_lastProgressAt' | '_progressPos' | '_endStallHandled' | '_stallSince' | '_stallRecoveries' | '_stallGivenUp' | '_stallNoticeOpen' | '_stallUrlIndex' | '_stallQualityDrops'
> {
  /** `<video>` 元素（markRaw 持有，DOM 节点绝不能进响应式系统） */
  _videoHolder: { el: VideoElement | null };
  /** bootstrap 里建立的 watch 的退订函数 */
  _stopWatchers: (() => void)[];
}

export const playbackState = (): PlaybackState => ({
  _videoHolder: markRaw({ el: null }),

  _stopWatchers: [],

  /** 播放引擎（markRaw 持有，避免被 Vue 代理 —— 它自带令牌与 MSE 会话） */
  engine: null as PlaybackEngine | null,

  /**
   * 正在播的那个视频的封面（主进程回传）
   *
   * 不能只靠 `videoList` 里查：`selectedBvid` 可能不在本次搜索结果里，
   * 而且缓存里的条目可能缺 `pic`，那时封面就空了。
   */
  videoPic: '',

  /** 正在播的视频清晰度短标签（playurl 响应报的档位），例如 1080P */
  videoQuality: '',

  /** 清晰度完整描述（playurl 的 new_description），例如 1080P 高清 */
  videoQualityDesc: '',

  /** `<video>` 实际解码出的分辨率，仅用于悬浮提示交叉印证 */
  videoQualityPixels: '',

  /** 正在播的音频流音质（playurl 响应报的档位），例如 192K */
  audioQuality: '',

  /** 音质完整描述，例如 192K 高音质 */
  audioQualityDesc: '',

  /** 这个视频当前可选的清晰度 / 音质（播放器上的切换菜单用） */
  qualityOptions: null as QualityOptionsPayload | null,

  /** 本次会话手动选过的清晰度（null 表示用设置里的默认值） */
  selectedQn: null as number | null,

  /** 本次会话手动选过的音质 */
  selectedAudioId: null as number | null,

  videoUrl: '',

  /** dash 双轨信息（非空时用 MSE 播放，取不到高清时才退回 durl） */
  dashSource: null as DashStreamsPayload | null,

  /** 正在播的视频 bvid（`currentVideoIndex` 可能是 -1，所以单独记一个） */
  currentBvid: '',

  currentVolume: 70,

  currentTime: 0,

  duration: 0,

  isMuted: false,

  paused: false,

  lastNonZeroVolume: 0,

  /** 同一个视频的连续失败次数，达到上限就跳过该曲，避免无限重试 */
  _videoErrorCount: 0,

  /**
   * 正在播的这条是不是**本地文件**
   *
   * 由 `api:resolveVideo` 回的 `isLocal` 决定，渲染层**不自己看 `lf_` 前缀** ——
   * 那是主进程的命名细节，改一次就得全渲染层跟着改。
   *
   * 用途只有一个：`<video>` 报错时分开处理 —— 本地文件只有「丢了」和
   * 「解不出来」两种可能，不该走 B 站那套「跳过缓存重试 → 跳下一条」。
   */
  currentBvidIsLocal: false,

  /**
   * 这次会话里已经弹过「文件丢了」的 bvid
   *
   * 不记的话，同一首失败会被 `next()` / 重试 / 用户手点反复触发，
   * 叠出一串一模一样的确认框。
   */
  _missingPrompted: [] as string[],

  /** 视频加载完成后要跳转到的秒数（续播用） */
  seekAfterLoad: 0,

  /**
   * `seekAfterLoad` 是为哪一首歌设的
   *
   * 这个字段必须一起带上：`seekAfterLoad` 是跨源共享的，
   * 若切歌后还拿旧的秒数去 seek，短一点的歌会直接被定位到 duration 之外。
   */
  seekAfterLoadFor: '',

  /** 是否正在缓冲（切换清晰度 / 切歌时 MSE 重新拉流的那段） */
  buffering: false,

  /** 缓冲进度百分比（0-100，朝「够播」推进） */
  bufferPercent: 0,

  /** 播放位置之后已缓冲的秒数 */
  bufferSeconds: 0,

  /** 缓冲百分比的定时刷新句柄（只在缓冲期间跑） */
  _bufferTimer: null as ReturnType<typeof setInterval> | null,

  /** 片尾看门狗：每秒检查一次「缓冲到底但没触发 ended」 */
  _endWatchTimer: null as ReturnType<typeof setInterval> | null,

  /** 换源时延迟显示缓冲提示的定时器 */
  _bufferOverlayTimer: null as ReturnType<typeof setTimeout> | null,

  /** 预热槽位：上一首 / 下一首各一个 */
  _warm: { next: null, prev: null } as AppData['_warm'],

  /**
   * 某个方向是否已经「热」过了
   *
   * 必须有这个标志：预热媒体只拉 2 秒就 `stopWarmMedia()`，而 `_warm[dir]`（接口结果）
   * 还要留着给切歌用 —— 只看 `_warmSession/_warmTimer` 的话，心跳每秒都会认为
   * 「这个方向还没预热」，于是**每 3 秒重建一次 MediaSource 并重新拉流**，
   * 一首歌下来几十次（next/prev 各一份），白白吃带宽和 CPU。
   * 只在 `clearWarm`（切进那首 / 换歌单）里清掉。
   */
  _warmed: { next: false, prev: false },

  _warming: { next: false, prev: false },

  /**
   * 某个方向的预热**失败了几次**（用来实现「重试 3 次、间隔 3 秒」）
   *
   * 为什么需要它：心跳每秒都会调 `warmApi`，而搜不到视频时不能靠 `_warm[dir]`
   * 拦截（那个槽位是空的）—— 没有这个计数就会**每秒重试一次真网络请求**，
   * 一直不停（用户反馈「日志刷了几十行、界面卡住」就是这么来的）。
   *
   * 达到上限后记进 `_warm[dir]`（带 `failed` 标记）彻底停掉，直到换歌才重置。
   */
  _warmTries: { next: 0, prev: 0 },

  /** 某个方向的预热结果是否已彻底失败（不再重试，等换歌清掉） */
  _warmFailed: { next: false, prev: false },

  /** 上次预热失败的时间戳（配合 `WARM_RETRY_DELAY_MS` 实现「间隔 3 秒」） */
  _warmRetryAt: { next: 0, prev: 0 },

  _warmEl: { next: null, prev: null } as AppData['_warmEl'],

  _warmSession: { next: null, prev: null } as AppData['_warmSession'],

  _warmTimer: { next: null, prev: null } as AppData['_warmTimer'],

  /** 播放位置最后一次前进的时间戳 */
  _lastProgressAt: 0,

  /** 最后一次记录到的播放位置（判断有没有前进） */
  _progressPos: 0,

  /** 本次源已经按「播完」处理过，避免看门狗重复触发 */
  _endStallHandled: false,

  /** 停滞看门狗的起始时间戳（0 = 当前没在停滞） */
  _stallSince: 0,

  /** 本次停滞已经恢复过几次（真的开始播了就清零） */
  _stallRecoveries: 0,

  /** 单曲歌单下反复停滞：已放弃这条流，不再周期性告警 */
  _stallGivenUp: false,

  /**
   * 「所有源都卡住」那条**常驻**通知当前是不是还开着
   *
   * 它 `duration: 0`（要手动关），所以必须保证同时只有一条 ——
   * 详见 `recoverFromStall` 步骤 ④ 的说明。
   */
  _stallNoticeOpen: false,

  /** 卡顿恢复链：当前试到第几个备用源（0 = 主地址） */
  _stallUrlIndex: 0,

  /** 卡顿恢复链：已经降了几档清晰度（最多 3 档） */
  _stallQualityDrops: 0,
});

/** ===== getters ===== */
export interface PlaybackGetters {
  readonly playlistsStore: ReturnType<typeof usePlaylistStore>;
  readonly queueStore: ReturnType<typeof useQueueStore>;
  readonly sessionStore: ReturnType<typeof useSessionStore>;
  readonly settingStore: ReturnType<typeof useSettingStore>;
  readonly sleepStore: ReturnType<typeof useSleepStore>;
  readonly systemStore: ReturnType<typeof useSystemStore>;
  readonly uiStore: ReturnType<typeof useUiStore>;
  readonly videoListsStore: ReturnType<typeof useVideoListStore>;
  readonly windowStore: ReturnType<typeof useWindowStore>;
  readonly videoQualityDetail: string;
  readonly audioQualityDetail: string;
  readonly ringLength: number;
  readonly ringOffset: number;
  readonly bufferSubText: string;
  readonly currentVideoQn: number | null;
  readonly currentAudioId: number | null;
}

export type PlaybackGetterFns = { [K in keyof PlaybackGetters]: () => PlaybackGetters[K] };

export const playbackGetters: ThisType<PlaybackContext> = {
  playlistsStore: () => usePlaylistStore(),
  queueStore: () => useQueueStore(),
  sessionStore: () => useSessionStore(),
  settingStore: () => useSettingStore(),
  sleepStore: () => useSleepStore(),
  systemStore: () => useSystemStore(),
  uiStore: () => useUiStore(),
  videoListsStore: () => useVideoListStore(),
  windowStore: () => useWindowStore(),
  /** 清晰度角标的悬浮提示：完整描述 + 实际解码分辨率 */
  videoQualityDetail(): string {
    if (!this.videoQuality) return '';
    const head = this.videoQualityDesc || this.videoQuality;
    return this.videoQualityPixels ? `${head}（${this.videoQualityPixels}）` : head;
  },

  /** 音质角标的悬浮提示 */
  audioQualityDetail(): string {
    if (!this.audioQuality) return '';
    return this.audioQualityDesc || this.audioQuality;
  },

  /** 缓冲圆环的周长（r = 15.5，SVG viewBox 36x36） */
  ringLength(): number {
    return 2 * Math.PI * 15.5;
  },

  /** 缓冲圆环的绘制偏移：百分比越大画得越满 */
  ringOffset(): number {
    return this.ringLength * (1 - Math.min(100, Math.max(0, this.bufferPercent)) / 100);
  },

  /**
   * 缓冲提示的副标题
   *
   * 把三个阶段分开说清楚，否则「0% 不动」和「99% 卡住」都会让人以为出问题了：
   *  - 还没拿到数据 -> 正在取流
   *  - 数据够了但解码器还没就绪 -> 即将播放
   *  - 其余 -> 报已缓冲秒数
   */
  bufferSubText(): string {
    if (this.bufferSeconds <= 0.05) return '正在获取视频流…';
    if (this.bufferPercent >= 95) return '即将开始播放…';
    return `已缓冲 ${this.bufferSeconds.toFixed(1)} 秒`;
  },

  /** 当前实际在播的清晰度代码；durl 兜底时没有 dash 信息，返回 null */
  currentVideoQn(): number | null {
    return this.dashSource?.videoId ?? null;
  },

  /** 当前实际在播的音频流 id；durl 兜底时为 null */
  currentAudioId(): number | null {
    return this.dashSource?.audioId ?? null;
  }
};

/** ===== actions ===== */
export interface PlaybackActions {
  videoEl(): VideoElement | null;
  stopDashSession(): void;
  videoControl(event: VideoControlAction): void;
  playControl(): void;
  changeTime(time: number): void;
  changeVolume(volume: number): void;
  toggleMute(): void;
  formatTime(s: number): string;
  onVideoBuffering(): void;
  onVideoPlaying(): void;
  lastBufferedEnd(): number;
  checkEndOfStream(): void;
  startEndWatch(): void;
  checkPlaybackStall(): void;
  recoverFromStall(): void;
  switchDashUrl(videoUrl: string): void;
  currentQualityLabel(): string;
  nextLowerQuality(): { id: number; label: string } | null;
  bufferedAhead(): number;
  syncBufferState(): void;
  startBufferTicker(): void;
  stopBufferTicker(): void;
  videoError(): Promise<void>;
  onLocalFileMissing(bvid: string, filePath: string): Promise<void>;
  removeLocalItemFromList(bvid: string): Promise<void>;
  onVideoLoaded(): void;
  onVideoPlayStateChange(): void;
  videoUpDate(): void;
  syncVideoQuality(): void;
  videoEnded(): void;
  scheduleBufferOverlay(): void;
  clearBufferOverlayTimer(): void;
  loadPlaybackSource(): Promise<{ name: string; songs: StructuredSong[]; lastIndex: number; } | null>;
  tryResume(): Promise<boolean>;
  restoreSongVideo(index: number, seekTo?: number): Promise<boolean>;
  createEngine(): void;
  playAt(index: number, options?: LoadOptions): Promise<boolean>;
  playCandidate(bvid: string, options?: LoadOptions): Promise<void>;
  stepIndex(direction: 1 | -1): number;
  onEngineSwitch(index: number, item: PlayItem): void;
  onEngineStream(stream: ResolvedStream): void;
  onEngineEmpty(item: PlayItem, filtered: boolean): void;
  onEngineError(item: PlayItem, err: unknown): void;
  fillDuration(bvid: string, seconds: number): void;
  clearNowPlaying(): void;
  playCurrent(seekTo?: number): void;
  next(): void;
  prev(): void;
  toggleMode(): void;
  getRandomNext(): number;
  getRandomPrev(): number;
  resetRandomList(): void;
  maybeWarm(): void;
  indexForDir(dir: 'next' | 'prev'): number;
  warmApi(dir: 'next' | 'prev'): Promise<void>;
  warmMedia(dir: 'next' | 'prev'): void;
  warmElement(dir: 'next' | 'prev'): VideoElement | null;
  stopWarmMedia(dir: 'next' | 'prev'): void;
  clearWarm(dir: 'next' | 'prev'): void;
  clearAllWarm(): void;
  dropWarmIfCurrent(): void;
  isRateLimitErr(err: unknown): boolean;
  switchQuality(kind: 'video' | 'audio', id: number): Promise<void>;
  rememberSeekPoint(): void;
  fallbackToDurl(): void;
  currentVideoCover(): string | null;
  currentCover(): string | null;
}

export type PlaybackContext = PlaybackState & PlaybackGetters & PlaybackActions;

export const playbackActions: ThisType<PlaybackContext> = {
  /**
   * 取 <video> 元素
   *
   * Vue 的 $refs 是无类型的，这里统一收口成一个小工具方法，
   * 避免每处都写 (this.$refs.video as HTMLVideoElement)。
   */
  videoEl(): VideoElement | null {
    return (this._videoHolder.el) ?? null;
  },

  /** 停掉当前的 dash（MSE）会话，不动界面状态 */
  stopDashSession(): void {
    this.engine?.stop();
  },

  videoControl(event: VideoControlAction): void {
    /*
     * ⚠️ 这里**不需要**再判 `netBusy`
     *
     * 「会发请求」的只有 `before` / `next` 两个动作，而它们最终都会走到
     * `prev()` / `next()` —— 那两个函数**内部**已经统一守住了 `netBusy`
     * （见 `next()` 的注释）。在这里再判一次是重复的，而且容易让人误以为
     * 「守卫只在这个入口有效」。
     *
     * 模板里的 `@click="busy ? null : ..."` 是**另一回事**：那儿只负责
     * 给用户「点不动」的视觉反馈（灰掉 + not-allowed），不承担拦截职责。
     */
    switch (event) {
      case 'songList':
      case 'videoList':
        this.uiStore.showList(event);
        break;
      case 'before':
        this.prev();
        break;
      case 'next':
        this.next();
        break;
      case 'playControls':
        this.playControl();
        break;
      case 'playMode':
        this.toggleMode();
        break;
    }
  },

  playControl(): void {
    const v = this.videoEl();
    if (!v) return;
    if (this.paused) {
      // play() 的 promise 必须吃掉：换源 / seek 会把它中断成 AbortError，
      // 不 catch 就是一条「Uncaught (in promise)」噪音日志
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
    this.paused = !this.paused;
    this.systemStore.syncTrayState();
  },

  changeTime(time: number): void {
    const v = this.videoEl();
    if (!v) return;
    if (this.paused) {
      void v.play().catch(() => {});
      this.paused = false;
    }
    v.currentTime = time;
  },

  changeVolume(volume: number): void {
    // 记住最后一个非零音量，供「解除静音」恢复使用。
    // 不能用子组件的 draggingVolume —— 那个只在拖动时才更新，
    // 点击静音时还停在初始值 0，会把音量"恢复"成 0。
    if (volume > 0) this.lastNonZeroVolume = volume;
    this.isMuted = volume == 0;
    // <video> 的 volume/muted 统一由上面的 settingStore watcher 落地，
    // 这里不重复写，避免两处状态不同步
    this.currentVolume = volume;
    // 用户改动音量 -> 写回主进程持久化（音量与静音状态一起写，保证两者不矛盾）
    this.settingStore.update({
      'player.volume': volume,
      'player.isMute': this.isMuted,
    });
    // 托盘菜单里的音量条要跟着变（菜单开着时）
    this.systemStore.syncTrayState();
  },

  /**
   * 静音 / 解除静音
   *
   * 由本组件决定音量（因为音量状态的权威在这里），
   * 子组件只负责上报「用户点了静音」。
   */
  toggleMute(): void {
    if (this.isMuted) {
      // 恢复：优先用上次的非零音量；没有历史就用默认音量，
      // 避免"恢复成 0"导致音量再也回不来
      const fallback = defaultSetting['player.volume'];
      const restore = this.lastNonZeroVolume > 0 ? this.lastNonZeroVolume : fallback;
      this.changeVolume(restore);
      ElMessage.success(`音量: ${restore}`);
    } else {
      this.changeVolume(0);
      ElMessage.success('已静音');
    }
  },

  formatTime(s: number): string {
    s = Math.floor(s || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p = (n: number): string => (n < 10 ? '0' + n : String(n));
    return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  },

  /**
   * 缓冲提示
   *
   * 显示时机只由 `<video>` 自己的信号决定（waiting / stalled / seeking / 换源），
   * 不用 `readyState` 主动显示 —— 否则正常播放时也会闪一下。
   * 隐藏则由「够播了」来判定（见 syncBufferState）。
   */
  onVideoBuffering(): void {
    this.buffering = true;
    this.syncBufferState();
    this.startBufferTicker();
    /**
     * 真卡了就先松开预热的流。
     *
     * 预热是「为了更顺」，绝不能反过来把当前播放挤卡 ——
     * 一旦出现 waiting/stalled，立刻停掉两个方向的预热下载。
     */
    this.stopWarmMedia('next');
    this.stopWarmMedia('prev');
  },

  onVideoPlaying(): void {
    this.buffering = false;
    this.bufferPercent = 100;
    this.stopBufferTicker();
    // 已经出画：撤掉还没到点的换源提示
    this.clearBufferOverlayTimer();
    // 有一条真的播起来了 = 失效条目不是连成片的，跳过计数归零
    this.queueStore._ovSkipStreak = 0;
  },

  /** 已经缓冲到第几秒（取**包含当前播放点**的那一段的末尾） */
  lastBufferedEnd(): number {
    const el = this.videoEl();
    if (!el || !el.buffered.length) return 0;
    const t = el.currentTime;
    /**
     * 为什么要挑「包含播放点」的那一段
     *
     * 往前拖到未缓冲区域后，`buffered` 会出现第二段区间（比如 [0,10] 和 [60,90]）。
     * 直接取最后一段的末尾（90）会把「已缓冲 80 秒」这种虚高的数字报给界面，
     * 于是「够播了」可能提前成立、缓冲提示被撤掉；预热那边「自己缓冲是否充足」的
     * 带宽闸门也会被骗着在真缺数据时去抢带宽。
     */
    for (let i = 0; i < el.buffered.length; i += 1) {
      if (t >= el.buffered.start(i) && t <= el.buffered.end(i)) return el.buffered.end(i);
    }
    /**
     * 播放点不在任何缓冲段里（刚开始加载 / 正在拖动）：沿用「最后一段末尾」的老行为。
     * 这里刻意保守 —— 换成返回 0 会让起播瞬间的 `bufferSeconds` 变成 0，
     * 「够播了」不成立，缓冲提示反而不该亮的时候亮着。
     */
    return el.buffered.end(el.buffered.length - 1);
  },

  /**
   * 片尾看门狗
   *
   * dash（MSE）偶尔会「缓冲已经到底、画面也播到最后一秒，但 `ended` 就是不触发」，
   * 于是自动下一首永远不会发生，界面上只留一个不动的缓冲圈 —— 用户看到的就是
   * 「播到还剩一秒卡住，弹个 98% 不动」。
   *
   * 判定条件卡得很死，避免把「尾巴还在下载」误判成播完：
   *  - 已经进入最后 2 秒，且**缓冲末尾真的到了片尾**（尾巴没下完就不会满足）
   *  - 没有暂停 / 没有在 seek（否则不动是正常的）
   *  - 位置连续 3 秒没有前进
   * 命中就按「播完了」处理（单曲循环重播，其余模式下一首）。
   */
  checkEndOfStream(): void {
    const v = this.videoEl();
    if (!v || this._endStallHandled) return;
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    if (v.paused || v.seeking) return;
    if (v.currentTime < d - 2) return;
    /**
     * 缓冲末尾的判定要留足余量。
     *
     * 实测的卡死现场：`155.1 / 156.0`、`readyState = 2`（有当前帧、没有后续数据），
     * 缓冲末尾就停在 155.1 —— 比总时长差 0.9 秒。原来要求 `>= duration - 0.5`，
     * 正好差一点点不满足，于是**看着它卡在那里什么都不做**（这就是用户报的那个 bug）。
     * 放宽到 2.5 秒：片尾这几秒本来就短，差这么多只可能是「拿不到剩下的了」。
     */
    if (this.lastBufferedEnd() < d - 2.5) return;
    /**
     * 等多久算真卡住：`readyState >= 3` 说明还有后手数据，等 3 秒；
     * `readyState <= 2`（等着数据但没来）多给一点时间，避免尾巴下载慢时误判成播完。
     */
    const wait = v.readyState >= 3 ? 3000 : 5000;
    if (Date.now() - this._lastProgressAt < wait) return;
    this._endStallHandled = true;
    console.warn('[video] 片尾卡住（缓冲到底但没触发 ended），按播完处理');
    this.videoEnded();
  },

  startEndWatch(): void {
    if (this._endWatchTimer) return;
    this._endWatchTimer = setInterval(() => {
      this.checkEndOfStream();
      // 片尾看门狗之外，再管「中途/刚开播就不动了」的情况
      this.checkPlaybackStall();
      this.maybeWarm();
    }, 1000);
  },

  /**
   * 播放停滞看门狗（不只是片尾）
   *
   * 用户反馈：偶尔一打开就显示「99% 缓冲」卡住，点一下下一首就好了。
   * 那种情况是「有数据但不继续来」：`syncBufferState` 的隐藏条件是
   * `readyState >= 3` 且余量够 1 秒，数据不来就永远不满足；而百分比被夹在 99
   * （分母是「播放点 + 余量」，没下完就不会到 100），于是圈一直挂着。
   *
   * 判据（1 秒心跳里看，都要满足）：
   *  - 没暂停 / 没拖动 / 已经拿到时长（真的在放一条片子）
   *  - 不在最后 2 秒（片尾另有 `checkEndOfStream`）
   *  - 播放位置连续 `STALL_MS` 没前进（`_lastProgressAt` 由 timeupdate 维护）
   * 命中后按「先重解析、再跳下一首」两级处理，和 `videoError` 的思路一致。
   */
  checkPlaybackStall(): void {
    const v = this.videoEl();
    // 已经判定这条流救不回来（单曲歌单 + 反复停滞）：别再周期性告警
    if (this._stallGivenUp) return;
    /**
     * `paused` 不能一概当成「用户暂停了」
     *
     * 踩过：起播的 `play()` 原来只在 `onVideoLoaded`（`@loadeddata`）里调用，
     * 而 dash（MSE）会话卡住时 `loadeddata` **永远不来** —— 元素一直 `paused === true`，
     * 这里第一道判断就把自己排除掉了，于是「时长有了、画面一个字节都没有」会**永久卡住**，
     * 连重解析兜底都进不去（用户报的就是这个）。
     * 判据：`readyState === 0` 且位置还是 0 = 一个字节都没到，算停滞，照样走兜底。
     */
    const neverStarted = v ? v.readyState === 0 && v.currentTime === 0 : false;
    if (!v || v.seeking || (v.paused && !neverStarted)) {
      // 暂停/拖动时不动是正常的：计时和「已恢复几次」都清掉，
      // 否则用户暂停过一次，本曲第一次真停滞会直接走「已跳过」而省掉重解析
      this._stallSince = 0;
      this._stallRecoveries = 0;
      return;
    }
    /**
     * 还没给过源就不管：起播前本来就该等。
     * 判据用 `currentSrc`（MSE 下是 blob: 地址，普通播放是直链），它空着说明连源都没设。
     */
    if (!v.currentSrc) {
      this._stallSince = 0;
      return;
    }
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    /**
     * **`duration` 为 0 正是用户报的那个场景**，不能提前 return。
     *
     * 现场是：时长那里显示 `0:00`、缓冲圈停在 99%。原因是 MSE 已经有分片进来了
     * （所以 `buffered.end()` 有值、百分比能算到 99），但整条的 duration 一直没确定、
     * `readyState` 也上不去 —— 于是 `syncBufferState` 的隐藏条件永远不满足，圈就挂着。
     * 原来这里写了「没拿到时长就直接返回」，等于把这个场景排除在保护之外。
     */
    const noDuration = d === 0;
    if (!noDuration && v.currentTime >= d - 2) {
      // 片尾交给 checkEndOfStream，别两边同时动手
      this._stallSince = 0;
      return;
    }
    // 2 秒内有前进就算正常（timeupdate 约 250ms 一次，留足余量）
    if (Date.now() - this._lastProgressAt < 2000) {
      this._stallSince = 0;
      this._stallRecoveries = 0;
      return;
    }
    if (!this._stallSince) {
      this._stallSince = Date.now();
      return;
    }
    if (Date.now() - this._stallSince < STALL_MS) return;
  
    // 记一次恢复尝试，并把计时重置为「再看一个 STALL_MS」
    this._stallSince = Date.now();
    this._stallRecoveries += 1;
    console.warn(
      `[video] 播放停滞 ${STALL_MS}ms（t=${v.currentTime.toFixed(1)} duration=${d} readyState=${v.readyState} 第 ${this._stallRecoveries} 次恢复，源 ${this._stallUrlIndex + 1}，已降 ${this._stallQualityDrops} 档）`,
    );
  
    this.recoverFromStall();
  },

  /**
   * ★ 卡顿恢复链（分级推进，每命中一次 `STALL_MS` 走一步）
   *
   * ```
   * ① 换同一清晰度的**备用源**（backupUrl）        ← 无条件自动
   * ② 备用源试完还卡 → 降一档清晰度（回到 ①）      ← ★ 只看「自动降清晰度」开关
   * ③ 降了 3 档还卡 → 降 durl                      ← 无条件自动
   * ④ durl 还卡 → 暂停 + notify「检查网络连接」
   * ```
   *
   * ## 开关只影响第 ② 步
   *
   * 「换源」和「降 durl」不损失清晰度体验（还是同一档画面 / 只是换封装），
   * 所以**无条件做**；只有「降清晰度」是画面变糊，才让用户决定：
   *  - **开**：自动降 + `message` 告知「已自动降低清晰度为 XXX」
   *  - **关**：不降，`message` 提示「建议降到 XXX」让用户自己点
   *
   * ## 关掉自动降时**不一级级降**
   *
   * 用户明确要求：关的时候换完备用源还卡就**直接降 durl**（不是一级级降下来）。
   * 因为"不自动降"意味着用户想保住当前清晰度，那就别拿一串中间档位烦他。
   */
  recoverFromStall(): void {
    /** 换源要保留播放位置（换 src 会清零） */
    this.rememberSeekPoint();
  
    const dash = this.dashSource;
    /**
     * ① 还有没用过的备用源 → 换下一个
     *
     * `_stallUrlIndex` 记着「当前试到第几个」；换源时递增。
     */
    if (dash && this._stallUrlIndex + 1 < dash.videoUrls.length) {
      this._stallUrlIndex += 1;
      const nextUrl = dash.videoUrls[this._stallUrlIndex];
      ElMessage.warning(
        `网络不稳定，正在切换备用源（${this._stallUrlIndex + 1}/${dash.videoUrls.length}）`,
      );
      this.switchDashUrl(nextUrl);
      return;
    }
  
    /**
     * ② 备用源试完了
     *
     * - 自动降清晰度**开** → 降一档（最多 3 档）
     * - **关** → 跳过这一步，直接进 ③ 降 durl
     */
    if (dash && this.settingStore.setting['player.autoDowngradeOnStall']) {
      if (this._stallQualityDrops < MAX_QUALITY_DROPS) {
        const lower = this.nextLowerQuality();
        if (lower) {
          this._stallQualityDrops += 1;
          ElMessage.warning(`网络不稳定，已自动降低清晰度为 ${lower.label}`);
          void this.switchQuality('video', lower.id);
          return;
        }
      }
    }
  
    /**
     * ③ 降 durl（混流 720P）
     *
     * 只有 dash 才需要这一步（已经在 durl 上就没什么可降的了）。
     */
    if (dash) {
      /**
       * ⚠️ 提示文案不要出现「已切换到 720P 混流，可以切换到 720P 试试」这种废话
       * （用户明确吐槽过）。分两种情况：
       *  - 当前清晰度**不是** 720P → 告知降到了 720P，并建议他试试**下一级**
       *  - 当前**就是** 720P（甚至更低）→ 只说「已切换到混流」，不提清晰度
       */
      const curLabel = this.currentQualityLabel();
      const lower = this.nextLowerQuality();
      if (lower && lower.label !== curLabel) {
        ElMessage.warning(
          `网络不稳定，已切换到 720P，可以试试 ${lower.label}`,
        );
      } else {
        ElMessage.warning('网络不稳定，已切换到 720P');
      }
      this.fallbackToDurl();
      return;
    }
  
    /**
     * ④ durl 也卡 → 暂停 + 常驻提示（用户要「一直显示」，所以用 `$notify`）
     *
     * 不跳下一首：用户说过「那样下一首也会卡的」，跳了没意义。
     *
     * ## ⚠️ 常驻通知必须**只留一条**（踩过）
     *
     * 这个通知 `duration: 0`（不自动消失，要手动关）。而 `_stallGivenUp`
     * 会在**每次换源**时被复位（`onEngineStream`）—— 于是用户手动切个清晰度
     * 或再 fallback 一次之后，8 秒又能弹一条**同样的**常驻通知，
     * 旧的那条还挂在屏幕右上角 → **通知叠加**。
     *
     * 所以这里自己记着「那条通知还开着没有」：还开着就**不再新弹**，
     * 由用户在关闭时（`onClose`）把标记清掉。这样「同时最多一条」是硬保证，
     * 不再依赖 `_stallGivenUp` 的复位时机。
     */
    if (!this._stallGivenUp) {
      this._stallGivenUp = true;
      this.videoEl()?.pause();
      this.paused = true;
      if (!this._stallNoticeOpen) {
        this._stallNoticeOpen = true;
        ElNotification({
          title: '播放已暂停',
          message: '网络连接不稳定，所有播放源都卡住了，请检查网络状况',
          type: 'warning',
          duration: 0,
          onClose: () => {
            this._stallNoticeOpen = false;
          },
        });
      }
      console.warn('[video] 所有源都卡顿，已暂停并提示用户检查网络');
    }
  },

  /**
   * 换到**同一个清晰度**的另一个源（不重新解析，只换 URL）
   *
   * 为什么值得做：卡顿往往是某个 CDN 节点的问题，B 站每条流都给了
   * `baseUrl` + 多个 `backupUrl`（不同 CDN）。换一个通常立刻就好，
   * 比降清晰度 / 重新解析都快。
   */
  switchDashUrl(videoUrl: string): void {
    const dash = this.dashSource;
    if (!dash) return;
    const el = this.videoEl();
    if (!el) return;
    /**
     * 只换视频轨的地址，音频轨保持不变 —— 卡顿通常是视频带宽吃紧
     * （音频只有几十 KB/s，很少成为瓶颈），换音频源收益小、风险大。
     */
    this.dashSource = { ...dash, videoUrl };
    this.engine?.retargetDash(videoUrl);
  },

  /** 当前清晰度的可读名（`1080P60` 这种） */
  currentQualityLabel(): string {
    const qn = this.currentVideoQn;
    if (qn == null) return '720P';
    return findQualityOption(VIDEO_QUALITY_OPTIONS, qn)?.label ?? String(qn);
  },

  /**
   * 比当前低一档的清晰度
   *
   * 按 `VIDEO_QUALITY_OPTIONS` 的顺序（从高到低）找当前档位的**下一个**。
   * 找不到（已经在最低档）返回 `null`。
   */
  nextLowerQuality(): { id: number; label: string } | null {
    const qn = this.currentVideoQn;
    if (qn == null) return null;
    const list = VIDEO_QUALITY_OPTIONS;
    const idx = list.findIndex((o) => o.id === qn);
    if (idx < 0) return null;
    const next = list[idx + 1];
    return next ? { id: next.id, label: next.label } : null;
  },

  /**
   * 刷新缓冲百分比
   *
   * 量的是「离能播还差多少」，而不是「整条视频下载了多少」——
   * 后者在限流之后会长时间停在很小的数字上，看着更像卡死。
   *
   * 关键：切歌/续播时播放点常常落在**已缓冲区间之外**（比如定位到 12.7 秒、
   * 但只下到 5 秒），这时进度应该按「下载到播放点」算：
   * 所以分子取「最后一段缓冲的末尾」，分母取「播放点 + 余量」。
   */
  /**
   * 播放点往后**连续可用**多少秒
   *
   * 播放点不在任何缓冲段里就返回 0 —— 这正是「时长有了、一个字节都没解码」那种卡住的判据。
   * 不能用 `lastBufferedEnd()` 代替：它取的是「包含播放点那段的末尾，否则最后一段的末尾」，
   * 当播放点在第一个缓冲段**之前**（MSE 刚 append、还没起播）时会给出一个很大的数，
   * 于是缓冲提示被误判成「早就够播了」而**不显示**（用户报的「加载条也不显示就卡在那里」）。
   */
  bufferedAhead(): number {
    const el = this.videoEl();
    if (!el || !el.buffered.length) return 0;
    const t = el.currentTime;
    for (let i = 0; i < el.buffered.length; i += 1) {
      if (t >= el.buffered.start(i) && t <= el.buffered.end(i)) {
        return Math.max(0, el.buffered.end(i) - t);
      }
    }
    return 0;
  },

  syncBufferState(): void {
    const el = this.videoEl();
    if (!el) return;
    const ahead = this.bufferedAhead();
    this.bufferSeconds = ahead;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    /** 从播放点往后连续可用到哪一秒（有空洞时就是播放点本身） */
    const end = el.currentTime + ahead;
    /**
     * 分母不能超过片子总长。
     *
     * 原来分母是 `max(播放点 + 3, 5)`，越接近片尾这个数越大，而缓冲末尾最多只能到
     * `duration`（播放器不可能缓冲到片子后面）—— 于是进度永远差一点点，
     * 表现就是「播到还剩一秒，弹个 98% 的圈不动」。夹到 duration 之后，
     * 片尾那几秒的百分比就是真实的「下载到哪了」。
     */
    const target = Math.max(el.currentTime + LEAD_S, START_BUFFER_S);
    const need = duration > 0 ? Math.min(duration, target) : target;
    const ratio = end <= 0 || need <= 0 ? 0 : Math.min(1, end / need);
    this.bufferPercent = Math.max(0, Math.min(99, Math.floor(ratio * 100)));
  
    /**
     * 够播了就撤掉提示。
     *
     * 正常播放中要求留 ≥1 秒余量；但**已经缓冲到片尾**时不存在「余量」这回事
     * （最后那零点几秒就是全部了），所以这时只要解码器就绪、还剩一点数据就撤，
     * 否则就会一直挂着一个 98% / 99% 的圈。
     */
    const atStreamEnd = duration > 0 && end >= duration - 0.5;
    const enough = el.readyState >= 3 && this.bufferSeconds >= (atStreamEnd ? 0.05 : 1);
    if (enough) {
      this.bufferPercent = 100;
      this.buffering = false;
      this.stopBufferTicker();
    }
  },

  /** 缓冲期间每 250ms 刷新一次数字（`progress` 事件在 MSE 下不一定会持续触发） */
  startBufferTicker(): void {
    if (this._bufferTimer) return;
    this._bufferTimer = setInterval(() => this.syncBufferState(), 250);
  },

  stopBufferTicker(): void {
    if (this._bufferTimer) {
      clearInterval(this._bufferTimer);
      this._bufferTimer = null;
    }
  },

  /**
   * 视频加载失败
   *
   * 修复要点：原来是无条件 `playCandidate(..., skipCache)` 重试，没有计数上限，
   * 一旦解析始终失败就是死循环。这里加失败计数：
   *  - 先跳过缓存重试一次（原意图）
   *  - 仍失败则跳到下一首，并提示用户
   */
  async videoError(): Promise<void> {
    // 切歌时 this.queueStore.currentKey 立刻变成新歌，但 videoList 还是上一首的；
    // 这段窗口里旧视频元素报错不能算在新歌头上（否则会拿旧 bvid 重试，
    // 甚至把旧视频永久记到新歌名下），直接忽略。
    if (this.queueStore.videoListKeyword !== this.queueStore.currentKey) return;
  
    /**
     * dash（MSE）出错时先退回 durl，别直接判成「视频加载失败」。
     *
     * MSE 的失败面比单文件播放宽得多（编码不支持、某个分片拉取失败、
     * buffer quota 超限……），这些都不代表视频本身坏了。
     * 退回 720P 混流至少能正常看，比跳歌好得多。
     */
    if (this.dashSource) {
      this._videoErrorCount = 0;
      ElMessage.warning('高清流播放失败，已自动切回 720P');
      this.fallbackToDurl();
      return;
    }
  
    /**
     * ★ 本地文件：只有两种失败，别混进 B 站那套重试 / 跳过
     *
     * 「跳过缓存重试一次」对本地文件是纯浪费（没有缓存、没有签名过期），
     * 「跳下一条」更糟：文件只是被挪走了，用户要的是**指回去**，不是绕过它。
     *
     * 所以先问一句文件还在不在，再分两条：
     *  - **不在了**（播放中途被删 / 移走 / 盘掉了）→ 弹重新定位；
     *  - **还在** → 那是解码问题（HEVC / 10bit / mkv 常见），
     *    说清原因就停住，不要一边报错一边往下跳。
     */
    if (this.currentBvidIsLocal && this.currentBvid) {
      const bvid = this.currentBvid;
      this._videoErrorCount = 0;
      const state = await electronApi
        .localVideoExists(bvid)
        .catch(() => ({ exists: false, filePath: null as string | null }));
      if (state.exists) {
        ElMessage.error('这个本地文件解不出画面（多半是编码不支持，比如 HEVC / 10bit）');
        return;
      }
      void this.onLocalFileMissing(bvid, state.filePath ?? '');
      return;
    }
  
    this._videoErrorCount += 1;
    const video = this.queueStore.videoList[this.queueStore.currentVideoIndex];
    if (this._videoErrorCount === 1 && video) {
      /**
       * 第一次失败：跳过缓存重新解析该视频
       *
       * 必须先把当前位置记下来：这是**同一个视频**重新解析地址（缓存过期 / 直链失效），
       * 换 `src` 会把播放位置清零 —— 不记的话用户听到的就是「重新解析后从头开始」。
       */
      this.rememberSeekPoint();
      await this.playCandidate(video.bvid, { skipCache: true });
      return;
    }
    this._videoErrorCount = 0;
    /**
     * OV 下的「失效条目」保护
     *
     * 视频列表的条目是外部数据，已删除 / 私享 / 充电专属 / 地区限制都很常见。
     * 全部或大半失效时，`next()` 会一条接一条地跳，每条还要重解析两次 ——
     * 几十条下来就是一批请求，B 站直接 412。
     * 所以连续跳过 5 条就**停下来**，把决定权交回用户。
     */
    if (this.queueStore.fromVideoList) {
      this.queueStore._ovSkipStreak += 1;
      const label = titleOf(this.queueStore.songs[this.queueStore.currentIndex]) || '当前视频';
      if (this.queueStore._ovSkipStreak >= OV_MAX_AUTO_SKIP) {
        this.queueStore._ovSkipStreak = 0;
        ElNotification({
          title: `连续 ${OV_MAX_AUTO_SKIP} 个视频都取不到播放地址`,
          message: '已暂停自动切换。点这条提示可以再试下一个。',
          type: 'warning',
          duration: 0,
          onClick: () => this.next(),
        });
        return;
      }
      ElMessage.warning(`《${label}》取不到播放地址，已跳过`);
    } else {
      /** 用显示名（`songName` 现在是缓存键，形如 `tx_xxx`，不能贴进提示） */
      ElMessage.warning(`《${this.queueStore.currentKey || '当前歌曲'}》视频加载失败，已跳过`);
    }
    if (this.queueStore.songs.length > 1) this.next();
  },

  /**
   * ★ 本地视频文件找不到了：给两条出路
   *
   * 没这个入口的话，用户唯一的办法是「去视频管理删掉这条 → 再拖一次」——
   * 而拖一次会生成**新的 bvid**（路径哈希变了），列表里的位置、收藏、
   * 播放进度全丢。所以这里的主路径是**重新定位**：只改路径、不动身份。
   *
   * 「从列表移除」是另一条出路，但**默认不选**：文件可能只是在没插上的
   * 移动硬盘里，过两天插回来还能用。
   *
   * 同一个 bvid 一次会话只问一次（`_missingPrompted`）：否则 `next()`、
   * 手动重点、重试各弹一次，叠出一摞确认框。
   */
  async onLocalFileMissing(bvid: string, filePath: string): Promise<void> {
    if (!bvid || this._missingPrompted.includes(bvid)) return;
    this._missingPrompted.push(bvid);
  
    let action = 'close';
    try {
      await ElMessageBox.confirm(
        `这个本地视频的文件找不到了（可能被删除、改名或移动）。` +
          (filePath ? `\n\n原来的位置：${filePath}` : '') +
          `\n\n重新定位后，它在列表里的位置、收藏和播放进度都会保留。`,
        '视频文件已丢失',
        {
          confirmButtonText: '重新定位文件',
          cancelButtonText: '从列表移除',
          distinguishCancelAndClose: true,
          type: 'warning',
          /**
           * 点遮罩不关：这个框后面没有「取消」这个中间态 ——
           * 误点一下就当作用户选了「从列表移除」太危险了。
           */
          closeOnClickModal: false,
        },
      );
      action = 'confirm';
    } catch (err) {
      // confirm 的 reject 值是 'cancel'（点了取消按钮）或 'close'（右上角 ×）
      action = typeof err === 'string' ? err : 'close';
    }
  
    if (action === 'cancel') {
      await this.removeLocalItemFromList(bvid);
      return;
    }
    if (action !== 'confirm') return;
  
    /** 弹系统文件对话框（取消返回空串 —— 什么都不做，别当失败报错） */
    const picked = await electronApi.pickLocalVideo(filePath).catch(() => '');
    if (!picked) return;
  
    const res = await electronApi
      .relocateLocalVideo(bvid, picked)
      .catch((err) => ({ ok: false, error: this.uiStore.errMsg(err) }) as { ok: boolean; error?: string });
    if (!res.ok) {
      // 失败允许再试：把它从「已问过」里放出来
      this._missingPrompted = this._missingPrompted.filter((item) => item !== bvid);
      ElMessage.error(res.error || '重新定位失败');
      return;
    }
  
    ElMessage.success('已重新定位，正在播放');
    /**
     * 从「已问过」里放出来：这条以后要是**再**丢了（又挪了位置），
     * 还得能再问一次 —— 不放出来的话这次会话里就再也不会提示了。
     */
    this._missingPrompted = this._missingPrompted.filter((item) => item !== bvid);
    /** 列表里那一行（和视频管理页）都要重读：标题可能刚被补上，失效标也该消掉 */
    await this.uiStore.loadBrowseList();
    await this.playCandidate(bvid, { skipCache: true });
  },

  /**
   * 把一条本地视频从**正在播的那个列表**里移除
   *
   * 只删列表关系，不动 `videos` 那一行（路线与「视频管理 → ×」一致）。
   * 不知道在哪个列表就不动 —— 猜错列表删掉别的东西，比不删糟得多。
   */
  async removeLocalItemFromList(bvid: string): Promise<void> {
    const listId = this.videoListsStore.activeId;
    if (!listId) {
      ElMessage.warning('不知道该从哪个列表移除，请到视频管理里删掉这一条');
      return;
    }
    try {
      const ok = await this.videoListsStore.removeItem(listId, bvid);
      if (!ok) {
        ElMessage.warning('这一条已经不在列表里了');
        return;
      }
      await this.uiStore.loadBrowseList();
      ElMessage.success('已从列表移除');
    } catch (err) {
      ElMessage.error('移除失败：' + this.uiStore.errMsg(err));
    }
  },

  onVideoLoaded(): void {
    const v = this.videoEl();
    if (v) {
      v.volume = this.currentVolume / 100;
      // 关键修复：原来只在 isMuted 为真时写 true，解除静音后不会写回 false，
      // 导致「图标显示有声、实际没声」。这里始终跟随当前状态赋值。
      v.muted = this.isMuted;
      /**
       * 续播 / 切清晰度后的定位
       *
       * `seekAfterLoad` 是**跨源共享**的字段，必须校验它是不是为「当前这首歌」设的：
       * 否则「在 140 秒处切清晰度 -> 流还没加载完就切了歌」会把新歌
       * 直接定位到 140 秒；新歌若比 140 秒短就越过 duration，
       * 表现成「画面不动 / 直接到底」。
       */
      if (this.seekAfterLoad > 0 && this.seekAfterLoadFor === this.queueStore.currentKey) {
        const target = this.seekAfterLoad;
        this.seekAfterLoad = 0;
        this.seekAfterLoadFor = '';
        /**
         * 目标点已经越过片尾就**别定位**：`currentTime` 在 duration 未知（MSE 早期是
         * 0 / Infinity）或上一次是坏源时可能很大，硬定位会「一进去就播完」甚至画面不动。
         */
        const dur = v.duration;
        if (Number.isFinite(dur) && dur > 0 && target >= dur - 1) {
          console.warn('[video] 记录的进度已超过片长，忽略定位:', target, dur);
        } else {
          try {
            v.currentTime = target;
          } catch {
            /* 某些格式不支持 seek，忽略 */
          }
        }
      } else {
        // 不是给这首歌设的，直接丢掉，别让它污染下一首
        this.seekAfterLoad = 0;
        this.seekAfterLoadFor = '';
      }
      this._videoErrorCount = 0;
      // 新的源开始了：片尾看门狗与停滞看门狗的状态一起复位
      this._endStallHandled = false;
      this._stallSince = 0;
      this._stallRecoveries = 0;
      /**
       * 卡顿恢复链的两个计数器也要归零
       *
       * ⚠️ 归零点只有两处：`onEngineSwitch()`（换条）和这里（新流真正开始播）。
       * **不要**挪进 `onEngineStream()` —— 换备用源 / 降 durl 也会走那里，
       * 换源后计数器清零，就会**永远在第一个备用源上打转**，降级链走不下去。
       */
      this._stallUrlIndex = 0;
      this._stallQualityDrops = 0;
      this._progressPos = 0;
      this._lastProgressAt = Date.now();
      // 如果这次切进来的正是预热过的那首，对应槽位就作废了
      this.dropWarmIfCurrent();
      void v.play().catch(() => {});
      this.paused = false;
      // dash（MSE）成功出画：清掉失败计数
      if (this.dashSource) this.engine?.noteDashWorked();
      this.syncVideoQuality();
      this.systemStore.syncTrayState();
      // 记录当前播放信息，供下次续播
      void this.systemStore.persistPlaybackState();
      // 更新系统媒体控件（歌名/歌手/专辑/封面 + 播放状态）
      this.systemStore.updateMediaSession();
      this.systemStore.updateMediaPosition();
    }
  },

  /** 播放/暂停状态变化时同步给系统媒体控件 */
  onVideoPlayStateChange(): void {
    // this.paused 必须跟着 <video> 走：它原先只在切歌/清空那几处被赋值，
    // 播完一首或元素自己暂停时不会更新，于是图标和托盘仍显示「正在播放」，
    // 用户第一次点播放键只是把它翻成 true（pause 空操作），要点第二次才真的重播。
    const v = this.videoEl();
    if (v) this.paused = v.paused;
    /**
     * ★ 立刻同步定时器状态（不要等下一秒的 tick）
     *
     * 踩过：冻结判断只在每秒 tick 里做，于是**点暂停后倒计时还会多跑一秒**
     * —— 用户在 `xx:59.1` 暂停，下一次 tick 在 `xx:00.0` 才切成冻结，
     * 那一刻剩余时间已经从 59 掉到 58。
     * 在 `play` / `pause` 事件里直接同步，冻结就发生在事件那一刻。
     */
    this.sleepStore._sleepTimer?.syncNow();
    this.systemStore.syncTrayState();
    this.systemStore.updateMediaSession();
  },

  videoUpDate(): void {
    const v = this.videoEl();
    if (!v) return;
    this.currentTime = v.currentTime;
    this.duration = v.duration;
    // 记录「播放位置最后一次前进」的时间，片尾看门狗靠它判断是不是真的卡住了
    if (v.currentTime - this._progressPos > 0.05) {
      this._progressPos = v.currentTime;
      this._lastProgressAt = Date.now();
    }
    // 少数源在 loadeddata 时尺寸还没就绪，这里补一次（拿到就不再重复算）
    if (!this.videoQuality) this.syncVideoQuality();
    // 节流记录播放进度，供下次续播
    this.systemStore.persistPlaybackStateThrottled();
    // 同步系统媒体控件的进度条
    this.systemStore.updateMediaPositionThrottled();
    /**
     * 托盘菜单开着时把进度推过去（菜单里那条进度条要动）
     *
     * 只在菜单开着时推：平时推是白费 IPC（`timeupdate` 一秒好几次）。
     */
    if (this.windowStore.trayMenuOpen && Date.now() - this.systemStore._lastTraySyncAt > 300) {
      this.systemStore._lastTraySyncAt = Date.now();
      this.systemStore.syncTrayState();
    }
  },

  /**
   * 记录 `<video>` 实际解码出来的分辨率
   *
   * 纯粹用来在悬浮提示里交叉印证 playurl 报的清晰度
   * （平台偶尔会出现「报 720P、实际给 1080P 帧」这种情况，
   * 摆在提示里总比藏着好）。
   * 顺带在 playurl 没给清晰度时，按分辨率兜底一个标签。
   */
  syncVideoQuality(): void {
    const v = this.videoEl();
    if (!v || !v.videoWidth || !v.videoHeight) return;
    this.videoQualityPixels = `${v.videoWidth}×${v.videoHeight}`;
    if (!this.videoQuality) {
      this.videoQuality = qualityLabelOf(v.videoWidth, v.videoHeight);
    }
  },

  videoEnded(): void {
    if (this.queueStore.currentMode == this.queueStore.MODE.single) {
      // 单曲循环：真的把播放位置拨回 0 再播，只改 this.currentTime 是没用的
      // （<video> 播完就停在末尾，UI 还会一直显示「正在播放」）
      const v = this.videoEl();
      this.currentTime = 0;
      if (v) {
        try {
          v.currentTime = 0;
        } catch {
          /* 不支持 seek 就退化成重载 */
        }
        void v.play().catch(() => {});
      }
      /**
       * 看门狗状态必须一起复位
       *
       * 单曲循环走的是「拨回 0 再 play」，不会重新触发 `loadeddata`，
       * 也就是 `onVideoLoaded` 里那次复位不会发生 —— 而 `checkEndOfStream` 第一行就是
       * `if (this._endStallHandled) return`。不复位的话，第二圈开始片尾看门狗永久失效，
       * 「播到最后一秒卡住」会原样重现。
       */
      this._endStallHandled = false;
      this._progressPos = 0;
      this._lastProgressAt = Date.now();
      this._stallSince = 0;
      /**
       * 恢复链的两个计数器也复位：这一圈是**新的一次播放**，
       * 从主地址重新试起，降清晰度的额度也重新给满。
       * （跟 `onVideoLoaded` 里那处是同一个道理，只是单曲循环走不到那里。）
       */
      this._stallUrlIndex = 0;
      this._stallQualityDrops = 0;
      this.paused = false;
      this.systemStore.syncTrayState();
      this.systemStore.updateMediaSession();
    } else {
      this.next();
    }
  },

  /**
   * 把当前的 dash / durl 结果挂到 `<video>` 上
   *
   * dash 走 MSE：B 站 dash 的音视频是两条独立的流，只给一条会没声音，
   * 所以由 DashSession 把两轨都塞进同一个 MediaSource；
   * 编码不支持或播放失败就自动退回 durl（720P 混流）。
   */
  /**
   * 延迟显示换源缓冲提示
   *
   * 500ms 内已经能播（`readyState >= 3`）就完全不显示；
   * 否则亮出来，用户知道是在拉流而不是卡死。
   */
  scheduleBufferOverlay(): void {
    this.clearBufferOverlayTimer();
    this._bufferOverlayTimer = setTimeout(() => {
      this._bufferOverlayTimer = null;
      const el = this.videoEl();
      if (!el || el.readyState >= 3) return;
      /**
       * 已经缓冲出足够数据（≥1 秒）也别亮提示。
       *
       * 实测：预热过的切歌里有 200ms 左右「数据其实早就够了、只是解码器还没出画」的空窗，
       * 这时亮一个 99% 的圈纯粹是干扰 —— 够播了就该直接出画。
       */
      if (this.bufferedAhead() >= 1) return;
      this.buffering = true;
      this.syncBufferState();
      this.startBufferTicker();
    }, 500);
  },

  clearBufferOverlayTimer(): void {
    if (this._bufferOverlayTimer) {
      clearTimeout(this._bufferOverlayTimer);
      this._bufferOverlayTimer = null;
    }
  },

  /**
   * 取「当前播放源」的曲目
   *
   * 两个来源（B 站视频列表 / 音乐歌单）在播放层长得一模一样，
   * 差别只有两点：`songs` 从哪来、播到第几条记在哪张表。
   * 这里一次抹平，续播和首启两条路就不用各写一遍分支 ——
   * 否则「视频列表忘了写 last_index」这种 bug 只会出现在其中一条路上。
   */
  async loadPlaybackSource(): Promise<{
    name: string;
    songs: PlayItem[];
    lastIndex: number;
  } | null> {
    const videoListId = this.videoListsStore.activeId;
    if (videoListId) {
      const record = this.videoListsStore.find(videoListId);
      if (!record) return null;
      const songs = await this.videoListsStore.items(videoListId);
      return { name: record.name, songs, lastIndex: record.lastIndex };
    }
    const record = this.playlistsStore.current;
    if (!record) return null;
    return { name: record.name, songs: [...record.songs], lastIndex: record.lastIndex };
  },

  /**
   * 续播：恢复上次的歌单 / 歌曲 / 视频 / 播放进度
   *
   * @returns 是否成功恢复（false 表示调用方应走默认加载流程）
   */
  async tryResume(): Promise<boolean> {
    if (!this.settingStore.setting['player.resumeOnStart']) return false;
    const source = await this.loadPlaybackSource();
    if (!source || source.songs.length === 0) return false;
  
    /**
     * 回到该歌单上次播放的位置
     *
     * ⚠️ 下标本身会**被同步改变含义**（曲目增删后第 N 个位置可能是别的歌），
     * 所以主进程在 `syncPlaylist` / `syncVideoList` 里会把它**重算**成
     * 新列表里的位置 —— 这里只需要夹进范围。
     */
    const index = Math.min(Math.max(0, source.lastIndex), source.songs.length - 1);
    this.queueStore.songs = source.songs;
    this.queueStore.listName = source.name;
    this.queueStore.currentIndex = index;
  
    const songName = this.queueStore.getSongName(index);
    if (!songName) return false;
  
    const resumeTime = this.settingStore.setting['player.resumeTime'] || 0;
  
    try {
      // 「记住播放进度」一个开关管到底：歌 + 进度一起回来
      if (await this.restoreSongVideo(index, resumeTime)) {
        // 视频列表里说「首」很别扭（那是歌的量词），按来源换一个
        const unit = this.queueStore.fromVideoList ? '个视频' : '首';
        ElMessage.success(
          `已续播《${this.queueStore.listName}》第 ${index + 1} ${unit}` +
            (resumeTime > 3 ? `（${this.formatTime(resumeTime)}）` : ''),
        );
        return true;
      }
    } catch (err) {
      console.warn('[resume] 续播失败，回退到默认流程', err);
    }
    return false;
  },

  /**
   * 恢复某首歌对应的视频
   *
   * 直接走一次正常搜索把候选列表铺满 —— 这首歌上次就是「正在播」的那首，
   * `api:searchSong` 基本命中主进程的搜索结果缓存（数据库命中，秒回），
   * 所以没必要为了省这一趟请求让 `videoList` 只放一条占位
   * （那样续播后点开视频列表只有孤零零一行）。
   *
   * 播哪个视频以主进程记的 `selectedBvid`（`song_meta` 表）为准，
   * 而且直链一律交给 `api:resolveVideo` 现取：缓存里的地址可能早就过了签名时效。
   *
   * @param index  要恢复的那首歌的下标（歌名/歌手/缓存键都由它推出来）
   * @param seekTo 播放起点（秒），0 表示从头
   * @returns 是否成功
   */
  async restoreSongVideo(index: number, seekTo = 0): Promise<boolean> {
    const songName = this.queueStore.getSongName(index);
    const parts = this.queueStore.getSongParts(index);
    if (!songName || !parts) return false;
    /**
     * 没有「上次播的视频」记录 -> 交给默认流程
     *
     * 这一条以前查的是歌单里的 `videoCache`，现在换成主进程的
     * `song_meta.selected_bvid`。语义没变：**没有记录就说明这首歌从没播过**，
     * 此时应该走 `loadPlaylist` 那套（它会播搜索结果里的第一个），
     * 而不是在这里造一个「随便挑一个」的行为 —— 两条路径都得挑第一个的话，
     * 不如只留一条，省得以后改挑选规则时漏改一处。
     */
    let remembered: string | null = null;
    try {
      remembered = await electronApi.getSelectedBvid(songName);
    } catch (err) {
      console.warn('[resume] 读取上次播放的视频失败，回退到默认流程', err);
    }
    if (!remembered) return false;
    const cachedBvid = remembered;
  
    // 歌曲信息先切过来：搜索往返期间界面显示的也该是这首歌
    this.queueStore.currentKey = songName;
  
    try {
      const res = await this.uiStore.withNet(() => electronApi.searchSong(parts.song, parts.singer));
      const videos = (res.data as { result?: BiliVideo[] } | null)?.result ?? [];
      /**
       * 顺序已经是最终顺序 —— 主进程 `rankVideos` **在写库之前**排好的
       * （收藏整段置顶，其余按「歌手名命中 +100」再叠关键词加权）。
       * 渲染层**不再排序**，直接用返回的顺序。
       */
      this.queueStore.videoList = videos;
      this.queueStore.videoListKeyword = songName;
    } catch (err) {
      // 搜索失败不致命：至少还能把记住的那个视频播起来
      console.warn('[resume] 搜索失败，只按记住的视频续播', err);
      this.queueStore.videoList = [];
    }
  
    if (seekTo > 0) {
      this.seekAfterLoad = seekTo;
      this.seekAfterLoadFor = songName;
    }
  
    // 交给 playCandidate 解析并起播：它顺手回填标题/封面/清晰度，地址过期会自动重取
    await this.playCandidate(cachedBvid);
    if (this.currentBvid === cachedBvid && (this.videoUrl || this.dashSource)) {
      // 记住的视频不在这轮搜索结果里 -> 补成列表第一项，别让「正在播的」在列表里找不到
      if (this.queueStore.currentVideoIndex < 0) {
        this.queueStore.videoList = [
          { bvid: cachedBvid, title: this.queueStore.videoName, pic: this.videoPic || null },
          ...this.queueStore.videoList,
        ];
        this.queueStore.currentVideoIndex = 0;
      }
      return true;
    }
  
    // 记住的视频已经播不了（被删 / 换源）-> 退回搜索结果第一条
    const first = this.queueStore.videoList[0];
    if (!first || first.bvid === cachedBvid) return false;
    console.warn('[resume] 记住的视频已失效，改用搜索结果第一条', first.bvid);
    await this.playCandidate(first.bvid);
    return Boolean(this.videoUrl || this.dashSource);
  },

  // #region 播放引擎 ↔ 界面
  /**
   * 建播放引擎（`created` 里调一次）
   *
   * 这条线把「界面」和「播放」分开：
   *  - 引擎（`player/engine.ts`）只做「把队列第 N 条变成 `<video>` 上的流」，
   *    它不认识 Element Plus、不认识歌单、不认识托盘；
   *  - 下面那几个回调是它**唯一**的输出口 —— 状态怎么写、提示怎么弹，
   *    全部留在这一层。
   *
   * 以前这些东西混在一个 5000 行的组件里，`changeSong` 和 `changeVideo`
   * 各自 200 行、互相调用，还共享一套 `songs` 字段，于是「视频是不是歌」
   * 只能靠 `bvid` 猜。现在分派在引擎里、状态在组件里，边界是硬的。
   */
  createEngine(): void {
    this.engine = markRaw(
      new PlaybackEngine({
        videoEl: () => this.videoEl(),
        queue: () => this.queueStore.songs,
        index: () => this.queueStore.currentIndex,
        stepIndex: (direction) => this.stepIndex(direction),
        withNet: (fn) => this.uiStore.withNet(fn),
        isPaused: () => this.paused,
        qualityOverride: () => ({ qn: this.selectedQn, audioId: this.selectedAudioId }),
        onSwitch: (index, item) => this.onEngineSwitch(index, item),
        onStream: (stream) => this.onEngineStream(stream),
        onEmpty: (item, filtered) => this.onEngineEmpty(item, filtered),
        onError: (item, err) => this.onEngineError(item, err),
        onLocalMissing: (bvid, filePath) => {
          void this.onLocalFileMissing(bvid, filePath);
        },
        onDurationFilled: (bvid, seconds) => this.fillDuration(bvid, seconds),
        // 退 durl / 卡顿恢复前先把播放位置记下来（否则换源会从头开始）
        rememberSeek: () => this.rememberSeekPoint(),
      }),
    );
  },

  /** 播队列里的第 index 条（切歌 / 切视频的**唯一**入口） */
  async playAt(index: number, options?: LoadOptions): Promise<boolean> {
    return (await this.engine?.playAt(index, options)) ?? false;
  },

  /**
   * 在当前这一条里换到另一个 bvid（候选列表点选）
   *
   * 不换队列条目、不重搜列表 —— 只重新解析这一个视频的地址。
   * 以前这是 `changeVideo(bvid, keyword)`，那个 `keyword` 参数其实只为写回
   * 「候选关系」用，那套已经删了。
   */
  async playCandidate(bvid: string, options?: LoadOptions): Promise<void> {
    if (!bvid) return;
    this.rememberSeekPoint();
    await this.engine?.playCandidate(bvid, options);
  },

  /** 下一条 / 上一条的下标（顺序循环，随机模式查那张打乱表） */
  stepIndex(direction: 1 | -1): number {
    const length = this.queueStore.songs.length;
    if (length === 0) return 0;
    if (this.queueStore.currentMode === this.queueStore.MODE.random) {
      return direction === 1 ? this.getRandomNext() : this.getRandomPrev();
    }
    return (this.queueStore.currentIndex + direction + length) % length;
  },

  /**
   * 引擎要换条了（在发请求**之前**调用）
   *
   * 这里做的是「把上一条的痕迹擦干净，并把指着新条目的东西先拨过去」——
   * 搜索要一两秒，这段时间界面显示的必须是新条目，而不是上一条的残影。
   *
   * ⚠️ `videoListKeyword` **不能**在这里就跟成新条目：`videoError` 靠
   * 「它是否等于 currentKey」判断这个错误是不是当前这条的，提前改掉会让
   * 「上一条的视频报错」被算到新条目头上。
   */
  onEngineSwitch(index: number, item: PlayItem): void {
    this.queueStore.currentIndex = index;
    this.queueStore.currentKey = keyOf(item);
    /**
     * 换条 = 上一次「手动挑的清晰度 / 音质」作废
     *
     * 手动选择只针对当前这一条（README 里也是这么写的），不清的话上一首
     * 临时挑的 360P 会一直粘到后面每一条。清掉后交给主进程用设置里的默认上限。
     */
    this.selectedQn = null;
    this.selectedAudioId = null;
  
    /** 视频信息属于上一条，先清掉（模板会退回显示条目自己的标题） */
    this.queueStore.videoListKeyword = '';
    this.queueStore.videoName = '';
    this.videoPic = '';
    this.videoQuality = '';
    this.videoQualityDesc = '';
    this.audioQuality = '';
    this.audioQualityDesc = '';
    this.qualityOptions = null;
    this.videoQualityPixels = '';
    /**
     * 上一条的看门狗状态在这里就作废
     *
     * `playAt` 之后有一段「搜索 + 解析」的空窗（网络往返可能好几秒），
     * 期间旧 `<video>` 还挂着旧源、1 秒心跳照样在跑：如果旧视频正好卡在
     * 最后 2 秒，片尾看门狗会在空窗里命中并 `videoEnded() → next()` ——
     * 用户点一次下一首实际跳过两条。
     */
    this._endStallHandled = true;
    this._lastProgressAt = Date.now();
    this._stallSince = 0;
    this._stallRecoveries = 0;
    /**
     * ★ 卡顿恢复链的两个计数器也必须归零（踩过）
     *
     * 它们是「当前这条流试到第几个备用源 / 降了几档清晰度」，而换条意味着
     * **换了一条全新的流** —— 旧计数对新的流没有意义。带着旧计数进入恢复链：
     *
     * ```
     * _stallUrlIndex=1     → 直接跳到第 3 个备用源，跳过本条自己的第 2 个候选
     * _stallQualityDrops=3 → 已到 MAX_QUALITY_DROPS，自动降清晰度对本条永不生效
     * ```
     */
    this._stallUrlIndex = 0;
    this._stallQualityDrops = 0;
    // 进度也属于上一条：不复位的话 playCurrent 会把上一条的秒数写进 resumeTime
    this.currentTime = 0;
    this.duration = 0;
    this.systemStore.syncTrayState();
  },

  /**
   * 解析完成、引擎马上要挂源
   *
   * 这里做两件事：把解析结果写成界面状态，以及**挂源前的复位**。
   * 真正往 `<video>` 上挂 dash / durl 的动作在引擎里（`attach`）。
   */
  onEngineStream(stream: ResolvedStream): void {
    this.currentBvid = stream.bvid;
    /** 记下这条的「本地」身份，供 `<video>` 报错时分开处理（见 `videoError`） */
    this.currentBvidIsLocal = stream.isLocal;
    this.dashSource = stream.dash;
    this.videoUrl = stream.videoUrl;
    this.queueStore.videoName = stream.title;
    this.videoPic = normalizeImageUrl(stream.pic || null) || '';
    this.videoQuality = stream.quality;
    this.videoQualityDesc = stream.qualityDesc;
    this.audioQuality = stream.audioQuality;
    this.audioQualityDesc = stream.audioQualityDesc;
    this.qualityOptions = stream.options;
  
    if (stream.candidates.length > 0) {
      /**
       * 歌：候选列表就是这一轮搜索的结果（顺序已经由主进程排好）
       *
       * 正在播的那条在不在列表里都要标对 —— `selectedBvid` 是历史选择，
       * 完全可能不在本次搜索结果里，那时置 -1，列表不会把别的条目误标成「正在播放」。
       */
      this.queueStore.videoList = stream.candidates;
      this.queueStore.videoListKeyword = stream.key;
      this.queueStore.currentVideoIndex = stream.candidates.findIndex((v) => v.bvid === stream.bvid);
    } else {
      /**
       * 视频条目：**候选就是它自己**，没有「换一个版本」这回事
       *
       * `videoList` 清空而不是塞一条自己：MV 的「视频列表」面板靠它判断
       * 「有没有别的东西可选」，塞一条自己进去只会让人点开看到孤零零一行。
       */
      this.queueStore.videoList = [];
      this.queueStore.videoListKeyword = stream.key;
      this.queueStore.currentVideoIndex = -1;
    }
  
    /**
     * 换源 = 看门狗与缓冲提示重新计时
     *
     * `currentSrc` 一设上就非空，而 `_lastProgressAt` 若还停在上一首最后一次
     * 推进的时间（可能很久以前），新源起播超过 12 秒就会被误判成「停滞」，
     * 弹提示并把**正在加载**的那个请求用 `recover()` 顶掉。
     */
    this._lastProgressAt = Date.now();
    this._stallSince = 0;
    // 换了源就重新给这条流机会（上一轮可能已经判定放弃过）
    this._stallGivenUp = false;
    /**
     * 换源时**不要立刻**亮缓冲提示：搜索 / 地址都有缓存时常常 200~400ms
     * 就出画了，提示亮一下再灭反而像闪屏。延迟 500ms，真慢还是会显示。
     */
    this.bufferPercent = 0;
    this.bufferSeconds = 0;
    this.stopBufferTicker();
    this.buffering = false;
    this.scheduleBufferOverlay();
  },

  /** 没有可播的内容（搜索无结果 / 全被过滤规则挡掉） */
  onEngineEmpty(item: PlayItem, filtered: boolean): void {
    this.queueStore.videoList = [];
    this.queueStore.currentVideoIndex = -1;
    this.clearNowPlaying();
    const label = titleOf(item);
    /**
     * 提示要分两种情况说 —— 它们**解决办法完全不同**：
     *  - `filtered`：搜索成功了，只是被**过滤规则**全挡掉了。解决办法是去设置里
     *    放宽规则（过滤词、时长容差），说「网络有问题」会把用户引到错误方向。
     *  - 否则：搜索真的没结果，才谈网络 / 登录。
     */
    if (filtered) this.uiStore.notifyFilteredEmpty(label);
    else this.uiStore.notifySearchEmpty(label);
  },

  /** 解析失败（网络 / 风控 / 地址取不到） */
  onEngineError(item: PlayItem, err: unknown): void {
    // 解析失败必须把上一条的视频信息清掉，否则控制栏会继续显示上一条的
    // 标题 / 封面 / 清晰度 —— 看起来像「信息不切换」
    this.queueStore.videoName = '';
    this.videoPic = '';
    this.videoQuality = '';
    this.videoQualityDesc = '';
    this.audioQuality = '';
    this.audioQualityDesc = '';
    this.qualityOptions = null;
    this.videoQualityPixels = '';
    const label = titleOf(item);
    /**
     * 提示要区分「被限流」和「其它失败」—— 两者**解决办法完全不同**
     *
     * 主进程遇到 B 站的 HTTP 412（或「第 1 轮就返回 0 条」）会抛
     * `RateLimitError`，错误消息里已经写明「切歌太快」。那种情况说「网络有问题」
     * 会把用户引到完全错误的方向 —— 他需要的是**等一会儿**。
     */
    if (this.isRateLimitErr(err)) {
      /**
       * ⚠️ 文案**不能出现技术细节**（「限流」/「412」/「请求被拦」）——
       * 用户会把界面截图发出去。只说**用户能观察到的现象** + **该怎么办**。
       */
      ElNotification({
        title: '暂时搜不到结果',
        message:
          `《${label}》没搜到结果。这通常是切歌切得太频繁导致的，` +
          '过一两分钟再试就好；期间尽量别连续切歌。',
        type: 'warning',
        duration: 0,
      });
      return;
    }
    ElMessage.error(`《${label}》${this.uiStore.errMsg(err)}`);
  },

  /**
   * 主进程回传了更准的时长：更新列表那一行 + 回写库
   *
   * B 站搜索接口**有些结果压根不带 `duration`**，缓存里就存成 NULL，
   * 列表那一行显示空秒数。真正开始播放时一定拿得到（view 响应里有），
   * 所以补上并回写 —— 不然下次重开还是空的，每次都要再补一遍。
   */
  fillDuration(bvid: string, seconds: number): void {
    if (!bvid || !Number.isFinite(seconds) || seconds <= 0) return;
    const row = this.queueStore.videoList.find((item) => item.bvid === bvid);
    if (row) row.duration = seconds;
    // 队列里的视频条目也一起改（否则控制栏的时长/进度分母还是空的）
    for (const item of this.queueStore.songs) {
      if (isVideoItem(item) && item.bvid === bvid && !item.duration) item.duration = seconds;
    }
    // 空 cacheKey：视频条目没有「候选关系」，只写 `videos` 表那一行
    void electronApi.fillVideoDuration('', bvid, seconds).catch(() => {
      /* 补时长失败不影响播放 */
    });
  },

  // #endregion
  /**
   * 清掉「正在播放」的视频信息
   *
   * 切歌单 / 歌单被删光 / 从管理弹窗点播时都要清一遍。集中在一处，
   * 免得以后新增字段又忘了清（控制栏手动挑的 `selectedQn` / `selectedAudioId`
   * 就是这么漏掉过：换歌后还沿用上一首的档位）。
   */
  clearNowPlaying(): void {
    this.stopDashSession();
    // 真把上一首停下来：只清字段的话 <video> 会继续播旧流，
    // 界面显示新歌名、耳朵里还是上一首
    const v = this.videoEl();
    if (v) {
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch {
        /* 忽略 */
      }
    }
    this.videoUrl = '';
    this.dashSource = null;
    this.currentBvid = '';
    this.queueStore.videoName = '';
    this.videoPic = '';
    this.videoQuality = '';
    this.videoQualityDesc = '';
    this.audioQuality = '';
    this.audioQualityDesc = '';
    this.qualityOptions = null;
    this.videoQualityPixels = '';
    this.selectedQn = null;
    this.selectedAudioId = null;
    this.currentTime = 0;
    this.duration = 0;
    this.paused = true;
    // 失败计数属于上一首，留着会让新歌的第一次错误被当成第二次（直接跳歌）
    this._videoErrorCount = 0;
    // 任务栏进度也跟着清掉（没有在播的东西了）
    this.systemStore.updateTaskbarProgress();
    // 片尾/停滞看门狗的状态也属于上一首：换源时重新计时
    this._endStallHandled = false;
    this._stallSince = 0;
    this._stallRecoveries = 0;
    /** 恢复链的两个计数器同理：没有在播的流了，谈「试到第几个源」没有意义 */
    this._stallUrlIndex = 0;
    this._stallQualityDrops = 0;
    this._progressPos = 0;
    this._lastProgressAt = Date.now();
    /**
     * 缓冲 UI 也要一起清干净
     *
     * 踩过：这里只清视频元素，`buffering` / 百分比 / ticker 都留着 ——
     * 元素被 removeAttribute('src') + load() 之后 readyState = 0、buffered 为空，
     * `syncBufferState` 的「够播了」永远不成立，于是缓冲圈以 0% 永久挂在屏幕上，
     * 250ms 的 ticker 也一直空转。触发路径很常见：搜索失败、歌单删空、没搜到视频。
     */
    this.clearBufferOverlayTimer();
    this.stopBufferTicker();
    this.buffering = false;
    this.bufferPercent = 0;
    this.bufferSeconds = 0;
    // 预热结果（含隐藏的预热流）属于上一首的上下文，一起清掉
    this.clearAllWarm();
    this.systemStore.syncTrayState();
  },

  playCurrent(seekTo = 0): void {
    if (this.queueStore.songs.length === 0) return;
    // 续播时把起播点传给 changeSong，视频加载完成后会 seek 过去
    if (seekTo > 0) {
      this.seekAfterLoad = seekTo;
      this.seekAfterLoadFor = this.queueStore.getSongName(this.queueStore.currentIndex) ?? '';
    }
    void this.playAt(this.queueStore.currentIndex);
    this.resetRandomList();
    // 记录当前播放信息（歌单 / 下标 / 进度）
    void this.systemStore.persistPlaybackState();
    nextTick(() => {
      const v = this.videoEl();
      if (v) {
        v.volume = this.currentVolume / 100;
      }
    });
  },

  /*
   * `getSongName` / `getSongParts` / `getSong` 已经搬到 `base.ts`：
   * 它们只做「取第 index 条的标识 / 搜索词 / 结构化信息」，和播放流程无关。
   *
   * `matchScore` / `tagBonus` / `nameBonus` 三个打分函数已**移到主进程**：
   * 见 `@common/utils/videoRank`。它们现在由 `api:searchSong` 在写库前调用，
   * 好让 `videos.ord` 直接等于最终显示顺序。渲染层不再需要它们。
   */
  next(): void {
    if (!this.queueStore.songs || this.queueStore.songs.length === 0) return;
    /**
     * ★ **`netBusy` 时忽略切歌**（统一守卫，所有入口都受保护）
     *
     * 放在 `next()` / `prev()` **内部**而不是每个调用点：
     * 会调它们的有控制栏按钮、托盘菜单、系统媒体键、将来的快捷键 ——
     * 逐个补漏迟早会漏。放在这里，**任何**入口在请求在飞时都点不动。
     *
     * 为什么必须拦：切歌 = 重新搜索 + 解析地址（两个请求）。
     * 连点就是请求成倍叠加，B站直接 412 风控。
     */
    if (this.uiStore.netBusy) {
      this.uiStore.notifyNetBusy();
      return;
    }
    const index =
      this.queueStore.currentMode === this.queueStore.MODE.random
        ? this.getRandomNext()
        : (this.queueStore.currentIndex + 1) % this.queueStore.songs.length;
    void this.playAt(index);
  },

  prev(): void {
    if (!this.queueStore.songs || this.queueStore.songs.length === 0) return;
    /** ★ `netBusy` 时忽略切歌（统一守卫，理由见 `next()` 那段） */
    if (this.uiStore.netBusy) {
      this.uiStore.notifyNetBusy();
      return;
    }
    const index =
      this.queueStore.currentMode === this.queueStore.MODE.random
        ? this.getRandomPrev()
        : (this.queueStore.currentIndex - 1 + this.queueStore.songs.length) % this.queueStore.songs.length;
    void this.playAt(index);
  },

  toggleMode(): void {
    this.queueStore.currentMode = (this.queueStore.currentMode + 1) % 3;
    if (this.queueStore.currentMode === this.queueStore.MODE.random) this.resetRandomList();
    // 用户切模式 -> 写回主进程持久化
    this.settingStore.update({
      'player.loopMode': PLAY_LOOP_MODES[this.queueStore.currentMode] || 'listLoop',
    });
    this.systemStore.syncTrayState();
  },

  getRandomNext(): number {
    if (this.queueStore.randomList.length === 0) this.resetRandomList();
    let pos = this.queueStore.randomList.indexOf(this.queueStore.currentIndex);
    if (pos === -1) {
      this.queueStore.randomList.push(this.queueStore.currentIndex);
      pos = this.queueStore.randomList.length - 1;
    }
    return this.queueStore.randomList[(pos + 1) % this.queueStore.randomList.length];
  },

  getRandomPrev(): number {
    if (this.queueStore.randomList.length === 0) this.resetRandomList();
    let pos = this.queueStore.randomList.indexOf(this.queueStore.currentIndex);
    if (pos === -1) {
      this.queueStore.randomList.push(this.queueStore.currentIndex);
      pos = this.queueStore.randomList.length - 1;
    }
    return this.queueStore.randomList[
      (pos - 1 + this.queueStore.randomList.length) % this.queueStore.randomList.length
    ];
  },

  resetRandomList(): void {
    const indices = Array.from({ length: this.queueStore.songs.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    this.queueStore.randomList = indices;
    if (this.queueStore.songs.length > 0) {
      const pos = this.queueStore.randomList.indexOf(this.queueStore.currentIndex);
      if (pos === -1) this.queueStore.randomList.unshift(this.queueStore.currentIndex);
      else if (pos > 0) {
        this.queueStore.randomList.splice(pos, 1);
        this.queueStore.randomList.unshift(this.queueStore.currentIndex);
      }
    }
  },

  /**
   * 预热「上一首 / 下一首」
   *
   * 目的：**手动切歌也不要停滞感**。切歌那次卡顿来自两段：
   *   1. 搜索 + 播放地址解析（缓存未命中时 1~3 秒网络往返）
   *   2. MSE 起播（要拉到第一个分片才能出画）
   * 所以两个方向都提前做：
   *   - 歌一开始播就把两个方向的**接口结果**备好（很便宜，几 KB）；
   *   - 接口就绪后把它们的**开头几秒真的拉起来**（隐藏的 <video>，静音），
   *     这样切过去时同源媒体缓存里已有数据，出画几乎没有等待。
   *
   * 唯一要克制的是流量：预热的媒体流只拉 2.5 秒就停，而且**自己这边缓冲充足才做**
   * （`bufferSeconds >= 5`），网络紧张时优先保当前播放。
   */
  maybeWarm(): void {
    const v = this.videoEl();
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    if (v.currentTime > 2) void this.warmApi('next');
    // 再往后一点才做上一首，避免刚开播就两个请求一起打出去
    if (v.currentTime > 6) void this.warmApi('prev');
    // 接口备好了就把开头拉起来（近片尾时两个方向都要保证是热的）
    const nearEnd = d > 0 && d - v.currentTime <= PREFETCH_AHEAD_S;
    /**
     * OV 只**备地址**、不拉流
     *
     * 视频列表的「下一条」是确定的 bvid，预热只剩「提前解析一次地址」这一步；
     * 再额外起一个隐藏的 MSE 会话去拉分片，收益很小（省的是首帧那一两秒），
     * 代价却是同时对两条流占带宽 —— 而列表里大半条目用户不会看。
     * 用户明确要的就是这个折中：留着地址预热，别开流。
     */
    if (this.queueStore.fromVideoList) return;
    if (this.bufferSeconds >= 5 || nearEnd) {
      if (this._warm.next) this.warmMedia('next');
      if (this._warm.prev) this.warmMedia('prev');
    }
  },

  /** 预热用「下一首 / 上一首」下标：规则与 next()/prev() 完全一致 */
  indexForDir(dir: 'next' | 'prev'): number {
    const len = this.queueStore.songs.length;
    if (len === 0) return -1;
    if (this.queueStore.currentMode === this.queueStore.MODE.random) {
      if (this.queueStore.randomList.length === 0) this.resetRandomList();
      const pos = this.queueStore.randomList.indexOf(this.queueStore.currentIndex);
      if (pos === -1) return -1;
      return dir === 'next'
        ? this.queueStore.randomList[(pos + 1) % this.queueStore.randomList.length]
        : this.queueStore.randomList[(pos - 1 + this.queueStore.randomList.length) % this.queueStore.randomList.length];
    }
    return dir === 'next' ? (this.queueStore.currentIndex + 1) % len : (this.queueStore.currentIndex - 1 + len) % len;
  },

  /** 搜索 + 解析某个方向的下一首（结果放进槽位，供切歌时直接命中缓存） */
  async warmApi(dir: 'next' | 'prev'): Promise<void> {
    if (this._warming[dir]) return;
    // 已经彻底失败过：不再重试，等换歌 / 换歌单时由 clearWarm 重置
    if (this._warmFailed[dir]) return;
    /**
     * ★ **有别的请求在飞时不要凑热闹**（预热自己让路）
     *
     * 预热是「后台悄悄准备下一首」，用户并不着急 —— 而它同样要打两个请求
     * （搜索 + 解析）。如果主流程正在搜索/解析（`netBusy`），再叠上来
     * 就是在同一时刻往上堆请求，正是 B站 412 的成因。
     *
     * 所以这里**让路**：等主流程忙完，下一跳心跳（每秒一次）再试。
     *
     * ⚠️ 注意预热**不参与 `netBusy`**（不把它算进 `_netBusyCount`）：
     * 它是后台行为，用户什么都没点，不该因此看到按钮变灰。
     * 下面的 `electronApi` 调用因此**不套 `withNet`** —— 它有自己这套
     * `_warming` / `_warmTries` / `_warmRetryAt` 节流。
     */
    if (this.uiStore.netBusy) return;
    /**
     * 失败后的重试节流：心跳是每秒一次，光看 `_warmTries` 做不到「间隔 3 秒」——
     * 三次会在 3 秒内打完。所以还要看上次失败的时间戳。
     */
    if (this._warmTries[dir] > 0 && Date.now() - this._warmRetryAt[dir] < WARM_RETRY_DELAY_MS) {
      return;
    }
    const idx = this.indexForDir(dir);
    if (idx < 0) return;
    const songName = this.queueStore.getSongName(idx);
    const parts = this.queueStore.getSongParts(idx);
    if (!songName || !parts || songName === this.queueStore.currentKey) return;
    if (this._warm[dir]?.song === songName) return; // 已经是热的
    this._warming[dir] = true;
    try {
      /**
       * ⚠️ 预热**不套 `withNet`**（不参与 `netBusy`，理由见函数开头那段）——
       * 它是后台行为，用户什么都没点，不该因此看到按钮变灰。
       * 防叠加靠入口处的「有请求在飞就让路」+ 它自己的 `_warming` 标记。
       */
      const res = await electronApi.searchSong(parts.song, parts.singer);
      const videos = (res.data as { result?: BiliVideo[] } | null)?.result ?? [];
      const list = videos;
      /**
       * 与 `changeSong` 的挑选规则**逐字一致**，保证预热的就是待会儿真正要播的那个。
       *
       * 必须也问 `getSelectedBvid`：`changeSong` 现在优先用它，
       * 而搜索返回体里那份 `selectedBvid` 只是兜底。两边规则不一样的话，
       * 预热好的地址到了切歌时会被换掉（白预热，用户还是要等一次解析）。
       */
      const remembered = await electronApi.getSelectedBvid(songName);
      const bvid =
        remembered ||
        (res.data as { selectedBvid?: string } | null)?.selectedBvid ||
        list[0]?.bvid;
      if (!bvid) {
        /**
         * 搜不到视频 —— **必须记账，否则会每秒重试**
         *
         * 踩过：这里原来直接 `return`，而 `_warm[dir]` 是空的，所以
         * `_warm[dir]?.song === songName` 那个「已经是热的」判断永远不成立，
         * 而 `finally` 又把 `_warming` 复位了 —— 心跳每秒进来一次，
         * **每秒发一次真网络请求，永不停止**。
         *
         * 症状：控制台同一个关键词刷几十行「搜索结果为空」，
         * 界面变卡（尤其是「歌名-歌手」很长的缓存键，B 站必然搜不到）。
         *
         * 现在按「重试 3 次、间隔 3 秒」处理：没到上限就等下一轮心跳
         * （心跳本身是 1 秒一次，所以额外加一个 3 秒的节流由 `_warmTries` 的时间戳控制）。
         */
        this._warmTries[dir] += 1;
        // 记下这次失败的时刻：下一轮心跳要靠它判断「够 3 秒了没」
        this._warmRetryAt[dir] = Date.now();
        if (this._warmTries[dir] >= WARM_MAX_TRIES) {
          this._warmFailed[dir] = true;
          console.warn(
            `[prefetch] ${dir === 'next' ? '下一首' : '上一首'}《${songName}》预热失败 ` +
              `${WARM_MAX_TRIES} 次（搜不到视频），不再重试。` +
              (this.sessionStore.isLoggedIn ? '' : '（未登录，登录后可能就能找到了）'),
          );
          /**
           * 提示用户 —— 但**只在未登录时**弹，因为那才是他能采取行动的情况。
           *
           * 已登录还搜不到，多半是这首歌本身在 B 站没有对应视频（歌名太长、
           * 多歌手用「、」连起来那种），提示「请登录」是误导。
           *
           * ⚠️ 文案**不描述 B 站的返回机制**（别说「未登录时只返回部分结果」）——
           * 那是内部行为，写进用户可见的提示里没必要。
           */
          if (!this.sessionStore.isLoggedIn) {
            ElNotification({
              title: '有歌曲预热失败',
              message: `《${songName}》搜不到视频。登录后再试一次，通常就能找到了。`,
              type: 'warning',
              duration: 6000,
            });
          }
        } else {
          console.warn(
            `[prefetch] ${dir === 'next' ? '下一首' : '上一首'}《${songName}》搜不到视频，` +
              `第 ${this._warmTries[dir]}/${WARM_MAX_TRIES} 次（${WARM_RETRY_DELAY_MS / 1000}s 后再试）`,
          );
        }
        return;
      }
      const url = await electronApi.resolveVideoUrl(
        bvid,
        songName,
        false,
        this.engine?.isDashDisabled ?? false,
      );
      this._warm[dir] = {
        song: songName,
        bvid,
        videoUrl: url.videoUrl ?? null,
        dash: url.dash ?? null,
      };
      // 换了一首歌的预热结果 → 「热过了」的标记要跟着重置，否则它永远不会被真正拉起来
      this._warmed[dir] = false;
      console.log(`[prefetch] 已备好${dir === 'next' ? '下一首' : '上一首'}：${songName}`);
    } catch (err) {
      // 预热失败完全不影响正常切歌（该联网还是联网），静默记一笔
      console.warn(`[prefetch] 预热${dir}失败（忽略）:`, err);
    } finally {
      this._warming[dir] = false;
    }
  },

  /**
   * 把某个方向的开头几秒真的拉起来
   *
   * 用隐藏的静音 `<video>` + 同一个 dash 会话实现：这样**连接（DNS/TLS/HTTP2）是热的**，
   * 能进 HTTP 缓存的分片也已经在本地，切过去时不用从零开始拉。
   *
   * 刻意**不调用 `play()`**：
   *  - 播放会占用系统媒体控件（SMTC 面板可能被这个隐藏元素顶掉）；
   *  - MSE 的分片是 JS 自己灌进去的，`start()` 本身就会拉数据，不需要真的播。
   * 拉 2 秒就停，元素留着复用。
   */
  warmMedia(dir: 'next' | 'prev'): void {
    const info = this._warm[dir];
    if (!info || this._warmed[dir] || this._warmSession[dir] || this._warmTimer[dir]) return;
    const nearEnd = this.duration > 0 && this.duration - this.currentTime <= PREFETCH_AHEAD_S;
    // 自己这边都快不够播了就先不抢带宽（近片尾时例外：马上要切了）
    if (this.bufferSeconds < 5 && !nearEnd) return;
    const el = this.warmElement(dir);
    if (!el) return;
    try {
      if (info.dash && DashSession.isSupported(info.dash)) {
        const session = new DashSession(el);
        this._warmSession[dir] = session;
        session.start(info.dash).catch(() => this.stopWarmMedia(dir));
      } else if (info.videoUrl) {
        el.src = info.videoUrl;
      } else {
        return;
      }
    } catch (err) {
      console.warn(`[prefetch] 预热媒体${dir}失败（忽略）:`, err);
      this.stopWarmMedia(dir);
      return;
    }
    // 只要开头那一小段，别把整条片子下下来；拉过就标记「这个方向热了」，不再重复拉
    this._warmed[dir] = true;
    this._warmTimer[dir] = setTimeout(() => this.stopWarmMedia(dir), 2000);
  },

  /** 取（或创建）预热用的隐藏元素：移出可视区、静音，绝不参与界面 */
  warmElement(dir: 'next' | 'prev'): VideoElement | null {
    if (this._warmEl[dir]) return this._warmEl[dir];
    const el = document.createElement('video');
    el.muted = true;
    el.volume = 0;
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    el.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(el);
    this._warmEl[dir] = el as unknown as VideoElement;
    return this._warmEl[dir];
  },

  /** 停掉某个方向的预热播放（元素留着下次复用） */
  stopWarmMedia(dir: 'next' | 'prev'): void {
    if (this._warmTimer[dir]) {
      clearTimeout(this._warmTimer[dir]);
      this._warmTimer[dir] = null;
    }
    const session = this._warmSession[dir];
    if (session) {
      this._warmSession[dir] = null;
      try {
        session.stop();
      } catch {
        /* 忽略 */
      }
    }
    const el = this._warmEl[dir];
    if (el) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* 忽略 */
      }
    }
  },

  /** 丢掉某个方向的预热结果（切进那首歌了 / 歌单变了） */
  clearWarm(dir: 'next' | 'prev'): void {
    this.stopWarmMedia(dir);
    this._warm[dir] = null;
    // 结果作废 → 「热过了」的标记也一起清掉，下一首才有机会再预热
    this._warmed[dir] = false;
    /**
     * 失败计数与「已彻底失败」标记**一起清掉** —— 换了歌就该重新给机会。
     *
     * 不清的话：某一首歌搜不到导致该方向被永久封禁，
     * 后面所有歌的预热都不再发生（用户会感觉「切歌越来越慢」却找不到原因）。
     */
    this._warmTries[dir] = 0;
    this._warmFailed[dir] = false;
    this._warmRetryAt[dir] = 0;
  },

  /** 两个方向全部作废（换歌单 / 清空播放） */
  clearAllWarm(): void {
    this.clearWarm('next');
    this.clearWarm('prev');
  },

  /** 已经切进预热过的那首歌：对应槽位作废 */
  dropWarmIfCurrent(): void {
    if (this._warm.next?.song === this.queueStore.currentKey) this.clearWarm('next');
    if (this._warm.prev?.song === this.queueStore.currentKey) this.clearWarm('prev');
  },

  /**
   * （原来这里有个 `sortSearchedVideos()` —— **已删除**）
   *
   * 它曾是渲染层的第二套打分排序，后来被打分排序搬到主进程
   * （`@common/utils/videoRank` 的 `rankVideos`）之后就退化成了恒等函数
   * （`return videos`），只是留着兼容 5 个调用点。现在直接在每个调用点写
   * `videos` 本身，这个空壳一并删掉。
   *
   * ## 为什么必须搬去主进程
   *
   * 原来主进程按「收藏 + B 站顺序」写 `ord`，渲染层拿到后又按打分重排一遍 ——
   * 于是**界面顺序和库里顺序是两套**。「收藏再取消来提升顺序」这种依赖持久化
   * 顺序的用法一重新搜索就散（取消后 `favorites` 变 0、合并时不再保留位置，
   * 它就回到 B 站顺序了）。
   *
   * 现在 `rankVideos` 在**写库之前**执行，`videos.ord` 直接等于最终显示顺序，
   * 搜索返回的列表**已经是排好的** —— 渲染层不再有任何排序逻辑。
   */
  /**
   * 这个错误是不是「操作太频繁，暂时搜不到」
   *
   * ## 为什么只能按 message 判断（不能按类型）
   *
   * 主进程抛的 `RateLimitError` 经 IPC 传过来**只剩 message**
   * （Error 被序列化，`name` / 原型链 / 自定义字段全丢），
   * 所以渲染层拿不到那个类 —— 只能比 message。
   *
   * ## 为什么匹配的是一句**中性文案**
   *
   * 匹配 **主进程那份固定的中性文案**（`RATE_LIMIT_MESSAGE`）——
   * 它同时也是用户可能看到的那句，所以不能写「风控」「412」这类词
   * （用户会截图）。两边用**同一句话**比对，既准确又不带敏感信息。
   *
   * ⚠️ 改主进程那句文案时，这里要同步改 —— 所以两边都留了注释互相指向。
   */
  isRateLimitErr(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return msg.includes('暂时搜不到结果');
  },

  /**
   * 手动切换清晰度 / 音质
   *
   * 选择只作用于**当前这一首**（`selectedQn` / `selectedAudioId`，换歌时在
   * `changeSong` 里清掉），不改设置里的默认值 —— 默认值在设置界面里改。
   * 重新解析会换掉流地址，所以先把播放进度记下来。
   *
   * ## ★ **不传 `skipCache`**（这里改过一次）
   *
   * 原来传的是 `skipCache: true`（「我改了清晰度，快重新取」）。但那是**多余**的：
   * B站给的一条 dash 流里**本来就带全部候选档位**，我们库里存的
   * `playurl_result` 是**整个 playurl 响应**。所以换清晰度只需要
   * `extractDashStreams(缓存的 playurl, 新qn, 新audioId)` —— 从同一份响应里
   * 按新档位重新挑一条流，**根本不用联网**。
   *
   * 主进程那边（`api:resolveVideo`）的判断链已经覆盖了所有该联网的情况：
   *
   * ```
   * 地址有效 且 缓存里有目标档位 → 用缓存（不联网）      ← 换清晰度走这条
   * 地址**已过期**              → 自动重新解析（联网）  ← 日志会打「缓存地址已过期」
   * 缓存里没有那个档位          → 自动重新解析（联网）  ← needDashUpgrade
   * 登录态变了（解锁更高档）      → 自动重新解析（联网）  ← loginChanged
   * ```
   *
   * 也就是说：**该联网的时候它自己会联**。`skipCache` 只是把「地址明明还没过期」
   * 这条快路径也一起废掉，白打一次请求 —— 而每一次多余的请求都在推高被 412 的概率。
   */
  async switchQuality(kind: 'video' | 'audio', id: number): Promise<void> {
    if (kind === 'video') this.selectedQn = id;
    else this.selectedAudioId = id;
  
    const bvid = this.currentBvid;
    if (!bvid) return;
    /**
     * ★ 冷却 3 秒：刚改完清晰度/音质，两个下拉先禁用一会儿
     *
     * 放在**解析之前**（不是之后）：这样「解析期间 + 解析完成后 3 秒」
     * 连起来是禁用的，中间没有可连点的空窗。
     */
    this.uiStore.startQualityCooldown();
    const resumeAt = this.currentTime;
    if (resumeAt > 1) {
      this.seekAfterLoad = resumeAt;
      this.seekAfterLoadFor = this.queueStore.currentKey;
    }
    /** 不传 skipCache —— 见上面那段说明（该联网时主进程自己会联） */
    await this.playCandidate(bvid);
  },

  /**
   * dash（MSE）失败后退回 durl
   *
   * 注意不能在本地把 `videoUrl` 拿来用 —— 走 dash 时主进程回的
   * `videoUrl` 是 null（它没有额外去要 durl），所以必须重新解析一次。
   * 连续失败两次就认为这台机器上 dash 不可用，本会话不再尝试，
   * 免得每切一首歌都白跑一次 dash。
   */
  rememberSeekPoint(): void {
    // 位置优先取元素上的（切源瞬间 this.currentTime 可能还是上一帧的旧值）
    const v = this.videoEl();
    const at = v && Number.isFinite(v.currentTime) ? v.currentTime : this.currentTime;
    if (at > 1) {
      this.seekAfterLoad = at;
      // 标明是给这首歌设的：中途切歌时 onVideoLoaded 会把不匹配的定位丢掉
      this.seekAfterLoadFor = this.queueStore.currentKey;
    }
  },

  fallbackToDurl(): void {
    /**
     * 降级决策全在引擎里（连续失败计数、本会话是否放弃 dash、记进度）
     *
     * store 这边只把界面上的清晰度信息清掉：引擎重新解析后会通过
     * `onStream` 把新档位写回来。
     */
    this.dashSource = null;
    this.engine?.fallbackToDurl();
  },

  /**
   * 当前歌曲对应的视频封面（B 站缩略图）
   *
   * 优先用正在播放的那个视频的缩略图，其次用候选列表里那一条的缩略图。
   *
   * 这里删掉了最后那级「歌单 videoCache 里记住的封面」兜底：那个字段已经不存在，
   * 而它记录的封面本来就来自 `videoList` 的同一项（`changeVideo` 写进去的就是
   * `video?.pic`），所以列表里没有的时候它也不会有新东西 —— 属于查不到还会
   * 多一次 IPC 的兜底，直接去掉。
   */
  currentVideoCover(): string | null {
    // 正在播的那个视频的缩略图：主进程随播放地址一起回传，最可靠
    const own = normalizeImageUrl(this.videoPic || null);
    if (own) return own;
    const v =
      this.queueStore.videoList[this.queueStore.currentVideoIndex] ??
      this.queueStore.videoList.find((item) => item.bvid && item.title === this.queueStore.videoName);
    const pic = normalizeImageUrl(v?.pic ?? null);
    if (pic) return pic;
    return null;
  },

  /** 当前歌曲的封面：优先平台专辑图，退回视频缩略图 */
  currentCover(): string | null {
    const song = this.queueStore.getSong(this.queueStore.currentIndex);
    const own = normalizeImageUrl(song?.cover ?? null);
    if (own) return own;
    return this.currentVideoCover();
  }
};

export const usePlaybackStore = defineStore<
  'playback',
  PlaybackState,
  PlaybackGetterFns,
  PlaybackActions
>('playback', {
  state: playbackState,
  getters: playbackGetters as never,
  actions: playbackActions as PlaybackActions,
});

/** 组件侧需要标注 store 类型时用它 */
export type PlaybackStore = ReturnType<typeof usePlaybackStore>;
