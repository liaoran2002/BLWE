<template>
  <el-dialog
    v-model="visible"
    width="960px"
    :show-close="false"
    align-center
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
                <span v-if="item.isDefault" class="plm-tag plm-tag-default" title="拖入的单曲会放进这里，不能删除">
                  默认
                </span>
                <span v-if="isLocal(item.id)" class="plm-tag" title="本地歌单：不跟随平台更新，可自由增删">本地</span>
                <span v-else-if="item.source" class="plm-tag">{{ sourceLabel(item.source) }}</span>
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
          <el-button class="plm-side-switch" size="small" @click="void ui.openManager('ov')">
            视频管理 →
          </el-button>
        </div>
      </div>

      <!-- 右：编辑表单 或 选中歌单的曲目 -->
      <div class="plm-main">
        <!--
          编辑 / 新建（内联，不再单开弹窗）

          **两类歌单的表单不一样，这不是偷懒**：
          平台歌单（`tx_8153225605`）的名字、链接、曲目都属于平台，应用内只让改同步方式；
          本地歌单（`pl_` 前缀）没有同步，链接框退化成「导入器」——
          贴链接保存 = 把那个歌单的歌追加进来一次，导完不留链接。
        -->
        <div v-if="editing" class="plm-form">
          <div class="plm-form-title">
            {{ editingId ? (editingLocal ? '编辑本地歌单' : '平台歌单设置') : '新建歌单' }}
          </div>

          <div class="plm-field">
            <label>歌单名称</label>
            <div v-if="editingRemote" class="plm-readonly">{{ form.name || '（同步后以平台为准）' }}</div>
            <el-input
              v-else
              v-model="form.name"
              size="small"
              placeholder="不填会自动取远端歌单名"
              clearable
            />
            <div v-if="editingRemote" class="plm-hint">
              平台歌单的名字跟着平台走，要改请去平台上改；同步时会自动更新过来
            </div>
          </div>

          <div class="plm-field">
            <label>{{ editingLocal ? '导入其他歌单' : '歌单链接' }}</label>
            <div v-if="editingRemote" class="plm-readonly">{{ form.sourceUrl || '（无）' }}</div>
            <el-input
              v-else
              v-model="form.sourceUrl"
              size="small"
              :placeholder="
                editingLocal
                  ? '粘贴歌单链接，保存后把里面的歌追加进来'
                  : '粘贴 网易云 / QQ音乐 / 酷我音乐 的歌单分享链接'
              "
              clearable
            />
            <div class="plm-hint">
              <template v-if="editingRemote">平台歌单的链接由平台管理，不能修改</template>
              <template v-else-if="editingLocal">
                只导入一次：已有的歌自动跳过；导入后不保存链接，也不会建立同步
              </template>
              <template v-else>会保存下来用于之后的自动同步（这样建出来的是平台歌单）</template>
            </div>
          </div>

          <div v-if="!editingId" class="plm-field">
            <label>或手动填</label>
            <el-input
              v-model="form.manualSongs"
              type="textarea"
              :rows="3"
              size="small"
              placeholder="每行一首：歌名-歌手（这样建出来的是本地歌单）"
            />
          </div>

          <!-- 本地歌单没有同步这个概念，整块不显示 -->
          <template v-if="!editingLocal">
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
          </template>

          <div class="plm-form-actions">
            <el-button size="small" @click="cancelEdit">取消</el-button>
            <el-button size="small" type="primary" :loading="saving" @click="saveForm">
              {{ saving ? (editingId ? '保存中…' : '解析中…') : editingId ? '保存' : '创建' }}
            </el-button>
            <!--
              平台 → 本地是**不可逆**的（id 会换成新的 `pl_` 主键），所以给确认框。
              转换后它就不再跟随平台更新，可以自由增删歌曲。
            -->
            <el-popconfirm
              v-if="editingRemote"
              title="转换后不再跟随平台更新、可以自由增删歌曲，且不可撤销。确定吗？"
              confirm-button-text="转换"
              cancel-button-text="算了"
              width="280"
              @confirm="convertToLocal"
            >
              <template #reference>
                <el-button size="small" type="warning" plain>转成本地歌单</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>

        <!-- 曲目列表 -->
        <template v-else-if="selected">
          <div class="plm-main-head">
            <div class="plm-main-info">
              <div class="plm-main-name">{{ selected.name }}</div>
              <div class="plm-main-sub">
                <span>{{ selected.songs.length }} 首</span>
                <span v-if="isLocal(selected.id)" class="plm-tag">本地</span>
                <span v-else-if="selected.source" class="plm-tag">{{ sourceLabel(selected.source) }}</span>
                <!-- 本地歌单没有同步这个概念，同步方式 / 上次同步对它无意义 -->
                <template v-if="!isLocal(selected.id)">
                  <span>{{ syncLabel(selected) }}</span>
                  <span>上次同步：{{ lastSyncText(selected) }}</span>
                </template>
              </div>
            </div>
            <div class="plm-main-actions">
              <el-button
                v-if="!isLocal(selected.id)"
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
                :disabled="selected.isDefault"
                @confirm="remove(selected)"
              >
                <template #reference>
                  <el-button
                    size="small"
                    type="danger"
                    plain
                    :disabled="selected.isDefault"
                    :title="selected.isDefault ? '默认歌单不能删除（可以改名）' : ''"
                  >
                    删除
                  </el-button>
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
import {
  isLocalPlaylistId,
  mergePlaylistSongs,
  parseCacheKey,
} from '@common/types/playlist';
// 库里存的是**秒**（schema v2 起统一），展示要转回 mm:ss；反向转换在解析音源时用
import { formatDuration } from '@common/utils/duration';
import api from '../api/electron';
import { usePlaylistStore } from '../stores/playlists';
import { normalizeImageUrl } from '../utils/image';
import { useUiStore } from '../stores/ui';
import { useQueueStore } from '../stores/queue';

export interface Row {
  index: number;
  song: PlaylistSong;
}

export interface EditorForm {
  name: string;
  sourceUrl: string;
  manualSongs: string;
  syncMode: PlaylistRecord['sync']['mode'];
  intervalMs: number;
}

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

export default defineComponent({
  name: 'PlaylistManager',
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
    /**
     * 这些 store（播放状态按域拆成了多个）
     *
     * 弹窗的开关、当前在播的歌单与曲目下标，本来就在 player 里 ——
     * 以前是 App.vue 用 v-model + props 传进来、切歌再 emit 出去，
     * 现在直接读写 store，父组件那一侧只剩一个组件标签。
     *
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    ui() {
      return useUiStore();
    },
    queue() {
      return useQueueStore();
    },
    visible: {
      get(): boolean {
        return this.ui.playlistManagerVisible;
      },
      set(v: boolean) {
        this.ui.playlistManagerVisible = v;
      },
    },
    /** 当前播放歌单的 id（用于高亮「当前」） */
    currentPlaylistId(): string {
      return this.store.currentId || '';
    },
    /** 当前播放到第几首（仅当展示的是当前歌单时有意义） */
    currentIndex(): number {
      return this.queue.currentIndex;
    },
    totalSongs(): number {
      return this.store.playlists.reduce((s, p) => s + p.songs.length, 0);
    },
    selected(): PlaylistRecord | null {
      return this.store.playlists.find((p) => p.id === this.selectedId) ?? null;
    },
    /**
     * 正在编辑的是不是本地歌单
     *
     * `editingId` 为空 = 新建，两种都不是 —— 新建时由「填链接 / 手动填 / 只填名字」
     * 决定最终建出哪一种，所以表单要给全（链接、手动填、同步方式都显示）。
     */
    editingLocal(): boolean {
      return !!this.editingId && isLocalPlaylistId(this.editingId);
    },
    /** 正在编辑的是不是平台歌单（名字 / 链接 / 曲目只读，只能改同步方式） */
    editingRemote(): boolean {
      return !!this.editingId && !isLocalPlaylistId(this.editingId);
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
    /** 这个歌单是不是本地歌单（模板里用它决定显示「本地」、隐藏同步相关） */
    isLocal(id: string): boolean {
      return isLocalPlaylistId(id);
    },
    /**
     * 平台歌单 → 本地歌单（不可逆）
     *
     * 主进程会换一个新 id、清掉链接与同步。这里负责界面上的三件事：
     *  1. 选中项从旧 id 换到新 id —— 不然接下来点「编辑」会指向一个不存在的歌单；
     *  2. 退出编辑态（同步方式那块对它已经没有意义了）；
     *  3. 如果它正在播，刷新队列的曲目来源（**曲目没变，不重起播放**）。
     */
    async convertToLocal() {
      const oldId = this.editingId;
      if (!oldId) return;
      this.saving = true;
      try {
        const record = await this.store.convertToLocal(oldId);
        if (this.selectedId === oldId) this.selectedId = record.id;
        this.editing = false;
        this.editingId = '';
        this.resetForm();
        if (record.id === this.store.currentId) void this.queue.reloadCurrentPlaylistSongs();
        ElMessage.success(`《${record.name}》已转成本地歌单，可以自由增删歌曲了`);
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err));
      } finally {
        this.saving = false;
      }
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
    /**
     * 保存表单
     *
     * 三类走法，差别在「谁拥有这些数据」：
     *
     * | 场景 | 提交什么 |
     * | :--- | :--- |
     * | 编辑平台歌单 | **只提交同步方式** —— 名字 / 链接 / 曲目属于平台 |
     * | 编辑本地歌单 | 名字 + 曲目（贴了链接就合并导入，跳过已有的） |
     * | 新建 + 链接 | 平台歌单：解析后原样落库，带上链接与同步策略 |
     * | 新建 + 手动填 / 只填名字 | 本地歌单：没有链接，同步恒为 off |
     */
    async saveForm() {
      const url = this.form.sourceUrl.trim();
      const manual = this.form.manualSongs
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => parseCacheKey(l));

      /**
       * 编辑平台歌单：只提交同步方式
       *
       * 表单那边已经把名字和链接渲染成只读，这里再只传 sync ——
       * 两道闸是为了防「以后某个调用方顺手多传几个字段」把平台数据写花。
       */
      if (this.editingRemote) {
        this.saving = true;
        try {
          await this.store.updatePlaylist(this.editingId, {
            sync: {
              mode: this.form.syncMode,
              intervalMs: this.form.syncMode === 'interval' ? this.form.intervalMs : 0,
            },
          });
          ElMessage.success('同步设置已保存');
          this.editing = false;
          this.editingId = '';
          this.resetForm();
        } catch (err) {
          ElMessage.error(err instanceof Error ? err.message : String(err));
        } finally {
          this.saving = false;
        }
        return;
      }

      /** 新建：链接、手动填、名字全空 = 没东西可建 */
      if (!this.editingId && !url && manual.length === 0 && !this.form.name.trim()) {
        ElMessage.warning('请填歌单名称，或粘贴歌单链接');
        return;
      }

      this.saving = true;
      try {
        const existing = this.store.playlists.find((p) => p.id === this.editingId);
        let songs = this.originalSongs;
        let source: string | undefined;
        let remoteName = '';
        /** 主进程拼好的平台主键（`tx_8153225605`）；手动新建时为 null */
        let presetId: string | null = null;
        let imported = 0;
        let duplicated = 0;

        if (url) {
          const detail = await api.getPlaylistDetail({ input: url });
          /** 解析结果**原样透传**：`toPlaylistSongs` 已在主进程做完了字段转换 */
          const incoming = detail.songs as unknown as PlaylistSong[];
          if (incoming.length === 0) throw new Error('该歌单没有解析到任何歌曲');

          if (this.editingLocal) {
            /**
             * 本地歌单：链接只是**导入器**，合并而不是替换
             *
             * 替换会把之前导入的歌全清掉，而本地歌单存在的意义正是
             * 「攒多个平台的歌」。去重规则见 `mergePlaylistSongs`
             * （先按 音源+平台id，再按 歌名-歌手 兜底）。
             */
            const merged = mergePlaylistSongs(songs, incoming);
            songs = merged.songs;
            imported = merged.added;
            duplicated = merged.duplicated;
          } else {
            songs = incoming;
            source = detail.source;
            presetId = detail.id;
            remoteName = detail.info.name || '';
          }
        } else if (manual.length > 0) {
          songs = manual;
        }

        const finalName =
          this.form.name.trim() || remoteName || existing?.name || '未命名歌单';

        if (this.editingId) {
          const editedId = this.editingId;
          /**
           * 本地歌单：只提交名字和曲目
           *
           * 链接 / 音源 / 同步不传 —— 它们对本地歌单恒为空 / off，
           * store 和主进程归一化也都会把它们剔掉，这里不传只是少一层误解。
           */
          await this.store.updatePlaylist(editedId, { name: finalName, songs });
          if (imported > 0 || duplicated > 0) {
            ElMessage.success(
              `已导入 ${imported} 首${duplicated ? `，跳过 ${duplicated} 首重复` : ''}`,
            );
          } else {
            ElMessage.success(`歌单《${finalName}》已更新`);
          }
          this.selectedId = editedId;
          /** 改的正好是当前播放的歌单：曲目可能变了，通知队列重载（不重起播放） */
          if (editedId === this.store.currentId) void this.queue.reloadCurrentPlaylistSongs();
        } else {
          const created = await this.store.addPlaylist({
            name: finalName,
            songs,
            source,
            sourceUrl: url || undefined,
            id: presetId,
            /** 没有链接 = 本地歌单，同步恒为 off（传进来的 syncMode 不采纳） */
            syncMode: url ? this.form.syncMode : 'off',
            intervalMs:
              url && this.form.syncMode === 'interval' ? this.form.intervalMs : 0,
          });
          ElMessage.success(`歌单《${finalName}》已添加`);
          this.selectedId = created.id;
          void this.queue.onPlaylistSwitch(created.id);
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
      void this.queue.onPlaylistSwitch(item.id);
    },
    async remove(item: PlaylistRecord) {
      const wasCurrent = item.id === this.store.currentId;
      try {
        const ok = await this.store.removePlaylist(item.id);
        /**
         * 默认歌单删不掉（store 返回 false）
         *
         * 按钮已经禁用了，走到这儿说明是别的入口（比如将来的右键菜单 / 批量删除）。
         * 不提示一句的话，用户会以为点了没反应。
         */
        if (!ok) {
          ElMessage.warning('默认歌单不能删除（可以改名）');
          return;
        }
      } catch (err) {
        ElMessage.error('删除歌单失败：' + (err instanceof Error ? err.message : String(err)));
        return;
      }
      ElMessage.success(`已删除《${item.name}》`);
      if (this.selectedId === item.id) {
        this.selectedId = this.store.currentId || this.store.playlists[0]?.id || '';
      }
      // 删掉的正好是当前歌单 -> 外面得换歌继续放；删的是别的歌单则只刷新，别打断正在听的
      if (wasCurrent) void this.queue.onPlaylistSwitch(this.store.currentId);
      else void this.queue.reloadCurrentPlaylistSongs();
    },
    /** 点歌单里的某首歌：切到该歌单并播放 */
    async play(index: number) {
      if (!this.selected) return;
      if (this.selected.id !== this.store.currentId) {
        await this.store.setCurrent(this.selected.id);
        void this.queue.onPlaylistSwitch(this.selected.id);
      }
      void this.queue.onPlayFromManager(index);
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

/* 「默认」标签：和来源标签（网易云 / QQ）区分开 —— 它是身份，不是来源 */
.plm-tag-default {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
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
/*
 * 只读字段（平台歌单的名字 / 链接）
 *
 * 长得像输入框但不可编辑：用户一眼能看出「这里有值，但不归我改」，
 * 比直接隐藏或换成纯文本更接近编辑表单的语境。
 */
.plm-readonly {
  padding: 5px 11px;
  border-radius: 4px;
  background: var(--panel-hover);
  font-size: 12px;
  opacity: 0.8;
  word-break: break-all;
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
