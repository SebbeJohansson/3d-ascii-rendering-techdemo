<script setup lang="ts">
import { findEnvironment } from '~/environments'
import type { FramePerf } from '~/lib/frameMeter'

definePageMeta({
  validate: route => findEnvironment(route.params.env) !== undefined,
  // Remount when switching environment, so camera and settings are re-read for the new one.
  key: route => route.fullPath,
})

const env = useRouteEnvironment()
const { seed, size } = useSceneSettings(env.value)
const stats = ref<string>()
const perf = ref<FramePerf>()
const grid = ref<{ cols: number, rows: number }>()
// Display settings are shared by all environments.
const color = usePersistentState('ascii-color', () => true)
const cellBackground = usePersistentState('ascii-cell-background', () => true)
const atlas = usePersistentState('ascii-atlas', () => true)
const stretch = usePersistentState('ascii-stretch', () => false)
const worker = usePersistentState('ascii-worker', () => true)
const fontSize = usePersistentState('ascii-font-size', () => 12)
</script>

<template>
  <div class="page">
    <AsciiScene
      :env="env"
      :seed="seed"
      :size="size"
      :color="color"
      :cell-background="cellBackground"
      :atlas="atlas"
      :stretch="stretch"
      :worker="worker"
      :font-size="fontSize"
      @grid="grid = $event"
      @stats="stats = $event"
      @perf="perf = $event"
    />
    <SceneControls :env="env" mode="ascii" :stats="stats" :perf="perf">
      <label>
        Resolution: {{ fontSize }} px characters
        <span v-if="grid" class="grid">{{ grid.cols }} × {{ grid.rows }} = {{ (grid.cols * grid.rows).toLocaleString('en-US') }} cells</span>
        <!-- Reversed so dragging right means more detail. -->
        <input v-model.number="fontSize" type="range" min="3" max="20" step="1" class="reversed">
      </label>
      <label class="toggle">
        <input v-model="color" type="checkbox">
        Colored characters
      </label>
      <label class="toggle" :class="{ disabled: !color }">
        <input v-model="cellBackground" type="checkbox" :disabled="!color">
        Cell backgrounds (solid color)
      </label>
      <label class="toggle">
        <input v-model="stretch" type="checkbox">
        Stretch contrast (per frame)
      </label>
      <label class="toggle">
        <input v-model="atlas" type="checkbox">
        Glyph atlas (fast text)
      </label>
      <label class="toggle">
        <input v-model="worker" type="checkbox">
        Ray trace in Web Workers
      </label>
    </SceneControls>
  </div>
</template>

<style scoped>
.toggle {
  flex-direction: row !important;
  align-items: center;
}

.toggle.disabled {
  opacity: 0.5;
}

.grid {
  font-size: 11px;
  color: #555;
}

.reversed {
  direction: rtl;
}
</style>
