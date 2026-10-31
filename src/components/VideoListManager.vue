<template>
  <!--
    B 站视频列表（收藏夹 / 合集 / 系列）

    与「歌单管理」并列的第二条进料管：这里的每个条目**本来就是视频**，
    导入后直接落库，播放时不再搜索。

    为什么单独一个弹窗而不是塞进歌单管理：两种来源的表、id、同步方式都不一样，
    混在一个界面里必然要到处判断「这条是歌还是视频」。分开之后，
    两边各自简单，用户也一眼能看出自己在哪个来源里。
  -->
  <el-dialog
    v-model="visible"
    width="900px"
    :show-close="false"
    append-to-body
    align-center
  >
    <template #header>
      <div class="vlm-head">
        <span class="vlm-title">视频管理</span>
        <span class="vlm-summary">
          共 {{ store.lists.length }} 个列表 · {{ totalItems }} 条视频
        </span>
      </div>
    </template>

    <div class="vlm-body">
      <!-- 左：列表 -->
      <div class="vlm-side">
        <div class="vlm-side-list">
          <div
            v-for="item in store.lists"
            :key="item.id"
            class="vlm-list-row"
            :class="{ sel: item.id === selectedId, cur: item.id === store.activeId }"
            @click="selectList(item.id)"
          >
            <div class="vlm-list-main">
              <div class="vlm-list-name" :title="item.name">
                <span v-if="item.id === store.activeId" class="vlm-dot" title="正在播放"></span>
                {{ item.name }}
              </div>
              <div class="vlm-list-meta">
                <span>{{ item.itemCount ?? '—' }} 条</span>
                <span class="vlm-tag">{{ kindLabel(item.kind) }}</span>
                <!-- 默认列表：拖入单条视频的落点，不能删（可以改名） -->
                <span v-if="item.isDefault" class="vlm-tag vlm-tag-default" title="拖入单条视频会放进这里">
                  默认
                </span>
                <span v-if="store.isSyncingOne(item.id)" class="vlm-syncing">同步中…</span>
              </div>
            </div>
          </div>
          <div v-if="store.lists.length === 0" class="vlm-empty">
            还没有列表，点下面「新建列表」开始
          </div>
        </div>
        <div class="vlm-side-actions">
          <div class="vlm-side-row">
            <!--
              「新建列表」= 唯一入口（和歌单管理的「新建歌单」对称）

              以前这里是「导入列表」+「新建本地列表」两个按钮，等于让用户先自己判断
              「我要的是哪种列表」。现在合成一个：先建列表，再选内容从哪来
              （空 / 链接 / 收藏夹 / 订阅合集）—— 建列表是目的，导入只是其中一种填法。
            -->
            <el-button size="small" type="primary" @click="startCreate">新建列表</el-button>
            <el-button
              size="small"
              :disabled="syncableCount === 0 || store.syncing.length > 0"
              :loading="store.syncing.length > 0"
              @click="syncAll"
            >
              全部同步
            </el-button>
          </div>
          <!-- 切回 MV 模式（和歌单管理里那个「视频管理 →」对称） -->
          <el-button class="vlm-side-switch" size="small" @click="void ui.openManager('mv')">
            ← 歌单管理
          </el-button>
        </div>
      </div>

      <!-- 右：新建表单 或 选中列表的条目 -->
      <div class="vlm-main">
        <!--
          新建列表（内联表单，不另开弹窗）

          和歌单管理「新建歌单」是同一套观感：左边列表固定不动，右边换成一列字段。
          四种来源在这里收口，用户不需要先知道「本地列表 / 导入」的区别。
        -->
        <div v-if="creating" class="vlm-form">
          <div class="vlm-form-title">新建列表</div>

          <div class="vlm-field">
            <label>列表名称</label>
            <el-input
              v-model="form.name"
              size="small"
              clearable
              :placeholder="form.source === 'local' ? '留空自动叫「本地列表」' : '留空自动取远端标题'"
            />
          </div>

          <div class="vlm-field">
            <label>内容来源</label>
            <el-radio-group v-model="form.source" size="small">
              <el-radio-button value="local">空列表</el-radio-button>
              <el-radio-button value="link">粘贴链接</el-radio-button>
              <el-radio-button value="fav">收藏夹</el-radio-button>
              <el-radio-button value="sub">订阅合集</el-radio-button>
            </el-radio-group>
          </div>

          <!-- ① 粘贴链接 -->
          <div v-if="form.source === 'link'" class="vlm-field">
            <el-input
              v-model="form.link"
              size="small"
              clearable
              placeholder="粘贴收藏夹 / 合集 / 系列链接，如 https://space.bilibili.com/123/favlist?fid=456"
            />
            <div class="vlm-hint">
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
          <div v-else-if="form.source === 'fav'" class="vlm-field">
            <div v-if="loadingFolders" class="vlm-hint">正在读取你的收藏夹…</div>
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
              <div v-else class="vlm-hint">
                <span v-if="folderError">{{ folderError }}</span>
                <span v-else>没有读到收藏夹。私密收藏夹需要先登录 B 站账号。</span>
                <el-button link type="primary" size="small" @click="loadFolders">重新读取</el-button>
              </div>
            </template>
          </div>

          <!--
            ③ 订阅合集（我**收藏的**别人做的合集）
            数据来自 `x/v3/fav/folder/collected/list`，那里 `type = 21` 的才是合集；
            收藏的「收藏夹」也在同一个响应里，但 media_id 语义不同，不收（见 biliApi.ts）。
          -->
          <div v-else-if="form.source === 'sub'" class="vlm-field">
            <div v-if="loadingSubs" class="vlm-hint">正在读取订阅合集…</div>
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
              <div v-else class="vlm-hint">
                <span v-if="subError">{{ subError }}</span>
                <span v-else>没有读到订阅合集。在 B 站收藏别人的合集之后，这里才会出现。</span>
                <el-button link type="primary" size="small" @click="loadSubs">重新读取</el-button>
              </div>
            </template>
          </div>

          <!-- ④ 空列表 -->
          <div v-else class="vlm-hint">
            不导入内容：建一个空列表，之后用「添加视频」一条条加，或者直接把视频链接拖进窗口。
          </div>

          <div class="vlm-form-actions">
            <el-button size="small" @click="cancelCreate">取消</el-button>
            <el-button size="small" type="primary" :loading="creatingBusy" @click="submitCreate">
              {{ creatingBusy ? '处理中…' : form.source === 'local' ? '创建' : '导入' }}
            </el-button>
          </div>
          <div class="vlm-hint">
            导入只写列表和条目（几百条会跑几秒），播放地址等第一次播放时才取 ——
            一次性预取几百个地址既慢又容易被风控。
          </div>
        </div>

        <!-- 条目 -->
        <template v-else-if="selected">
          <div class="vlm-main-head">
            <div class="vlm-main-info">
              <div class="vlm-main-name">{{ selected.name }}</div>
              <div class="vlm-main-sub">
                <span>{{ selected.itemCount ?? items.length }} 条</span>
                <span class="vlm-tag">{{ kindLabel(selected.kind) }}</span>
                <span>上次同步：{{ lastSyncText(selected.lastSyncAt) }}</span>
              </div>
            </div>
            <div class="vlm-main-actions">
              <el-button size="small" @click="playList(selected)">从这里播放</el-button>
              <el-button size="small" @click="addItem(selected)">添加视频</el-button>
              <el-button size="small" @click="rename(selected)">重命名</el-button>
              <el-button
                size="small"
                :disabled="selected.kind === 'local'"
                :loading="store.isSyncingOne(selected.id)"
                @click="syncOne(selected)"
              >
                同步
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
            </div>
          </div>

          <div class="vlm-search">
            <el-input v-model="keyword" size="small" placeholder="搜索标题 / UP 主" clearable />
            <span class="vlm-search-count">{{ filtered.length }} / {{ items.length }}</span>
          </div>

          <div class="vlm-items">
            <div
              v-for="row in filtered"
              :key="row.item.bvid"
              class="vlm-item"
              :class="{ playing: isPlaying(row), missing: row.item.missing }"
              @click="onRowClick(selected, row)"
            >
              <div class="vlm-idx">{{ row.index + 1 }}</div>
              <div class="vlm-thumb">
                <img
                  v-if="coverOf(row.item) && !failedCovers[coverOf(row.item) as string]"
                  :src="coverOf(row.item) as string"
                  alt=""
                  referrerpolicy="no-referrer"
                  loading="lazy"
                  @error="onImgError"
                />
              </div>
              <div class="vlm-item-info">
                <div class="vlm-item-name" :title="row.item.localPath || row.item.title">
                  {{ row.item.title || row.item.bvid }}
                </div>
                <div class="vlm-item-more">
                  <span class="vlm-item-author">{{ row.item.author || '未知 UP 主' }}</span>
                  <!--
                    本地文件失效标：打开列表时主进程已经 stat 过一遍（`missing`），
                    所以「哪几条播不了」在这里就能看见，不用等播到它才失败。
                  -->
                  <span
                    v-if="row.item.missing"
                    class="vlm-missing-tag"
                    :title="`文件不在这个位置了：${row.item.localPath || '（路径未知）'}`"
                  >
                    文件丢失
                  </span>
                </div>
              </div>
              <div class="vlm-item-dur">{{ formatDuration(row.item.duration) }}</div>
              <!-- 失效条目的主操作是「定位」，放到收藏前面（收藏对它没用） -->
              <div
                v-if="row.item.missing"
                class="vlm-item-fix"
                title="重新定位到这个文件的新位置（列表位置 / 收藏 / 进度都保留）"
                @click.stop="relocate(selected, row.item)"
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
                :class="{ on: row.item.favorites }"
                :title="row.item.favorites ? '取消收藏' : '收藏（会置顶）'"
                @click.stop="toggleFav(selected, row.item)"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  :fill="row.item.favorites ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linejoin="round"
                >
                  <path d="M8 13.1S2.3 9.7 2.3 6.2c0-1.7 1.3-3 3-3 1.2 0 2.2.7 2.7 1.7.5-1 1.5-1.7 2.7-1.7 1.7 0 3 1.3 3 3 0 3.5-5.7 6.9-5.7 6.9z" />
                </svg>
              </div>
              <div
                class="vlm-item-del"
                title="从列表移除（不影响 B 站上的收藏）"
                @click.stop="removeItem(selected, row.item)"
              >
                ×
              </div>
            </div>
            <div v-if="loadingItems" class="vlm-empty">正在读取条目…</div>
            <div v-else-if="filtered.length === 0" class="vlm-empty">
              {{
                items.length === 0
                  ? selected.kind === 'local'
                    ? '这个本地列表还没有条目，点「添加视频」加一条'
                    : '这个列表还没有条目，先同步一下'
                  : '没有匹配的视频'
              }}
            </div>
          </div>
        </template>

        <div v-else class="vlm-empty big">
          从左边选一个列表查看条目，或点「新建列表」从链接 / 收藏夹 / 订阅合集导入
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { VideoListItem, VideoListRecord } from '@common/types/playlist';
import { formatDuration } from '@common/utils/duration';
import api from '../api/electron';
import { useVideoListStore } from '../stores/videoLists';
import { normalizeImageUrl } from '../utils/image';
import { useUiStore } from '../stores/ui';
import { useQueueStore } from '../stores/queue';

export interface Row {
  index: number;
  item: VideoListItem;
}

/**
 * 订阅合集里的一项（主进程 `fetchMySubscribedLists` 的返回形状）
 *
 * `kind` 目前恒为 `'season'`（只收 `type = 21` 的合集）；类型里留着 `'series'`
 * 是因为「系列」也是 B 站的一类列表，将来若找到来源可以不做类型改动就接上。
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

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

export default defineComponent({
  name: 'VideoListManager',
  data() {
    return {
      selectedId: '',
      keyword: '',
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
    syncableCount(): number {
      return this.store.lists.filter((item) => item.kind !== 'local').length;
    },
    selected(): VideoListRecord | null {
      return this.store.find(this.selectedId);
    },
    filtered(): Row[] {
      // 行号必须是**原下标**：点第 N 行要播列表里的第 N 条，
      // 筛过之后再从 0 数就会播错（和歌单管理那边同一个坑）
      const rows: Row[] = this.items.map((item, index) => ({ index, item }));
      const kw = this.keyword.trim().toLowerCase();
      if (!kw) return rows;
      return rows.filter(
        (r) =>
          (r.item.title || '').toLowerCase().includes(kw) ||
          (r.item.author || '').toLowerCase().includes(kw),
      );
    },
  },
  watch: {
    modelValue(v: boolean) {
      if (v) void this.onOpen();
    },
    browseId(v: string) {
      // store 换了「正在看哪个列表」（切模式 / 新建后）：跟着换，别停在旧列表上
      if (v && v !== this.selectedId && this.visible) {
        this.selectedId = v;
      }
    },
    selectedId(v: string) {
      this.keyword = '';
      if (v) void this.loadItems(v);
      else this.items = [];
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
        ElMessage.error('读取列表失败：' + this.errMsg(err));
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
    /** 左侧选中一个列表（只换浏览，不动播放） */
    selectList(id: string): void {
      this.selectedId = id;
      void this.ui.onVideoListBrowse(id);
    },
    errMsg(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
    },
    kindLabel(kind: string): string {
      if (kind === 'local') return '本地';
      if (kind === 'season') return '合集';
      if (kind === 'series') return '系列';
      return '收藏夹';
    },
    lastSyncText(at: number | null): string {
      if (!at) return '从未';
      const d = new Date(at);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    coverOf(item: VideoListItem): string | null {
      return normalizeImageUrl(item.cover);
    },
    onImgError(e: Event) {
      const img = e.target as HTMLImageElement;
      const src = img.getAttribute('src');
      if (!src) return;
      if (Object.keys(this.failedCovers).length > 2000) this.failedCovers = {};
      this.failedCovers[src] = true;
    },
    isPlaying(row: Row): boolean {
      // 只有「当前在播的就是这个列表」时才有「正在播」这回事
      if (this.selected?.id !== this.store.activeId) return false;
      return row.index === this.selected?.lastIndex;
    },
    async loadItems(id: string): Promise<void> {
      this.loadingItems = true;
      try {
        this.items = await this.store.items(id);
      } catch (err) {
        ElMessage.error('读取条目失败：' + this.errMsg(err));
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
     */
    onRowClick(record: VideoListRecord, row: Row): void {
      if (row.item.missing) {
        void this.relocate(record, row.item);
        return;
      }
      this.playAt(record, row.index);
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
        ElMessage.error('重新定位失败：' + this.errMsg(err));
      }
    },
    // #endregion

    // #region 新建列表
    /** 打开新建表单（不动左栏选中项：取消时还能回到原来的列表） */
    startCreate(): void {
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
    async addItem(record: VideoListRecord): Promise<void> {
      let input = '';
      try {
        const { value } = await ElMessageBox.prompt(
          '粘贴 B 站视频链接或 BV 号',
          `添加到《${record.name}》`,
          {
            confirmButtonText: '添加',
            cancelButtonText: '取消',
            inputPlaceholder: 'BV1xx411c7mD 或 https://www.bilibili.com/video/BV...',
          },
        );
        input = (value || '').trim();
      } catch {
        return;
      }
      if (!input) return;
      try {
        const item = await this.store.addItem(record.id, input);
        await this.loadItems(record.id);
        void this.ui.refreshBrowseAfterEdit();
        ElMessage.success(`已添加《${item.title || item.bvid}》`);
      } catch (err) {
        ElMessage.error('添加失败：' + this.errMsg(err));
      }
    },
    /** 收藏 / 取消收藏某一条（收藏会置顶） */
    async toggleFav(record: VideoListRecord, item: VideoListItem): Promise<void> {
      try {
        await this.store.setFavorite(record.id, item.bvid, !item.favorites);
        await this.loadItems(record.id);
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('收藏失败：' + this.errMsg(err));
      }
    },
    /** 从列表移除一条（只是关系，不影响 B 站收藏夹） */
    async removeItem(record: VideoListRecord, item: VideoListItem): Promise<void> {
      try {
        await ElMessageBox.confirm(
          `从《${record.name}》移除《${item.title || item.bvid}》？（B 站上的收藏不受影响）`,
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
        ElMessage.error('移除失败：' + this.errMsg(err));
      }
    },
    /** 重命名 */
    async rename(record: VideoListRecord): Promise<void> {
      let name = '';
      try {
        const { value } = await ElMessageBox.prompt('列表名称', '重命名', {
          confirmButtonText: '保存',
          cancelButtonText: '取消',
          inputValue: record.name,
        });
        name = (value || '').trim();
      } catch {
        return;
      }
      if (!name || name === record.name) return;
      try {
        const ok = await this.store.rename(record.id, name);
        if (!ok) {
          ElMessage.error('重命名失败');
          return;
        }
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('重命名失败：' + this.errMsg(err));
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
         * 不能留给模板：B 站给的是 `//i0.hdslb.com/…` 这种协议相对地址，
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
        this.folderError = this.errMsg(err);
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
        this.subError = this.errMsg(err);
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
          ElMessage.error('创建失败：' + this.errMsg(err));
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
          ElMessage.warning('请粘贴 B 站列表链接');
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
        ElMessage.error('导入失败：' + this.errMsg(err));
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
        void this.ui.refreshBrowseAfterEdit();
      } catch (err) {
        ElMessage.error('同步失败：' + this.errMsg(err));
      }
    },
    async syncAll(): Promise<void> {
      // 本地列表没有远端来源，跳过（按钮的禁用条件也按「可同步列表数」算）
      for (const item of this.store.lists.filter((l) => l.kind !== 'local')) {
        // 串行：并发拉列表很容易触发 412，而且这里的失败率不值得赌
        // eslint-disable-next-line no-await-in-loop
        await this.syncOne(item);
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
.vlm-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.vlm-title {
  font-size: 16px;
  font-weight: 600;
}
.vlm-summary {
  font-size: 12px;
  opacity: 0.55;
}
.vlm-body {
  display: flex;
  gap: 14px;
  height: 60vh;
}
.vlm-side {
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--panel-divider);
  padding-right: 12px;
}
.vlm-side-list {
  flex: 1;
  overflow-y: auto;
}
.vlm-list-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 7px;
  cursor: pointer;
  margin-bottom: 2px;
}
.vlm-list-row:hover {
  background: var(--panel-hover);
}
.vlm-list-row.sel {
  background: var(--panel-active);
}
.vlm-list-row.cur .vlm-list-name {
  font-weight: 600;
}
.vlm-list-main {
  flex: 1;
  min-width: 0;
}
.vlm-list-name {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vlm-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}
.vlm-list-meta {
  display: flex;
  gap: 6px;
  font-size: 11px;
  opacity: 0.55;
  margin-top: 2px;
}
.vlm-tag {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-hover);
}
/* 「默认」标记：和普通来源标签区分开（它是身份，不是来源） */
.vlm-tag-default {
  color: var(--accent);
}
.vlm-syncing {
  color: var(--accent);
}
.vlm-side-actions {
  display: flex;
  /* 竖排：第一行新建/同步，第二行切回歌单管理 */
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--panel-divider);
}
.vlm-side-row {
  display: flex;
  gap: 6px;
}
.vlm-side-actions :deep(.el-button) {
  flex: 1;
  margin-left: 0;
}
/* 「← 歌单管理」：它是切换器，视觉上要比动作按钮弱一档 */
.vlm-side-switch {
  opacity: 0.85;
}
/* 条目行尾：收藏爱心 / 移除 */
.vlm-item-fav,
.vlm-item-del {
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
.vlm-item-fav:hover,
.vlm-item-del:hover {
  background: var(--panel-hover);
  opacity: 1;
}
.vlm-item-fav.on {
  opacity: 1;
  color: var(--accent-danger);
}
.vlm-item-del {
  font-size: 16px;
  line-height: 1;
}

/*
 * 失效的本地文件条目
 *
 * 做法是「压暗 + 保留点击」而不是「禁用」：点它不会播放（播了必然失败），
 * 而是直接弹重新定位 —— 用户看到一行灰的，第一反应就是「怎么修」，
 * 这时让他点了没反应是最糟的。
 */
.vlm-item.missing .vlm-idx,
.vlm-item.missing .vlm-item-name,
.vlm-item.missing .vlm-item-dur {
  opacity: 0.45;
}
.vlm-item.missing .vlm-thumb {
  opacity: 0.4;
}
/* 下面那个角标是警告，不能被父级的 0.6 透明度一起压掉 */
.vlm-item.missing .vlm-item-more {
  opacity: 1;
}
.vlm-item.missing .vlm-item-author {
  opacity: 0.5;
}
.vlm-missing-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 15px;
  color: var(--accent-danger);
  border: 1px solid var(--accent-danger);
}
/* 行尾的「定位」：失效条目的主操作，比图标按钮更需要被看见 */
.vlm-item-fix {
  flex: none;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: 11px;
  line-height: 21px;
  color: var(--accent-strong);
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}
.vlm-item-fix:hover {
  background: var(--panel-hover);
  border-color: var(--accent-strong);
}

.vlm-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.vlm-main-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 9px;
}
.vlm-main-info {
  flex: 1;
  min-width: 0;
}
.vlm-main-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vlm-main-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  opacity: 0.55;
  margin-top: 3px;
}
.vlm-main-actions {
  display: flex;
  gap: 6px;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.vlm-main-actions :deep(.el-button) {
  margin-left: 0;
}
.vlm-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.vlm-search-count {
  font-size: 11px;
  opacity: 0.55;
  flex: none;
}
.vlm-items {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--panel-divider);
  border-radius: 8px;
}
.vlm-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 9px;
  cursor: pointer;
  border-bottom: 1px solid var(--panel-hover);
}
.vlm-item:last-child {
  border-bottom: none;
}
.vlm-item:hover {
  background: var(--panel-hover);
}
.vlm-item.playing {
  background: var(--panel-active);
}
.vlm-item.playing .vlm-item-name {
  color: var(--accent-strong);
  font-weight: 600;
}
.vlm-idx {
  width: 30px;
  flex: none;
  text-align: right;
  font-size: 11px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.vlm-thumb {
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
.vlm-thumb img {
  height: 32px;
  width: auto;
  max-width: 84px;
  object-fit: contain;
  display: block;
}
.vlm-item-info {
  flex: 1;
  min-width: 0;
}
.vlm-item-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vlm-item-more {
  display: flex;
  gap: 7px;
  font-size: 11px;
  opacity: 0.6;
  margin-top: 1px;
  overflow: hidden;
}
.vlm-item-author {
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vlm-item-dur {
  flex: none;
  font-size: 11px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

.vlm-form {
  padding: 2px 4px;
  overflow-y: auto;
}
.vlm-form-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
}
/* 和歌单管理的 `.plm-field` 保持同一套间距，两个弹窗看起来才是一家的 */
.vlm-field {
  margin-bottom: 12px;
}
.vlm-field label {
  display: block;
  font-size: 12px;
  opacity: 0.7;
  margin-bottom: 5px;
}
.vlm-hint {
  font-size: 11px;
  opacity: 0.55;
  margin-top: 6px;
  line-height: 1.6;
}
.vlm-hint code {
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
  font-size: 12px;
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
  font-size: 11px;
  opacity: 0.55;
  margin-top: 1px;
  font-variant-numeric: tabular-nums;
}
.vlm-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 10px;
  margin-top: 8px;
  border-top: 1px solid var(--panel-divider);
}
.vlm-empty {
  padding: 24px 8px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}
.vlm-empty.big {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
