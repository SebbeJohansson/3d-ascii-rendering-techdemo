<script setup lang="ts">
// No 3D engine here: the scene is ray traced, one ray per character, or with method 'pixels'
// one ray per pixel on the GPU, drawn onto the canvas without characters.
import type { Environment } from '~/environments'
import { lightingAt } from '~/environments/lighting'
import { CAMERA_FOV, orbitView, panView, zoomView, type CameraView } from '~/lib/camera'
import { createFrameMeter, type FramePerf } from '~/lib/frameMeter'
import { createGlyphRenderer } from '~/lib/glyphRenderer'
import { hexToBytes, hexToCss } from '~/lib/color'
import { createGpuTracer, type GpuGlyphs, type GpuTracer } from '~/lib/gpu/gpuTracer'
import { lensMask, type Lens } from '~/lib/lens'
import type { Camera } from '~/lib/raycaster'
import type { PlayerPose } from '~/players'
import { createMainThreadTracer, createWorkerTracer, upscaleFrame, type Picked, type TracedFrame, type Tracer } from '~/lib/tracers'

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
  /** Trace a coarser grid while the camera is dragged or zoomed, and sharpen when it stops. */
  coarseDrag: boolean
  /** Ray trace in a pool of Web Workers instead of on the main thread. */
  worker: boolean
  /**
   * 'gpu' ray traces with WebGPU compute, 'pixels' too but at one ray per pixel; anything else
   * on the CPU (see `worker`). Mount a new component to switch to or from 'pixels': its canvas
   * holds a WebGPU context instead of a 2D one.
   */
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
/** Over `canvas`: the atlas path draws here with WebGL2. Lets pointer events through. */
const glCanvas = ref<HTMLCanvasElement>()
/** Over both: the GPU ray tracer draws characters here itself, without reading frames back. */
const gpuCanvas = ref<HTMLCanvasElement>()
const { time: timeOfDay } = useTimeOfDay()
const lighting = computed(() => lightingAt(timeOfDay.value, props.env.sky))
const skyCss = computed(() => hexToCss(lighting.value.sky))

const view = useCameraView(props.env)
const playerKind = usePlayerKind()
const playerPose = usePlayerPose(props.env)
const chaseCamera = useChaseCamera()
let glyphs = createGlyphRenderer()
const meter = createFrameMeter(perf => emit('perf', perf))
let tracer: Tracer | undefined
/** `tracer` when it is the GPU one that can draw characters itself. */
let gpuGlyphTracer: GpuTracer | undefined
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
/** The camera is being moved by hand: drag, or a wheel turned in the last moment. */
let moving = false
let wheelTimer: ReturnType<typeof setTimeout> | undefined
/** Whether the frame in flight, or else the last one, was traced on the coarse grid. */
let tracedCoarse = false

const pixels = props.method === 'pixels'
/** Full resolution traces at most this many rays, past which a 4K screen at 2x would be 33M. */
const MAX_PIXELS = 8_300_000
/** While moving, full resolution traces one ray per this many pixels across. */
const PIXELS_COARSE = 3

/** The grid traced while moving: cells of at least ~10 px, and at least twice as big as usual. */
function coarseGrid() {
  const factor = pixels ? PIXELS_COARSE : Math.max(2, Math.ceil(10 / props.fontSize))
  return { cols: Math.ceil(cols / factor), rows: Math.ceil(rows / factor) }
}

function startTracer() {
  tracer?.dispose()
  const events = {
    onScene: (summary: string) => {
      // A tracer that wasn't ready yet (the GPU device starts asynchronously) skipped the
      // frames asked for until now: trace again.
      dirty = true
      emit('stats', `${summary} · ${pixels ? 'GPU ray tracer, per pixel' : props.method === 'gpu' ? 'GPU ray tracer' : 'CPU ray tracer'} · ${tracer!.label}`)
    },
    onFrame,
  }
  gpuGlyphTracer = props.method === 'gpu' && !pixels ? createGpuTracer(events, gpuCanvas.value, 'glyphs') : undefined
  tracer = pixels
    ? createGpuTracer(events, canvas.value)
    : gpuGlyphTracer ?? (props.worker ? createWorkerTracer(events) : createMainThreadTracer(events))
  tracer.setPlayer(playerKind.value, props.seed)
  tracer.setBoxes(boxes.value)
  rebuild()
}

function rebuild() {
  inspected.value = undefined
  tracer!.setScene(props.env.id, props.seed, props.size)
  dirty = true
}

function onFrame(frame: TracedFrame) {
  if (frame.cols !== cols || frame.rows !== rows) {
    const coarse = coarseGrid()
    // Traced for an old window size: throw it away and trace again.
    if (frame.cols !== coarse.cols || frame.rows !== coarse.rows) {
      dirty = true
      return
    }
    // Frames the GPU drew are already on the canvas, stretched by the GPU.
    if (!frame.presented) frame = upscaleFrame(frame, cols, rows)
  }
  if (frame.presented) {
    // The GPU's canvas sits on top; clear what the CPU drew underneath, for the frames it lets through.
    if (ctx) glyphs.clear(ctx)
    last = undefined
    meter.frame(frame.traceMs, frame.stages ?? { trace: frame.traceMs })
    return
  }
  last = frame
  lastCamera = tracing
  const start = performance.now()
  draw()
  const drawMs = performance.now() - start
  meter.frame(frame.traceMs + drawMs, { ...(frame.stages ?? { trace: frame.traceMs }), draw: drawMs })
}

function draw() {
  // Drawn by the GPU, or nothing traced yet: trace again with the new settings.
  if (!last) {
    dirty = true
    return
  }
  if (!ctx) return
  const { env, color, cellBackground, atlas, stretch, outlines, lens } = props
  if (lens && lastCamera) {
    if (mask.length !== cols * rows) mask = new Uint8Array(cols * rows)
    lensMask(lens, lastCamera, last.depths, cols, rows, cellWidth, cellHeight, mask)
  }
  glyphs.draw(ctx, last, { sky: lighting.value.sky, color, cellBackground, atlas, stretch, outlines, fogNear: env.fogNear, fogFar: env.fogFar, mask: lens && mask })
}

function resize() {
  if (!container.value || !canvas.value) return
  width = container.value.clientWidth
  height = container.value.clientHeight
  if (pixels) {
    let dpr = Math.min(window.devicePixelRatio, 2)
    dpr = Math.min(dpr, Math.sqrt(MAX_PIXELS / Math.max(1, width * height)))
    cols = canvas.value.width = Math.max(1, Math.round(width * dpr))
    rows = canvas.value.height = Math.max(1, Math.round(height * dpr))
    emit('grid', { cols, rows })
    dirty = true
    return
  }
  if (!ctx) return
  ;({ cols, rows, cellWidth, cellHeight } = glyphs.resize(canvas.value, ctx, width, height, props.fontSize))
  if (gpuCanvas.value) {
    gpuCanvas.value.width = canvas.value.width
    gpuCanvas.value.height = canvas.value.height
  }
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
  tracedCoarse = moving && props.coarseDrag
  const grid = tracedCoarse ? coarseGrid() : { cols, rows }
  gpuGlyphTracer?.setGlyphs(gpuGlyphs())
  tracer.render(tracing, grid.cols, grid.rows, performance.now() / 1000, player(), timeOfDay.value, props.occlusion)
}

/**
 * How the GPU tracer should draw characters itself, or null where the CPU has to: the lens
 * and stretched contrast need the whole frame, and fillText is the CPU's own way to draw.
 */
function gpuGlyphs(): GpuGlyphs | null {
  const { env, color, cellBackground, atlas, stretch, outlines, lens } = props
  if (!atlas || stretch || lens) return null
  return { ...glyphs.layout(), color, cellBackground, outlines, fogNear: env.fogNear, fogFar: env.fogFar, sky: hexToBytes(lighting.value.sky) }
}

// Mouse controls: left drag orbits, right or shift drag pans, wheel zooms. Around a spawned
// player, any drag orbits and the wheel zooms, both through its chase camera. A left click
// that barely moves names what is under the pointer. In the boxes mode a click drops a box,
// in the air with Shift.
let drag: { x: number, y: number, pan: boolean, startX: number, startY: number } | undefined
/** A press that moves less than this many pixels is a click, not a drag. */
const CLICK_SLOP = 4
/** What the last click landed on, shown beside where it landed until the next press. */
const inspected = ref<Picked & { x: number, y: number }>()
const boxMode = useBoxMode()
const { boxes, drop } = useBoxes(props.env)

function setView(next: CameraView) {
  view.value = next
  dirty = true
}

function onPointerDown(e: PointerEvent) {
  canvas.value!.setPointerCapture(e.pointerId)
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, startX: e.clientX, startY: e.clientY }
  moving = true
  inspected.value = undefined
}

/** The camera came to rest: trace again at full resolution if the last frame was coarse. */
function stopMoving() {
  moving = false
  if (tracedCoarse) dirty = true
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

function onPointerUp(e: PointerEvent) {
  const click = !drag?.pan || (boxMode.value && e.shiftKey)
  if (drag && click && e.type === 'pointerup' && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < CLICK_SLOP) void inspect(e)
  drag = undefined
  stopMoving()
}

/**
 * Casts a ray through the clicked point, with the camera of the frame on screen, and names
 * what it hits or drops a box there.
 */
async function inspect(e: PointerEvent) {
  if (!tracer || !canvas.value) return
  const rect = canvas.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const picked = await tracer.pick(lastCamera ?? camera(), x / rect.width, y / rect.height)
  if (boxMode.value) {
    if (picked && picked.kind !== 'player') drop(picked, e.shiftKey)
    return
  }
  inspected.value = picked ? { ...picked, x, y } : undefined
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  inspected.value = undefined
  // A wheel has no "up" event: count it as moving until it has been still for a moment.
  moving = true
  clearTimeout(wheelTimer)
  wheelTimer = setTimeout(() => !drag && stopMoving(), 150)
  if (playerPose.value) chaseCamera.zoom(e.deltaY)
  else setView(zoomView(view.value, e.deltaY))
}

onMounted(async () => {
  // .client components render their template after mount; wait for the refs to exist.
  await nextTick()
  if (!pixels) {
    ctx = canvas.value!.getContext('2d')!
    glyphs = createGlyphRenderer(glCanvas.value)
  }
  startTracer()
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container.value!)
  resize()
  tick()
})

watch(() => [props.env, props.seed, props.size], rebuild)
watch(boxes, b => tracer?.setBoxes(b))
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
  clearTimeout(wheelTimer)
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
    <canvas v-if="!pixels" ref="glCanvas" class="glyphs" />
    <canvas v-if="!pixels" ref="gpuCanvas" class="glyphs" />
    <InspectLabel v-if="inspected" :picked="inspected" :x="inspected.x" :y="inspected.y" :left="inspected.x > width / 2" />
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

.glyphs {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
</style>
