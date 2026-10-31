/**
 * Drop store —— 拖入导入：分类、四路分派、本地文件探针。
 *
 * 状态与动作都只属于这一个业务域；跨域访问通过 getters 里那几个 `xxxStore`
 * 指针拿到别的 store 实例（惰性求值，所以模块之间可以互相 import 而不成环）。
 */
import { defineStore } from 'pinia';
import type { DropInputTarget } from '@common/types/playlist';
import type { AppData } from '../types/app';
import { ElMessage } from 'element-plus';
import electronApi from '../api/electron';
import { probeMedia } from '../utils/mediaProbe';

import { usePlaylistStore } from './playlists';
import { useQueueStore } from './queue';
import { useUiStore } from './ui';
import { useVideoListStore } from './videoLists';

/** ===== state ===== */
export type DropState = Pick<
  AppData,
  'dropActive' | 'dropBusy' | '_dragDepth'
>;

export const dropState = (): DropState => ({
  /** 正拖着东西悬在窗口上（显示「松手导入」遮罩） */
  dropActive: false,

  /** 正在导入拖进来的东西（遮罩上转圈，挡住第二次拖入） */
  dropBusy: false,

  /** dragenter/dragleave 的进出计数（子元素之间移动也会触发，不能只用布尔） */
  _dragDepth: 0,
});

/** ===== getters ===== */
export interface DropGetters {
  readonly playlistsStore: ReturnType<typeof usePlaylistStore>;
  readonly queueStore: ReturnType<typeof useQueueStore>;
  readonly uiStore: ReturnType<typeof useUiStore>;
  readonly videoListsStore: ReturnType<typeof useVideoListStore>;

}

export type DropGetterFns = { [K in keyof DropGetters]: () => DropGetters[K] };

export const dropGetters: ThisType<DropContext> = {
  playlistsStore: () => usePlaylistStore(),
  queueStore: () => useQueueStore(),
  uiStore: () => useUiStore(),
  videoListsStore: () => useVideoListStore(),

};

/** ===== actions ===== */
export interface DropActions {
  dropTextOf(e: DragEvent): string;
  onDocDragEnter(e: DragEvent): void;
  onDocDragOver(e: DragEvent): void;
  onDocDragLeave(): void;
  onDocDrop(e: DragEvent): void;
  handleDroppedText(text: string): Promise<void>;
  dropImportMusic(url: string): Promise<void>;
  dropImportSong(url: string): Promise<void>;
  dropImportList(target: { kind: 'fav' | 'season' | 'series'; id: string; mid?: string }): Promise<void>;
  dropImportVideo(input: string): Promise<void>;
  handleDroppedFiles(files: File[]): Promise<void>;
  probeLocalDurations( listId: string, items: Array<{ bvid: string; url: string }>, ): Promise<void>;
}

export type DropContext = DropState & DropGetters & DropActions;

export const dropActions: ThisType<DropContext> = {
  /**
   * 拖入的**文本**是啥？（从 DataTransfer 里取）
   *
   * 顺序有讲究：
   *  1. `text/uri-list` —— 从浏览器地址栏 / 页面链接拖出来最标准的形态；
   *     多行时只取第一行有效行（`#` 开头的是注释）；
   *  2. `text/plain` —— 很多页面拖拽只给这个（分享文案、裸链接、纯 BV 号）；
   *  3. `text/html` —— 最后兜底，从里面抠第一个 `href`。
   *
   * ⚠️ 只有 `drop` 事件里才读得到真实内容（浏览器在 dragover 阶段出于安全
   * 把数据清空，只留 `types`），所以识别不放在 dragover 里做。
   */
  dropTextOf(e: DragEvent): string {
    const dt = e.dataTransfer;
    if (!dt) return '';
    try {
      const uri = dt.getData('text/uri-list');
      if (uri) {
        const first = uri
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#'));
        if (first) return first;
      }
      const text = dt.getData('text/plain');
      if (text && text.trim()) return text.trim();
      const html = dt.getData('text/html');
      if (html) {
        return /href=["']([^"']+)["']/i.exec(html)?.[1] ?? '';
      }
    } catch {
      /* 读取被拒绝（极少见）：当没拖着东西处理 */
    }
    return '';
  },

  /** 拖着东西**进入**窗口：只有「像链接/文本/文件」的才算，其他（比如选中的文字）不显示遮罩 */
  onDocDragEnter(e: DragEvent): void {
    const dt = e.dataTransfer;
    if (!dt) return;
    const types = Array.from(dt.types);
    const wanted = types.some(
      (t) => t === 'text/uri-list' || t === 'text/plain' || t === 'text/html',
    );
    if (!wanted && !types.includes('Files')) return;
    /**
     * 计数而不是布尔：`dragenter` 在**子元素之间移动**时也会触发
     * （进入 video → 进入控制栏），只用一个布尔值会在第一次 dragleave 就误判成「离开窗口」，
     * 遮罩一闪一闪的。
     */
    this._dragDepth += 1;
    if (!this.dropBusy) this.dropActive = true;
  },

  /** 悬停：**必须** preventDefault，否则 Electron 会把拖进来的链接当页面导航（窗口白屏） */
  onDocDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  },

  /** 离开：减计数，减到 0 才算真的离开窗口 */
  onDocDragLeave(): void {
    this._dragDepth = Math.max(0, this._dragDepth - 1);
    if (this._dragDepth === 0 && !this.dropBusy) this.dropActive = false;
  },

  /** 松手 */
  onDocDrop(e: DragEvent): void {
    e.preventDefault();
    this._dragDepth = 0;
    if (this.dropBusy) return;
    const dt = e.dataTransfer;
    const fileCount = dt?.files?.length ?? 0;
    const text = this.dropTextOf(e);
    this.dropActive = false;
    /**
     * 本地文件优先：拖文件进来时 `text` 一般是空的，但从某些程序拖
     * 可能会带一段 `text/uri-list`（指向同一个文件），
     * 那种情况按文件处理才是用户的本意。
     */
    if (fileCount > 0) {
      void this.handleDroppedFiles(Array.from(dt?.files ?? []));
      return;
    }
    void this.handleDroppedText(text);
  },

  /**
   * 拖入的文本 → 识别 → 导入 → 播放
   *
   * 识别在主进程（`api:classifyDrop`），这里只按 `type` 分四路：
   *  - 音乐歌单 → 导入成歌单，从第一首起播（工作区自动变 MV）；
   *  - 音乐单曲 → 追加进默认歌单，播它（同上）；
   *  - B 站列表（收藏夹 / 合集 / 系列）→ 导入成视频列表（工作区自动变 OV）；
   *  - 单条视频 → 放进默认列表（同上）。
   *
   * ⚠️ 这几路**不再自己切工作区**。工作区是播放源的投影（`queue.mode`），
   * 起播那一刻它自然就对了；以前每条路都先 `switchMode()` 写一次设置，
   * 等于用「写配置」去骗界面，和播放源是两套状态，迟早打架。
   *
   * 导入期间整窗一个「正在导入…」遮罩 —— 几百条要跑几秒，没有反馈就像卡死。
   */
  async handleDroppedText(text: string): Promise<void> {
    const raw = (text ?? '').trim();
    if (!raw) return;
  
    let target: DropInputTarget;
    try {
      target = await electronApi.classifyDrop(raw);
    } catch (err) {
      ElMessage.error('识别失败：' + this.uiStore.errMsg(err));
      return;
    }
    if (target.type === 'none') {
      ElMessage.warning(
        '没认出这是什么：拖 B 站视频 / 合集 / 收藏夹链接，或网易云 / QQ音乐的歌曲、歌单链接',
      );
      return;
    }
  
    this.dropBusy = true;
    this.dropActive = true;
    try {
      if (target.type === 'music') await this.dropImportMusic(target.url);
      else if (target.type === 'song') await this.dropImportSong(target.url);
      else if (target.type === 'list') await this.dropImportList(target);
      else await this.dropImportVideo(target.input);
    } catch (err) {
      ElMessage.error('导入失败：' + this.uiStore.errMsg(err));
    } finally {
      this.dropBusy = false;
      this.dropActive = false;
    }
  },

  /** 拖入的是**音乐歌单**：导入（已有则同步）→ 播第一首 */
  async dropImportMusic(url: string): Promise<void> {
    this.uiStore.closeManagers();
    const { record, existed } = await electronApi.importMusicPlaylist(url);
    await this.playlistsStore.load();
    ElMessage.success(
      `${existed ? '已同步' : '已导入'}《${record.name}》（${record.songs.length} 首）`,
    );
    await this.queueStore.onPlaylistSwitch(record.id);
  },

  /**
   * 拖入的是**单曲**：追加进默认歌单 → 播它
   *
   * 和拖歌单的区别只在落点：一首歌不配为它建一个歌单，否则歌单列表里
   * 迟早攒出一堆只有一首歌的歌单。默认歌单由主进程保证存在（没有就现建、删不掉），
   * 去重也在那边（同一首歌拖第二次是「定位过去」，不是多一行）。
   *
   * 起播不用传下标：主进程已经把默认歌单的 `lastIndex` 写成这首歌的位置，
   * `onPlaylistSwitch` 会从那儿续播。
   */
  async dropImportSong(url: string): Promise<void> {
    this.uiStore.closeManagers();
    const { record, added, songName } = await electronApi.importMusicSong(url);
    await this.playlistsStore.load();
    /**
     * 只说「哪首歌进了哪个歌单」。不提「第 N 首」：
     * 紧接着 `onPlaylistSwitch` 还会报一句「已切换到《X》（N 首）」，
     * 这里再叠一个序号，两句读起来就像同一件事说了两遍。
     */
    ElMessage.success(`${added ? '已加入' : '已在'}《${record.name}》：${songName}`);
    await this.queueStore.onPlaylistSwitch(record.id);
  },

  /** 拖入的是 **B 站列表**：导入（已有则同步）→ 从上次那个视频起播 */
  async dropImportList(target: { kind: 'fav' | 'season' | 'series'; id: string; mid?: string }): Promise<void> {
    this.uiStore.closeManagers();
    const { record, skipped, existed } = await this.videoListsStore.add(
      target.kind,
      target.id,
      target.mid,
    );
    ElMessage.success(
      `${existed ? '已同步' : '已导入'}《${record.name}》${record.itemCount ?? ''} 条` +
        (skipped > 0 ? `（跳过 ${skipped} 个不支持的条目）` : ''),
    );
    await this.uiStore.loadBrowseList();
    await this.queueStore.onVideoListPlay(record.id, Math.max(0, record.lastIndex || 0));
  },

  /**
   * 拖入的是**单条视频**：加进默认列表（插到最前，所以就是第 1 条）→ 播它
   *
   * 默认列表由主进程保证存在（没有就现建，且删不掉），这里只拿 `listId` 去播。
   */
  async dropImportVideo(input: string): Promise<void> {
    this.uiStore.closeManagers();
    const { listId, listName } = await this.videoListsStore.addItemToDefault(input);
    ElMessage.success(`已加入《${listName}》，正在播放`);
    await this.uiStore.loadBrowseList();
    await this.queueStore.onVideoListPlay(listId, 0);
  },

  /**
   * 拖入的是**本地视频文件**：登记进默认列表 → 播第一个 → 后台补时长
   *
   * 和拖入「单条 B 站视频」是同一条路（同样进默认列表、同样置顶、同样续播），
   * 唯一不同的是地址来源。这也是当初「给本地文件发一个 `lf_` 开头的 bvid」
   * 那个决定换来的东西：播放、收藏、续播、托盘媒体信息全都不用加分支。
   */
  async handleDroppedFiles(files: File[]): Promise<void> {
    if (this.dropBusy) return;
  
    /**
     * 路径只能从 preload 的 `webUtils` 拿 —— Electron 32 起 `File.path` 已被移除。
     *
     * 拿不到就**明确说一句**：从某些程序（截图工具、压缩软件预览）拖出来的
     * 东西不是真实文件，静默什么都不做最让人困惑。
     */
    const paths: string[] = [];
    for (const file of files) {
      const filePath = electronApi.getPathForFile(file);
      if (filePath) paths.push(filePath);
    }
    if (paths.length === 0) {
      ElMessage.warning('没拿到文件路径，请从资源管理器把视频文件拖进来');
      return;
    }
  
    this.dropBusy = true;
    this.dropActive = true;
    try {
      this.uiStore.closeManagers();
  
      const { listId, listName, items, skipped } =
        await this.videoListsStore.importLocal(paths);
  
      if (items.length === 0) {
        ElMessage.error(
          skipped.length > 0 ? `没导入任何文件：${skipped[0].reason}` : '没导入任何文件',
        );
        return;
      }
  
      ElMessage.success(
        `已加入《${listName}》${items.length} 个文件，正在播放` +
          (skipped.length > 0 ? `（跳过 ${skipped.length} 个）` : ''),
      );
      await this.uiStore.loadBrowseList();
      await this.queueStore.onVideoListPlay(listId, 0);
  
      /**
       * 时长放**起播之后**补：一个文件几十毫秒，十个就是几百毫秒，
       * 而用户松手之后想看的是画面，不是「正在导入…」。
       */
      void this.probeLocalDurations(listId, items);
    } catch (err) {
      ElMessage.error('导入失败：' + this.uiStore.errMsg(err));
    } finally {
      this.dropBusy = false;
      this.dropActive = false;
    }
  },

  /**
   * 给刚拖进来的本地文件补时长（顺带**实测**能不能播）
   *
   * 用 `<video preload="metadata">` 探（见 `utils/mediaProbe.ts`）：
   * 这是唯一和真播放用同一个解码器的判断 —— 而 ffmpeg 说「没问题」
   * 并不代表 Chromium 能播（HEVC 就是典型）。
   *
   * 探不出来（编码不支持 / 路径失效）的**不删也不拦**，只提示一句：
   * 能播与否的最终裁判还是播放器自己，那时 OV 的连续失败刹车会接住。
   */
  async probeLocalDurations(
    listId: string,
    items: Array<{ bvid: string; url: string }>,
  ): Promise<void> {
    const broken: string[] = [];
    let changed = false;
  
    for (const item of items) {
      const probe = await probeMedia(item.url);
      if (!probe.ok) {
        broken.push(item.bvid);
        continue;
      }
      if (probe.duration > 0) {
        changed = true;
        void electronApi
          .fillVideoDuration('', item.bvid, probe.duration)
          .catch(() => {
            /* 补时长失败不影响播放，下次拖进来还会再探一次 */
          });
      }
    }
  
    if (broken.length > 0) {
      ElMessage.warning(
        `有 ${broken.length} 个文件解不出来（多半是 mkv / HEVC 编码），已照常加入但可能播不了`,
      );
    }
    /** 列表里那一列时长要跟着变（只在用户正看着这个列表时才重读） */
    if (changed && this.uiStore.browseVideoListId === listId) await this.uiStore.loadBrowseList();
  }
};

export const useDropStore = defineStore<
  'drop',
  DropState,
  DropGetterFns,
  DropActions
>('drop', {
  state: dropState,
  getters: dropGetters as never,
  actions: dropActions as DropActions,
});

/** 组件侧需要标注 store 类型时用它 */
export type DropStore = ReturnType<typeof useDropStore>;
