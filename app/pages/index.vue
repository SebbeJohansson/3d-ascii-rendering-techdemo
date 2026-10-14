<script setup lang="ts">
const { seed, blocks } = useCitySettings()
const stats = ref<{ buildings: number, backend: string }>()
</script>

<template>
  <div class="page">
    <CityScene :seed="seed" :blocks="blocks" @stats="stats = $event" />
    <CityControls :stats="stats" />
  </div>
</template>
