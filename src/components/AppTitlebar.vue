<!--
  标题栏：左边歌单入口，中间拖拽区，右边定时 / 壁纸 / 账户 / 设置 / 窗口按钮

  壁纸模式下整条隐藏（用户要求）：那时候窗口就是一块桌面背景，所有操作走托盘菜单。
  用 class 而不是 v-if —— 组件不卸载，内部状态不会丢。

  只读 store、只调 store：显示什么从 `player` 里取，点完直接叫对应的方法。
-->
<template>
    <div class="titlebar" :class="{ 'wm-hidden': wallpaperEnabled || locked }">
      <!-- 左侧：歌单入口（点一下直接打开歌单管理弹窗，没有二级菜单） -->
      <div class="titlebar-left">
        <PlaylistPanel />
      </div>
      <!-- 中间：拖拽区 -->
      <div class="titlebar-drag"
        @mousedown="window.onTitlebarMouseDown($event)"
        @dblclick="window.onTitlebarDblClick($event)"
      ></div>
      <!-- 右侧：定时暂停 / 壁纸 / 头像 / 设置 / 窗口按钮 -->
      <div class="titlebar-right">
        <!--
          定时暂停 / 定时关闭

          三种显示：
            · 没定时   —— 「定时」
            · 倒计时中 —— 剩余时间（`1:23:45` / `23:45`），强调色
            · 已归零、等视频播完 —— `00:00`，**红色**（用户要求）
        -->
        <div
          class="titlebar-btn sleep-trigger"
          :class="{
            'sleep-trigger--active': sleepActive && !sleepPending,
            'sleep-trigger--waiting': sleepPending,
          }"
          @click="sleep.sleepPanelVisible = true"
          :title="
            sleepPending
              ? '计时已结束，等待视频播放完毕（点击修改或取消）'
              : sleepActive
                ? `${sleepText} 后${sleepActionText}（点击修改或取消）`
                : '定时暂停 / 定时关闭'
          "
        >
          {{ sleepActive ? sleepText : '定时' }}
        </div>
        <div class="titlebar-btn" @click="window.toggleWallpaper()">
          {{ wallpaperEnabled ? '窗口模式' : '壁纸模式' }}
        </div>
        <div class="user-info" @click="session.handleLogoutConfirm()">
          <img
            v-if="userFace"
            :src="userFace"
            class="user-avatar"
            referrerpolicy="no-referrer"
          />
          <span class="user-name">{{ userName || '未登录' }}</span>
        </div>
        <div class="win-btn" @click="ui.settingsVisible = true" title="设置">
          <i class="iconfont icon-shezhi"></i>
        </div>
        <div class="win-btn" @click="ui.aboutVisible = true" title="关于">
          <i class="iconfont icon-guanyu"></i>
        </div>
        <div
          class="win-btn"
          @click="window.winMinimize()"
          title="最小化"
          v-if="!wallpaperEnabled"
        >
          <i class="iconfont icon-zuixiaohua"></i>
        </div>
        <div
          class="win-btn"
          @click="window.winMaximize()"
          :title="isMaximized || isFullscreen ? '向下还原' : '最大化'"
          v-if="!wallpaperEnabled"
        >
          <i
            class="iconfont"
            :class="isMaximized || isFullscreen ? 'icon-xiangxiahuanyuan' : 'icon-chuangti-zuidahua'"
          ></i>
        </div>
        <div class="win-btn win-close" @click="window.winClose()" title="关闭">
          <i class="iconfont icon-guanbi"></i>
        </div>
      </div>
    </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import PlaylistPanel from './PlaylistPanel.vue';
import { useWindowStore } from '../stores/window';
import { useSleepStore } from '../stores/sleep';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import { useQueueStore } from '../stores/queue';

export default defineComponent({
  name: 'AppTitlebar',
  components: { PlaylistPanel },
  computed: {
    /**
     * 这些 store（播放状态按域拆成了多个）
     *
     * 标题栏要显示的东西（歌名 / 模式 / 定时状态 / 用户）全都已经在 store 里了，
     * 再让 App.vue 一个个传下来只是搬运 —— 这里直接读。
     *
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    window() {
      return useWindowStore();
    },
    sleep() {
      return useSleepStore();
    },
    session() {
      return useSessionStore();
    },
    ui() {
      return useUiStore();
    },
    queue() {
      return useQueueStore();
    },
    /** 当前工作区：`ov` = 视频列表，`mv` = 音乐歌单 */
    mode(): string {
      return this.queue.mode;
    },
    wallpaperEnabled(): boolean {
      return this.window.wallpaperEnabled;
    },
    locked(): boolean {
      return this.window.locked;
    },
    /** 定时暂停的三种显示状态 */
    sleepActive(): boolean {
      return this.sleep.sleepState.active;
    },
    sleepPending(): boolean {
      return this.sleep.sleepState.pending;
    },
    sleepText(): string {
      return this.sleep.sleepRemainText;
    },
    sleepActionText(): string {
      return this.sleep.sleepActionText;
    },
    userFace(): string {
      return this.session.userFace;
    },
    userName(): string {
      return this.session.userName;
    },
    isMaximized(): boolean {
      return this.window.isMaximized;
    },
    isFullscreen(): boolean {
      return this.window.isFullscreen;
    },
  },
});
</script>

<style scoped>
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
/**
 * 定时暂停按钮
 *
 * 三种显示：
 *  · 没定时   —— 「定时」
 *  · 倒计时中 —— 剩余时间（`1:23:45` / `23:45`），强调色
 *  · 已归零、在等视频播完 —— `00:00`，**红色**（`--accent-danger`）
 *
 * `tabular-nums` 是必须的：倒计时每秒刷新，数字宽度不一样会让按钮左右抖动。
 */
.sleep-trigger {
  font-variant-numeric: tabular-nums;
}
.sleep-trigger--active {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
/* 计时已结束、正在等视频播完：红色，提示「马上要执行了」 */
.sleep-trigger--waiting {
  border-color: var(--accent-danger);
  color: var(--accent-danger);
  font-weight: 600;
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

</style>
