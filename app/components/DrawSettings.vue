<script setup lang="ts">
// The draw mode's part of the panel: the tool, the pad to draw on, sizes, color, and the
// shapes placed so far.
import type { Environment } from '~/environments'
import { hexToCss } from '~/lib/color'
import { COLORS, type DrawTool } from '~/lib/shapes'

const props = defineProps<{
  env: Environment
}>()

const { tool, profile, cells, sizes, extrudeHeight, color, ready, resetProfile, resetCells } = useDrawing()
const shapes = useShapes(props.env)

const TOOLS: { id: DrawTool, name: string }[] = [
  { id: 'spin', name: 'Spin' },
  { id: 'extrude', name: 'Extrude' },
  { id: 'blobs', name: 'Blobs' },
]
</script>

<template>
  <nav>
    <button v-for="t in TOOLS" :key="t.id" type="button" :class="{ active: tool === t.id }" @click="tool = t.id">
      {{ t.name }}
    </button>
  </nav>
  <template v-if="tool === 'spin'">
    <p class="keys">
      Drag to draw half an outline; it spins around the dashed axis.
    </p>
    <DrawPad v-model:profile="profile" v-model:cells="cells" tool="spin" />
    <button type="button" class="link" @click="resetProfile">
      Back to the vase
    </button>
    <label>
      Height: {{ sizes.spin.value }} m
      <input v-model.number="sizes.spin.value" type="range" min="2" max="40">
    </label>
  </template>
  <template v-else-if="tool === 'extrude'">
    <p class="keys">
      Click or drag to fill cells; start on a filled one to erase.
    </p>
    <DrawPad v-model:profile="profile" v-model:cells="cells" tool="extrude" />
    <span class="links">
      <button type="button" class="link" @click="cells = []">Clear pad</button>
      <button type="button" class="link" @click="resetCells">Back to the heart</button>
    </span>
    <label>
      Width: {{ sizes.extrude.value }} m
      <input v-model.number="sizes.extrude.value" type="range" min="4" max="64" step="4">
    </label>
    <label>
      Height: {{ extrudeHeight }} m
      <input v-model.number="extrudeHeight" type="range" min="0.5" max="24" step="0.5">
    </label>
  </template>
  <template v-else>
    <p class="keys">
      Click to add a blob; blobs touching melt together.
    </p>
    <label>
      Blob size: {{ sizes.blobs.value }} m
      <input v-model.number="sizes.blobs.value" type="range" min="1" max="16" step="0.5">
    </label>
  </template>
  <div class="swatches" role="radiogroup" aria-label="Color">
    <button type="button" class="swatch random" :class="{ active: color < 0 }" title="Random color" @click="color = -1" />
    <button
      v-for="(c, i) in COLORS"
      :key="c"
      type="button"
      class="swatch"
      :class="{ active: color === i }"
      :style="{ background: hexToCss(c) }"
      :title="hexToCss(c)"
      @click="color = i"
    />
  </div>
  <p v-if="!ready" class="keys">
    Draw something on the pad first.
  </p>
  <span v-if="shapes.count.value" class="links">
    <button type="button" class="link" @click="shapes.undo()">Undo</button>
    <button type="button" class="link" @click="shapes.clear()">Clear {{ shapes.count.value }} {{ shapes.count.value === 1 ? 'shape' : 'shapes' }}</button>
  </span>
</template>

<style scoped>
.keys {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #555;
}

.links {
  display: flex;
  gap: 12px;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  font-size: 12px;
  color: #2b5d8a;
  text-decoration: underline;
  cursor: pointer;
}

.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.swatch {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid rgb(0 0 0 / 0.2);
  border-radius: 50%;
  cursor: pointer;
}

.swatch.active {
  outline: 2px solid #2b5d8a;
  outline-offset: 1px;
}

.random {
  background: conic-gradient(#e74c3c, #f1c40f, #2ecc71, #3498db, #9b59b6, #e74c3c);
}
</style>
