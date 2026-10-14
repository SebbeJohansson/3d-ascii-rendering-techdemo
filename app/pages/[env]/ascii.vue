<script setup lang="ts">
import { findEnvironment } from '~/environments'
import type { FramePerf } from '~/lib/frameMeter'

definePageMeta({
  validate: route => findEnvironment(route.params.env) !== undefined,
  // Remount when switching environment, so camera and settings are re-read for the new one.
  key: route => route.fullPath,
})

const env = useRouteEnvironment()
const { seed, size } = useSceneSettings(env.value)
const ascii = reactive(useAsciiSettings())
const stats = ref<string>()
const perf = ref<FramePerf>()
const grid = ref<{ cols: number, rows: number }>()
</script>

<template>
  <div class="page">
    <AsciiScene
      :env="env"
      :seed="seed"
      :size="size"
      v-bind="ascii"
      @grid="grid = $event"
      @stats="stats = $event"
      @perf="perf = $event"
    />
    <SceneControls :env="env" mode="ascii" :stats="stats" :perf="perf">
      <AsciiSettings :grid="grid" />
    </SceneControls>
  </div>
</template>
