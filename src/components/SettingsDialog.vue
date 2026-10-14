<template>
  <el-dialog
    :model-value="modelValue"
    title="设置"
    width="600px"
    :show-close="false"
    align-center
    @update:model-value="(v: boolean) => $emit('update:modelValue', v)"
  >
    <div class="st-body">
      <!-- 播放 -->
      <div class="st-group">
        <div class="st-group-title">播放</div>
        <div class="st-row">
          <div class="st-name">最高视频清晰度</div>
          <el-select
            :model-value="setting['player.videoQuality']"
            size="small"
            style="width: 170px"
            @update:model-value="(v: number) => set('player.videoQuality', v)"
          >
            <el-option
              v-for="opt in VIDEO_QUALITY_OPTIONS"
              :key="opt.id"
              :label="opt.description"
              :value="opt.id"
            />
          </el-select>
        </div>
        <div class="st-row">
          <div class="st-name">最高音质</div>
          <el-select
            :model-value="setting['player.audioQuality']"
            size="small"
            style="width: 170px"
            @update:model-value="(v: number) => set('player.audioQuality', v)"
          >
            <el-option
              v-for="opt in AUDIO_QUALITY_OPTIONS"
              :key="opt.id"
              :label="opt.description"
              :value="opt.id"
            />
          </el-select>
        </div>
        <div class="st-row">
          <div class="st-name">记住播放进度</div>
          <el-switch
            :model-value="setting['player.resumeOnStart']"
            @update:model-value="(v: string | number | boolean) => setBool('player.resumeOnStart', v)"
          />
        </div>
        <div class="st-row">
          <div class="st-name">声音输出设备变化时暂停</div>
          <el-switch
            :model-value="setting['player.pauseOnDeviceChange']"
            @update:model-value="
              (v: string | number | boolean) => setBool('player.pauseOnDeviceChange', v)
            "
          />
        </div>
        <div class="st-row">
          <div class="st-name">全屏自动锁定</div>
          <el-switch
            :model-value="setting['player.lockOnFullscreen']"
            @update:model-value="
              (v: string | number | boolean) => setBool('player.lockOnFullscreen', v)
            "
          />
        </div>
      </div>

      <!-- 界面 -->
      <div class="st-group">
        <div class="st-group-title">界面</div>
        <div class="st-row">
          <div class="st-name">主题色</div>
          <div class="st-color-box">
            <el-input
              class="st-hex"
              size="small"
              :model-value="setting['common.themeColor']"
              spellcheck="false"
              @change="(v: string) => setColor('common.themeColor', v)"
            />
            <el-color-picker
              :model-value="setting['common.themeColor']"
              size="small"
              @update:model-value="(v: string | null) => setColor('common.themeColor', v)"
            />
          </div>
        </div>
        <div class="st-row">
          <div class="st-name">字体颜色</div>
          <div class="st-color-box">
            <el-input
              class="st-hex"
              size="small"
              :model-value="setting['common.fontColor']"
              spellcheck="false"
              @change="(v: string) => setColor('common.fontColor', v)"
            />
            <el-color-picker
              :model-value="setting['common.fontColor']"
              size="small"
              @update:model-value="(v: string | null) => setColor('common.fontColor', v)"
            />
          </div>
        </div>
        <div class="st-row">
          <div class="st-name">透明度</div>
          <div class="st-slider-box">
            <el-slider
              class="st-slider"
              :model-value="setting['common.glassTransparency']"
              :min="GLASS_TRANSPARENCY_MIN"
              :max="GLASS_TRANSPARENCY_MAX"
              :step="GLASS_TRANSPARENCY_STEP"
              @update:model-value="(v: number | number[]) => setTransparency(v)"
            />
            <span class="st-value">{{ setting['common.glassTransparency'] }}%</span>
          </div>
        </div>
        <div class="st-row">
          <div class="st-name">模糊强度</div>
          <div class="st-slider-box">
            <el-slider
              class="st-slider"
              :model-value="blurPercent"
              :min="GLASS_TRANSPARENCY_MIN"
              :max="GLASS_TRANSPARENCY_MAX"
              :step="GLASS_BLUR_PERCENT_STEP"
              @update:model-value="(v: number | number[]) => setBlurPercent(v)"
            />
            <span class="st-value">{{ blurPercent }}%</span>
          </div>
        </div>
        <div class="st-row">
          <div class="st-name">阴影强度</div>
          <div class="st-slider-box">
            <el-slider
              class="st-slider"
              :model-value="shadowPercent"
              :min="GLASS_TRANSPARENCY_MIN"
              :max="GLASS_TRANSPARENCY_MAX"
              :step="GLASS_SHADOW_PERCENT_STEP"
              @update:model-value="(v: number | number[]) => setShadowPercent(v)"
            />
            <span class="st-value">{{ shadowPercent }}%</span>
          </div>
        </div>
        <!--
          窗口宽高比

          `allow-create` 让用户能直接输入一个比例（如 21:9、9:16），输入的值会被
          加进列表并持久化（`common.customAspectRatios`），下次打开还在。
          `filterable` 让选项多了以后能搜。
        -->
        <div class="st-row">
          <div class="st-name">窗口宽高比</div>
          <el-select
            :model-value="setting['common.windowAspectRatio']"
            size="small"
            style="width: 170px"
            filterable
            allow-create
            default-first-option
            :reserve-keyword="false"
            @update:model-value="(v: string) => setAspectRatio(v)"
          >
            <el-option
              v-for="opt in aspectRatioOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </div>
      </div>

      <!-- 通用 -->
      <div class="st-group">
        <div class="st-group-title">通用</div>
        <div class="st-row">
          <div class="st-name">启动时进入桌面壁纸模式</div>
          <el-switch
            :model-value="setting['common.wallpaperMode']"
            @update:model-value="(v: string | number | boolean) => setBool('common.wallpaperMode', v)"
          />
        </div>
        <div class="st-row">
          <div class="st-name">关闭窗口时最小化到托盘</div>
          <el-switch
            :model-value="setting['common.closeToTray']"
            @update:model-value="(v: string | number | boolean) => setBool('common.closeToTray', v)"
          />
        </div>
        <div class="st-row">
          <div class="st-name">任务栏显示播放进度</div>
          <el-switch
            :model-value="setting['common.taskbarProgress']"
            @update:model-value="
              (v: string | number | boolean) => setBool('common.taskbarProgress', v)
            "
          />
        </div>
        <div class="st-row">
          <div class="st-name">搜索结果过期时间</div>
          <div class="st-actions">
            <!--
              单位是「天」，存的是毫秒，所以读写都要换算（见 expireDays / setExpireDays）。
              `el-input-number` 自带左右加减按钮，正好用来一档一档地点。

              「0 = 永久」用**旁边的说明文字**表达，没有用 formatter/parser：
              那对钩子会把输入框里的文本和 v-model 的数字来回转换，
              用户手输（尤其是清空、只留一个「0」）时的行为不容易验证，
              而这里要表达的只是「0 是什么意思」，一句话就够清楚了。
            -->
            <el-input-number
              :model-value="expireDays"
              size="small"
              style="width: 130px"
              :min="CACHE_EXPIRE_DAYS_MIN"
              :max="CACHE_EXPIRE_DAYS_MAX"
              :step="CACHE_EXPIRE_DAYS_STEP"
              @update:model-value="(v: number | undefined) => setExpireDays(v)"
            />
            <span class="st-desc">{{ expireHint }}</span>
          </div>
        </div>
        <div class="st-row">
          <div class="st-name">搜索缓存</div>
          <div class="st-actions">
            <span class="st-desc">{{ cacheText }}</span>
            <el-button size="small" :loading="cacheBusy" @click="pruneCache">清理过期</el-button>
            <el-button size="small" type="danger" plain @click="clearCache">全部清除</el-button>
          </div>
        </div>
        <div class="st-row">
          <div class="st-name">恢复默认设置</div>
          <el-popconfirm
            title="确定恢复所有设置为默认值吗？"
            confirm-button-text="恢复"
            cancel-button-text="取消"
            width="230"
            @confirm="resetAll"
          >
            <template #reference>
              <el-button size="small" type="danger" plain>恢复默认</el-button>
            </template>
          </el-popconfirm>
        </div>
      </div>
    </div>

  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage } from 'element-plus';
import {
  ASPECT_RATIO_FREE,
  ASPECT_RATIO_MAX_LENGTH,
  ASPECT_RATIO_OPTIONS,
  ASPECT_RATIO_PATTERN,
  AUDIO_QUALITY_OPTIONS,
  CACHE_EXPIRE_DAYS_MAX,
  CACHE_EXPIRE_DAYS_MIN,
  CACHE_EXPIRE_DAYS_STEP,
  CUSTOM_ASPECT_RATIO_MAX_COUNT,
  GLASS_BLUR_PERCENT_PER_PX,
  GLASS_BLUR_PERCENT_STEP,
  GLASS_SHADOW_PERCENT_PER_PX,
  GLASS_SHADOW_PERCENT_STEP,
  GLASS_TRANSPARENCY_MAX,
  GLASS_TRANSPARENCY_MIN,
  GLASS_TRANSPARENCY_STEP,
  MS_PER_DAY,
  VIDEO_QUALITY_OPTIONS,
} from '@common/constants';
import type { AppSetting } from '@common/types/app_setting';
import api from '../api/electron';
import { useSettingStore } from '../stores/setting';
import { parseHexColor } from '../utils/uiTheme';

/** 字节 -> 可读体积 */
const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * 把滑块回调的值收敛成「范围内的步进倍数」
 *
 * 滑块本身已经按 step 取整了，这里再兜一次：回调可能给数组、浮点，
 * 旧实例 / 键盘操作也可能塞进 53 这种值，落盘前统一归到步进的倍数。
 */
const snapSlider = (v: number | number[], min: number, max: number, step: number): number => {
  const n = Array.isArray(v) ? v[0] : v;
  const raw = Math.min(max, Math.max(min, Math.round(Number(n) || 0)));
  return Math.round(raw / step) * step;
};

export default defineComponent({
  name: 'SettingsDialog',
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      /** 缓存占用统计 */
      cacheStats: { count: 0, bytes: 0 },
      cacheBusy: false,
      /** 完整档位表（设置页给的是「自动播放的上限」，所以铺全表而不是当前视频的可用档位） */
      VIDEO_QUALITY_OPTIONS,
      AUDIO_QUALITY_OPTIONS,
      /** 透明度的取值范围与步进 */
      GLASS_TRANSPARENCY_MIN,
      GLASS_TRANSPARENCY_MAX,
      GLASS_TRANSPARENCY_STEP,
      /** 模糊强度 / 阴影强度：滑块是百分比（0-100%，5% 一档），存的却是 0-20px */
      GLASS_BLUR_PERCENT_STEP,
      GLASS_SHADOW_PERCENT_STEP,
      /** 搜索结果过期时间：界面按「天」，范围与步进都从常量来 */
      CACHE_EXPIRE_DAYS_MIN,
      CACHE_EXPIRE_DAYS_MAX,
      CACHE_EXPIRE_DAYS_STEP,
    };
  },
  computed: {
    store() {
      return useSettingStore();
    },
    setting(): AppSetting {
      return this.store.setting;
    },
    /** 模糊强度界面上显示的百分比（0-20px -> 0-100%） */
    blurPercent(): number {
      return this.setting['common.glassBlur'] * GLASS_BLUR_PERCENT_PER_PX;
    },
    /** 阴影强度界面上显示的百分比（0-20px -> 0-100%） */
    shadowPercent(): number {
      return this.setting['common.glassShadow'] * GLASS_SHADOW_PERCENT_PER_PX;
    },
    cacheText(): string {
      const { count, bytes } = this.cacheStats;
      return `${count} 个视频 / ${formatBytes(bytes)}`;
    },
    /**
     * 搜索结果过期时间：界面上的「天」
     *
     * 存储是毫秒（`cache.searchResultExpireMs`），界面按天 —— 用户不会想输 259200000。
     * 换算在这里做一次，别的地方一律用毫秒。
     */
    expireDays(): number {
      return Math.round(this.setting['cache.searchResultExpireMs'] / MS_PER_DAY);
    },
    /**
     * 过期时间那一行的说明文字
     *
     * **0 必须被说出来**：它是有意义的选项（永久不清理播放直链），
     * 而不是「填了个很小的数」。光看一个「0」用户没法知道这是「马上过期」还是「不过期」，
     * 而这两种理解的后果完全相反。
     */
    expireHint(): string {
      return this.expireDays === 0 ? '永久（不清理播放地址）' : '天后重新解析播放地址';
    },
    /**
     * 下拉框的选项 = 固定预设 + 用户自己输入过的比例
     *
     * 预设里已经有 `16:9` / `4:3` / `free`，自定义列表要去掉重复的
     * （用户可能把 16:9 又输了一遍），否则下拉框里会出现两个「16:9」。
     */
    aspectRatioOptions(): { label: string; value: string }[] {
      const presetValues = new Set<string>(ASPECT_RATIO_OPTIONS.map((o) => o.value));
      const custom = this.setting['common.customAspectRatios']
        .filter((v) => v && !presetValues.has(v))
        .map((v) => ({ label: v, value: v }));
      return [...ASPECT_RATIO_OPTIONS.map((o) => ({ label: o.label, value: o.value })), ...custom];
    },
  },
  watch: {
    // 每次打开时刷新一次占用
    modelValue(visible: boolean) {
      if (visible) void this.refreshCacheStats();
    },
  },
  mounted() {
    if (this.modelValue) void this.refreshCacheStats();
  },
  methods: {

    /** 统一走 store 的 update（会由主进程广播回写，保证与其它窗口一致） */
    set<K extends keyof AppSetting>(key: K, value: AppSetting[K]): void {
      void this.store.update({ [key]: value } as Partial<AppSetting>);
    },
    /**
     * 开关类控件
     *
     * element-plus 的 el-switch 回调签名是 `string | number | boolean`（它支持自定义值），
     * 所以这里在方法里收窄成 boolean，避免模板里塞一堆断言。
     */
    setBool(
      key:
        | 'player.resumeOnStart'
        | 'player.pauseOnDeviceChange'
        | 'player.lockOnFullscreen'
        | 'common.wallpaperMode'
        | 'common.closeToTray'
        | 'common.taskbarProgress',
      v: string | number | boolean,
    ): void {
      this.set(key, Boolean(v));
    },
    /**
     * 颜色（主题色 / 字体颜色）
     *
     * 两个入口共用：前面那个 16 进制输入框（手输 #RRGGBB）和后面的取色盘。
     * 取色盘取消选择时会回 null，这时候直接忽略；输入框里写的东西一律先校验，
     * 不合法就不落盘（不然会把上一次的好颜色覆盖成垃圾值）。
     */
    setColor(key: 'common.themeColor' | 'common.fontColor', v: string | null | undefined): void {
      if (v == null) return;
      const value = v.trim().toLowerCase();
      if (!parseHexColor(value)) return;
      this.set(key, value);
    },
    /**
     * 透明度：就是玻璃底色 `rgba(255,255,255,x)` 里的 x（百分比）
     *
     * 滑块本身已经按 step 取整了，这里再吸附一次：旧实例 / 键盘 / 未来换控件
     * 都可能塞进 53 这种值，落盘前统一归到 5 的倍数。
     */
    setTransparency(v: number | number[]): void {
      this.set(
        'common.glassTransparency',
        snapSlider(v, GLASS_TRANSPARENCY_MIN, GLASS_TRANSPARENCY_MAX, GLASS_TRANSPARENCY_STEP),
      );
    },
    /**
     * 模糊强度：界面按百分比走（5% 一档），存的是 0-20 的 px
     *
     * 100% = 20px，所以 px = 百分比 / 5。
     */
    setBlurPercent(v: number | number[]): void {
      const pct = snapSlider(v, 0, 100, GLASS_BLUR_PERCENT_STEP);
      this.set('common.glassBlur', Math.round(pct / GLASS_BLUR_PERCENT_PER_PX));
    },
    /** 阴影强度：和模糊强度一个套路（界面百分比、实际 0-20px） */
    setShadowPercent(v: number | number[]): void {
      const pct = snapSlider(v, 0, 100, GLASS_SHADOW_PERCENT_STEP);
      this.set('common.glassShadow', Math.round(pct / GLASS_SHADOW_PERCENT_PER_PX));
    },
    /**
     * 设置窗口宽高比
     *
     * 三种输入都要处理：
     *  1. 固定预设（`16:9` / `4:3` / `free`）→ 直接用；
     *  2. 已有自定义比例 → 直接用；
     *  3. **新输入的比例**（`allow-create` 放进来的任意字符串）→ 先校验格式，
     *     合法才落盘，并把它加进 `common.customAspectRatios` 让它留在下拉列表里。
     *
     * 校验必须做：输入框里可以敲任何东西（`abc`、`16/9`、空串），
     * 非法值落盘后主进程会当成 `0`（不限制），界面却显示着 `abc` —— 两边不一致。
     */
    setAspectRatio(v: string): void {
      const value = String(v ?? '').trim();

      // 「不限制」和空值：回到不限制
      if (!value || value === ASPECT_RATIO_FREE) {
        this.set('common.windowAspectRatio', ASPECT_RATIO_FREE);
        return;
      }

      if (!ASPECT_RATIO_PATTERN.test(value) || value.length > ASPECT_RATIO_MAX_LENGTH) {
        ElMessage.warning('宽高比格式应为「宽:高」，例如 16:9 或 21:9');
        return;
      }

      // 解析一次，挡掉 `0:9` / `16:0` 这种数学上无意义的值
      const [w, h] = value.split(':').map(Number);
      if (!(w > 0) || !(h > 0)) {
        ElMessage.warning('宽高比两边的数字都必须大于 0');
        return;
      }

      this.set('common.windowAspectRatio', value);

      // 新比例就记进下拉列表（已有则不重复加）
      const presetValues = ASPECT_RATIO_OPTIONS.map((o) => o.value) as string[];
      const list = this.setting['common.customAspectRatios'];
      if (!presetValues.includes(value) && !list.includes(value)) {
        // 只留最近若干个，避免长期使用后列表无限膨胀
        const next = [...list, value].slice(-CUSTOM_ASPECT_RATIO_MAX_COUNT);
        this.set('common.customAspectRatios', next);
      }
    },
    /**
     * 设置搜索结果过期时间（界面输入「天」，存储「毫秒」）
     *
     * 做了三件收敛：
     *  1. 输入框可能回 `undefined`（用户清空），按 0 处理 —— 0 就是「永久」，
     *     语义上比「保持上一次的值」更贴近用户的意图（他刚把内容删了）；
     *  2. 夹进 `[MIN, MAX]`：手输可以越过 `:min` / `:max`（Element Plus 只在
     *     步进/失焦时钳制），而超出上限的毫秒值没有意义；
     *  3. 取整：小数点后的「天」没有意义，还会让毫秒值变成小数。
     */
    setExpireDays(v: number | undefined): void {
      const days = Math.round(Number(v) || 0);
      const clamped = Math.min(CACHE_EXPIRE_DAYS_MAX, Math.max(CACHE_EXPIRE_DAYS_MIN, days));
      this.set('cache.searchResultExpireMs', clamped * MS_PER_DAY);
    },
    async clearCache() {
      this.cacheBusy = true;
      try {
        await api.clearCache();
        await this.refreshCacheStats();
        ElMessage.success('缓存已清除');
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err));
      } finally {
        this.cacheBusy = false;
      }
    },
    /**
     * 手动触发一次过期清理
     *
     * 注意现在**只清播放地址那一批列**（`durl_url` / `dash_video` / `dash_audio` /
     * `quality` / `support_formats` / `playurl_at`），不再有 LRU 淘汰 ——
     * 元数据（标题/封面/收藏/顺序）永不过期，所以清理之后条数不会变少，
     * 只有体积会掉下来。
     */
    async pruneCache() {
      this.cacheBusy = true;
      try {
        const stats = await api.pruneCache();
        this.cacheStats = stats;
        ElMessage.success(`清理完成，当前 ${stats.count} 个视频 / ${formatBytes(stats.bytes)}`);
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err));
      } finally {
        this.cacheBusy = false;
      }
    },
    async refreshCacheStats() {
      try {
        this.cacheStats = await api.getCacheStats();
      } catch {
        /* 拿不到统计不影响设置界面 */
      }
    },
    async resetAll() {
      try {
        await this.store.reset();
        ElMessage.success('已恢复默认设置');
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err));
      }
    },
  },
});
</script>

<style scoped>
.st-body {
  max-height: 62vh;
  overflow-y: auto;
  padding-right: 4px;
}
.st-group {
  margin-bottom: 18px;
}
.st-group-title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.55;
  margin-bottom: 6px;
  padding-left: 2px;
}
.st-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--panel-divider);
}
.st-row:last-child {
  border-bottom: none;
}
.st-name {
  font-size: 13px;
}
/* 只有「搜索缓存」那一行用它显示占用体积，属于数据不是说明 */
.st-desc {
  font-size: 11px;
  opacity: 0.55;
  white-space: nowrap;
}
.st-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
/* 颜色行：前面是 16 进制输入框，后面是取色盘 */
.st-color-box {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.st-hex {
  width: 104px;
}
.st-hex :deep(.el-input__inner) {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  text-align: center;
}
/* 滑块 + 右侧常显数值：值必须一直看得见，别只靠悬停 tooltip */
.st-slider-box {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.st-slider {
  width: 180px;
  flex: none;
}
.st-value {
  width: 42px;
  text-align: right;
  font-size: 12px;
  /* 数字等宽，拖动时不会左右跳 */
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
</style>
