<template>
  <!-- 壁纸模式 / 锁定时整条隐藏（class 而不是 v-if：v-if 拆掉再挂会丢拖动状态） -->
  <div id="VideoControls" :class="{ 'wm-hidden': window.wallpaperEnabled || window.locked }">
    <div class="now-playing">
      <!-- 封面：优先歌曲专辑图，退回视频缩略图 -->
      <div class="np-cover">
        <img
          v-if="coverUrl && !coverFailed"
          :src="coverUrl"
          alt=""
          referrerpolicy="no-referrer"
          @error="coverFailed = true"
        />
        <div v-else class="np-cover-fallback">
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
      <div class="np-text">
        <div class="videoName-container">
          <div :class="['videoName-scroll', paused ? 'paused' : '']">
            <!-- 用净化过的 HTML：标题是第三方数据，不能直接 v-html（见 utils/title.ts） -->
            <span v-html="safeVideoName"></span>
            <span v-html="safeVideoName"></span>
          </div>
        </div>
        <div v-if="subtitle || quality || audioQuality" class="np-sub">
          <div class="np-subtitle" :title="subtitle">{{ subtitle }}</div>
          <!--
            清晰度 / 音质角标：贴在这一行最右边，点开可以切换
            可选档位由 store 从 playurl 响应里取（不同视频、不同账号能选的档位不一样）

            ⚠️ 切换清晰度**会重新解析播放地址**（发请求）—— 请求进行中禁用（`qualityBusy`），
            而且改完还有 3 秒冷却（防连点）。禁用时 `title` 说明原因。
          -->
          <el-dropdown
            v-if="quality"
            trigger="click"
            placement="top"
            :disabled="qualityBusy"
            @command="(id: number) => playback.switchQuality('video', id)"
          >
            <div class="np-quality" :title="qualityBusy ? '正在加载中，请稍候……' : qualityTitle">
              {{ quality }}<span v-if="videoChoices.length > 1" class="np-caret">▾</span>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="opt in videoChoices"
                  :key="opt.id"
                  :command="opt.id"
                  :disabled="opt.id === currentQn"
                >
                  画质 · {{ opt.description }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-dropdown
            v-if="audioQuality"
            trigger="click"
            placement="top"
            :disabled="qualityBusy"
            @command="(id: number) => playback.switchQuality('audio', id)"
          >
            <div class="np-quality" :title="qualityBusy ? '正在加载中，请稍候……' : audioTitle">
              {{ audioQuality }}<span v-if="audioChoices.length > 1" class="np-caret">▾</span>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="opt in audioChoices"
                  :key="opt.id"
                  :command="opt.id"
                  :disabled="opt.id === currentAudioId"
                >
                  音质 · {{ opt.description }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </div>
    <!-- 进度条放在按钮**上方**（用户要求） -->
    <div class="progressContainer">
      <div class="time" id="currentTime">
        {{ formatTime(isVideoDragging ? draggingTime : currentTime) }}
      </div>
      <div
        class="progressWrapper"
        id="progressContainer"
        @pointerdown.prevent="onProgressDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @lostpointercapture="onPointerUp"
      >
        <div
          class="progressBar"
          :style="{ width: progress * 100 + '%' }"
          id="progressBar"
        >
          <div class="progressHandle" id="progressHandle"></div>
        </div>
      </div>
      <div class="time" id="totalTime">{{ formatTime(duration) }}</div>
    </div>
    <div id="controls">
      <!--
        歌曲列表（MV 的播放队列）

        **OV 下不渲染** —— 那边没有「歌」这一层，整个合集就是视频列表本身；
        留一个「歌曲列表」按钮只会让人以为还能按歌看。
      -->
      <i
        v-if="mode !== 'ov'"
        :class="['iconfont', listType == 'songList' ? 'icon-cuowu' : 'icon-bofangduilie']"
        title="歌曲列表"
        @click="playback.videoControl('songList')"
        id="songList"
      ></i>
      <!--
        视频列表

        MV：当前这首歌的 B 站搜索结果（一条一个视频版本，可以换）
        OV：当前这一列的全部条目（合集 / 收藏夹）

        两个工作区里它都表示「一堆视频」，所以图标和文案**不随模式变**。
        以前 OV 是把这个图标借给「歌曲列表」那个按钮、再把文案改成「视频列表」，
        于是一个按钮身上挂三种 `mode === 'ov' ? …`，改一处漏一处。
      -->
      <i
        :class="[
          'iconfont',
          listType == 'videoList' ? 'icon-cuowu' : 'icon-bofangliebiao',
        ]"
        title="视频列表"
        @click="playback.videoControl('videoList')"
        id="videoList"
      ></i>
      <!--
        上一首 / 下一首：**会发请求**（重新搜索 + 解析地址），
        请求进行中禁用 —— 狂点只会让 B站 412 风控（`busy`）。

        `title` 说明**为什么点不动**：只灰掉而不给原因，用户会以为按钮坏了。
      -->
      <i
        :class="['iconfont', 'icon-1_music83', busy ? 'ctrl-disabled' : '']"
        :title="busy ? '正在加载中，请稍候……' : modeUi.prevTitle"
        @click="busy ? null : playback.videoControl('before')"
        id="before"
      ></i>
      <i
        :class="['iconfont', paused ? 'icon-play' : 'icon-pause']"
        @click="playback.videoControl('playControls')"
        id="playControls"
      ></i>
      <i
        :class="['iconfont', 'icon-1_music82', busy ? 'ctrl-disabled' : '']"
        :title="busy ? '正在加载中，请稍候……' : modeUi.nextTitle"
        @click="busy ? null : playback.videoControl('next')"
        id="next"
      ></i>
      <!--
        音量：悬停出条 + 可拖动

        滚轮也挂在这一块上（**不是**整个控制栏）：`.audio-control:hover` 正是
        「音量条显示着」的那个条件，所以鼠标停在这一块上才滚得动 —— 恰好是用户要的。
      -->
      <div class="audio-control" @wheel.prevent="onVolumeWheel">
        <i
          :class="['iconfont', isMuted ? 'icon-sound-off' : 'icon-sound-on']"
          @click="toggleMute"
          id="sound"
        ></i>
        <div
          :class="['volume-slider', isSoundDragging ? 'show' : '']"
          id="volume-slider"
        >
          <div
            class="volume-track"
            id="volume-track"
            @pointerdown.prevent="onVolumeDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @lostpointercapture="onPointerUp"
          >
            <div
              class="volume-progress"
              id="volumeProgress"
              :style="{
                height:
                  (isSoundDragging ? draggingVolume : currentVolume) + '%',
              }"
            ></div>
            <div
              class="volume-thumb"
              id="volumeThumb"
              :style="{
                bottom:
                  (isSoundDragging ? draggingVolume : currentVolume) + '%',
              }"
            ></div>
          </div>
          <div class="volume-number" id="volume-number">
            {{ isSoundDragging ? draggingVolume : currentVolume }}
          </div>
        </div>
      </div>
      <!--
        循环模式：0 列表循环 / 1 单曲循环 / 2 随机播放
        （原来的 icon-ziyuanldpi 已经从字体里删掉了，换成 icon-suijibofang）
      -->
      <i
        :class="[
          'iconfont',
          currentMode
            ? currentMode == 1
              ? 'icon-danquxunhuan'
              : 'icon-suijibofang'
            : 'icon-liebiaoxunhuan',
        ]"
        @click="playback.videoControl('playMode')"
        id="playMode"
      ></i>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import type { QualityOptionPayload, QualityOptionsPayload } from '@common/types/ipc';
import { normalizeImageUrl } from '../utils/image';
import { sanitizeTitleHtml } from '../utils/title';
import { useWindowStore } from '../stores/window';
import { usePlaybackStore } from '../stores/playback';
import { useQueueStore } from '../stores/queue';
import { useUiStore } from '../stores/ui';

export default defineComponent({
  name: 'VideoControls',
  data() {
    return {
      isVideoDragging: false,
      isSoundDragging: false,
      draggingTime: 0,
      draggingVolume: 0,
      activeEl: null as HTMLElement | null,
      /**
       * 当前封面是否加载失败
       *
       * 必须用响应式状态而不是 `img.style.display = 'none'`：
       * 直接改内联样式后，切歌时 Vue 只会 patch `src`（模板里没有 style 绑定），
       * 那个 display:none 永远不会被清掉 —— 一次加载失败，封面就再也出不来了。
       */
      coverFailed: false,
    };
  },
  methods: {
    formatTime(s: number): string {
      s = Math.floor(s || 0);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      const p = (n: number): string => (n < 10 ? '0' + n : String(n));
      return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
    },
    /**
     * 静音按钮
     *
     * 这里只负责转达「用户按了静音」，具体是静音还是恢复、恢复到多少音量，
     * 都由 store 决定 —— 音量状态的权威在 player 里。
     *
     * 之前这里用 draggingVolume 当「静音前的音量」暂存：
     * 但 draggingVolume 只在拖动音量条时才被赋值，点击静音时它还是初始值 0，
     * 于是「解除静音」恢复的音量是 0，音量永远回不来，静音状态也卡死。
     */
    toggleMute() {
      this.playback.toggleMute();
    },
    onProgressDown(e: PointerEvent) {
      this.isVideoDragging = true;
      this.activeEl = e.currentTarget as HTMLElement;
      this.activeEl.setPointerCapture(e.pointerId);
      this.calcProgress(e);
    },
    onVolumeDown(e: PointerEvent) {
      this.isSoundDragging = true;
      this.activeEl = e.currentTarget as HTMLElement;
      this.activeEl.setPointerCapture(e.pointerId);
      this.calcVolume(e);
    },
    /**
     * 音量按钮上的滚轮：**一次 5**，上滚加、下滚减
     *
     * 触发范围就是音量条显示的范围（`.audio-control:hover`），鼠标不在按钮/条子上时
     * 这里根本收不到事件 —— 不用再判断「条子有没有显示」，那和 hover 是同一件事。
     * 步长和键盘 ↑ / ↓、托盘菜单里的滚轮一致，三处手感相同。
     *
     * 拖动中不响应：那时 `draggingVolume` 和指针位置才是权威，滚轮一插手就打架。
     */
    onVolumeWheel(e: WheelEvent) {
      if (this.isSoundDragging) return;
      if (!e.deltaY) return; // 触控板横向滑动、deltaY 为 0 的情况不理
      const step = 5;
      const next = Math.min(
        100,
        Math.max(0, this.currentVolume + (e.deltaY < 0 ? step : -step)),
      );
      // 已经 0 / 100：照样 preventDefault（别让滚轮漏到页面去），但不白发一次事件
      if (next === this.currentVolume) return;
      this.playback.changeVolume(next);
    },
    onPointerMove(e: PointerEvent) {
      if (this.isVideoDragging) this.calcProgress(e);
      else if (this.isSoundDragging) this.calcVolume(e);
    },
    onPointerUp(e: PointerEvent) {
      this.endDrag(e);
    },
    /**
     * 拖拽收尾：`pointerup` / `pointercancel` / `lostpointercapture` 都走这里
     *
     * 只挂 `pointerup` 是不够的：指针被系统取消（触控被打断、拖动中锁屏 / Alt+Tab、
     * 窗口失焦）时不会再有 `pointerup`，`isVideoDragging` / `isSoundDragging` 会永久为真 ——
     * 进度显示被冻在 `draggingTime`、真实播放进度再也不更新，音量条也被钉在展开态。
     */
    endDrag(e?: PointerEvent) {
      if (e && this.activeEl) {
        try {
          this.activeEl.releasePointerCapture(e.pointerId);
        } catch {
          /* 指针可能已经释放，忽略 */
        }
      }
      this.activeEl = null;
      if (this.isVideoDragging) {
        this.isVideoDragging = false;
      }
      if (this.isSoundDragging) {
        this.isSoundDragging = false;
      }
    },
    calcProgress(e: PointerEvent) {
      const el =
        this.activeEl ||
        (this.$el as HTMLElement).querySelector<HTMLElement>('#progressContainer');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pos = Math.min(Math.max(0, (e.clientX - rect.left) / rect.width), 1);
      this.draggingTime = pos * this.duration;
      this.playback.changeTime(this.draggingTime);
    },
    calcVolume(e: PointerEvent) {
      const el =
        this.activeEl ||
        (this.$el as HTMLElement).querySelector<HTMLElement>('#volume-track');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = rect.bottom - e.clientY;
      const pct = Math.min(Math.max(0, y / rect.height), 1);
      this.draggingVolume = Math.round(pct * 100);
      this.playback.changeVolume(this.draggingVolume);
    },
  },
  computed: {
    /**
     * 这些 store（播放状态按域拆成了多个）
     *
     * 控制栏显示的一切（标题 / 封面 / 清晰度 / 进度 / 音量）都是播放状态，
     * 以前由 App.vue 逐个 props 传进来、操作再 emit 回去 —— 那层搬运没有信息量。
     * 现在直接读写 store：下面这些同名 computed 就是原来那些 props 的同义替换，
     * 模板一行都不用改。
     *
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    window() {
      return useWindowStore();
    },
    playback() {
      return usePlaybackStore();
    },
    queue() {
      return useQueueStore();
    },
    ui() {
      return useUiStore();
    },
    /** 标题：视频标题优先，没有就用「歌名 - 歌手」 */
    videoName(): string {
      return this.queue.videoName || this.queue.songDisplayName;
    },
    /** 当前封面（歌曲专辑图或视频缩略图） */
    cover(): string {
      return this.playback.currentCover() || '';
    },
    /** 副标题：歌手 · 专辑 / UP 主 · 列表名 */
    subtitle(): string {
      return this.queue.controlsSubtitle;
    },
    /** 正在播的视频清晰度标签（例如 1080P），为空则不显示 */
    quality(): string {
      return this.playback.videoQuality;
    },
    /** 清晰度 + 分辨率，用于悬浮提示 */
    qualityDetail(): string {
      return this.playback.videoQualityDetail;
    },
    /** 正在播的音频流音质（例如 192K） */
    audioQuality(): string {
      return this.playback.audioQuality;
    },
    audioQualityDetail(): string {
      return this.playback.audioQualityDetail;
    },
    /** 这个视频当前可选的清晰度 / 音质 */
    qualityOptions(): QualityOptionsPayload | null {
      return this.playback.qualityOptions;
    },
    /** 当前实际在播的清晰度代码（qn）；durl 时为空 */
    videoQn(): number | null {
      return this.playback.currentVideoQn;
    },
    /** 当前实际在播的音频流 id；durl 时为空 */
    audioId(): number | null {
      return this.playback.currentAudioId;
    },
    /** 播放模式（顺序 / 随机 / 单曲） */
    currentMode(): number {
      return this.queue.currentMode;
    },
    currentVolume(): number {
      return this.playback.currentVolume;
    },
    isMuted(): boolean {
      return this.playback.isMuted;
    },
    currentTime(): number {
      return this.playback.currentTime;
    },
    duration(): number {
      return this.playback.duration;
    },
    paused(): boolean {
      return this.playback.paused;
    },
    listType(): string {
      return this.ui.listType;
    },
    /**
     * 当前工作区：`ov` / `mv`
     *
     * 只影响**文案与图标取舍**，不影响播放。所有派生项都收在 `modeUi` 里：
     * **模板不要再直接判 `mode === 'ov'`**，要加一项就加在那里。
     */
    mode(): string {
      return this.queue.mode;
    },
    /**
     * 有网络请求在飞（搜索 / 解析地址）时为 true
     *
     * 用于禁用**会再发请求的控件**，防请求风暴（B站 412 风控）。
     * ⚠️ 只禁「会发请求的」——播放 / 暂停 / 音量 / 进度这些本地功能不禁。
     */
    busy(): boolean {
      return this.ui.netBusy;
    },
    /**
     * 清晰度 / 音质下拉是否该禁用
     *
     * 比 `busy` 多一个来源：刚改过清晰度/音质的 3 秒冷却。
     * 不用 `busy` 是因为切歌按钮没必要因为「刚改过清晰度」被禁 3 秒。
     */
    qualityBusy(): boolean {
      return this.ui.qualityBusy;
    },
    /**
     * 按工作区切换的文案
     *
     * 只剩「上一个视频 / 上一首」这一类**纯文案**了：两个列表按钮各自的图标和
     * 名字现在都是固定的（见模板顶部），不再需要在这里按模式分叉。
     *
     * 这里保留一个对象而不是两个 computed，是为了让模板只写 `modeUi.prevTitle`，
     * 不至于哪天又有人往 `<i :title="mode === 'ov' ? …">` 那样散回去。
     */
    modeUi(): { prevTitle: string; nextTitle: string } {
      const ov = this.mode === 'ov';
      return {
        prevTitle: ov ? '上一个视频' : '上一首',
        nextTitle: ov ? '下一个视频' : '下一首',
      };
    },
    /**
     * 跑马灯标题（净化过的 HTML）
     *
     * 保留 B 站搜索结果的 `<em>` 关键词高亮，其余标签一律转义 —— 标题是第三方数据，
     * 直接 `v-html="videoName"` 是可以注入的（`<img src=x onerror=…>`）。
     */
    safeVideoName(): string {
      return sanitizeTitleHtml(this.videoName);
    },
    /** 封面地址（规整成绝对 https，避免协议相对 URL 在 file:// 下坏掉） */
    coverUrl(): string {
      return normalizeImageUrl(this.cover) ?? '';
    },
    /** 可选清晰度列表 */
    videoChoices(): QualityOptionPayload[] {
      return this.qualityOptions?.video ?? [];
    },
    /** 可选音质列表 */
    audioChoices(): QualityOptionPayload[] {
      return this.qualityOptions?.audio ?? [];
    },
    /**
     * 当前在播的清晰度代码
     *
     * 优先用主进程给的 `videoQn`；durl 兜底时没有 dash 信息，
     * 就按展示名反查（菜单里用来把当前项置灰）。
     */
    currentQn(): number | null {
      if (typeof this.videoQn === 'number') return this.videoQn;
      return this.videoChoices.find((o) => o.label === this.quality)?.id ?? null;
    },
    /** 当前在播的音频流 id（同 currentQn，durl 时回退按标签反查） */
    currentAudioId(): number | null {
      if (typeof this.audioId === 'number') return this.audioId;
      return this.audioChoices.find((o) => o.label === this.audioQuality)?.id ?? null;
    },
    qualityTitle(): string {
      const base = `视频清晰度：${this.qualityDetail || this.quality}`;
      return this.videoChoices.length > 1 ? `${base}（点击切换）` : base;
    },
    audioTitle(): string {
      const base = `音质：${this.audioQualityDetail || this.audioQuality}`;
      return this.audioChoices.length > 1 ? `${base}（点击切换）` : base;
    },
    progress(): number {
      /**
       * 必须收口到 0~1
       *
       * 切清晰度、重新解析期间 `duration` 会短暂为 0 或变小，此时 `currentTime > duration`，
       * 不收口就会算出 >100% 的宽度 —— 进度条和右侧滑块直接画到容器外面去。
       */
      const raw =
        (this.isVideoDragging ? this.draggingTime : this.currentTime) /
        (this.duration || 1);
      return Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));
    },
  },
  watch: {
    /** 换封面就把失败标记清掉，给新地址一次机会 */
    coverUrl(): void {
      this.coverFailed = false;
    },
  },
});
</script>

<style>
#VideoControls {
  /* 配色/圆角/模糊全部走主题令牌，和歌单面板、弹窗保持同一套风格 */
  color: var(--glass-text);
  position: fixed;
  bottom: 5%;
  left: 50%;
  user-select: none;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: var(--glass-radius);
  padding: 20px;
  min-width: 10vw;
  max-width: 50vw;
  transform: translate(-50%, 0%);
  /* 未悬停时的不透明度由固定的 --ui-idle-opacity 决定（鼠标移上去变 1） */
  opacity: var(--ui-idle-opacity);
  transition: all 0.5s ease-in-out;
  font-size: 5vh;
  /* 白字 + 黑阴影（深色主题换成白阴影），压在亮/暗视频上都看得清 */
  text-shadow: var(--glass-shadow);
}
#VideoControls:hover {
  opacity: 1;
  box-shadow: var(--glass-shadow);
}
.videoName-container {
  overflow: hidden;
  white-space: nowrap;
  position: relative;
  width: 100%;
}
.videoName-scroll {
  display: inline-flex;
  gap: 5em;
  text-shadow: var(--glass-shadow);
  animation: scroll-left 10s linear infinite;
}
.videoName-scroll.paused {
  animation-play-state: paused;
}
.videoName-container:hover .videoName-scroll {
  animation-play-state: paused;
}
.videoName-scroll span {
  white-space: nowrap;
}
@keyframes scroll-left {
  0% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(calc(-50% - 1.5em));
  }
}
#controls {
  display: flex;
  align-items: center;
  justify-content: space-evenly;
}
#controls i {
  /*
   * 只缩字形，不动按钮高度。
   *
   * 这里必须显式 `height` + `inline-flex`：`sound` 那个图标在 `.audio-control`
   * （inline-block）里面，行内元素的 `height` 不生效、盒子高度会跟着字号一起缩，
   * 于是它的点击区域会比别的按钮小一圈。统一成 10vh 的 inline-flex 就不会了。
   */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 7vh;
  height: 10vh;
  line-height: 1;
}
/*
 * 请求进行中被禁用的控件（切歌按钮 / 清晰度、音质下拉）
 *
 * 只做视觉弱化 + `cursor: not-allowed`，**点击已经在模板里拦住了**
 * （`@click="busy ? null : ..."`）—— 样式只是给用户一个「现在点了没用」的反馈，
 * 不承担拦截职责（免得有人以为改样式就能解禁）。
 */
#controls i.ctrl-disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}
.audio-control {
  position: relative;
  display: inline-block;
  cursor: pointer;
}
.audio-control .volume-slider {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: 30px;
  height: 120px;
  background: rgba(var(--text-rgb), 0.8);
  border-radius: 4px;
  padding: 8px 5px;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.2s,
    visibility 0.2s;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 8px;
}
.audio-control:hover .volume-slider {
  opacity: 1;
  visibility: visible;
}
.show {
  opacity: 1 !important;
  visibility: visible !important;
}
.volume-track {
  width: 4px;
  height: 100%;
  background: rgba(var(--text-rgb), 0.3);
  box-shadow: var(--glass-shadow);
  border-radius: 2px;
  position: relative;
  touch-action: none;
}
.volume-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 70%;
  background: rgb(var(--text-rgb));
  border-radius: 2px;
  transition: height 0.1s ease;
}
.volume-thumb {
  position: absolute;
  left: 50%;
  bottom: 70%;
  transform: translate(-50%, 50%);
  width: 12px;
  height: 12px;
  background: rgb(var(--text-rgb));
  border-radius: 50%;
  cursor: pointer;
  box-shadow: var(--glass-shadow);
  transition: bottom 0.1s ease;
}
.volume-number {
  font-size: 2vh;
}
.time {
  font-size: 14px;
  min-width: 60px;
  text-align: center;
  text-shadow: var(--glass-shadow);
}
.progressContainer {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 5px;
  /* 现在是「标题 → 进度条 → 按钮」的顺序，所以上下都要留白 */
  margin: 15px 0;
  position: relative;
}
.progressWrapper {
  flex: 1;
  height: 5px;
  background-color: rgba(var(--text-rgb), 0.3);
  position: relative;
  touch-action: none;
  cursor: pointer;
}
.progressBar {
  height: 100%;
  background-color: rgba(var(--text-rgb), 0.8);
  box-shadow: var(--glass-shadow);
  position: relative;
}
.progressHandle {
  position: absolute;
  right: -5px;
  top: 50%;
  transform: translateY(-50%);
  width: 15px;
  height: 15px;
  background-color: rgb(var(--text-rgb));
  border-radius: 50%;
  box-shadow: var(--glass-shadow);
  display: none;
}
#VideoControls:hover .progressHandle {
  display: block;
}
/* #region 当前播放（封面 + 标题 + 副标题） */
.now-playing {
  display: flex;
  align-items: center;
  gap: 0.28em;
  /* 关键：给 flex 行明确上限 + min-width:0，
     否则里面的封面会被标题行拉伸（实测曾被撑到 800x65，整条控件栏高达 349px） */
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.np-cover {
  flex: 0 0 auto;
  /* 只管高度，宽度按原图比例自适应；左右留白、图片居中 */
  height: 1.3em;
  min-height: 34px;
  max-height: 58px;
  min-width: 1.3em;
  padding: 0 0.12em;
  border-radius: 0.16em;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--glass-border);
  display: flex;
  align-items: center;
  justify-content: center;
}
.np-cover img {
  height: 100%;
  width: auto;
  max-width: 4em;
  object-fit: contain;
  display: block;
}
.np-cover-fallback {
  color: var(--glass-text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
}
.np-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}
.np-sub {
  display: flex;
  align-items: center;
  gap: 0.4em;
  min-width: 0;
  margin-top: 0.04em;
  font-size: 0.4em;
  line-height: 1.3;
}
/* el-dropdown 的包裹元素默认 inline-block，这里让它不参与收缩 */
.np-sub :deep(.el-dropdown) {
  flex: 0 0 auto;
}
.np-subtitle {
  flex: 1 1 auto;
  min-width: 0;
  /* 副标题（歌曲名 - 歌手 · 专辑）也要跟「字体颜色」设置走 */
  color: var(--glass-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: var(--glass-shadow);
}
/* 清晰度 / 音质小标签：不参与收缩，永远贴在最右边；点开是切换菜单 */
.np-quality {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.18em;
  font-size: 0.92em;
  line-height: 1;
  padding: 0.24em 0.5em;
  border-radius: 0.35em;
  color: var(--glass-text);
  letter-spacing: 0.02em;
  white-space: nowrap;
  cursor: pointer;
  background: rgba(var(--text-rgb), 0.22);
  border: 1px solid rgba(var(--text-rgb), 0.4);
  text-shadow: var(--glass-shadow);
}
.np-quality:hover {
  background: rgba(var(--text-rgb), 0.34);
}
.np-caret {
  font-size: 0.8em;
  opacity: 0.8;
  transform: translateY(-0.05em);
}
/* #endregion */
</style>
