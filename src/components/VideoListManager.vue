<template>
  <!--
    界面（弹窗 / 左列表 / 右侧三态 / 搜索 / 条目行）全部由 `ManagerDialog` 渲染，
    这里只留三样属于视频列表的东西：
      · 新建 / 编辑表单（四种内容来源在这一张表单里收口）
      · 详情头右侧的动作按钮（同步 / 编辑 / 添加视频 / 从这里播放 / 删除）
      · 条目行尾的按钮（定位 / 收藏置顶 / 移除）
  -->
  <ManagerDialog
    v-model:visible="visible"
    v-model:selected-id="selectedId"
    title="视频管理"
    :summary="`共 ${store.lists.length} 个列表 · ${totalItems} 条视频`"
    append-to-body
    :lists="dialogLists"
    :mode="dialogMode"
    :detail="dialogDetail"
    :rows="dialogRows"
    :loading-rows="loadingItems"
    create-label="新建列表"
    switch-label="← 歌单管理"
    :sync-all-disabled="syncableCount === 0 || store.syncing.length > 0"
    :sync-all-loading="store.syncing.length > 0"
    search-placeholder="搜索标题 / UP 主"
    empty-list-text="还没有列表，点下面「新建列表」开始"
    empty-main-text="从左边选一个列表查看条目，或点「新建列表」从链接 / 收藏夹 / 订阅合集导入"
    :empty-rows-text="emptyRowsText"
    empty-search-text="没有匹配的视频"
    @create="startCreate"
    @sync-all="syncAll"
    @switch="void ui.openManager('mv')"
    @play="onRowPlay($event)"
  >
    <template #form>
      <div v-if="creating" class="mgr-form">
          <div class="mgr-form-title">新建列表</div>

          <div class="mgr-field">
            <label>列表名称</label>
            <el-input
              v-model="form.name"
              size="small"
              clearable
              :placeholder="form.source === 'local' ? '留空自动叫「本地列表」' : '留空自动取远端标题'"
            />
          </div>

          <div class="mgr-field">
            <label>内容来源</label>
            <el-radio-group v-model="form.source" size="small">
              <el-radio-button value="local">空列表</el-radio-button>
              <el-radio-button value="link">粘贴链接</el-radio-button>
              <el-radio-button value="fav">收藏夹</el-radio-button>
              <el-radio-button value="sub">订阅合集</el-radio-button>
            </el-radio-group>
          </div>

          <!-- ① 粘贴链接 -->
          <div v-if="form.source === 'link'" class="mgr-field">
            <el-input
              v-model="form.link"
              size="small"
              clearable
              placeholder="粘贴收藏夹 / 合集 / 系列链接，如 https://space.bilibili.com/123/favlist?fid=456"
            />
            <div class="mgr-hint">
              支持：收藏夹（<code>/list/ml…</code>、<code>favlist?fid=…</code>）、
              合集 / 系列（<code>/lists/…?type=season|series</code>）
            </div>
          </div>

          <!--
            ② 收藏夹

            ★ 原来是 `el-select` 下拉，现在改成**封面网格**（用户要求）：
            收藏夹名字往往很像（「默认收藏夹」「我的收藏」「收藏夹1」…），
            下拉里只剩一行字，选的时候要逐个读；封面能一眼认出来。
            交互照抄左边那个列表：点一下选中、选中行高亮。
          -->
          <div v-else-if="form.source === 'fav'" class="mgr-field">
            <div v-if="loadingFolders" class="mgr-hint">正在读取你的收藏夹…</div>
            <template v-else>
              <div v-if="folders.length > 0" class="vlm-picker">
                <div
                  v-for="f in folders"
                  :key="f.id"
                  class="vlm-pick"
                  :class="{ sel: form.folderId === f.id }"
                  :title="`${f.title}（${f.count} 条）`"
                  @click="form.folderId = f.id"
                >
                  <div class="vlm-pick-cover">
                    <img
                      v-if="f.cover && !failedCovers[f.cover]"
                      :src="f.cover"
                      alt=""
                      referrerpolicy="no-referrer"
                      loading="lazy"
                      @error="onImgError"
                    />
                  </div>
                  <div class="vlm-pick-name">{{ f.title }}</div>
                  <div class="vlm-pick-meta">{{ f.count }} 条</div>
                </div>
              </div>
              <div v-else class="mgr-hint">
                <span v-if="folderError">{{ folderError }}</span>
                <span v-else>没有读到收藏夹。私密收藏夹需要先登录某站账号。</span>
                <el-button link type="primary" size="small" @click="loadFolders">重新读取</el-button>
              </div>
            </template>
          </div>

          <!--
            ③ 订阅合集（我**收藏的**别人做的合集）
            数据来自 `x/v3/fav/folder/collected/list`，那里 `type = 21` 的才是合集；
            收藏的「收藏夹」也在同一个响应里，但 media_id 语义不同，不收（见 biliApi.ts）。
          -->
          <div v-else-if="form.source === 'sub'" class="mgr-field">
            <div v-if="loadingSubs" class="mgr-hint">正在读取订阅合集…</div>
            <template v-else>
              <div v-if="subs.length > 0" class="vlm-picker">
                <div
                  v-for="s in subs"
                  :key="subKeyOf(s)"
                  class="vlm-pick"
                  :class="{ sel: form.subKey === subKeyOf(s) }"
                  :title="`${s.title}（${s.count} 条）`"
                  @click="form.subKey = subKeyOf(s)"
                >
                  <div class="vlm-pick-cover">
                    <img
                      v-if="s.cover && !failedCovers[s.cover]"
                      :src="s.cover"
                      alt=""
                      referrerpolicy="no-referrer"
                      loading="lazy"
                      @error="onImgError"
                    />
                  </div>
                  <div class="vlm-pick-name">{{ s.title }}</div>
                  <div class="vlm-pick-meta">{{ s.count }} 条</div>
                </div>
              </div>
              <div v-else class="mgr-hint">
                <span v-if="subError">{{ subError }}</span>
                <span v-else>没有读到订阅合集。在某站收藏别人的合集之后，这里才会出现。</span>
                <el-button link type="primary" size="small" @click="loadSubs">重新读取</el-button>
              </div>
            </template>
          </div>

          <!-- ④ 空列表 -->
          <div v-else class="mgr-hint">
            不导入内容：建一个空列表，之后用「添加视频」一条条加，或者直接把视频链接拖进窗口。
          </div>

          <div class="mgr-form-actions">
            <el-button size="small" @click="cancelCreate">取消</el-button>
            <el-button size="small" type="primary" :loading="creatingBusy" @click="submitCreate">
              {{ creatingBusy ? '处理中…' : form.source === 'local' ? '创建' : '导入' }}
            </el-button>
          </div>
          <div class="mgr-hint">
            导入只写列表和条目（几百条会跑几秒），播放地址等第一次播放时才取 ——
            一次性预取几百个地址既慢又容易被风控。
          </div>
      </div>

      <div v-else-if="editing && selected" class="mgr-form">
          <div class="mgr-form-title">编辑《{{ selected.name }}》</div>
          <div class="mgr-hint" style="margin: -6px 0 12px">
            {{ kindLabel(selected.kind) }} · {{ selected.itemCount ?? items.length }} 条
          </div>

          <div class="mgr-field">
            <label>列表名称</label>
            <div v-if="selected.kind !== 'local'" class="mgr-readonly">{{ selected.name }}</div>
            <el-input v-else v-model="editForm.name" size="small" placeholder="列表名称" clearable />
            <div v-if="selected.kind !== 'local'" class="mgr-hint">
              平台列表的名字由某站决定（同步时会跟着远端变），想改名先转成本地列表
            </div>
          </div>

          <template v-if="selected.kind !== 'local'">
            <div class="mgr-field">
              <label>同步方式</label>
              <el-select v-model="editForm.syncMode" size="small" style="width: 100%">
                <el-option label="手动同步" value="off" />
                <el-option label="每次启动应用时同步" value="startup" />
                <el-option label="定时自动同步" value="interval" />
              </el-select>
            </div>
            <!-- 只有选了「定时」才需要间隔，和歌单管理那边完全一样 -->
            <div v-if="editForm.syncMode === 'interval'" class="mgr-field">
              <label>同步间隔</label>
              <el-select v-model="editForm.intervalMs" size="small" style="width: 100%">
                <el-option
                  v-for="opt in SYNC_INTERVAL_OPTIONS"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </div>
            <div class="mgr-field">
              <label>来源</label>
              <div class="mgr-readonly">
                {{ kindLabel(selected.kind) }} · {{ selected.sourceId || '（无）' }}
              </div>
            </div>
          </template>

          <div class="mgr-form-actions">
            <el-button size="small" @click="cancelEdit">取消</el-button>
            <el-button size="small" type="primary" :loading="saving" @click="saveEdit">
              {{ saving ? '保存中…' : '保存' }}
            </el-button>
            <el-popconfirm
              v-if="selected.kind !== 'local'"
              title="转换后不再跟随某站同步，名字和条目都可以随便改。确定吗？"
              confirm-button-text="转换"
              cancel-button-text="算了"
              width="280"
              @confirm="convert(selected)"
            >
              <template #reference>
                <el-button size="small" type="warning" plain>转成本地列表</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
    </template>

    <template #actions>
      <!-- 弹窗只在详情态渲染这个 slot，此时 selected 一定有值；v-if 是给类型收窄看的 -->
      <template v-if="selected">
              <!--
                按钮顺序和歌单管理那一栏对齐：同步 → 编辑 → 操作 → 播放 → 删除。
                本地列表没有"同步"；平台列表没有"添加视频"（条目由远端决定）。
              -->
              <el-button
                v-if="selected.kind !== 'local'"
                size="small"
                :loading="store.isSyncingOne(selected.id)"
                @click="syncOne(selected)"
              >
                同步
              </el-button>
              <el-button size="small" @click="startEdit(selected)">编辑</el-button>
              <el-button
                v-if="selected.kind === 'local'"
                size="small"
                @click="openImport(selected)"
              >
                添加视频
              </el-button>
              <!--
                和歌单管理那一栏同一个按钮、同一套文案：点了就是「切播放源 + 立刻起播」，
                所以叫「从这里播放」；已经在播的那个显示「正在播放」并禁用。
              -->
              <el-button
                size="small"
                type="primary"
                :disabled="isPlayingList(selected.id)"
                @click="playList(selected)"
              >
                {{ isPlayingList(selected.id) ? '正在播放' : '从这里播放' }}
              </el-button>
              <!--
                默认列表**不许删**（用户要求：可以改名，不能删）
                它是「拖入单条视频」的落点，删了下次拖视频还得悄悄再建一个。
                主进程那边也拦了一道，这里禁用按钮只是别让人白点。
              -->
              <el-popconfirm
                title="确定删除这个列表吗？（只删列表和它的条目关系，不影响收藏夹本身）"
                confirm-button-text="删除"
                cancel-button-text="取消"
                width="260"
                @confirm="remove(selected)"
              >
                <template #reference>
                  <el-button
                    size="small"
                    type="danger"
                    plain
                    :disabled="selected.isDefault"
                    :title="selected.isDefault ? '默认列表不能删除（可以改名）' : ''"
                  >
                    删除
                  </el-button>
                </template>
              </el-popconfirm>
      </template>
    </template>

    <!--
      行尾按钮：视频列表比歌单多出来的东西，正是这一行。
      `row` 是归一化后的行，原始条目用 `itemAt(row)` 取（行一定来自 `items`）。
    -->
    <template #row-actions="{ row }">
      <!-- 行只在详情态渲染，此时 selected 一定有值；v-if 是给类型收窄看的 -->
      <template v-if="selected">
                <!-- 失效条目的主操作是「定位」，放到收藏前面（收藏对它没用） -->
                <div
                  v-if="row.missing"
                  class="vlm-item-fix"
                  title="重新定位到这个文件的新位置（列表位置 / 收藏 / 进度都保留）"
                  @click.stop="relocate(selected, itemAt(row))"
                >
                  定位
                </div>
                <!--
                  收藏 = 置顶（主进程在事务里把它挪到 ord=0）

                  和 MV 候选列表的爱心是同一套交互，但存在 `videolist_items.favorites` 上 ——
                  同一个视频在 A 列表收藏了，B 列表不该跟着变实心。
                -->
                <div
                  class="vlm-item-fav"
                  :class="{ on: itemAt(row).favorites }"
                  :title="itemAt(row).favorites ? '取消收藏' : '收藏（会置顶）'"
                  @click.stop="toggleFav(selected, itemAt(row))"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 16 16"
                    :fill="itemAt(row).favorites ? 'currentColor' : 'none'"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                  >
                    <path d="M8 13.1S2.3 9.7 2.3 6.2c0-1.7 1.3-3 3-3 1.2 0 2.2.7 2.7 1.7.5-1 1.5-1.7 2.7-1.7 1.7 0 3 1.3 3 3 0 3.5-5.7 6.9-5.7 6.9z" />
                  </svg>
                </div>
                <div
                  v-if="selected && selected.kind === 'local'"
                  class="mgr-row-btn mgr-row-btn--x"
                  title="从列表移除（不影响某站上的收藏）"
                  @click.stop="removeItem(selected, itemAt(row))"
                >
                  ×
                </div>
      </template>
    </template>
  </ManagerDialog>


  <!--
    「添加视频」的确认框（局部子组件，只服务这个弹窗）
    贴单条视频 → 一张详情；贴合集 / 收藏夹 / 系列 → 列表详情 + 下面每条视频。
    确认之前不写库：点取消没有任何副作用。
  -->
  <VideoImportDialog
    v-model:visible="importVisible"
    :list-id="importTarget.id"
    :list-name="importTarget.name"
    @done="onImportDone"
  />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { VideoListItem, VideoListRecord } from '@common/types/playlist';
import { formatDuration } from '@common/utils/duration';
import { SYNC_INTERVAL_OPTIONS } from '@common/constants';
import api from '../api/electron';
import ManagerDialog from './ManagerDialog.vue';
import VideoImportDialog from './VideoImportDialog.vue';
import type { ManagerDetail, ManagerList, ManagerMode, ManagerRow, ManagerTag } from '../types/manager';
import type { VideoListSyncMode } from '@common/types/playlist';
import { useVideoListStore } from '../stores/videoLists';
import { normalizeImageUrl } from '../utils/image';
import { errMsg } from '../utils/errorText';
import { formatSyncTime } from '../utils/datetime';
import { useUiStore } from '../stores/ui';
import { useQueueStore } from '../stores/queue';

/**
 * 订阅合集里的一项（主进程 `fetchMySubscribedLists` 的返回形状）
 *
 * `kind` 目前恒为 `'season'`（只收 `type = 21` 的合集）；类型里留着 `'series'`
 * 是因为「系列」也是某站的一类列表，将来若找到来源可以不做类型改动就接上。
 */
export interface SubList {
  kind: 'season' | 'series';
  id: string;
  mid: string;
  title: string;
  count: number;
  /** 已规整成绝对 https（`loadSubs` 里过的 `normalizeImageUrl`）；无封面为 null */
  cover: string | null;
}

export default defineComponent({
  name: 'VideoListManager',
  components: { ManagerDialog, VideoImportDialog },
  data() {
    return {
      SYNC_INTERVAL_OPTIONS,
      selectedId: '',
      /** 「添加视频」确认框的开关与目标列表 */
      importVisible: false,
      importTarget: { id: '', name: '' },
      /** 右侧正在显示「编辑」表单 */
      editing: false,
      saving: false,
      /**
       * 编辑表单（和上面那个新建用的 `form` 分开：两者字段不同，复用会打架）
       *
       * `syncMode` 只有 `off` / `manual` 两个值 —— 视频列表没有间隔同步，
       * 「参与全部同步」就是它唯一能配的东西。
       */
      editForm: { name: '', syncMode: 'off' as VideoListSyncMode, intervalMs: 0 },
      items: [] as VideoListItem[],
      loadingItems: false,
      failedCovers: {} as Record<string, boolean>,
      /** 右侧正在显示「新建列表」表单 */
      creating: false,
      creatingBusy: false,
      /**
       * 新建表单
       *
       * `source` 决定下面显示哪一块，也决定提交时走哪条路：
       * `local` = 只建空列表，其余三种 = 导入（再按 `kind` 分派）。
       */
      form: {
        name: '',
        source: 'link' as 'local' | 'link' | 'fav' | 'sub',
        link: '',
        folderId: '',
        /** 订阅合集的选中值，形如 `season_456`（带上 kind，将来接上系列时不会和合集 id 撞号） */
        subKey: '',
      },
      /**
       * 收藏夹清单（封面网格的数据源）
       *
       * `cover` 已在 `loadFolders` 里规整成绝对 https，模板直接绑即可。
       */
      folders: [] as Array<{ id: string; title: string; count: number; cover: string | null }>,
      loadingFolders: false,
      folderError: '',
      subs: [] as SubList[],
      loadingSubs: false,
      subError: '',
    };
  },
  computed: {
    store() {
      return useVideoListStore();
    },
    /**
     * 这些 store（播放状态按域拆成了多个）
     *
     * 弹窗开关、「正在看哪个列表」、播一条 / 换一列，本来就都在 player 里。
     * 以前靠 v-model + props + 四个 emit 来回传，现在直接读写 store。
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
        return this.ui.videoListVisible;
      },
      set(v: boolean) {
        this.ui.videoListVisible = v;
      },
    },
    /**
     * 「正在看哪个列表」
     *
     * 弹窗自身也存了 `selectedId`，但那个只在打开期间有效；
     * 关掉再打开（或从歌单管理切回来）要停回同一个列表，得靠 store 这份。
     */
    browseId(): string {
      return this.ui.browseVideoListId;
    },
    totalItems(): number {
      return this.store.lists.reduce((sum, item) => sum + (item.itemCount ?? 0), 0);
    },
    /** 能被同步的列表数（本地列表没有远端来源，不参与「全部同步」） */
    /** 参与「全部同步」的列表数（本地列表和关掉同步的都不算） */
    syncableCount(): number {
      return this.store.lists.filter(
        (item) => item.kind !== 'local' && item.syncMode !== 'off',
      ).length;
    },
    selected(): VideoListRecord | null {
      return this.store.find(this.selectedId);
    },
    /** 左栏列表：外壳不知道「视频列表」是什么，只认名字 / 数量 / 标签 / 状态 */
    dialogLists(): ManagerList[] {
      return this.store.lists.map((item) => {
        const tags: ManagerTag[] = [{ text: this.kindLabel(item.kind) }];
        if (item.isDefault) {
          tags.push({ text: '默认', tone: 'default', title: '拖入单条视频会放进这里' });
        }
        return {
          id: item.id,
          name: item.name,
          countText: `${item.itemCount ?? '—'} 条`,
          tags,
          current: this.isPlayingList(item.id),
          syncing: this.store.isSyncingOne(item.id),
        };
      });
    },
    /** 详情头 */
    dialogDetail(): ManagerDetail | null {
      const s = this.selected;
      if (!s) return null;
      return {
        name: s.name,
        countText: `${s.itemCount ?? this.items.length} 条`,
        tags: [{ text: this.kindLabel(s.kind) }],
        meta: [`上次同步：${formatSyncTime(s.lastSyncAt)}`],
      };
    },
    /** 右侧主区停在哪一态 */
    dialogMode(): ManagerMode {
      if (this.creating || this.editing) return 'form';
      return this.selected ? 'detail' : 'empty';
    },
    /**
     * 条目行
     *
     * `key` 用 bvid（同一个视频在列表里只会出现一次）；
     * `index` 必须是**原始下标**，点第 N 行播列表里的第 N 条。
     */
    dialogRows(): ManagerRow[] {
      const record = this.selected;
      const isActive = !!record && this.isPlayingList(record.id);
      return this.items.map((item, index) => ({
        key: item.bvid,
        index,
        title: item.title || item.bvid,
        titleTooltip: item.localPath || '',
        subtitle: item.author || '未知 UP 主',
        cover: normalizeImageUrl(item.cover),
        duration: item.duration,
        playing: isActive && index === record?.lastIndex,
        missing: !!item.missing,
        missingHint: `文件不在这个位置了：${item.localPath || '（路径未知）'}`,
      }));
    },
    /** 空列表时的引导文案按类型分：本地列表要指去「添加视频」 */
    emptyRowsText(): string {
      return this.selected?.kind === 'local'
        ? '这个本地列表还没有条目，点「添加视频」加一条'
        : '这个列表还没有条目，先同步一下';
    },
  },
  watch: {
    /** 打开时重新读一遍列表并按 store 记忆选中（原来是 watch `modelValue`，那个 prop 早就不存在了） */
    visible(v: boolean) {
      if (v) void this.onOpen();
    },
    browseId(v: string) {
      // store 换了「正在看哪个列表」（切模式 / 新建后）：跟着换，别停在旧列表上
      if (v && v !== this.selectedId && this.visible) {
        this.selectedId = v;
      }
    },
    selectedId(v: string) {
      // 换了列表就退出编辑态，否则保存会写到新选中的列表上
      this.editing = false;
      if (v) {
        // 左栏点击、打开时恢复、外部切换都从这里过一遍 ——「正在看哪个」只记一处
        void this.ui.onVideoListBrowse(v);
        void this.loadItems(v);
      } else {
        this.items = [];
      }
    },
    /** 切到「收藏夹 / 订阅合集」时才去拉清单（每次打开弹窗都拉太浪费） */
    'form.source'(v: string) {
      if (!this.creating) return;
      if (v === 'fav' && this.folders.length === 0 && !this.loadingFolders) void this.loadFolders();
      if (v === 'sub' && this.subs.length === 0 && !this.loadingSubs) void this.loadSubs();
    },
  },
  methods: {
    normalizeImageUrl,
    formatDuration,
    async onOpen(): Promise<void> {
      this.creating = false;
      /**
       * 每次打开都重读一遍（纯数据库读，几毫秒）
       *
       * `lastIndex` 会在播放过程中不断被 player store 写库，store 里那份是旧值 ——
       * 不重读的话「正在播」那行会停在打开程序时的位置。
       */
      try {
        await this.store.load();
      } catch (err) {
        ElMessage.error('读取列表失败：' + errMsg(err));
        return;
      }
      /**
       * 停在哪个列表：store 记的 > 正在播的 > 第一个
       *
       * store 那份是「用户上次在看哪个」，关掉再开、从歌单管理切回来都要接上；
       * 直接落到 activeId 的话，切模式把播放留在另一边时就会跳到别的列表。
       */
      const preferred = [this.browseId, this.store.activeId, this.store.lists[0]?.id || ''];
      const target = preferred.find((id) => id && this.store.lists.some((item) => item.id === id));
      this.selectedId = target || this.store.lists[0]?.id || '';
    },
    /**
     * 选中一个列表（只换浏览，不动播放）
     *
     * 「正在看哪个」由 `selectedId` 的 watch 统一记录 —— 左栏点击也走那条路，
     * 这里不再单独调一次（否则同一次切换会记两遍）。
     */
    selectList(id: string): void {
      this.selectedId = id;
    },
    /**
     * 这个视频列表**此刻是不是真的在播**
     *
     * 和歌单侧对称：`activeId` 只在「播放源是视频列表」时才有意义，
     * 播歌单时它会被 `onPlaylistSwitch` 清掉 —— 但那是别处的副作用，
     * 不能当作这里的保证。`queue.mode === 'ov'` 才是唯一判据。
     */
    isPlayingList(id: string): boolean {
      return this.queue.mode === 'ov' && id === this.store.activeId;
    },
    kindLabel(kind: string): string {
      if (kind === 'local') return '本地';
      if (kind === 'season') return '合集';
      if (kind === 'series') return '系列';
      return '收藏夹';
    },
    onImgError(e: Event) {
      const img = e.target as HTMLImageElement;
      const src = img.getAttribute('src');
      if (!src) return;
      if (Object.keys(this.failedCovers).length > 2000) this.failedCovers = {};
      this.failedCovers[src] = true;
    },
    async loadItems(id: string): Promise<void> {
      this.loadingItems = true;
      try {
        this.items = await this.store.items(id);
      } catch (err) {
        ElMessage.error('读取条目失败：' + errMsg(err));
        this.items = [];
      } finally {
        this.loadingItems = false;
      }
    },

    // #region 播放
    /** 从这个列表「上次播到的那条」开始（`lastIndex` 已由主进程按 bvid 重定位） */
    playList(item: VideoListRecord): void {
      if (!item.itemCount) {
        ElMessage.warning('这个列表还没有条目');
        return;
      }
      void this.ui.onVideoListBrowse(item.id);
      void this.queue.onVideoListPlay(item.id, Math.max(0, item.lastIndex || 0));
      this.visible = false;
    },
    playAt(item: VideoListRecord, index: number): void {
      void this.ui.onVideoListBrowse(item.id);
      void this.queue.onVideoListPlay(item.id, index);
      this.visible = false;
    },
    /**
     * 点条目：正常条目直接播，**失效条目先去定位**
     *
     * 不播是因为播了必然失败（主进程 stat 都过不了），失败后还要再弹一次
     * 一模一样的确认框 —— 不如在这儿一步到位。
     *
     * 入参是弹窗归一化后的行（含 `index`），原始条目用 `itemAt(row)` 取。
     */
    onRowPlay(row: ManagerRow): void {
      const record = this.selected;
      if (!record) return;
      const item = this.itemAt(row);
      if (item.missing) {
        void this.relocate(record, item);
        return;
      }
      this.playAt(record, row.index);
    },
    /**
     * 行 → 原始条目
     *
     * 弹窗传回来的行一定是它从 `items` 里映射出来的（同一个下标），
     * 所以这里不判空：真为空说明是 bug，早炸比静默播错好。
     */
    itemAt(row: ManagerRow): VideoListItem {
      const item = this.items[row.index];
      if (!item) throw new Error(`条目不存在：第 ${row.index} 行`);
      return item;
    },
    /**
     * 重新定位一个本地文件
     *
     * 只改路径、**bvid 不变**，所以列表位置 / 收藏 / 进度全都在 —— 这也是为什么
     * 这里不删了重加（那样会得到新 bvid，等于换了一条）。
     */
    async relocate(record: VideoListRecord, item: VideoListItem): Promise<void> {
      const picked = await api.pickLocalVideo(item.localPath || '').catch(() => '');
      if (!picked) return; // 用户取消，什么都不做
      try {
        const res = await api.relocateLocalVideo(item.bvid, picked);
        if (!res.ok) {
          ElMessage.error(res.error || '重新定位失败');
          return;
        }
        ElMessage.success('已重新定位');
        /**
         * 同一份文件从新位置被拖进来过 → 库里已有另一条记录。
         * 不合并（老记录的列表引用还在，合并要动主键），只提醒一句：播放不受影响。
         */
        if (res.duplicate) {
          ElMessage.warning('这个文件还有另一条记录（之前从新位置拖进来过），不影响播放');
        }
        await this.loadItems(record.id);
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('重新定位失败：' + errMsg(err));
      }
    },
    // #endregion

    // #region 新建列表
    /** 打开新建表单（不动左栏选中项：取消时还能回到原来的列表） */
    startCreate(): void {
      // 两个表单互斥：编辑态点「新建」时，编辑表单要让位
      this.editing = false;
      this.creating = true;
      this.form.name = '';
      this.form.source = 'link';
      this.form.link = '';
      this.form.folderId = this.folders[0]?.id ?? '';
      this.form.subKey = this.subs[0] ? this.subKeyOf(this.subs[0]) : '';
    },
    cancelCreate(): void {
      this.creating = false;
    },
    /** 订阅合集的选中值 —— 带上 kind：合集 id 和系列 id 是两套命名空间，可能撞号 */
    subKeyOf(s: SubList): string {
      return `${s.kind}_${s.id}`;
    },
    /** 添加视频：解析链接 / BV 号，插到列表最前（置顶区） */
    /**
     * 「添加视频」：打开确认框
     *
     * 不在这里直接写库 —— 先让用户看到「这条视频是什么」或「这个合集里都有什么」，
     * 确认之后 `VideoImportDialog` 才落库（它拿到的是预览数据，不会二次请求）。
     */
    openImport(record: VideoListRecord): void {
      this.importTarget = { id: record.id, name: record.name };
      this.importVisible = true;
    },
    /** 确认框写完库：重读条目，并让主面板跟着刷新 */
    async onImportDone(): Promise<void> {
      const id = this.importTarget.id;
      if (!id) return;
      await this.loadItems(id);
      void this.ui.refreshBrowseAfterEdit();
    },
    /**
     * 平台列表 → 本地列表
     *
     * 主进程会换一个 id（`bv_local_` 开头）并把条目整体搬过去。
     * 这里要把「正在看的那个列表」和选中项一起重映射，否则界面会指向一个不存在的 id。
     */
    async convert(record: VideoListRecord): Promise<void> {
      try {
        const result = await this.store.convertToLocal(record.id);
        if (this.selectedId === record.id) this.selectedId = result.id;
        if (this.ui.browseVideoListId === record.id) this.ui.browseVideoListId = result.id;
        ElMessage.success(`《${result.name}》已转成本地列表，现在可以改名和增删条目了`);
        await this.loadItems(result.id);
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('转换失败：' + errMsg(err));
      }
    },
    /** 收藏 / 取消收藏某一条（收藏会置顶） */
    async toggleFav(record: VideoListRecord, item: VideoListItem): Promise<void> {
      try {
        await this.store.setFavorite(record.id, item.bvid, !item.favorites);
        await this.loadItems(record.id);
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('收藏失败：' + errMsg(err));
      }
    },
    /** 从列表移除一条（只是关系，不影响某站收藏夹） */
    async removeItem(record: VideoListRecord, item: VideoListItem): Promise<void> {
      try {
        await ElMessageBox.confirm(
          `从《${record.name}》移除《${item.title || item.bvid}》？（某站上的收藏不受影响）`,
          '移除条目',
          { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' },
        );
      } catch {
        return;
      }
      try {
        const ok = await this.store.removeItem(record.id, item.bvid);
        if (!ok) {
          ElMessage.warning('这一条已经不在列表里了');
        }
        await this.loadItems(record.id);
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('移除失败：' + errMsg(err));
      }
    },
    /** 打开编辑页（和歌单管理的「编辑」同一套交互） */
    startEdit(record: VideoListRecord): void {
      this.creating = false;
      this.editForm = {
        name: record.name,
        syncMode: record.syncMode,
        // 没设过间隔时给一个默认值，避免用户选「定时」后是一个空框
        intervalMs: record.syncIntervalMs || SYNC_INTERVAL_OPTIONS[3].value,
      };
      this.editing = true;
    },
    cancelEdit(): void {
      this.editing = false;
    },
    /**
     * 保存编辑
     *
     * 本地列表只有名字可改；平台列表只有同步方式可改（名字是远端的投影，
     * 主进程也会拒绝改）。所以这里按 kind 分两条，不写成一堆 if。
     */
    async saveEdit(): Promise<void> {
      const record = this.selected;
      if (!record) return;
      this.saving = true;
      try {
        if (record.kind === 'local') {
          const name = this.editForm.name.trim();
          if (!name) {
            ElMessage.warning('名字不能为空');
            return;
          }
          if (name !== record.name) {
            const ok = await this.store.rename(record.id, name);
            if (!ok) {
              ElMessage.error('改名失败');
              return;
            }
          }
        } else if (
          this.editForm.syncMode !== record.syncMode ||
          (this.editForm.syncMode === 'interval' &&
            this.editForm.intervalMs !== record.syncIntervalMs)
        ) {
          const ok = await this.store.setSyncMode(
            record.id,
            this.editForm.syncMode,
            this.editForm.intervalMs,
          );
          if (!ok) {
            ElMessage.error('设置同步方式失败');
            return;
          }
        }
        ElMessage.success('已保存');
        this.editing = false;
        await this.loadItems(record.id);
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('保存失败：' + errMsg(err));
      } finally {
        this.saving = false;
      }
    },
    // #endregion

    // #region 导入
    async loadFolders(): Promise<void> {
      this.loadingFolders = true;
      this.folderError = '';
      try {
        /**
         * 封面在这里就规整成绝对 https（`normalizeImageUrl`）
         *
         * 不能留给模板：某站给的是 `//i0.hdslb.com/…` 这种协议相对地址，
         * 页面 origin 是 `blwe://app` 或 `file://`，直接绑上去会被解析成
         * `blwe://i0.hdslb.com/…` —— 图全裂。
         *
         * 另一个原因是 `failedCovers` 的键要用**规整后**的地址：
         * `onImgError` 取的是 `img.getAttribute('src')`，那就是绑定上去的那个值，
         * 两边不一致的话某张图会反复重试加载。
         */
        this.folders = (await api.fetchMyFavFolders()).map((f) => ({
          ...f,
          cover: normalizeImageUrl(f.cover),
        }));
        if (this.folders.length > 0 && !this.form.folderId) this.form.folderId = this.folders[0].id;
      } catch (err) {
        /**
         * 未登录 / 接口被风控都会走到这里。**不是错误弹窗**，而是一句行内提示 ——
         * 用户此时要做的是「去登录」或「改用粘贴链接」，弹窗只会挡路。
         */
        this.folders = [];
        this.folderError = errMsg(err);
      } finally {
        this.loadingFolders = false;
      }
    },
    async loadSubs(): Promise<void> {
      this.loadingSubs = true;
      this.subError = '';
      try {
        // 封面规整的理由同 `loadFolders`
        this.subs = (await api.fetchMySubLists()).map((s) => ({
          ...s,
          cover: normalizeImageUrl(s.cover),
        }));
        if (this.subs.length > 0 && !this.form.subKey) {
          this.form.subKey = this.subKeyOf(this.subs[0]);
        }
      } catch (err) {
        // 和收藏夹同一条原则：读不出来就在行内说原因，别弹窗挡路
        this.subs = [];
        this.subError = errMsg(err);
      } finally {
        this.loadingSubs = false;
      }
    },
    /**
     * 提交「新建列表」
     *
     * 四条来源最后都收敛到两个动作：**建空列表**（`createLocal`）或**导入**（`store.add`）。
     * 名字留空的语义两边不同，因此这里只在用户真填了名字时才改名 ——
     * 导入时留空就该用远端标题，而不是被一个空字符串覆盖掉。
     */
    async submitCreate(): Promise<void> {
      const name = this.form.name.trim();

      // ① 空列表：建完就能「添加视频」
      if (this.form.source === 'local') {
        this.creatingBusy = true;
        try {
          const record = await this.store.createLocal(name || undefined);
          this.creating = false;
          this.selectList(record.id);
          void this.ui.refreshBrowseAfterEdit();
          ElMessage.success(`已创建《${record.name}》，点「添加视频」往里加条目`);
        } catch (err) {
          ElMessage.error('创建失败：' + errMsg(err));
        } finally {
          this.creatingBusy = false;
        }
        return;
      }

      // ② 三种导入来源 → (kind, sourceId, mid)
      let kind: 'fav' | 'season' | 'series' | null = null;
      let sourceId = '';
      let mid: string | undefined;

      if (this.form.source === 'link') {
        const text = this.form.link.trim();
        if (!text) {
          ElMessage.warning('请粘贴某站列表链接');
          return;
        }
        const parsed = await api.parseListInput(text);
        if (!parsed || parsed.kind === 'local') {
          ElMessage.warning('没认出这是列表链接，请确认复制的是收藏夹 / 合集 / 系列的地址');
          return;
        }
        kind = parsed.kind;
        sourceId = parsed.id;
        mid = parsed.mid;
      } else if (this.form.source === 'fav') {
        if (this.folders.length === 0) await this.loadFolders();
        if (!this.form.folderId) {
          ElMessage.warning('先选一个收藏夹');
          return;
        }
        kind = 'fav';
        sourceId = this.form.folderId;
      } else {
        if (this.subs.length === 0) await this.loadSubs();
        const picked = this.subs.find((s) => this.subKeyOf(s) === this.form.subKey);
        if (!picked) {
          ElMessage.warning('先选一个订阅合集');
          return;
        }
        kind = picked.kind;
        sourceId = picked.id;
        mid = picked.mid;
      }
      if (!kind) return;

      this.creatingBusy = true;
      try {
        const { record, skipped, existed } = await this.store.add(kind, sourceId, mid);
        // 用户填了名字就覆盖远端标题（没填则保留远端标题，别用空串把它洗掉）
        const finalName = name && name !== record.name ? name : record.name;
        if (name && name !== record.name) await this.store.rename(record.id, name);
        ElMessage.success(
          `${existed ? '已同步' : '已导入'}《${finalName}》${record.itemCount ?? ''} 条` +
            (skipped > 0 ? `（跳过 ${skipped} 个不支持的条目）` : ''),
        );
        this.creating = false;
        this.selectList(record.id);
        // 重复导入同一个列表时 selectedId 没变，watch 不会触发 —— 手动刷一次条目
        await this.loadItems(record.id);
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('导入失败：' + errMsg(err));
      } finally {
        this.creatingBusy = false;
      }
    },
    // #endregion

    // #region 同步 / 删除
    async syncOne(item: VideoListRecord): Promise<void> {
      try {
        const r = await this.store.sync(item.id);
        if (!r.ok) {
          ElMessage.warning(`${item.name}：${r.error ?? '同步失败'}`);
          return;
        }
        ElMessage.success(
          `${r.name}：+${r.added ?? 0}/-${r.removed ?? 0}` +
            (r.skipped ? `（跳过 ${r.skipped} 个）` : ''),
        );
        if (this.selectedId === item.id) await this.loadItems(item.id);
        // 正在播的就是这个列表 → 队列里的条目可能变了（增删都算）。
        // `reloadCurrentPlaylistSongs` 只换 songs 数组、保持当前播放，不会打断。
        if (this.store.activeId === item.id) void this.queue.reloadCurrentPlaylistSongs();
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('同步失败：' + errMsg(err));
      }
    },
    /**
     * 「全部同步」
     *
     * 走 store 的 `syncAll`：那里的过滤（本地列表跳过、手动同步的跳过）
     * 和启动同步 / 定时同步用的是**同一份**判断，不会三处各写一套。
     * store 内部串行、失败不打断后面的。
     */
    async syncAll(): Promise<void> {
      try {
        const results = await this.store.syncAll();
        const okCount = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok);
        if (okCount > 0) ElMessage.success(`已同步 ${okCount} 个列表`);
        for (const r of failed) {
          ElMessage.warning(`${r.name} 同步失败：${r.error ?? '未知错误'}`);
        }
        if (this.selectedId) await this.loadItems(this.selectedId);
        // 正在播的列表如果在这次同步里，队列也得重载
        if (results.some((r) => r.ok && r.id === this.store.activeId)) {
          void this.queue.reloadCurrentPlaylistSongs();
        }
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('同步失败：' + errMsg(err));
      }
    },
    async remove(item: VideoListRecord): Promise<void> {
      const ok = await this.store.remove(item.id);
      if (!ok) {
        ElMessage.error('删除失败');
        return;
      }
      ElMessage.success(`已删除《${item.name}》`);
      if (this.selectedId === item.id) {
        const next = this.store.lists[0]?.id ?? '';
        this.selectList(next);
      }
      void this.ui.refreshBrowseAfterEdit();
    },
    // #endregion
  },
});
</script>

<style scoped>
/*
 * 只留「视频列表独有」的几块：行尾按钮（定位 / 收藏 / 移除）、收藏夹与订阅合集的封面网格，
 * 以及表单里 <code> 的那点样式。弹窗骨架、左列表、条目行骨架、空态都在
 * `ManagerDialog.vue` 里（非 scoped，类名 `mgr-`），两个管理器共用一份。
 */
/*
 * 条目行尾：收藏爱心
 *
 * 「移除」那个 × 用的是 `ManagerDialog` 里的 `.mgr-row-btn`（歌单管理也用同一个），
 * 这里只留爱心 —— 它有 `on` 状态，比通用按钮多一条规则。
 */
.vlm-item-fav {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  opacity: 0.45;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}
.vlm-item-fav:hover {
  background: var(--panel-hover);
  opacity: 1;
}
.vlm-item-fav.on {
  opacity: 1;
  color: var(--accent-danger);
}

/* 行尾的「定位」：失效条目的主操作，比图标按钮更需要被看见 */
.vlm-item-fix {
  flex: none;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: calc(11px * var(--fs));
  line-height: 21px;
  color: var(--accent-strong);
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}
.vlm-item-fix:hover {
  background: var(--panel-hover);
  border-color: var(--accent-strong);
}

.mgr-hint code {
  background: var(--panel-hover);
  padding: 0 3px;
  border-radius: 3px;
}
/*
 * 封面网格（收藏夹 / 订阅合集的选片器）
 *
 * 为什么不用 `el-select`：这两个清单的标题高度同质（「默认收藏夹」「我的收藏」
 * 「收藏夹1」…），下拉里只剩一行字，选一次要把每行都读一遍；封面能一眼认出来。
 *
 * 布局用 `auto-fill` 而不是固定列数：弹窗宽度是 900px，但右侧栏还要留给条目表，
 * 视口一窄就得自己掉列 —— 写死 4 列会在小屏上把封面挤成一条缝。
 * 「宽度自适应 + 最小 108px」正好让 3~5 列之间自然过渡。
 */
.vlm-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  gap: 8px;
  /* 清单可能几十个（订阅合集实测常见几十），限高自己滚，别把「取消/导入」顶出视野 */
  max-height: 270px;
  overflow-y: auto;
  padding: 2px;
}
.vlm-pick {
  cursor: pointer;
  padding: 4px;
  border-radius: 7px;
  /* 未选中时也给一圈透明边框：选中后加边框不会让整格尺寸跳动 */
  border: 1px solid transparent;
  transition: background-color 0.12s, border-color 0.12s;
}
.vlm-pick:hover {
  background: var(--panel-hover);
}
.vlm-pick.sel {
  background: var(--panel-active);
  border-color: var(--accent);
}
.vlm-pick-cover {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 5px;
  overflow: hidden;
  background: rgba(128, 128, 128, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
}
.vlm-pick-cover img {
  width: 100%;
  height: 100%;
  /* cover 而不是 contain：合集封面几乎都是 16:9，个别不是的宁可裁边也别留黑边 */
  object-fit: cover;
  display: block;
}
.vlm-pick-name {
  font-size: calc(12px * var(--fs));
  margin-top: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 选中项的标题用强调色：网格里一眼看到「我选了哪个」，不必去找那圈边框 */
.vlm-pick.sel .vlm-pick-name {
  color: var(--accent-strong);
  font-weight: 600;
}
.vlm-pick-meta {
  font-size: calc(11px * var(--fs));
  opacity: 0.55;
  margin-top: 1px;
  font-variant-numeric: tabular-nums;
}
</style>
