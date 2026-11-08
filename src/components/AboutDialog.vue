<template>
  <!--
    「关于」弹窗

    和其它弹窗一样：没有右上角叉号，点空白处关闭，
    提示「点击空白位置关闭」由 `styles/global.css` 里遮罩的 ::after 统一提供。
  -->
  <el-dialog
    v-model="visible"
    title="关于"
    width="440px"
    :show-close="false"
    align-center
  >
    <div class="ab-body">
      <div class="ab-avatars">
        <div class="ab-person">
          <img class="ab-avatar" :src="devAvatar" alt="作者头像" />
          <div class="ab-name">作者</div>
          <div class="ab-role">liaoran2002</div>
        </div>
        <div class="ab-heart">❤</div>
        <div class="ab-person">
          <img class="ab-avatar" :src="aiAvatar" alt="DeepSeek 大肥鱼" />
          <div class="ab-name">大肥鱼</div>
          <div class="ab-role">DeepSeek</div>
        </div>
      </div>

      <div class="ab-title">BLWE(全称:BiLiWallpaperEngine)</div>
      <div class="ab-desc">把某站视频列表 / 音乐歌单铺到桌面当壁纸的播放器</div>

      <div class="ab-link" title="用系统浏览器打开" @click="openRepo">
        https://github.com/liaoran2002/BLWE
      </div>

      <!--
        版本号 + 检查更新

        「检查更新」是唯一的手动入口（自动检查在启动后静默跑一次，连不上就什么都不说）。
        指纹（app.asar 的 sha256）只用于内部比对**有没有新版**，不往界面上摆。
      -->
      <div class="ab-meta">
        <span>版本 {{ appVersion || "—" }}</span>
        <span class="ab-check" :class="{ busy: checking }" @click="checkUpdate">
          {{ checking ? "检查中…" : "检查更新" }}
        </span>
      </div>

      <div class="ab-thanks">大肥鱼，没有你我写不出来啊！<br>虽然花了我40块钱加6元鲸圆券！但是你不是吃白饭的大肥鱼！</div>
    </div>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api/electron';
import { useUiStore } from '../stores/ui';

/**
 * 仓库地址
 *
 * 用 `new URL(..., import.meta.url)` 引静态图：Vite 会在构建时把它换成产物里的真实路径，
 * 既不用给 `*.jpg` 补模块声明，也不会在打包后 404。
 */
const REPO_URL = 'https://github.com/liaoran2002/BLWE';

export default defineComponent({
  name: 'AboutDialog',
  computed: {
    /*
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    ui() {
      return useUiStore();
    },
    /** 弹窗开关就在 store 里，父组件不需要参与 */
    visible: {
      get(): boolean {
        return this.ui.aboutVisible;
      },
      set(v: boolean) {
        this.ui.aboutVisible = v;
      },
    },
  },
  data() {
    return {
      devAvatar: new URL('../assets/avatar.jpg', import.meta.url).href,
      aiAvatar: new URL('../assets/avatar-fish.jpg', import.meta.url).href,
      /** 打包版本号（只展示用，不参与新旧判断） */
      appVersion: '',
      checking: false,
    };
  },
  watch: {
    /** 每次打开读一次版本号（不发请求，纯本地读） */
    visible(v: boolean) {
      if (v) void this.loadInfo();
    },
  },
  methods: {
    async loadInfo(): Promise<void> {
      try {
        const info = await api.getUpdateInfo();
        this.appVersion = info.version;
      } catch {
        /* 读不到就显示「—」，不影响其它功能 */
      }
    },
    /**
     * 手动检查更新
     *
     * 和自动检查的区别只有一处：**失败要说出来**。自动检查连不上 GitHub 时是完全静默的。
     */
    async checkUpdate(): Promise<void> {
      if (this.checking) return;
      this.checking = true;
      try {
        const res = await api.checkUpdate();
        if (res.skipped) {
          ElMessage.info(res.skipped);
          return;
        }
        if (!res.ok) {
          ElMessage.error(`检查失败：${res.error || '连接失败'}`);
          return;
        }
        if (!res.different) {
          ElMessage.success('已经是最新构建');
          return;
        }
        try {
          await ElMessageBox.confirm(
            '发布页上的构建和当前这份不一样，说明有新版本。\n去下载后需要手动安装。',
            '发现新版本',
            { confirmButtonText: '去下载', cancelButtonText: '以后再说', type: 'info' },
          );
          if (res.url) await api.openExternal(res.url);
        } catch {
          /** 点「以后再说」：记下这份指纹，自动检查不再主动弹它 */
          if (res.remote) await api.dismissUpdate(res.remote);
        }
      } catch (err) {
        ElMessage.error(`检查失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.checking = false;
      }
    },

    /** 交给系统浏览器打开（主进程只放行 http/https） */
    async openRepo(): Promise<void> {
      try {
        const ok = await api.openExternal(REPO_URL);
        if (!ok) ElMessage.warning('链接被拒绝了');
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err));
      }
    },
  },
});
</script>

<style scoped>
.ab-body {
  text-align: center;
}
.ab-avatars {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  margin: 4px 0 18px;
}
.ab-person {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.ab-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--panel-border);
  background: var(--panel-hover);
}
.ab-name {
  font-size: calc(13px * var(--fs));
  font-weight: 600;
}
.ab-role {
  font-size: calc(11px * var(--fs));
  opacity: 0.6;
}
.ab-heart {
  font-size: calc(16px * var(--fs));
  opacity: 0.75;
  color: var(--accent-danger);
}
.ab-title {
  font-size: calc(16px * var(--fs));
  font-weight: 600;
  letter-spacing: 0.02em;
}
.ab-desc {
  font-size: calc(12px * var(--fs));
  opacity: 0.75;
  margin-top: 6px;
  line-height: 1.6;
}
.ab-link {
  display: inline-block;
  margin-top: 12px;
  font-size: calc(12px * var(--fs));
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
  word-break: break-all;
}
.ab-link:hover {
  color: rgb(var(--text-rgb));
}
.ab-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 10px;
  font-size: calc(11px * var(--fs));
  opacity: 0.65;
}
.ab-check {
  margin-left: 4px;
  padding: 2px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  color: var(--accent);
  cursor: pointer;
  opacity: 1;
}
.ab-check:hover {
  background: var(--panel-hover);
}
.ab-check.busy {
  cursor: default;
  opacity: 0.6;
}
.ab-thanks {
  margin-top: 16px;
  font-size: calc(12px * var(--fs));
  opacity: 0.6;
}
</style>
