/**
 * Two interchangeable ways to run the ray tracer: on the main thread, or split across a pool
 * of Web Workers. Both report results through the same callbacks, so the page doesn't care
 * which one is active.
 */
import { getEnvironment } from '../environments'
import type { WorkerRequest, WorkerResponse } from '../workers/raytrace.worker'
import type { EnvironmentScene } from '../environments/types'
import { getPlayer, type PlayerKind, type PlayerModel, type PlayerPose } from '../players'
import { buildRaycastPlayer, buildRaycastScene, placePlayer, renderScene, updateMeshes, type Camera, type RaycastPlayer, type RaycastScene } from './raycaster'

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
  /** `time` (seconds) poses animated environments and players; `player` places the player. */
  render: (camera: Camera, cols: number, rows: number, time: number, player?: PlayerPose) => void
  dispose: () => void
}

/** Poses an animated environment for this frame and updates the ray tracer's copy of it. */
export function poseScene(envId: string, generated: EnvironmentScene, scene: RaycastScene, time: number) {
  const env = getEnvironment(envId)
  if (!env.animate) return
  env.animate(generated, time)
  updateMeshes(scene, generated)
}

/** The ray tracer's copy of the spawned player, kept apart from the environment's scene. */
export function createPlayerSlot() {
  let model: PlayerModel | undefined
  let raycast: RaycastPlayer | undefined
  return {
    set(kind: PlayerKind | null, seed: number) {
      if (!kind) {
        model = raycast = undefined
        return
      }
      const player = getPlayer(kind)
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
    render(camera, cols, rows, time, pose) {
      if (!scene || !generated) return
      poseScene(currentEnv, generated, scene, time)
      player.attach(scene, pose, time)
      const frame = emptyFrame(cols, rows)
      const start = performance.now()
      renderScene(scene, camera, cols, rows, frame.ink, frame.rgb, frame.depths, frame.normals)
      frame.traceMs = performance.now() - start
      onFrame(frame)
    },
    dispose() {},
  }
}

/** Leave one core for the page itself. Past ~8 workers the gains flatten out. */
export const DEFAULT_WORKER_COUNT = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))

/**
 * Each worker holds its own copy of the scene and traces an interleaved share of the rows:
 * worker k does rows k, k + n, k + 2n, ... That gives every worker an even mix of cheap sky
 * rows and expensive scenery rows.
 */
export function createWorkerTracer({ onScene, onFrame }: TracerEvents, count = DEFAULT_WORKER_COUNT): Tracer {
  let pending = 0
  let frameStart = 0
  let frame: TracedFrame | undefined

  const workers = Array.from({ length: count }, () => {
    const worker = new Worker(new URL('../workers/raytrace.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => onMessage(worker, e.data)
    return worker
  })

  function post(worker: Worker, message: WorkerRequest, transfer: Transferable[] = []) {
    worker.postMessage(message, transfer)
  }

  function onMessage(worker: Worker, msg: WorkerResponse) {
    if (msg.type === 'scene') {
      // Every worker replies; they all built the same scene, so report it once.
      if (worker === workers[0]) onScene(msg.summary)
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
    render(camera, cols, rows, time, player) {
      if (pending) return
      pending = workers.length
      frameStart = performance.now()
      frame = emptyFrame(cols, rows)
      workers.forEach((w, k) => {
        const band = emptyFrame(cols, Math.max(0, Math.ceil((rows - k) / count)))
        const { ink, rgb, depths, normals } = band
        post(w, { type: 'render', camera, time, player, cols, rows, rowStart: k, rowStep: count, ink, rgb, depths, normals }, [ink.buffer, rgb.buffer, depths.buffer, normals.buffer])
      })
    },
    dispose() {
      for (const w of workers) w.terminate()
      pending = 0
      frame = undefined
    },
  }
}
