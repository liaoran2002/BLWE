/**
 * Session store —— 登录态：用户信息、扫码登录、退出确认。
 *
 * 状态与动作都只属于这一个业务域；跨域访问通过 getters 里那几个 `xxxStore`
 * 指针拿到别的 store 实例（惰性求值，所以模块之间可以互相 import 而不成环）。
 */
import { defineStore } from 'pinia';
import type { AppData } from '../types/app';
import { ElMessage, ElMessageBox } from 'element-plus';
import electronApi from '../api/electron';

import { usePlaybackStore } from './playback';
import { useQueueStore } from './queue';
import { useUiStore } from './ui';

/** ===== state ===== */
export type SessionState = Pick<
  AppData,
  'isLoggedIn' | 'userFace' | 'userName' | 'removeLoginListener' | 'removeLogoutListener'
>;

export const sessionState = (): SessionState => ({
  isLoggedIn: false,

  userFace: '',

  userName: '',

  removeLoginListener: null,

  removeLogoutListener: null,
});

/** ===== getters ===== */
export interface SessionGetters {
  readonly playbackStore: ReturnType<typeof usePlaybackStore>;
  readonly queueStore: ReturnType<typeof useQueueStore>;
  readonly uiStore: ReturnType<typeof useUiStore>;

}

export type SessionGetterFns = { [K in keyof SessionGetters]: () => SessionGetters[K] };

export const sessionGetters: ThisType<SessionContext> = {
  playbackStore: () => usePlaybackStore(),
  queueStore: () => useQueueStore(),
  uiStore: () => useUiStore(),

};

/** ===== actions ===== */
export interface SessionActions {
  loadUserInfo(): Promise<void>;
  onLoggedIn(): Promise<void>;
  handleLogoutConfirm(): void;
  doLogout(): Promise<void>;
  startLogin(): Promise<void>;
}

export type SessionContext = SessionState & SessionGetters & SessionActions;

export const sessionActions: ThisType<SessionContext> = {
  async loadUserInfo(): Promise<void> {
    try {
      const info = await electronApi.getUserInfo();
      this.userFace = info.face;
      this.userName = info.name;
      this.isLoggedIn = true;
      electronApi.setLoggedIn(true);
    } catch (err) {
      /**
       * 拉取失败 ≠ 没登录
       *
       * 主进程把两者分开了：`未登录` 是 nav 明确说的，`NAV_FAILED` 是这次请求没问到。
       * 后者（网络抖动、风控）不能把界面切成未登录 —— 否则托盘菜单会显示「登录」、
       * 解析视频还会按未登录档位取流并写进缓存，表现就是「明明登录着却每次都重新解析」。
       */
      if (this.uiStore.errMsg(err) === 'NAV_FAILED') {
        console.warn('[auth] 登录态查询失败（网络问题），保持原状态');
        return;
      }
      this.isLoggedIn = false;
      this.userFace = '';
      this.userName = '';
      electronApi.setLoggedIn(false);
    }
  },

  /**
   * 登录成功后的收尾
   *
   * 1. 刷头像/昵称；
   * 2. **用新的登录态重新解析当前视频的播放地址** ——
   *    未登录时平台只会给低清晰度（实测 360P 档），登录后同一个 bvid 能给到 720P+。
   *    不主动重取的话，得等切到下一首（甚至重启）才看得到变化，
   *    表现就是「登录了跟没登录一样」。
   */
  async onLoggedIn(): Promise<void> {
    await this.loadUserInfo();
    const bvid = this.playbackStore.currentBvid;
    if (!bvid) return;
    // 重新解析会换 URL，视频会重新加载，先把进度记下来
    const resumeAt = this.playbackStore.currentTime;
    if (resumeAt > 3) {
      this.playbackStore.seekAfterLoad = resumeAt;
      this.playbackStore.seekAfterLoadFor = this.queueStore.currentKey;
    }
    ElMessage.success('登录成功，正在用更高清晰度重新加载当前视频');
    await this.playbackStore.playCandidate(bvid, { skipCache: true });
  },

  handleLogoutConfirm(): void {
    if (!this.isLoggedIn) {
      this.startLogin();
      return;
    }
    ElMessageBox.confirm('确定要退出登录吗?', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
      .then(() => {
        this.doLogout();
      })
      .catch(() => {});
  },

  async doLogout(): Promise<void> {
    this.userFace = '';
    this.userName = '';
    this.isLoggedIn = false;
    electronApi.setLoggedIn(false);
    await electronApi.executeLogout();
  },

  async startLogin(): Promise<void> {
    await electronApi.startLogin();
  }
};

export const useSessionStore = defineStore<
  'session',
  SessionState,
  SessionGetterFns,
  SessionActions
>('session', {
  state: sessionState,
  getters: sessionGetters as never,
  actions: sessionActions as SessionActions,
});

/** 组件侧需要标注 store 类型时用它 */
export type SessionStore = ReturnType<typeof useSessionStore>;
