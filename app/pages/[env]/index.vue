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
usePlayerDriver(env.value)
const stats = ref<string>()
const perf = ref<FramePerf>()
</script>

<template>
  <div class="page">
    <Scene3D :env="env" :seed="seed" :size="size" @stats="stats = $event" @perf="perf = $event" />
    <SceneControls :env="env" mode="3d" :stats="stats" :perf="perf" />
  </div>
</template>
