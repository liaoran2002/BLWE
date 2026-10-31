/**
 * Window store —— 窗口：最大化 / 全屏 / 壁纸模式 / 锁定 / 标题栏拖拽 / 快捷键。
 *
 * 状态与动作都只属于这一个业务域；跨域访问通过 getters 里那几个 `xxxStore`
 * 指针拿到别的 store 实例（惰性求值，所以模块之间可以互相 import 而不成环）。
 */
import { defineStore } from 'pinia';
import type { AppData } from '../types/app';
import { ElMessage } from 'element-plus';
import electronApi from '../api/electron';

import { usePlaybackStore } from './playback';
import { useUiStore } from './ui';

/** ===== state ===== */
export type WindowState = Pick<
  AppData,
  'isMaximized' | 'isFullscreen' | 'wallpaperEnabled' | 'locked' | 'trayMenuOpen' | 'isDragging' | 'dragStarted' | 'dragReady' | 'dragStartX' | 'dragStartY' | 'dragOffsetX' | 'dragOffsetY' | '_pendingMoveX' | '_pendingMoveY' | '_moveFramePending' | 'removeMaximizedListener' | 'removeFullscreenListener' | 'removeWallpaperState' | 'removeWallpaperUnavailable' | '_lockedByFullscreen'
>;

export const windowState = (): WindowState => ({
  isMaximized: false,

  isFullscreen: false,

  wallpaperEnabled: false,

  /** 界面锁定（只留左下锁定 + 右下全屏两个按钮），快捷键 S 或左下角按钮切换 */
  locked: false,

  /** 自绘托盘菜单是否正开着（开着时吞掉窗口内点击） */
  trayMenuOpen: false,

  isDragging: false,

  dragStarted: false,

  dragReady: false,

  dragStartX: 0,

  dragStartY: 0,

  dragOffsetX: 0,

  dragOffsetY: 0,

  _pendingMoveX: 0,

  _pendingMoveY: 0,

  _moveFramePending: false,

  removeMaximizedListener: null,

  removeFullscreenListener: null,

  removeWallpaperState: null,

  removeWallpaperUnavailable: null,

  /** 当前这次锁定是「进全屏自动锁的」，退出全屏时要跟着解开（手工锁的不动） */
  _lockedByFullscreen: false,
});

/** ===== getters ===== */
export interface WindowGetters {
  readonly playbackStore: ReturnType<typeof usePlaybackStore>;
  readonly uiStore: ReturnType<typeof useUiStore>;

}

export type WindowGetterFns = { [K in keyof WindowGetters]: () => WindowGetters[K] };

export const windowGetters: ThisType<WindowContext> = {
  playbackStore: () => usePlaybackStore(),
  uiStore: () => useUiStore(),

};

/** ===== actions ===== */
export interface WindowActions {
  toggleWallpaper(): Promise<void>;
  winMinimize(): void;
  winMaximize(): void;
  winClose(): void;
  onTitlebarMouseDown(e: MouseEvent): void;
  onTitlebarDblClick(e: MouseEvent): void;
  onDocMouseMove(e: MouseEvent): void;
  onDocMouseUp(e: MouseEvent): void;
  toggleFullscreen(): Promise<void>;
  toggleLock(force?: boolean): void;
  anyDialogOpen(): boolean;
  handleKeydown(e: KeyboardEvent): void;
}

export type WindowContext = WindowState & WindowGetters & WindowActions;

export const windowActions: ThisType<WindowContext> = {
  async toggleWallpaper(): Promise<void> {
    this.wallpaperEnabled = await electronApi.wallpaperToggle();
  },

  winMinimize(): void {
    electronApi.winMinimize();
  },

  winMaximize(): void {
    if (this.isFullscreen) this.toggleFullscreen();
    else electronApi.winMaximize();
  },

  winClose(): void {
    electronApi.winClose();
  },

  /**
   * 标题栏按下 = 开始拖动
   *
   * 全屏和壁纸模式下都不拖：
   *  - 壁纸模式：窗口是桌面的一部分，拖动没有意义，标题栏本来也隐藏了；
   *  - 全屏：和原生全屏一致（用户要求），只能按 F / Esc / 右下角按钮退出全屏。
   *    以前这里是允许的，拖一下就会「退出全屏」，很容易误触。
   */
  onTitlebarMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || this.wallpaperEnabled || this.isFullscreen) return;
    this.isDragging = true;
    this.dragStarted = false;
    this.dragReady = false;
    this.dragStartX = e.screenX;
    this.dragStartY = e.screenY;
  },

  onTitlebarDblClick(e: MouseEvent): void {
    if (e.button !== 0 || this.wallpaperEnabled || this.isFullscreen) return;
    this.isDragging = false;
    electronApi.winMaximize();
  },

  onDocMouseMove(e: MouseEvent): void {
    if (!this.isDragging) return;
    if (!this.dragStarted) {
      const dx = Math.abs(e.screenX - this.dragStartX);
      const dy = Math.abs(e.screenY - this.dragStartY);
      if (dx < 5 && dy < 5) return;
      this.dragStarted = true;
      this.dragReady = false;
      electronApi.winStartDrag().then((info) => {
        if (info) {
          this.dragOffsetX = info.offsetX;
          this.dragOffsetY = info.offsetY;
          this.dragReady = true;
        }
      });
      return;
    }
    if (!this.dragReady) return;
    this._pendingMoveX = e.screenX - this.dragOffsetX;
    this._pendingMoveY = e.screenY - this.dragOffsetY;
    if (!this._moveFramePending) {
      this._moveFramePending = true;
      requestAnimationFrame(() => {
        this._moveFramePending = false;
        electronApi.winMoveWindow(this._pendingMoveX, this._pendingMoveY);
      });
    }
  },

  onDocMouseUp(e: MouseEvent): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    if (this.dragStarted && this.dragReady) {
      electronApi.winGetScreenWorkArea().then((workArea) => {
        if (workArea && e.screenY <= workArea.y + 8 && !this.isMaximized) {
          electronApi.winMaximize();
        }
      });
    }
  },

  async toggleFullscreen(): Promise<void> {
    this.isFullscreen = await electronApi.winToggleFullscreen();
    ElMessage.info(
      this.isFullscreen
        ? '进入全屏,按esc或F键可以退出全屏'
        : '退出全屏,按F键可以再次进入全屏',
    );
  },

  /**
   * 锁定 / 解锁
   *
   * 锁定 = 把标题栏、控制栏、歌单入口全藏起来（`.wm-hidden`），窗口只剩画面，
   * 只留左下（锁定）和右下（全屏）两个按钮 —— 那俩是唯一的解锁入口，不能一起藏。
   * 快捷键 S 走同一个方法。
   *
   * 提示文案照全屏那条抄（同样的语气与「按 X 可以…」结构）。
   */
  toggleLock(force?: boolean): void {
    const next = typeof force === 'boolean' ? force : !this.locked;
    if (next === this.locked) return;
    this.locked = next;
    // 手工解锁之后就别再让「退出全屏」把它又改回去
    if (!next) this._lockedByFullscreen = false;
    ElMessage.info(
      next ? '已锁定,按S键或点左下角按钮可以解锁' : '已解锁,按S键可以再次锁定',
    );
  },

  /**
   * 有没有弹窗开着
   *
   * 弹窗是模态的（遮罩挡住整窗），这时按 S 锁定会在弹窗底下藏界面，
   * 所以快捷键在这种情况下直接不响应 —— 锁定按钮本来也点不到。
   */
  anyDialogOpen(): boolean {
    return (
      this.uiStore.listType !== 'none' ||
      this.uiStore.playlistManagerVisible ||
      this.uiStore.settingsVisible ||
      this.uiStore.aboutVisible ||
      this.uiStore.addVideoVisible
    );
  },

  handleKeydown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLElement) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    }
    if (this.wallpaperEnabled) return;
  
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.playbackStore.playControl();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.playbackStore.changeVolume(Math.min(100, this.playbackStore.currentVolume + 5));
        ElMessage.success(`当前音量:${this.playbackStore.currentVolume}`);
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.playbackStore.changeVolume(Math.max(0, this.playbackStore.currentVolume - 5));
        ElMessage.success(`当前音量:${this.playbackStore.currentVolume}`);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (this.playbackStore.duration) {
          this.playbackStore.changeTime(Math.min(this.playbackStore.duration, this.playbackStore.currentTime + 5));
          ElMessage.success(
            `${this.playbackStore.formatTime(this.playbackStore.currentTime)}/${this.playbackStore.formatTime(this.playbackStore.duration)}`,
          );
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.playbackStore.changeTime(Math.max(0, this.playbackStore.currentTime - 5));
        ElMessage.success(
          `${this.playbackStore.formatTime(this.playbackStore.currentTime)}/${this.playbackStore.formatTime(this.playbackStore.duration)}`,
        );
        break;
      case 'KeyF':
        e.preventDefault();
        this.toggleFullscreen();
        break;
      case 'KeyS':
        // 锁定 / 解锁；输入框里打字不受影响（上面挡掉了 INPUT/TEXTAREA），
        // 弹窗开着时也不响应（模态遮罩下按 S 会在弹窗背后藏界面）
        if (this.anyDialogOpen()) break;
        e.preventDefault();
        this.toggleLock();
        break;
      case 'Escape':
        e.preventDefault();
        if (this.isFullscreen) this.toggleFullscreen();
        break;
    }
  }
};

export const useWindowStore = defineStore<
  'window',
  WindowState,
  WindowGetterFns,
  WindowActions
>('window', {
  state: windowState,
  getters: windowGetters as never,
  actions: windowActions as WindowActions,
});

/** 组件侧需要标注 store 类型时用它 */
export type WindowStore = ReturnType<typeof useWindowStore>;
