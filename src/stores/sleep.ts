/**
 * Sleep store —— 定时暂停 / 定时关闭。
 *
 * 状态与动作都只属于这一个业务域；跨域访问通过 getters 里那几个 `xxxStore`
 * 指针拿到别的 store 实例（惰性求值，所以模块之间可以互相 import 而不成环）。
 */
import { defineStore } from 'pinia';
import type { AppData } from '../types/app';
import { ElMessage } from 'element-plus';
import electronApi from '../api/electron';
import { formatRemain, SleepTimer } from '../utils/sleepTimer';
import type { SleepTimerOptions, SleepTimerState } from '../utils/sleepTimer';

import { usePlaybackStore } from './playback';
import { useSettingStore } from './setting';
import { useSystemStore } from './system';
import { useWindowStore } from './window';

/** ===== state ===== */
export type SleepState = Pick<
  AppData,
  'sleepPanelVisible' | 'sleepState' | '_sleepTimer' | '_sleepUnsub'
>;

export const sleepState = (): SleepState => ({
  /** 定时暂停面板是否展开 */
  sleepPanelVisible: false,

  /**
   * 定时器状态快照（由 `SleepTimer` 每秒推一次）
   *
   * `markRaw` 不适用于这里（它是纯数据对象），但计时器实例本身
   * 在 `created` 里用普通字段存（不放 data，避免被 Vue 代理 —— 它有自己的 ticker）
   */
  sleepState: { active: false, remainMs: 0, pending: false, action: 'stop' } as SleepTimerState,

  /**
   * 定时暂停实例（`created` 里创建）
   *
   * 放 `data` 里是为了让 TS 认得它（`_` 前缀表示内部字段，模板不直接用）；
   * 但它自带 `setInterval`，被 Vue 响应式代理没有好处 —— 见 `setupSleepTimer`。
   */
  _sleepTimer: null as SleepTimer | null,

  /** `SleepTimer` 的订阅取消函数（`beforeUnmount` 里调） */
  _sleepUnsub: null as (() => void) | null,
});

/** ===== getters ===== */
export interface SleepGetters {
  readonly playbackStore: ReturnType<typeof usePlaybackStore>;
  readonly settingStore: ReturnType<typeof useSettingStore>;
  readonly systemStore: ReturnType<typeof useSystemStore>;
  readonly windowStore: ReturnType<typeof useWindowStore>;
  readonly sleepRemainText: string;
  readonly sleepActionText: string;
  readonly sleepHours: number;
  readonly sleepMinutes: number;
  readonly sleepOptions: SleepTimerOptions;
}

export type SleepGetterFns = { [K in keyof SleepGetters]: () => SleepGetters[K] };

export const sleepGetters: ThisType<SleepContext> = {
  playbackStore: () => usePlaybackStore(),
  settingStore: () => useSettingStore(),
  systemStore: () => useSystemStore(),
  windowStore: () => useWindowStore(),
  /**
   * 定时暂停：剩余时间的可读文本（按钮上和面板顶部都用它）
   *
   * 有小时 `H:MM:SS`，没有小时 `MM:SS`（用户明确要求）。
   */
  sleepRemainText(): string {
    return formatRemain(this.sleepState.remainMs);
  },

  /** 定时暂停：到点后做什么的可读文本 */
  sleepActionText(): string {
    return this.sleepState.action === 'quit' ? '停止播放并关闭程序' : '停止播放';
  },

  /**
   * 定时暂停：面板里的「时」（来自 settings 的记忆值）
   *
   * ⚠️ 面板里显示的是 **settings 里记住的值**，不是"剩余时间拆成时分"——
   * 用户要求如此：倒计时中点开面板，看到的是上次设的「1 时 0 分」，
   * 而不是「还剩 0 时 43 分」，这样改起来才知道自己在原来基础上调。
   */
  sleepHours(): number {
    return Number(this.settingStore.setting['common.sleepTimerHours']) || 0;
  },

  sleepMinutes(): number {
    return Number(this.settingStore.setting['common.sleepTimerMinutes']) || 0;
  },

  /** 定时暂停：三个复选框的状态（存在 settings 里，下次打开自动勾上） */
  sleepOptions(): SleepTimerOptions {
    const raw = this.settingStore.setting['common.sleepTimerOptions'];
    return {
      pauseCountdown: Boolean(raw?.pauseCountdown),
      waitVideoEnd: Boolean(raw?.waitVideoEnd),
      closeApp: Boolean(raw?.closeApp),
    };
  }
};

/** ===== actions ===== */
export interface SleepActions {
  setupSleepTimer(): void;
  onSleepTimerFired(): void;
  applySleepTimer(payload: { hours: number; minutes: number; options: SleepTimerOptions; }): void;
  cancelSleepTimer(): void;
}

export type SleepContext = SleepState & SleepGetters & SleepActions;

export const sleepActions: ThisType<SleepContext> = {
  // #region 定时暂停 / 定时关闭
  /**
   * 创建定时器实例（`created` 里调一次）
   *
   * 为什么实例不放 `data`：它自己持有 `setInterval`，被 Vue 代理没有好处，
   * 而且 `data` 里的对象会被深度响应式化（每帧都走一遍 Proxy 没意义）。
   * 状态通过 `subscribe` 推回 `sleepState`，界面只看那份快照。
   */
  setupSleepTimer(): void {
    this._sleepTimer = new SleepTimer({
      /**
       * 「停止播放」：只暂停，不退出
       *
       * 不用 `next()` / `changeSong` —— 定时暂停的语义就是「停下来」，
       * 不是「换下一首」。暂停后用户回来点播放就能接着听。
       */
      stop: () => {
        this.playbackStore.videoEl()?.pause();
        this.playbackStore.paused = true;
        ElMessage.success('定时暂停：已停止播放');
      },
      /** 「关闭程序」：走 `win:quit`（不是 `winClose`，那个会被"关闭到托盘"拦下） */
      quit: () => {
        ElMessage.success('定时暂停：正在关闭程序…');
        void electronApi.winQuit();
      },
      /** 定时真的执行了 → 这时才关弹窗 */
      fired: () => {
        this.onSleepTimerFired();
      },
      /**
       * 读当前播放位置与暂停态
       *
       * 没有视频元素时返回 `null` —— 定时器据此**不判定**「播到 1-3 秒」，
       * 也不冻结倒计时（当作在播）。
       */
      readVideo: () => {
        const el = this.playbackStore.videoEl();
        if (!el) return null;
        return { currentTime: el.currentTime, paused: el.paused };
      },
    });
    this._sleepUnsub = this._sleepTimer.subscribe((state) => {
      this.sleepState = state;
      /**
       * 托盘菜单开着时，把倒计时也推过去
       *
       * 菜单里的「定时」显示剩余时间，而这条每秒一跳的状态是**唯一**能驱动它更新的
       * 时钟：暂停时 `timeupdate` 不走了，光靠播放进度那条链倒计时会冻在菜单上。
       */
      if (this.windowStore.trayMenuOpen) this.systemStore.syncTrayState();
      /**
       * ⚠️ **不要在这里根据 `state.active` 关面板**
       *
       * 踩过：原来写了 `if (!state.active) 关面板`，结果**点 `+` / 勾复选框就关掉弹窗**。
       * 原因：那会儿面板还是「编辑时立刻上报」的写法 —— 改一下就触发 `emit()`，
       * 此刻定时还没启动，`active` 自然是 false，于是面板被误关。
       *
       * 现在面板是**草稿模式**（编辑只改本地 draft，点确认才 `apply`），
       * 定时器那边也没有 `setOptions()` 这条路径，所以这个误关根本不会发生；
       * 而且改成「只有真的执行了动作才关」——由 `onSleepTimerFired` 兜住。
       */
    });
  },

  /** 定时到点、动作执行完（关面板 + 收尾提示由 `fire` 那边给） */
  onSleepTimerFired(): void {
    this.sleepPanelVisible = false;
  },

  /**
   * 点「确认」/「更新定时」—— **只有这一步才写 settings 和启动定时器**
   *
   * `payload` 是面板里的**草稿**（编辑过程中不落盘、不影响定时器）。
   * 0 时 0 分 = 不设定时（面板那边也不会让你点，这里兜一层）。
   */
  applySleepTimer(payload: {
    hours: number;
    minutes: number;
    options: SleepTimerOptions;
  }): void {
    const { hours, minutes, options } = payload;
    if (hours === 0 && minutes === 0) {
      ElMessage.warning('时和分都是 0，等于不设定时');
      return;
    }
    /**
     * 先落 settings（记忆下次打开直接显示），再启动定时器
     *
     * 两者都放这里是有意的：编辑过程中不写盘，避免「只是按了下加号」也改配置。
     */
    void this.settingStore.update({
      'common.sleepTimerHours': hours,
      'common.sleepTimerMinutes': minutes,
      'common.sleepTimerOptions': options,
    });
    const started = this._sleepTimer?.start(hours, minutes, options) ?? false;
    if (!started) return;
    this.sleepPanelVisible = false;
    const action = options.closeApp ? '停止播放并关闭程序' : '停止播放';
    ElMessage.success(
      `已设定时：${formatRemain((hours * 60 + minutes) * 60000)} 后${action}`,
    );
  },

  /** 点「取消定时」（只对正在跑的定时有效；未定时时面板上没有这个按钮） */
  cancelSleepTimer(): void {
    this._sleepTimer?.cancel();
    this.sleepPanelVisible = false;
    ElMessage.success('已取消定时');
  }
};

export const useSleepStore = defineStore<
  'sleep',
  SleepState,
  SleepGetterFns,
  SleepActions
>('sleep', {
  state: sleepState,
  getters: sleepGetters as never,
  actions: sleepActions as SleepActions,
});

/** 组件侧需要标注 store 类型时用它 */
export type SleepStore = ReturnType<typeof useSleepStore>;
