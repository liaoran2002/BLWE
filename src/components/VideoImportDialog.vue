<!--
  「添加视频」的确认框

  流程和 MV 那边的 AddVideoDialog 一致：贴链接 → 解析 → 看到详情 → 确认 → 落库。
  差别只有两处：

   1. 贴**合集 / 收藏夹 / 系列**链接时，预览是「列表详情 + 下面每条视频」，
      而不是一个视频；
   2. 确认后写的是本地列表（单条置顶、一批追加末尾），不涉及歌曲搜索。

  为什么做成 VideoListManager 的局部子组件、而不是像 AddVideoDialog 那样挂全局：
  它只服务「往这个弹窗里选中的列表加东西」这一件事，开关和目标列表就是父组件的局部状态；
  塞进 `ui` store 会多出三个没人共用的字段。

  ⚠️ 预览只是**读**：用户点取消不会留下任何东西（主进程那个接口不写库）。
-->
<template>
  <el-dialog
    v-model="visible"
    width="620px"
    :show-close="false"
    align-center
    append-to-body
  >
    <template #header>
      <div class="vi-head">添加到《{{ listName }}》</div>
    </template>

    <div class="vi-body">
      <div class="vi-row">
        <el-input
          v-model="input"
          placeholder="视频链接 / BV 号 / 合集 / 收藏夹 / 系列链接"
          clearable
          @keyup.enter="parse"
        />
        <el-button type="primary" :loading="loading" @click="parse">解析</el-button>
      </div>

      <!-- 单条视频 -->
      <div v-if="result?.type === 'video'" class="vi-single">
        <div class="vi-cover">
          <img
            v-if="coverOf(result.item.cover) && !coverFailed"
            :src="coverOf(result.item.cover) as string"
            alt=""
            referrerpolicy="no-referrer"
            @error="coverFailed = true"
          />
        </div>
        <div class="vi-meta">
          <div class="vi-title" :title="result.item.title">
            {{ result.item.title || result.item.bvid }}
          </div>
          <div class="vi-sub">
            {{ result.item.author || '未知 UP 主' }}
            <span v-if="result.item.duration">{{ durationText(result.item.duration) }}</span>
          </div>
          <div class="vi-bvid">{{ result.item.bvid }}</div>
        </div>
      </div>

      <!-- 整个列表 -->
      <div v-else-if="result?.type === 'list'" class="vi-list">
        <div class="vi-list-head">
          <div class="vi-cover vi-cover-sm">
            <img
              v-if="coverOf(result.cover) && !coverFailed"
              :src="coverOf(result.cover) as string"
              alt=""
              referrerpolicy="no-referrer"
              @error="coverFailed = true"
            />
          </div>
          <div class="vi-meta">
            <div class="vi-title" :title="result.name">{{ result.name }}</div>
            <div class="vi-sub">
              {{ kindLabel }} · {{ result.items.length }} 条可导入<template
                v-if="result.itemCount && result.itemCount > result.items.length"
              >（共 {{ result.itemCount }} 条，只取前 {{ result.items.length }}）</template>
            </div>
            <div v-if="result.skipped > 0" class="vi-warn">
              有 {{ result.skipped }} 个条目不支持（合集里的子合集 / 番剧），会跳过
            </div>
          </div>
        </div>

        <div class="vi-rows">
          <div v-for="(item, i) in result.items" :key="item.bvid" class="vi-row-item">
            <span class="vi-idx">{{ i + 1 }}</span>
            <div class="vi-thumb">
              <img
                v-if="coverOf(item.cover) && !failedCovers[item.bvid]"
                :src="coverOf(item.cover) as string"
                alt=""
                referrerpolicy="no-referrer"
                loading="lazy"
                @error="failedCovers[item.bvid] = true"
              />
            </div>
            <span class="vi-row-title" :title="item.title">{{ item.title || item.bvid }}</span>
            <span class="vi-row-author" :title="item.author || ''">{{ item.author || '未知 UP 主' }}</span>
            <span class="vi-row-dur">{{ durationText(item.duration) }}</span>
          </div>
        </div>
      </div>

      <div v-else class="vi-empty">
        {{
          loading
            ? '正在读取…'
            : input
              ? '点「解析」看看这个东西里有什么，确认之后才会写进列表'
              : '把视频 / 合集 / 收藏夹链接粘到上面'
        }}
      </div>

      <div class="vi-actions">
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :disabled="!result || result.type === 'none'" :loading="submitting" @click="confirm">
          {{ confirmText }}
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage } from 'element-plus';
import type { VideoImportPreview, VideoMetaInput } from '@common/types/playlist';
import { normalizeImageUrl } from '../utils/image';
import { useVideoListStore } from '../stores/videoLists';
import { useUiStore } from '../stores/ui';

export default defineComponent({
  name: 'VideoImportDialog',
  props: {
    visible: { type: Boolean, default: false },
    listId: { type: String, default: '' },
    listName: { type: String, default: '' },
  },
  emits: ['update:visible', 'done'],
  data() {
    return {
      input: '',
      loading: false,
      submitting: false,
      result: null as VideoImportPreview | null,
      coverFailed: false,
      /** 逐行封面加载失败（合集里有个别失效的封面很常见） */
      failedCovers: {} as Record<string, boolean>,
      /** 请求序号：关闭 / 重新解析都会 +1，回来对不上就丢掉 */
      _req: 0,
    };
  },
  computed: {
    shown: {
      get(): boolean {
        return this.visible;
      },
      set(v: boolean) {
        this.$emit('update:visible', v);
      },
    },
    store() {
      return useVideoListStore();
    },
    ui() {
      return useUiStore();
    },
    kindLabel(): string {
      const kind = this.result?.type === 'list' ? this.result.kind : '';
      if (kind === 'fav') return '收藏夹';
      if (kind === 'season') return '合集';
      if (kind === 'series') return '系列';
      return '列表';
    },
    confirmText(): string {
      if (this.result?.type === 'list') return `导入 ${this.result.items.length} 条`;
      return '添加';
    },
  },
  watch: {
    visible(v: boolean) {
      if (v) {
        this.input = '';
        this.result = null;
        this.coverFailed = false;
        this.failedCovers = {};
        this.loading = false;
        this.submitting = false;
      } else {
        // 关闭时把在飞的请求作废（组件实例是复用的，旧响应会写进下次打开的表单）
        this._req += 1;
        this.loading = false;
      }
    },
  },
  methods: {
    coverOf(url: string | null): string | null {
      return normalizeImageUrl(url);
    },
    durationText(sec: number | null): string {
      if (!sec || sec <= 0) return '';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    errMsg(err: unknown): string {
      return this.ui.errMsg(err);
    },
    async parse(): Promise<void> {
      const text = this.input.trim();
      if (!text) {
        ElMessage.warning('请先粘贴链接');
        return;
      }
      const req = ++this._req;
      this.loading = true;
      this.coverFailed = false;
      this.failedCovers = {};
      try {
        const result = await this.store.previewImport(text);
        if (req !== this._req) return;
        if (result.type === 'none') {
          this.result = null;
          ElMessage.warning('没认出这是什么：视频 / 合集 / 收藏夹 / 系列链接都行');
          return;
        }
        this.result = result;
      } catch (err) {
        if (req !== this._req) return;
        this.result = null;
        ElMessage.error('解析失败：' + this.errMsg(err));
      } finally {
        if (req === this._req) this.loading = false;
      }
    },
    async confirm(): Promise<void> {
      const p = this.result;
      if (!p || p.type === 'none') return;
      if (!this.listId) return;

      this.submitting = true;
      try {
        if (p.type === 'video') {
          const result = await this.store.addItem(this.listId, p.item as VideoMetaInput);
          ElMessage.success(
            result.existed
              ? `《${p.item.title || p.item.bvid}》已经在列表里，已置顶`
              : `已添加《${p.item.title || p.item.bvid}》`,
          );
        } else {
          const result = await this.store.addItems(this.listId, p.items);
          ElMessage.success(
            `已从《${p.name}》导入 ${result.added} 条` +
              (result.existed > 0 ? `（${result.existed} 条已在列表里）` : '') +
              (p.skipped > 0 ? `，跳过 ${p.skipped} 个不支持的条目` : ''),
          );
        }
        this.$emit('done');
        this.close();
      } catch (err) {
        ElMessage.error('添加失败：' + this.errMsg(err));
      } finally {
        this.submitting = false;
      }
    },
    close(): void {
      this.shown = false;
    },
  },
});
</script>

<style scoped>
.vi-head {
  font-weight: 600;
}
.vi-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.vi-row {
  display: flex;
  gap: 10px;
}
.vi-single {
  display: flex;
  gap: 14px;
  padding: 12px;
  border-radius: 10px;
  background: var(--panel-hover);
  min-height: 96px;
}
.vi-cover {
  flex: none;
  width: 150px;
  height: 88px;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
}
.vi-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.vi-cover-sm {
  width: 108px;
  height: 64px;
}
.vi-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  justify-content: center;
}
.vi-title {
  font-size: calc(14px * var(--fs));
  font-weight: 600;
  color: var(--panel-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.vi-sub {
  font-size: calc(12px * var(--fs));
  color: var(--panel-text);
  opacity: 0.75;
  display: flex;
  gap: 8px;
}
.vi-bvid {
  font-size: calc(12px * var(--fs));
  color: var(--panel-text);
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.vi-warn {
  font-size: calc(12px * var(--fs));
  color: var(--el-color-warning);
}
.vi-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.vi-list-head {
  display: flex;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  background: var(--panel-hover);
}
.vi-rows {
  max-height: 300px;
  overflow-y: auto;
  border-top: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
}
.vi-row-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--panel-border, rgba(255, 255, 255, 0.06));
  font-size: calc(12px * var(--fs));
}
.vi-idx {
  flex: none;
  width: 28px;
  text-align: right;
  opacity: 0.45;
  font-variant-numeric: tabular-nums;
}
.vi-thumb {
  flex: none;
  width: 64px;
  height: 36px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
}
.vi-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.vi-row-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vi-row-author {
  flex: none;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}
.vi-row-dur {
  flex: none;
  width: 44px;
  text-align: right;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
.vi-empty {
  font-size: calc(12px * var(--fs));
  color: var(--panel-text);
  opacity: 0.55;
  padding: 6px 2px;
}
.vi-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
