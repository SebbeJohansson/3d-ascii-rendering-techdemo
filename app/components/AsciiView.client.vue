<script setup lang="ts">
// The ASCII view, drawn by whichever renderer the ASCII settings pick: a ray tracer (CPU or
// GPU) that draws characters on a canvas, or the 3D view run through an ASCII shader. A lens
// needs a ray tracer, so with one the shader choice falls back to the CPU.
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
const method = computed(() => (settings.method === 'gpu' && !hasWebGpu() ? 'cpu' : settings.method))
</script>

<template>
  <Scene3D
    v-if="method === 'shader' && !lens"
    :env="env"
    :seed="seed"
    :size="size"
    :ascii="{ fontSize: settings.fontSize, color: settings.color, cellBackground: settings.cellBackground }"
  />
  <AsciiScene v-else :env="env" :seed="seed" :size="size" v-bind="settings" :method="method" :lens="lens" />
</template>
