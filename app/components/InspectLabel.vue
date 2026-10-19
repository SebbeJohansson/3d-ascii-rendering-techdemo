<script setup lang="ts">
import type { Picked } from '~/lib/tracers'

// What a click landed on, shown beside the point clicked.
defineProps<{
  picked: Picked
  /** Where the click landed, in CSS pixels within the view. */
  x: number
  y: number
  /** Open toward the left, for clicks on the right half, so it stays on screen. */
  left: boolean
}>()
</script>

<template>
  <div class="inspect" :class="{ left }" :style="{ left: `${x}px`, top: `${y}px` }">
    <strong>{{ picked.label }}</strong>
    <span>{{ Math.round(picked.distance) }} m away</span>
  </div>
</template>

<style scoped>
.inspect {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  transform: translate(12px, 12px);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.9);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.2);
  color: #333;
  font-size: 13px;
  white-space: nowrap;
  pointer-events: none;
}

.inspect.left {
  transform: translate(calc(-100% - 12px), 12px);
}

span {
  font-size: 12px;
  color: #666;
}
</style>
