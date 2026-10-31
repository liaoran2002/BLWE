<!--
  缓冲提示

  切清晰度 / 切歌时 MSE 要重新拉流，没有任何反馈看起来就是「卡死了」。
  这里给出百分比，明确是「在缓冲」而不是「出问题了」。

  数据从播放 store 里取：百分比、圆环偏移、副标题都是 getter，这里只负责画。
-->
<template>
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
        <span class="buffer-percent">{{ percent }}%</span>
      </div>
      <div class="buffer-text">缓冲中…</div>
      <div class="buffer-sub">{{ subText }}</div>
    </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { usePlaybackStore } from '../stores/playback';

export default defineComponent({
  name: 'BufferOverlay',
  computed: {
    /*
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    playback() {
      return usePlaybackStore();
    },
    /** 是否显示（store 里换源后延迟 500ms 才亮，避免闪一下） */
    buffering(): boolean {
      return this.playback.buffering;
    },
    /** 0-100 */
    percent(): number {
      return this.playback.bufferPercent;
    },
    /** SVG 圆环的周长 / 绘制偏移 */
    ringLength(): number {
      return this.playback.ringLength;
    },
    ringOffset(): number {
      return this.playback.ringOffset;
    },
    /** 「已缓冲 3.2 秒」这类副标题 */
    subText(): string {
      return this.playback.bufferSubText;
    },
  },
});
</script>

<style scoped>
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
</style>
