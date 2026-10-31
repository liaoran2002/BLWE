<template>
  <!--
    定时暂停 / 定时关闭弹窗

    形态与「歌单管理」「设置」一致：`el-dialog` + `v-model`。

    ## 草稿状态（重要）

    面板里的时长和三个复选框是**本地草稿**，编辑时只改 draft，
    **只有点「确认 / 更新定时」才上报**（`apply`）。

    为什么：编辑时若立刻上报 → 触发定时器 `emit()` → 那一刻定时还没启动，
    之前按 `active` 判断就会「点一下加号弹窗就关了」。改成草稿后不存在这个问题，
    也符合「只有点确认才真的生效」。

    ⚠️ 定时器那边**没有** `setOptions()` 这条路径（已删的死代码）——
    选项只在点确认时通过 `apply` 一次性传过去（`start()` / `applySleepTimer`）。
    别照着"实时同步"的假设去改这个面板。

    两种状态：
      · 未定时 —— 时长 + 三个复选框 + 「确认」
      · 定时中 —— 头部显示剩余时间，按钮是「取消定时」/「更新定时」
  -->
  <el-dialog
    v-model="visible"
    width="430px"
    :show-close="false"
    align-center
  >
    <template #header>
      <div class="slp-head">
        <span class="slp-title">定时暂停</span>
        <!--
          倒计时中：显示剩余时间 + 到点做什么
          已归零、在等视频播完（`pending`）：显示「计时已结束，等待视频播放完毕…」
        -->
        <span v-if="pending" class="slp-remain slp-remain--pending">
          计时已结束，等待视频播放完毕…
        </span>
        <span v-else-if="active" class="slp-remain">
          <b>{{ remainText }}</b> 后{{ actionText }}
        </span>
      </div>
    </template>

    <div class="slp-body">
      <!--
        时长：`[+] [输入框] [−] 时   [+] [输入框] [−] 分`

        中间是**数字输入框**（不只是显示）—— 要 59 分钟能直接打进去，
        不用点 59 下加号。`+` / `−` 仍然保留，用于微调。
        `el-input-number` 自带的加减按钮关掉（`controls=false`），
        因为我们要自己控制这两个按钮的位置（加号在左、减号在右）。
      -->
      <div class="slp-time">
        <div class="slp-field">
          <button class="slp-step" type="button" @click="bump('hours', 1)">+</button>
          <el-input-number
            v-model="draftHours"
            :min="0"
            :max="23"
            :controls="false"
            :step="1"
            size="small"
            class="slp-input"
            @change="normalize('hours')"
          />
          <button class="slp-step" type="button" @click="bump('hours', -1)">−</button>
          <span class="slp-unit">时</span>
        </div>
        <div class="slp-field">
          <button class="slp-step" type="button" @click="bump('minutes', 1)">+</button>
          <el-input-number
            v-model="draftMinutes"
            :min="0"
            :max="59"
            :controls="false"
            :step="1"
            size="small"
            class="slp-input"
            @change="normalize('minutes')"
          />
          <button class="slp-step" type="button" @click="bump('minutes', -1)">−</button>
          <span class="slp-unit">分</span>
        </div>
      </div>

      <!--
        三个复选框是**叠加**关系（不是三选一）：
          · 暂停时停止倒计时  —— 视频暂停，倒计时也停
          · 视频播放完毕后停止播放 —— 到点不立刻停，等播到某个视频的第 1 秒
          · 停止播放后关闭程序 —— 把「停止播放」升级成「关闭程序」
      -->
      <label class="slp-check">
        <input type="checkbox" v-model="draftOptions.pauseCountdown" />
        <span>暂停时停止倒计时</span>
      </label>
      <label class="slp-check">
        <input type="checkbox" v-model="draftOptions.waitVideoEnd" />
        <span>视频播放完毕后停止播放</span>
      </label>
      <label class="slp-check">
        <input type="checkbox" v-model="draftOptions.closeApp" />
        <span>停止播放后关闭程序</span>
      </label>
    </div>

    <template #footer>
      <div class="slp-foot">
        <!-- 定时中才有「取消定时」；未定时**只有确认**（没有取消按钮） -->
        <el-button v-if="active" size="small" @click="onCancel">取消定时</el-button>
        <!--
          ⚠️ `0 时 0 分` 时**未定时**要禁用确认（踩过）

          原来按钮永远可点，于是「时长停在 00:00 → 点确认」会走到 player 的
          `applySleepTimer`：弹一句 warning 并 return（不写设置、不启动定时），
          但面板的 `confirm()` 紧接着**自己把弹窗关了** —— 用户看到的是
          「警告一闪 + 面板关了 + 什么也没设定」。

          禁用之后这条路径根本走不到。注意**定时中**不禁用：那时 0/0 是
          「取消定时」的语义（`apply` 会走取消分支），不是错误输入。
        -->
        <el-button
          size="small"
          type="primary"
          :disabled="!active && draftHours === 0 && draftMinutes === 0"
          @click="confirm"
        >
          {{ active ? '更新定时' : '确认' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script lang="ts">
/**
 * 定时暂停弹窗
 *
 * 时长与三个复选框是**本地草稿**：编辑只改 draft，点确认才写回 store。
 * 这样编辑过程完全不影响 player store 里正在跑的定时器，
 * 也就不会出现「点加号弹窗自己关掉」那种回环。
 */
import { defineComponent } from 'vue';
import type { SleepTimerOptions } from '../utils/sleepTimer';
import { useSleepStore } from '../stores/sleep';

export default defineComponent({
  name: 'SleepTimerPanel',
  data() {
    return {
      /** 草稿：时 */
      draftHours: 0,
      /** 草稿：分 */
      draftMinutes: 0,
      /** 草稿：三个复选框 */
      draftOptions: {
        pauseCountdown: false,
        waitVideoEnd: false,
        closeApp: false,
      } as SleepTimerOptions,
    };
  },
  computed: {
    /**
     * 这些 store（播放状态按域拆成了多个）
     *
     * 面板要显示的状态（是否在倒计时 / 剩余多久 / 上次设的时长）全在 store 里，
     * 开关也在 —— 以前用 props 传进来、emit 出去，现在直接读写。
     *
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    sleep() {
      return useSleepStore();
    },
    /** `el-dialog` 的 v-model */
    visible: {
      get(): boolean {
        return this.sleep.sleepPanelVisible;
      },
      set(v: boolean): void {
        this.sleep.sleepPanelVisible = v;
      },
    },
    /** 是否正在倒计时（决定头部显示和按钮组） */
    active(): boolean {
      return this.sleep.sleepState.active;
    },
    /**
     * 倒计时已归零、正在等「视频播到 0-3 秒」
     *
     * 头部改成「计时已结束，等待视频播放完毕…」。
     */
    pending(): boolean {
      return this.sleep.sleepState.pending;
    },
    /** 剩余时间的可读文本（`1:23:45` / `23:45`） */
    remainText(): string {
      return this.sleep.sleepRemainText;
    },
    /** 到点后做什么的可读文本 */
    actionText(): string {
      return this.sleep.sleepActionText;
    },
    /** settings 里记住的时长（打开面板时用它初始化草稿） */
    hours(): number {
      return this.sleep.sleepHours;
    },
    minutes(): number {
      return this.sleep.sleepMinutes;
    },
    /** settings 里记住的三个选项（打开面板时用它初始化草稿） */
    options(): SleepTimerOptions {
      return this.sleep.sleepOptions;
    },
  },
  watch: {
    /**
     * 打开面板时把草稿重置成 settings 里的记忆值
     *
     * 必须每次打开都重置：用户可能上次改到一半点了取消，
     * 或者定时执行完值变了 —— 再打开应该看到「已保存的那份」。
     */
    visible: {
      immediate: true,
      handler(open: boolean): void {
        if (!open) return;
        this.resetDraft();
      },
    },
  },
  methods: {
    /** 点「取消定时」：先关自己，再取消定时 */
    onCancel(): void {
      this.sleep.cancelSleepTimer();
      this.visible = false;
    },
    resetDraft(): void {
      this.draftHours = Math.min(23, Math.max(0, Math.floor(this.hours || 0)));
      this.draftMinutes = Math.min(59, Math.max(0, Math.floor(this.minutes || 0)));
      this.draftOptions = {
        pauseCountdown: Boolean(this.options?.pauseCountdown),
        waitVideoEnd: Boolean(this.options?.waitVideoEnd),
        closeApp: Boolean(this.options?.closeApp),
      };
    },
    /**
     * 用户在输入框里手打数字后，把值夹回合法范围
     *
     * `el-input-number` 的 `:min`/`:max` 只在**失焦或点步进**时才夹，
     * 输入过程中允许越界值（也允许 `null`）—— 所以这里再兜一层，
     * 避免 `null` 或者 999 被带进 `confirm()`。
     */
    normalize(kind: 'hours' | 'minutes'): void {
      if (kind === 'hours') {
        const n = Math.floor(Number(this.draftHours));
        this.draftHours = Number.isFinite(n) ? Math.min(23, Math.max(0, n)) : 0;
      } else {
        const n = Math.floor(Number(this.draftMinutes));
        this.draftMinutes = Number.isFinite(n) ? Math.min(59, Math.max(0, n)) : 0;
      }
    },
    /**
     * `+` / `−` 改时长（只改草稿）
     *
     * 时 0-23、分 0-59 **循环**：从 59 分调到 0 分时按一下 `+` 就绕回来，
     * 不用按 59 次 `−`。
     */
    bump(kind: 'hours' | 'minutes', delta: number): void {
      if (kind === 'hours') {
        /**
         * 时：0-23 循环
         *
         * 23 再 +1 回 0、0 再 −1 回 23 —— 用户从 23 调到 0 时按一下 `+`
         * 就绕回来了，不用按 23 次 `−`。
         */
        this.draftHours = (this.draftHours + delta + 24) % 24;
        return;
      }
      /**
       * 分：59 再 +1 **进位到小时**（而不是绕回 0）
       *
       * 用户要求：59 分时点加号 → 小时 +1、分变 0。
       * 反向同理：0 分时点 `−` → 小时 −1、分变 59 ——「退一位」比"卡在 0"
       * 更好用（想把 1 时 0 分改成 0 时 59 分时不用点 59 次）。
       */
      const next = this.draftMinutes + delta;
      if (next > 59) {
        this.draftMinutes = 0;
        this.draftHours = (this.draftHours + 1) % 24;
      } else if (next < 0) {
        this.draftMinutes = 59;
        this.draftHours = (this.draftHours - 1 + 24) % 24;
      } else {
        this.draftMinutes = next;
      }
    },
    /** 点确认 / 更新定时：交给 store，并自己先关掉弹窗 */
    confirm(): void {
      this.sleep.applySleepTimer({
        hours: this.draftHours,
        minutes: this.draftMinutes,
        options: { ...this.draftOptions },
      });
      /**
       * ⚠️ **必须在这里主动关掉自己**
       *
       * 踩过：只上报启动定时、然后指望别处把 `sleepPanelVisible` 置 false ——
       * 实测**弹窗不会关**（定时确实启动了，但框还在）。
       * 原因当时是 `el-dialog` 的 `v-model="visible"` 绑了一个 getter/setter，
       * 外面改 `sleepPanelVisible` 时 setter 又 emit `update:modelValue` 回来，
       * 形成来回覆盖。
       *
       * 现在 setter 直接写 store、没有 emit 了，那个来回已经不存在；这里照旧
       * 显式关一次，语义更清楚：用户点了确认，框就该消失。
       */
      this.visible = false;
    },
  },
});
</script>

<style scoped>
.slp-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.slp-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--panel-text);
}
.slp-remain {
  font-size: 12.5px;
  color: var(--panel-text-dim);
}
.slp-remain b {
  color: var(--accent);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
/* 计时已结束、在等视频播完：红色，与按钮上的 `00:00` 呼应 */
.slp-remain--pending {
  color: var(--accent-danger);
  font-weight: 600;
}
.slp-body {
  padding: 2px 2px 0;
}
/* 时长：时和分同一排居中 */
.slp-time {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 26px;
  padding: 10px 0 18px;
  border-bottom: 1px solid var(--panel-divider);
  margin-bottom: 10px;
}
.slp-field {
  display: flex;
  align-items: center;
  gap: 7px;
}
.slp-unit {
  font-size: 12.5px;
  color: var(--panel-text-dim);
  margin-left: 2px;
}
/* `+` / `−` 按钮：小方块 */
.slp-step {
  width: 24px;
  height: 24px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  background: transparent;
  color: var(--panel-text);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s;
}
.slp-step:hover {
  background: var(--panel-hover);
}
/* 数字输入框：定宽 + 居中 + 等宽数字，`09` 和 `10` 宽度一样，按钮不会左右跳 */
.slp-input {
  width: 58px;
}
.slp-input :deep(.el-input__inner) {
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 16px;
  font-weight: 600;
  padding: 0 4px;
}
.slp-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 2px;
  cursor: pointer;
  font-size: 13px;
  color: var(--panel-text);
  border-radius: 5px;
  transition: background 0.12s;
}
.slp-check:hover {
  background: var(--panel-hover);
}
.slp-check input {
  cursor: pointer;
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
}
.slp-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
