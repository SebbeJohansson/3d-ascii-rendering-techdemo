<script setup lang="ts">
// The ASCII view's display settings, for the control panel's slot.
defineProps<{
  grid?: { cols: number, rows: number }
}>()

const { color, cellBackground, outlines, stretch, atlas, worker, fontSize } = useAsciiSettings()
</script>

<template>
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
    <input v-model="outlines" type="checkbox">
    Outlines (line characters on edges)
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
