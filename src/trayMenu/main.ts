/**
 * 自绘托盘菜单（菜单窗口的页面）
 *
 * 它其实是个**迷你控制台**：
 *
 *   歌名 - 歌手名
 *   ──────────── 进度条 ────────────
 *   已播时长 / 视频时长
 *   [音量(悬停出条)] [上一首] [播放/暂停] [下一首] [模式切换]
 *   ────────────
 *   设置歌单 / 壁纸模式·窗口模式 / 退出登录 / 退出程序
 *
 * 为什么不用原生 `Menu.popup`：壁纸模式下窗口嵌在桌面层、界面按钮又都隐藏了，
 * 原生菜单在那种环境里点不动（详见 ARCHITECTURE 里那段 `RIDEV_INPUTSINK` 的分析）。
 * 这个页面跑在独立置顶窗口里，收的是真实鼠标消息。
 *
 * 渲染流程：主进程 `trayMenu:state` 推状态 → 渲染 → 量高度回报 `trayMenu:ready`
 * → 主进程按高度定位并显示。拖动进度条 / 音量条时**不重建 DOM**，只改样式，
 * 否则拖到一半元素被换掉会中断拖拽。
 */
import type { TrayMenuAction, TrayMenuState } from '@common/types/ipc'
import api from '@/api/electron'
// 控制按钮用的是和控制栏同一套 iconfont（不引这份 CSS 图标会全空）
import '@/assets/iconfont/iconfont.css'

const root = document.getElementById('menu') as HTMLElement

const pad = (n: number): string => String(Math.floor(n)).padStart(2, '0')
const formatTime = (sec: number): string => {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0
  return `${pad(s / 60)}:${pad(s % 60)}`
}

// #region DOM（一次建好，之后只更新，别在拖拽中重建）

const titleEl = document.createElement('div')
titleEl.className = 'now'

/** 进度条 */
const seekWrap = document.createElement('div')
seekWrap.className = 'seek'
const seekTrack = document.createElement('div')
seekTrack.className = 'seek-track'
const seekFill = document.createElement('div')
seekFill.className = 'seek-fill'
const seekThumb = document.createElement('div')
seekThumb.className = 'seek-thumb'
seekTrack.appendChild(seekFill)
seekTrack.appendChild(seekThumb)
seekWrap.appendChild(seekTrack)

/** 时间：左边已播、右边总长（flex 两端对齐，中间不加分隔符） */
const timeEl = document.createElement('div')
timeEl.className = 'time'
const timeCur = document.createElement('span')
timeCur.className = 't-cur'
const timeTotal = document.createElement('span')
timeTotal.className = 't-total'
timeEl.append(timeCur, timeTotal)

/** 控制按钮那一行 */
const controlsEl = document.createElement('div')
controlsEl.className = 'controls'

/** 音量：按钮 + 悬停出现的横条（左边还有音量数字） */
const volumeWrap = document.createElement('div')
volumeWrap.className = 'volume'
const volumeBtn = document.createElement('i')
volumeBtn.className = 'iconfont icon-sound-on'
const volumePop = document.createElement('div')
volumePop.className = 'volume-pop'
/** 音量数字：放在条左边 */
const volumeNum = document.createElement('span')
volumeNum.className = 'volume-num'
const volumeTrack = document.createElement('div')
volumeTrack.className = 'volume-track'
const volumeFill = document.createElement('div')
volumeFill.className = 'volume-fill'
const volumeThumb = document.createElement('div')
volumeThumb.className = 'volume-thumb'
volumeTrack.appendChild(volumeFill)
volumeTrack.appendChild(volumeThumb)
volumePop.appendChild(volumeNum)
volumePop.appendChild(volumeTrack)
volumeWrap.appendChild(volumePop)
volumeWrap.appendChild(volumeBtn)

/** 上一首 / 播放暂停 / 下一首 / 模式 */
const prevBtn = document.createElement('i')
prevBtn.className = 'iconfont icon-1_music83'
const playBtn = document.createElement('i')
playBtn.className = 'iconfont icon-play'
const nextBtn = document.createElement('i')
nextBtn.className = 'iconfont icon-1_music82'
const modeBtn = document.createElement('i')
modeBtn.className = 'iconfont icon-liebiaoxunhuan'

for (const el of [volumeWrap, prevBtn, playBtn, nextBtn, modeBtn]) {
  controlsEl.appendChild(el)
}

/** 下面那几项（设置歌单 / 壁纸模式 / 退出登录 / 退出程序） */
const listEl = document.createElement('div')
listEl.className = 'list'

root.append(titleEl, seekWrap, timeEl, controlsEl, listEl)

// #endregion

// #region 下面那几项（文案按状态变）

interface Item {
  action: TrayMenuAction | ((s: TrayMenuState) => TrayMenuAction)
  label: (s: TrayMenuState) => string
  danger?: boolean
}

const ITEMS: Item[] = [
  { action: 'showPlaylist', label: () => '设置歌单' },
  {
    // 窗口被收到托盘里时，这一项换成「恢复窗口」（动作也跟着换）
    action: (s) => (s.windowHidden ? 'restoreWindow' : 'toggleWallpaper'),
    label: (s) => (s.windowHidden ? '恢复窗口' : s.wallpaperEnabled ? '窗口模式' : '壁纸模式'),
  },
  {
    /**
     * 登录 / 退出登录
     *
     * 动作**必须跟着状态走**：以前这里是写死的 `'login'`，文案却随登录态变成「退出登录」，
     * 于是点「退出登录」发的还是 login —— 打开登录窗口，用户看到的就是「点了又登录上了」。
     */
    action: (s) => (s.isLoggedIn ? 'logout' : 'login'),
    label: (s) => (s.isLoggedIn ? '退出登录' : '登录'),
  },
  { action: 'quit', label: () => '退出程序', danger: true },
]

/**
 * 列表**只在启动时建一次**，之后只改文案
 *
 * 菜单开着时进度条会每 300ms 推一次状态；如果每次重建这几个 div，
 * 用户按下和抬起之间元素被换掉，`mouseup` 就落不到同一个元素上（点不动）。
 * 每个元素自己记住当前动作，只有文案随状态变。
 */
/**
 * 统一包一层失败处理
 *
 * 托盘菜单页里所有调用都是「发出去就不管」的：主进程 handler 一旦抛错，
 * 渲染侧就是未处理的 promise rejection —— 而动作的前半段（收起菜单）已经执行了，
 * 用户看到的是「点了没反应」，也没有任何地方能看出失败。
 */
const run = (action: TrayMenuAction, value?: number): void => {
  api.trayMenuAction(action, value).catch((err) => {
    console.warn(`[tray] 动作 ${action} 失败:`, err);
  });
}

const listEls: { el: HTMLElement; current: TrayMenuAction }[] = ITEMS.map((item) => {
  const el = document.createElement('div')
  el.className = item.danger ? 'item danger' : 'item'
  const entry = { el, current: 'showPlaylist' as TrayMenuAction }
  /**
   * 用 `mouseup` 而不是 `click`：壁纸模式下的鼠标转发可能抢走 mousedown，
   * down / up 不在同一元素上时浏览器不合成 `click`。mouseup 一定收得到。
   *
   * 但正因为靠 `mouseup`，必须自己校验「按下与抬起是同一项」：
   * 从「设置歌单」按下、滑到「退出程序」再松手（托盘菜单这种小面板很常见），
   * 原来会执行抬起那一项 —— 直接把应用退掉。所以记下按下的元素，抬起时比对。
   */
  let pressedOn: HTMLElement | null = null
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    pressedOn = el
  })
  el.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return
    const same = pressedOn === el
    pressedOn = null
    if (!same) {
      console.warn('[tray] 按下与抬起不在同一项，忽略这次点击')
      return
    }
    run(entry.current)
  })
  listEl.appendChild(el)
  return entry
})

const renderList = (state: TrayMenuState): void => {
  ITEMS.forEach((item, i) => {
    const action = typeof item.action === 'function' ? item.action(state) : item.action
    const entry = listEls[i]
    entry.current = action
    const label = item.label(state)
    if (entry.el.textContent !== label) entry.el.textContent = label
  })
}

// #endregion

let lastState: TrayMenuState | null = null

// #region 进度条（可拖动跳转）

let seeking = false
let seekRatio = 0

const ratioOf = (state: TrayMenuState | null): number => {
  if (seeking) return seekRatio
  if (!state || !state.duration) return 0
  return Math.min(1, Math.max(0, state.position / state.duration))
}

const paintSeek = (ratio: number, position: number, duration: number): void => {
  seekFill.style.width = `${ratio * 100}%`
  seekThumb.style.left = `${ratio * 100}%`
  const shown = seeking ? ratio * duration : position
  // 左中右三段：已播 / 总长
  timeCur.textContent = formatTime(shown)
  timeTotal.textContent = formatTime(duration)
}

const ratioFromEvent = (e: PointerEvent): number => {
  const r = seekTrack.getBoundingClientRect()
  return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0
}

const repaintSeekDrag = (): void => {
  paintSeek(seekRatio, seekRatio * (lastState?.duration ?? 0), lastState?.duration ?? 0)
}

seekTrack.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  seeking = true
  seekRatio = ratioFromEvent(e)
  try {
    seekTrack.setPointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
  repaintSeekDrag()
})
seekTrack.addEventListener('pointermove', (e) => {
  if (!seeking) return
  seekRatio = ratioFromEvent(e)
  repaintSeekDrag()
})
const finishSeek = (e: PointerEvent): void => {
  if (!seeking) return
  seeking = false
  try {
    seekTrack.releasePointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
  // 主进程会顺手收起菜单
  run('seek', seekRatio)
  repaintSeekDrag()
}
seekTrack.addEventListener('pointerup', finishSeek)
seekTrack.addEventListener('pointercancel', finishSeek)

// #endregion

// #region 音量（悬停出条 + 可拖动；按钮点了静音）

let volDragging = false
let volValue = 70
/** 最后一个非零音量：静音按钮点一下要有立刻的图标/数字反馈 */
let lastNonZeroVol = 70

const paintVolume = (v: number, muted: boolean): void => {
  // 横向条：填充宽度 + 滑块位置都是百分比；数字在条左边
  volumeFill.style.width = `${v}%`
  volumeThumb.style.left = `${v}%`
  volumeNum.textContent = String(v)
  volumeBtn.className = muted || v <= 0 ? 'iconfont icon-sound-off' : 'iconfont icon-sound-on'
  volumeBtn.title = muted || v <= 0 ? '取消静音' : '静音'
}

const volumeFromEvent = (e: PointerEvent): number => {
  const r = volumeTrack.getBoundingClientRect()
  if (r.width <= 0) return volValue
  const v = ((e.clientX - r.left) / r.width) * 100
  return Math.min(100, Math.max(0, Math.round(v)))
}

volumeTrack.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  volDragging = true
  volValue = volumeFromEvent(e)
  try {
    volumeTrack.setPointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
  paintVolume(volValue, false)
})
volumeTrack.addEventListener('pointermove', (e) => {
  if (!volDragging) return
  volValue = volumeFromEvent(e)
  paintVolume(volValue, false)
  run('volume', volValue)
})
const finishVolume = (e: PointerEvent): void => {
  if (!volDragging) return
  volDragging = false
  try {
    volumeTrack.releasePointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
  run('volume', volValue)
}
volumeTrack.addEventListener('pointerup', finishVolume)
volumeTrack.addEventListener('pointercancel', finishVolume)

/**
 * 音量按钮：静音开关
 *
 * 菜单**不收起**（主进程那边 volume/toggleMute 也不收），所以能立刻看到图标与数字变化；
 * 这里先按本地状态画一下（乐观更新），主进程推回权威状态后会再对齐。
 */
volumeBtn.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return
  const muted = volumeBtn.className.includes('icon-sound-off')
  if (muted) paintVolume(lastNonZeroVol || 70, false)
  else paintVolume(0, true)
  run('toggleMute')
})

// #endregion

// #region 四个控制按钮

const bind = (el: HTMLElement, action: TrayMenuAction, title?: string): void => {
  if (title) el.title = title
  el.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return
    run(action)
  })
}
bind(prevBtn, 'prev', '上一首')
bind(playBtn, 'playControl')
bind(nextBtn, 'next', '下一首')
bind(modeBtn, 'toggleMode')
// 播放按钮的提示要跟着状态走（悬停提示写错比没有更误导）
playBtn.title = '播放 / 暂停'
volumeBtn.title = '静音 / 取消静音'
seekTrack.title = '拖动跳转到指定位置'

const MODE_ICONS = ['icon-liebiaoxunhuan', 'icon-danquxunhuan', 'icon-suijibofang']

// #endregion

/** 用一份状态刷新界面（控制区不重建，避免打断拖拽） */
const apply = (state: TrayMenuState): void => {
  lastState = state
  titleEl.textContent = state.title || '未在播放'
  titleEl.title = state.title || ''
  playBtn.className = `iconfont ${state.paused ? 'icon-play' : 'icon-pause'}`
  playBtn.title = state.paused ? '播放' : '暂停'
  modeBtn.className = `iconfont ${MODE_ICONS[state.loopModeIndex] ?? MODE_ICONS[0]}`
  modeBtn.title = `当前：${state.loopModeName}（点击切换）`
  volValue = state.volume
  if (state.volume > 0) lastNonZeroVol = state.volume
  if (!volDragging) paintVolume(state.volume, state.muted)
  if (!seeking) paintSeek(ratioOf(state), state.position, state.duration)
  renderList(state)
}

/** 上一次报给主进程的高度（只有真的变了才再报，免得每 300ms 喊一次） */
let reportedHeight = 0

/** 把量到的高度报给主进程（它据此定位与显示） */
const reportHeight = (): void => {
  const height = Math.ceil(root.getBoundingClientRect().height)
  if (height === reportedHeight) return
  reportedHeight = height
  api.trayMenuReady(height).catch((err) => console.warn('[tray] 回报高度失败:', err))
}

api.onTrayMenuState((state) => {
  apply(state)
  reportHeight()
})

// Esc 收起（和原生菜单一致）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.trayMenuClose().catch(() => {})
})

// 首帧先要一次状态：主进程可能在我们监听之前就推过了
void api
  .trayMenuGetState()
  .then((state) => {
    apply(state)
    reportHeight()
  })
  .catch((err) => {
    // 拿不到状态也别让菜单空着：留一句提示，至少知道出事了
    console.warn('[tray] 获取菜单状态失败:', err)
    titleEl.textContent = '（读取状态失败）'
  })
