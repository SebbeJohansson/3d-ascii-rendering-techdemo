<script setup lang="ts">
// The outline of a box about to be dropped, drawn over a view.
defineProps<{
  /** SVG path of its edges, in CSS pixels within the view. */
  d: string
}>()
</script>

<template>
  <svg class="outline">
    <path class="shadow" :d="d" />
    <path :d="d" />
  </svg>
</template>

<style scoped>
.outline {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

path {
  fill: none;
  stroke: #fff;
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
}

.shadow {
  stroke: rgb(0 0 0 / 0.6);
  stroke-width: 3.5;
  stroke-dasharray: none;
}
</style>
