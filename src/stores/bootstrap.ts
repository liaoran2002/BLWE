/**
 * boot —— 启动与收摊（**不是 store**）
 *
 * 它只做编排：按顺序把各个 store 叫起来，自己不留任何状态。
 * 之所以独立成对象而不是继续挂在 store 上，是因为 store 是「状态 + 属于该状态的
 * 动作」，而启动顺序、卸载清理属于应用生命周期，不属于任何域。
 *
 * 对应的生命周期挂在 App.vue 的 onMounted / onBeforeUnmount 上，
 * 那里只调 `boot.attachVideo()` / `boot.bootstrap()` / `boot.teardown()`。
 *
 * ## 为什么方法体开头先取 store 实例
 *
 * 这里没有 `this`（不是 Pinia store），所以不能写 `this.xxx`。
 * 每个方法按自己用到的东西取一次实例，剩下的逻辑和原来一模一样 ——
 * Pinia 的 `useXxxStore()` 拿的是同一个单例，重复调用没有开销。
 */
import { useDropStore } from './drop';
import { usePlaybackStore } from './playback';
import { usePlaylistStore } from './playlists';
import { useQueueStore } from './queue';
import { useSessionStore } from './session';
import { useSettingStore } from './setting';
import { useSleepStore } from './sleep';
import { useSystemStore } from './system';
import { useUiStore } from './ui';
import { useVideoListStore } from './videoLists';
import { useWindowStore } from './window';
import { watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { AppSetting } from '@common/types/app_setting';
import defaultSetting from '@common/defaultSetting';
import electronApi from '../api/electron';
import type { VideoElement } from '../types/app';

export const boot = {
  async init(): Promise<void> {
    const playback = usePlaybackStore();
    const setting = useSettingStore();
    const queue = useQueueStore();
    const windowStore = useWindowStore();
    const session = useSessionStore();
    const system = useSystemStore();
    const playlists = usePlaylistStore();
    const ui = useUiStore();
    const videoLists = useVideoListStore();
    /**
     * 先建播放引擎
     *
     * `bootstrap()` 里第一件事就是调它 —— 引擎要在任何一次 `playAt()` 之前存在，
     * 否则 `playback.engine?.playAt()` 会静默什么都不做（可选链吞掉）。
     */
    playback.createEngine();
    // 用主进程下发（Pinia 中）的配置初始化本地播放状态
    const cfg = setting.setting;
    playback.currentVolume = cfg['player.volume'];
    playback.isMuted = cfg['player.isMute'];
    // 记录初始非零音量，保证「静音 -> 解除」能恢复到本次会话的实际音量
    playback.lastNonZeroVolume = cfg['player.volume'] > 0 ? cfg['player.volume'] : defaultSetting['player.volume'];
    queue.currentMode = queue.loopModeToIndex(cfg['player.loopMode']);
  
    windowStore.isMaximized = await electronApi.winIsMaximized();
    windowStore.isFullscreen = await electronApi.winIsFullscreen();
    session.loadUserInfo();
    system.syncTrayState();
    // 接上 Windows 系统媒体控件（SMTC）：媒体键 + 系统音量弹窗里的媒体信息
    system.setupMediaSessionActions();
    system.updateMediaSession();
  
    // 加载歌单集合（旧版单歌单文件已由主进程迁移进集合）
    try {
      await playlists.load();
    } catch (err) {
      ElMessage.error('加载歌单失败：' + ui.errMsg(err));
    }
  
    /**
     * 加载某站视频列表（纯读库，不联网）
     *
     * 同时恢复「上次在播的是哪个视频列表」：没有这一步，用户今天导入的收藏夹
     * 明天开机又会回到音乐歌单，等于每次都要重新点一遍。
     * 列表已经被删掉时必须把设置里的 id 清掉 —— 否则 `fromVideoList`
     * 永远为真，界面会按视频列表的文案渲染一个空来源。
     */
    try {
      await videoLists.load();
      const savedVideoListId = setting.setting['player.activeVideoListId'] || '';
      if (savedVideoListId) {
        if (videoLists.find(savedVideoListId)) {
          videoLists.setActive(savedVideoListId);
        } else {
          void setting.update({ 'player.activeVideoListId': '' });
        }
      }
    } catch (err) {
      console.warn('[videolist] 加载视频列表失败', err);
    }
  
    /**
     * 视频管理页默认停在哪个列表
     *
     * 纯读库、**不参与播放**：`loadBrowseList` 优先停「正在播的那个列表」，
     * 没有就退回第一个。以前这里还会顺手把第一个列表设成「当前播放源」，
     * 等于开机替用户决定了播什么 —— 现在播放源只由 `tryResume` 按
     * `player.activeVideoListId` 恢复，两边不再互相污染。
     */
    await ui.loadBrowseList();
  
    // 后台做启动同步，不阻塞续播
    void system.runStartupSync();
    // 按歌单的定时同步策略装心跳（记下指纹，免得后续无关的配置广播重建它）
    system._syncKey = `${playlists.hasIntervalSync}|${playlists.minSyncInterval}|${videoLists.hasIntervalSync}|${videoLists.minSyncInterval}`;
    system.setupSyncTimer();
  
    // 优先续播；没有可续播内容时退回「当前歌单的第一首」
    const resumed = await playback.tryResume();
    if (!resumed) await queue.loadPlaylist();
  },

  /**
   * 声音输出设备变化时暂停播放（设置项 `player.pauseOnDeviceChange`）
   *
   * 插拔耳机、切换默认输出设备时，正在播的音频有可能会跑到另一个设备上，
   * 所以先暂停，等用户自己决定继续。（`devicechange` 不区分输入/输出设备，
   * 这是渲染进程能拿到的唯一信号。）
   */
  onAudioDeviceChange(): void {
    const setting = useSettingStore();
    const playback = usePlaybackStore();
    if (!setting.setting['player.pauseOnDeviceChange']) return;
    if (playback.paused) return;
    playback.playControl();
    ElMessage.info('检测到声音输出设备变化，已暂停播放');
  },

  setupAudioDeviceWatch(): void {
  
    const md = navigator.mediaDevices;
    if (!md || typeof md.addEventListener !== 'function') return;
    md.addEventListener('devicechange', boot.onAudioDeviceChange);
  },

  /**
   * 关闭窗口前记录播放信息
   *
   * beforeunload 里不能等异步，所以这里直接发一次 fire-and-forget 的 IPC；
   * 主进程侧有 300ms 防抖并在 before-quit 里 flush，能保证落盘。
   */
  onBeforeUnload(): void {
    const playback = usePlaybackStore();
    const setting = useSettingStore();
    const system = useSystemStore();
    const patch: Partial<AppSetting> = {
      'player.resumeTime': Math.floor(playback.currentTime || 0),
    };
    setting.update(patch);
    system.recordPlayPosition();
    /**
     * 退出时**不需要**再写 `selectedBvid`
     *
     * 它已经在每次切视频时落库了（见 `playCandidate` → `api:resolveVideo`），
     * 这里再写一次是重复的。而且 `beforeunload` 是同步的、Electron 不会等 promise，
     * 真要写还得依赖 `ipcRenderer.invoke` 的同步投递，属于把正确性押在一个
     * 不好验证的行为上 —— 没必要，那条数据早就是最新的了。
     */
  },

  /**
   * 自绘托盘菜单打开期间吞掉窗口内的鼠标点击（捕获阶段）
   *
   * 壁纸模式的鼠标转发会把「点菜单项」这一下同时合成到壁纸窗口上，
   * 不拦的话可能顺手把控制栏的按钮也点了一次。
   */
  onTrayMenuGuard(e: MouseEvent): void {
    const windowStore = useWindowStore();
    if (!windowStore.trayMenuOpen) return;
    e.stopPropagation();
    e.preventDefault();
  },

  async initWallpaperState(): Promise<void> {
    const windowStore = useWindowStore();
    windowStore.wallpaperEnabled = await electronApi.wallpaperIsEnabled();
  },

  /** 把 `<video>` 元素交给 store（组件 onMounted 时调，onBeforeUnmount 时传 null） */
    attachVideo(el: VideoElement | null): void {
    const playback = usePlaybackStore();
      playback._videoHolder.el = el;
    },

  bootstrap(): void {
    const drop = useDropStore();
    const session = useSessionStore();
    const system = useSystemStore();
    const playback = usePlaybackStore();
    const ui = useUiStore();
    const sleep = useSleepStore();
    const windowStore = useWindowStore();
    const setting = useSettingStore();
    const playlists = usePlaylistStore();
    // 配置在 src/main.ts 里已经拉取完成，这里直接初始化播放状态
    void boot.init();
    /**
     * 拖入导入（某站视频 / 合集 / 收藏夹 / 音乐歌单）
     *
     * 挂在 document 上而不是某个元素上：拖进窗口的任何位置都算，
     * 包括标题栏、控制栏、视频画面。`dragover` 里必须 preventDefault，
     * 否则 Electron 会把拖进来的链接当成「导航到这个地址」——窗口直接白屏。
     */
    document.addEventListener('dragenter', drop.onDocDragEnter);
    document.addEventListener('dragover', drop.onDocDragOver);
    document.addEventListener('dragleave', drop.onDocDragLeave);
    document.addEventListener('drop', drop.onDocDrop);
    session.removeLoginListener = electronApi.onLoginSuccess(() => {
      void session.onLoggedIn();
    });
    session.removeLogoutListener = electronApi.onLogout(() => {
      session.isLoggedIn = false;
      session.userFace = '';
      session.userName = '';
    });
    system.removeTrayPlayControl = electronApi.onTrayPlayControl(() => {
      playback.playControl();
    });
    system.removeTrayPrev = electronApi.onTrayPrev(() => {
      /**
       * ★ 托盘切歌也要守 `netBusy`（用户要求「托盘控制栏能 ban 一起 ban」）
       *
       * 托盘菜单是个迷你控制台，连点它和连点控制栏的「上一首」是**同一件事**：
       * 每次都会重新搜索 + 解析地址。请求在飞的时候直接忽略，
       * 免得和屏幕上的控制栏一样把请求叠加起来。
       *
       * ⚠️ 只拦**会发请求**的（上一首 / 下一首）。播放暂停、音量、进度、
       * 静音这些**本地操作照常** —— 用户不该因为后台在搜歌就不能暂停。
       */
      if (ui.netBusy) return;
      playback.prev();
    });
    system.removeTrayNext = electronApi.onTrayNext(() => {
      /** 同上：切歌会发请求，`netBusy` 时忽略 */
      if (ui.netBusy) return;
      playback.next();
    });
    system.removeTrayToggleMode = electronApi.onTrayToggleMode(() => {
      playback.toggleMode();
    });
    // 托盘菜单上的进度条 / 音量（菜单是个迷你控制台）
    system.removeTraySeek = electronApi.onTraySeek((ratio) => {
      const total = playback.duration || 0;
      if (total > 0) playback.changeTime(Math.min(total, Math.max(0, ratio * total)));
    });
    system.removeTrayVolume = electronApi.onTrayVolume((volume) => {
      playback.changeVolume(volume);
    });
    system.removeTrayToggleMute = electronApi.onTrayToggleMute(() => {
      playback.toggleMute();
    });
    system.removeTrayShowPlaylist = electronApi.onTrayShowPlaylist(() => {
      /**
       * 托盘「歌单管理 / 视频管理」-> 打开当前工作区对应的管理弹窗
       *
       * 不传页签：文案由主进程按渲染层推上去的工作区决定，
       * 这里只负责「打开当前那一页」——和弹窗左下角的切换按钮同一条路径。
       */
      void ui.openManager();
    });
    system.removeTrayShowSleepTimer = electronApi.onTrayShowSleepTimer(() => {
      /**
       * 托盘「定时」-> 打开定时面板
       *
       * 和「歌单管理 / 视频管理」同一条路径：主进程已经先把窗口从壁纸层/托盘里叫回来了，
       * 这里只负责把面板弹出来。
       */
      sleep.sleepPanelVisible = true;
    });
    system.removeTrayShowLogoutConfirm = electronApi.onTrayShowLogoutConfirm(
      () => {
        session.handleLogoutConfirm();
      },
    );
    /**
     * 左键点托盘图标 = 回到窗口 + 解锁
     *
     * 窗口模式 + 锁定状态下，界面只剩左下右下两个角按钮，用户自然会去点托盘；
     * 这里用 `toggleLock(false)`（幂等）：没锁就什么都不做，也不会多弹一条提示。
     */
    system.removeTrayUnlock = electronApi.onTrayUnlock(() => {
      windowStore.toggleLock(false);
    });
    windowStore.removeWallpaperState = electronApi.onWallpaperState((enabled) => {
      windowStore.wallpaperEnabled = enabled;
    });
    /**
     * 壁纸模式不可用：把原因告诉用户
     *
     * 以前这种情况是**完全静默**的（主进程用空 catch 吞掉了原生模块加载失败），
     * 用户点了按钮什么都不发生，无从判断是环境不支持还是程序坏了。
     *
     * ⚠️ 主进程给的 `reason` 是**技术原因**（`找不到桌面壁纸层（WorkerW）`、
     * `SetParent 抛错: ...` 之类），**不能直接显示给用户** ——
     * 他看不懂，而且没必要把内部实现写在界面上。
     * 所以界面统一说一句人话，技术原因只进控制台日志（排查用）。
     */
    windowStore.removeWallpaperUnavailable = electronApi.onWallpaperUnavailable(
      (reason) => {
        console.warn('[wallpaper] 不可用（技术原因）：', reason);
        ElMessage.warning(
          '壁纸模式在当前系统上用不了。可以继续用窗口模式，功能不受影响。',
        );
      },
    );
    boot.initWallpaperState();
    windowStore.removeMaximizedListener = electronApi.onMaximized((val) => {
      windowStore.isMaximized = val;
    });
    windowStore.removeFullscreenListener = electronApi.onFullscreen((val) => {
      windowStore.isFullscreen = val;
    });
    // 声音输出设备变化时暂停（插拔耳机 / 切默认设备）
    boot.setupAudioDeviceWatch();
    // 片尾看门狗：常驻一个 1 秒的心跳（内部条件很严，平时几乎不做任何事）
    playback.startEndWatch();
    /**
     * 定时暂停：创建实例并订阅状态
     *
     * 放在这里（而不是 `created`）是因为它的 `readVideo` 回调要读 `<video>`，
     * 而那个元素要等模板挂载完才拿得到。定时器本身只有 `start()` 之后才
     * 开始 tick，所以在这里创建完全够用。
     */
    sleep.setupSleepTimer();
    /**
     * 自绘托盘菜单打开期间，把窗口内的点击吞掉。
     *
     * 原因：壁纸模式开着鼠标转发，用户点菜单项时壁纸窗口**同时**会收到一次同坐标的
     * 合成点击，可能误触控制栏。用捕获阶段拦下来，菜单一关就恢复。
     */
    system.removeTrayMenuListener = electronApi.onTrayMenuVisibility((visible) => {
      windowStore.trayMenuOpen = visible;
      /**
       * 刚弹出时先推一份最新状态
       *
       * 主进程手里那份是**上一次推送的快照**：暂停很久之后再右键托盘，
       * 定时倒计时会先用旧值显示一小会儿，等下一秒的推送才跳到正确值。
       * 菜单一出现就推一次，省掉这一下跳变（进度条也同理）。
       */
      if (visible) system.syncTrayState();
    });
    /**
     * 这里原来有三个捕获阶段的监听，用来在托盘菜单打开时吞掉窗口内的点击 ——
     * 那是为了挡住「壁纸模式的鼠标转发把点菜单这一下同时合成到壁纸窗口」的副作用。
     * 现在壁纸模式已经 `forwardMouseInput: false`（界面也全隐藏了），不会再有合成点击，
     * 所以按计划注释掉。`trayMenuOpen` 本身还留着：菜单开着时要把进度推给菜单里的进度条。
     */
    // document.addEventListener('mousedown', boot.onTrayMenuGuard, true);
    // document.addEventListener('mouseup', boot.onTrayMenuGuard, true);
    // document.addEventListener('click', boot.onTrayMenuGuard, true);
    document.addEventListener('keydown', windowStore.handleKeydown);
    document.addEventListener('mousemove', windowStore.onDocMouseMove);
    document.addEventListener('mouseup', windowStore.onDocMouseUp);
    // 关闭窗口前记录一次播放信息（用户要求「关闭时」也记录）
    window.addEventListener('beforeunload', boot.onBeforeUnload);
  
    // #region  watchers（原来是组件的 watch 块）
    /** 进壁纸模式就先把所有弹窗收掉（弹窗在桌面层点不动也关不掉） */
    playback._stopWatchers.push(
      watch(
        () => windowStore.wallpaperEnabled,
        (enabled) => {
          if (!enabled) return;
          ui.listType = 'none';
          ui.playlistManagerVisible = false;
          ui.settingsVisible = false;
          ui.aboutVisible = false;
          ui.addVideoVisible = false;
        },
      ),
    );
    /**
     * 全屏 -> 自动锁定（设置里开关，默认关）
     *
     * 只动「因全屏而锁」的那次：用户自己按 S 锁的，退出全屏不该替他解开。
     */
    playback._stopWatchers.push(
      watch(
        () => windowStore.isFullscreen,
        (full) => {
          if (full) {
            if (setting.setting['player.lockOnFullscreen'] && !windowStore.locked) {
              windowStore._lockedByFullscreen = true;
              windowStore.toggleLock(true);
            }
            return;
          }
          if (windowStore._lockedByFullscreen) {
            windowStore._lockedByFullscreen = false;
            if (windowStore.locked) windowStore.toggleLock(false);
          }
        },
      ),
    );
    /**
     * 配置可能在别处被改动（多窗口同步、托盘、恢复默认），
     * 把 Pinia 里的音量/静音同步回本地播放状态，并作用到 <video> 上。
     * 用 !== 判断避免与「用户改音量 -> 写回主进程 -> 广播回来」形成回环。
     */
    playback._stopWatchers.push(
      watch(
        () => setting.setting,
        () => {
          const cfg = setting.setting;
          if (cfg['player.volume'] !== playback.currentVolume) {
            playback.currentVolume = cfg['player.volume'];
          }
          if (cfg['player.isMute'] !== playback.isMuted) {
            playback.isMuted = cfg['player.isMute'];
          }
          const v = playback.videoEl();
          if (v) {
            v.volume = playback.currentVolume / 100;
            v.muted = playback.isMuted;
          }
          // 只有「有没有定时歌单 / 最小间隔」变了才重建定时器，
          // 否则播放中每 5 秒广播一次 resumeTime 会把 30 分钟的心跳无限推迟。
          // 这个 watch 不在 boot() 的作用域里，视频列表那边要现取（Pinia 单例，无开销）
          const videoLists = useVideoListStore();
          const syncKey = `${playlists.hasIntervalSync}|${playlists.minSyncInterval}|${videoLists.hasIntervalSync}|${videoLists.minSyncInterval}`;
          if (syncKey !== system._syncKey) {
            system._syncKey = syncKey;
            system.setupSyncTimer();
          }
          system.updateTaskbarProgress();
        },
        { deep: true },
      ),
    );
    // #endregion
  
  },

  teardown(): void {
    const playback = usePlaybackStore();
    const sleep = useSleepStore();
    const system = useSystemStore();
    const session = useSessionStore();
    const windowStore = useWindowStore();
    const drop = useDropStore();
    for (const stop of playback._stopWatchers) stop();
    playback._stopWatchers = [];
    playback.stopDashSession();
    playback.stopBufferTicker();
    // 定时暂停：停掉 ticker 并退订（否则组件没了 interval 还在跑）
    sleep._sleepUnsub?.();
    sleep._sleepUnsub = null;
    sleep._sleepTimer?.dispose();
    sleep._sleepTimer = null;
    navigator.mediaDevices?.removeEventListener?.('devicechange', boot.onAudioDeviceChange);
    // 自绘托盘菜单的守卫与其他监听一起摘掉
    // （守卫本身已经注释掉，这里同样注释，留着对照）
    // document.removeEventListener('mousedown', boot.onTrayMenuGuard, true);
    // document.removeEventListener('mouseup', boot.onTrayMenuGuard, true);
    // document.removeEventListener('click', boot.onTrayMenuGuard, true);
    if (system.removeTrayMenuListener) system.removeTrayMenuListener();
    // 预热的隐藏流 / 元素也要收掉
    playback.clearAllWarm();
    for (const dir of ['next', 'prev'] as const) {
      const el = playback._warmEl[dir];
      if (el) {
        try {
          (el as unknown as HTMLVideoElement).remove();
        } catch {
          /* 忽略 */
        }
        playback._warmEl[dir] = null;
      }
    }
    if (playback._endWatchTimer) {
      clearInterval(playback._endWatchTimer);
      playback._endWatchTimer = null;
    }
    if (session.removeLoginListener) session.removeLoginListener();
    if (session.removeLogoutListener) session.removeLogoutListener();
    if (system.removeTrayPlayControl) system.removeTrayPlayControl();
    if (system.removeTrayPrev) system.removeTrayPrev();
    if (system.removeTrayNext) system.removeTrayNext();
    if (system.removeTrayToggleMode) system.removeTrayToggleMode();
    if (system.removeTraySeek) system.removeTraySeek();
    if (system.removeTrayVolume) system.removeTrayVolume();
    if (system.removeTrayToggleMute) system.removeTrayToggleMute();
    if (system.removeTrayShowPlaylist) system.removeTrayShowPlaylist();
    if (system.removeTrayShowSleepTimer) system.removeTrayShowSleepTimer();
    if (system.removeTrayShowLogoutConfirm) system.removeTrayShowLogoutConfirm();
    if (system.removeTrayUnlock) system.removeTrayUnlock();
    if (windowStore.removeWallpaperState) windowStore.removeWallpaperState();
    if (windowStore.removeWallpaperUnavailable) windowStore.removeWallpaperUnavailable();
    if (windowStore.removeMaximizedListener) windowStore.removeMaximizedListener();
    if (windowStore.removeFullscreenListener) windowStore.removeFullscreenListener();
    document.removeEventListener('dragenter', drop.onDocDragEnter);
    document.removeEventListener('dragover', drop.onDocDragOver);
    document.removeEventListener('dragleave', drop.onDocDragLeave);
    document.removeEventListener('drop', drop.onDocDrop);
    document.removeEventListener('keydown', windowStore.handleKeydown);
    document.removeEventListener('mousemove', windowStore.onDocMouseMove);
    document.removeEventListener('mouseup', windowStore.onDocMouseUp);
    window.removeEventListener('beforeunload', boot.onBeforeUnload);
    system.clearSyncTimer();
  }
};
