<template>
  <div id="app">
    <!--
      壁纸模式下整条标题栏隐藏（用户要求）：那时候窗口就是一块桌面背景，
      所有操作走托盘菜单；退出壁纸模式再显示回来。
      用 class 而不是 v-if：组件不卸载，内部状态（音量拖动等）不会丢。
    -->
    <div class="titlebar" :class="{ 'wm-hidden': wallpaperEnabled || locked }">
      <!-- 左侧：歌单入口（点一下直接打开歌单管理弹窗，没有二级菜单） -->
      <div class="titlebar-left">
        <PlaylistPanel @manage="playlistManagerVisible = true" />
      </div>
      <!-- 中间：拖拽区 -->
      <div class="titlebar-drag"
        @mousedown="onTitlebarMouseDown"
        @dblclick="onTitlebarDblClick"
      ></div>
      <!-- 右侧：壁纸 / 头像 / 设置 / 窗口按钮 -->
      <div class="titlebar-right">
        <div class="titlebar-btn" @click="toggleWallpaper">
          {{ wallpaperEnabled ? '窗口模式' : '壁纸模式' }}
        </div>
        <div class="user-info" @click="handleLogoutConfirm">
          <img
            v-if="userFace"
            :src="userFace"
            class="user-avatar"
            referrerpolicy="no-referrer"
          />
          <span class="user-name">{{ userName || '未登录' }}</span>
        </div>
        <div class="win-btn" @click="settingsVisible = true" title="设置">
          <i class="iconfont icon-shezhi"></i>
        </div>
        <div class="win-btn" @click="aboutVisible = true" title="关于">
          <i class="iconfont icon-guanyu"></i>
        </div>
        <div
          class="win-btn"
          @click="winMinimize"
          title="最小化"
          v-if="!wallpaperEnabled"
        >
          <i class="iconfont icon-zuixiaohua"></i>
        </div>
        <div
          class="win-btn"
          @click="winMaximize"
          :title="isMaximized || isFullscreen ? '向下还原' : '最大化'"
          v-if="!wallpaperEnabled"
        >
          <i
            class="iconfont"
            :class="isMaximized || isFullscreen ? 'icon-xiangxiahuanyuan' : 'icon-chuangti-zuidahua'"
          ></i>
        </div>
        <div class="win-btn win-close" @click="winClose" title="关闭">
          <i class="iconfont icon-guanbi"></i>
        </div>
      </div>
    </div>

    <!-- src 不绑在模板上：durl 直接用 URL，dash 需要挂 MediaSource，
         统一由 applyVideoSource() 设置，免得两条路互相覆盖 -->
    <video
      id="biliVideo"
      ref="video"
      @loadeddata="onVideoLoaded"
      @timeupdate="videoUpDate"
      @ended="videoEnded"
      @error="videoError"
      @waiting="onVideoBuffering"
      @stalled="onVideoBuffering"
      @seeking="onVideoBuffering"
      @progress="syncBufferState"
      @playing="onVideoPlaying"
      @seeked="syncBufferState"
      @canplaythrough="syncBufferState"
      @play="onVideoPlayStateChange"
      @pause="onVideoPlayStateChange"
    ></video>

    <!--
      缓冲提示
      切换清晰度 / 切歌时 MSE 要重新拉流，这段没有任何反馈的话看起来就是「卡死了」。
      这里像视频平台那样给出百分比，明确是「在缓冲」而不是「出问题了」。
    -->
    <div v-if="buffering" class="buffer-overlay">
      <div class="buffer-ring-wrap">
        <svg class="buffer-ring" viewBox="0 0 36 36">
          <circle class="ring-bg" cx="18" cy="18" r="15.5" />
          <circle
            class="ring-fg"
            cx="18"
            cy="18"
            r="15.5"
            :stroke-dasharray="ringLength"
            :stroke-dashoffset="ringOffset"
          />
        </svg>
        <span class="buffer-percent">{{ bufferPercent }}%</span>
      </div>
      <div class="buffer-text">缓冲中…</div>
      <div class="buffer-sub">{{ bufferSubText }}</div>
    </div>
    <showList
      :listType="listType"
      :title="listType == 'list' ? listName : songName"
      :list="listType == 'list' ? songs : videoList"
      :currentIndex="listType == 'list' ? currentIndex : currentVideoIndex"
      :favorites="favoriteBvids"
      @showList="showList"
      @changeSong="changeSong"
      @changeVideo="changeVideo"
      @refresh="onListRefresh"
      @addVideo="addVideoVisible = true"
      @toggleFavorite="onToggleFavorite"
    ></showList>

    <!-- 「添加视频」：解析链接后加到这首歌的收藏里 -->
    <AddVideoDialog v-model="addVideoVisible" @confirm="onAddVideo" />
    <biliVideoControls
      :class="{ 'wm-hidden': wallpaperEnabled || locked }"
      :videoName="videoName || songName"
      :cover="currentCover() || ''"
      :subtitle="controlsSubtitle"
      :quality="videoQuality"
      :qualityDetail="videoQualityDetail"
      :audioQuality="audioQuality"
      :audioQualityDetail="audioQualityDetail"
      :qualityOptions="qualityOptions"
      :videoQn="currentVideoQn"
      :audioId="currentAudioId"
      @selectQuality="switchQuality"
      :currentMode="currentMode"
      :currentVolume="currentVolume"
      :isMuted="isMuted"
      :currentTime="currentTime"
      :duration="duration"
      :paused="paused"
      :listType="listType"
      @videoControl="videoControl"
      @changeTime="changeTime"
      @changeVolume="changeVolume"
      @toggleMute="toggleMute"
    ></biliVideoControls>

    <div
      class="fullscreen-btn"
      @click="toggleFullscreen"
      v-if="!wallpaperEnabled"
      :title="isFullscreen ? '退出全屏' : '全屏'"
    >
      <i
        class="iconfont"
        :class="isFullscreen ? 'icon-suoxiao' : 'icon-full-screen'"
      ></i>
    </div>

    <!--
      左下角：锁定按钮（和右下角全屏按钮同一套样式与逻辑）
      锁定后把标题栏、控制栏、歌单入口全隐藏，只留左下/右下这两个按钮；
      再点一次（或按 S）解锁。图标字体里没有锁，用内联 SVG。
    -->
    <div
      class="corner-btn lock-btn"
      :class="{ locked }"
      @click="toggleLock()"
      v-if="!wallpaperEnabled"
      :title="locked ? '解锁（S）' : '锁定（S）'"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="4.2" y="8.6" width="11.6" height="8" rx="2" />
        <path v-if="locked" d="M7 8.6V6.4a3 3 0 0 1 6 0v2.2" />
        <path v-else d="M7 8.6V6.4a3 3 0 0 1 5.9-.7" />
        <circle cx="10" cy="12.6" r="1" fill="currentColor" stroke="none" />
      </svg>
    </div>

    <!-- 歌单管理：新建 / 编辑 / 同步 / 曲目浏览全部在这一个弹窗里 -->
    <PlaylistManager
      v-model="playlistManagerVisible"
      :current-playlist-id="playlistsStore.currentId || ''"
      :current-index="currentIndex"
      @switch="onPlaylistSwitch"
      @play="onPlayFromManager"
      @reload="reloadCurrentPlaylistSongs"
    />

    <!-- 设置 -->
    <SettingsDialog v-model="settingsVisible" />

    <!-- 关于 -->
    <AboutDialog v-model="aboutVisible" />
  </div>
</template>

<script lang="ts">
import { defineComponent, markRaw } from 'vue';
import type { AppSetting } from '@common/types/app_setting';
import defaultSetting from '@common/defaultSetting';
import { PLAY_LOOP_MODES } from '@common/constants';
import biliVideoControls from './components/biliVideoControls.vue';
import showList from './components/showList.vue';
import AddVideoDialog from './components/AddVideoDialog.vue';
import PlaylistPanel from './components/PlaylistPanel.vue';
import PlaylistManager from './components/PlaylistManager.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import AboutDialog from './components/AboutDialog.vue';
import electronApi from './api/electron';
import { useSettingStore } from './stores/setting';
import { usePlaylistStore } from './stores/playlists';
import type { SyncResult, PlaylistSong as StructuredSong } from '@common/types/playlist';
import { toSearchKey } from '@common/types/playlist';
import { normalizeImageUrl } from './utils/image';
import { qualityLabelOf } from './utils/videoQuality';
import { DashSession } from './utils/dashPlayer';
import type { DashStreamsPayload, QualityOptionsPayload } from '@common/types/ipc';

/**
 * 起播需要缓冲到多少秒才算「够」
 *
 * 缓冲百分比就是以它为分母算的：起播时数字会从 0 很快涨到 100，
 * 用户能明确看到「在动」而不是「卡死」。
 */
const START_BUFFER_S = 5;
/** 播放中需要前方至少有多少秒余量才认为不会卡 */
const LEAD_S = 3;
/**
 * 距片尾多少秒开始预热下一首
 *
 * 预热只跑「搜索 + 播放地址解析」两个接口（主进程有缓存），一般 1~3 秒就完；
 * 留 15 秒足够，也不至于太早 —— 太早拿到的播放地址可能已经过期。
 */
const PREFETCH_AHEAD_S = 15;
/**
 * 播放位置停住多久算「这条流不行了」
 *
 * 取 12 秒：正常网络波动、CDN 换节点都不会连着 12 秒一个字节都不来；
 * 而用户手动点下一首的忍耐时间大概也就这么长。命中后先重解析一次，再不行才跳歌。
 */
const STALL_MS = 12000;
/**
 * 预热失败后的重试次数与间隔
 *
 * 心跳（`startEndWatch`）是**每秒**一次，所以光靠计数做不到「间隔 3 秒」——
 * 必须同时看时间戳，否则三次重试会在 3 秒内打完。
 *
 * 为什么是 3 次 / 3 秒：B 站搜索偶发返回空（风控、抖动），隔几秒再试往往就好了；
 * 但连着 3 次都空基本就是「这首歌在 B 站真的没有」或「未登录导致结果被裁」，
 * 再试只是白烧网络（用户反馈过「日志刷几十行、界面卡住」）。
 */
const WARM_MAX_TRIES = 3;
const WARM_RETRY_DELAY_MS = 3000;
import type {
  AppData,
  BiliVideo,
  ListType,
  VideoControlAction,
  VideoElement,
} from './types/app';
import type { ParsedVideoInfo } from '@common/types/ipc';

export default defineComponent({
  name: 'App',
  components: {
    biliVideoControls,
    showList,
    PlaylistPanel,
    PlaylistManager,
    SettingsDialog,
    AboutDialog,
    AddVideoDialog,
  },
  setup() {
    // Pinia 只做渲染进程的响应式副本；真正的持久化在主进程。
    // 注意 setup() 会在 options 的 data/computed/methods 之前执行，
    // 所以这里存下的 store 实例在 init() / mounted() 里可以直接用。
    const settingStore = useSettingStore();
    const playlistsStore = usePlaylistStore();
    return { settingStore, playlistsStore };
  },
  computed: {
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
    /*
     * `tagBonusConfig`（关键词加权表）也已搬走 —— 它唯一的用途是喂给
     * `tagBonus()` 打分，而打分现在在主进程（`@common/utils/videoRank`，
     * 直接读主进程的设置）。渲染层不再需要这份配置。
     */
    /** 当前播放歌曲的结构化信息（供详情弹窗右侧与 SMTC 使用） */
    currentSong(): StructuredSong | null {
      return this.songs[this.currentIndex] ?? null;
    },
    /** 播放控制栏副标题：歌曲名 - 歌手 · 专辑 */
    controlsSubtitle(): string {
      const song = this.currentSong;
      if (!song) return '';
      // 缺失的部分直接不出现，避免留下「- · 」这种空占位
      const head = [song.name, song.singer].filter((x): x is string => !!x).join(' - ');
      return [head, song.album].filter((x): x is string => !!x).join(' · ');
    },
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
    },
  },
  data(): AppData {
    return {
      songs: [],
      videoList: [],
      /**
       * `videoList` 属于哪一首歌（搜索键）
       *
       * `changeSong` 会立刻把 `songName` 切成新歌，但 `videoList` 要等搜索
       * 回来才换。用这个字段标明列表的归属，避免拿上一首的视频干新歌的事。
       */
      videoListKeyword: '',
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
      randomList: [],
      currentIndex: 0,
      currentVideoIndex: 0,
      MODE: { read: 0, single: 1, random: 2 },
      currentMode: 0,
      videoName: '',
      songName: '',
      listName: '',
      currentVolume: 70,
      currentTime: 0,
      duration: 0,
      isMuted: false,
      paused: false,
      listType: 'none',
      /** 歌单管理弹窗（新建/编辑/同步/曲目浏览都在里面） */
      playlistManagerVisible: false,
      isMaximized: false,
      isFullscreen: false,
      wallpaperEnabled: false,
      /** 界面锁定（只留左下锁定 + 右下全屏两个按钮），快捷键 S 或左下角按钮切换 */
      locked: false,
      /** 自绘托盘菜单是否正开着（开着时吞掉窗口内点击） */
      trayMenuOpen: false,
      isDragging: false,
      dragStarted: false,
      dragReady: false,
      dragStartX: 0,
      dragStartY: 0,
      dragOffsetX: 0,
      dragOffsetY: 0,
      _pendingMoveX: 0,
      _pendingMoveY: 0,
      _moveFramePending: false,
      _songToken: 0,
      isLoggedIn: false,
      userFace: '',
      userName: '',
      removeMaximizedListener: null,
      removeFullscreenListener: null,
      removeLoginListener: null,
      removeLogoutListener: null,
      removeTrayPlayControl: null,
      removeTrayPrev: null,
      removeTrayNext: null,
      removeTrayToggleMode: null,
      removeTrayShowPlaylist: null,
      removeTrayShowLogoutConfirm: null,
      /** 左键点托盘图标 -> 解锁 */
      removeTrayUnlock: null as null | (() => void),
      removeWallpaperState: null,
      removeWallpaperUnavailable: null,
      removeTraySeek: null,
      removeTrayVolume: null,
      removeTrayToggleMute: null,
      removeTrayMenuListener: null,
      lastNonZeroVolume: 0,
      /** 设置弹窗 */
      settingsVisible: false,
      /** 关于弹窗 */
      aboutVisible: false,
      /** 「添加视频」弹窗（视频列表右上角的加号） */
      addVideoVisible: false,
      /** 视频请求竞态令牌（切视频时防乱序覆盖） */
      _videoToken: 0,
      /** 同一个视频的连续失败次数，达到上限就跳过该曲，避免无限重试 */
      _videoErrorCount: 0,
      /** 当前 dash 会话（MSE），不参与渲染所以放实例字段 */
      _dashSession: null as DashSession | null,
      /** dash 连续失败次数，达到阈值就本会话不再尝试 */
      _dashFailures: 0,
      /** 本会话是否已判定 dash 不可用 */
      _dashDisabled: false,
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
      /** 当前这次锁定是「进全屏自动锁的」，退出全屏时要跟着解开（手工锁的不动） */
      _lockedByFullscreen: false,
    };
  },
  methods: {
    /**
     * 取 <video> 元素
     *
     * Vue 的 $refs 是无类型的，这里统一收口成一个小工具方法，
     * 避免每处都写 (this.$refs.video as HTMLVideoElement)。
     */
    videoEl(): VideoElement | null {
      return (this.$refs.video as VideoElement | undefined) ?? null;
    },
    /** 统一把 unknown 类型的 catch 错误转成可读文案 */
    errMsg(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
    },
    async init(): Promise<void> {
      // 用主进程下发（Pinia 中）的配置初始化本地播放状态
      const cfg = this.settingStore.setting;
      this.currentVolume = cfg['player.volume'];
      this.isMuted = cfg['player.isMute'];
      // 记录初始非零音量，保证「静音 -> 解除」能恢复到本次会话的实际音量
      this.lastNonZeroVolume = cfg['player.volume'] > 0 ? cfg['player.volume'] : defaultSetting['player.volume'];
      this.currentMode = this.loopModeToIndex(cfg['player.loopMode']);

      this.isMaximized = await electronApi.winIsMaximized();
      this.isFullscreen = await electronApi.winIsFullscreen();
      this.loadUserInfo();
      this.syncTrayState();
      // 接上 Windows 系统媒体控件（SMTC）：媒体键 + 系统音量弹窗里的媒体信息
      this.setupMediaSessionActions();
      this.updateMediaSession();

      // 加载歌单集合（旧版单歌单文件已由主进程迁移进集合）
      try {
        await this.playlistsStore.load();
      } catch (err) {
        this.$message.error('加载歌单失败：' + this.errMsg(err));
      }

      // 后台做启动同步，不阻塞续播
      void this.runStartupSync();
      // 按歌单的定时同步策略装心跳（记下指纹，免得后续无关的配置广播重建它）
      this._syncKey = `${this.playlistsStore.hasIntervalSync}|${this.playlistsStore.minSyncInterval}`;
      this.setupSyncTimer();

      // 优先续播；没有可续播内容时退回「当前歌单的第一首」
      const resumed = await this.tryResume();
      if (!resumed) await this.loadPlaylist();
    },
    /** 启动时按设置自动同步歌单（失败只提示，不打断启动） */
    async runStartupSync(): Promise<void> {
      try {
        const results = await this.playlistsStore.syncOnStartupIfNeeded();
        await this.reportSyncResults(results, '自动同步');
      } catch (err) {
        console.warn('[sync] 启动同步失败', err);
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
          this.$message.success(
            `${label}完成 ${okList.length} 个` + (detail ? `（${detail}）` : '，无变化'),
          );
        }
      }
      for (const r of failed) {
        this.$message.warning(`${r.name} ${label}失败：${r.error ?? '未知错误'}`);
      }
      // 曲目列表变了：重载当前播放列表，保证播放的不是过期数据
      if (changed.length > 0 && this.songs.length > 0) {
        await this.reloadCurrentPlaylistSongs();
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
      if (!this.playlistsStore.hasIntervalSync) return;
      // 兜底 5 分钟，避免配置成极小值导致疯狂请求
      const interval = Math.max(5 * 60 * 1000, this.playlistsStore.minSyncInterval || 0);
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
    /** 定时心跳：只同步到点的歌单 */
    async runIntervalSync(): Promise<void> {
      // 已有同步在跑就跳过这一轮，避免请求叠加
      if (this.playlistsStore.isSyncing) return;
      const dueIds = this.playlistsStore.getDueSyncIds();
      if (dueIds.length === 0) return;
      try {
        const results = await this.playlistsStore.sync(dueIds);
        // 无变化时静默，避免每次心跳都弹提示
        await this.reportSyncResults(results, '定时同步', true);
      } catch (err) {
        console.warn('[sync] 定时同步失败', err);
      }
    },
    /** 把 store 里当前歌单的曲目同步到本地播放列表（保留当前下标，越界则归零） */
    async reloadCurrentPlaylistSongs(): Promise<void> {
      const record = this.playlistsStore.current;
      if (!record) return;
      const keepIndex = this.currentIndex;
      this.songs = [...record.songs];
      this.listName = record.name;
      // 曲目变了，随机播放的下标表必须跟着重建：
      // 否则同步后曲目变少，随机列表里还留着越界下标，「下一首」会拿到 null 静默不动
      this.resetRandomList();
      // 预热槽位按下标算，曲目一变就全部作废
      this.clearAllWarm();
      if (this.songs.length === 0) return;
      if (keepIndex >= this.songs.length) {
        this.currentIndex = 0;
        await this.playCurrent();
      }
    },
    /**
     * 续播：恢复上次的歌单 / 歌曲 / 视频 / 播放进度
     *
     * @returns 是否成功恢复（false 表示调用方应走默认加载流程）
     */
    async tryResume(): Promise<boolean> {
      if (!this.settingStore.setting['player.resumeOnStart']) return false;
      const record = this.playlistsStore.current;
      if (!record || record.songs.length === 0) return false;

      const index = Math.min(Math.max(0, record.lastIndex), record.songs.length - 1);
      this.songs = [...record.songs];
      this.listName = record.name;
      this.currentIndex = index;

      const songName = this.getSongName(index);
      if (!songName) return false;

      const resumeTime = this.settingStore.setting['player.resumeTime'] || 0;

      try {
        // 「记住播放进度」一个开关管到底：歌 + 进度一起回来
        if (await this.restoreSongVideo(songName, resumeTime)) {
          this.$message.success(
            `已续播《${this.listName}》第 ${index + 1} 首` +
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
     * @param seekTo 播放起点（秒），0 表示从头
     * @returns 是否成功
     */
    async restoreSongVideo(songName: string, seekTo = 0): Promise<boolean> {
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
      this.songName = songName;

      try {
        const res = await electronApi.searchSong(songName);
        const videos = (res.data as { result?: BiliVideo[] } | null)?.result ?? [];
        /**
         * 顺序已经是最终顺序：主进程合并时就按「收藏在前、其余保持搜索顺序」
         * 排好了，这里只做打分排序（`sortSearchedVideos` 会把收藏那一段原样保留）。
         */
        this.videoList = this.sortSearchedVideos(videos);
        this.videoListKeyword = songName;
      } catch (err) {
        // 搜索失败不致命：至少还能把记住的那个视频播起来
        console.warn('[resume] 搜索失败，只按记住的视频续播', err);
        this.videoList = [];
      }

      if (seekTo > 0) {
        this.seekAfterLoad = seekTo;
        this.seekAfterLoadFor = songName;
      }

      // 交给 changeVideo 解析并起播：它顺手回填标题/封面/清晰度，地址过期会自动重取
      await this.changeVideo(cachedBvid, songName);
      if (this.currentBvid === cachedBvid && (this.videoUrl || this.dashSource)) {
        // 记住的视频不在这轮搜索结果里 -> 补成列表第一项，别让「正在播的」在列表里找不到
        if (this.currentVideoIndex < 0) {
          this.videoList = [
            { bvid: cachedBvid, title: this.videoName, pic: this.videoPic || null },
            ...this.videoList,
          ];
          this.currentVideoIndex = 0;
        }
        return true;
      }

      // 记住的视频已经播不了（被删 / 换源）-> 退回搜索结果第一条
      const first = this.videoList[0];
      if (!first || first.bvid === cachedBvid) return false;
      console.warn('[resume] 记住的视频已失效，改用搜索结果第一条', first.bvid);
      await this.changeVideo(first.bvid, songName);
      return Boolean(this.videoUrl || this.dashSource);
    },
    /** 循环模式：字符串枚举 -> 数字下标（供 biliVideoControls 使用） */
    loopModeToIndex(mode: AppSetting['player.loopMode']): number {
      const idx = PLAY_LOOP_MODES.indexOf(mode);
      return idx >= 0 ? idx : this.MODE.read;
    },
    async loadUserInfo(): Promise<void> {
      try {
        const info = await electronApi.getUserInfo();
        this.userFace = info.face;
        this.userName = info.name;
        this.isLoggedIn = true;
        electronApi.setLoggedIn(true);
      } catch (err) {
        /**
         * 拉取失败 ≠ 没登录
         *
         * 主进程把两者分开了：`未登录` 是 nav 明确说的，`NAV_FAILED` 是这次请求没问到。
         * 后者（网络抖动、风控）不能把界面切成未登录 —— 否则托盘菜单会显示「登录」、
         * 解析视频还会按未登录档位取流并写进缓存，表现就是「明明登录着却每次都重新解析」。
         */
        if (this.errMsg(err) === 'NAV_FAILED') {
          console.warn('[auth] 登录态查询失败（网络问题），保持原状态');
          return;
        }
        this.isLoggedIn = false;
        this.userFace = '';
        this.userName = '';
        electronApi.setLoggedIn(false);
      }
    },
    /**
     * 登录成功后的收尾
     *
     * 1. 刷头像/昵称；
     * 2. **用新的登录态重新解析当前视频的播放地址** ——
     *    未登录时平台只会给低清晰度（实测 360P 档），登录后同一个 bvid 能给到 720P+。
     *    不主动重取的话，得等切到下一首（甚至重启）才看得到变化，
     *    表现就是「登录了跟没登录一样」。
     */
    async onLoggedIn(): Promise<void> {
      await this.loadUserInfo();
      const bvid = this.currentBvid;
      if (!bvid) return;
      // 重新解析会换 URL，视频会重新加载，先把进度记下来
      const resumeAt = this.currentTime;
      if (resumeAt > 3) {
        this.seekAfterLoad = resumeAt;
        this.seekAfterLoadFor = this.songName;
      }
      this.$message.success('登录成功，正在用更高清晰度重新加载当前视频');
      await this.changeVideo(bvid, this.videoListKeyword || this.songName, { skipCache: true });
    },
    handleLogoutConfirm(): void {
      if (!this.isLoggedIn) {
        this.startLogin();
        return;
      }
      this.$confirm('确定要退出登录吗?', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      })
        .then(() => {
          this.doLogout();
        })
        .catch(() => {});
    },
    async doLogout(): Promise<void> {
      this.userFace = '';
      this.userName = '';
      this.isLoggedIn = false;
      electronApi.setLoggedIn(false);
      await electronApi.executeLogout();
    },
    async toggleWallpaper(): Promise<void> {
      this.wallpaperEnabled = await electronApi.wallpaperToggle();
    },
    async startLogin(): Promise<void> {
      await electronApi.startLogin();
    },
    /**
     * 加载当前歌单的曲目
     *
     * 多歌单之后，曲目来源是 playlists store 的「当前歌单」，
     * 不再直接读旧版单歌单文件（那个文件已由主进程迁移进集合）。
     */
    async loadPlaylist(): Promise<void> {
      const record = this.playlistsStore.current;
      if (record && record.songs.length > 0) {
        this.listName = record.name;
        this.songs = [...record.songs];
        // 回到该歌单上次播放的位置
        const savedIndex = record.lastIndex;
        this.currentIndex =
          savedIndex >= 0 && savedIndex < this.songs.length ? savedIndex : 0;
        // 兼顾「播放进度」：走这条兜底路径时（没有已缓存的视频可精确还原）
        // 也要把上次的秒数带上，否则换歌单/首启场景会丢掉进度
        const cfg = this.settingStore.setting;
        const resumeTime =
          cfg['player.resumeOnStart'] ? Number(cfg['player.resumeTime']) || 0 : 0;
        void this.playCurrent(resumeTime > 3 ? resumeTime : 0);
        return;
      }
      // 没有任何歌单：直接打开歌单管理，让用户在里面新建
      this.playlistManagerVisible = true;
    },
    /** 从歌单管理弹窗里点某首歌播放
     *
     * 弹窗内部已负责把该歌单设为当前，这里只需加载曲目并起播。
     */
    async onPlayFromManager(index: number): Promise<void> {
      const record = this.playlistsStore.current;
      if (!record || record.songs.length === 0) return;
      this.songs = [...record.songs];
      this.listName = record.name;
      this.currentIndex = Math.min(Math.max(0, index), this.songs.length - 1);
      this.seekAfterLoad = 0;
      this.seekAfterLoadFor = '';
      this.videoList = [];
      this.videoListKeyword = '';
      this.clearNowPlaying();
      this.songName = '';
      void this.playCurrent();
    },
    /** 从歌单面板切换歌单 */
    async onPlaylistSwitch(id: string | null): Promise<void> {
      if (!id) {
        // 歌单被删光了
        this.songs = [];
        this.videoList = [];
        this.videoListKeyword = '';
        this.listName = '';
        this.currentIndex = 0;
        this.currentVideoIndex = 0;
        this.songName = '';
        this.clearNowPlaying();
        this.playlistManagerVisible = true;
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
      this.currentIndex =
        record.lastIndex >= 0 && record.lastIndex < this.songs.length ? record.lastIndex : 0;
      this.videoList = [];
      this.videoListKeyword = '';
      this.currentVideoIndex = 0;
      this.clearNowPlaying();
      this.songName = '';
      this.currentTime = 0;
      this.seekAfterLoad = 0;
      this.seekAfterLoadFor = '';
      await this.settingStore.update({
        'player.resumeTime': 0,
      });

      if (this.songs.length === 0) {
        this.$message.warning(`《${record.name}》还没有曲目，可以先「同步」一下`);
        return;
      }
      this.$message.success(`已切换到《${record.name}》（${this.songs.length} 首）`);
      void this.playCurrent();
    },
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
      this.videoName = '';
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
      this.updateTaskbarProgress();
      // 片尾/停滞看门狗的状态也属于上一首：换源时重新计时
      this._endStallHandled = false;
      this._stallSince = 0;
      this._stallRecoveries = 0;
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
      this.syncTrayState();
    },
    playCurrent(seekTo = 0): void {
      if (this.songs.length === 0) return;
      // 续播时把起播点传给 changeSong，视频加载完成后会 seek 过去
      if (seekTo > 0) {
        this.seekAfterLoad = seekTo;
        this.seekAfterLoadFor = this.getSongName(this.currentIndex) ?? '';
      }
      this.changeSong(this.currentIndex);
      this.resetRandomList();
      // 记录当前播放信息（歌单 / 下标 / 进度）
      void this.persistPlaybackState();
      this.$nextTick(() => {
        const v = this.videoEl();
        if (v) {
          v.volume = this.currentVolume / 100;
        }
      });
    },
    winMinimize(): void {
      electronApi.winMinimize();
    },
    winMaximize(): void {
      if (this.isFullscreen) this.toggleFullscreen();
      else electronApi.winMaximize();
    },
    winClose(): void {
      electronApi.winClose();
    },
    onTitlebarMouseDown(e: MouseEvent): void {
      if (e.button !== 0 || this.wallpaperEnabled) return;
      this.isDragging = true;
      this.dragStarted = false;
      this.dragReady = false;
      this.dragStartX = e.screenX;
      this.dragStartY = e.screenY;
    },
    onTitlebarDblClick(e: MouseEvent): void {
      if (e.button !== 0 || this.wallpaperEnabled) return;
      this.isDragging = false;
      electronApi.winMaximize();
    },
    onDocMouseMove(e: MouseEvent): void {
      if (!this.isDragging) return;
      if (!this.dragStarted) {
        const dx = Math.abs(e.screenX - this.dragStartX);
        const dy = Math.abs(e.screenY - this.dragStartY);
        if (dx < 5 && dy < 5) return;
        this.dragStarted = true;
        this.dragReady = false;
        electronApi.winStartDrag().then((info) => {
          if (info) {
            this.dragOffsetX = info.offsetX;
            this.dragOffsetY = info.offsetY;
            this.dragReady = true;
          }
        });
        return;
      }
      if (!this.dragReady) return;
      this._pendingMoveX = e.screenX - this.dragOffsetX;
      this._pendingMoveY = e.screenY - this.dragOffsetY;
      if (!this._moveFramePending) {
        this._moveFramePending = true;
        requestAnimationFrame(() => {
          this._moveFramePending = false;
          electronApi.winMoveWindow(this._pendingMoveX, this._pendingMoveY);
        });
      }
    },
    onDocMouseUp(e: MouseEvent): void {
      if (!this.isDragging) return;
      this.isDragging = false;
      if (this.dragStarted && this.dragReady) {
        electronApi.winGetScreenWorkArea().then((workArea) => {
          if (workArea && e.screenY <= workArea.y + 8 && !this.isMaximized) {
            electronApi.winMaximize();
          }
        });
      }
    },
    async toggleFullscreen(): Promise<void> {
      this.isFullscreen = await electronApi.winToggleFullscreen();
      this.$message.info(
        this.isFullscreen
          ? '进入全屏,按esc或F键可以退出全屏'
          : '退出全屏,按F键可以再次进入全屏',
      );
    },
    /**
     * 锁定 / 解锁
     *
     * 锁定 = 把标题栏、控制栏、歌单入口全藏起来（`.wm-hidden`），窗口只剩画面，
     * 只留左下（锁定）和右下（全屏）两个按钮 —— 那俩是唯一的解锁入口，不能一起藏。
     * 快捷键 S 走同一个方法。
     *
     * 提示文案照全屏那条抄（同样的语气与「按 X 可以…」结构）。
     */
    toggleLock(force?: boolean): void {
      const next = typeof force === 'boolean' ? force : !this.locked;
      if (next === this.locked) return;
      this.locked = next;
      // 手工解锁之后就别再让「退出全屏」把它又改回去
      if (!next) this._lockedByFullscreen = false;
      this.$message.info(
        next ? '已锁定,按S键或点左下角按钮可以解锁' : '已解锁,按S键可以再次锁定',
      );
    },
    /**
     * 有没有弹窗开着
     *
     * 弹窗是模态的（遮罩挡住整窗），这时按 S 锁定会在弹窗底下藏界面，
     * 所以快捷键在这种情况下直接不响应 —— 锁定按钮本来也点不到。
     */
    anyDialogOpen(): boolean {
      return (
        this.listType !== 'none' ||
        this.playlistManagerVisible ||
        this.settingsVisible ||
        this.aboutVisible ||
        this.addVideoVisible
      );
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
      const video = this.videoList[this.currentVideoIndex];
      console.warn(
        `[video] 播放停滞 ${STALL_MS}ms（t=${v.currentTime.toFixed(1)} duration=${d} readyState=${v.readyState} 第 ${this._stallRecoveries} 次恢复）`,
      );

      if (this._stallRecoveries === 1) {
        this.$message.warning(
          noDuration ? '这条视频没能加载出来，正在重新解析…' : '缓冲停住了，正在重新解析这条视频的地址…',
        );
        /**
         * 重新解析的是**同一个视频**，所以要把当前位置记下来接着播
         *
         * 换 `src` 会把播放位置清零，不记的话就是「重新解析成功后从头开始」——
         * 用户正听到一半，突然回到 0:00。
         */
        this.rememberSeekPoint();
        /**
         * dash（MSE）卡住时**优先退回 durl**
         *
         * 重新解析同一个 dash 地址往往还是卡在同一个环节（分片拉不动 / MSE 没数据），
         * 白等 12 秒再跳歌。durl 是单文件直链，能立刻绕开这一层 —— 用户要的是"能看"。
         */
        if (this.dashSource) {
          this.fallbackToDurl();
          return;
        }
        if (video && this.videoListKeyword === this.songName) {
          void this.changeVideo(video.bvid, this.videoListKeyword, { skipCache: true });
        } else {
          void this.videoError();
        }
        return;
      }

      this._stallRecoveries = 0;
      const label = `《${this.songName || '当前歌曲'}》`;
      if (this.songs.length > 1) {
        this.$message.warning(`${label}这条视频拉不动，已跳过`);
        this.next();
        return;
      }
      /**
       * 单曲歌单没有「下一首」可跳
       *
       * 原来这里只把计数归零、照样弹提示 —— 于是每 12 秒刷一次同样的告警，
       * 永远不恢复也不停。改成只提示一次并**放弃这条流**，别再空转。
       */
      if (!this._stallGivenUp) {
        this._stallGivenUp = true;
        this.$message.warning(`${label}这条视频一直拉不动，可以换个视频源试试`);
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
      if (this.bufferSeconds >= 5 || nearEnd) {
        if (this._warm.next) this.warmMedia('next');
        if (this._warm.prev) this.warmMedia('prev');
      }
    },
    /** 预热用「下一首 / 上一首」下标：规则与 next()/prev() 完全一致 */
    indexForDir(dir: 'next' | 'prev'): number {
      const len = this.songs.length;
      if (len === 0) return -1;
      if (this.currentMode === this.MODE.random) {
        if (this.randomList.length === 0) this.resetRandomList();
        const pos = this.randomList.indexOf(this.currentIndex);
        if (pos === -1) return -1;
        return dir === 'next'
          ? this.randomList[(pos + 1) % this.randomList.length]
          : this.randomList[(pos - 1 + this.randomList.length) % this.randomList.length];
      }
      return dir === 'next' ? (this.currentIndex + 1) % len : (this.currentIndex - 1 + len) % len;
    },
    /** 搜索 + 解析某个方向的下一首（结果放进槽位，供切歌时直接命中缓存） */
    async warmApi(dir: 'next' | 'prev'): Promise<void> {
      if (this._warming[dir]) return;
      // 已经彻底失败过：不再重试，等换歌 / 换歌单时由 clearWarm 重置
      if (this._warmFailed[dir]) return;
      /**
       * 失败后的重试节流：心跳是每秒一次，光看 `_warmTries` 做不到「间隔 3 秒」——
       * 三次会在 3 秒内打完。所以还要看上次失败的时间戳。
       */
      if (this._warmTries[dir] > 0 && Date.now() - this._warmRetryAt[dir] < WARM_RETRY_DELAY_MS) {
        return;
      }
      const idx = this.indexForDir(dir);
      if (idx < 0) return;
      const songName = this.getSongName(idx);
      if (!songName || songName === this.songName) return;
      if (this._warm[dir]?.song === songName) return; // 已经是热的
      this._warming[dir] = true;
      try {
        const res = await electronApi.searchSong(songName);
        const videos = (res.data as { result?: BiliVideo[] } | null)?.result ?? [];
        const list = this.sortSearchedVideos(videos);
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
           * 界面变卡（尤其是「歌名-歌手」很长的搜索键，B 站必然搜不到）。
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
                (this.isLoggedIn ? '' : '（未登录时 B 站只返回部分结果，登录后可能就能找到了）'),
            );
            /**
             * 提示用户 —— 但**只在未登录时**弹，因为那才是他能采取行动的情况。
             *
             * 已登录还搜不到，多半是这首歌本身在 B 站没有对应视频（歌名太长、
             * 多歌手用「、」连起来那种），提示「请登录」是误导。
             */
            if (!this.isLoggedIn) {
              this.$notify({
                title: '有歌曲预热失败',
                message: `《${songName}》搜不到视频。未登录时 B 站只返回部分结果，登录后可能就能找到了。`,
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
          this._dashDisabled,
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
      if (this._warm.next?.song === this.songName) this.clearWarm('next');
      if (this._warm.prev?.song === this.songName) this.clearWarm('prev');
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
     * 修复要点：原来是无条件 `changeVideo(..., true)` 重试，没有计数上限，
     * 一旦解析始终失败就是死循环。这里加失败计数：
     *  - 先跳过缓存重试一次（原意图）
     *  - 仍失败则跳到下一首，并提示用户
     */
    async videoError(): Promise<void> {
      // 切歌时 this.songName 立刻变成新歌，但 videoList 还是上一首的；
      // 这段窗口里旧视频元素报错不能算在新歌头上（否则会拿旧 bvid 重试，
      // 甚至把旧视频永久记到新歌名下），直接忽略。
      if (this.videoListKeyword !== this.songName) return;

      /**
       * dash（MSE）出错时先退回 durl，别直接判成「视频加载失败」。
       *
       * MSE 的失败面比单文件播放宽得多（编码不支持、某个分片拉取失败、
       * buffer quota 超限……），这些都不代表视频本身坏了。
       * 退回 720P 混流至少能正常看，比跳歌好得多。
       */
      if (this.dashSource) {
        this._videoErrorCount = 0;
        this.$message.warning('高清（dash）流播放失败，已自动切回 720P');
        this.fallbackToDurl();
        return;
      }

      this._videoErrorCount += 1;
      const video = this.videoList[this.currentVideoIndex];
      if (this._videoErrorCount === 1 && video) {
        /**
         * 第一次失败：跳过缓存重新解析该视频
         *
         * 必须先把当前位置记下来：这是**同一个视频**重新解析地址（缓存过期 / 直链失效），
         * 换 `src` 会把播放位置清零 —— 不记的话用户听到的就是「重新解析后从头开始」。
         */
        this.rememberSeekPoint();
        await this.changeVideo(video.bvid, this.videoListKeyword, { skipCache: true });
        return;
      }
      this._videoErrorCount = 0;
      this.$message.warning(`《${this.songName || '当前歌曲'}》视频加载失败，已跳过`);
      if (this.songs.length > 1) this.next();
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
        if (this.seekAfterLoad > 0 && this.seekAfterLoadFor === this.songName) {
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
        this._progressPos = 0;
        this._lastProgressAt = Date.now();
        // 如果这次切进来的正是预热过的那首，对应槽位就作废了
        this.dropWarmIfCurrent();
        void v.play().catch(() => {});
        this.paused = false;
        // dash（MSE）成功出画：清掉失败计数
        if (this.dashSource) this._dashFailures = 0;
        this.syncVideoQuality();
        this.syncTrayState();
        // 记录当前播放信息，供下次续播
        void this.persistPlaybackState();
        // 更新系统媒体控件（歌名/歌手/专辑/封面 + 播放状态）
        this.updateMediaSession();
        this.updateMediaPosition();
      }
    },
    /** 播放/暂停状态变化时同步给系统媒体控件 */
    onVideoPlayStateChange(): void {
      // this.paused 必须跟着 <video> 走：它原先只在切歌/清空那几处被赋值，
      // 播完一首或元素自己暂停时不会更新，于是图标和托盘仍显示「正在播放」，
      // 用户第一次点播放键只是把它翻成 true（pause 空操作），要点第二次才真的重播。
      const v = this.videoEl();
      if (v) this.paused = v.paused;
      this.syncTrayState();
      this.updateMediaSession();
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
      this.persistPlaybackStateThrottled();
      // 同步系统媒体控件的进度条
      this.updateMediaPositionThrottled();
      /**
       * 托盘菜单开着时把进度推过去（菜单里那条进度条要动）
       *
       * 只在菜单开着时推：平时推是白费 IPC（`timeupdate` 一秒好几次）。
       */
      if (this.trayMenuOpen && Date.now() - this._lastTraySyncAt > 300) {
        this._lastTraySyncAt = Date.now();
        this.syncTrayState();
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
      if (this.currentMode == this.MODE.single) {
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
        this.paused = false;
        this.syncTrayState();
        this.updateMediaSession();
      } else {
        this.next();
      }
    },
    videoControl(event: VideoControlAction): void {
      switch (event) {
        case 'list':
        case 'vList':
          this.showList(event);
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
    showList(event: ListType): void {
      this.listType = this.listType == event ? 'none' : event;
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
      this.syncTrayState();
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
      this.syncTrayState();
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
        this.$message.success(`音量: ${restore}`);
      } else {
        this.changeVolume(0);
        this.$message.success('已静音');
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
    handleKeydown(e: KeyboardEvent): void {
      if (e.target instanceof HTMLElement) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      }
      if (this.wallpaperEnabled) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.playControl();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.changeVolume(Math.min(100, this.currentVolume + 5));
          this.$message.success(`当前音量:${this.currentVolume}`);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.changeVolume(Math.max(0, this.currentVolume - 5));
          this.$message.success(`当前音量:${this.currentVolume}`);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (this.duration) {
            this.changeTime(Math.min(this.duration, this.currentTime + 5));
            this.$message.success(
              `${this.formatTime(this.currentTime)}/${this.formatTime(this.duration)}`,
            );
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.changeTime(Math.max(0, this.currentTime - 5));
          this.$message.success(
            `${this.formatTime(this.currentTime)}/${this.formatTime(this.duration)}`,
          );
          break;
        case 'KeyF':
          e.preventDefault();
          this.toggleFullscreen();
          break;
        case 'KeyS':
          // 锁定 / 解锁；输入框里打字不受影响（上面挡掉了 INPUT/TEXTAREA），
          // 弹窗开着时也不响应（模态遮罩下按 S 会在弹窗背后藏界面）
          if (this.anyDialogOpen()) break;
          e.preventDefault();
          this.toggleLock();
          break;
        case 'Escape':
          e.preventDefault();
          if (this.isFullscreen) this.toggleFullscreen();
          break;
      }
    },
    /**
     * 把搜索结果按「像不像这首原曲」排序
     *
     * ⚠️ **已废弃，保留仅为兼容调用点** —— 打分排序搬到主进程了
     * （`@common/utils/videoRank` 的 `sortByRelevance`），并且**在写库之前**执行，
     * 所以 `videos.ord` 直接等于最终显示顺序，搜索返回的列表**已经是排好的**。
     *
     * 为什么必须搬走：原来主进程按「收藏 + B 站顺序」写 `ord`，渲染层拿到后又按打分
     * 重排一遍，于是界面顺序和库里顺序是两套 ——「收藏再取消来提升顺序」这种
     * 依赖持久化顺序的用法一重新搜索就散（取消后 `favorites` 变 0，
     * 合并时不再保留它的位置，它就回到 B 站顺序了）。
     *
     * 这里保留成恒等函数（而不是删掉），是因为调用点分布在续播 / 预热 / 重试等
     * 好几处，逐个删容易漏；恒等之后行为立刻正确，且渲染层不再有第二套顺序。
     * 两处各写一份打分早晚会漂移，这也是它被抽成共享模块的原因。
     */
    sortSearchedVideos(videos: BiliVideo[]): BiliVideo[] {
      return videos;
    },
    async changeSong(index: number): Promise<void> {
      const songName = this.getSongName(index);
      if (!songName) return;
      const token = ++this._songToken;
      /**
       * 换歌 = 上一次「手动挑的清晰度 / 音质」作废
       *
       * 控制栏角标上的手动选择只针对**当前这一首**（README 里也是这么写的），
       * 所以换歌时必须清掉，否则上一首临时挑的档位会一直粘到后面每一首 ——
       * 表现就是「我上一首挑了 360P，下一首还是 360P」。
       * 清掉后交给主进程用设置里的默认上限。
       */
      this.selectedQn = null;
      this.selectedAudioId = null;

      // 先把「只依赖本地歌单」的信息立刻切过去。
      //
      // 歌曲名、专辑封面、歌单高亮全都能就地取到，不需要网络；
      // 原来它们排在 `await searchSong()` 后面，于是要等一次搜索往返
      // （缓存未命中时是 1~3 秒的真网络请求，失败就一直不回来）——
      // 表现就是「切了歌，播放器里的歌曲图片和名称还是上一首的」。
      this.currentIndex = index;
      this.songName = songName;
      /**
       * 视频信息属于上一首，先清掉：
       *
       * - `videoListKeyword` **不能**在这里就跟成新歌：`videoError` 靠
       *   「`videoListKeyword` 是否等于 `songName`」判断这个错误是不是当前这首歌的，
       *   提前改掉会让「上一首的视频报错」被算到新歌头上。
       *   换清晰度 / 退 durl 需要关键字时统一用 `this.songName`（它就是搜索键）。
       * - 标题回退成歌名（见模板的 `videoName || songName`），等搜索回来再换成真标题。
       */
      this.videoListKeyword = '';
      this.videoName = '';
      this.videoPic = '';
      this.videoQuality = '';
      this.videoQualityDesc = '';
      this.audioQuality = '';
      this.audioQualityDesc = '';
      this.qualityOptions = null;
      this.videoQualityPixels = '';
      /**
       * 上一首的看门狗状态要在这里就作废
       *
       * `changeSong` 之后有一段「搜索 + 解析」的空窗（网络往返可能好几秒），
       * 期间旧 `<video>` 还挂着旧源、1 秒心跳照样在跑：如果旧视频正好卡在最后 2 秒
       * （就是「缓冲到底但没触发 ended」那个已知场景），片尾看门狗会在空窗里命中并
       * `videoEnded() → next()` —— 用户点一次下一首实际跳过两首。
       */
      this._endStallHandled = true;
      this._lastProgressAt = Date.now();
      this._stallSince = 0;
      this._stallRecoveries = 0;
      // 进度也属于上一首：不复位的话 playCurrent 会把上一首的秒数写进 resumeTime，
      // 键盘 / SMTC 拖进度还会拿它去定位新歌
      this.currentTime = 0;
      this.duration = 0;

      /**
       * `selectedBvid`（「这首歌上次播的是哪个视频」）不在这里写。
       *
       * 它由 `api:resolveVideo` 在**每次真正切到某个视频时**落库（一行 upsert）。
       * 换 SQLite 之前之所以要攒到「切歌 / 退出」才写，是因为旧实现是 JSON 文件：
       * 每写一次都要把整份候选列表 stringify 再 rename，切视频那么频繁根本受不了。
       * 现在按主键更新一行，成本和一次 setItem 差不多，所以**每次切视频直接写**，
       * 语义反而更准（不必再担心「切了视频但没切歌就退出」会丢）。
       *
       * 预热（`warmApi`）走的是同一个 `resolveVideoUrl`，而它挑的 bvid 与 `changeSong`
       * 逐字一致，所以它写进去的也是「这首歌该播的那个」，不会写错。
       */

      try {
        const res = await electronApi.searchSong(songName);
        if (token !== this._songToken) return;
        // searchSong 的 data 形状由搜索接口决定，这里收敛成 BiliVideo
        const videos = (res.data as { result?: BiliVideo[] } | null)?.result ?? [];
        /**
         * 顺序已经是最终顺序：主进程合并时就按「收藏在前、其余保持搜索顺序」排好了，
         * 这里只做打分排序（`sortSearchedVideos` 会把收藏那一段原样保留在最前面）。
         * 原来那层 `applyFavoriteOrder` 已经删掉 —— 它和主进程各排一次，必然对不上。
         */
        let list = this.sortSearchedVideos(videos);

        /**
         * 一首都没搜到 -> 重试几次（最多 3 次）
         *
         * 空结果现在已经**不会写进缓存**了（见 `api:searchSong`），所以重试一定是真联网。
         * 之所以还要重试：单次搜索为空往往只是偶发（网络抖动、风控、接口抽风），
         * B 站搜索本身很稳，连着 3 次都搜不到才值得怀疑是环境问题。
         *
         * 每次都用 `skipCache`，避免上一次的空结果又被读出来。
         */
        if (list.length === 0) {
          const MAX_RETRY = 3;
          for (let attempt = 1; attempt <= MAX_RETRY && list.length === 0; attempt++) {
            if (token !== this._songToken) return;
            console.warn(
              `[search] 《${songName}》搜索结果为空，第 ${attempt}/${MAX_RETRY} 次重试`,
            );
            const retry = await electronApi.searchSong(songName, true);
            if (token !== this._songToken) return;
            const retryVideos = (retry.data as { result?: BiliVideo[] } | null)?.result ?? [];
            list = this.sortSearchedVideos(retryVideos);
            if (list.length > 0) {
              console.log(`[search] 《${songName}》第 ${attempt} 次重试成功，找到 ${list.length} 个视频`);
              res.data = retry.data as never;
              break;
            }
            // 还有下一次的话，稍等一下再试 —— 连着打三次反而更容易被风控
            if (attempt < MAX_RETRY) await new Promise((r) => setTimeout(r, 800));
          }
        }

        this.videoList = list;
        this.videoListKeyword = songName;
        if (this.videoList.length > 0) {
          /**
           * 播哪个视频：**优先「上次这首歌播的那个」**
           *
           * 以前读的是搜索返回体里的 `selectedBvid`，那是个 bug 的来源 ——
           * 它由 `api:resolveVideo` 写回，而那个写回要等「真的联网重新解析」才发生
           * （缓存命中时不写）。于是切回上一首歌时读到的往往是**很久以前**那次
           * 解析留下的 bvid，而不是上次真正在播的那个。
           *
           * 现在 `selected_bvid` 由 `api:resolveVideo` 在**每次切到某个视频时**写库
           * （一行 upsert），所以这里读到的就是「上次真正在播的那个」。
           * 搜索返回体里那份仍然兜底读一次 —— 主进程写库后立即返回的新结果会带上它，
           * 少一次 IPC 往返。
           */
          const remembered = await electronApi.getSelectedBvid(songName);
          if (token !== this._songToken) return;
          const selectedBvid =
            remembered ||
            (res.data as { selectedBvid?: string } | null)?.selectedBvid ||
            this.videoList[0].bvid;
          await this.changeVideo(selectedBvid, songName);
        } else {
          // 重试完还是没有：把上一首的播放状态彻底停掉，别出现「新歌名 + 旧视频在播」
          this.clearNowPlaying();
          this.notifySearchEmpty(songName);
        }
      } catch (err) {
        if (token !== this._songToken) return;
        // 搜索失败：列表清空 + 停掉上一首，别让「视频列表」里还挂着上一首的候选
        this.videoList = [];
        this.currentVideoIndex = -1;
        this.clearNowPlaying();
        this.$message.error(`《${songName}》${this.errMsg(err)}`);
      }
    },
    /**
     * 搜索彻底失败（重试 3 次仍没有结果）时的提示
     *
     * 分两种情况说，因为**解决办法完全不同**：
     *  - 未登录：B 站对未登录用户只放出一部分搜索结果，提示去登录；
     *  - 已登录：连着 3 次都搜不到，基本不是 B 站的问题了（它没那么拉），
     *    更可能是本地网络 / 代理 / 风控，让用户检查网络。
     *
     * 用 `$notify`（右上角浮层）而不是 `$message`（一闪而过的 toast）：
     * 这两句话都带操作指引，用户需要时间读，而且要点右上角头像去登录。
     */
    notifySearchEmpty(songName: string): void {
      if (!this.isLoggedIn) {
        this.$notify({
          title: `《${songName}》没有找到视频`,
          message:
            '未登录时 B 站只会返回部分搜索结果。点右上角头像登录后再试，通常就能找到了。',
          type: 'warning',
          duration: 8000,
        });
        return;
      }
      this.$notify({
        title: `《${songName}》搜索失败`,
        message:
          '已经重试了 3 次都没有结果。请检查一下网络连接（或代理 / VPN）是否正常，稍后再试。',
        type: 'error',
        duration: 8000,
      });
    },
    /**
     * 切换到某个视频
     *
     * 加了竞态保护：快速切歌/切视频时，先发出的请求可能后返回，
     * 没有令牌就会被旧结果覆盖 videoUrl（原实现缺这个保护）。
     */
    async changeVideo(
      bvid: string,
      keyword: string,
      opts: {
        skipCache?: boolean;
        noDash?: boolean;
        qn?: number;
        audioId?: number;
      } = {},
    ): Promise<void> {
      const token = ++this._videoToken;
      try {
        const res = await electronApi.resolveVideoUrl(
          bvid,
          keyword,
          opts.skipCache ?? false,
          opts.noDash || this._dashDisabled,
          // 本次会话里手动选过的优先；没选过就交给主进程用设置里的默认值
          opts.qn ?? this.selectedQn ?? undefined,
          opts.audioId ?? this.selectedAudioId ?? undefined,
        );
        if (token !== this._videoToken) return; // 已有更新的请求，丢弃本次结果
        /**
         * 主进程解析失败时**不抛异常**，而是回 `{ videoUrl: null, error }`。
         * 原来这里完全不看 `error`：既没有提示，`applyVideoSource()` 又因为
         * videoUrl 为空什么都不做（旧视频接着播），可 currentBvid / 标题 / 清晰度
         * 已经被换成这个失败视频的空值，还会把它记成「上次播的视频」，
         * 下次续播继续踩同一个坑。所以失败必须在这里拦住。
         */
        if (res.error && !res.videoUrl && !res.dash) {
          // AUTH_FAILED 是主进程约定的「登录失效」错误码，给一句能照做的提示
          if (res.error === 'AUTH_FAILED') {
            throw new Error('B 站登录已失效，请重新登录后再试');
          }
          throw new Error(res.error);
        }
        this.currentBvid = bvid;
        // dash 双轨（1080P+，需要 MSE 合成）与 durl（720P 混流）二选一
        this.dashSource = res.dash ?? null;
        this.videoUrl = res.videoUrl ?? '';
        this.applyVideoSource();
        const idx = this.videoList.findIndex((item) => item.bvid === bvid);
        // 找不到就置 -1：selectedBvid 是历史选择，可能不在本次搜索结果里。
        // 置 -1 后列表不会把别的条目误标成「正在播放」。
        this.currentVideoIndex = idx;
        const video = this.videoList[idx];
        // 标题/封面以主进程回传的为准（它解析的就是正在播的这个视频），
        // 列表项只作兜底：缓存里可能还留着旧版本写坏的、缺 title/pic 的条目。
        this.videoName = res.title || video?.title || '';
        this.videoPic =
          normalizeImageUrl(res.pic ?? null) ||
          normalizeImageUrl(video?.pic ?? null) ||
          '';
        // 清晰度 / 音质只认 playurl 响应自己报的档位（不是请求参数里的 qn）
        this.videoQuality = res.quality ?? '';
        this.videoQualityDesc = res.qualityDesc ?? '';
        this.audioQuality = res.audioQuality ?? '';
        this.audioQualityDesc = res.audioQualityDesc ?? '';
        // 这个视频此刻可选的档位（切换菜单用）
        this.qualityOptions = res.options ?? null;
        /**
         * 这里**不再**调 `recordCurrentVideo`。
         *
         * 原来它把「这首歌选了哪个视频」写进歌单的 `videoCache`。那个字段已经删掉，
         * 而它要记的东西现在由主进程负责：`api:resolveVideo` 会写
         * `song_meta.selected_bvid`（本次改造放宽了它的写回条件，缓存命中也写）。
         * 渲染层再写一遍就是同一件事做两次，而且两处判据不一致时必然漂移。
         */
      } catch (err) {
        if (token !== this._videoToken) return;
        /**
         * 解析失败时**必须把上一首的视频信息清掉**。
         *
         * 前面那几行是「解析成功才赋值」，失败时如果不清，控制栏会继续显示
         * 上一首的视频标题 / 封面 / 清晰度 —— 用户切歌后看到的就是
         * 「歌名换了，可标题封面还是上一条」，看起来像「信息不切换」。
         * 清掉之后模板会退回显示歌名（`videoName || songName`），一眼能看出是解析失败了。
         */
        this.videoName = '';
        this.videoPic = '';
        this.videoQuality = '';
        this.videoQualityDesc = '';
        this.audioQuality = '';
        this.audioQualityDesc = '';
        this.qualityOptions = null;
        this.videoQualityPixels = '';
        this.$message.error(this.errMsg(err));
      }
    },
    /**
     * 手动切换清晰度 / 音质
     *
     * 选择只作用于**当前这一首**（`selectedQn` / `selectedAudioId`，换歌时在
     * `changeSong` 里清掉），不改设置里的默认值 —— 默认值在设置界面里改。
     * 重新解析会换掉流地址，所以先把播放进度记下来。
     */
    async switchQuality(kind: 'video' | 'audio', id: number): Promise<void> {
      if (kind === 'video') this.selectedQn = id;
      else this.selectedAudioId = id;

      const bvid = this.currentBvid;
      if (!bvid) return;
      const resumeAt = this.currentTime;
      if (resumeAt > 1) {
        this.seekAfterLoad = resumeAt;
        this.seekAfterLoadFor = this.songName;
      }
      await this.changeVideo(bvid, this.videoListKeyword || this.songName, {
        skipCache: true,
      });
    },
    /**
     * 把当前的 dash / durl 结果挂到 `<video>` 上
     *
     * dash 走 MSE：B 站 dash 的音视频是两条独立的流，只给一条会没声音，
     * 所以由 DashSession 把两轨都塞进同一个 MediaSource；
     * 编码不支持或播放失败就自动退回 durl（720P 混流）。
     */
    applyVideoSource(): void {
      const el = this.videoEl();
      if (!el) return;
      this.stopDashSession();

      /**
       * 换了源就重置停滞看门狗的计时
       *
       * 必须在这里做：`currentSrc` 一设上就非空，而 `_lastProgressAt` 若还停在上一首
       * 最后一次推进的时间（可能很久以前），新源起播超过 12 秒就会被误判成「停滞」，
       * 弹提示并把**正在加载**的那个请求用 `changeVideo(skipCache)` 顶掉；
       * 重解析也慢的话再过 12 秒就变成「拉不动，已跳过」。
       */
      this._lastProgressAt = Date.now();
      this._stallSince = 0;
      // 换了源就重新给这条流机会（上一轮可能已经判定放弃过）
      this._stallGivenUp = false;

      /**
       * 换源时**不要立刻**亮缓冲提示。
       *
       * 搜索 / 播放地址都有缓存时，切歌常常 200~400ms 就出画了，
       * 提示亮一下再灭反而像闪屏（用户说的「切歌时的加载条」）。
       * 所以延迟 500ms：真慢（重新联网解析、MSE 拉流慢）还是会显示，反馈不丢。
       */
      this.bufferPercent = 0;
      this.bufferSeconds = 0;
      this.stopBufferTicker();
      this.buffering = false;
      this.scheduleBufferOverlay();

      const dash = this.dashSource;
      if (dash && DashSession.isSupported(dash)) {
        const session = new DashSession(el);
        /**
         * `markRaw` 不能省：`data()` 里的对象会被 Vue 变成响应式，读 `this._dashSession`
         * 拿到的是 **reactive 代理**，而闭包里的 `session` 是原始对象 —— 两者 `!==` 恒为真，
         * 下面那句「期间已经换过源就忽略」会把**每一次**失败都当成「已经换过源」，
         * `fallbackToDurl()` 成了死代码。表现是 dash 起播失败（sourceopen 超时、配额耗尽，
         * 这些都不触发 <video> 的 error）时黑屏挂着，最后整首歌被跳过。
         */
        this._dashSession = markRaw(session);
        session
          .start(dash)
          .catch((err) => {
            // 期间已经换过源（切歌 / 换视频）就忽略这次失败
            if (this._dashSession !== session) return;
            console.warn('[video] dash 播放失败，退回 durl:', err);
            this.fallbackToDurl();
          });
        /**
         * 立刻把 `play()` 叫起来（别等 `loadeddata`）
         *
         * 踩过：起播的 `play()` 原来只在 `onVideoLoaded` 里调用，而 dash 会话卡住时
         * `loadeddata` 永远不来 —— 元素一直 `paused === true`，停滞看门狗的第一道判断
         * 就会把它当成「用户暂停了」，于是「时长有了、画面一个字节都没有」永久卡住。
         * 这里叫起来之后就算数据不来，`paused` 也是 false，12 秒后兜底照常生效。
         */
        if (!this.paused) void el.play().catch(() => {});
        return;
      }

      /**
       * 环境不支持这条 dash 编码：**必须真的退回 durl**
       *
       * 踩过：这里原来只打一行「改用 durl」的日志，什么都没做；而此时旧会话已经 stop、
       * blob 地址也 revoke 过了，走 dash 时主进程回的 `videoUrl` 本来就是 null ——
       * 结果新源根本没设上，画面停在上一首，界面却已经是新歌名，下一首还会重复。
       */
      if (dash && !DashSession.isSupported(dash)) {
        console.warn('[video] 当前环境不支持该 dash 编码，退回 durl');
        this._dashDisabled = true;
        this.fallbackToDurl();
        return;
      }
      if (this.videoUrl) {
        el.src = this.videoUrl;
        // 同上：不等 loadeddata，先把播放意图落到元素上（否则「没数据的源」会让
        // 元素一直 paused，停滞兜底进不去）
        if (!this.paused) void el.play().catch(() => {});
      }
    },
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
    stopDashSession(): void {
      if (this._dashSession) {
        this._dashSession.stop();
        this._dashSession = null;
      }
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
        this.seekAfterLoadFor = this.songName;
      }
    },
    fallbackToDurl(): void {
      this.stopDashSession();
      this.dashSource = null;
      this._dashFailures += 1;
      if (this._dashFailures >= 2) {
        this._dashDisabled = true;
        console.warn('[video] dash 连续失败，本会话改用 durl');
      }
      const bvid = this.currentBvid;
      if (!bvid) return;
      // 换 durl 会重新加载视频，把当前进度记下来接着播
      this.rememberSeekPoint();
      void this.changeVideo(bvid, this.videoListKeyword || this.songName, {
        skipCache: true,
        noDash: true,
      });
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
        this.videoList[this.currentVideoIndex] ??
        this.videoList.find((item) => item.bvid && item.title === this.videoName);
      const pic = normalizeImageUrl(v?.pic ?? null);
      if (pic) return pic;
      return null;
    },
    /** 当前歌曲的封面：优先平台专辑图，退回视频缩略图 */
    currentCover(): string | null {
      const song = this.getSong(this.currentIndex);
      const own = normalizeImageUrl(song?.cover ?? null);
      if (own) return own;
      return this.currentVideoCover();
    },
    /**
     * 左上角刷新（两个列表共用一个按钮）
     *
     * 歌曲列表 -> 重新同步当前歌单；视频列表 -> 重新搜索这首歌（收藏仍在最前面）。
     */
    async onListRefresh(): Promise<void> {
      if (this.listType === 'list') {
        const id = this.playlistsStore.currentId;
        if (!id) return;
        try {
          const results = await this.playlistsStore.sync([id]);
          await this.reportSyncResults(results, '同步');
          await this.reloadCurrentPlaylistSongs();
        } catch (err) {
          this.$message.error('同步失败：' + this.errMsg(err));
        }
        return;
      }
      await this.refreshVideoList();
    },
    /**
     * 重新搜索这首歌的候选视频
     *
     * `skipCache` 走主进程真实重搜（同时会与旧条目合并，保住已解析的播放地址）；
     * 不重播当前视频，只是把列表换了 —— 用户要的是「刷新列表」。
     */
    async refreshVideoList(): Promise<void> {
      const songName = this.songName;
      if (!songName) return;
      const token = this._songToken;
      try {
        const res = await electronApi.searchSong(songName, true);
        if (token !== this._songToken) return;
        const videos = (res.data as { result?: BiliVideo[] } | null)?.result ?? [];
        this.videoList = this.sortSearchedVideos(videos);
        this.videoListKeyword = songName;
        // 当前播放的视频可能还在列表里（下标要跟着更新），也可能被搜没了
        this.currentVideoIndex = this.videoList.findIndex((v) => v.bvid === this.currentBvid);
        this.$message.success(`已重新搜索《${songName}》，找到 ${this.videoList.length} 个视频`);
      } catch (err) {
        this.$message.error(`重新搜索失败：${this.errMsg(err)}`);
      }
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
      if (!bvid || !this.songName) return;
      const songName = this.songName;
      const isFav = this.favoriteBvids.includes(bvid);
      try {
        const { favorites } = await electronApi.setFavorite(songName, bvid, !isFav);
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
        this.currentVideoIndex = this.videoList.findIndex((v) => v.bvid === this.currentBvid);
      } catch (err) {
        this.$message.error(`收藏操作失败：${this.errMsg(err)}`);
      }
    },
    /** 「添加视频」确认：加进候选列表并收藏（收藏 = 排在最前面） */
    async onAddVideo(info: ParsedVideoInfo): Promise<void> {
      if (!this.songName) return;
      const songName = this.songName;
      if (!this.videoList.some((v) => v.bvid === info.bvid)) {
        this.videoList = [
          {
            bvid: info.bvid,
            title: info.title,
            pic: info.pic,
            author: info.author,
            duration: info.duration,
          },
          ...this.videoList,
        ];
      }
      try {
        /**
         * 走 `setFavorite` 而不是新增一个「加视频」接口：
         * 添加的语义就是「这首歌多一个我一定要用到的候选」，也就是收藏。
         * 主进程会在库里补插这一行（搜索没搜到的 bvid 本来不在 videos 表里），
         * 并把它挪到第一位 —— 与收藏完全同一条路径，不需要另写一套。
         */
        const { favorites } = await electronApi.setFavorite(songName, info.bvid, true);
        const favSet = new Set(favorites);
        this.videoList = this.videoList.map((v) => ({
          ...v,
          favorites: favSet.has(v.bvid),
        }));
        const idx = this.videoList.findIndex((v) => v.bvid === info.bvid);
        if (idx > 0) {
          const [moved] = this.videoList.splice(idx, 1);
          this.videoList.unshift(moved);
        }
      } catch (err) {
        this.$message.error(`添加视频失败：${this.errMsg(err)}`);
        return;
      }
      this.currentVideoIndex = this.videoList.findIndex((v) => v.bvid === this.currentBvid);
      this.$message.success(`已添加《${info.title || info.bvid}》`);
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
      const song = this.getSong(this.currentIndex);
      const title = song?.name || this.videoName || this.songName || 'B站音乐视频';
      const artist = song?.singer || this.userName || '未知歌手';
      const album = song?.album || this.listName || '';

      // 封面：平台专辑图 -> 视频缩略图，两个尺寸都给，系统会挑合适的
      const cover = this.currentCover();
      const artwork = cover
        ? [
            { src: cover, sizes: '256x256', type: 'image/jpeg' },
            { src: cover, sizes: '512x512', type: 'image/jpeg' },
          ]
        : [];

      try {
        ms.metadata = new MediaMetadata({
          title,
          artist,
          album,
          artwork,
        });
        // 同步播放/暂停状态，否则系统控件按钮会显示错
        ms.playbackState = this.paused ? 'paused' : 'playing';
      } catch (err) {
        console.warn('[smtc] 更新媒体信息失败', err);
      }
    },
    /** 同步播放进度到系统控件（有则显示进度条） */
    updateMediaPosition(): void {
      const ms = navigator.mediaSession;
      if (!ms || typeof ms.setPositionState !== 'function') return;
      if (!Number.isFinite(this.duration) || this.duration <= 0) return;
      try {
        ms.setPositionState({
          duration: this.duration,
          position: Math.min(Math.max(0, this.currentTime), this.duration),
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
        ['play', () => { if (this.paused) this.playControl(); }],
        ['pause', () => { if (!this.paused) this.playControl(); }],
        ['nexttrack', () => this.next()],
        ['previoustrack', () => this.prev()],
        ['seekbackward', () => this.changeTime(Math.max(0, this.currentTime - 10))],
        ['seekforward', () => this.changeTime(Math.min(this.duration || 0, this.currentTime + 10))],
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
      const record = this.playlistsStore.current;
      if (!record) return;
      const patch: Partial<AppSetting> = {
        'player.resumeTime': Math.floor(this.currentTime || 0),
      };
      void this.settingStore.update(patch);
      // 歌单自己的下标（切歌单时用于回到各自的位置）
      void this.playlistsStore.setLastIndex(this.currentIndex);
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
      const total = this.duration || 0;
      const progress = total > 0 ? (this.currentTime || 0) / total : -1;
      // 设置里关掉、或者没有在播 -> 清掉进度条
      const enabled = this.settingStore.setting['common.taskbarProgress'];
      const value = !enabled || (!this.videoUrl && !this.dashSource) ? -1 : progress;
      const key = value < 0 ? 'none' : `${Math.round(value * 200)}|${this.paused}`;
      if (key === this._lastTaskbarKey) return;
      this._lastTaskbarKey = key;
      void electronApi.setProgress(value, this.paused);
    },
    /**
     * 声音输出设备变化时暂停播放（设置项 `player.pauseOnDeviceChange`）
     *
     * 插拔耳机、切换默认输出设备时，正在播的音频有可能会跑到另一个设备上，
     * 所以先暂停，等用户自己决定继续。（`devicechange` 不区分输入/输出设备，
     * 这是渲染进程能拿到的唯一信号。）
     */
    onAudioDeviceChange(): void {
      if (!this.settingStore.setting['player.pauseOnDeviceChange']) return;
      if (this.paused) return;
      this.playControl();
      this.$message.info('检测到声音输出设备变化，已暂停播放');
    },
    setupAudioDeviceWatch(): void {
      const md = navigator.mediaDevices;
      if (!md || typeof md.addEventListener !== 'function') return;
      md.addEventListener('devicechange', this.onAudioDeviceChange);
    },
    /**
     * 关闭窗口前记录播放信息
     *
     * beforeunload 里不能等异步，所以这里直接发一次 fire-and-forget 的 IPC；
     * 主进程侧有 300ms 防抖并在 before-quit 里 flush，能保证落盘。
     */
    onBeforeUnload(): void {
      const patch: Partial<AppSetting> = {
        'player.resumeTime': Math.floor(this.currentTime || 0),
      };
      this.settingStore.update(patch);
      this.playlistsStore.setLastIndex(this.currentIndex);
      /**
       * 退出时**不需要**再写 `selectedBvid`
       *
       * 它已经在每次切视频时落库了（见 `changeVideo` / `api:resolveVideo`），
       * 这里再写一次是重复的。而且 `beforeunload` 是同步的、Electron 不会等 promise，
       * 真要写还得依赖 `ipcRenderer.invoke` 的同步投递，属于把正确性押在一个
       * 不好验证的行为上 —— 没必要，那条数据早就是最新的了。
       */
    },
    /**
     * 取第 index 首歌的「搜索键」（`"歌名-歌手"`）
     *
     * 匹配打分、搜索缓存 key、收藏/选中视频的 key 全部沿用这个格式，
     * 所以曲目改成结构化对象后，这里统一用 toSearchKey 兼容旧链路。
     */
    getSongName(index: number): string | null {
      if (!this.songs || this.songs.length === 0) return null;
      const song = this.songs[index];
      return song ? toSearchKey(song) : null;
    },
    /** 取第 index 首歌的结构化信息（供界面展示封面/专辑） */
    getSong(index: number): StructuredSong | null {
      return this.songs[index] ?? null;
    },
    /*
     * `matchScore` / `tagBonus` / `nameBonus` 三个打分函数已**移到主进程**：
     * 见 `@common/utils/videoRank`。它们现在由 `api:searchSong` 在写库前调用，
     * 好让 `videos.ord` 直接等于最终显示顺序。渲染层不再需要它们。
     */
    next(): void {
      if (!this.songs || this.songs.length === 0) return;
      const index =
        this.currentMode === this.MODE.random
          ? this.getRandomNext()
          : (this.currentIndex + 1) % this.songs.length;
      this.changeSong(index);
    },
    /**
     * 自绘托盘菜单打开期间吞掉窗口内的鼠标点击（捕获阶段）
     *
     * 壁纸模式的鼠标转发会把「点菜单项」这一下同时合成到壁纸窗口上，
     * 不拦的话可能顺手把控制栏的按钮也点了一次。
     */
    onTrayMenuGuard(e: MouseEvent): void {
      if (!this.trayMenuOpen) return;
      e.stopPropagation();
      e.preventDefault();
    },
    syncTrayState(): void {
      // 托盘显示的是「歌曲名 - 歌手名」，不是视频标题（视频标题太长了）
      const song = this.getSong(this.currentIndex);
      const title = song
        ? song.singer
          ? `${song.name} - ${song.singer}`
          : song.name
        : this.songName || '';
      electronApi.trayUpdateState({
        paused: this.paused,
        // 托盘契约用字符串枚举的循环模式（与持久化的 player.loopMode 一致）
        loopMode: PLAY_LOOP_MODES[this.currentMode] || 'listLoop',
        title,
        // 托盘菜单是个迷你控制台：进度条与音量跟着实时走
        position: this.currentTime || 0,
        duration: this.duration || 0,
        volume: this.currentVolume,
        muted: this.isMuted,
        // 登录态一起带上，防主进程那份和这边不一致
        isLoggedIn: this.isLoggedIn,
      });
    },
    async initWallpaperState(): Promise<void> {
      this.wallpaperEnabled = await electronApi.wallpaperIsEnabled();
    },
    prev(): void {
      if (!this.songs || this.songs.length === 0) return;
      const index =
        this.currentMode === this.MODE.random
          ? this.getRandomPrev()
          : (this.currentIndex - 1 + this.songs.length) % this.songs.length;
      this.changeSong(index);
    },
    toggleMode(): void {
      this.currentMode = (this.currentMode + 1) % 3;
      if (this.currentMode === this.MODE.random) this.resetRandomList();
      // 用户切模式 -> 写回主进程持久化
      this.settingStore.update({
        'player.loopMode': PLAY_LOOP_MODES[this.currentMode] || 'listLoop',
      });
      this.syncTrayState();
    },
    getRandomNext(): number {
      if (this.randomList.length === 0) this.resetRandomList();
      let pos = this.randomList.indexOf(this.currentIndex);
      if (pos === -1) {
        this.randomList.push(this.currentIndex);
        pos = this.randomList.length - 1;
      }
      return this.randomList[(pos + 1) % this.randomList.length];
    },
    getRandomPrev(): number {
      if (this.randomList.length === 0) this.resetRandomList();
      let pos = this.randomList.indexOf(this.currentIndex);
      if (pos === -1) {
        this.randomList.push(this.currentIndex);
        pos = this.randomList.length - 1;
      }
      return this.randomList[
        (pos - 1 + this.randomList.length) % this.randomList.length
      ];
    },
    resetRandomList(): void {
      const indices = Array.from({ length: this.songs.length }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      this.randomList = indices;
      if (this.songs.length > 0) {
        const pos = this.randomList.indexOf(this.currentIndex);
        if (pos === -1) this.randomList.unshift(this.currentIndex);
        else if (pos > 0) {
          this.randomList.splice(pos, 1);
          this.randomList.unshift(this.currentIndex);
        }
      }
    },
  },
  watch: {
    /**
     * 进壁纸模式就先把所有弹窗收掉
     *
     * 踩过：壁纸模式下窗口在桌面层、标题栏和控制栏都隐藏了，弹窗却还开着 ——
     * 它既点不动也关不掉，用户只能先回窗口模式关掉它再重新进壁纸模式。
     * 所以只要 `wallpaperEnabled` 变 true，就把列表 / 歌单管理 / 设置 / 关于 / 添加视频全关掉。
     */
    wallpaperEnabled(enabled: boolean): void {
      if (!enabled) return;
      this.listType = 'none';
      this.playlistManagerVisible = false;
      this.settingsVisible = false;
      this.aboutVisible = false;
      this.addVideoVisible = false;
    },
    /**
     * 全屏 -> 自动锁定（设置里开关，默认关）
     *
     * 进全屏时锁上、退出全屏时解开，但**只动「因全屏而锁」的那次**：
     * 用户自己按 S 锁的，退出全屏不该替他解开。
     */
    isFullscreen(full: boolean): void {
      if (full) {
        /**
         * 只有**本次真的由全屏触发了锁定**才记来源
         *
         * 用户可能自己按 S 锁着再进全屏：这时不能把「解锁的责任」算在全屏头上，
         * 否则退出全屏会替他解开（与这段的初衷相反）。
         */
        if (this.settingStore.setting['player.lockOnFullscreen'] && !this.locked) {
          this._lockedByFullscreen = true;
          this.toggleLock(true);
        }
        return;
      }
      if (this._lockedByFullscreen) {
        this._lockedByFullscreen = false;
        if (this.locked) this.toggleLock(false);
      }
    },
    /**
     * 配置可能在别处被改动（多窗口同步、托盘、恢复默认），
     * 所以要把 Pinia 里的音量/静音同步回本地播放状态，并作用到 <video> 上。
     *
     * 用 !== 判断避免与「用户改音量 -> 写回主进程 -> 广播回来」形成回环。
     */
    'settingStore.setting': {
      handler(): void {
        const cfg = this.settingStore.setting;
        if (cfg['player.volume'] !== this.currentVolume) {
          this.currentVolume = cfg['player.volume'];
        }
        if (cfg['player.isMute'] !== this.isMuted) {
          this.isMuted = cfg['player.isMute'];
        }
        const v = this.videoEl();
        if (v) {
          v.volume = this.currentVolume / 100;
          v.muted = this.isMuted;
        }
        // 定时同步策略挂在每个歌单上：只有「有没有定时歌单 / 最小间隔」变了才重建定时器。
        // 以前是无条件 setupSyncTimer()，而它会先 clear 再 setInterval ——
        // 播放中每 5 秒就会广播一次 player.resumeTime，于是定时器被无限推迟，30 分钟的心跳永远等不到。
        const syncKey = `${this.playlistsStore.hasIntervalSync}|${this.playlistsStore.minSyncInterval}`;
        if (syncKey !== this._syncKey) {
          this._syncKey = syncKey;
          this.setupSyncTimer();
        }
        // 任务栏进度开关可能刚被关掉：立刻把进度条清掉（不然要等下一次 3 秒节流）
        this.updateTaskbarProgress();
      },
      deep: true,
    },
  },
  mounted() {
    // 配置在 src/main.ts 里已经拉取完成，这里直接初始化播放状态
    void this.init();
    this.removeLoginListener = electronApi.onLoginSuccess(() => {
      void this.onLoggedIn();
    });
    this.removeLogoutListener = electronApi.onLogout(() => {
      this.isLoggedIn = false;
      this.userFace = '';
      this.userName = '';
    });
    this.removeTrayPlayControl = electronApi.onTrayPlayControl(() => {
      this.playControl();
    });
    this.removeTrayPrev = electronApi.onTrayPrev(() => {
      this.prev();
    });
    this.removeTrayNext = electronApi.onTrayNext(() => {
      this.next();
    });
    this.removeTrayToggleMode = electronApi.onTrayToggleMode(() => {
      this.toggleMode();
    });
    // 托盘菜单上的进度条 / 音量（菜单是个迷你控制台）
    this.removeTraySeek = electronApi.onTraySeek((ratio) => {
      const total = this.duration || 0;
      if (total > 0) this.changeTime(Math.min(total, Math.max(0, ratio * total)));
    });
    this.removeTrayVolume = electronApi.onTrayVolume((volume) => {
      this.changeVolume(volume);
    });
    this.removeTrayToggleMute = electronApi.onTrayToggleMute(() => {
      this.toggleMute();
    });
    this.removeTrayShowPlaylist = electronApi.onTrayShowPlaylist(() => {
      // 托盘「设置歌单」-> 直接打开统一的歌单管理弹窗
      this.playlistManagerVisible = true;
    });
    this.removeTrayShowLogoutConfirm = electronApi.onTrayShowLogoutConfirm(
      () => {
        this.handleLogoutConfirm();
      },
    );
    /**
     * 左键点托盘图标 = 回到窗口 + 解锁
     *
     * 窗口模式 + 锁定状态下，界面只剩左下右下两个角按钮，用户自然会去点托盘；
     * 这里用 `toggleLock(false)`（幂等）：没锁就什么都不做，也不会多弹一条提示。
     */
    this.removeTrayUnlock = electronApi.onTrayUnlock(() => {
      this.toggleLock(false);
    });
    this.removeWallpaperState = electronApi.onWallpaperState((enabled) => {
      this.wallpaperEnabled = enabled;
    });
    /**
     * 壁纸模式不可用：把原因告诉用户
     *
     * 以前这种情况是**完全静默**的（主进程用空 catch 吞掉了原生模块加载失败），
     * 用户点了按钮什么都不发生，无从判断是环境不支持还是程序坏了。
     */
    this.removeWallpaperUnavailable = electronApi.onWallpaperUnavailable(
      (reason) => {
        this.$message.warning(`壁纸模式不可用：${reason}`);
      },
    );
    this.initWallpaperState();
    this.removeMaximizedListener = electronApi.onMaximized((val) => {
      this.isMaximized = val;
    });
    this.removeFullscreenListener = electronApi.onFullscreen((val) => {
      this.isFullscreen = val;
    });
    // 声音输出设备变化时暂停（插拔耳机 / 切默认设备）
    this.setupAudioDeviceWatch();
    // 片尾看门狗：常驻一个 1 秒的心跳（内部条件很严，平时几乎不做任何事）
    this.startEndWatch();
    /**
     * 自绘托盘菜单打开期间，把窗口内的点击吞掉。
     *
     * 原因：壁纸模式开着鼠标转发，用户点菜单项时壁纸窗口**同时**会收到一次同坐标的
     * 合成点击，可能误触控制栏。用捕获阶段拦下来，菜单一关就恢复。
     */
    this.removeTrayMenuListener = electronApi.onTrayMenuVisibility((visible) => {
      this.trayMenuOpen = visible;
    });
    /**
     * 这里原来有三个捕获阶段的监听，用来在托盘菜单打开时吞掉窗口内的点击 ——
     * 那是为了挡住「壁纸模式的鼠标转发把点菜单这一下同时合成到壁纸窗口」的副作用。
     * 现在壁纸模式已经 `forwardMouseInput: false`（界面也全隐藏了），不会再有合成点击，
     * 所以按计划注释掉。`trayMenuOpen` 本身还留着：菜单开着时要把进度推给菜单里的进度条。
     */
    // document.addEventListener('mousedown', this.onTrayMenuGuard, true);
    // document.addEventListener('mouseup', this.onTrayMenuGuard, true);
    // document.addEventListener('click', this.onTrayMenuGuard, true);
    document.addEventListener('keydown', this.handleKeydown);
    document.addEventListener('mousemove', this.onDocMouseMove);
    document.addEventListener('mouseup', this.onDocMouseUp);
    // 关闭窗口前记录一次播放信息（用户要求「关闭时」也记录）
    window.addEventListener('beforeunload', this.onBeforeUnload);
  },
  beforeUnmount() {
    this.stopDashSession();
    this.stopBufferTicker();
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onAudioDeviceChange);
    // 自绘托盘菜单的守卫与其他监听一起摘掉
    // （守卫本身已经注释掉，这里同样注释，留着对照）
    // document.removeEventListener('mousedown', this.onTrayMenuGuard, true);
    // document.removeEventListener('mouseup', this.onTrayMenuGuard, true);
    // document.removeEventListener('click', this.onTrayMenuGuard, true);
    if (this.removeTrayMenuListener) this.removeTrayMenuListener();
    // 预热的隐藏流 / 元素也要收掉
    this.clearAllWarm();
    for (const dir of ['next', 'prev'] as const) {
      const el = this._warmEl[dir];
      if (el) {
        try {
          (el as unknown as HTMLVideoElement).remove();
        } catch {
          /* 忽略 */
        }
        this._warmEl[dir] = null;
      }
    }
    if (this._endWatchTimer) {
      clearInterval(this._endWatchTimer);
      this._endWatchTimer = null;
    }
    if (this.removeLoginListener) this.removeLoginListener();
    if (this.removeLogoutListener) this.removeLogoutListener();
    if (this.removeTrayPlayControl) this.removeTrayPlayControl();
    if (this.removeTrayPrev) this.removeTrayPrev();
    if (this.removeTrayNext) this.removeTrayNext();
    if (this.removeTrayToggleMode) this.removeTrayToggleMode();
    if (this.removeTraySeek) this.removeTraySeek();
    if (this.removeTrayVolume) this.removeTrayVolume();
    if (this.removeTrayToggleMute) this.removeTrayToggleMute();
    if (this.removeTrayShowPlaylist) this.removeTrayShowPlaylist();
    if (this.removeTrayShowLogoutConfirm) this.removeTrayShowLogoutConfirm();
    if (this.removeTrayUnlock) this.removeTrayUnlock();
    if (this.removeWallpaperState) this.removeWallpaperState();
    if (this.removeWallpaperUnavailable) this.removeWallpaperUnavailable();
    if (this.removeMaximizedListener) this.removeMaximizedListener();
    if (this.removeFullscreenListener) this.removeFullscreenListener();
    document.removeEventListener('keydown', this.handleKeydown);
    document.removeEventListener('mousemove', this.onDocMouseMove);
    document.removeEventListener('mouseup', this.onDocMouseUp);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.clearSyncTimer();
  },
});
</script>

<style>
/* #region 主题令牌（颜色 / 毛玻璃都靠这几个变量） */
/*
 * 分两组，别混用：
 *  - `--glass-*`：**浮在视频上**的毛玻璃（控制栏、左上角歌单按钮、标题栏、全屏按钮）；
 *  - `--panel-*`：**有实底**的面板（歌单下拉、设置 / 歌单管理 / 关于弹窗、歌曲列表）。
 *
 * 颜色来自设置里的两个取色器，由 `src/utils/uiTheme.ts` 写成 `r, g, b` 三个通道：
 *  - `--glass-rgb`：玻璃/面板的底色（浅色主题默认 255,255,255）；
 *  - `--text-rgb`：浮层上的文字颜色（默认也是白色）。
 * 透明度由 `--glass-alpha`（设置里的「透明度」）组合进 rgba。
 * 底色偏暗时 `uiTheme` 会给 html 加 `data-tint="dark"`，阴影自动换成白色。
 */
:root {
  --glass-rgb: 255, 255, 255;
  --text-rgb: 255, 255, 255;
  --glass-alpha: 0.3;
  --glass-alpha-strong: 0.42;
  --glass-blur: 10px;
  /* 文字阴影的模糊半径（设置里的「阴影强度」，8px = 默认那套） */
  --glass-shadow-size: 8px;
  /**
   * 强调色
   *
   * 当前播放标记、同步转圈、B 站搜索关键词高亮这些「功能色」用它，
   * 别在组件里散落一堆 #6f8cff / #d03050 —— 换主题时至少有个统一入口。
   */
  --accent: #6f8cff;
  --accent-strong: #5b6fe0;
  --accent-danger: #d03050;

  /* —— 浮在视频上的毛玻璃 —— */
  --glass-bg: rgba(var(--glass-rgb), var(--glass-alpha));
  --glass-bg-strong: rgba(var(--glass-rgb), var(--glass-alpha-strong));
  --glass-border: rgba(var(--text-rgb), 0.5);
  --glass-radius: 12px;
  --glass-text: rgb(var(--text-rgb));
  --glass-text-dim: rgba(var(--text-rgb), 0.75);
  /* 浅底 -> 黑阴影；近影是远影的一半，字号小的地方也不会糊成一团 */
  --glass-shadow:
    0 1px calc(var(--glass-shadow-size) * 0.5) rgba(0, 0, 0, 0.9),
    0 0 var(--glass-shadow-size) rgba(0, 0, 0, 0.5);

  /* —— 面板：同一套底色与 alpha，文字也跟设置走 —— */
  --panel-bg: rgba(var(--glass-rgb), var(--glass-alpha));
  --panel-border: rgba(var(--text-rgb), 0.28);
  --panel-text: rgb(var(--text-rgb));
  --panel-text-dim: rgba(var(--text-rgb), 0.78);
  --panel-hover: rgba(var(--text-rgb), 0.16);
  --panel-active: rgba(111, 140, 255, 0.35);
  --panel-shadow: 0 10px 32px rgba(0, 0, 0, 0.25);
  --panel-divider: rgba(var(--text-rgb), 0.18);

  /**
   * 浮层未悬停时的不透明度：**固定行为**，鼠标移上去变 1。
   *
   * 注意它跟设置里的「透明度」是两回事：
   * 这个管的是「整个控件淡出到什么程度」，设置管的是「玻璃底有多透明」。
   */
  --ui-idle-opacity: 0.1;
}
/* 深底 -> 白阴影（底色深浅由 uiTheme 按亮度写进来） */
html[data-tint='dark'] {
  --glass-shadow:
    0 0 var(--glass-shadow-size) rgba(255, 255, 255, 0.5),
    0 1px calc(var(--glass-shadow-size) * 0.4) rgba(0, 0, 0, 0.5);
  --panel-shadow: 0 10px 32px rgba(0, 0, 0, 0.7);
}
/* #endregion */

#app {
  height: 100vh;
  margin: 0;
  padding: 0;
  overflow: hidden;
  user-select: none;
}

/*
 * 所有 el-dialog 统一成同一套面板风格（歌单管理 / 设置两个弹窗）。
 * 弹窗是 teleport 到 body 的，scoped 样式够不到，所以写在全局里。
 *
 * 文字是白色的（浅色主题偏白的面板底 + 黑阴影，深色主题偏黑的底 + 白阴影），
 * 这样不管背后视频是亮是暗都看得清 —— 跟控制栏同一套做法。
 */
.el-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--glass-radius);
  box-shadow: var(--panel-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  color: var(--panel-text);
  text-shadow: var(--glass-shadow);
}
.el-dialog .el-dialog__title,
.el-dialog .el-dialog__header,
.el-dialog .el-dialog__body {
  color: var(--panel-text);
}
/*
 * 这几个弹窗（设置 / 歌单管理 / 歌曲·视频列表）都不用右上角的叉号
 * （`show-close=false`），关闭方式统一成「点弹窗外面的空白处」——
 * Element Plus 默认行为，它要求 mousedown/mouseup 都落在遮罩上，
 * 所以拖滑块松手在弹窗外不会误关。
 *
 * 提示写在**遮罩**上、弹窗下面：用遮罩的 ::after，一处生效三个弹窗都有。
 * `pointer-events: none` 保证它不挡点击（点它等于点遮罩，照样关）。
 */
.el-overlay-dialog::after {
  content: '点击空白位置关闭';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 4vh;
  text-align: center;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--glass-text);
  text-shadow: var(--glass-shadow);
  pointer-events: none;
}
/*
 * Element Plus 自己的控件有实底（输入框、按钮、下拉），文字不能再叠阴影：
 * 白底黑字加一圈黑阴影会发虚，像没对焦。
 */
.el-dialog .el-button,
.el-dialog .el-input,
.el-dialog .el-select,
.el-dialog .el-textarea,
.el-dialog .el-radio-group,
.el-dialog .el-checkbox,
.el-dialog .el-switch,
.el-dialog .el-tag {
  text-shadow: none;
}
.el-overlay {
  background-color: rgba(0, 0, 0, 0.45);
}
#biliVideo {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  z-index: 0;
}

/* #region 缓冲提示 */
.buffer-overlay {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 26px;
  border-radius: 14px;
  /* 刻意压暗的 scrim：缓冲提示要压在视频上，文字再走 --glass-text */
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  color: var(--glass-text);
  pointer-events: none;
  user-select: none;
}
.buffer-ring-wrap {
  position: relative;
  width: 76px;
  height: 76px;
}
.buffer-ring {
  width: 100%;
  height: 100%;
  /* 从 12 点方向顺时针画 */
  transform: rotate(-90deg);
}
.ring-bg,
.ring-fg {
  fill: none;
  stroke-width: 2.6;
}
.ring-bg {
  stroke: rgba(var(--text-rgb), 0.18);
}
.ring-fg {
  stroke: rgb(var(--text-rgb));
  stroke-linecap: round;
  transition: stroke-dashoffset 0.2s linear;
}
.buffer-percent {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-shadow: var(--glass-shadow);
}
.buffer-text {
  font-size: 13px;
  opacity: 0.92;
}
.buffer-sub {
  font-size: 11px;
  opacity: 0.6;
}
/* #endregion */

.titlebar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 40px;
  z-index: 200;
  display: flex;
  align-items: center;
}
/*
 * 壁纸模式：标题栏与控制栏整体隐藏
 *
 * 壁纸模式下窗口就是桌面背景，鼠标输入也不再转发（attach 里 forwardMouseInput: false），
 * 界面上的按钮点不到，留着只会挡画面 —— 全部操作走托盘菜单。
 * 用 !important 压掉组件自己的 `position: fixed` / opacity 之类。
 */
.wm-hidden {
  display: none !important;
}
.titlebar-drag {
  flex: 1;
  height: 100%;
  cursor: default;
}
/* 左侧歌单入口：贴左边缘，与右侧按钮区分开 */
.titlebar-left {
  display: flex;
  align-items: center;
  padding-left: 8px;
  -webkit-app-region: no-drag;
}
.titlebar-right {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 4px;
  -webkit-app-region: no-drag;
}

.titlebar-btn {
  padding: 0 12px;
  margin: 0 6px;
  height: 30px;
  display: flex;
  align-items: center;
  font-size: 15px;
  color: var(--glass-text);
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  box-shadow: var(--glass-shadow);
  transition: background 0.15s;
  white-space: nowrap;
  text-shadow: var(--glass-shadow);
}
.titlebar-btn:hover {
  background: var(--glass-bg-strong);
}

.user-info {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  border-radius: 16px;
  padding: 3px 12px 3px 3px;
  margin-left: 6px;
  transition: background 0.2s;
  text-shadow: var(--glass-shadow);
}
.user-info:hover {
  background: var(--glass-bg-strong);
}
.user-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--glass-border);
}
.user-name {
  color: var(--glass-text);
  font-size: 13px;
  white-space: nowrap;
  text-shadow: var(--glass-shadow);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.win-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  margin-left: 6px;
  color: var(--glass-text);
  transition: background 0.15s;
  border-radius: 4px;
  text-shadow: var(--glass-shadow);
  box-shadow: var(--glass-shadow);
}
.win-btn:hover {
  background: var(--glass-bg-strong);
}
.win-btn .iconfont {
  font-size: 15px;
  line-height: 1;
}
/* 关闭图标笔画细，稍微放大一点才和别的按钮视觉等重 */
.win-btn.win-close .iconfont {
  font-size: 13px;
}
.win-close:hover {
  background: #e81123 !important;
  color: white;
}

.fullscreen-btn {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 100;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--glass-text);
  /* 和别的浮层同一套毛玻璃令牌（受设置里的透明度 / 模糊强度控制） */
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  text-shadow: var(--glass-shadow);
  transition: all 0.2s;
  opacity: 0.2;
}
.fullscreen-btn:hover {
  opacity: 1;
  background: var(--glass-bg-strong);
}
.fullscreen-btn .iconfont {
  font-size: 20px;
  line-height: 1;
}

/*
 * 左下角的锁定按钮
 *
 * 和右下角全屏按钮完全同一套外观，只是贴左边；锁定状态下这俩按钮**都要留着**
 * （界面其它部分都藏起来了，没有它们就没法解锁）。
 */
.corner-btn {
  position: fixed;
  bottom: 16px;
  z-index: 100;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--glass-text);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  text-shadow: var(--glass-shadow);
  transition: all 0.2s;
  opacity: 0.2;
}
.corner-btn:hover {
  opacity: 1;
  background: var(--glass-bg-strong);
}
.lock-btn {
  left: 16px;
}
/* 锁着的时候让它明显一点，否则界面上什么都看不到、这个按钮又是半透明的 */
.lock-btn.locked {
  opacity: 0.75;
}
.lock-btn.locked:hover {
  opacity: 1;
}
</style>
