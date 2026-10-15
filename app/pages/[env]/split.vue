<script setup lang="ts">
import { findEnvironment } from '~/environments'
import type { FramePerf } from '~/lib/frameMeter'

definePageMeta({
  validate: route => findEnvironment(route.params.env) !== undefined,
  // Remount when switching environment, so camera and settings are re-read for the new one.
  key: route => route.fullPath,
})

// Both halves share the environment's camera and player state, so dragging either one, or
// driving the player, moves both.
const env = useRouteEnvironment()
const { seed, size } = useSceneSettings(env.value)
usePlayerDriver(env.value)
const ascii = reactive(useAsciiSettings())
const stats3d = ref<string>()
const statsAscii = ref<string>()
const perf3d = ref<FramePerf>()
const perfAscii = ref<FramePerf>()
const grid = ref<{ cols: number, rows: number }>()

/** "WebGPU" from "530 buildings · WebGPU", "8 workers" from "... · CPU ray tracer · 8 workers". */
const lastPart = (stats?: string) => stats?.split(' · ').at(-1) ?? ''
const fps = (perf?: FramePerf) => (perf ? (perf.fps >= 1 ? `${Math.round(perf.fps)} fps` : 'idle') : '')
</script>

<template>
  <div class="page split">
    <section>
      <Scene3D :env="env" :seed="seed" :size="size" @stats="stats3d = $event" @perf="perf3d = $event" />
      <span class="label">3D · {{ lastPart(stats3d) }} · {{ fps(perf3d) }}</span>
    </section>
    <section>
      <AsciiScene
        :env="env"
        :seed="seed"
        :size="size"
        v-bind="ascii"
        @grid="grid = $event"
        @stats="statsAscii = $event"
        @perf="perfAscii = $event"
      />
      <span class="label">ASCII · {{ lastPart(statsAscii) }} · {{ fps(perfAscii) }}</span>
    </section>
    <SceneControls :env="env" mode="split" :stats="stats3d?.split(' · ').slice(0, -1).join(' · ')" :perf="perfAscii">
      <AsciiSettings :grid="grid" />
    </SceneControls>
  </div>
</template>

<style scoped>
.split {
  display: flex;
}

section {
  position: relative;
  flex: 1;
  overflow: hidden;
}

section + section {
  border-left: 2px solid rgb(0 0 0 / 0.25);
}

.label {
  position: absolute;
  top: 12px;
  right: 12px;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgb(255 255 255 / 0.85);
  font: 600 12px ui-monospace, Menlo, Consolas, monospace;
  color: #2b5d8a;
  pointer-events: none;
}
</style>
