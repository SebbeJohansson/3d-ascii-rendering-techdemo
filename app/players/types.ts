import type { Mesh } from '../environments/types'
import type { Collider } from '../lib/collision'

export type PlayerKind = 'dragon' | 'car'

/** A built player model, in its own space: facing +x, standing on y = 0. */
export interface PlayerModel {
  mesh: Mesh
  /** Moves the model for `time` (seconds), writing into mesh positions and normals in place. */
  animate?: (time: number) => void
}

/** Something the viewer can spawn and steer through any environment. */
export interface Player {
  id: PlayerKind
  name: string
  /** Model units to world units. */
  scale: number
  /** Leaves the ground: Space climbs and Shift dives. Otherwise it stays on the ground. */
  flies: boolean
  /** Top speed forward, in world units per second. Reverse is a third of it. */
  speed: number
  /** World units per second², speeding up and braking. */
  acceleration: number
  /** Radians per second at full steering. */
  turnRate: number
  /** Its body for collisions, in world units. */
  collider: Collider
  /** Chase camera: how far behind and above it sits, and how high above the player it aims. */
  camera: { distance: number, height: number, lookHeight: number }
  build: (seed: number) => PlayerModel
}

/** Where a player is. Sent to both renderers every frame. */
export interface PlayerPose {
  position: [number, number, number]
  /** Rotation around +y in radians. 0 faces +x; forward is (cos h, 0, -sin h), like three's rotation.y. */
  heading: number
}
