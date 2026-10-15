<script setup lang="ts">
// The ASCII view's display settings, for the control panel's slot.
import { hasWebGpu } from '~/lib/gpu/gpuTracer'

const props = defineProps<{
  grid?: { cols: number, rows: number }
  /** The lens view: it needs a ray tracer, so the shader can't be picked there. */
  lens?: boolean
}>()

const { method, color, cellBackground, outlines, stretch, atlas, worker, fontSize } = useAsciiSettings()
const gpu = hasWebGpu()
const METHODS: { id: AsciiMethod, name: string, hint: string }[] = [
  { id: 'cpu', name: 'CPU', hint: 'Ray traced in JavaScript, one ray per character.' },
  { id: 'gpu', name: 'GPU', hint: 'The same ray tracer as a WebGPU compute shader.' },
  { id: 'shader', name: 'Shader', hint: 'No ray tracing: the 3D view, turned into characters by a post-processing shader.' },
]
const effective = computed(() => (props.lens && method.value === 'shader' ? 'cpu' : method.value))
const traced = computed(() => effective.value !== 'shader')
</script>

<template>
  <nav>
    <button
      v-for="m in METHODS"
      :key="m.id"
      type="button"
      :class="{ active: effective === m.id }"
      :disabled="(m.id === 'gpu' && !gpu) || (m.id === 'shader' && lens)"
      @click="method = m.id"
    >
      {{ m.name }}
    </button>
  </nav>
  <p class="hint">
    {{ METHODS.find(m => m.id === effective)!.hint }}
    <template v-if="!gpu">
      GPU needs WebGPU, which this browser doesn't have.
    </template>
    <template v-if="lens && method === 'shader'">
      The lens needs a ray tracer, so it uses the CPU here.
    </template>
  </p>
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
  <label v-if="traced" class="toggle">
    <input v-model="outlines" type="checkbox">
    Outlines (line characters on edges)
  </label>
  <label v-if="traced" class="toggle">
    <input v-model="stretch" type="checkbox">
    Stretch contrast (per frame)
  </label>
  <label v-if="traced" class="toggle">
    <input v-model="atlas" type="checkbox">
    Glyph atlas (fast text)
  </label>
  <label v-if="effective === 'cpu'" class="toggle">
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

.hint {
  margin: 0;
  font-size: 12px;
  color: #555;
}

nav button:disabled {
  opacity: 0.4;
  cursor: default;
}

.grid {
  font-size: 11px;
  color: #555;
}

.reversed {
  direction: rtl;
}
</style>
