/**
 * 把界面颜色 / 毛玻璃参数写到文档根节点上
 *
 * 做法是「CSS 变量 + data 属性」，组件里的颜色全部引用令牌
 * （见 App.vue 里的 `--glass-*` / `--panel-*`），
 * 这样调颜色不需要在每个组件里写一套 if。
 *
 * 写进去的三类东西：
 *  1. 颜色：玻璃底色 `--glass-rgb`、文字色 `--text-rgb`（都写成 `r, g, b`，
 *     具体透明度由 CSS 里的 `rgba(var(--glass-rgb), var(--glass-alpha))` 组合）；
 *  2. 毛玻璃：`--glass-alpha` / `--glass-alpha-strong` / `--glass-blur` / `--glass-shadow-size`；
 *  3. 深浅：按玻璃底色的亮度决定 `data-tint`（决定阴影用黑还是白）
 *     和 `html.dark`（Element Plus 的暗色，弹窗里的输入框、下拉都跟它走）。
 *
 * 两个毛玻璃参数的换算：
 *  - 透明度（0-100）就是底色里的 alpha，所以 `--glass-alpha = 透明度 / 100`（30 -> 0.3）；
 *  - 模糊强度（0-20）是 `backdrop-filter: blur(Npx)` 的 N，直接写 `--glass-blur: Npx`；
 *  - 阴影强度（0-20）是文字阴影的模糊半径，写进 `--glass-shadow-size`，
 *    CSS 里用 `calc()` 派生出「小一号的近影 + 大一号的远影」。
 */
import {
  COLOR_HEX_PATTERN,
  DARK_TINT_LUMINANCE,
  DEFAULT_FONT_COLOR,
  DEFAULT_IDLE_OPACITY,
  DEFAULT_THEME_COLOR,
  GLASS_BLUR_MAX,
  GLASS_BLUR_MIN,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  GLASS_SHADOW_MAX,
  GLASS_SHADOW_MIN,
  IDLE_OPACITY_MAX,
  IDLE_OPACITY_MIN,
} from '@common/constants';

/** 与 defaultSetting 里的 `common.glassTransparency` 对齐 */
const DEFAULT_TRANSPARENCY = 30;
/** 与 defaultSetting 里的 `common.glassBlur` 对齐 */
const DEFAULT_BLUR = 10;
/** 与 defaultSetting 里的 `common.glassShadow` 对齐 */
const DEFAULT_SHADOW = 8;
/** 悬停 / 展开态比常态实多少 */
const STRONG_DELTA = 0.12;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * `#RGB` / `#RRGGBB` -> 三个通道
 *
 * 认不出来就返回 null（设置里的值来自输入框 / 取色器，不能假设它一定合法）。
 */
export const parseHexColor = (value: unknown): Rgb | null => {
  if (typeof value !== 'string') return null;
  const hex = value.trim();
  if (!COLOR_HEX_PATTERN.test(hex)) return null;
  const body = hex.slice(1);
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
};

/** 相对亮度（0-1）：决定「深底还是浅底」 */
const luminance = ({ r, g, b }: Rgb): number => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

export interface UiThemeInput {
  'common.themeColor'?: string;
  'common.fontColor'?: string;
  'common.glassTransparency'?: number;
  'common.idleOpacity'?: number;
  'common.glassBlur'?: number;
  'common.glassShadow'?: number;
  /** 界面字号缩放（百分比，-50 ~ 50） */
  'ui.fontScale'?: number;
}

export const applyUiTheme = (input: UiThemeInput): void => {
  const root = document.documentElement;

  // ---- 颜色 ----
  const tint = parseHexColor(input['common.themeColor']) ?? parseHexColor(DEFAULT_THEME_COLOR)!;
  const text = parseHexColor(input['common.fontColor']) ?? parseHexColor(DEFAULT_FONT_COLOR)!;
  root.style.setProperty('--glass-rgb', `${tint.r}, ${tint.g}, ${tint.b}`);
  root.style.setProperty('--text-rgb', `${text.r}, ${text.g}, ${text.b}`);

  // ---- 毛玻璃 ----
  const pct = Number(input['common.glassTransparency']);
  const alpha =
    (Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : DEFAULT_TRANSPARENCY) / 100;
  root.style.setProperty('--glass-alpha', alpha.toFixed(2));
  root.style.setProperty('--glass-alpha-strong', Math.min(1, alpha + STRONG_DELTA).toFixed(2));

  /**
   * 闲置透明度：**存的是百分比（0-100），写进去的是 0-1 的小数**
   *
   * 和 `--glass-alpha` 一样要除 100（CSS 的 `opacity` 收小数）。
   * 悬停时 CSS 直接写死 `opacity: 1`（见 VideoControls.vue），所以这里只管闲置态。
   */
  const idlePct = Number(input['common.idleOpacity']);
  const idle =
    (Number.isFinite(idlePct)
      ? Math.min(IDLE_OPACITY_MAX, Math.max(IDLE_OPACITY_MIN, idlePct))
      : DEFAULT_IDLE_OPACITY) / 100;
  root.style.setProperty('--ui-idle-opacity', idle.toFixed(2));

  const px = Number(input['common.glassBlur']);
  const radius = Number.isFinite(px)
    ? Math.min(GLASS_BLUR_MAX, Math.max(GLASS_BLUR_MIN, px))
    : DEFAULT_BLUR;
  root.style.setProperty('--glass-blur', `${Math.round(radius)}px`);

  const shadow = Number(input['common.glassShadow']);
  const shadowSize = Number.isFinite(shadow)
    ? Math.min(GLASS_SHADOW_MAX, Math.max(GLASS_SHADOW_MIN, shadow))
    : DEFAULT_SHADOW;
  root.style.setProperty('--glass-shadow-size', `${Math.round(shadowSize)}px`);

  /**
   * 界面字号缩放
   *
   * 存的是百分比（0 / ±10 / ±50），写进去的是倍率（1 / 1.1 / 1.5）——
   * CSS 里每处字号是 `calc(13px * var(--fs))`，乘的是无单位数字。
   * 托盘菜单是独立页面（`tray-menu.html`），不读这个变量，所以不受影响。
   */
  const fontPct = Number(input['ui.fontScale'])
  const fontScale = Number.isFinite(fontPct)
    ? Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, fontPct))
    : 0
  root.style.setProperty('--fs', (1 + fontScale / 100).toFixed(2));

  // ---- 深浅 ----
  // 底色偏暗 -> 白阴影 + Element Plus 暗色；偏亮 -> 黑阴影 + 亮色
  const dark = luminance(tint) < DARK_TINT_LUMINANCE;
  root.setAttribute('data-tint', dark ? 'dark' : 'light');
  root.classList.toggle('dark', dark);
};

/**
 * 从配置对象里取界面相关字段并应用
 *
 * 单独抽出来是为了让 main.ts 的 watch 和首次加载共用同一段逻辑。
 */
export const applyUiThemeFromSetting = (setting: UiThemeInput): void => {
  applyUiTheme(setting);
};
