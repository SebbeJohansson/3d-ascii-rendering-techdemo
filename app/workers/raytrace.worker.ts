// Ray traces off the main thread. Holds its own copy of the scene, so each frame only needs
// a camera in and two small pixel buffers out. The page runs several of these in parallel,
// each tracing an interleaved share of the rows (see lib/tracers.ts).
import { getEnvironment } from '../environments'
import type { EnvironmentScene } from '../environments/types'
import { buildRaycastScene, renderScene, type Camera, type RaycastScene } from '../lib/raycaster'
import { createPlayerSlot, poseScene } from '../lib/tracers'
import type { PlayerKind, PlayerPose } from '../players'

export type WorkerRequest =
  | { type: 'scene', envId: string, seed: number, size: number }
  | { type: 'player', kind: PlayerKind | null, seed: number }
  /** Traces rows rowStart, rowStart + rowStep, ... into tightly packed ink/rgb. */
  | { type: 'render', camera: Camera, time: number, timeOfDay: number, player?: PlayerPose, cols: number, rows: number, rowStart: number, rowStep: number, ink: Uint8Array, rgb: Uint8Array, depths: Float32Array, normals: Int8Array }

export type WorkerResponse =
  | { type: 'scene', summary: string }
  | { type: 'frame', rowStart: number, rowStep: number, ink: Uint8Array, rgb: Uint8Array, depths: Float32Array, normals: Int8Array }

let scene: RaycastScene | undefined
let generated: EnvironmentScene | undefined
let envId = ''
const player = createPlayerSlot()

function reply(message: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'scene') {
    const env = getEnvironment(msg.envId)
    generated = env.generate(msg.seed, msg.size)
    scene = buildRaycastScene(env, generated)
    envId = msg.envId
    reply({ type: 'scene', summary: generated.summary })
  }
  else if (msg.type === 'player') {
    player.set(msg.kind, msg.seed)
  }
  else if (scene && generated) {
    const { camera, time, timeOfDay, player: pose, cols, rows, rowStart, rowStep, ink, rgb, depths, normals } = msg
    // Every worker poses the scene for the same time, so all rows show the same moment.
    poseScene(envId, generated, scene, time, timeOfDay)
    player.attach(scene, pose, time)
    renderScene(scene, camera, cols, rows, ink, rgb, depths, normals, rowStart, rowStep)
    // Hand the buffers back without copying.
    reply({ type: 'frame', rowStart, rowStep, ink, rgb, depths, normals }, [ink.buffer, rgb.buffer, depths.buffer, normals.buffer])
  }
}
