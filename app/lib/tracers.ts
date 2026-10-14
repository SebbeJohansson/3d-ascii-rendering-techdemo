/**
 * Two interchangeable ways to run the ray tracer: on the main thread, or split across a pool
 * of Web Workers. Both report results through the same callbacks, so the page doesn't care
 * which one is active.
 */
import { getEnvironment } from '../environments'
import type { WorkerRequest, WorkerResponse } from '../workers/raytrace.worker'
import { buildRaycastScene, renderScene, type Camera, type RaycastScene } from './raycaster'

export interface TracedFrame {
  cols: number
  rows: number
  ink: Uint8Array
  rgb: Uint8Array
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
  render: (camera: Camera, cols: number, rows: number) => void
  dispose: () => void
}

export function createMainThreadTracer({ onScene, onFrame }: TracerEvents): Tracer {
  let scene: RaycastScene | undefined
  return {
    label: 'main thread',
    busy: false,
    setScene(envId, seed, size) {
      const env = getEnvironment(envId)
      const generated = env.generate(seed, size)
      scene = buildRaycastScene(env, generated)
      onScene(generated.summary)
    },
    render(camera, cols, rows) {
      if (!scene) return
      const ink = new Uint8Array(cols * rows)
      const rgb = new Uint8Array(cols * rows * 3)
      const start = performance.now()
      renderScene(scene, camera, cols, rows, ink, rgb)
      onFrame({ cols, rows, ink, rgb, traceMs: performance.now() - start })
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
      frame.rgb.set(msg.rgb.subarray(row * cols * 3, (row + 1) * cols * 3), y * cols * 3)
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
    render(camera, cols, rows) {
      if (pending) return
      pending = workers.length
      frameStart = performance.now()
      frame = { cols, rows, ink: new Uint8Array(cols * rows), rgb: new Uint8Array(cols * rows * 3), traceMs: 0 }
      workers.forEach((w, k) => {
        const bandRows = Math.max(0, Math.ceil((rows - k) / count))
        const ink = new Uint8Array(bandRows * cols)
        const rgb = new Uint8Array(bandRows * cols * 3)
        post(w, { type: 'render', camera, cols, rows, rowStart: k, rowStep: count, ink, rgb }, [ink.buffer, rgb.buffer])
      })
    },
    dispose() {
      for (const w of workers) w.terminate()
      pending = 0
      frame = undefined
    },
  }
}
