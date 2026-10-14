<script setup lang="ts">
// No 3D engine here: the city is ray traced on the CPU, one ray per character.
import type { Camera, RaycastScene } from '~/utils/raycaster'
import type { WorkerRequest, WorkerResponse } from '~/workers/raytrace.worker'
import { CAMERA_FOV, MAX_DISTANCE, MAX_POLAR_ANGLE, MIN_DISTANCE, type Vec3 } from '~/composables/useCitySettings'

const props = defineProps<{
  seed: number
  blocks: number
  color: boolean
  /** Draw characters by copying from a pre-rendered glyph atlas instead of fillText. */
  atlas: boolean
  /** Ray trace in a pool of Web Workers instead of on the main thread. */
  worker: boolean
  /** Fill each cell with its surface color and draw the character in a shade of it. */
  cellBackground: boolean
  /** Character height in CSS pixels. Smaller characters mean more cells and more detail. */
  fontSize: number
}>()

const emit = defineEmits<{
  stats: [stats: { buildings: number, backend: string }]
  perf: [perf: FramePerf]
  grid: [grid: { cols: number, rows: number }]
}>()

const container = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()

// Sparse to dense. The first character is a space so the sky stays blank.
const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'
// Line height relative to font size, so rows don't touch.
const LINE_SPACING = 7 / 6
const FONT_FAMILY = 'ui-monospace, Menlo, Consolas, monospace'
// Same sky as the 3D view. Characters are blended onto it.
const SKY_R = (SKY_COLOR >> 16) & 255
const SKY_G = (SKY_COLOR >> 8) & 255
const SKY_B = SKY_COLOR & 255
const SKY_CSS = `#${SKY_COLOR.toString(16).padStart(6, '0')}`
// Dark ink for the single-color mode: readable on the light sky.
const MONO_R = 0x1D
const MONO_G = 0x2B
const MONO_B = 0x38
const MONO_COLOR = '#1d2b38'
// Ink (0..255) to ramp index, so the draw loops do one table lookup per cell.
const GLYPH = new Uint8Array(256).map((_, v) => Math.min(RAMP.length - 1, Math.floor((v / 255) * RAMP.length)))

const view = useCameraView()
let scene: RaycastScene | undefined
// Leave one core for the page itself. Past ~8 workers the gains flatten out.
const WORKER_COUNT = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
let workers: Worker[] = []
/** Workers still tracing the current frame. 0 means no frame is in flight. */
let pending = 0
let frameStart = 0
let nextInk: Uint8Array = new Uint8Array(0)
let nextRgb: Uint8Array = new Uint8Array(0)
let ctx: CanvasRenderingContext2D | undefined
let resizeObserver: ResizeObserver | undefined
let frameId = 0
let dirty = true
let cols = 0
let rows = 0
let charWidth = 0
let lineHeight = 0
let width = 0
let height = 0
let ink: Uint8Array = new Uint8Array(0)
let rgb: Uint8Array = new Uint8Array(0)
const meter = createFrameMeter(perf => emit('perf', perf))

// Glyph atlas: every ramp character drawn once in white, then kept as alpha masks.
// Each frame writes glyph pixels straight into an ImageData buffer and shows it with one
// putImageData. Measured ~2x faster than fillText, and ~7x faster than stamping glyphs
// with drawImage (which runs per call in software when canvas isn't GPU-backed).
let glyphAlpha = new Uint8Array(0)
let atlasWidth = 0
let frame = new ImageData(1, 1)
let pixels = new Uint32Array(1)
let cellW = 0
let cellH = 0
let glyphW = 0
let glyphH = 0

function rebuild() {
  dirty = true
  if (workers.length) {
    scene = undefined
    for (const w of workers) post(w, { type: 'scene', seed: props.seed, blocks: props.blocks })
    return
  }
  const city = generateCity({ seed: props.seed, blocks: props.blocks, blockSize: BLOCK_SIZE, roadWidth: ROAD_WIDTH })
  scene = buildRaycastScene(city, props.blocks)
  emit('stats', { buildings: city.buildings.length, backend: 'CPU ray tracer · main thread' })
}

function startWorkers() {
  workers = Array.from({ length: WORKER_COUNT }, () => {
    const w = new Worker(new URL('../workers/raytrace.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<WorkerResponse>) => onWorkerMessage(e.data)
    return w
  })
  pending = 0
}

function stopWorkers() {
  for (const w of workers) w.terminate()
  workers = []
  pending = 0
}

function post(worker: Worker, message: WorkerRequest, transfer: Transferable[] = []) {
  worker.postMessage(message, transfer)
}

function onWorkerMessage(msg: WorkerResponse) {
  if (msg.type === 'scene') {
    // Every worker replies; they all built the same city.
    emit('stats', { buildings: msg.buildings, backend: `CPU ray tracer · ${workers.length} workers` })
    return
  }

  // Unpack this worker's interleaved rows into the full frame.
  const { cols: c, rowStart, rowStep } = msg
  if (nextInk.length === c * msg.rows) {
    for (let y = rowStart, row = 0; y < msg.rows; y += rowStep, row++) {
      nextInk.set(msg.ink.subarray(row * c, (row + 1) * c), y * c)
      nextRgb.set(msg.rgb.subarray(row * c * 3, (row + 1) * c * 3), y * c * 3)
    }
  }
  if (--pending > 0) return

  // Traced for an old window size: throw it away and trace again.
  if (c !== cols || msg.rows !== rows) {
    dirty = true
    return
  }
  // Wall-clock time across all workers, including messaging.
  const traceMs = performance.now() - frameStart
  ink = nextInk
  rgb = nextRgb
  const drawMs = timed(draw)
  meter.frame(traceMs + drawMs, { trace: traceMs, draw: drawMs })
}

function timed(fn: () => void) {
  const start = performance.now()
  fn()
  return performance.now() - start
}

function camera(): Camera {
  // Copy out of the reactive state: proxies can't be posted to a worker.
  const { position, target } = view.value
  return { position: [...position], target: [...target], fov: CAMERA_FOV, aspect: width / height }
}

function resize() {
  if (!container.value || !canvas.value || !ctx) return
  width = container.value.clientWidth
  height = container.value.clientHeight
  const dpr = Math.min(window.devicePixelRatio, 2)
  canvas.value.width = width * dpr
  canvas.value.height = height * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  lineHeight = Math.round(props.fontSize * LINE_SPACING)
  ctx.font = `${props.fontSize}px ${FONT_FAMILY}`
  ctx.textBaseline = 'top'

  // Snap cells to whole device pixels. With fractional cells (e.g. 2.25 px at 125% display
  // scaling) rounding makes every 4th gap 1 px wider, which shows up as regular vertical
  // and horizontal lines across the image.
  cellW = Math.max(1, Math.round(ctx.measureText('M').width * dpr))
  cellH = Math.max(1, Math.round(lineHeight * dpr))
  glyphW = cellW
  glyphH = cellH
  charWidth = cellW / dpr
  lineHeight = cellH / dpr

  cols = Math.max(1, Math.floor(canvas.value.width / cellW))
  rows = Math.max(1, Math.floor(canvas.value.height / cellH))
  ink = new Uint8Array(cols * rows)
  rgb = new Uint8Array(cols * rows * 3)

  // The atlas and frame buffer work in device pixels so glyphs stay sharp on high-DPI screens.
  atlasWidth = glyphW * RAMP.length
  const atlas = document.createElement('canvas')
  atlas.width = atlasWidth
  atlas.height = glyphH
  const atlasCtx = atlas.getContext('2d', { willReadFrequently: true })!
  atlasCtx.font = `${props.fontSize * dpr}px ${FONT_FAMILY}`
  atlasCtx.textBaseline = 'top'
  atlasCtx.fillStyle = '#fff'
  for (let g = 1; g < RAMP.length; g++) atlasCtx.fillText(RAMP[g]!, g * glyphW, 0)
  const rgba = atlasCtx.getImageData(0, 0, atlasWidth, glyphH).data
  glyphAlpha = new Uint8Array(atlasWidth * glyphH)
  for (let i = 0; i < glyphAlpha.length; i++) glyphAlpha[i] = rgba[i * 4 + 3]!
  frame = new ImageData(canvas.value.width, canvas.value.height)
  pixels = new Uint32Array(frame.data.buffer)

  emit('grid', { cols, rows })

  dirty = true
}

function draw() {
  if (!ctx) return
  if (props.atlas) drawWithAtlas()
  else drawWithFillText()
}

/**
 * The character's own color when cells have a background: a darker shade on light surfaces,
 * a lighter one on dark surfaces, so the glyph stays visible against its cell.
 */
function glyphShade(c: number, lightSurface: boolean) {
  return lightSurface ? (c * 0.6) | 0 : (c + (255 - c) * 0.35) | 0
}

function isLight(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 100
}

function drawWithFillText() {
  const backgrounds = props.color && props.cellBackground
  ctx!.fillStyle = SKY_CSS
  ctx!.fillRect(0, 0, width, height)
  if (!props.color) ctx!.fillStyle = MONO_COLOR

  let lastStyle = ''
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const g = GLYPH[ink[i]!]!
      if (g === 0) continue

      if (backgrounds) {
        const r = rgb[i * 3]!
        const gr = rgb[i * 3 + 1]!
        const b = rgb[i * 3 + 2]!
        const light = isLight(r, gr, b)
        ctx!.fillStyle = `rgb(${r},${gr},${b})`
        ctx!.fillRect(x * charWidth, y * lineHeight, charWidth, lineHeight)
        ctx!.fillStyle = `rgb(${glyphShade(r, light)},${glyphShade(gr, light)},${glyphShade(b, light)})`
        lastStyle = ''
      }
      else if (props.color) {
        // Quantize so consecutive cells can share a fillStyle.
        const style = `rgb(${rgb[i * 3]! & 0xf0},${rgb[i * 3 + 1]! & 0xf0},${rgb[i * 3 + 2]! & 0xf0})`
        if (style !== lastStyle) {
          ctx!.fillStyle = style
          lastStyle = style
        }
      }
      ctx!.fillText(RAMP[g]!, x * charWidth, y * lineHeight)
    }
  }
}

function drawWithAtlas() {
  // Copy everything the hot loop touches into locals: reading a Vue prop or a closure
  // variable per pixel is measurably slower than a local at 100k+ cells.
  const colored = props.color
  const backgrounds = colored && props.cellBackground
  const { width: frameW, height: frameH } = frame
  const px = pixels
  const alpha = glyphAlpha
  const cells = ink
  const colors = rgb
  const stride = atlasWidth
  const gw = glyphW
  const gh = glyphH
  // ImageData is RGBA in memory, so a little-endian Uint32 pixel is 0xAABBGGRR.
  px.fill(0xFF000000 | (SKY_B << 16) | (SKY_G << 8) | SKY_R)

  for (let y = 0; y < rows; y++) {
    const oy = y * cellH
    const h = Math.min(gh, frameH - oy)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const g = GLYPH[cells[i]!]!
      if (g === 0) continue

      const r = colored ? colors[i * 3]! : MONO_R
      const gr = colored ? colors[i * 3 + 1]! : MONO_G
      const b = colored ? colors[i * 3 + 2]! : MONO_B
      // Background and foreground of this cell. Without cell backgrounds the glyph sits on the sky.
      let bgR = SKY_R
      let bgG = SKY_G
      let bgB = SKY_B
      let fgR = r
      let fgG = gr
      let fgB = b
      if (backgrounds) {
        const light = isLight(r, gr, b)
        bgR = r
        bgG = gr
        bgB = b
        fgR = glyphShade(r, light)
        fgG = glyphShade(gr, light)
        fgB = glyphShade(b, light)
      }

      const ox = x * cellW
      const w = Math.min(gw, frameW - ox)
      for (let yy = 0; yy < h; yy++) {
        const dst = (oy + yy) * frameW + ox
        const src = yy * stride + g * gw
        for (let xx = 0; xx < w; xx++) {
          const a = alpha[src + xx]!
          // Blend by glyph coverage: background + (foreground - background) * coverage.
          if (a || backgrounds) {
            px[dst + xx] = 0xFF000000
              | ((bgB + (((fgB - bgB) * a) >> 8)) << 16)
              | ((bgG + (((fgG - bgG) * a) >> 8)) << 8)
              | (bgR + (((fgR - bgR) * a) >> 8))
          }
        }
      }
    }
  }
  ctx!.putImageData(frame, 0, 0)
}

// Only re-render when something changed: the image is static between camera moves.
function tick() {
  frameId = requestAnimationFrame(tick)
  meter.tick()
  if (!dirty || !cols) return

  if (workers.length) {
    // One frame in flight at a time. `dirty` stays set, so the next one goes out when it lands.
    if (pending) return
    dirty = false
    pending = workers.length
    frameStart = performance.now()
    nextInk = new Uint8Array(cols * rows)
    nextRgb = new Uint8Array(cols * rows * 3)
    const cam = camera()
    const step = workers.length
    workers.forEach((w, k) => {
      // Worker k traces rows k, k + step, k + 2 * step, ...
      const bandRows = Math.max(0, Math.ceil((rows - k) / step))
      const inkOut = new Uint8Array(bandRows * cols)
      const rgbOut = new Uint8Array(bandRows * cols * 3)
      post(w, { type: 'render', camera: cam, cols, rows, rowStart: k, rowStep: step, ink: inkOut, rgb: rgbOut }, [inkOut.buffer, rgbOut.buffer])
    })
    return
  }

  if (!scene) return
  dirty = false
  const traceMs = timed(() => renderCity(scene!, camera(), cols, rows, ink, rgb))
  const drawMs = timed(draw)
  meter.frame(traceMs + drawMs, { trace: traceMs, draw: drawMs })
}

// Orbit controls with the same feel and limits as three's OrbitControls in the 3D view:
// left drag orbits, right or shift drag pans, wheel zooms.
let drag: { x: number, y: number, pan: boolean } | undefined

function setView(position: Vec3, target: Vec3) {
  view.value = { position, target }
  dirty = true
}

function orbit(dx: number, dy: number) {
  const { position: p, target: t } = view.value
  const offset = [p[0] - t[0], p[1] - t[1], p[2] - t[2]] as Vec3
  const radius = Math.hypot(...offset)
  const theta = Math.atan2(offset[0], offset[2]) - (2 * Math.PI * dx) / height
  const phi = Math.min(MAX_POLAR_ANGLE, Math.max(0.01, Math.acos(offset[1] / radius) - (2 * Math.PI * dy) / height))
  setView([
    t[0] + radius * Math.sin(phi) * Math.sin(theta),
    t[1] + radius * Math.cos(phi),
    t[2] + radius * Math.sin(phi) * Math.cos(theta),
  ], t)
}

function pan(dx: number, dy: number) {
  const { position: p, target: t } = view.value
  const { right, up } = cameraBasis(p, t)
  const distance = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2])
  const scale = (2 * distance * Math.tan((CAMERA_FOV * Math.PI) / 360)) / height
  const move = [0, 1, 2].map(i => (-right[i]! * dx + up[i]! * dy) * scale) as Vec3
  setView(p.map((v, i) => v + move[i]!) as Vec3, t.map((v, i) => v + move[i]!) as Vec3)
}

function zoom(deltaY: number) {
  const { position: p, target: t } = view.value
  const distance = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2])
  const next = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance * Math.exp(deltaY * 0.001)))
  setView(p.map((v, i) => t[i]! + (v - t[i]!) * (next / distance)) as Vec3, t)
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
  if (drag.pan) pan(dx, dy)
  else orbit(dx, dy)
}

function onPointerUp() {
  drag = undefined
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  zoom(e.deltaY)
}

onMounted(async () => {
  // .client components render their template after mount; wait for the refs to exist.
  await nextTick()
  ctx = canvas.value!.getContext('2d')!
  if (props.worker) startWorkers()
  rebuild()
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container.value!)
  resize()
  tick()
})

watch(() => [props.seed, props.blocks], rebuild)
watch(() => [props.color, props.atlas, props.cellBackground], () => (dirty = true))
watch(() => props.fontSize, resize)
watch(() => props.worker, (on) => {
  if (on) startWorkers()
  else stopWorkers()
  rebuild()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frameId)
  resizeObserver?.disconnect()
  stopWorkers()
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
  background: v-bind(SKY_CSS);
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}
</style>
