<template>
  <!--
    左上角歌单入口

    只做一件事：点一下打开「歌单管理」弹窗（切换歌单 / 同步 / 新建编辑 / 曲目全在那边）。
    原来这里还有个快捷下拉菜单，已经去掉 —— 两套入口容易状态打架，而且用户点开只为了进管理。
    hover 表现和标题栏其它按钮一致：只换背景，不动透明度。
  -->
  <div class="pl-trigger" :title="triggerTitle" @click="$emit('manage')">
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

export default defineComponent({
  name: 'PlaylistPanel',
  emits: ['manage'],
  props: {
    /** 当前工作区：决定这里显示哪个源的名字、点开哪个管理器 */
    mode: { type: String, default: 'ov' },
  },
  computed: {
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
