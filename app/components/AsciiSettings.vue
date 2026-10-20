<script setup lang="ts">
// The ASCII view's display settings, for the control panel's slot.
import { hasWebGpu } from '~/lib/gpu/gpuTracer'

const props = defineProps<{
  grid?: { cols: number, rows: number }
  /** The lens view: it needs characters from a ray tracer, so shader and pixels can't be picked there. */
  lens?: boolean
}>()

const { method, color, cellBackground, blocks, outlines, stretch, occlusion, coarseDrag, atlas, worker, fontSize } = useAsciiSettings()
const gpu = hasWebGpu()
const METHODS: { id: AsciiMethod, name: string, hint: string }[] = [
  { id: 'cpu', name: 'CPU', hint: 'Ray traced in JavaScript, one ray per character.' },
  { id: 'gpu', name: 'GPU', hint: 'The same ray tracer as a WebGPU compute shader, drawn straight from the GPU.' },
  { id: 'shader', name: 'Shader', hint: 'No ray tracing: the 3D view, turned into characters by a post-processing shader.' },
  { id: 'pixels', name: 'Pixels', hint: 'No characters: the GPU ray tracer at full resolution, one ray per pixel, drawn straight from the GPU.' },
]
const cellsOnly = (m: AsciiMethod) => m === 'shader' || m === 'pixels'
const effective = computed(() => (props.lens && cellsOnly(method.value) ? 'cpu' : method.value))
const traced = computed(() => effective.value !== 'shader')
/** Drawn as characters, so the character settings apply. */
const glyphs = computed(() => effective.value !== 'pixels')
/** Blocks are colors without characters: the character settings don't apply. */
const blocksOn = computed(() => traced.value && blocks.value)
</script>

<template>
  <nav>
    <button
      v-for="m in METHODS"
      :key="m.id"
      type="button"
      :class="{ active: effective === m.id }"
      :disabled="((m.id === 'gpu' || m.id === 'pixels') && !gpu) || (cellsOnly(m.id) && lens)"
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
    <template v-if="lens && cellsOnly(method)">
      The lens needs characters from a ray tracer, so it uses the CPU here.
    </template>
  </p>
  <p v-if="!glyphs && grid" class="hint">
    {{ grid.cols }} × {{ grid.rows }} = {{ (grid.cols * grid.rows).toLocaleString('en-US') }} rays per frame
  </p>
  <label v-if="glyphs">
    Resolution: {{ fontSize }} px characters
    <span v-if="grid" class="grid">{{ grid.cols }} × {{ grid.rows }} = {{ (grid.cols * grid.rows).toLocaleString('en-US') }} cells</span>
    <!-- Reversed so dragging right means more detail. -->
    <input v-model.number="fontSize" type="range" min="3" max="20" step="1" class="reversed">
  </label>
  <label v-if="traced && glyphs" class="toggle">
    <input v-model="blocks" type="checkbox">
    Blocks (two colored pixels per character, no characters)
  </label>
  <label v-if="glyphs" class="toggle" :class="{ disabled: blocksOn }">
    <input v-model="color" type="checkbox" :disabled="blocksOn">
    Colored characters
  </label>
  <label v-if="glyphs" class="toggle" :class="{ disabled: !color || blocksOn }">
    <input v-model="cellBackground" type="checkbox" :disabled="!color || blocksOn">
    Cell backgrounds (solid color)
  </label>
  <label v-if="traced && glyphs" class="toggle">
    <input v-model="outlines" type="checkbox">
    Outlines (line characters on edges)
  </label>
  <label v-if="traced && glyphs" class="toggle" :class="{ disabled: blocksOn }">
    <input v-model="stretch" type="checkbox" :disabled="blocksOn">
    Stretch contrast (per frame)
  </label>
  <label v-if="traced" class="toggle">
    <input v-model="occlusion" type="checkbox">
    Ambient occlusion (darker corners, slower)
  </label>
  <label v-if="traced" class="toggle">
    <input v-model="coarseDrag" type="checkbox">
    Lower resolution while dragging
  </label>
  <label v-if="traced && glyphs" class="toggle" :class="{ disabled: blocksOn }">
    <input v-model="atlas" type="checkbox" :disabled="blocksOn">
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
