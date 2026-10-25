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
      <!--
        左侧目录 + 右侧一页到底
        ============================
        ⚠️ 左栏**不是 Tab（不是切换页面）**，是**目录**：
        右边始终是完整的一页（所有设置都在），点左栏只是**滚到对应位置**。

        为什么不做成 Tab 切换：
          - 切换会让人「找不到刚看过的那一项」——设置项之间经常要对照着调
            （比如「时长容差」和「降级阈值」），换页就把上下文切断了；
          - 用户的原话是「不要点一下就像换了个页面一样」。

        左栏的高亮跟着**滚动位置**走（scroll spy），而不是只记"最后点了谁"——
        否则用户自己滚到「搜索」时，左栏还停在「播放」，看着像坏了。
      -->
      <div class="st-nav">
        <div
          v-for="tab in TABS"
          :key="tab.key"
          class="st-nav-item"
          :class="{ 'is-active': activeTab === tab.key }"
          @click="scrollToSection(tab.key)"
        >
          {{ tab.label }}
        </div>
      </div>

      <div ref="content" class="st-content" @scroll="onContentScroll">
      <!-- 播放 -->
      <div :data-section="'player'" class="st-group">
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
        <!--
          卡顿自动降低清晰度

          ⚠️ 这个开关**只管「降清晰度」这一步**：
          卡顿时的「换备用源」和「降 durl」是无条件自动做的（那两步不损失清晰度体验）。
          关掉时不是什么都不做，而是「不自动降」+ 提示用户自己降。
        -->
        <div class="st-row">
          <div class="st-name">
            卡顿自动降低清晰度
          </div>
          <el-switch
            :model-value="setting['player.autoDowngradeOnStall']"
            @update:model-value="
              (v: string | number | boolean) => setBool('player.autoDowngradeOnStall', v)
            "
          />
        </div>
      </div>

      <!-- 界面 -->
      <div :data-section="'ui'" class="st-group">
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
        <div class="st-row st-row--slider">
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
        <!--
          控制栏闲置透明度

          管的是「鼠标**不**悬停时整个控制栏淡到多透明」（移上去恢复完全不透明）。
          和上面的「透明度」不是一回事：那个管玻璃**底色**，悬停前后都一样。
        -->
        <div class="st-row st-row--slider">
          <div class="st-name">
            控制栏闲置透明度
          </div>
          <div class="st-slider-box">
            <el-slider
              class="st-slider"
              :model-value="setting['common.idleOpacity']"
              :min="IDLE_OPACITY_MIN"
              :max="IDLE_OPACITY_MAX"
              :step="IDLE_OPACITY_STEP"
              @update:model-value="(v: number | number[]) => setIdleOpacity(v)"
            />
            <span class="st-value">{{ setting['common.idleOpacity'] }}%</span>
          </div>
        </div>
        <div class="st-row st-row--slider">
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
        <div class="st-row st-row--slider">
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
      <div :data-section="'common'" class="st-group">
        <div class="st-group-title">通用</div>
        <div class="st-row">
          <div class="st-name">启动时进入桌面壁纸模式</div>
          <el-switch
            :model-value="setting['common.wallpaperMode']"
            @update:model-value="(v: string | number | boolean) => setBool('common.wallpaperMode', v)"
          />
        </div>
        <!--
          开机自动启动

          写进系统启动项（Windows 注册表 Run 键），下次开机自动拉起。
          ⚠️ 便携版会注册**当前 exe 的完整路径** —— 之后挪动文件夹的话，
          启动项里还是旧路径，会静默失效（每次启动应用会重写一遍来纠正）。
        -->
        <div class="st-row">
          <div class="st-name">
            开机自动启动
            <span class="st-desc">移动程序位置后需要重新开一次</span>
          </div>
          <el-switch
            :model-value="setting['common.autoLaunch']"
            @update:model-value="(v: string | number | boolean) => setBool('common.autoLaunch', v)"
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
			  :max="CACHE_EXPIRE_DAYS_MAX"
              :min="CACHE_EXPIRE_DAYS_MIN"
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

      <!-- ==================== 搜索 ==================== -->
      <div :data-section="'search'" class="st-group">
        <div class="st-group-title">搜索</div>

        <!-- ① 时长容差 -->
        <div class="st-row">
          <div class="st-name">时长容差</div>
          <div class="st-actions">
            <el-input-number
              :model-value="setting['player.durationToleranceSec']"
              size="small"
              style="width: 120px"
              :min="DURATION_TOLERANCE_MIN"
              :max="DURATION_TOLERANCE_MAX"
              :step="10"
              @update:model-value="(v: number | undefined) => setNumber('player.durationToleranceSec', v)"
            />
            <span class="st-desc">秒（MV / Live 自动放宽）</span>
          </div>
        </div>

        <!-- ② 降级阈值 -->
        <div class="st-row">
          <div class="st-name">降级重搜阈值</div>
          <div class="st-actions">
            <el-input-number
              :model-value="setting['player.minSearchResults']"
              size="small"
              style="width: 120px"
              :min="0"
              :max="MIN_SEARCH_RESULTS_MAX"
              :step="5"
              @update:model-value="(v: number | undefined) => setNumber('player.minSearchResults', v)"
            />
            <span class="st-desc">条；0 = 从不降级</span>
          </div>
        </div>

        <!--
          ③ 关键词加权（**在过滤关键词之上**，按用户要求）
          ================================================
          每一档两行：
            · 第一行 `[+] [分值] [−]`   —— 加号在左、减号在右
            · 第二行 关键词标签 + 「删除」（删除靠最右）
          这样分值调节和标签各自有空间，不会挤成一团。
        -->
        <div class="st-sub st-sub--split">
          <span class="st-sub-title">关键词加权</span>
          <el-button class="st-add-tier" size="small" text @click="openTierInput">
            添加分值档
          </el-button>
        </div>
        <!-- 新增分值档：点了「+ 分值档」才出现 -->
        <div v-if="tierInputVisible" class="st-row">
          <div class="st-name">新分值</div>
          <div class="st-actions">
            <el-input
              v-model="newTierText"
              size="small"
              style="width: 90px"
              placeholder="如 -5"
              autofocus
              @keyup.enter="addTier"
            />
            <!-- 确定：绿色（success）、取消：蓝色（primary）—— 和删除确认那组配色一致 -->
            <el-button size="small" type="success" @click="addTier">确定</el-button>
            <el-button size="small" type="primary" @click="cancelTierInput">取消</el-button>
          </div>
        </div>
        <div v-for="score in tagBonusScores" :key="`tb-${score}`" class="st-tier">
          <!--
            第一行：`[+] [分值] [−]` …… 「- 删除分值档」

            加号在最左、减号在中、删除按钮**推最右**（`margin-left: auto`）。
            中间是**数字输入框**，可以直接打字改成任意分值（比如 -50）；
            输入框失焦/回车时 `applyTagBonusScore` 会把键名换掉
            （`player.tagBonus` 的**键就是分值**）。
          -->
          <div class="st-tier-head">
            <el-button
              class="st-score-btn"
              size="small"
              text
              title="增加 1 分"
              @click="shiftTagBonusScore(score, 1)"
            >
              +
            </el-button>
            <el-input-number
              class="st-score-input"
              :model-value="Number(score)"
              :controls="false"
              :step="1"
              :min="TAG_BONUS_SCORE_HARD_MIN"
              :max="TAG_BONUS_SCORE_HARD_MAX"
              size="small"
              :class="Number(score) >= 0 ? 'st-score-pos' : 'st-score-neg'"
              @change="(v: number | undefined) => applyTagBonusScore(score, v)"
            />
            <el-button
              class="st-score-btn"
              size="small"
              text
              title="减小 1 分"
              @click="shiftTagBonusScore(score, -1)"
            >
              −
            </el-button>
            <!--
              删除分值档要**二次确认**

              点「删除分值档」后原地换成「确认删除？」+「确认 / 取消」按钮 ——
              这一档可能配了很多关键词，误点一次就全没了。
              确认前记在 `deletingScore` 里，所以同时只会有一档处于待确认状态。
            -->
            <template v-if="deletingScore === score">
              <span class="st-tier-del-ask">确认删除？</span>
              <!--
                确认 / 取消 用**实心按钮**（不带 `text`）
                
                踩过：原来加了 `text`（文字型按钮），`type="danger"` 只让**文字**变红，
                而面板底色是半透明玻璃、背后是视频画面 —— 红字常常糊在画面里看不清。
                实心按钮是"红底白字 / 蓝底白字"，对比度足够，不依赖背景。
              -->
              <el-button
                class="st-tier-del-confirm"
                size="small"
                type="danger"
                @click="confirmRemoveTagBonus(score)"
              >
                确认
              </el-button>
              <el-button
                class="st-tier-del-cancel"
                size="small"
                type="primary"
                @click="cancelRemoveTagBonus"
              >
                取消
              </el-button>
            </template>
            <el-button
              v-else
              class="st-tier-del"
              size="small"
              text
              @click="askRemoveTagBonus(score)"
            >
              删除分值档
            </el-button>
          </div>
          <!-- 第二行：关键词标签（标签多了自动换行） -->
          <div class="st-tier-tags">
            <el-tag
              v-for="(kw, i) in setting['player.tagBonus'][score] ?? []"
              :key="`tbk-${score}-${i}-${kw}`"
              closable
              size="small"
              :type="Number(score) >= 0 ? 'success' : 'danger'"
              @close="removeTagBonusKeyword(score, i)"
            >
              {{ kw }}
            </el-tag>
            <!-- 点 + 才出现输入框（同一个时间只有一个） -->
            <el-input
              v-if="tagInputs[score]?.visible"
              :model-value="tagInputs[score]?.text ?? ''"
              size="small"
              class="st-tag-input"
              placeholder="回车添加"
              autofocus
              @update:model-value="(v: string) => setTagInputText(score, v)"
              @keyup.enter="addTagBonusKeyword(score)"
              @blur="closeTagInput(score)"
            />
            <el-button v-else class="st-add" size="small" @click="openTagInput(score)">+</el-button>
          </div>
        </div>

        <!--
          ④ 过滤关键词（在加权**下面**）
          命中直接丢弃，所以和加权是两套 —— 界面上也分成两块。
        -->
        <div class="st-sub">
          过滤关键词
          <span class="st-desc">命中直接丢弃</span>
        </div>
        <div class="st-row st-row--tags">
          <div class="st-name">关键词</div>
          <div class="st-tags">
            <el-tag
              v-for="(kw, i) in setting['player.filterKeywords']"
              :key="`fk-${i}-${kw}`"
              closable
              size="small"
              @close="removeFilterKeyword(i)"
            >
              {{ kw }}
            </el-tag>
            <el-input
              v-if="filterInputVisible"
              v-model="newFilterKeyword"
              size="small"
              class="st-tag-input"
              placeholder="回车添加"
              autofocus
              @keyup.enter="addFilterKeyword"
              @blur="filterInputVisible = false"
            />
            <el-button v-else class="st-add" size="small" @click="openFilterInput">+</el-button>
          </div>
        </div>
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
  /** 搜索排序：时长容差与降级阈值的取值范围 */
  DURATION_TOLERANCE_MAX,
  DURATION_TOLERANCE_MIN,
  GLASS_BLUR_PERCENT_PER_PX,
  GLASS_BLUR_PERCENT_STEP,
  GLASS_SHADOW_PERCENT_PER_PX,
  GLASS_SHADOW_PERCENT_STEP,
  GLASS_TRANSPARENCY_MAX,
  GLASS_TRANSPARENCY_MIN,
  GLASS_TRANSPARENCY_STEP,
  /** 控制栏闲置透明度的范围与步进（0-100，**五步一进**） */
  IDLE_OPACITY_MAX,
  IDLE_OPACITY_MIN,
  IDLE_OPACITY_STEP,
  /** 关键词加权分值的输入框安全范围（很宽，防手滑） */
  TAG_BONUS_SCORE_HARD_MAX,
  TAG_BONUS_SCORE_HARD_MIN,
  MS_PER_DAY,
  MIN_SEARCH_RESULTS_MAX,
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
 * 左侧目录的分区
 *
 * ⚠️ 这些**不是 Tab**（不是切换页面），而是**锚点**：
 * 右边始终是完整的一页，点它只是滚到对应位置。
 * `key` 同时用作 `data-section` 的值，两边靠它对应。
 */
const TABS = [
  { key: 'player', label: '播放' },
  { key: 'ui', label: '界面' },
  { key: 'common', label: '通用' },
  { key: 'search', label: '搜索' },
] as const;

type TabKey = (typeof TABS)[number]['key']

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
      /** 控制栏闲置透明度：0-100，**五步一进** */
      IDLE_OPACITY_MIN,
      IDLE_OPACITY_MAX,
      IDLE_OPACITY_STEP,
      /** 关键词加权分值的输入框安全范围（很宽，防手滑） */
      TAG_BONUS_SCORE_HARD_MIN,
      TAG_BONUS_SCORE_HARD_MAX,
      /** 模糊强度 / 阴影强度：滑块是百分比（0-100%，5% 一档），存的却是 0-20px */
      GLASS_BLUR_PERCENT_STEP,
      GLASS_SHADOW_PERCENT_STEP,
      /** 搜索结果过期时间：界面按「天」，范围与步进都从常量来 */
      CACHE_EXPIRE_DAYS_MIN,
      CACHE_EXPIRE_DAYS_MAX,
      CACHE_EXPIRE_DAYS_STEP,
      /** 搜索排序：时长容差的范围 */
      DURATION_TOLERANCE_MIN,
      DURATION_TOLERANCE_MAX,
      MIN_SEARCH_RESULTS_MAX,
      /** 左侧目录常量（模板里 v-for 用） */
      TABS,
      /**
       * 当前高亮的分区
       *
       * ⚠️ 它跟着**滚动位置**走（见 `onContentScroll`），不是"最后点了谁" ——
       * 否则用户自己滚到「搜索」时左栏还停在「播放」，看着像坏了。
       */
      activeTab: 'player' as TabKey,
      /**
       * 点击目录后正在「程序化滚动」的标记
       *
       * 平滑滚动期间会连续触发 `scroll` 事件，若不加标记，
       * scroll spy 会一路把高亮改成途经的分区（点「搜索」会看到高亮
       * 从播放→界面→通用→搜索 扫过去，很乱）。滚动结束后自动清掉。
       */
      scrollingTo: false as boolean,
      /** 「等滚动停下」的 rAF 句柄（见 watchScrollSettle） */
      _settleRaf: 0 as number,
      /** 过滤关键词：输入框是否展开（点 + 才出现） */
      filterInputVisible: false,
      /** 过滤关键词输入框里正在打的字（回车才落到设置里） */
      newFilterKeyword: '',
      /**
       * 关键词加权：**每一档各自的输入框状态**
       *
       * 键是分值（字符串，与 `player.tagBonus` 的键一致），值是 `{ visible, text }`。
       * 用对象而不是「当前编辑哪一档」的单个变量：那样切档时上一档的半成品
       * 内容会丢，而用户很可能一边看一边改。
       */
      tagInputs: {} as Record<string, { visible: boolean; text: string }>,
      /** 新增分值档：输入框是否展开 */
      tierInputVisible: false,
      /** 新增分值档：输入的分值文本 */
      newTierText: '',
      /**
       * 正在等确认删除的分值档（`null` = 没有待确认的）
       *
       * 存的是分值字符串（`"5"` / `"-2"`），同一时间只会有一档处于待确认状态 ——
       * 点了别的档的「删除分值档」会把待确认的换成那一档。
       */
      deletingScore: null as string | null,
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
     * 关键词加权表的分值档（**按数值降序**）
     *
     * 排序是为了让界面上的标签有个稳定顺序 —— 直接用 `Object.keys` 的话，
     * 顺序取决于对象的插入顺序，用户改一次分值档位顺序就会跳。
     */
    tagBonusScores(): string[] {
      return Object.keys(this.setting['player.tagBonus'] ?? {}).sort(
        (a, b) => Number(b) - Number(a),
      );
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
      if (visible) {
        void this.refreshCacheStats();
        return;
      }
      /**
       * 关弹窗时把「滚动停止检测」停掉
       *
       * ⚠️ 这个组件是**常驻挂载**的（`v-model` 而不是 `v-if`），
       * 所以关弹窗不会触发 `beforeUnmount` —— 清理必须写在这里。
       *
       * `watchScrollSettle` 是个自我调度的 rAF 循环。用户点着左栏目录、
       * 滚动还没停就关掉弹窗时，循环里读的是已经隐藏的容器，
       * 虽然会自己跑到「连续 3 帧没变」而退出（不会真的泄漏），
       * 但 `scrollingTo` 会停在 `true` —— 下次打开时 scroll spy 被它挡住不工作。
       */
      if (this._settleRaf) window.cancelAnimationFrame(this._settleRaf);
      this._settleRaf = 0;
      this.scrollingTo = false;
    },
  },
  mounted() {
    if (this.modelValue) void this.refreshCacheStats();
  },
  beforeUnmount() {
    /** 组件真被销毁时（App 卸载）也兜一次，别留着 rAF */
    if (this._settleRaf) window.cancelAnimationFrame(this._settleRaf);
    this._settleRaf = 0;
  },
  methods: {

    /** 统一走 store 的 update（会由主进程广播回写，保证与其它窗口一致） */
    set<K extends keyof AppSetting>(key: K, value: AppSetting[K]): void {
      void this.store.update({ [key]: value } as Partial<AppSetting>);
    },

    // #region 左侧目录（滚动定位 + scroll spy）
    /**
     * 点目录 → 平滑滚到对应分区
     *
     * ⚠️ 这里**刻意不用 `scrollIntoView`**，而是手算 `scrollTop`。
     * （这段 JSDoc 以前写反了，说"用 scrollIntoView 而不是手算" —— 代码一直
     * 都是手算，注释才是错的。）
     *
     * 为什么不用 `scrollIntoView`：它会把**所有可滚祖先**都滚一遍 ——
     * 包括弹窗外面那层，结果整个对话框也跟着动，看着像页面在跳。
     * 手算 `scrollTop` 只动这一个容器，行为可预期。
     *
     * 至于"分区高度会变、手算的偏移量会过期"那个顾虑：这里不是缓存偏移量，
     * 而是**每次点击时现算**（`el.offsetTop - box.offsetTop`），
     * 所以标签换行、输入框展开都不会让它失准。
     */
    scrollToSection(key: TabKey): void {
      const box = this.$refs.content as HTMLElement | undefined;
      if (!box) return;
      const el = box.querySelector<HTMLElement>(`[data-section="${key}"]`);
      if (!el) return;
      /** 立刻点亮（不等滚动结束）—— 用户点了就该马上有反馈 */
      this.activeTab = key;
      this.scrollingTo = true;
      /** 现算目标位置（不缓存）：分区高度会随标签换行 / 输入框展开而变 */
      const top = el.offsetTop - box.offsetTop;
      box.scrollTo({ top, behavior: 'smooth' });
      this.watchScrollSettle(box);
    },
    /**
     * 等「滚动真的停下来」再解除 `scrollingTo`
     *
     * ## ⚠️ 为什么不能用固定定时器（我第一版就是那么写的）
     *
     * 平滑滚动的**时长取决于距离**（滚 100px 和滚 2000px 差很多），
     * 用一个写死的毫秒数必然两头不对：
     *  - 定太短（如 420ms）→ 长距离还没滚完就解锁，
     *    此时 scroll spy 会把高亮改成"途经的"分区 —— 用户点「搜索」会看到
     *    高亮一路从 播放→界面→通用→搜索 扫过去；
     *  - 定太长 → 用户点完立刻自己滚，高亮却不响应，像卡住了。
     *
     * ## ⚠️ 也不能只看「连续几帧没变」（第二版踩的坑）
     *
     * 平滑滚动**起步前**有几帧 `scrollTop` 是不动的（浏览器还没开始动画），
     * 于是"连续 3 帧没变"会被**误判成已经停下** → 提前解锁 →
     * 剩下的滚动就交给 scroll spy 了（实测：点「界面」只滚了 24px 就解锁，
     * 高亮被改回「播放」）。
     *
     * 所以加一条前置条件：**必须先观察到"动过"**，或者等够一个保守帧数
     * （防止目标就是当前位置、压根不会动的情况）。
     */
    watchScrollSettle(box: HTMLElement): void {
      if (this._settleRaf) window.cancelAnimationFrame(this._settleRaf);
      const start = box.scrollTop;
      let last = start;
      let still = 0;
      let frames = 0;
      let moved = false;
      const tick = (): void => {
        frames++;
        const cur = box.scrollTop;
        if (cur !== start) moved = true;
        if (cur === last) {
          still++;
          /**
           * 停下的判据：连续 3 帧没变，**且**「已经动过 或 等够了 15 帧」。
           * 15 帧 ≈ 250ms，足够覆盖平滑滚动的起步延迟。
           */
          if (still >= 3 && (moved || frames >= 15)) {
            this.scrollingTo = false;
            this._settleRaf = 0;
            return;
          }
        } else {
          still = 0;
          last = cur;
        }
        this._settleRaf = window.requestAnimationFrame(tick);
      };
      this._settleRaf = window.requestAnimationFrame(tick);
    },
    /**
     * 内容区滚动 → 反向高亮左栏（scroll spy）
     *
     * 判据：**最后一个「顶部已经滚过内容区上沿」的分区**。
     * 用「上沿」而不是「中心」是因为分区高度差别很大（搜索那栏很长），
     * 按中心判会在长分区里长时间显示错的高亮。
     */
    onContentScroll(): void {
      /** 程序化滚动期间不抢高亮（见 `scrollingTo` 的说明） */
      if (this.scrollingTo) return;
      const box = this.$refs.content as HTMLElement | undefined;
      if (!box) return;
      /**
       * 留 8px 余量：分区标题刚好贴着上沿时也算「已经到这一区」，
       * 否则滚到标题处高亮还停在上一个分区，差一点点很别扭。
       */
      const y = box.scrollTop + 8;
      let current: TabKey = TABS[0].key;
      for (const tab of TABS) {
        const el = box.querySelector<HTMLElement>(`[data-section="${tab.key}"]`);
        if (!el) continue;
        if (el.offsetTop - box.offsetTop <= y) current = tab.key;
      }
      /**
       * 滚到底时**强制点亮最后一个分区**
       *
       * 因为最后一个分区可能不够高，永远滚不到它的上沿（内容已经到底了），
       * 于是高亮会卡在倒数第二个 —— 用户滚到底却看到高亮在上一栏，很怪。
       */
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      if (atBottom) current = TABS[TABS.length - 1].key;
      this.activeTab = current;
    },
    // #endregion

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
        | 'player.autoDowngradeOnStall'
        | 'common.wallpaperMode'
        | 'common.autoLaunch'
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
     * 控制栏闲置透明度
     *
     * 与其它滑块一样过 `snapSlider`：`el-slider` 在某些交互下会给出
     * 不在步进上的值（拖动 + 键盘微调），统一夹一次能保证存进去的总是整步。
     * 这里步进是 **5**（0-100 五步一进），所以存进去的会是 0/5/10/…/100。
     */
    setIdleOpacity(v: number | number[]): void {
      this.set(
        'common.idleOpacity',
        snapSlider(v, IDLE_OPACITY_MIN, IDLE_OPACITY_MAX, IDLE_OPACITY_STEP),
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
    /**
     * 数值类设置（搜索排序用的两个）
     *
     * 落盘前夹紧到合法范围：`el-input-number` 自己会夹，但用户手输时
     * （清空、只留一位、粘贴一个大数）回调可能给 `undefined` 或越界值。
     */
    setNumber(
      key: 'player.durationToleranceSec' | 'player.minSearchResults',
      v: number | undefined,
    ): void {
      const n = Math.round(Number(v) || 0);
      /** 降级阈值允许 0（= 从不降级），容差不允许 —— 0 容差等于把 MV 全砍掉 */
      const min = key === 'player.minSearchResults' ? 0 : DURATION_TOLERANCE_MIN;
      const max = key === 'player.minSearchResults' ? MIN_SEARCH_RESULTS_MAX : DURATION_TOLERANCE_MAX;
      this.set(key, Math.min(max, Math.max(min, n)));
    },
    /**
     * 展开过滤关键词的输入框（点 `+` 才出现）
     *
     * 为什么不像原来那样**常显**输入框：一屏里有两处关键词（加权 + 过滤），
     * 每处都挂一个空输入框会让界面看起来很吵，而且用户多数时候是「来删词」不是「来加词」。
     * 点 `+` 展开、回车提交、失焦收起 —— 和 `el-tag` 的交互是同一套。
     */
    openFilterInput(): void {
      this.newFilterKeyword = '';
      this.filterInputVisible = true;
    },
    /**
     * 加一个过滤关键词
     *
     * 去重是必要的：重复词不会出错（`includes` 判断），但界面上会显示两个一样的标签，
     * 用户会以为没加进去又点一次。
     */
    addFilterKeyword(): void {
      const kw = this.newFilterKeyword.trim();
      if (!kw) {
        this.filterInputVisible = false;
        return;
      }
      const list = [...(this.setting['player.filterKeywords'] ?? [])];
      /**
       * 去重按**归一化后**比较（小写、去空格）—— 用户输入「吉他谱」和「吉他谱 」
       * 应该算同一个词，而 `includes` 判断本来就是归一化的，存两份没意义。
       */
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
      if (!list.some((x) => norm(x) === norm(kw))) {
        list.push(kw);
        this.set('player.filterKeywords', list);
      }
      this.newFilterKeyword = '';
      this.filterInputVisible = false;
    },
    removeFilterKeyword(index: number): void {
      const list = [...(this.setting['player.filterKeywords'] ?? [])];
      list.splice(index, 1);
      this.set('player.filterKeywords', list);
    },

    // #region 关键词加权（每一档各自一个标签列表 + 各自的输入框）

    /*
     * 注意这里**没有** `tierKeywords(score)`（已删的死方法）。
     *
     * 它原来「读某一档的关键词数组、拿不到给空数组」，但**从未被调用** ——
     * 模板里直接读的是 `tagBonusScores`（带分值的有序数组），
     * 每个档位的词由 `setting['player.tagBonus']?.[score]` 就地取用，
     * 不需要再经一层包装。
     */

    /** 展开某一档的输入框 */
    openTagInput(score: string): void {
      this.tagInputs = { ...this.tagInputs, [score]: { visible: true, text: '' } };
    },
    setTagInputText(score: string, text: string): void {
      this.tagInputs = { ...this.tagInputs, [score]: { visible: true, text } };
    },
    closeTagInput(score: string): void {
      const cur = this.tagInputs[score];
      if (!cur) return;
      this.tagInputs = { ...this.tagInputs, [score]: { visible: false, text: '' } };
    },
    /**
     * 给某一档加一个关键词
     *
     * ## ⚠️ 整个对象必须换新引用再落盘
     *
     * `updateSetting` 对嵌套对象是**整体替换**语义（见 `main/utils/setting.ts`）：
     * 原地改 `this.setting['player.tagBonus'][score]` 不会触发写入 ——
     * 引用没变，主进程那边的深比较也看不出差异，表现就是「改了没反应」。
     */
    addTagBonusKeyword(score: string): void {
      const text = (this.tagInputs[score]?.text ?? '').trim();
      const next = { ...(this.setting['player.tagBonus'] ?? {}) };
      const list = [...(next[score] ?? [])];
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
      if (text && !list.some((x) => norm(x) === norm(text))) {
        list.push(text);
        next[score] = list;
        this.set('player.tagBonus', next);
      }
      this.closeTagInput(score);
    },
    removeTagBonusKeyword(score: string, index: number): void {
      const next = { ...(this.setting['player.tagBonus'] ?? {}) };
      const list = [...(next[score] ?? [])];
      list.splice(index, 1);
      next[score] = list;
      this.set('player.tagBonus', next);
    },
    /** 展开「新增分值档」输入框 */
    openTierInput(): void {
      this.newTierText = '';
      this.tierInputVisible = true;
    },
    cancelTierInput(): void {
      this.tierInputVisible = false;
      this.newTierText = '';
    },
    /**
     * 新增一个分值档（如 `-8`）
     *
     * 校验：必须是整数、不能是已存在的档。
     *
     * ⚠️ **没有分值范围限制**（这里去掉过）—— 关键词加权现在不再被 clamp，
     * 用户想给「伴奏」配 `-50` 是完全合理的（比 `-4` 档更重地压下去）。
     * 早先限制 ±10 是因为打分侧会把加权夹在 ±10 内，超出无意义；
     * 那个 clamp 已经取消了，所以这里的限制也一起去掉。
     */
    addTier(): void {
      const raw = this.newTierText.trim();
      const n = Number(raw);
      if (!raw || !Number.isFinite(n) || !Number.isInteger(n)) {
        ElMessage.warning('请输入一个整数分值，例如 -5');
        return;
      }
      const key = String(n);
      const next = { ...(this.setting['player.tagBonus'] ?? {}) };
      if (key in next) {
        ElMessage.warning(`分值 ${key} 已经存在了`);
        return;
      }
      next[key] = [];
      this.set('player.tagBonus', next);
      this.cancelTierInput();
    },
    /**
     * 把一整档分值**加 1 / 减 1**（←/→ 按钮或键盘左右箭头）
     *
     * ## 为什么要改键名而不是改数值
     *
     * `player.tagBonus` 的**键就是分值**（`{ "5": [...], "-2": [...] }`），
     * 所以「把 +5 档改成 +6」= 把键 `"5"` 换成 `"6"`，**关键词跟着搬过去**。
     *
     * ## 撞到已存在的档就不动
     *
     * 已经有 `+6` 档时再按 →，两档会**合并**（关键词全并进 +6）——
     * 那是**丢信息**的（用户本来分了两档不同权重）。这里直接拒绝并提示，
     * 让他先删掉或改名，比悄悄合并不知不觉改变打分结果安全。
     *
     * @param score 当前分值（字符串键）
     * @param delta `+1` 或 `-1`
     */
    /**
     * 直接设成某个分值（数字输入框用）
     *
     * 和 `shiftTagBonusScore` 是**同一条换键逻辑**：`player.tagBonus` 的**键就是分值**，
     * 所以「把 +5 改成 +6」= 把键 `"5"` 换成 `"6"`，关键词跟着搬过去。
     *
     * 与增量版的区别只是「目标值怎么来」：这里来自输入框，可能是任意整数。
     *
     * @param score 当前分值（字符串键）
     * @param value 输入框给的新值（`undefined` = 清空了，直接忽略，等它失焦时再夹）
     */
    applyTagBonusScore(score: string, value: number | undefined): void {
      if (value == null) return;
      const from = Number(score);
      const to = Math.round(Number(value));
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      const toKey = String(to);
      /** 没变就什么都不做（否则每次失焦都会重建一次对象） */
      if (toKey === score) return;
      const next = { ...(this.setting['player.tagBonus'] ?? {}) };
      if (toKey in next) {
        ElMessage.warning(`已经有 ${to > 0 ? '+' : ''}${to} 这一档了`);
        return;
      }
      /** 保持键顺序：新键放在**原位置**，否则这一档会跳到最后一行 */
      const rebuilt: Record<string, string[]> = {};
      for (const key of this.tagBonusScores) {
        if (key === score) rebuilt[toKey] = next[score] ?? [];
        else rebuilt[key] = next[key] ?? [];
      }
      this.set('player.tagBonus', rebuilt);
      /** 输入框的临时状态也跟着搬（否则正在输的那半截字会丢） */
      if (this.tagInputs[score]) {
        const moved = { ...this.tagInputs };
        moved[toKey] = moved[score];
        delete moved[score];
        this.tagInputs = moved;
      }
    },
    /**
     * 分值调节：`−` 减 1 / `+` 加 1
     *
     * 撞到已存在的档就不动并提示 —— 悄悄合并会**丢信息**
     * （用户本来分了两档不同权重），让他先删掉或改名，
     * 比悄悄合并不知不觉改变打分结果安全。
     *
     * @param score 当前分值（字符串键）
     * @param delta `+1` 或 `-1`
     */
    shiftTagBonusScore(score: string, delta: number): void {
      const from = Number(score);
      if (!Number.isFinite(from)) return;
      const to = from + delta;
      const toKey = String(to);
      if (toKey === score) return;
      const next = { ...(this.setting['player.tagBonus'] ?? {}) };
      if (toKey in next) {
        ElMessage.warning(`已经有 ${to > 0 ? '+' : ''}${to} 这一档了`);
        return;
      }
      /**
       * 重建对象时要**保持键的顺序**（`tagBonusScores` 依赖键序）
       *
       * 直接把新键塞到最后会让这一档在界面上**跳到最后一行** ——
       * 用户按一下 → 就往下一行跳，很别扭。
       * 所以按当前显示顺序重建，把新键放在**原位置**。
       */
      const rebuilt: Record<string, string[]> = {};
      for (const key of this.tagBonusScores) {
        if (key === score) rebuilt[toKey] = next[score] ?? [];
        else rebuilt[key] = next[key] ?? [];
      }
      this.set('player.tagBonus', rebuilt);

      /** 输入框的临时状态也跟着搬（否则用户正在输的那半截字会丢） */
      if (this.tagInputs[score]) {
        const moved = { ...this.tagInputs };
        moved[toKey] = moved[score];
        delete moved[score];
        this.tagInputs = moved;
      }
    },
    /**
     * 点「删除分值档」→ 先进入待确认状态（不真删）
     *
     * 那一行会原地换成「确认 / 取消」。之所以要二次确认：
     * 一档可能配了很多关键词，误点一次就全没了，而且没有撤销。
     */
    askRemoveTagBonus(score: string): void {
      this.deletingScore = score;
    },
    /** 取消删除：只退出待确认状态 */
    cancelRemoveTagBonus(): void {
      this.deletingScore = null;
    },
    /** 确认删除：真删，并清掉待确认状态 */
    confirmRemoveTagBonus(score: string): void {
      this.removeTagBonus(score);
      this.deletingScore = null;
    },
    /** 删掉一整档分值（连同它的关键词） */
    removeTagBonus(score: string): void {
      const next = { ...(this.setting['player.tagBonus'] ?? {}) };
      delete next[score];
      this.set('player.tagBonus', next);
      /**
       * 顺手清掉这一档的输入框状态
       *
       * `tagInputs` 是按分值键的对象，删档后那个键就没人再读了 ——
       * 不清的话它会一直留着（虽然只有几十字节，但属于「删了还在」的那种脏状态，
       * 而且如果用户再加一个同分值的档，会看到上次残留的半成品文字）。
       */
      if (this.tagInputs[score]) {
        const cleaned = { ...this.tagInputs };
        delete cleaned[score];
        this.tagInputs = cleaned;
      }
    },
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
/*
 * 主体：左侧目录 + 右侧一页到底
 *
 * ## ⚠️ 为什么必须显式写 `overflow-x: hidden`（修掉横向滚动条）
 *
 * 只写 `overflow-y: auto` 是**不够**的：按 CSS 规范，当 `overflow-y` 是 `auto`
 * 而 `overflow-x` 还是默认的 `visible` 时，浏览器会把 `overflow-x` **计算成 `auto`**
 * （不能出现"一个方向滚动、另一个方向溢出到外面"的组合）。
 * 于是只要有任何一个子元素比容器宽（长标签、`white-space: nowrap` 的说明文字），
 * 底部就会冒出一条横向滚动条。
 *
 * ## ⚠️ 滚动条挂在 `.st-content` 上，不是 `.st-body`
 *
 * 因为左栏要**跟着内容滚**吗？不是 —— 左栏要**固定**（它是指南针）。
 * 所以滚动容器是右边那一栏，左栏在容器外，天然不跟着滚。
 * 这也顺带解决了一个问题：滚动条不会压在左栏旁边，视觉上"不分家"。
 */
.st-body {
  display: flex;
  /* 左栏和内容之间只留间距，**没有分隔线**（用户要的是"分栏不分家"） */
  gap: 6px;
  height: 62vh;
}
/* 左侧目录 */
.st-nav {
  flex: none;
  width: 76px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 顶部留一点，和右边第一个分组标题对齐 */
  padding-top: 2px;
}
.st-nav-item {
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  /* 未选中时淡一点，选中项才突出 */
  opacity: 0.6;
  transition: background-color 0.15s ease, opacity 0.15s ease;
  user-select: none;
}
.st-nav-item:hover {
  background: rgba(255, 255, 255, 0.08);
  opacity: 1;
}
.st-nav-item.is-active {
  background: rgba(255, 255, 255, 0.14);
  opacity: 1;
  font-weight: 500;
}
/*
 * 右侧内容：**滚动容器**
 *
 * `min-width: 0` 让它能被压缩（flex 子项默认 `min-width: auto` 会拒绝收缩，
 * 长内容就会顶宽整个弹窗，那是横向溢出的另一半原因）。
 */
.st-content {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  /* 给滚动条留一点空隙，免得贴着文字 */
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
/*
 * 分组内的小标题（「关键词加权」「过滤关键词」）
 *
 * 比 `st-group-title` 低一级：它是**同一页里的子块**，不该和分类标题抢视觉层级。
 */
.st-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 2px;
  padding-left: 2px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
}
/*
 * 小标题行：**标题靠左、按钮靠右**
 *
 * 「关键词加权」这一行原来是「标题 + 说明 + 按钮」挤在一起，
 * 按钮位置随文字长度漂移。改成两端对齐后按钮固定在右边。
 * （说明文字「歌手名命中 +100…」按用户要求去掉了。）
 *
 * 并且**下面加一条细线**，把「关键词加权」这块和上面的搜索项分开 ——
 * 这条线比普通设置项之间的线**更细**，视觉上属于"次级分隔"。
 */
.st-sub--split {
  justify-content: space-between;
  margin-bottom: 0;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--panel-divider-fine);
}
.st-sub-title {
  flex: none;
}
/*
 * 一档分值 = 两行
 *
 *   第一行：`[+] [分值] [−]` ……………… 「- 删除分值档」（推最右）
 *   第二行：关键词标签…（+ 添加）
 *
 * 拆成两行是因为原来「分值 + 标签 + 删除」全挤一行，
 * 标签一多就换行错位，删除按钮还会跟着标签跑。
 */
.st-tier {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 2px;
  /* 和「关键词加权」下面那条**同一套细线**（两级都用 fine，比 st-row 淡） */
  border-bottom: 1px solid var(--panel-divider-fine);
}
.st-tier:last-child {
  border-bottom: none;
}
/* 第一行：分值调节靠左，删除推到最右 */
.st-tier-head {
  display: flex;
  align-items: center;
  gap: 2px;
}
.st-tier-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: 2px;
}
/* 「- 删除分值档」推到最右，和分值调节拉开距离，避免误点 */
.st-tier-del {
  margin-left: auto;
  opacity: 0.65;
}
.st-tier-del:hover {
  opacity: 1;
}
/*
 * 待确认删除时的提示文字「确认删除？」
 *
 * 它承担 `margin-left: auto` —— 把「提示 + 确认 + 取消」整组推到最右，
 * 和平时「删除分值档」的位置一致（不然提示会把按钮挤到左边去）。
 */
/* 待确认删除时的提示文字「确认删除？」：只推右 + 字号，**不设颜色**（跟面板文字走） */
.st-tier-del-ask {
  margin-left: auto;
  font-size: 12px;
  opacity: 0.9;
}
/*
 * 「确认」/「取消」：**用实心按钮，颜色交给 Element Plus**
 *
 * 只给间距和紧凑内边距，**不覆盖 color / background / border-color** ——
 * `type="danger"` / `type="primary"` 自带红/蓝底 + 对应的前景色，
 * 手动写 `color: #fff` 反而会和主题（`html.dark`）打架。
 */
.st-tier-del-confirm {
  margin-left: 4px;
  padding: 0 8px !important;
}
.st-tier-del-cancel {
  margin-left: 6px;
  padding: 0 8px !important;
}
.st-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 2px;
  /*
   * 普通设置项之间的线**加粗**
   *
   * 比「关键词加权」下面那条（`--panel-divider-fine`）更明显，
   * 形成「设置项之间 > 子块内部」的层级。
   */
  border-bottom: 2px solid var(--panel-divider);
}
/*
 * 滑块行（透明度 / 闲置透明度 / 模糊 / 阴影）的线**要更细**
 *
 * 这几行是**同一类参数的连续小项**，行高又矮，2px 的线在它们之间会显得很重。
 * 用 `--panel-divider-fine` 让它们看起来是"一组"，而不是四个独立设置。
 */
.st-row--slider {
  border-bottom-width: 1px;
  border-bottom-color: var(--panel-divider-fine);
}
/* 标签行要**顶对齐**：标签可能换行，居中会让左标题浮在中间很怪 */
.st-row--tags {
  align-items: flex-start;
}
.st-row:last-child {
  border-bottom: none;
}
.st-name {
  font-size: 13px;
  flex: none;
}
/* 分值 + 删除按钮横排的那一列（已废弃：分值行和标签行已拆成两行） */
/*
 * 分值输入框
 *
 * 中间是**数字输入框**（可直接打字改成任意分值，比如 -50），
 * 两边 `+` / `−` 微调。正负用颜色区分（绿 = 加分、红 = 减分），
 * 和原来的 `.st-score-pos` / `.st-score-neg` 同一套色值。
 */
.st-score-input {
  width: 62px;
}
.st-score-input :deep(.el-input__inner) {
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 600;
}
/* 正负色要作用到内层 input 上（scoped 下够不到子组件内部） */
.st-score-input.st-score-pos :deep(.el-input__inner) {
  color: #67c23a;
}
.st-score-input.st-score-neg :deep(.el-input__inner) {
  color: #f56c6c;
}
/*
 * ←/→ 加减分按钮
 *
 * 用 `text` 型按钮（无边框）＋ 紧凑内边距，让它像一个可点的箭头而不是"按钮"——
 * 这一列已经有「删除」，三个按钮都做成方块会很挤。
 */
.st-score-btn {
  padding: 0 2px !important;
  min-width: 16px !important;
  font-size: 13px;
  line-height: 1;
  opacity: 0.7;
}
.st-score-btn:hover {
  opacity: 1;
}
.st-score-pos {
  color: #67c23a;
  font-variant-numeric: tabular-nums;
}
.st-score-neg {
  color: #f56c6c;
  font-variant-numeric: tabular-nums;
}
/*
 * 说明文字
 *
 * 去掉 `white-space: nowrap`：那是横向溢出的主要来源之一
 * （「秒（MV / Live 自动放宽）」这类文字一长就把行顶宽）。
 */
.st-desc {
  font-size: 11px;
  opacity: 0.55;
}
.st-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 允许收缩：否则输入框 + 说明文字的固定宽度会把行撑破 */
  flex: 1;
  min-width: 0;
  justify-content: flex-end;
}
/*
 * 标签容器：**自动换行**
 *
 * 这是修掉横向滚动条的关键 —— 标签多了就往下排，而不是一直往右顶。
 */
.st-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
/* 标签添加输入框：窄一点，免得占满整行 */
.st-tag-input {
  width: 100px;
}
/* 「+」按钮：做成小方块，和标签同一视觉重量 */
.st-add {
  width: 24px;
  padding: 0;
  font-size: 14px;
  line-height: 1;
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
