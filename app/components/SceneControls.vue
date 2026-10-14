<script setup lang="ts">
import { ENVIRONMENTS, type Environment } from '~/environments'
import type { FramePerf } from '~/lib/frameMeter'

export type ViewMode = '3d' | 'ascii' | 'split'

const props = defineProps<{
  env: Environment
  /** Which view this panel sits on, so the tabs can link to the others. */
  mode: ViewMode
  stats?: string
  perf?: FramePerf
}>()

const { seed, size } = useSceneSettings(props.env)

function randomize() {
  seed.value = Math.floor(Math.random() * 1e6)
}

function viewPath(envId: string, mode: ViewMode) {
  return mode === '3d' ? `/${envId}` : `/${envId}/${mode}`
}
</script>

<template>
  <aside class="panel">
    <nav>
      <NuxtLink v-for="e in ENVIRONMENTS" :key="e.id" :to="viewPath(e.id, mode)" :class="{ active: e.id === env.id }">
        {{ e.name }}
      </NuxtLink>
    </nav>
    <nav>
      <NuxtLink :to="viewPath(env.id, '3d')" :class="{ active: mode === '3d' }">
        3D
      </NuxtLink>
      <NuxtLink :to="viewPath(env.id, 'ascii')" :class="{ active: mode === 'ascii' }">
        ASCII
      </NuxtLink>
      <NuxtLink :to="viewPath(env.id, 'split')" :class="{ active: mode === 'split' }">
        Split
      </NuxtLink>
    </nav>
    <label>
      Seed
      <input v-model.number="seed" type="number">
    </label>
    <label>
      Size: {{ env.size.label(size) }}
      <input v-model.number="size" type="range" :min="env.size.min" :max="env.size.max">
    </label>
    <slot />
    <button type="button" @click="randomize">
      New {{ env.name.toLowerCase() }}
    </button>
    <p v-if="stats" class="stats">
      {{ stats }}
    </p>
    <p v-if="perf" class="perf">
      <span>{{ perf.fps >= 1 ? `${Math.round(perf.fps)} fps` : 'idle' }}</span>
      <span>{{ perf.ms.toFixed(1) }} ms/frame</span>
    </p>
    <p v-if="perf?.parts" class="perf parts">
      <span v-for="(ms, name) in perf.parts" :key="name">{{ name }} {{ ms.toFixed(1) }}</span>
    </p>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 16px;
  left: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 220px;
  padding: 14px 16px;
  background: rgb(255 255 255 / 0.85);
  backdrop-filter: blur(6px);
  border-radius: 10px;
  box-shadow: 0 4px 20px rgb(0 0 0 / 0.15);
}

nav {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: rgb(0 0 0 / 0.08);
  border-radius: 7px;
}

nav a {
  flex: 1;
  padding: 5px;
  border-radius: 5px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  color: #333;
  text-decoration: none;
}

nav a.active {
  background: white;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
}

.panel :deep(label) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

button {
  padding: 8px;
  border: 0;
  border-radius: 6px;
  background: #2b5d8a;
  color: white;
  font-weight: 600;
  cursor: pointer;
}

.perf {
  display: flex;
  justify-content: space-between;
  margin: 0;
  font: 600 12px ui-monospace, Menlo, Consolas, monospace;
  color: #2b5d8a;
}

.perf.parts {
  font-weight: 400;
  color: #555;
}

.stats {
  margin: 0;
  font-size: 12px;
  color: #555;
}
</style>
