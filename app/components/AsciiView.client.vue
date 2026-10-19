<script setup lang="ts">
// The ASCII view, drawn by whichever renderer the ASCII settings pick: a ray tracer (CPU or
// GPU) that draws characters on a canvas, the 3D view run through an ASCII shader, or the GPU
// ray tracer at full resolution. A lens needs characters from a ray tracer, so with one the
// shader and full resolution fall back to the CPU.
import type { Environment } from '~/environments'
import { hasWebGpu } from '~/lib/gpu/gpuTracer'
import type { Lens } from '~/lib/lens'

defineProps<{
  env: Environment
  seed: number
  size: number
  lens?: Lens
}>()

const settings = reactive(useAsciiSettings())
/** GPU picked in a browser without WebGPU (say, the setting came from another browser): use the CPU. */
// Full resolution draws on a WebGPU canvas and the others on a 2D one, and a canvas can't
// switch: the template keys AsciiScene on which one it needs.
const method = computed(() => ((settings.method === 'gpu' || settings.method === 'pixels') && !hasWebGpu() ? 'cpu' : settings.method))
</script>

<template>
  <!-- Lazy, so the ray tracers don't download three.js. -->
  <LazyScene3D
    v-if="method === 'shader' && !lens"
    :env="env"
    :seed="seed"
    :size="size"
    :ascii="{ fontSize: settings.fontSize, color: settings.color, cellBackground: settings.cellBackground }"
  />
  <AsciiScene
    v-else
    :key="method === 'pixels' && !lens ? 'pixels' : 'cells'"
    :env="env"
    :seed="seed"
    :size="size"
    v-bind="settings"
    :method="method === 'pixels' && lens ? 'cpu' : method"
    :lens="lens"
  />
</template>
