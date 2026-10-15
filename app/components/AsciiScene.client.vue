<script setup lang="ts">
// No 3D engine here: the scene is ray traced on the CPU, one ray per character.
import type { Environment } from '~/environments'
import { lightingAt } from '~/environments/lighting'
import { CAMERA_FOV, orbitView, panView, zoomView, type CameraView } from '~/lib/camera'
import { hexToCss } from '~/lib/color'
import { createFrameMeter, type FramePerf } from '~/lib/frameMeter'
import { createGlyphRenderer } from '~/lib/glyphRenderer'
import { createGpuTracer } from '~/lib/gpu/gpuTracer'
import { lensMask, type Lens } from '~/lib/lens'
import type { Camera } from '~/lib/raycaster'
import type { PlayerPose } from '~/players'
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
  /** Darken corners and creases with ambient occlusion rays. */
  occlusion: boolean
  /** Ray trace in a pool of Web Workers instead of on the main thread. */
  worker: boolean
  /** 'gpu' ray traces with WebGPU compute; anything else on the CPU (see `worker`). */
  method: AsciiMethod
  /** Character height in CSS pixels. Smaller characters mean more cells and more detail. */
  fontSize: number
  /**
   * Show only the cells inside this lens, over a transparent background, to sit on top of
   * the 3D view. Mouse input then goes to whatever is underneath.
   */
  lens?: Lens
}>()

const emit = defineEmits<{
  stats: [stats: string]
  perf: [perf: FramePerf]
  grid: [grid: { cols: number, rows: number }]
}>()

const container = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const { time: timeOfDay } = useTimeOfDay()
const lighting = computed(() => lightingAt(timeOfDay.value, props.env.sky))
const skyCss = computed(() => hexToCss(lighting.value.sky))

const view = useCameraView(props.env)
const playerKind = usePlayerKind()
const playerPose = usePlayerPose(props.env)
const chaseCamera = useChaseCamera()
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
/** The camera of the frame being traced, then of `last`: the lens needs it to place cells. */
let tracing: Camera | undefined
let lastCamera: Camera | undefined
let cellWidth = 0
let cellHeight = 0
let mask = new Uint8Array(0)

function startTracer() {
  tracer?.dispose()
  const events = {
    onScene: (summary: string) => emit('stats', `${summary} · ${props.method === 'gpu' ? 'GPU' : 'CPU'} ray tracer · ${tracer!.label}`),
    onFrame,
  }
  tracer = props.method === 'gpu' ? createGpuTracer(events) : props.worker ? createWorkerTracer(events) : createMainThreadTracer(events)
  tracer.setPlayer(playerKind.value, props.seed)
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
  lastCamera = tracing
  const start = performance.now()
  draw()
  const drawMs = performance.now() - start
  meter.frame(frame.traceMs + drawMs, { trace: frame.traceMs, draw: drawMs })
}

function draw() {
  if (!ctx || !last) return
  const { env, color, cellBackground, atlas, stretch, outlines, lens } = props
  if (lens && lastCamera) {
    if (mask.length !== cols * rows) mask = new Uint8Array(cols * rows)
    lensMask(lens, lastCamera, last.depths, cols, rows, cellWidth, cellHeight, mask)
  }
  glyphs.draw(ctx, last, { sky: lighting.value.sky, color, cellBackground, atlas, stretch, outlines, fogNear: env.fogNear, fogFar: env.fogFar, mask: lens && mask })
}

function resize() {
  if (!container.value || !canvas.value || !ctx) return
  width = container.value.clientWidth
  height = container.value.clientHeight
  ;({ cols, rows, cellWidth, cellHeight } = glyphs.resize(canvas.value, ctx, width, height, props.fontSize))
  emit('grid', { cols, rows })
  dirty = true
}

function camera(): Camera {
  // Copy out of the reactive state: proxies can't be posted to a worker.
  const { position, target } = view.value
  return { position: [...position], target: [...target], fov: CAMERA_FOV, aspect: width / height }
}

function player(): PlayerPose | undefined {
  const pose = playerPose.value
  return pose && { position: [...pose.position], heading: pose.heading }
}

// Only re-trace when something changed: a still environment is static between camera moves.
function tick() {
  frameId = requestAnimationFrame(tick)
  meter.tick()
  // Animated environments change every frame, so keep tracing.
  if (props.env.animate || playerPose.value) dirty = true
  // One frame in flight at a time. `dirty` stays set, so the next one goes out when it lands.
  if (!dirty || !cols || !tracer || tracer.busy) return
  dirty = false
  tracing = camera()
  tracer.render(tracing, cols, rows, performance.now() / 1000, player(), timeOfDay.value, props.occlusion)
}

// Mouse controls: left drag orbits, right or shift drag pans, wheel zooms. Around a spawned
// player, any drag orbits and the wheel zooms, both through its chase camera.
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
  if (playerPose.value) chaseCamera.orbit(dx, dy, height)
  else setView(drag.pan ? panView(view.value, dx, dy, height) : orbitView(view.value, dx, dy, height))
}

function onPointerUp() {
  drag = undefined
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  if (playerPose.value) chaseCamera.zoom(e.deltaY)
  else setView(zoomView(view.value, e.deltaY))
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
watch(() => props.occlusion, () => (dirty = true))
watch(() => props.fontSize, resize)
// The camera can also be moved from elsewhere (the 3D half of the split view).
watch(view, () => (dirty = true))
watch(timeOfDay, () => (dirty = true))
// The lens moves without the scene changing: redraw the last frame, no new trace needed.
watch(() => props.lens, draw, { deep: true })
watch(() => [props.worker, props.method], startTracer)
watch([playerKind, () => props.seed], () => {
  tracer?.setPlayer(playerKind.value, props.seed)
  dirty = true
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frameId)
  resizeObserver?.disconnect()
  tracer?.dispose()
})
</script>

<template>
  <div ref="container" class="scene" :class="{ overlay: lens }">
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

.overlay {
  background: none;
  pointer-events: none;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}
</style>
