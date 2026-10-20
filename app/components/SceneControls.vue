<script setup lang="ts">
import { ENVIRONMENTS, type Environment } from '~/environments'
import type { FramePerf } from '~/lib/frameMeter'
import type { ViewMode } from '~/composables/useBenchmark'
import { DAY_LENGTH, formatTimeOfDay } from '~/environments/lighting'
import { getPlayer, PLAYERS, type PlayerKind } from '~/players'

const props = defineProps<{
  env: Environment
  /** Which view this panel sits on, so the tabs can link to the others. */
  mode: ViewMode
  stats?: string
  perf?: FramePerf
}>()

const { seed, size } = useSceneSettings(props.env)
const playerKind = usePlayerKind()
const boxMode = useBoxMode()
const { boxes, fall, clear: clearBoxes } = useBoxes(props.env)
const gravity = useBoxGravity()
const stick = useBoxStick()
watch(gravity, on => on && fall())

/** Orbit, the boxes mode (orbit where a click drops a box) or a player: one at a time. */
function play(kind: PlayerKind | null, boxes = false) {
  playerKind.value = kind
  boxMode.value = boxes
}
const { time: timeOfDay, cycling } = useTimeOfDay()

const benchmark = useBenchmark()
/** The benchmark for this environment, running or finished. */
const run = computed(() => (benchmark.state.value?.env === props.env.id ? benchmark.state.value : null))

function randomize() {
  seed.value = Math.floor(Math.random() * 1e6)
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
      <NuxtLink :to="viewPath(env.id, 'lens')" :class="{ active: mode === 'lens' }">
        Lens
      </NuxtLink>
    </nav>
    <nav>
      <button type="button" :class="{ active: !playerKind && !boxMode }" @click="play(null)">
        Orbit
      </button>
      <button type="button" :class="{ active: boxMode }" @click="play(null, true)">
        Boxes
      </button>
      <button v-for="p in PLAYERS" :key="p.id" type="button" :class="{ active: playerKind === p.id }" @click="play(p.id)">
        {{ p.name }}
      </button>
    </nav>
    <p v-if="playerKind" class="keys">
      <kbd>W</kbd><kbd>S</kbd> speed · <kbd>A</kbd><kbd>D</kbd> turn
      <template v-if="getPlayer(playerKind).flies">
        · <kbd>Space</kbd> up · <kbd>Shift</kbd> down
      </template>
      · drag to look · scroll to zoom · click to name what's there
    </p>
    <p v-else class="keys">
      drag to orbit · right-drag or <kbd>Shift</kbd> + drag to pan · scroll to zoom · <template v-if="boxMode">
        {{ stick ? 'click a face to stick a box onto it' : 'click to drop a box onto what\'s there' }} · <kbd>Shift</kbd> + click drops it in the air
      </template>
      <template v-else>
        click to name what's there
      </template>
    </p>
    <template v-if="boxMode">
      <label class="toggle">
        <input v-model="gravity" type="checkbox">
        Gravity
      </label>
      <label class="toggle">
        <input v-model="stick" type="checkbox">
        Stick to faces
      </label>
      <button v-if="boxes.length" type="button" class="link" @click="clearBoxes">
        Clear {{ boxes.length }} {{ boxes.length === 1 ? 'box' : 'boxes' }}
      </button>
    </template>
    <label>
      Seed
      <input v-model.number="seed" type="number">
    </label>
    <label>
      Size: {{ env.size.label(size) }}
      <input v-model.number="size" type="range" :min="env.size.min" :max="env.size.max">
    </label>
    <label>
      Time: {{ formatTimeOfDay(timeOfDay) }}
      <input v-model.number="timeOfDay" type="range" min="0" max="1" step="0.001">
    </label>
    <label class="toggle">
      <input v-model="cycling" type="checkbox">
      Day and night cycle ({{ DAY_LENGTH / 60 }} min day)
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
    <template v-if="run?.running">
      <p class="keys">
        Benchmarking {{ stepName(run.queue[0]!) }} · {{ Math.floor(run.elapsed) }} / {{ benchmark.duration }} s
      </p>
      <button type="button" class="secondary" @click="benchmark.stop()">
        Stop benchmark
      </button>
    </template>
    <button v-else type="button" class="secondary" @click="benchmark.start(env)">
      Benchmark 3D vs ASCII renderers
    </button>
    <div v-if="run && !run.running && run.results.length" class="results">
      <table>
        <thead>
          <tr><th /><th>fps</th><th>ms</th><th>worst</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in run.results" :key="stepName(r)">
            <th>{{ stepName(r) }} <small>{{ r.label }}</small></th>
            <td>{{ Math.round(r.fps) }}</td>
            <td>{{ r.ms.toFixed(1) }}</td>
            <td>{{ Math.round(r.worstFps) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="keys">
        {{ run.queue.length ? 'Stopped early. ' : '' }}Same camera path, seed and size for all. For 3D and shader ASCII, ms is the CPU's part only: the GPU's isn't measurable here.
      </p>
      <button type="button" class="link" @click="benchmark.clear()">
        Clear results
      </button>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 16px;
  left: 16px;
  /* Scrolls when the settings don't fit, e.g. the lens view's on a short window. */
  max-height: calc(100% - 32px);
  overflow-y: auto;
  /* Never sideways: a row that doesn't fit wraps instead (see nav). */
  overflow-x: hidden;
  box-sizing: border-box;
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

/* :deep so settings components in the slot (LensSettings) get the same tabs. */
.panel :deep(nav) {
  display: flex;
  /* Five environments don't fit on one row; they wrap onto a second. */
  flex-wrap: wrap;
  gap: 4px;
  padding: 3px;
  background: rgb(0 0 0 / 0.08);
  border-radius: 7px;
}

.panel :deep(nav a),
.panel :deep(nav button) {
  flex: 1 0 auto;
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

.panel :deep(nav .active) {
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

.toggle {
  flex-direction: row !important;
  align-items: center;
}

.secondary {
  padding: 7px;
  border: 1px solid #2b5d8a;
  border-radius: 6px;
  background: white;
  color: #2b5d8a;
  font-weight: 600;
  cursor: pointer;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

table {
  border-collapse: collapse;
  font: 12px ui-monospace, Menlo, Consolas, monospace;
}

th, td {
  padding: 2px 4px;
  text-align: right;
}

tbody th {
  text-align: left;
}

small {
  display: block;
  font-weight: 400;
  color: #777;
}

.link {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  font-size: 12px;
  color: #2b5d8a;
  text-decoration: underline;
  cursor: pointer;
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
