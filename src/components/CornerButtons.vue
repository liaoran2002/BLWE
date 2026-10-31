<!--
  右下角全屏按钮 + 左下角锁定按钮

  锁定后把标题栏、控制栏、歌单入口全隐藏，只留这两个；再点一次（或按 S）解锁。
  图标字体里没有锁，所以锁定按钮用内联 SVG。
-->
<template>
    <div
      class="fullscreen-btn"
      @click="window.toggleFullscreen()"
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
      @click="window.toggleLock()"
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
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { useWindowStore } from '../stores/window';

export default defineComponent({
  name: 'CornerButtons',
  computed: {
    /*
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    window() {
      return useWindowStore();
    },
    wallpaperEnabled(): boolean {
      return this.window.wallpaperEnabled;
    },
    isFullscreen(): boolean {
      return this.window.isFullscreen;
    },
    locked(): boolean {
      return this.window.locked;
    },
  },
});
</script>

<style scoped>
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
