<template>
  <!--
    左上角歌单入口

    只做一件事：点一下打开「歌单管理」弹窗（切换歌单 / 同步 / 新建编辑 / 曲目全在那边）。
    原来这里还有个快捷下拉菜单，已经去掉 —— 两套入口容易状态打架，而且用户点开只为了进管理。
    hover 表现和标题栏其它按钮一致：只换背景，不动透明度。
  -->
  <div class="pl-trigger" :title="triggerTitle" @click="manage">
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
    <span class="pl-trigger-name">{{ currentName }}</span>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { usePlaylistStore } from '../stores/playlists';
import { useVideoListStore } from '../stores/videoLists';
import { useQueueStore } from '../stores/queue';
import { useUiStore } from '../stores/ui';

export default defineComponent({
  name: 'PlaylistPanel',
  computed: {
    /**
     * 当前工作区：决定这里显示哪个源的名字、点开哪个管理器
     *
     * 以前是 AppTitlebar 传下来的 prop、点一下 emit 上去 —— 现在直接读 store，
     * 点一下也直接叫管理器。这个入口只有「当前模式」一个输入，没必要绕。
     */
    mode(): string {
      return this.queue.mode;
    },
    /*
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    queue() {
      return useQueueStore();
    },
    ui() {
      return useUiStore();
    },
    playlistsStore() {
      return usePlaylistStore();
    },
    videoListsStore() {
      return useVideoListStore();
    },
    triggerTitle(): string {
      return this.mode === 'ov' ? '视频管理' : '歌单管理';
    },
    /**
     * 入口上显示的名字
     *
     * 两种来源共用一个入口：按模式显示对应的源，正在播另一边时才回落到播放源
     * （否则切到 MV 后左上角还写着收藏夹的名字，用户以为没切过来）。
     */
    currentName(): string {
      const playingVideoList = this.videoListsStore.active?.name || '';
      const playingPlaylist = this.playlistsStore.current?.name || '';
      if (this.mode === 'ov') {
        return playingVideoList || playingPlaylist || '还没有视频列表';
      }
      return playingPlaylist || playingVideoList || '还没有歌单';
    },
  },
  methods: {
    /** 点整个入口 = 打开对应那一页管理器 */
    manage(): void {
      void this.ui.openManager(this.mode === 'ov' ? 'ov' : 'mv');
    },
  },
});
</script>

<style scoped>
.pl-trigger {
  /* 和标题栏其它按钮（.titlebar-btn）同一套值，别各写一套 */
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  max-width: 220px;
  margin: 0 6px;
  color: var(--glass-text);
  font-size: 15px;
  border-radius: 8px;
  cursor: pointer;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  text-shadow: var(--glass-shadow);
  /* 悬停只换背景，不做透明度变化 */
  transition: background 0.15s;
  opacity: 1;
}
.pl-trigger:hover {
  background: var(--glass-bg-strong);
}
.pl-trigger-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}
</style>
