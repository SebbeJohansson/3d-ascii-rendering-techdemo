<script setup lang="ts">
import { ENVIRONMENTS, type Environment } from '~/environments'
import type { FramePerf } from '~/lib/frameMeter'
import { getPlayer, PLAYERS } from '~/players'

export type ViewMode = '3d' | 'ascii' | 'split'

const props = defineProps<{
  env: Environment
  /** Which view this panel sits on, so the tabs can link to the others. */
  mode: ViewMode
  stats?: string
  perf?: FramePerf
}>()

const { seed, size } = useSceneSettings(props.env)
const playerKind = usePlayerKind()

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
    <nav>
      <button type="button" :class="{ active: !playerKind }" @click="playerKind = null">
        Orbit
      </button>
      <button v-for="p in PLAYERS" :key="p.id" type="button" :class="{ active: playerKind === p.id }" @click="playerKind = p.id">
        {{ p.name }}
      </button>
    </nav>
    <p v-if="playerKind" class="keys">
      <kbd>W</kbd><kbd>S</kbd> speed · <kbd>A</kbd><kbd>D</kbd> turn
      <template v-if="getPlayer(playerKind).flies">
        · <kbd>Space</kbd> up · <kbd>Shift</kbd> down
      </template>
      · drag to look · scroll to zoom
    </p>
    <p v-else class="keys">
      drag to orbit · right-drag or <kbd>Shift</kbd> + drag to pan · scroll to zoom
    </p>
    <label>
      Seed
      <input v-model.number="seed" type="number">
    </label>
    <label>
      Size: {{ env.size.label(size) }}
      <input v-model.number="size" type="range" :min="env.size.min" :max="env.size.max">
    </label>
    <slot />
    <button type="button" class="primary" @click="randomize">
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

nav a,
nav button {
  flex: 1;
  padding: 5px;
  border: 0;
  background: none;
  font-family: inherit;
  cursor: pointer;
  border-radius: 5px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  color: #333;
  text-decoration: none;
}

nav .active {
  background: white;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
}

.panel :deep(label) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.primary {
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

.keys {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: #555;
}

kbd {
  padding: 1px 4px;
  margin-right: 2px;
  border: 1px solid #bbb;
  border-radius: 3px;
  background: white;
  font: 11px ui-monospace, Menlo, Consolas, monospace;
}

.stats {
  margin: 0;
  font-size: 12px;
  color: #555;
}
</style>
