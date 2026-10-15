/**
 * The ASCII view in a terminal: `yarn ascii [city|forest|dragon] [--seed N] [--size N]`.
 * Same ray tracer, environments and players as the browser, drawn with ANSI colors.
 */
import { availableParallelism } from 'node:os'
import { parseArgs } from 'node:util'
import { ENVIRONMENTS, findEnvironment } from '../app/environments'
import { CAMERA_FOV, DEFAULT_VIEW, orbitView, panView, zoomView, type CameraView } from '../app/lib/camera'
import { hexToBytes } from '../app/lib/color'
import { createFrameMeter, type FramePerf } from '../app/lib/frameMeter'
import { defaultChase, followPlayer, orbitChase, spawnPose, stepPlayer, swapPose, zoomChase, type PlayerMotion } from '../app/lib/playerMotion'
import type { TracedFrame } from '../app/lib/tracers'
import { getPlayer, type PlayerKind, type PlayerPose } from '../app/players'
import { createInput, type MouseEvent } from './input'
import { createScreen } from './screen'
import { createNodeTracer } from './tracer'

/** Terminal cells are about twice as tall as they are wide. */
const CELL_ASPECT = 2
/** Orbiting with the keys, in full turns per second. */
const KEY_ORBIT_SPEED = 0.2
const KEY_ZOOM_SPEED = 900
const TICK_MS = 1000 / 60

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    seed: { type: 'string' },
    size: { type: 'string' },
    workers: { type: 'string' },
    player: { type: 'string' },
    outlines: { type: 'boolean', default: true },
    backgrounds: { type: 'boolean', default: true },
    color: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' },
  },
})

const USAGE = `Usage: yarn ascii [${ENVIRONMENTS.map(e => e.id).join('|')}] [options]

  --seed N          world seed (random by default)
  --size N          environment size, as the browser's size slider
  --player KIND     start riding: dragon or car
  --workers N       ray tracing threads (default: cores - 1, at most 8)
  --no-outlines     no line characters on edges
  --no-backgrounds  characters only, no colored cells
  --no-color        dark characters on the sky color

Keys: 1 orbit · 2 dragon · 3 car · WASD/arrows move or look · Q/E zoom (dragon: down/up)
      Space/Shift dragon up/down · N new world · O outlines · B backgrounds · Esc quit
Mouse: drag to look, right-drag to pan, wheel to zoom.`

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
const env = findEnvironment(positionals[0] ?? 'city')
if (!env) {
  console.error(`Unknown environment "${positionals[0]}".\n\n${USAGE}`)
  process.exit(1)
}
if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error('This needs an interactive terminal.')
  process.exit(1)
}

const size = values.size ? Number(values.size) : env.size.default
const workerCount = values.workers ? Number(values.workers) : Math.max(1, Math.min(8, availableParallelism() - 1))
const style = { outlines: values.outlines, cellBackground: values.backgrounds, color: values.color, stretch: false, fogNear: env.fogNear, fogFar: env.fogFar, sky: hexToBytes(env.sky) }

let seed = values.seed ? Number(values.seed) : Math.floor(Math.random() * 1e6)
let world = env.generate(seed, size)
let summary = world.summary
let view: CameraView = structuredClone(env.camera ?? DEFAULT_VIEW)
let playerKind: PlayerKind | null = null
let pose: PlayerPose | undefined
const motion: PlayerMotion = { speed: 0, cameraHeading: 0 }
let chase = defaultChase()

let cols = 0
let rows = 0
let dirty = true
let perf: FramePerf | undefined
const meter = createFrameMeter((p) => {
  perf = p
  screen.status(status())
})
const screen = createScreen(process.stdout, process.stdout.hasColors(2 ** 24))

const tracer = createNodeTracer({
  onScene: (s) => {
    summary = s
    dirty = true
  },
  onFrame,
}, workerCount)

function onFrame(frame: TracedFrame) {
  // Traced for an old terminal size: throw it away and trace again.
  if (frame.cols !== cols || frame.rows !== rows) {
    dirty = true
    return
  }
  screen.status(status())
  const start = performance.now()
  screen.draw(frame, style)
  const drawMs = performance.now() - start
  meter.frame(frame.traceMs + drawMs, { trace: frame.traceMs, draw: drawMs })
}

function status() {
  const fps = perf ? (perf.fps >= 1 ? `${Math.round(perf.fps)} fps ${perf.ms.toFixed(1)} ms` : 'idle') : ''
  const riding = playerKind ? getPlayer(playerKind).name.toLowerCase() : 'orbit'
  const keys = playerKind
    ? `WASD move${getPlayer(playerKind).flies ? ' · Space/E up · Shift/Q down' : ''}`
    : 'WASD/arrows look · Q/E zoom'
  return ` ${env!.id} · seed ${seed} · ${summary} · ${cols}×${rows} · ${workerCount} threads · ${fps} │ ${riding}: ${keys} · 1 orbit 2 dragon 3 car · N new · Esc quit`
}

function resize() {
  cols = process.stdout.columns
  // The last row is the status line.
  rows = Math.max(1, process.stdout.rows - 1)
  screen.resize(cols, rows)
  dirty = true
}

function spawn(kind: PlayerKind | null) {
  if (kind === playerKind) return
  const previous = playerKind
  playerKind = kind
  tracer.setPlayer(kind, seed)
  dirty = true
  if (!kind) {
    pose = undefined
    return
  }
  const player = getPlayer(kind)
  chase = defaultChase(player)
  if (pose && previous) pose = swapPose(pose, player, world)
  else {
    pose = spawnPose(env!, size, view, player, world)
    motion.speed = 0
    motion.cameraHeading = pose.heading
  }
}

function newWorld() {
  seed = Math.floor(Math.random() * 1e6)
  world = env!.generate(seed, size)
  tracer.setScene(env!.id, seed, size)
  // A new color for the player too, and somewhere it fits in the new world.
  const kind = playerKind
  spawn(null)
  spawn(kind)
}

const input = createInput(process.stdin, process.stdout, {
  onKey(name) {
    if (name === 'escape' || name === 'ctrl+c') quit()
    else if (name === '1') spawn(null)
    else if (name === '2') spawn('dragon')
    else if (name === '3') spawn('car')
    else if (name === 'n') newWorld()
    else if (name === 'o') style.outlines = !style.outlines
    else if (name === 'b') style.cellBackground = !style.cellBackground
    else return
    dirty = true
    // Restyling needs every cell rewritten.
    if (name === 'o' || name === 'b') screen.resize(cols, rows)
  },
  onMouse,
})

let drag: { x: number, y: number, pan: boolean } | undefined

function onMouse(e: MouseEvent) {
  if (e.kind === 'wheel') {
    if (pose) zoomChase(chase, e.delta * 100)
    else view = zoomView(view, e.delta * 100)
    dirty = true
    return
  }
  if (e.kind === 'down') drag = { x: e.x, y: e.y, pan: e.button === 2 }
  else if (e.kind === 'up') drag = undefined
  else if (drag) {
    // Cells are narrow: scale both directions to the pointer movement of square pixels.
    const dx = e.x - drag.x
    const dy = (e.y - drag.y) * CELL_ASPECT
    const height = rows * CELL_ASPECT
    drag.x = e.x
    drag.y = e.y
    if (pose) orbitChase(chase, dx, dy, height)
    else view = drag.pan ? panView(view, dx, dy, height) : orbitView(view, dx, dy, height)
    dirty = true
  }
}

const axis = (plus: string[], minus: string[]) => Number(plus.some(input.isDown)) - Number(minus.some(input.isDown))

function step(dt: number) {
  if (playerKind && pose) {
    const player = getPlayer(playerKind)
    const from = pose
    pose = stepPlayer(player, from, motion, {
      throttle: axis(['w', 'up'], ['s', 'down']),
      steer: axis(['a', 'left'], ['d', 'right']),
      climb: axis(['space', 'e'], ['shift', 'q']),
    }, world, dt)
    view = followPlayer(player, from, pose, motion, chase, dt)
    // Moving and flapping: trace every frame.
    dirty = true
    return
  }
  // Orbiting with the keys, as if dragging at a steady pace.
  const turn = axis(['a', 'left'], ['d', 'right'])
  const tilt = axis(['w', 'up'], ['s', 'down'])
  const zoom = axis(['q'], ['e'])
  // orbitView turns a full circle per viewport height of pointer movement.
  if (turn || tilt) view = orbitView(view, -turn * KEY_ORBIT_SPEED * dt * rows, tilt * KEY_ORBIT_SPEED * dt * rows, rows)
  if (zoom) view = zoomView(view, zoom * KEY_ZOOM_SPEED * dt)
  if (turn || tilt || zoom || env!.animate) dirty = true
}

let last = performance.now()
let timer: NodeJS.Timeout | undefined

function tick() {
  const now = performance.now()
  // Capped, so a frame after a stall doesn't jump far.
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  step(dt)
  meter.tick()
  // One frame in flight at a time; a write still draining to the terminal also waits.
  if (dirty && cols && !tracer.busy && process.stdout.writableNeedDrain === false) {
    dirty = false
    tracer.render({ position: [...view.position], target: [...view.target], fov: CAMERA_FOV, aspect: cols / (rows * CELL_ASPECT) }, cols, rows, now / 1000, pose && { position: [...pose.position], heading: pose.heading })
  }
  timer = setTimeout(tick, TICK_MS)
}

let quitting = false

function quit(code = 0) {
  if (quitting) return
  quitting = true
  clearTimeout(timer)
  input.stop()
  screen.leave()
  tracer.dispose()
  process.exit(code)
}

process.on('uncaughtException', (error) => {
  if (!quitting) {
    input.stop()
    screen.leave()
  }
  console.error(error)
  process.exit(1)
})
process.stdout.on('resize', resize)

screen.enter()
input.start()
resize()
tracer.setScene(env.id, seed, size)
if (values.player === 'dragon' || values.player === 'car') spawn(values.player)
tick()
