import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// Element Plus 的暗色变量：挂在 html.dark 上，切主题时由 applyUiTheme 控制
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import './assets/iconfont/iconfont.css'
// 主题令牌与全局骨架。顺序有意义：排在 element-plus 的 css 之后，覆盖才生效
import './styles/theme.css'
import './styles/global.css'
import { useSettingStore } from './stores/setting'
import { applyUiThemeFromSetting } from './utils/uiTheme'

const app = createApp(App)

app.use(createPinia())
app.use(ElementPlus)

/**
 * 启动前先把主进程的配置拉进 Pinia，并挂上 setting:update 广播监听。
 *
 * 这样组件 mounted 时 store 已经就绪，
 * 不会出现「首帧用默认值、下一帧才跳成真实值」的闪烁。
 */
const bootstrap = async (): Promise<void> => {
  const settingStore = useSettingStore()
  // 先挂监听再拉取：避免拉取与广播之间的竞态导致丢更新
  settingStore.startSync()
  try {
    await settingStore.load()
  } catch (err) {
    console.error('[bootstrap] load setting failed, fallback to defaults:', err)
  }
  // 界面颜色 / 毛玻璃参数跟着配置走（含后续广播过来的修改）。
  // 放在 mount 之前应用一次，避免先按默认色渲染再跳一下的闪烁。
  //
  // ⚠️ 这个数组必须与 `applyUiTheme` **实际读取的键**保持一致。
  // 漏掉某个键的后果是：那个设置改了不会生效（数字变了、界面没变），
  // 要等到用户再动数组里别的键时才被顺带应用一次。
  // 踩过：`common.idleOpacity` 漏在这里 → 「控制栏闲置透明度」拖了没反应。
  watch(
    () => [
      settingStore.setting['common.themeColor'],
      settingStore.setting['common.fontColor'],
      settingStore.setting['common.glassTransparency'],
      settingStore.setting['common.glassBlur'],
      settingStore.setting['common.glassShadow'],
      settingStore.setting['common.idleOpacity'],
    ],
    () => applyUiThemeFromSetting(settingStore.setting),
    { immediate: true },
  )
  app.mount('#app')
}

void bootstrap()
