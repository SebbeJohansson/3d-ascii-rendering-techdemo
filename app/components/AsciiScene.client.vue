<script setup lang="ts">
// No 3D engine here: the scene is ray traced on the CPU, one ray per character.
import type { Environment } from '~/environments'
import { CAMERA_FOV, orbitView, panView, zoomView, type CameraView } from '~/lib/camera'
import { hexToCss } from '~/lib/color'
import { createFrameMeter, type FramePerf } from '~/lib/frameMeter'
import { createGlyphRenderer } from '~/lib/glyphRenderer'
import type { Camera } from '~/lib/raycaster'
import { createMainThreadTracer, createWorkerTracer, type TracedFrame, type Tracer } from '~/lib/tracers'

const props = defineProps<{
  env: Environment
  seed: number
  size: number
  color: boolean
  /** Fill each cell with its surface color and draw the character in a shade of it. */
  cellBackground: boolean
  /** Draw characters from a pre-rendered glyph atlas instead of fillText. */
  atlas: boolean
  /** Spread each frame's ink over the whole character ramp. */
  stretch: boolean
  /** Draw edges and silhouettes as line characters. */
  outlines: boolean
  /** Ray trace in a pool of Web Workers instead of on the main thread. */
  worker: boolean
  /** Character height in CSS pixels. Smaller characters mean more cells and more detail. */
  fontSize: number
}>()

const emit = defineEmits<{
  stats: [stats: string]
  perf: [perf: FramePerf]
  grid: [grid: { cols: number, rows: number }]
}>()

const container = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const skyCss = computed(() => hexToCss(props.env.sky))

const view = useCameraView(props.env)
const glyphs = createGlyphRenderer()
const meter = createFrameMeter(perf => emit('perf', perf))
let tracer: Tracer | undefined
let ctx: CanvasRenderingContext2D | undefined
let resizeObserver: ResizeObserver | undefined
let frameId = 0
let dirty = true
let cols = 0
let rows = 0
let width = 0
let height = 0
/** Last traced frame, kept so style toggles can redraw without tracing again. */
let last: TracedFrame | undefined

function startTracer() {
  tracer?.dispose()
  const events = {
    onScene: (summary: string) => emit('stats', `${summary} · CPU ray tracer · ${tracer!.label}`),
    onFrame,
  }
  tracer = props.worker ? createWorkerTracer(events) : createMainThreadTracer(events)
  rebuild()
}

function rebuild() {
  tracer!.setScene(props.env.id, props.seed, props.size)
  dirty = true
}

function onFrame(frame: TracedFrame) {
  // Traced for an old window size: throw it away and trace again.
  if (frame.cols !== cols || frame.rows !== rows) {
    dirty = true
    return
  }
  last = frame
  const start = performance.now()
  draw()
  const drawMs = performance.now() - start
  meter.frame(frame.traceMs + drawMs, { trace: frame.traceMs, draw: drawMs })
}

function draw() {
  if (!ctx || !last) return
  const { env, color, cellBackground, atlas, stretch, outlines } = props
  glyphs.draw(ctx, last, { sky: env.sky, color, cellBackground, atlas, stretch, outlines, fogNear: env.fogNear, fogFar: env.fogFar })
}

function resize() {
  if (!container.value || !canvas.value || !ctx) return
  width = container.value.clientWidth
  height = container.value.clientHeight
  ;({ cols, rows } = glyphs.resize(canvas.value, ctx, width, height, props.fontSize))
  emit('grid', { cols, rows })
  dirty = true
}

function camera(): Camera {
  // Copy out of the reactive state: proxies can't be posted to a worker.
  const { position, target } = view.value
  return { position: [...position], target: [...target], fov: CAMERA_FOV, aspect: width / height }
}

// Only re-trace when something changed: a still environment is static between camera moves.
function tick() {
  frameId = requestAnimationFrame(tick)
  meter.tick()
  // Animated environments change every frame, so keep tracing.
  if (props.env.animate) dirty = true
  // One frame in flight at a time. `dirty` stays set, so the next one goes out when it lands.
  if (!dirty || !cols || !tracer || tracer.busy) return
  dirty = false
  tracer.render(camera(), cols, rows, performance.now() / 1000)
}

// Mouse controls: left drag orbits, right or shift drag pans, wheel zooms.
let drag: { x: number, y: number, pan: boolean } | undefined

function setView(next: CameraView) {
  view.value = next
  dirty = true
}

function onPointerDown(e: PointerEvent) {
  canvas.value!.setPointerCapture(e.pointerId)
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }
}

function onPointerMove(e: PointerEvent) {
  if (!drag) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  drag.x = e.clientX
  drag.y = e.clientY
  setView(drag.pan ? panView(view.value, dx, dy, height) : orbitView(view.value, dx, dy, height))
}

function onPointerUp() {
  drag = undefined
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  setView(zoomView(view.value, e.deltaY))
}

onMounted(async () => {
  // .client components render their template after mount; wait for the refs to exist.
  await nextTick()
  ctx = canvas.value!.getContext('2d')!
  startTracer()
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container.value!)
  resize()
  tick()
})

watch(() => [props.env, props.seed, props.size], rebuild)
watch(() => [props.color, props.atlas, props.cellBackground, props.stretch, props.outlines], draw)
watch(() => props.fontSize, resize)
watch(() => props.worker, startTracer)

onBeforeUnmount(() => {
  cancelAnimationFrame(frameId)
  resizeObserver?.disconnect()
  tracer?.dispose()
})
</script>

<template>
  <div ref="container" class="scene">
    <canvas
      ref="canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
      @contextmenu.prevent
    />
  </div>
</template>

<style scoped>
.scene {
  position: absolute;
  inset: 0;
  background: v-bind(skyCss);
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}
</style>
