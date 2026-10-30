<template>
  <el-dialog
    v-model="visible"
    width="960px"
    :show-close="false"
    align-center
    @update:model-value="onVisibleChange"
  >
    <template #header>
      <div class="plm-head">
        <span class="plm-title">歌单管理</span>
        <span class="plm-summary">
          共 {{ store.playlists.length }} 个歌单 · {{ totalSongs }} 首
        </span>
      </div>
    </template>

    <div class="plm-body">
      <!-- 左：歌单列表 -->
      <div class="plm-side">
        <div class="plm-side-list">
          <div
            v-for="item in store.playlists"
            :key="item.id"
            class="plm-pl"
            :class="{ sel: item.id === selectedId, cur: item.id === store.currentId }"
            @click="selectedId = item.id"
          >
            <div class="plm-pl-main">
              <div class="plm-pl-name" :title="item.name">
                <span v-if="item.id === store.currentId" class="plm-dot" title="当前播放歌单"></span>
                {{ item.name }}
              </div>
              <div class="plm-pl-meta">
                <span>{{ item.songs.length }} 首</span>
                <span v-if="item.source" class="plm-tag">{{ sourceLabel(item.source) }}</span>
              </div>
            </div>
            <span
              class="plm-spin"
              :class="{ on: store.isSyncingOne(item.id) }"
              title="同步中"
              v-if="store.isSyncingOne(item.id)"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3.5H10"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </div>

          <div v-if="store.playlists.length === 0" class="plm-empty">
            还没有歌单，点下面「新建歌单」开始
          </div>
        </div>

        <div class="plm-side-actions">
          <div class="plm-side-row">
            <el-button size="small" type="primary" @click="startCreate">新建歌单</el-button>
            <el-button
              size="small"
              :disabled="store.playlists.length === 0 || store.isSyncing"
              :loading="store.isSyncing"
              @click="syncAll"
            >
              全部同步
            </el-button>
          </div>
          <!--
            切换工作区：点它 = 切到 OV 模式并打开「视频管理」

            放在这一排按钮**下面**（用户要求）：上面两个是「歌单管理」自己的动作，
            这个是「换个管理器」，语义不同，不该混在同一排里。
          -->
          <el-button class="plm-side-switch" size="small" @click="$emit('openVideoLists')">
            视频管理 →
          </el-button>
        </div>
      </div>

      <!-- 右：编辑表单 或 选中歌单的曲目 -->
      <div class="plm-main">
        <!-- 编辑 / 新建（内联，不再单开弹窗） -->
        <div v-if="editing" class="plm-form">
          <div class="plm-form-title">{{ editingId ? '编辑歌单' : '新建歌单' }}</div>

          <div class="plm-field">
            <label>歌单名称</label>
            <el-input v-model="form.name" size="small" placeholder="不填会自动取远端歌单名" clearable />
          </div>

          <div class="plm-field">
            <label>歌单链接</label>
            <el-input
              v-model="form.sourceUrl"
              size="small"
              placeholder="粘贴 网易云 / QQ音乐 / 酷我音乐 的歌单分享链接"
              clearable
            />
            <div class="plm-hint">会保存下来用于之后的自动同步</div>
          </div>

          <div v-if="!editingId" class="plm-field">
            <label>或手动填</label>
            <el-input
              v-model="form.manualSongs"
              type="textarea"
              :rows="3"
              size="small"
              placeholder="每行一首：歌名-歌手（不参与自动同步）"
            />
          </div>

          <div class="plm-field">
            <label>同步方式</label>
            <el-select v-model="form.syncMode" size="small" style="width: 100%">
              <el-option label="手动同步" value="off" />
              <el-option label="每次启动应用时同步" value="startup" />
              <el-option label="定时自动同步" value="interval" />
            </el-select>
          </div>

          <div v-if="form.syncMode === 'interval'" class="plm-field">
            <label>同步间隔</label>
            <el-select v-model="form.intervalMs" size="small" style="width: 100%">
              <el-option
                v-for="opt in SYNC_INTERVAL_OPTIONS"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>

          <div class="plm-form-actions">
            <el-button size="small" @click="cancelEdit">取消</el-button>
            <el-button size="small" type="primary" :loading="saving" @click="saveForm">
              {{ saving ? (editingId ? '保存中…' : '解析中…') : editingId ? '保存' : '创建' }}
            </el-button>
          </div>
        </div>

        <!-- 曲目列表 -->
        <template v-else-if="selected">
          <div class="plm-main-head">
            <div class="plm-main-info">
              <div class="plm-main-name">{{ selected.name }}</div>
              <div class="plm-main-sub">
                <span>{{ selected.songs.length }} 首</span>
                <span v-if="selected.source" class="plm-tag">{{ sourceLabel(selected.source) }}</span>
                <span>{{ syncLabel(selected) }}</span>
                <span>上次同步：{{ lastSyncText(selected) }}</span>
              </div>
            </div>
            <div class="plm-main-actions">
              <el-button
                size="small"
                :loading="store.isSyncingOne(selected.id)"
                :disabled="!selected.sourceUrl"
                @click="syncOne(selected)"
              >
                同步
              </el-button>
              <el-button size="small" @click="startEdit(selected)">编辑</el-button>
              <el-button
                size="small"
                type="primary"
                :disabled="selected.id === store.currentId"
                @click="setCurrent(selected)"
              >
                {{ selected.id === store.currentId ? '当前歌单' : '设为当前' }}
              </el-button>
              <el-popconfirm
                title="确定删除这个歌单吗？不可恢复。"
                confirm-button-text="删除"
                cancel-button-text="取消"
                width="220"
                @confirm="remove(selected)"
              >
                <template #reference>
                  <el-button size="small" type="danger" plain>删除</el-button>
                </template>
              </el-popconfirm>
            </div>
          </div>

          <div class="plm-search">
            <el-input
              v-model="keyword"
              size="small"
              placeholder="搜索歌名 / 歌手 / 专辑"
              clearable
            />
            <span class="plm-search-count">{{ filtered.length }} / {{ selected.songs.length }}</span>
          </div>

          <div class="plm-songs">
            <div
              v-for="row in filtered"
              :key="row.index"
              class="plm-song"
              :class="{ playing: isPlayingRow(row) }"
              @click="play(row.index)"
            >
              <div class="plm-idx">{{ row.index + 1 }}</div>
              <div class="plm-thumb">
                <img
                  v-if="coverOf(row.song) && !failedCovers[coverOf(row.song) as string]"
                  :src="coverOf(row.song) as string"
                  alt=""
                  referrerpolicy="no-referrer"
                  loading="lazy"
                  @error="onImgError"
                />
              </div>
              <div class="plm-song-info">
                <div class="plm-song-name" :title="row.song.name">{{ row.song.name }}</div>
                <div class="plm-song-more">
                  <span class="plm-song-singer">{{ row.song.singer || '未知歌手' }}</span>
                  <span v-if="row.song.album" class="plm-song-album" :title="row.song.album">
                    {{ row.song.album }}
                  </span>
                </div>
              </div>
              <div class="plm-song-dur">{{ formatDuration(row.song.duration) }}</div>
            </div>
            <div v-if="filtered.length === 0" class="plm-empty">
              {{ selected.songs.length === 0 ? '这个歌单还没有曲目' : '没有匹配的歌曲' }}
            </div>
          </div>
        </template>

        <div v-else class="plm-empty big">从左边选一个歌单查看曲目，或点「新建歌单」</div>
      </div>
    </div>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage } from 'element-plus';
import { SOURCE_LABELS, SYNC_INTERVAL_OPTIONS } from '@common/constants';
import type { PlaylistRecord, PlaylistSong } from '@common/types/playlist';
import { parseCacheKey } from '@common/types/playlist';
// 库里存的是**秒**（schema v2 起统一），展示要转回 mm:ss；反向转换在解析音源时用
import { formatDuration } from '@common/utils/duration';
import api from '../api/electron';
import { usePlaylistStore } from '../stores/playlists';
import { normalizeImageUrl } from '../utils/image';

interface Row {
  index: number;
  song: PlaylistSong;
}

interface EditorForm {
  name: string;
  sourceUrl: string;
  manualSongs: string;
  syncMode: PlaylistRecord['sync']['mode'];
  intervalMs: number;
}

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

export default defineComponent({
  name: 'PlaylistManager',
  props: {
    modelValue: { type: Boolean, default: false },
    /** 当前播放歌单的 id（用于高亮「当前」） */
    currentPlaylistId: { type: String, default: '' },
    /** 当前播放到第几首（仅当展示的是当前歌单时有意义） */
    currentIndex: { type: Number, default: -1 },
  },
  emits: ['update:modelValue', 'switch', 'play', 'reload', 'openVideoLists'],
  data() {
    return {
      SYNC_INTERVAL_OPTIONS,
      selectedId: '',
      keyword: '',
      editing: false,
      editingId: '',
      saving: false,
      originalSongs: [] as PlaylistSong[],
      /** 加载失败的封面地址（按地址记，换一个地址就有一次新机会） */
      failedCovers: {} as Record<string, boolean>,
      form: {
        name: '',
        sourceUrl: '',
        manualSongs: '',
        syncMode: 'off',
        intervalMs: SYNC_INTERVAL_OPTIONS[3].value,
      } as EditorForm,
    };
  },
  computed: {
    store() {
      return usePlaylistStore();
    },
    visible: {
      get(): boolean {
        return this.modelValue;
      },
      set(v: boolean) {
        this.$emit('update:modelValue', v);
      },
    },
    totalSongs(): number {
      return this.store.playlists.reduce((s, p) => s + p.songs.length, 0);
    },
    selected(): PlaylistRecord | null {
      return this.store.playlists.find((p) => p.id === this.selectedId) ?? null;
    },
    filtered(): Row[] {
      const songs = this.selected?.songs ?? [];
      const rows: Row[] = songs.map((song, index) => ({ index, song }));
      const kw = this.keyword.trim().toLowerCase();
      if (!kw) return rows;
      return rows.filter(
        (r) =>
          r.song.name.toLowerCase().includes(kw) ||
          (r.song.singer || '').toLowerCase().includes(kw) ||
          (r.song.album || '').toLowerCase().includes(kw),
      );
    },
  },
  watch: {
    modelValue(v: boolean) {
      if (v) this.onOpen();
    },
  },
  methods: {
    /** 图片地址规整（协议相对 URL 在 file:// 页面下会坏掉） */
    normalizeImageUrl,
    /** 打开时：默认选中当前歌单（或第一个），并清掉上次的编辑态 */
    onOpen() {
      this.editing = false;
      this.keyword = '';
      const exists = this.store.playlists.some((p) => p.id === this.selectedId);
      if (!exists) {
        this.selectedId = this.store.currentId || this.store.playlists[0]?.id || '';
      }
    },
    onVisibleChange(v: boolean) {
      this.$emit('update:modelValue', v);
    },
    onImgError(e: Event) {
      /**
       * 记下坏掉的封面地址，而不是给 <img> 写内联 `display: none`。
       *
       * 曲目行是 `:key="row.index"`，切歌单时同一位置的 DOM 会被复用，
       * Vue 只 patch `src`，那个内联样式不会被清掉 ——
       * 结果一个歌单里坏了一张封面，别的歌单同一行的封面就永远是空的。
       */
      const img = e.target as HTMLImageElement;
      const src = img.getAttribute('src');
      if (!src) return;
      if (Object.keys(this.failedCovers).length > 2000) this.failedCovers = {};
      this.failedCovers[src] = true;
    },
    /** 封面地址（规整成 https）；空值交给模板判空 */
    coverOf(song: PlaylistSong): string | null {
      return normalizeImageUrl(song.cover);
    },
    /**
     * 时长（秒 -> `mm:ss`）给模板用
     *
     * 曲目行显示时长走这个方法，而不是直接 `{{ song.duration }}` ——
     * 库里存的是秒（`402`），直接显示会变成「402」而不是「06:42」。
     */
    formatDuration,
    isPlayingRow(row: Row): boolean {
      // 只有展示的是「当前播放歌单」时才高亮当前曲
      if (this.selected?.id !== this.store.currentId) return false;
      return row.index === this.currentIndex;
    },
    sourceLabel(source: string): string {
      return SOURCE_LABELS[source] ?? source;
    },
    syncLabel(item: PlaylistRecord): string {
      switch (item.sync.mode) {
        case 'startup':
          return '启动同步';
        case 'interval':
          /**
           * 间隔可能小于 1 小时（常量表里最小是「每 30 分钟」），
           * 直接 `Math.round(ms / 3600000)` 会把 30 分钟显示成「每 1 小时」。
           */
          return item.sync.intervalMs >= 3600000
            ? `每 ${Math.round(item.sync.intervalMs / 3600000)} 小时`
            : item.sync.intervalMs >= 60000
              ? `每 ${Math.round(item.sync.intervalMs / 60000)} 分钟`
              : '定时同步';
        default:
          return '手动同步';
      }
    },
    lastSyncText(item: PlaylistRecord): string {
      if (!item.lastSyncAt) return '从未';
      const d = new Date(item.lastSyncAt);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    // #region 编辑 / 新建（内联）
    resetForm() {
      this.form = {
        name: '',
        sourceUrl: '',
        manualSongs: '',
        syncMode: 'off',
        intervalMs: SYNC_INTERVAL_OPTIONS[3].value,
      };
    },
    startCreate() {
      this.editing = true;
      this.editingId = '';
      this.originalSongs = [];
      this.resetForm();
    },
    startEdit(item: PlaylistRecord) {
      this.editing = true;
      this.editingId = item.id;
      this.originalSongs = [...item.songs];
      this.form = {
        name: item.name,
        sourceUrl: item.sourceUrl ?? '',
        manualSongs: '',
        syncMode: item.sync.mode,
        intervalMs: item.sync.intervalMs || SYNC_INTERVAL_OPTIONS[3].value,
      };
    },
    cancelEdit() {
      this.editing = false;
      this.editingId = '';
      this.resetForm();
    },
    async saveForm() {
      const url = this.form.sourceUrl.trim();
      const manual = this.form.manualSongs
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => parseCacheKey(l));

      if (!url && manual.length === 0 && !this.editingId) {
        ElMessage.warning('请填写歌单链接，或手动填入歌曲');
        return;
      }

      this.saving = true;
      try {
        const existing = this.store.playlists.find((p) => p.id === this.editingId);
        let songs = this.originalSongs;
        let source: string | undefined = existing?.source;
        let remoteName = '';
        /**
         * ★ 主进程**拼好的**歌单主键（`tx_8153225605`）
         *
         * 渲染层直接拿来当 id 用 —— 不需要认识 `listId`，也不需要知道拼装规则。
         * 没有平台链接（手动新建）时它是 `null`，那时 store 会退化成随机 id。
         */
        let presetId: string | null = null;

        if (url) {
          const detail = await api.getPlaylistDetail({ input: url });
          /**
           * ★ **原样透传**，不再在这里转字段
           *
           * 主进程（`music:getPlaylistDetail`）已经做完了这两件事：
           *  1. 用 `toPlaylistSongs` 把音源的 `interval: "4:03"` / `albumName`
           *     转成库里的 `duration: 243`（秒） / `album`，**并带上 `platformId`**；
           *  2. 拼好歌单主键 `id`（`tx_8153225605`）。
           *
           * 早先第 1 件写在这里，代价是 **`platformId` 被丢掉** ——
           * 渲染层不知道它有用，于是 `songs.id` 只能退化成 `歌名-歌手`。
           *
           * 现在渲染层只做展示（曲目列表本来就是只读的），回传时原样送回去。
           */
          songs = detail.songs as unknown as PlaylistSong[];
          source = detail.source;
          presetId = detail.id;
          remoteName = detail.info.name || '';
          if (songs.length === 0) throw new Error('该歌单没有解析到任何歌曲');
        } else if (manual.length > 0) {
          songs = manual;
        }
        if (songs.length === 0) {
          ElMessage.warning('没有可用的曲目');
          return;
        }

        const finalName =
          this.form.name.trim() || remoteName || existing?.name || '未命名歌单';
        const sync = {
          mode: this.form.syncMode,
          intervalMs: this.form.syncMode === 'interval' ? this.form.intervalMs : 0,
        };

        if (this.editingId) {
          const editedId = this.editingId;
          await this.store.updatePlaylist(editedId, {
            name: finalName,
            songs,
            source,
            // 用户没改链接就沿用原来的，否则自动同步会失效
            sourceUrl: url || existing?.sourceUrl,
            sync,
          });
          ElMessage.success(`歌单《${finalName}》已更新`);
          this.selectedId = editedId;
          /**
           * 只有「编辑的正好是当前播放的歌单」时才需要通知外面重载曲目；
           * 而且这时**不能**当成「切换歌单」—— App 的 onPlaylistSwitch 会把播放进度清零
           * 并从头重播，用户只是改个名字/同步一下，正在听的歌不该被打回 0 秒。
           * 所以这里改成发一个只刷新的事实：调用方按 currentId 判断。
           */
          if (editedId === this.store.currentId) this.$emit('reload');
        } else {
          const created = await this.store.addPlaylist({
            name: finalName,
            songs,
            source,
            sourceUrl: url || undefined,
            /** 主进程拼好的主键；手动新建时为 null（store 退化成随机 id） */
            id: presetId,
            syncMode: sync.mode,
            intervalMs: sync.intervalMs,
          });
          ElMessage.success(`歌单《${finalName}》已添加`);
          this.selectedId = created.id;
          this.$emit('switch', created.id);
        }
        this.editing = false;
        this.editingId = '';
        this.resetForm();
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err));
      } finally {
        this.saving = false;
      }
    },
    // #endregion

    // #region 同步 / 切换 / 删除 / 播放
    async syncOne(item: PlaylistRecord) {
      await this.runSync([item.id]);
    },
    async syncAll() {
      await this.runSync(this.store.playlists.map((p) => p.id));
    },
    async runSync(ids: string[]) {
      try {
        const results = await this.store.sync(ids);
        const failed = results.filter((r) => !r.ok);
        const okList = results.filter((r) => r.ok);
        if (okList.length > 0) {
          const changed = okList.filter((r) => (r.added ?? 0) > 0 || (r.removed ?? 0) > 0);
          const detail = changed
            .map((r) => `${r.name} +${r.added ?? 0}/-${r.removed ?? 0}`)
            .join('，');
          ElMessage.success(
            `同步完成 ${okList.length} 个` + (detail ? `（${detail}）` : '，无变化'),
          );
        }
        for (const r of failed) ElMessage.warning(`${r.name}：${r.error ?? '同步失败'}`);
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err));
      }
    },
    async setCurrent(item: PlaylistRecord) {
      /**
       * 写盘可能失败（磁盘满 / 被杀软占用），而 `store.setCurrent` 内部会 `await persist()`：
       * 不接住就是一个未处理的 rejection —— 用户还会先看到「已切换为《X》」的假成功。
       * 所以先 await 成功、再弹提示。
       */
      try {
        await this.store.setCurrent(item.id);
      } catch (err) {
        ElMessage.error('切换歌单失败：' + (err instanceof Error ? err.message : String(err)));
        return;
      }
      ElMessage.success(`已切换为《${item.name}》`);
      this.$emit('switch', item.id);
    },
    async remove(item: PlaylistRecord) {
      const wasCurrent = item.id === this.store.currentId;
      try {
        await this.store.removePlaylist(item.id);
      } catch (err) {
        ElMessage.error('删除歌单失败：' + (err instanceof Error ? err.message : String(err)));
        return;
      }
      ElMessage.success(`已删除《${item.name}》`);
      if (this.selectedId === item.id) {
        this.selectedId = this.store.currentId || this.store.playlists[0]?.id || '';
      }
      // 删掉的正好是当前歌单 -> 外面得换歌继续放；删的是别的歌单则只刷新，别打断正在听的
      if (wasCurrent) this.$emit('switch', this.store.currentId);
      else this.$emit('reload');
    },
    /** 点歌单里的某首歌：切到该歌单并播放 */
    async play(index: number) {
      if (!this.selected) return;
      if (this.selected.id !== this.store.currentId) {
        await this.store.setCurrent(this.selected.id);
        this.$emit('switch', this.selected.id);
      }
      this.$emit('play', index);
    },
    // #endregion
  },
});
</script>

<style scoped>
.plm-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.plm-title {
  font-size: 16px;
  font-weight: 600;
}
.plm-summary {
  font-size: 12px;
  opacity: 0.55;
}
.plm-body {
  display: flex;
  gap: 14px;
  height: 62vh;
}

/* 左侧歌单列表 */
.plm-side {
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--panel-divider);
  padding-right: 12px;
}
.plm-side-list {
  flex: 1;
  overflow-y: auto;
}
.plm-pl {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 7px;
  cursor: pointer;
  margin-bottom: 2px;
}
.plm-pl:hover {
  background: var(--panel-hover);
}
.plm-pl.sel {
  background: var(--panel-active);
}
.plm-pl.cur .plm-pl-name {
  font-weight: 600;
}
.plm-pl-main {
  flex: 1;
  min-width: 0;
}
.plm-pl-name {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plm-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}
.plm-pl-meta {
  display: flex;
  gap: 6px;
  font-size: 11px;
  opacity: 0.55;
  margin-top: 2px;
}
.plm-tag {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-hover);
}
.plm-spin {
  flex: none;
  color: var(--accent);
}
.plm-spin.on svg {
  animation: plm-rotate 0.9s linear infinite;
}
@keyframes plm-rotate {
  to {
    transform: rotate(360deg);
  }
}
.plm-side-actions {
  display: flex;
  /* 竖排：上面一行是歌单自己的动作，下面一行是「切到视频管理」 */
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--panel-divider);
}
.plm-side-row {
  display: flex;
  gap: 6px;
}
.plm-side-actions :deep(.el-button) {
  flex: 1;
  margin-left: 0;
}

/* 右侧主区 */
.plm-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.plm-main-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 9px;
}
.plm-main-info {
  flex: 1;
  min-width: 0;
}
.plm-main-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plm-main-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  opacity: 0.55;
  margin-top: 3px;
}
.plm-main-actions {
  display: flex;
  gap: 6px;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.plm-main-actions :deep(.el-button) {
  margin-left: 0;
}
.plm-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.plm-search-count {
  font-size: 11px;
  opacity: 0.55;
  flex: none;
}
.plm-songs {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--panel-divider);
  border-radius: 8px;
}
.plm-song {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 9px;
  cursor: pointer;
  border-bottom: 1px solid var(--panel-hover);
}
.plm-song:last-child {
  border-bottom: none;
}
.plm-song:hover {
  background: var(--panel-hover);
}
.plm-song.playing {
  background: var(--panel-active);
}
.plm-song.playing .plm-song-name {
  color: var(--accent-strong);
  font-weight: 600;
}
.plm-idx {
  width: 26px;
  flex: none;
  text-align: right;
  font-size: 11px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.plm-thumb {
  /* 只管高度，宽度按原图比例自适应，图片居中 */
  height: 32px;
  min-width: 32px;
  flex: none;
  border-radius: 5px;
  overflow: hidden;
  background: rgba(128, 128, 128, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
}
.plm-thumb img {
  height: 32px;
  width: auto;
  max-width: 84px;
  object-fit: contain;
  display: block;
}
.plm-song-info {
  flex: 1;
  min-width: 0;
}
.plm-song-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plm-song-more {
  display: flex;
  gap: 7px;
  font-size: 11px;
  opacity: 0.6;
  margin-top: 1px;
  overflow: hidden;
}
.plm-song-singer {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plm-song-album {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plm-song-dur {
  flex: none;
  font-size: 11px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

/* 内联表单 */
.plm-form {
  padding: 2px 4px;
  overflow-y: auto;
}
.plm-form-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}
.plm-field {
  margin-bottom: 12px;
}
.plm-field label {
  display: block;
  font-size: 12px;
  opacity: 0.7;
  margin-bottom: 5px;
}
.plm-hint {
  font-size: 11px;
  opacity: 0.5;
  margin-top: 4px;
}
.plm-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--panel-divider);
}
.plm-empty {
  padding: 24px 8px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}
.plm-empty.big {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
