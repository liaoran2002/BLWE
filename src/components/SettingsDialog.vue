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
  AUDIO_QUALITY_OPTIONS,
  GLASS_BLUR_PERCENT_PER_PX,
  GLASS_BLUR_PERCENT_STEP,
  GLASS_SHADOW_PERCENT_PER_PX,
  GLASS_SHADOW_PERCENT_STEP,
  GLASS_TRANSPARENCY_MAX,
  GLASS_TRANSPARENCY_MIN,
  GLASS_TRANSPARENCY_STEP,
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
      return `${count} 个文件 / ${formatBytes(bytes)}`;
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
    /** 手动触发一次「过期 + LRU」清理 */
    async pruneCache() {
      this.cacheBusy = true;
      try {
        const stats = await api.pruneCache();
        this.cacheStats = stats;
        ElMessage.success(`清理完成，当前 ${stats.count} 个文件 / ${formatBytes(stats.bytes)}`);
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
