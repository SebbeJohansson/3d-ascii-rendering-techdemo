// Ray traces off the main thread. Holds its own copy of the scene, so each frame only needs
// a camera in and two small pixel buffers out. The page runs several of these in parallel,
// each tracing an interleaved share of the rows (see lib/tracers.ts).
import { getEnvironment } from '../environments'
import { buildRaycastScene, renderScene, type Camera, type RaycastScene } from '../lib/raycaster'

export type WorkerRequest =
  | { type: 'scene', envId: string, seed: number, size: number }
  /** Traces rows rowStart, rowStart + rowStep, ... into tightly packed ink/rgb. */
  | { type: 'render', camera: Camera, cols: number, rows: number, rowStart: number, rowStep: number, ink: Uint8Array, rgb: Uint8Array }

export type WorkerResponse =
  | { type: 'scene', summary: string }
  | { type: 'frame', rowStart: number, rowStep: number, ink: Uint8Array, rgb: Uint8Array }

let scene: RaycastScene | undefined

function reply(message: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'scene') {
    const env = getEnvironment(msg.envId)
    const generated = env.generate(msg.seed, msg.size)
    scene = buildRaycastScene(env, generated)
    reply({ type: 'scene', summary: generated.summary })
  }
  else if (scene) {
    const { camera, cols, rows, rowStart, rowStep, ink, rgb } = msg
    renderScene(scene, camera, cols, rows, ink, rgb, rowStart, rowStep)
    // Hand the buffers back without copying.
    reply({ type: 'frame', rowStart, rowStep, ink, rgb }, [ink.buffer, rgb.buffer])
  }
}
