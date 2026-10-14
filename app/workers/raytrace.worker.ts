// Ray traces the city off the main thread. Holds its own copy of the scene,
// so each frame only needs a camera in and two small pixel buffers out. The page runs
// several of these in parallel, each tracing an interleaved share of the rows.
import { BLOCK_SIZE, ROAD_WIDTH, generateCity } from '../utils/city'
import { buildRaycastScene, renderCity, type Camera, type RaycastScene } from '../utils/raycaster'

export type WorkerRequest =
  | { type: 'scene', seed: number, blocks: number }
  /** Traces rows rowStart, rowStart + rowStep, ... into tightly packed ink/rgb. */
  | { type: 'render', camera: Camera, cols: number, rows: number, rowStart: number, rowStep: number, ink: Uint8Array, rgb: Uint8Array }

export type WorkerResponse =
  | { type: 'scene', buildings: number }
  | { type: 'frame', cols: number, rows: number, rowStart: number, rowStep: number, ink: Uint8Array, rgb: Uint8Array }

let scene: RaycastScene | undefined

function reply(message: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'scene') {
    const city = generateCity({ seed: msg.seed, blocks: msg.blocks, blockSize: BLOCK_SIZE, roadWidth: ROAD_WIDTH })
    scene = buildRaycastScene(city, msg.blocks)
    reply({ type: 'scene', buildings: city.buildings.length })
  }
  else if (scene) {
    const { camera, cols, rows, rowStart, rowStep, ink, rgb } = msg
    renderCity(scene, camera, cols, rows, ink, rgb, rowStart, rowStep)
    // Hand the buffers back without copying.
    reply({ type: 'frame', cols, rows, rowStart, rowStep, ink, rgb }, [ink.buffer, rgb.buffer])
  }
}
