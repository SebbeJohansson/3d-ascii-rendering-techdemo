// Ray traces off the main thread. Holds its own copy of the scene, so each frame only needs
// a camera in and two small pixel buffers out. The page runs several of these in parallel,
// each tracing an interleaved share of the rows (see lib/tracers.ts).
import type { Primitive } from '../environments/types'
import type { DrawnShape } from '../lib/shapes'
import { renderScene, type Camera, type MeshPart } from '../lib/raycaster'
import { createPlayerSlot, createSceneSlot, pickScene, poseScene, type Picked } from '../lib/tracers'
import type { PlayerKind, PlayerPose } from '../players'

export type WorkerRequest =
  /**
   * A new scene. 'build' builds it; 'share' builds it and replies with its meshes' part for
   * the other workers; 'wait' generates it and waits for that part (a 'part' message) before
   * building it, so its BVH is built once, not in every worker.
   */
  | { type: 'scene', envId: string, seed: number, size: number, mode: 'build' | 'share' | 'wait', version: number }
  | { type: 'part', version: number, part?: MeshPart }
  | { type: 'boxes', boxes: Primitive[] }
  | { type: 'shapes', shapes: DrawnShape[] }
  | { type: 'player', kind: PlayerKind | null, seed: number }
  /** What the ray through (u, v) of the view hits, in the scene as the last frame posed it. */
  | { type: 'pick', camera: Camera, u: number, v: number }
  /** Traces rows rowStart, rowStart + rowStep, ... into tightly packed ink/rgb. */
  | { type: 'render', camera: Camera, time: number, timeOfDay: number, occlusion: boolean, player?: PlayerPose, cols: number, rows: number, rowStart: number, rowStep: number, ink: Uint8Array, rgb: Uint8Array, depths: Float32Array, normals: Int8Array }

export type WorkerResponse =
  /** With `version` when it answers a 'share' scene, with the part to hand on. */
  | { type: 'scene', summary: string, version?: number, part?: MeshPart }
  | { type: 'pick', picked: Picked | null }
  | { type: 'frame', rowStart: number, rowStep: number, ink: Uint8Array, rgb: Uint8Array, depths: Float32Array, normals: Int8Array }

const slot = createSceneSlot()
const player = createPlayerSlot()
/** The version of the scene generated and waiting for its part, if one is. */
let waiting: number | undefined

function reply(message: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  const { scene, generated, envId } = slot
  if (msg.type === 'scene') {
    if (msg.mode === 'wait') {
      slot.generate(msg.envId, msg.seed, msg.size)
      waiting = msg.version
      return
    }
    waiting = undefined
    const summary = slot.set(msg.envId, msg.seed, msg.size)
    reply(msg.mode === 'share' ? { type: 'scene', summary, version: msg.version, part: slot.shareable() } : { type: 'scene', summary })
  }
  else if (msg.type === 'part') {
    // A part for a scene since replaced is no use: the right one is on its way.
    if (msg.version !== waiting) return
    waiting = undefined
    reply({ type: 'scene', summary: slot.build(msg.part) })
  }
  else if (msg.type === 'boxes') {
    const summary = slot.setBoxes(msg.boxes)
    if (summary) reply({ type: 'scene', summary })
  }
  else if (msg.type === 'shapes') {
    const summary = slot.setShapes(msg.shapes)
    if (summary) reply({ type: 'scene', summary })
  }
  else if (msg.type === 'player') {
    player.set(msg.kind, msg.seed)
  }
  else if (msg.type === 'pick') {
    reply({ type: 'pick', picked: scene && generated ? pickScene(envId, generated, scene, player.name, msg.camera, msg.u, msg.v) : null })
  }
  else if (scene && generated) {
    const { camera, time, timeOfDay, occlusion, player: pose, cols, rows, rowStart, rowStep, ink, rgb, depths, normals } = msg
    // Every worker poses the scene for the same time, so all rows show the same moment.
    poseScene(envId, generated, scene, time, timeOfDay)
    player.attach(scene, pose, time)
    scene.occlusion = occlusion
    renderScene(scene, camera, cols, rows, ink, rgb, depths, normals, rowStart, rowStep)
    // Hand the buffers back without copying.
    reply({ type: 'frame', rowStart, rowStep, ink, rgb, depths, normals }, [ink.buffer, rgb.buffer, depths.buffer, normals.buffer])
  }
}
