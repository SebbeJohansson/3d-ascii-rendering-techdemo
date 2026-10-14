<script setup lang="ts">
const { seed, blocks } = useCitySettings()
const stats = ref<{ buildings: number, backend: string }>()
const perf = ref<FramePerf>()
const color = usePersistentState('ascii-color', () => true)
const cellBackground = usePersistentState('ascii-cell-background', () => true)
const atlas = usePersistentState('ascii-atlas', () => true)
const worker = usePersistentState('ascii-worker', () => true)
const fontSize = usePersistentState('ascii-font-size', () => 12)
const grid = ref<{ cols: number, rows: number }>()
</script>

<template>
  <div class="page">
    <AsciiCityScene
      :seed="seed"
      :blocks="blocks"
      :color="color"
      :cell-background="cellBackground"
      :atlas="atlas"
      :worker="worker"
      :font-size="fontSize"
      @grid="grid = $event"
      @stats="stats = $event"
      @perf="perf = $event"
    />
    <CityControls :stats="stats" :perf="perf">
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
        <input v-model="atlas" type="checkbox">
        Glyph atlas (fast text)
      </label>
      <label class="toggle">
        <input v-model="worker" type="checkbox">
        Ray trace in Web Workers
      </label>
    </CityControls>
  </div>
</template>

<style scoped>
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

.toggle {
  flex-direction: row !important;
  align-items: center;
}
</style>
