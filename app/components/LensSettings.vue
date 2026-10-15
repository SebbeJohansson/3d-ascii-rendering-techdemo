<script setup lang="ts">
// The ASCII lens's settings, for the control panel's slot.
import type { LensShape } from '~/lib/lens'

const { shape, size } = useLensSettings()
const SHAPES: { id: LensShape, name: string }[] = [
  { id: 'mouse', name: 'Mouse' },
  { id: 'focus', name: 'Focus' },
  { id: 'scan', name: 'Scan' },
]
const HINTS: Record<LensShape, string> = {
  mouse: 'ASCII under the pointer.',
  focus: 'ASCII around what the camera looks at: the dragon or car when riding.',
  scan: 'A line sweeps across the view, ASCII behind it.',
}
</script>

<template>
  <nav>
    <button v-for="s in SHAPES" :key="s.id" type="button" :class="{ active: shape === s.id }" @click="shape = s.id">
      {{ s.name }}
    </button>
  </nav>
  <p class="hint">
    {{ HINTS[shape] }}
  </p>
  <label v-if="shape !== 'scan'">
    Lens size
    <input v-model.number="size" type="range" min="1" max="10" step="1">
  </label>
</template>

<style scoped>
.hint {
  margin: 0;
  font-size: 12px;
  color: #555;
}
</style>
