<script setup lang="ts">
const { seed, blocks } = useCitySettings()
const stats = ref<{ buildings: number, backend: string }>()
const perf = ref<FramePerf>()
</script>

<template>
  <div class="page">
    <CityScene :seed="seed" :blocks="blocks" @stats="stats = $event" @perf="perf = $event" />
    <CityControls :stats="stats" :perf="perf" />
  </div>
</template>
