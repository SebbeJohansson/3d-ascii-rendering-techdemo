/**
 * The ASCII view in a terminal: `yarn ascii [city|forest|ocean|mountains|dragon] [--seed N] [--size N]`.
 * Same ray tracer, environments and players as the browser, drawn with ANSI colors.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { parseArgs } from 'node:util'
import { ENVIRONMENTS, findEnvironment, type Environment, type EnvironmentScene } from '../app/environments'
import { benchmarkView, CAMERA_FOV, DEFAULT_VIEW, orbitView, panView, zoomView, type CameraView } from '../app/lib/camera'
import { DAY_LENGTH, formatTimeOfDay, lightingAt, NOON } from '../app/environments/lighting'
import { dropBox, fallBoxes, removeBox, withBoxes, type DroppedBox } from '../app/lib/boxes'
import { dropTower, startTower, stepTower, type TowerGame } from '../app/lib/tower'
import { COLORS, DEFAULT_CELLS, DEFAULT_PROFILE, DRAW_TOOLS, fallShapes, placeShape, removeShape, shapeBoxes, type DrawnShape, type DrawTool } from '../app/lib/shapes'
import { hexToBytes } from '../app/lib/color'
import { createFrameMeter, type FramePerf } from '../app/lib/frameMeter'
import { defaultChase, followPlayer, orbitChase, spawnPose, stepPlayer, swapPose, zoomChase, type PlayerMotion } from '../app/lib/playerMotion'
import type { Picked, TracedFrame } from '../app/lib/tracers'
import type { Camera } from '../app/lib/raycaster'
import { getPlayer, type PlayerKind, type PlayerPose } from '../app/players'
import { createInput, type MouseEvent } from './input'
import { COLOR_DEPTH_NAMES, COLOR_DEPTHS, createScreen, detectColorDepth, type ColorDepth, type Resolution } from './screen'
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
    colors: { type: 'string' },
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
  --colors MODE     24bit, 256, 16 or none (characters only, in the terminal's own
                    colors). Default: what the terminal supports; none with NO_COLOR
  --benchmark       fly a ${BENCH_SECONDS} s camera path, then print fps and where frame time went
  --log-input FILE  write every key and mouse sequence, and the camera after it, to FILE

Keys: 1 orbit · 2 dragon · 3 car · 4 boxes · 5 tower game · 6 draw shapes · WASD/arrows move or look
      Q/E zoom (dragon: down/up) · Space/Shift dragon up/down · G gravity for boxes and shapes · F stick boxes to faces
      X clear boxes or shapes · V next shape: spun vase, extruded heart, blobs
      Tab next environment · R characters/blocks · T day/night cycle · , and . an hour back/forward
      N new world · O outlines · B backgrounds · C colors · Esc quit
Mouse: drag to look, right-drag to pan, wheel to zoom, click to name what's there
       (in boxes mode: to drop a box there, Shift/Alt-click in the air, right-click removes one;
       in the tower game: to start a tower there, then click or Space drops the swinging box;
       in draw mode: to place the shape there, right-click removes one).`

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
const startEnv = findEnvironment(positionals[0] ?? 'city')
if (!startEnv) {
  console.error(`Unknown environment "${positionals[0]}".\n\n${USAGE}`)
  process.exit(1)
}
if (values.colors && !COLOR_DEPTHS.includes(values.colors as ColorDepth)) {
  console.error(`Unknown --colors "${values.colors}": use ${COLOR_DEPTHS.join(', ')}.`)
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
/** The environment as generated, and with the dropped boxes: what the player collides with. */
let generated = env.generate(seed, size)
let world: EnvironmentScene = generated
let summary = world.summary
/** Orbiting, where a click drops a box instead of naming what is there. */
let boxMode = false
let gravity = true
/** Whether a dropped box sticks to the face clicked, and so doesn't fall. */
let stick = false
let boxes: DroppedBox[] = []
/** Orbiting, where a click starts a stacking tower game or drops its swinging box. */
let towerMode = false
let tower: TowerGame | undefined
/** The highest tower stacked since starting. */
let towerBest = 0
/** Orbiting, where a click places a shape: the browser's starting drawings, spun, extruded or as blobs. */
let drawMode = false
let drawTool: DrawTool = 'spin'
let shapes: DrawnShape[] = []
let view: CameraView = structuredClone(env.camera ?? DEFAULT_VIEW)
let playerKind: PlayerKind | null = null
let pose: PlayerPose | undefined
const motion: PlayerMotion = { speed: 0, cameraHeading: 0 }
let chase = defaultChase()

/** Terminal cells the frame covers, between the status bar and the key bar. */
let cols = 0
let rows = 0
let resolution: Resolution = values.blocks ? 'blocks' : 'characters'
let colorDepth = (values.colors as ColorDepth | undefined) ?? detectColorDepth(process.stdout)
/** Blocks are colors only: without color, characters it is. */
const shownResolution = (): Resolution => (colorDepth === 'none' ? 'characters' : resolution)
/** The grid the tracer fills: rows × 2 in block mode. */
let grid = { cols: 0, rows: 0 }
let dirty = true
let perf: FramePerf | undefined
const meter = createFrameMeter((p) => {
  perf = p
  showBars()
})
const screen = createScreen(process.stdout)

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
    `${env.name} · seed ${seed} · ${grid.cols}×${grid.rows} ${shownResolution()} · ${workerCount} threads · ${COLOR_DEPTH_NAMES[colorDepth]}`,
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
  return ` ${env.name} · ${what} · ${clock} · seed ${seed} · ${grid.cols}×${grid.rows} ${shownResolution()} · ${COLOR_DEPTH_NAMES[colorDepth]} · ${workerCount} threads · ${fps} · ${releases}`
}

/** The keys that do something right now, for the bar at the bottom. */
function keyBar() {
  const moves = drawMode
    ? `draw: WASD look · Q/E zoom · click places a ${{ spin: 'spun vase', extrude: 'extruded heart', blobs: 'blob' }[drawTool]} · V next shape · right-click removes · G gravity ${gravity ? 'on' : 'off'}${shapes.length ? ' · X clear' : ''}`
    : towerMode
    ? `tower: WASD look · Q/E zoom · ${!tower ? 'click a spot to build a tower there' : tower.over ? `missed! tower of ${tower.score} · click a spot for a new one` : `height ${tower.score} · click/Space drops`} · best ${towerBest}`
    : boxMode
    ? `boxes: WASD look · Q/E zoom · click drops a box · Alt-click in the air · right-click removes · G gravity ${gravity ? 'on' : 'off'} · F stick ${stick ? 'on' : 'off'}${boxes.length ? ' · X clear' : ''}`
    : !playerKind
        ? 'orbit: WASD look · Q/E zoom · click names it'
        : `${getPlayer(playerKind).name.toLowerCase()}: WASD move${getPlayer(playerKind).flies ? ' · Space/E up · Shift/Q down' : ''} · click names it`
  return ` ${moves} │ 1 orbit · 2 dragon · 3 car · 4 boxes · 5 tower · 6 draw · Tab scene · ${colorDepth === 'none' ? '' : `R ${resolution === 'blocks' ? 'characters' : 'blocks'} · `}C colors · T cycle · ,. hour · N new · Esc quit`
}

function showBars(loading?: string) {
  screen.bars(statusBar(loading), keyBar())
}

/** Fits the frame to the terminal and resolution, and redraws everything. */
function layout() {
  grid = screen.resize(process.stdout.columns, process.stdout.rows, shownResolution(), colorDepth)
  cols = process.stdout.columns
  rows = Math.max(1, process.stdout.rows - 2)
  dirty = true
  showBars()
}

function applyBoxes(next: DroppedBox[]) {
  boxes = next
  showBoxes()
}

function applyTower(next: TowerGame | undefined) {
  tower = next
  if (next && next.score > towerBest) towerBest = next.score
  showBoxes()
}

function applyShapes(next: DrawnShape[]) {
  shapes = next
  tracer.setShapes(shapes)
  showBoxes()
}

/** Hands the dropped boxes, the tower game's and extruded shapes' to the tracer and to the player's collisions. */
function showBoxes() {
  const all = [...boxes.map(b => b.box), ...(tower?.boxes ?? []).map(b => b.box), ...shapeBoxes(shapes)]
  world = withBoxes(generated, all)
  tracer.setBoxes(all)
  dirty = true
}

/** Orbit, the boxes mode, the tower game, the draw mode or a player: one at a time. */
function play(kind: PlayerKind | null, mode?: 'boxes' | 'tower' | 'draw') {
  boxMode = mode === 'boxes'
  towerMode = mode === 'tower'
  drawMode = mode === 'draw'
  spawn(kind)
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
  generated = env.generate(seed, size)
  // A new world starts without boxes or shapes.
  tower = undefined
  boxes = []
  applyShapes([])
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
    else if (name === '1') play(null)
    else if (name === '2') play('dragon')
    else if (name === '3') play('car')
    else if (name === '4') play(null, 'boxes')
    else if (name === '5') play(null, 'tower')
    else if (name === '6') play(null, 'draw')
    else if (name === 'v' && drawMode) drawTool = DRAW_TOOLS[(DRAW_TOOLS.indexOf(drawTool) + 1) % DRAW_TOOLS.length]!
    else if (name === 'x' && drawMode) applyShapes([])
    else if (name === 'space' && towerMode && tower && !tower.over) applyTower(dropTower(tower))
    else if (name === 'g' && (boxMode || drawMode)) gravity = !gravity
    else if (name === 'f' && boxMode) stick = !stick
    else if (name === 'x' && boxMode) applyBoxes([])
    else if (name === 'n') newWorld()
    else if (name === 'tab') cycleEnvironment(1)
    else if (name === 'shift+tab') cycleEnvironment(-1)
    else if (name === 'o') style.outlines = !style.outlines
    else if (name === 'b') style.cellBackground = !style.cellBackground
    else if (name === 'r') resolution = resolution === 'blocks' ? 'characters' : 'blocks'
    else if (name === 'c') colorDepth = COLOR_DEPTHS[(COLOR_DEPTHS.indexOf(colorDepth) + 1) % COLOR_DEPTHS.length]!
    else if (name === 't') cycling = !cycling
    else if (name === ',' || name === '.') timeOfDay = (timeOfDay + (name === '.' ? 1 : 23) / 24) % 1
    else return
    dirty = true
    // Restyling needs every cell rewritten.
    if (name === 'o' || name === 'b' || name === 'r' || name === 'c') layout()
    else showBars()
  },
  onMouse,
})

let drag: { x: number, y: number, pan: boolean, moved: boolean, air: boolean } | undefined
/** What the last click landed on, shown in the status bar until the next press. */
let inspected: Picked | undefined
/** The camera of the frame on screen: a click picks in what is shown. */
let lastCamera: Camera | undefined

/**
 * Names what is under cell (x, y) of the terminal, in the status bar, or drops a box there:
 * in the air with `air`. With `remove`, takes out the box there. In the tower game, starts a
 * tower there or drops the swinging box. In the draw mode, places a shape there or, with
 * `remove`, takes out the shape there.
 */
async function inspect(x: number, y: number, { air = false, remove = false } = {}) {
  // Terminal row 0 is the status bar; the frame starts below it.
  const v = (y - 1 + 0.5) / rows
  if (!lastCamera || v < 0 || v > 1) return
  // Mid-game a click drops the swinging box at once: no need to know what is under it.
  if (towerMode && tower && !tower.over) {
    if (!remove) applyTower(dropTower(tower))
    showBars()
    return
  }
  const picked = await tracer.pick(lastCamera, (x + 0.5) / cols, v)
  if (towerMode) {
    if (!remove && picked && picked.kind !== 'player') applyTower(startTower(picked))
    showBars()
    return
  }
  if (drawMode) {
    const drawing = { profile: DEFAULT_PROFILE, cells: DEFAULT_CELLS, size: { spin: 12, extrude: 16, blobs: 4 }[drawTool], height: 3 }
    const placed = !remove && picked && picked.kind !== 'player' && placeShape(drawTool, drawing, picked, lastCamera, COLORS[Math.floor(Math.random() * COLORS.length)]!)
    if (remove && picked?.drawn !== undefined) applyShapes(removeShape(shapes, picked.drawn, picked.point))
    else if (placed) applyShapes([...shapes, placed])
    showBars()
    return
  }
  if (boxMode) {
    if (remove && picked?.box !== undefined) applyBoxes(removeBox(boxes, picked.box))
    else if (!remove && picked && picked.kind !== 'player') applyBoxes([...boxes, dropBox(picked, { boxes, stick, air })])
    showBars()
    return
  }
  inspected = picked ?? undefined
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
  if (e.kind === 'down') drag = { x: e.x, y: e.y, pan: e.button === 2, moved: false, air: !!e.modified }
  else if (e.kind === 'up') {
    // A press that never left its cell is a click; a right one only removes boxes.
    if (drag && !drag.moved && (!drag.pan || boxMode || towerMode || drawMode)) void inspect(e.x, e.y, { air: drag.air, remove: drag.pan })
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
  if (gravity) {
    const fallen = fallBoxes(boxes, dt)
    if (fallen) applyBoxes(fallen)
    const shapesFallen = fallShapes(shapes, dt)
    if (shapesFallen) applyShapes(shapesFallen)
  }
  if (tower) {
    const next = stepTower(tower, dt)
    if (next) applyTower(next)
  }
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
