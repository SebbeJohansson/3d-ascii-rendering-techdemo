<script setup lang="ts">
import { findEnvironment } from '~/environments'
import type { FramePerf } from '~/lib/frameMeter'

definePageMeta({
  validate: route => findEnvironment(route.params.env) !== undefined,
  // Remount when switching environment, so camera and settings are re-read for the new one.
  key: route => route.fullPath,
})

// The 3D view, with the ASCII view on top showing only inside the lens. Both draw with the
// same camera at the same size, so every character sits over the part of the scene it shows.
const env = useRouteEnvironment()
const { seed, size } = useSceneSettings(env.value)
usePlayerDriver(env.value)
useDayCycle()
const stats = ref<string>()
const perf = ref<FramePerf>()
const grid = ref<{ cols: number, rows: number }>()

const page = ref<HTMLDivElement>()
const pointer = ref<{ x: number, y: number } | null>(null)
const lens = useLens(env.value, pointer)

function onPointerMove(e: PointerEvent) {
  const box = page.value!.getBoundingClientRect()
  pointer.value = { x: e.clientX - box.left, y: e.clientY - box.top }
}
</script>

<template>
  <div ref="page" class="page" @pointermove="onPointerMove" @pointerleave="pointer = null">
    <Scene3D :env="env" :seed="seed" :size="size" @stats="stats = $event" />
    <AsciiView
      :env="env"
      :seed="seed"
      :size="size"
      :lens="lens"
      @grid="grid = $event"
      @perf="perf = $event"
    />
    <SceneControls :env="env" mode="lens" :stats="stats?.split(' · ').slice(0, -1).join(' · ')" :perf="perf">
      <LensSettings />
      <AsciiSettings :grid="grid" lens />
    </SceneControls>
  </div>
</template>
