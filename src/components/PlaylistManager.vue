<template>
  <!--
    界面（弹窗 / 左列表 / 右侧三态 / 搜索 / 条目行）全部由 `ManagerDialog` 渲染，
    这里只留两样真正属于「歌单」的东西：
      · 表单（新建 / 编辑，按平台 / 本地分流的字段）
      · 详情头右侧的动作按钮（同步 / 编辑 / 从这里播放 / 删除）
  -->
  <ManagerDialog
    v-model:visible="visible"
    v-model:selected-id="selectedId"
    title="歌单管理"
    :summary="`共 ${store.playlists.length} 个歌单 · ${totalSongs} 首`"
    :lists="dialogLists"
    :mode="dialogMode"
    :detail="dialogDetail"
    :rows="dialogRows"
    current-hint="当前播放歌单"
    create-label="新建歌单"
    switch-label="视频管理 →"
    :sync-all-disabled="store.playlists.length === 0 || store.isSyncing"
    :sync-all-loading="store.isSyncing"
    search-placeholder="搜索歌名 / 歌手 / 专辑"
    empty-list-text="还没有歌单，点下面「新建歌单」开始"
    empty-main-text="从左边选一个歌单查看曲目，或点「新建歌单」"
    empty-rows-text="这个歌单还没有曲目"
    empty-search-text="没有匹配的歌曲"
    @create="startCreate"
    @sync-all="syncAll"
    @switch="void ui.openManager('ov')"
    @play="play($event.index)"
  >
    <!--
      编辑 / 新建（内联，不再单开弹窗）

      **两类歌单的表单不一样，这不是偷懒**：
      平台歌单（`tx_8153225605`）的名字、链接、曲目都属于平台，应用内只让改同步方式；
      本地歌单（`pl_` 前缀）没有同步，链接框退化成「导入器」——
      贴链接保存 = 把那个歌单的歌追加进来一次，导完不留链接。
    -->
    <template #form>
      <div class="mgr-form">

          <div class="mgr-form-title">
            {{ editingId ? (editingLocal ? '编辑本地歌单' : '平台歌单设置') : '新建歌单' }}
          </div>

          <div class="mgr-field">
            <label>歌单名称</label>
            <div v-if="editingRemote" class="mgr-readonly">{{ form.name || '（同步后以平台为准）' }}</div>
            <el-input
              v-else
              v-model="form.name"
              size="small"
              placeholder="不填会自动取远端歌单名"
              clearable
            />
            <div v-if="editingRemote" class="mgr-hint">
              平台歌单的名字跟着平台走，要改请去平台上改；同步时会自动更新过来
            </div>
          </div>

          <div class="mgr-field">
            <label>{{ editingLocal ? '导入其他歌单' : '歌单链接' }}</label>
            <div v-if="editingRemote" class="mgr-readonly">{{ form.sourceUrl || '（无）' }}</div>
            <el-input
              v-else
              v-model="form.sourceUrl"
              size="small"
              :placeholder="
                editingLocal
                  ? '粘贴歌单链接，保存后把里面的歌追加进来'
                  : '粘贴 wy / tx / kw 的歌单分享链接'
              "
              clearable
            />
            <div class="mgr-hint">
              <template v-if="editingRemote">平台歌单的链接由平台管理，不能修改</template>
              <template v-else-if="editingLocal">
                只导入一次：已有的歌自动跳过；导入后不保存链接，也不会建立同步
              </template>
              <template v-else>会保存下来用于之后的自动同步（这样建出来的是平台歌单）</template>
            </div>
          </div>

          <div v-if="!editingId" class="mgr-field">
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
            <div class="mgr-field">
              <label>同步方式</label>
              <el-select v-model="form.syncMode" size="small" style="width: 100%">
                <el-option label="手动同步" value="off" />
                <el-option label="每次启动应用时同步" value="startup" />
                <el-option label="定时自动同步" value="interval" />
              </el-select>
            </div>

            <div v-if="form.syncMode === 'interval'" class="mgr-field">
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

          <div class="mgr-form-actions">
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
    </template>

    <template #actions>
      <!-- 外壳只在「详情态」渲染这个 slot，此时 selected 一定有值；v-if 是给类型收窄看的 -->
      <template v-if="selected">
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
                :disabled="isPlayingPlaylist(selected.id)"
                @click="setCurrent(selected)"
              >
                {{ isPlayingPlaylist(selected.id) ? '正在播放' : '从这里播放' }}
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
      </template>
    </template>

    <!--
      行尾的「从歌单移除」

      只在**本地歌单**出现：平台歌单的曲目是远端的投影，删了下次同步又回来，
      所以那种歌单整行都不给按钮（和改名、添加歌曲是同一套规则）。
    -->
    <template #row-actions="{ row }">
      <template v-if="selected && isLocal(selected.id)">
        <div
          class="mgr-row-btn mgr-row-btn--x"
          title="从歌单移除"
          @click.stop="removeSong(selected, row)"
        >
          ×
        </div>
      </template>
    </template>
  </ManagerDialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage } from 'element-plus';
import { SYNC_INTERVAL_OPTIONS } from '@common/constants';
import type { PlaylistRecord, PlaylistSong } from '@common/types/playlist';
import {
  isLocalPlaylistId,
  mergePlaylistSongs,
  parseCacheKey,
  songId,
  sourceOfSongId,
} from '@common/types/playlist';
import api from '../api/electron';
import ManagerDialog from './ManagerDialog.vue';
import type { ManagerDetail, ManagerList, ManagerMode, ManagerRow, ManagerTag } from '../types/manager';
import { usePlaylistStore } from '../stores/playlists';
import { normalizeImageUrl } from '../utils/image';
import { errMsg } from '../utils/errorText';
import { formatSyncTime } from '../utils/datetime';
import { useUiStore } from '../stores/ui';
import { useQueueStore } from '../stores/queue';

export interface EditorForm {
  name: string;
  sourceUrl: string;
  manualSongs: string;
  syncMode: PlaylistRecord['sync']['mode'];
  intervalMs: number;
}

export default defineComponent({
  name: 'PlaylistManager',
  components: { ManagerDialog },
  data() {
    return {
      SYNC_INTERVAL_OPTIONS,
      selectedId: '',
      editing: false,
      editingId: '',
      saving: false,
      originalSongs: [] as PlaylistSong[],
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
    /**
     * 给外壳的左栏列表
     *
     * 外壳不知道「歌单」是什么，只认 `ManagerList`：名字 / 数量文案 / 标签 / 是否在播 /
     * 是否同步中。映射只有十几行，换来的是一条链路的唯一实现。
     */
    dialogLists(): ManagerList[] {
      return this.store.playlists.map((p) => {
        const tags: ManagerTag[] = [];
        if (p.isDefault) {
          tags.push({ text: '默认', tone: 'default', title: '拖入的单曲会放进这里，不能删除' });
        }
        if (isLocalPlaylistId(p.id)) {
          tags.push({ text: '本地', title: '本地歌单：不跟随平台更新，可自由增删' });
        } else if (p.source) {
          /**
           * 只显示短码（wy / tx / kw）
           *
           * **不给 tooltip**：之前把中文名挂在 `title` 上，鼠标一悬停就能看清是哪家，
           * 截图一样会露 —— 要么只留短码，要么等于没藏。
           */
          tags.push({ text: this.sourceLabel(p.source) });
        }
        return {
          id: p.id,
          name: p.name,
          countText: `${p.songs.length} 首`,
          tags,
          current: this.isPlayingPlaylist(p.id),
          syncing: this.store.isSyncingOne(p.id),
        };
      });
    },
    /** 详情头：名字 / 数量 / 标签 / 同步状态（本地歌单没有同步，那两项不出现） */
    dialogDetail(): ManagerDetail | null {
      const s = this.selected;
      if (!s) return null;
      const local = isLocalPlaylistId(s.id);
      const tags: ManagerTag[] = [];
      if (local) tags.push({ text: '本地' });
      else if (s.source) tags.push({ text: this.sourceLabel(s.source) });
      const meta: string[] = local
        ? []
        : [this.syncLabel(s), `上次同步：${formatSyncTime(s.lastSyncAt)}`];
      return { name: s.name, countText: `${s.songs.length} 首`, tags, meta };
    },
    /** 右侧主区停在哪一态：编辑/新建 → 表单，选中 → 详情，否则空态 */
    dialogMode(): ManagerMode {
      if (this.editing) return 'form';
      return this.selected ? 'detail' : 'empty';
    },
    /**
     * 给外壳的条目行
     *
     * `key` 用下标：歌单里的歌目前没有稳定的行 id（同一首歌可能重复出现两次），
     * `index` 必须是**原始下标** —— 点第 N 行播列表里的第 N 条，过滤后从 0 数会播错。
     */
    dialogRows(): ManagerRow[] {
      const songs = this.selected?.songs ?? [];
      const isCurrent = this.isPlayingPlaylist(this.selected?.id ?? '');
      /**
       * 平台标记只在**本地歌单**里显示
       *
       * 平台歌单整列都来自同一个来源（详情头已经有一个平台标签了），
       * 行内再标一遍是重复；本地歌单会混进多个平台的歌，久了确实记不住。
       *
       * 取值优先 `song.source`，老数据没有就退回 `songId()` 的前缀解析。
       */
      const showTag = !!this.selected && isLocalPlaylistId(this.selected.id);
      return songs.map((song, index) => ({
        key: index,
        index,
        title: song.name,
        subtitle: song.singer || '未知歌手',
        extra: song.album || '',
        tag: showTag ? song.source || sourceOfSongId(songId(song)) || '' : '',
        cover: normalizeImageUrl(song.cover),
        duration: song.duration,
        playing: isCurrent && index === this.currentIndex,
      }));
    },
  },
  watch: {
    /** 打开时自动选中当前播放的歌单（原来是 watch `modelValue`，那个 prop 早就不存在了） */
    visible(v: boolean) {
      if (v) this.onOpen();
    },
  },
  methods: {
    /** 打开时：默认选中当前歌单（或第一个），并清掉上次的编辑态 */
    onOpen() {
      this.editing = false;
      const exists = this.store.playlists.some((p) => p.id === this.selectedId);
      if (!exists) {
        this.selectedId = this.store.currentId || this.store.playlists[0]?.id || '';
      }
    },
    /**
     * 平台在界面上只显示**短码**（`wy` / `tx` / `kw`）
     *
     * 界面上**任何地方**都不出现中文全名，包括 tooltip —— 悬停提示一样会露，
     * 所以这类标签不挂 `title`。
     */
    sourceLabel(source: string): string {
      return source;
    },
    /** 这个歌单是不是本地歌单（模板里用它决定显示「本地」、隐藏同步相关） */
    isLocal(id: string): boolean {
      return isLocalPlaylistId(id);
    },
    /**
     * 这个歌单**此刻是不是真的在播**
     *
     * 不能只看 `store.currentId`：它是「上次听的歌单」，播视频列表时不会被清掉
     * （留着是为了切回歌单时能接上位置）。只看它的话，正在播视频、切到歌单管理，
     * 那个歌单会亮着「正在播放」，条目行也高亮 —— 用户看到的正是这个。
     *
     * `queue.mode === 'mv'` 才是「当前播放源是歌单」的唯一判据。
     */
    /**
     * 从当前歌单删掉一条曲目
     *
     * 只对本地歌单开放（平台歌单的曲目由平台决定，按钮本身也不渲染）。
     *
     * **不做二次确认**：删错的成本是「再点一次添加」，而为每一首弹一次确认，
     * 清一个几十首的歌单会变成点几十次弹窗。视频那边之所以确认，是因为
     * 移除会连带丢掉收藏和播放进度，这里没有这类副作用。
     */
    async removeSong(record: PlaylistRecord, row: ManagerRow): Promise<void> {
      const ok = await this.store.removeSongAt(record.id, row.index);
      if (!ok) {
        ElMessage.warning('这条已经不在了');
        return;
      }
      // 正在播的就是这个歌单 → 队列里的曲目要跟着变（只换数组，不打断当前播放）
      if (this.isPlayingPlaylist(record.id)) void this.queue.reloadCurrentPlaylistSongs();
    },
    isPlayingPlaylist(id: string): boolean {
      return this.queue.mode === 'mv' && id === this.store.currentId;
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
        if (this.isPlayingPlaylist(record.id)) void this.queue.reloadCurrentPlaylistSongs();
        ElMessage.success(`《${record.name}》已转成本地歌单，可以自由增删歌曲了`);
      } catch (err) {
        ElMessage.error(errMsg(err));
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
          ElMessage.error(errMsg(err));
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
          if (this.isPlayingPlaylist(editedId)) void this.queue.reloadCurrentPlaylistSongs();
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
        ElMessage.error(errMsg(err));
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
        ElMessage.error(errMsg(err));
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
        ElMessage.error('切换歌单失败：' + errMsg(err));
        return;
      }
      ElMessage.success(`已切换为《${item.name}》`);
      void this.queue.onPlaylistSwitch(item.id);
    },
    async remove(item: PlaylistRecord) {
      const wasCurrent = this.isPlayingPlaylist(item.id);
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
        ElMessage.error('删除歌单失败：' + errMsg(err));
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
      /**
       * 判据是「此刻在播的就是这个歌单」，不是「它是 currentId」：
       * 正在播视频时 `currentId` 还停在上次那个歌单，按老判据会跳过切源，
       * 直接拿视频队列去播第 index 条。
       */
      if (!this.isPlayingPlaylist(this.selected.id)) {
        await this.store.setCurrent(this.selected.id);
        void this.queue.onPlaylistSwitch(this.selected.id);
      }
      void this.queue.onPlayFromManager(index);
    },
    // #endregion
  },
});
</script>

<!--
  这里没有样式块：弹窗骨架、左列表、条目行、空态，以及表单里那些
  `mgr-form` / `mgr-field` / `mgr-hint` / `mgr-readonly` 的外观，
  全部由 `ManagerDialog.vue` 的非 scoped 样式提供（两个管理器共用一份）。
-->

