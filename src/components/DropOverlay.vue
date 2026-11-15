<!--
  拖入遮罩

  整窗盖一层虚线框 + 一句「松手导入并播放」：
  拖拽过程中浏览器给的唯一反馈就是光标，不盖点东西用户不知道松手会发生什么。

  `pointer-events: none` —— 它只是个提示，不能挡住鼠标（否则 drop 事件都收不到）。
  层级压过 Element Plus 的弹窗：管理弹窗开着时也照样看得见。

  数据全在 store 里（`dropActive` / `dropBusy` 由 App 的拖拽监听写入），
  这个组件只负责画。
-->
<template>
  <div v-if="drop.dropActive" class="drop-overlay">
    <!--
      分栏：左边进默认列表、右边进当前列表

      只在「当前在播的是本地列表 / 本地歌单，且不是默认那个」时出现
      （判定在 `dropTargets` 里）。鼠标在哪半就高亮哪半 ——
      遮罩本身 `pointer-events: none`，高亮靠 store 里 `dragover` 算出的 `dropHalf`。
    -->
    <template v-if="drop.dropTargets">
      <!--
        一条竖线把窗口分成两半，只有文字：鼠标在哪半，那半的名字亮起来，
        另一半压暗。不做卡片 / 描边 / 缩放 —— 拖拽时眼睛只认「亮的那边」。
      -->
      <div class="drop-split">
        <div class="drop-half" :class="{ on: drop.dropHalf === 'left' }">
          <div class="drop-half-name">{{ drop.dropTargets.left.name }}</div>
          <div class="drop-half-hint">默认</div>
        </div>
        <div class="drop-half" :class="{ on: drop.dropHalf === 'right' }">
          <div class="drop-half-name">{{ drop.dropTargets.right.name }}</div>
          <div class="drop-half-hint">当前</div>
        </div>
      </div>
      <div class="drop-foot">
        {{
          drop.dropBusy
            ? '正在导入…'
            : drop.dropHalf
              ? '松手导入到亮着的那一边'
              : '左右两边是不同的落点，看准了再松手'
        }}
      </div>
    </template>

    <div v-else class="drop-card">
      <div class="drop-ring"></div>
      <div class="drop-title">
        {{ drop.dropBusy ? '正在导入…' : '松手即可导入并播放' }}
      </div>
      <div class="drop-sub">
        {{
          drop.dropBusy
            ? '拉取列表可能要几秒，导入完直接从第一条开始播'
            : '某站视频 / 合集 / 收藏夹 · wy / tx 歌单'
        }}
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { useDropStore } from '../stores/drop';

export default defineComponent({
  name: 'DropOverlay',
  computed: {
    /*
     * 播放相关的状态按业务域拆成了多个 store（原来全在一个 player store 里）：
     * 下面每个 computed 取一个（Pinia 返回同一个单例，调用没有开销），
     * 模板里就用 `playback.xxx` / `queue.xxx` / `ui.xxx` 直接读。
     */
    drop() {
      return useDropStore();
    },
  },
});
</script>

<style scoped>
/*
 * 层级 3000 —— 压过 Element Plus 的弹窗（2000 上下），管理弹窗开着也看得见。
 */
.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  /* 只做提示，绝不能吃掉鼠标事件（吃掉就收不到 drop 了） */
  pointer-events: none;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.drop-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 26px 40px;
  border-radius: 16px;
  border: 2px dashed rgba(255, 255, 255, 0.55);
  background: var(--glass-bg-strong);
  color: var(--glass-text);
  user-select: none;
}
.drop-ring {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: var(--accent);
  /* 一直转：拖拽时是「准备接收」，导入时是「正在干活」，两种状态都不用额外写样式 */
  animation: drop-spin 0.9s linear infinite;
}
@keyframes drop-spin {
  to {
    transform: rotate(360deg);
  }
}
.drop-title {
  font-size: 16px;
  font-weight: 600;
}
.drop-sub {
  font-size: 12px;
  opacity: 0.75;
}

/* 分栏：整屏两半，中间一条竖线，两半各摆一组文字 */
.drop-split {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: stretch;
}
.drop-half {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  user-select: none;
  /* 没被指向的那半压暗：拖拽时只该有一个「亮的目标」 */
  opacity: 0.35;
  transition:
    opacity 0.12s,
    color 0.12s;
}
/* 竖线画在右半边的左边界上，自然贯穿整个窗口高度 */
.drop-half + .drop-half {
  border-left: 1px solid rgba(255, 255, 255, 0.45);
}
.drop-half.on {
  opacity: 1;
  color: var(--accent);
}
.drop-half-name {
  font-size: 22px;
  font-weight: 700;
  max-width: 88%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drop-half-hint {
  font-size: 12px;
  opacity: 0.75;
}
.drop-foot {
  position: absolute;
  bottom: 40px;
  font-size: 12px;
  color: var(--glass-text);
  opacity: 0.8;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.35);
}
</style>
