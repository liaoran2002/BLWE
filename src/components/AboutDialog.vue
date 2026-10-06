<template>
  <!--
    「关于」弹窗

    和其它弹窗一样：没有右上角叉号，点空白处关闭，
    提示「点击空白位置关闭」由 App.vue 里遮罩的 ::after 统一提供。
  -->
  <el-dialog
    :model-value="modelValue"
    title="关于"
    width="440px"
    :show-close="false"
    align-center
    @update:model-value="(v: boolean) => $emit('update:modelValue', v)"
  >
    <div class="ab-body">
      <div class="ab-avatars">
        <div class="ab-person">
          <img class="ab-avatar" :src="devAvatar" alt="作者头像" />
          <div class="ab-name">作者</div>
          <div class="ab-role">liaoran2002</div>
        </div>
        <div class="ab-heart">❤</div>
        <div class="ab-person">
          <img class="ab-avatar" :src="aiAvatar" alt="DeepSeek 大肥鱼" />
          <div class="ab-name">大肥鱼</div>
          <div class="ab-role">DeepSeek</div>
        </div>
      </div>

      <div class="ab-title">BiLiMusicVideo(简称:BLMV)</div>
      <div class="ab-desc">把音乐歌单变成 B 站视频播放列表的桌面播放器</div>

      <div class="ab-link" title="用系统浏览器打开" @click="openRepo">
        https://github.com/liaoran2002/BiLiMusicVideo
      </div>

      <div class="ab-thanks">大肥鱼，没有你我写不出来啊！<br>虽然花了我38.53块钱加6元鲸圆券！但是你不是吃白饭的大肥鱼！</div>
    </div>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api/electron';

/**
 * 仓库地址
 *
 * 用 `new URL(..., import.meta.url)` 引静态图：Vite 会在构建时把它换成产物里的真实路径，
 * 既不用给 `*.jpg` 补模块声明，也不会在打包后 404。
 */
const REPO_URL = 'https://github.com/liaoran2002/BiLiMusicVideo';

export default defineComponent({
  name: 'AboutDialog',
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      devAvatar: new URL('../assets/avatar.jpg', import.meta.url).href,
      aiAvatar: new URL('../assets/avatar-fish.jpg', import.meta.url).href,
    };
  },
  methods: {
    /** 交给系统浏览器打开（主进程只放行 http/https） */
    async openRepo(): Promise<void> {
      try {
        const ok = await api.openExternal(REPO_URL);
        if (!ok) ElMessage.warning('链接被拒绝了');
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err));
      }
    },
  },
});
</script>

<style scoped>
.ab-body {
  text-align: center;
}
.ab-avatars {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  margin: 4px 0 18px;
}
.ab-person {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.ab-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--panel-border);
  background: var(--panel-hover);
}
.ab-name {
  font-size: 13px;
  font-weight: 600;
}
.ab-role {
  font-size: 11px;
  opacity: 0.6;
}
.ab-heart {
  font-size: 16px;
  opacity: 0.75;
  color: var(--accent-danger);
}
.ab-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.ab-desc {
  font-size: 12px;
  opacity: 0.75;
  margin-top: 6px;
  line-height: 1.6;
}
.ab-link {
  display: inline-block;
  margin-top: 12px;
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
  word-break: break-all;
}
.ab-link:hover {
  color: rgb(var(--text-rgb));
}
.ab-thanks {
  margin-top: 16px;
  font-size: 12px;
  opacity: 0.6;
}
</style>
