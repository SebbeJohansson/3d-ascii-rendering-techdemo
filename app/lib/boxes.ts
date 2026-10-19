/**
 * Boxes dropped into an environment by clicking it. They are plain primitives, added on top
 * of the generated scene by every renderer, and the player collides with them like any other.
 */
import type { EnvironmentScene, Primitive } from '../environments/types'
import type { Vec3 } from './math'
import { between, pick } from './random'

const COLORS = [0xe74c3c, 0xf39c12, 0xf1c40f, 0x2ecc71, 0x1abc9c, 0x3498db, 0x9b59b6, 0xecf0f1]
/** Sides are whole and half meters in this range. */
const MIN_SIDE = 1
const MAX_SIDE = 5
/** Space left between a box and the wall it was dropped against. */
const GAP = 0.01

/** Where a click landed, as far as dropping a box there goes. */
export interface DropSpot {
  point: Vec3
  /** Unit normal of the surface clicked. */
  normal: Vec3
  /** Height of the first surface straight below the spot: what a box dropped there lands on. */
  landing: number
}

/**
 * A box of random size and color, dropped at a clicked spot: onto what was clicked, or for a
 * wall, against it on the side that was clicked, down to whatever is below.
 */
export function dropBox({ point: [x, , z], normal: [nx, ny, nz], landing }: DropSpot, rand = Math.random): Primitive {
  const side = () => Math.round(between(rand, MIN_SIDE, MAX_SIDE) * 2) / 2
  const width = side()
  const depth = side()
  const height = side()
  if (Math.abs(ny) < 0.5) {
    if (Math.abs(nx) > Math.abs(nz)) x += Math.sign(nx) * (width / 2 + GAP)
    else z += Math.sign(nz) * (depth / 2 + GAP)
  }
  return { shape: 'box', x, y: landing, z, width, depth, height, color: pick(rand, COLORS), roughness: 0.7, label: `Box · ${width} × ${depth} × ${height} m` }
}

/** The generated scene with dropped boxes added, and counted in its summary. */
export function withBoxes(scene: EnvironmentScene, boxes: readonly Primitive[]): EnvironmentScene {
  if (!boxes.length) return scene
  return {
    ...scene,
    primitives: [...scene.primitives, ...boxes],
    summary: `${scene.summary} · ${boxes.length} ${boxes.length === 1 ? 'box' : 'boxes'}`,
  }
}
