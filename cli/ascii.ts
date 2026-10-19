/**
 * The ASCII view in a terminal: `yarn ascii [city|forest|ocean|mountains|dragon] [--seed N] [--size N]`.
 * Same ray tracer, environments and players as the browser, drawn with ANSI colors.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { parseArgs } from 'node:util'
import { ENVIRONMENTS, findEnvironment, type Environment } from '../app/environments'
import { benchmarkView, CAMERA_FOV, DEFAULT_VIEW, orbitView, panView, zoomView, type CameraView } from '../app/lib/camera'
import { DAY_LENGTH, formatTimeOfDay, lightingAt, NOON } from '../app/environments/lighting'
import { hexToBytes } from '../app/lib/color'
import { createFrameMeter, type FramePerf } from '../app/lib/frameMeter'
import { defaultChase, followPlayer, orbitChase, spawnPose, stepPlayer, swapPose, zoomChase, type PlayerMotion } from '../app/lib/playerMotion'
import type { Picked, TracedFrame } from '../app/lib/tracers'
import type { Camera } from '../app/lib/raycaster'
import { getPlayer, type PlayerKind, type PlayerPose } from '../app/players'
import { createInput, type MouseEvent } from './input'
import { createScreen, type Resolution } from './screen'
import { createNodeTracer } from './tracer'

/** Terminal cells are about twice as tall as they are wide. */
const CELL_ASPECT = 2
/** Orbiting with the keys, in full turns per second. */
const KEY_ORBIT_SPEED = 0.2
const KEY_ZOOM_SPEED = 900
const TICK_MS = 1000 / 60
/** --benchmark: seconds along the browser benchmark's camera path, the first WARMUP not counted. */
const BENCH_SECONDS = 12
const BENCH_WARMUP = 2

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    seed: { type: 'string' },
    size: { type: 'string' },
    workers: { type: 'string' },
    player: { type: 'string' },
    time: { type: 'string' },
    cycle: { type: 'boolean', default: false },
    'log-input': { type: 'string' },
    outlines: { type: 'boolean', default: true },
    backgrounds: { type: 'boolean', default: true },
    blocks: { type: 'boolean', default: false },
    color: { type: 'boolean', default: true },
    benchmark: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
})

const COMMAND = import.meta.url.endsWith('.ts') ? 'yarn ascii' : 'npx 3d-ascii'
const USAGE = `Usage: ${COMMAND} [${ENVIRONMENTS.map(e => e.id).join('|')}] [options]

  --seed N          world seed (random by default)
  --size N          environment size, as the browser's size slider
  --player KIND     start riding: dragon or car
  --time HH         time of day to start at, 0-24 (default 12)
  --cycle           start with day and night cycling
  --workers N       ray tracing threads (default: cores - 1, at most 8)
  --no-outlines     no line characters on edges
  --no-backgrounds  characters only, no colored cells
  --blocks          twice the detail: half-cell color blocks instead of characters
  --no-color        dark characters on the sky color
  --benchmark       fly a ${BENCH_SECONDS} s camera path, then print fps and where frame time went
  --log-input FILE  write every key and mouse sequence, and the camera after it, to FILE

Keys: 1 orbit · 2 dragon · 3 car · WASD/arrows move or look · Q/E zoom (dragon: down/up)
      Space/Shift dragon up/down · Tab next environment · R characters/blocks
      T day/night cycle · , and . an hour back/forward · N new world · O outlines
      B backgrounds · Esc quit
Mouse: drag to look, right-drag to pan, wheel to zoom.`

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
const startEnv = findEnvironment(positionals[0] ?? 'city')
if (!startEnv) {
  console.error(`Unknown environment "${positionals[0]}".\n\n${USAGE}`)
  process.exit(1)
}
if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error('This needs an interactive terminal.')
  process.exit(1)
}

let env: Environment = startEnv
let size = values.size ? Number(values.size) : env.size.default
const workerCount = values.workers ? Number(values.workers) : Math.max(1, Math.min(8, availableParallelism() - 1))
const style = { outlines: values.outlines, cellBackground: values.backgrounds, color: values.color, stretch: false, fogNear: env.fogNear, fogFar: env.fogFar, sky: hexToBytes(env.sky) }

let timeOfDay = values.time ? (((Number(values.time) / 24) % 1) + 1) % 1 : NOON
let cycling = values.cycle
// The benchmark uses the same world every run, so runs compare.
let seed = values.seed ? Number(values.seed) : values.benchmark ? 1 : Math.floor(Math.random() * 1e6)
let world = env.generate(seed, size)
let summary = world.summary
let view: CameraView = structuredClone(env.camera ?? DEFAULT_VIEW)
let playerKind: PlayerKind | null = null
let pose: PlayerPose | undefined
const motion: PlayerMotion = { speed: 0, cameraHeading: 0 }
let chase = defaultChase()

/** Terminal cells the frame covers, between the status bar and the key bar. */
let cols = 0
let rows = 0
let resolution: Resolution = values.blocks ? 'blocks' : 'characters'
/** The grid the tracer fills: rows × 2 in block mode. */
let grid = { cols: 0, rows: 0 }
let dirty = true
let perf: FramePerf | undefined
const meter = createFrameMeter((p) => {
  perf = p
  showBars()
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
  if (frame.cols !== grid.cols || frame.rows !== grid.rows) dirty = true
  else traced = { frame, camera: tracingCamera! }
  pump()
}

/** A traced frame not drawn yet, waiting for the terminal to read the one before it. */
let traced: { frame: TracedFrame, camera: Camera } | undefined
/** The camera of the frame the tracer is working on. */
let tracingCamera: Camera | undefined
/** When the last trace started, to cap the frame rate. */
let lastTrace = -Infinity

/**
 * Moves frames along as soon as each step can, rather than on the next tick: draws a traced
 * frame once the terminal has read the last one, and starts tracing the next before drawing,
 * so the workers trace while this thread writes and the terminal reads.
 */
function pump() {
  const now = performance.now()
  if (unread && now - unread.since > UNREAD_TIMEOUT_MS) {
    unread = undefined
    paced = answered
  }
  const ready = traced && !unread && process.stdout.writableNeedDrain === false ? traced : undefined
  if (ready) traced = undefined
  // A little early is fine: the tick that would otherwise start it may come late.
  if (dirty && cols && !traced && !tracer.busy && now - lastTrace >= TICK_MS - 2) {
    dirty = false
    lastTrace = now
    tracingCamera = { position: [...view.position], target: [...view.target], fov: CAMERA_FOV, aspect: cols / (rows * CELL_ASPECT) }
    tracer.render(tracingCamera, grid.cols, grid.rows, now / 1000, pose && { position: [...pose.position], heading: pose.heading }, timeOfDay)
  }
  if (ready) draw(ready.frame, ready.camera)
}

function draw(frame: TracedFrame, camera: Camera) {
  lastCamera = camera
  showBars()
  const start = performance.now()
  const { bytes, writeMs } = screen.draw(frame, style)
  const end = performance.now()
  meter.frame(frame.traceMs + end - start, { trace: frame.traceMs, draw: end - start })
  if (bytes && paced) unread = { since: end }
  if (values.benchmark) {
    benchStart ??= end
    benchFrames.push({ at: end, trace: frame.traceMs, build: end - start - writeMs, write: writeMs, bytes, terminal: 0 })
  }
}

interface BenchFrame { at: number, trace: number, build: number, write: number, bytes: number, terminal: number }
/** When the first frame was drawn: the camera path starts there. */
let benchStart: number | undefined
const benchFrames: BenchFrame[] = []
const benchFrom = structuredClone(view)
/**
 * The last frame the terminal hasn't confirmed reading yet. The next waits for it, so frames
 * can't pile up in the terminal and lag behind input. Given up on after UNREAD_TIMEOUT_MS, for
 * terminals that don't answer.
 */
let unread: { since: number } | undefined
const UNREAD_TIMEOUT_MS = 250
/** Off once the terminal has left a status request unanswered, without having answered one before. */
let paced = true
let answered = false

function onStatus() {
  answered = true
  if (!unread) return
  const last = benchFrames.at(-1)
  if (last && values.benchmark) last.terminal = performance.now() - unread.since
  unread = undefined
  pump()
}

/** Leaves the full screen and prints how fast the measured part of the run was. */
function finishBenchmark() {
  const measured = benchFrames.filter(f => f.at >= benchStart! + BENCH_WARMUP * 1000)
  const seconds = BENCH_SECONDS - BENCH_WARMUP
  const avg = (key: keyof BenchFrame) => measured.reduce((n, f) => n + f[key], 0) / Math.max(1, measured.length)
  const fps = measured.length / seconds
  // The slowest half second.
  const windows = Array.from({ length: seconds * 2 }, (_, w) => measured.filter(f => Math.floor((f.at - benchStart! - BENCH_WARMUP * 1000) / 500) === w).length * 2)
  const [trace, build, write, terminal] = [avg('trace'), avg('build'), avg('write'), avg('terminal')]
  const frameMs = 1000 / Math.max(fps, 1e-9)
  const ms = (n: number) => `${n.toFixed(1).padStart(6)} ms`
  const lines = [
    `${env.name} · seed ${seed} · ${grid.cols}×${grid.rows} ${resolution} · ${workerCount} threads · ${process.stdout.hasColors(2 ** 24) ? '24-bit' : '256'} color`,
    '',
    `  fps          ${fps.toFixed(1).padStart(6)}     (worst half second: ${Math.min(...windows)})`,
    `  per frame    ${ms(frameMs)}`,
    `    tracing    ${ms(trace)}  on worker threads, while the steps below run`,
    `    ANSI       ${ms(build)}  building the escape codes`,
    `    writing    ${ms(write)}  ${(avg('bytes') / 1024).toFixed(0)} KB (${((avg('bytes') * fps) / 1024 / 1024).toFixed(1)} MB/s)`,
    `    terminal   ${ms(terminal)}  until the terminal had read the frame`,
    `  at most ${Math.round(1000 / TICK_MS)} fps`,
  ]
  quit(0, lines.join('\n'))
}

/** What's on screen and how fast, for the bar on top. */
function statusBar(loading?: string) {
  const fps = perf ? (perf.fps >= 1 ? `${Math.round(perf.fps)} fps · ${perf.ms.toFixed(1)} ms` : 'idle') : ''
  const releases = input.releases ? 'key releases' : 'key repeat'
  const what = loading ? `loading ${loading}…` : summary
  const clock = `${formatTimeOfDay(timeOfDay)}${cycling ? ' ↻' : ''}`
  if (inspected) return ` ▸ ${inspected.label} · ${Math.round(inspected.distance)} m away │ ${env.name} · ${what} · ${clock} · seed ${seed}`
  return ` ${env.name} · ${what} · ${clock} · seed ${seed} · ${grid.cols}×${grid.rows} ${resolution} · ${workerCount} threads · ${fps} · ${releases}`
}

/** The keys that do something right now, for the bar at the bottom. */
function keyBar() {
  const moves = !playerKind
    ? 'orbit: WASD look · Q/E zoom · click names it'
    : `${getPlayer(playerKind).name.toLowerCase()}: WASD move${getPlayer(playerKind).flies ? ' · Space/E up · Shift/Q down' : ''} · click names it`
  return ` ${moves} │ 1 orbit · 2 dragon · 3 car · Tab scene · R ${resolution === 'blocks' ? 'characters' : 'blocks'} · T cycle · ,. hour · N new · Esc quit`
}

function showBars(loading?: string) {
  screen.bars(statusBar(loading), keyBar())
}

/** Fits the frame to the terminal and resolution, and redraws everything. */
function layout() {
  grid = screen.resize(process.stdout.columns, process.stdout.rows, resolution)
  cols = process.stdout.columns
  rows = Math.max(1, process.stdout.rows - 2)
  dirty = true
  showBars()
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
    pose = spawnPose(env, size, view, player, world)
    motion.speed = 0
    motion.cameraHeading = pose.heading
  }
}

/** Builds the current environment for `seed` and puts the player somewhere it fits. */
function rebuild() {
  world = env.generate(seed, size)
  tracer.setScene(env.id, seed, size)
  // A new color for the player too, spawned fresh in the new world.
  const kind = playerKind
  spawn(null)
  spawn(kind)
}

function newWorld() {
  seed = Math.floor(Math.random() * 1e6)
  rebuild()
}

/** Switches to the next environment (or the previous one, with step -1), at its own size and camera. */
function cycleEnvironment(step: number) {
  const i = ENVIRONMENTS.indexOf(env)
  env = ENVIRONMENTS[(i + step + ENVIRONMENTS.length) % ENVIRONMENTS.length]!
  size = env.size.default
  // The sky color follows the time of day; step() sets it.
  Object.assign(style, { fogNear: env.fogNear, fogFar: env.fogFar })
  view = structuredClone(env.camera ?? DEFAULT_VIEW)
  // A new sky color: every cell gets rewritten.
  layout()
  // Building can take a moment (the dragon is meshed from scratch), so say so first.
  showBars(env.name.toLowerCase())
  setImmediate(rebuild)
}

const logFile = values['log-input']
if (logFile) writeFileSync(logFile, '')
/** With --log-input: one line per raw input sequence, with the camera as it was after the last one. */
function logInput(sequence: string) {
  if (!logFile) return
  const round = (v: number[]) => v.map(n => Math.round(n * 10) / 10)
  appendFileSync(logFile, `${performance.now().toFixed(0)} ${JSON.stringify(sequence)} camera ${round(view.position)} → ${round(view.target)}\n`)
}

const input = createInput(process.stdin, process.stdout, {
  onRaw: logInput,
  onStatus,
  onKey(name) {
    if (name === 'escape' || name === 'ctrl+c') quit()
    else if (values.benchmark) return
    else if (name === '1') spawn(null)
    else if (name === '2') spawn('dragon')
    else if (name === '3') spawn('car')
    else if (name === 'n') newWorld()
    else if (name === 'tab') cycleEnvironment(1)
    else if (name === 'shift+tab') cycleEnvironment(-1)
    else if (name === 'o') style.outlines = !style.outlines
    else if (name === 'b') style.cellBackground = !style.cellBackground
    else if (name === 'r') resolution = resolution === 'blocks' ? 'characters' : 'blocks'
    else if (name === 't') cycling = !cycling
    else if (name === ',' || name === '.') timeOfDay = (timeOfDay + (name === '.' ? 1 : 23) / 24) % 1
    else return
    dirty = true
    // Restyling needs every cell rewritten.
    if (name === 'o' || name === 'b' || name === 'r') layout()
    else showBars()
  },
  onMouse,
})

let drag: { x: number, y: number, pan: boolean, moved: boolean } | undefined
/** What the last click landed on, shown in the status bar until the next press. */
let inspected: Picked | undefined
/** The camera of the frame on screen: a click picks in what is shown. */
let lastCamera: Camera | undefined

/** Names what is under cell (x, y) of the terminal, in the status bar. */
async function inspect(x: number, y: number) {
  // Terminal row 0 is the status bar; the frame starts below it.
  const v = (y - 1 + 0.5) / rows
  if (!lastCamera || v < 0 || v > 1) return
  inspected = (await tracer.pick(lastCamera, (x + 0.5) / cols, v)) ?? undefined
  showBars()
}

function onMouse(e: MouseEvent) {
  if (values.benchmark) return
  if (inspected && (e.kind === 'down' || e.kind === 'wheel')) {
    inspected = undefined
    showBars()
  }
  if (e.kind === 'wheel') {
    if (pose) zoomChase(chase, e.delta * 100)
    else view = zoomView(view, e.delta * 100)
    dirty = true
    return
  }
  if (e.kind === 'down') drag = { x: e.x, y: e.y, pan: e.button === 2, moved: false }
  else if (e.kind === 'up') {
    // A left press that never left its cell is a click.
    if (drag && !drag.pan && !drag.moved) void inspect(e.x, e.y)
    drag = undefined
  }
  else if (drag) {
    drag.moved ||= e.x !== drag.x || e.y !== drag.y
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
  if (values.benchmark) {
    if (benchStart === undefined) return
    const u = (performance.now() - benchStart) / 1000 / BENCH_SECONDS
    if (u >= 1) return finishBenchmark()
    view = benchmarkView(benchFrom, u)
    dirty = true
    return
  }
  if (cycling) {
    timeOfDay = (timeOfDay + dt / DAY_LENGTH) % 1
    dirty = true
  }
  style.sky = hexToBytes(lightingAt(timeOfDay, env.sky).sky)
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
  if (turn || tilt || zoom || env.animate) dirty = true
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
  pump()
  timer = setTimeout(tick, TICK_MS)
}

let quitting = false

function quit(code = 0, message?: string) {
  if (quitting) return
  quitting = true
  clearTimeout(timer)
  input.stop()
  screen.leave()
  tracer.dispose()
  if (message) console.log(message)
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
process.stdout.on('resize', layout)

screen.enter()
input.start()
layout()
tracer.setScene(env.id, seed, size)
if (!values.benchmark && (values.player === 'dragon' || values.player === 'car')) spawn(values.player)
tick()
