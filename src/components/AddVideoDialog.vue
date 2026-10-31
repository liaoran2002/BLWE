<template>
  <!--
    「添加视频」弹窗

    和歌单管理一样是 el-dialog：没有右上角叉号，点空白处关闭，
    「点击空白位置关闭」的提示由 `styles/global.css` 里遮罩的 ::after 统一提供。

    流程：粘贴链接 / BV 号 -> 解析 -> 看到封面 + 标题 + UP 主 -> 确认 -> 加到这首歌的收藏里
  -->
  <el-dialog
    v-model="visible"
    width="560px"
    :show-close="false"
    align-center
  >
    <template #header>
      <div class="av-head">添加视频</div>
    </template>

    <div class="av-body">
      <!-- 输入框 + 解析 -->
      <div class="av-row">
        <el-input
          v-model="input"
          placeholder="粘贴 B 站视频链接或 BV 号（支持分享短链）"
          clearable
          @keyup.enter="parse"
        />
        <el-button type="primary" :loading="parsing" @click="parse">解析</el-button>
      </div>

      <!-- 解析结果预览：左封面、右标题 + UP 主 -->
      <div v-if="info" class="av-preview">
        <div class="av-cover">
          <img
            v-if="coverUrl && !coverFailed"
            :src="coverUrl"
            alt=""
            referrerpolicy="no-referrer"
            @error="coverFailed = true"
          />
          <div v-else class="av-cover-fallback">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
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
        <div class="av-meta">
          <div class="av-title" :title="info.title">{{ info.title || '（没有标题）' }}</div>
          <div class="av-author">{{ info.author || '未知 UP 主' }}</div>
          <div class="av-bvid">{{ info.bvid }}</div>
        </div>
      </div>
      <div v-else class="av-empty">
        {{ parsed ? '解析成功后会显示封面与标题' : '把 B 站视频链接粘到上面，点「解析」' }}
      </div>

      <!-- 确认 / 取消 -->
      <div class="av-actions">
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :disabled="!info" @click="confirm">确认</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage } from 'element-plus';
import type { ParsedVideoInfo } from '@common/types/ipc';
import api from '../api/electron';
import { normalizeImageUrl } from '../utils/image';
import { useUiStore } from '../stores/ui';

export default defineComponent({
  name: 'AddVideoDialog',
  data() {
    return {
      input: '',
      parsing: false,
      /** 是否解析过（决定提示文案，只是文案差异） */
      parsed: false,
      info: null as ParsedVideoInfo | null,
      coverFailed: false,
      /** 解析请求序号：关闭弹窗 / 重新解析都会 +1，用来丢弃过期响应 */
      _req: 0,
    };
  },
  computed: {
    /**
     * 这些 store（播放状态按域拆成了多个）
     *
     * 开关在 `ui.addVideoVisible`，确认后要做的事（把视频加进收藏）
     * 也是 player 的 action —— 这个弹窗不需要父组件参与。
     *
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    ui() {
      return useUiStore();
    },
    visible: {
      get(): boolean {
        return this.ui.addVideoVisible;
      },
      set(v: boolean) {
        this.ui.addVideoVisible = v;
      },
    },
    coverUrl(): string | null {
      return normalizeImageUrl(this.info?.pic ?? null);
    },
  },
  watch: {
    visible(v: boolean) {
      // 每次打开都是一张干净的空白表单；关闭时丢掉上次的结果
      if (v) {
        this.input = '';
        this.parsed = false;
        this.info = null;
        this.coverFailed = false;
        this.parsing = false;
      } else {
        /**
         * 关闭时把在飞的解析请求作废
         *
         * 组件实例是复用的（el-dialog 只是收起内容），点「解析」后立刻关掉再打开时，
         * 旧响应会写进已经重置过的新表单 —— 表现是「一打开就冒出上次的视频预览」，
         * 接着点「确认」就把那个不相干的视频收藏进了当前歌曲。
         */
        this._req += 1;
        this.parsing = false;
      }
    },
  },
  methods: {
    errMsg(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
    },
    async parse(): Promise<void> {
      const text = this.input.trim();
      if (!text) {
        ElMessage.warning('请先粘贴视频链接或 BV 号');
        return;
      }
      // 请求序号：回来时对不上就丢弃（弹窗已关闭 / 又发起了一次解析）
      const req = ++this._req;
      this.parsing = true;
      this.coverFailed = false;
      try {
        const info = await api.parseVideo(text);
        if (req !== this._req) return;
        this.info = info;
        this.parsed = true;
      } catch (err) {
        if (req !== this._req) return;
        this.info = null;
        ElMessage.error(this.errMsg(err));
      } finally {
        if (req === this._req) this.parsing = false;
      }
    },
    confirm(): void {
      if (!this.info) return;
      void this.ui.onAddVideo(this.info);
      this.close();
    },
    close(): void {
      this.visible = false;
    },
  },
});
</script>

<style scoped>
.av-head {
  font-weight: 600;
}
.av-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.av-row {
  display: flex;
  gap: 10px;
}
.av-preview {
  display: flex;
  gap: 14px;
  padding: 12px;
  border-radius: 10px;
  background: var(--panel-hover);
  min-height: 96px;
}
.av-cover {
  flex: none;
  width: 150px;
  height: 88px;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.av-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.av-cover-fallback {
  color: var(--panel-text-dim, var(--panel-text));
  opacity: 0.7;
}
.av-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  justify-content: center;
}
.av-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--panel-text);
  /* 最多两行，超出省略（B 站标题很长） */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.av-author {
  font-size: 12px;
  color: var(--panel-text);
  opacity: 0.75;
}
.av-bvid {
  font-size: 12px;
  color: var(--panel-text);
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.av-empty {
  font-size: 12px;
  color: var(--panel-text);
  opacity: 0.55;
  padding: 4px 2px;
}
.av-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
