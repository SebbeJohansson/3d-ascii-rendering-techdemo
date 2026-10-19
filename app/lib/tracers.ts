/**
 * Two interchangeable ways to run the ray tracer: on the main thread, or split across a pool
 * of Web Workers. Both report results through the same callbacks, so the page doesn't care
 * which one is active.
 */
import { getEnvironment } from '../environments'
import type { WorkerRequest, WorkerResponse } from '../workers/raytrace.worker'
import type { Environment, EnvironmentScene } from '../environments/types'
import { getPlayer, type PlayerKind, type PlayerModel, type PlayerPose } from '../players'
import { lightingAt, NOON } from '../environments/lighting'
import { buildRaycastPlayer, buildRaycastScene, castRay, placePlayer, renderScene, setLighting, updateMeshes, type Camera, type RaycastPlayer, type RaycastScene } from './raycaster'

export interface TracedFrame {
  cols: number
  rows: number
  ink: Uint8Array
  rgb: Uint8Array
  /** View depth per cell, Infinity where the ray hit nothing. */
  depths: Float32Array
  /** Surface normal per cell: x, y, z × 127. */
  normals: Int8Array
  /** Wall-clock time from request to result, including any worker messaging. */
  traceMs: number
  /** Optional breakdown of traceMs by stage, e.g. { gpu, readback }. */
  stages?: Record<string, number>
  /** Already drawn onto the canvas by the GPU: the cell arrays are empty. */
  presented?: boolean
}

/** What a click landed on. */
export interface Picked {
  /** e.g. "Building · 12 floors". */
  label: string
  /** From the camera, in world units (meters). */
  distance: number
}

export interface TracerEvents {
  /** A new scene is ready; summary is e.g. "530 buildings". */
  onScene: (summary: string) => void
  onFrame: (frame: TracedFrame) => void
}

export interface Tracer {
  /** Shown in the panel, e.g. "8 workers". */
  readonly label: string
  /** A frame is being traced; wait for onFrame before asking for the next. */
  readonly busy: boolean
  setScene: (envId: string, seed: number, size: number) => void
  /** Spawns a player (or removes it, with null). Its colors come from the seed. */
  setPlayer: (kind: PlayerKind | null, seed: number) => void
  /**
   * `time` (seconds) poses animated environments and players; `player` places the player;
   * `timeOfDay` (see lighting.ts) sets the light; `occlusion` turns on ambient occlusion.
   */
  render: (camera: Camera, cols: number, rows: number, time: number, player?: PlayerPose, timeOfDay?: number, occlusion?: boolean) => void
  /**
   * What the ray through (u, v) of the camera's view hits (both 0..1 from the top left), in
   * the scene as the last frame posed it. Null for sky.
   */
  pick: (camera: Camera, u: number, v: number) => Promise<Picked | null>
  dispose: () => void
}

/**
 * Lights the scene for the time of day, and poses an animated environment for this frame and
 * updates the ray tracer's copy of it.
 */
export function poseScene(envId: string, generated: EnvironmentScene, scene: RaycastScene, time: number, timeOfDay: number) {
  const env = getEnvironment(envId)
  setLighting(scene, lightingAt(timeOfDay, env.sky))
  if (!env.animate) return
  env.animate(generated, time)
  updateMeshes(scene, generated)
}

/**
 * Casts the ray through (u, v) of the camera's view and names what it hits. `scene` is the
 * ray tracer's copy of `generated`; `player` is the spawned player's name, if any.
 */
export function pickScene(envId: string, generated: EnvironmentScene, scene: RaycastScene, player: string | undefined, camera: Camera, u: number, v: number): Picked | null {
  const hit = castRay(scene, camera, u, v)
  if (!hit) return null
  const env = getEnvironment(envId)
  let label: string | undefined
  if (hit.kind === 'ground') label = env.groundLabel ?? (env.reflectance ? 'Sea' : 'Ground')
  else if (hit.kind === 'player') label = player
  else if (hit.kind === 'primitive') label = generated.primitives[hit.index]?.label
  else if (hit.kind === 'mesh') {
    // The meshes were merged in order: find the one this triangle came from.
    let first = 0
    for (const mesh of generated.meshes ?? []) {
      first += mesh.indices.length / 3
      if (hit.triangle < first) {
        label = mesh.label
        break
      }
    }
  }
  return { label: label ?? 'Something', distance: hit.distance }
}

/**
 * Picking for a view drawn without the ray tracer (the 3D view): builds the ray tracer's copy
 * of the scene on the first pick, and brings moved meshes up to date before each one after.
 */
export function createScenePicker() {
  let built: { generated: EnvironmentScene, scene: RaycastScene } | undefined
  const player = createPlayerSlot()
  return {
    setPlayer: player.set,
    pick(env: Environment, generated: EnvironmentScene, pose: PlayerPose | undefined, time: number, camera: Camera, u: number, v: number) {
      if (built?.generated !== generated) built = { generated, scene: buildRaycastScene(env, generated) }
      else if (env.animate) updateMeshes(built.scene, generated)
      player.attach(built.scene, pose, time)
      return pickScene(env.id, generated, built.scene, player.name, camera, u, v)
    },
  }
}

/** The ray tracer's copy of the spawned player, kept apart from the environment's scene. */
export function createPlayerSlot() {
  let model: PlayerModel | undefined
  let raycast: RaycastPlayer | undefined
  let name: string | undefined
  return {
    /** The spawned player's name, e.g. "Car". */
    get name() {
      return name
    },
    set(kind: PlayerKind | null, seed: number) {
      if (!kind) {
        model = raycast = name = undefined
        return
      }
      const player = getPlayer(kind)
      name = player.name
      model = player.build(seed)
      raycast = buildRaycastPlayer(model.mesh, player.scale)
    },
    /** Poses and places the player for this frame and puts it into `scene`, or takes it out. */
    attach(scene: RaycastScene, pose: PlayerPose | undefined, time: number) {
      if (!model || !raycast || !pose) {
        scene.player = undefined
        return
      }
      model.animate?.(time)
      placePlayer(raycast, pose, !!model.animate)
      scene.player = raycast
    },
  }
}

function emptyFrame(cols: number, rows: number): TracedFrame {
  const n = cols * rows
  return { cols, rows, ink: new Uint8Array(n), rgb: new Uint8Array(n * 3), depths: new Float32Array(n), normals: new Int8Array(n * 3), traceMs: 0 }
}

/** Stretches a frame traced on a coarser grid over cols × rows cells, each cell copying its nearest. */
export function upscaleFrame(frame: TracedFrame, cols: number, rows: number): TracedFrame {
  const out = emptyFrame(cols, rows)
  out.traceMs = frame.traceMs
  for (let y = 0; y < rows; y++) {
    const from = Math.floor((y * frame.rows) / rows) * frame.cols
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const j = from + Math.floor((x * frame.cols) / cols)
      out.ink[i] = frame.ink[j]!
      out.depths[i] = frame.depths[j]!
      for (let c = 0; c < 3; c++) {
        out.rgb[i * 3 + c] = frame.rgb[j * 3 + c]!
        out.normals[i * 3 + c] = frame.normals[j * 3 + c]!
      }
    }
  }
  return out
}

export function createMainThreadTracer({ onScene, onFrame }: TracerEvents): Tracer {
  let scene: RaycastScene | undefined
  let generated: EnvironmentScene | undefined
  let currentEnv = ''
  const player = createPlayerSlot()
  return {
    label: 'main thread',
    busy: false,
    setScene(envId, seed, size) {
      const env = getEnvironment(envId)
      generated = env.generate(seed, size)
      scene = buildRaycastScene(env, generated)
      currentEnv = envId
      onScene(generated.summary)
    },
    setPlayer(kind, seed) {
      player.set(kind, seed)
    },
    render(camera, cols, rows, time, pose, timeOfDay = NOON, occlusion = false) {
      if (!scene || !generated) return
      poseScene(currentEnv, generated, scene, time, timeOfDay)
      player.attach(scene, pose, time)
      scene.occlusion = occlusion
      const frame = emptyFrame(cols, rows)
      const start = performance.now()
      renderScene(scene, camera, cols, rows, frame.ink, frame.rgb, frame.depths, frame.normals)
      frame.traceMs = performance.now() - start
      onFrame(frame)
    },
    async pick(camera, u, v) {
      return scene && generated ? pickScene(currentEnv, generated, scene, player.name, camera, u, v) : null
    },
    dispose() {},
  }
}

/** Leave one core for the page itself. Past ~8 workers the gains flatten out. */
export const DEFAULT_WORKER_COUNT = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))

/** The part of a Web Worker the tracer uses, so Node's worker threads can stand in for it. */
export interface TraceWorker {
  postMessage: (message: WorkerRequest, transfer: Transferable[]) => void
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null
  terminate: () => void
}

function spawnBrowserWorker(): TraceWorker {
  return new Worker(new URL('../workers/raytrace.worker.ts', import.meta.url), { type: 'module' })
}

/**
 * Each worker holds its own copy of the scene and traces an interleaved share of the rows:
 * worker k does rows k, k + n, k + 2n, ... That gives every worker an even mix of cheap sky
 * rows and expensive scenery rows.
 */
export function createWorkerTracer({ onScene, onFrame }: TracerEvents, count = DEFAULT_WORKER_COUNT, spawn = spawnBrowserWorker): Tracer {
  let pending = 0
  let frameStart = 0
  let frame: TracedFrame | undefined
  /** Picks asked of the first worker, answered in order. */
  const picks: ((picked: Picked | null) => void)[] = []

  const workers = Array.from({ length: count }, () => {
    const worker = spawn()
    worker.onmessage = e => onMessage(worker, e.data)
    return worker
  })

  function post(worker: TraceWorker, message: WorkerRequest, transfer: Transferable[] = []) {
    worker.postMessage(message, transfer)
  }

  function onMessage(worker: TraceWorker, msg: WorkerResponse) {
    if (msg.type === 'scene') {
      // Every worker replies; they all built the same scene, so report it once.
      if (worker === workers[0]) onScene(msg.summary)
      return
    }
    if (msg.type === 'pick') {
      picks.shift()?.(msg.picked)
      return
    }
    if (!frame) return

    // Unpack this worker's interleaved rows into the full frame.
    const { cols, rows } = frame
    for (let y = msg.rowStart, row = 0; y < rows; y += msg.rowStep, row++) {
      frame.ink.set(msg.ink.subarray(row * cols, (row + 1) * cols), y * cols)
      frame.depths.set(msg.depths.subarray(row * cols, (row + 1) * cols), y * cols)
      frame.rgb.set(msg.rgb.subarray(row * cols * 3, (row + 1) * cols * 3), y * cols * 3)
      frame.normals.set(msg.normals.subarray(row * cols * 3, (row + 1) * cols * 3), y * cols * 3)
    }
    if (--pending > 0) return

    frame.traceMs = performance.now() - frameStart
    const done = frame
    frame = undefined
    onFrame(done)
  }

  return {
    label: `${count} workers`,
    get busy() {
      return pending > 0
    },
    setScene(envId, seed, size) {
      for (const w of workers) post(w, { type: 'scene', envId, seed, size })
    },
    setPlayer(kind, seed) {
      for (const w of workers) post(w, { type: 'player', kind, seed })
    },
    render(camera, cols, rows, time, player, timeOfDay = NOON, occlusion = false) {
      if (pending) return
      pending = workers.length
      frameStart = performance.now()
      frame = emptyFrame(cols, rows)
      workers.forEach((w, k) => {
        const band = emptyFrame(cols, Math.max(0, Math.ceil((rows - k) / count)))
        const { ink, rgb, depths, normals } = band
        post(w, { type: 'render', camera, time, timeOfDay, occlusion, player, cols, rows, rowStart: k, rowStep: count, ink, rgb, depths, normals }, [ink.buffer, rgb.buffer, depths.buffer, normals.buffer])
      })
    },
    pick(camera, u, v) {
      // Every worker holds the whole scene: one is enough.
      return new Promise((resolve) => {
        picks.push(resolve)
        post(workers[0]!, { type: 'pick', camera, u, v })
      })
    },
    dispose() {
      for (const w of workers) w.terminate()
      pending = 0
      frame = undefined
      for (const resolve of picks.splice(0)) resolve(null)
    },
  }
}
