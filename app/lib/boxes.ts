/**
 * Boxes dropped into an environment by clicking it. They are plain primitives, added on top
 * of the generated scene by every renderer, and the player collides with them like any other.
 * With gravity on they fall onto the environment or onto each other.
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
/** m/s². */
export const GRAVITY = 9.81

/** Where a click landed, as far as dropping a box there goes. */
export interface DropSpot {
  point: Vec3
  /** Unit normal of the surface clicked. */
  normal: Vec3
  /** Height of the environment straight below the spot, leaving out dropped boxes. */
  floor: number
}

export interface DroppedBox {
  box: Primitive
  /** Height of the environment under it, which it can fall to with gravity on. */
  floor: number
  /** Downward speed while falling, m/s. */
  speed: number
}

/**
 * A box of random size and color at a clicked spot: on top of a roof or box, under a
 * ceiling, or against a wall on the side that was clicked, its middle at the click's height.
 */
export function dropBox({ point: [x, y, z], normal: [nx, ny, nz], floor }: DropSpot, rand = Math.random): DroppedBox {
  const side = () => Math.round(between(rand, MIN_SIDE, MAX_SIDE) * 2) / 2
  const width = side()
  const depth = side()
  const height = side()
  // Clicked a top: it stands there as it is.
  if (ny <= -0.5) y -= height
  else if (ny < 0.5) {
    if (Math.abs(nx) > Math.abs(nz)) x += Math.sign(nx) * (width / 2 + GAP)
    else z += Math.sign(nz) * (depth / 2 + GAP)
    y = Math.max(floor, y - height / 2)
  }
  const box: Primitive = { shape: 'box', x, y, z, width, depth, height, color: pick(rand, COLORS), roughness: 0.7, label: `Box · ${width} × ${depth} × ${height} m`, dropped: true }
  return { box, floor: Math.min(floor, y), speed: 0 }
}

const overlap = (a: Primitive, b: Primitive) =>
  Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2

/**
 * Lets the boxes fall for `dt` seconds, each onto its floor or the highest box below it.
 * Returns the moved boxes, or undefined when all of them are resting.
 */
export function fallBoxes(boxes: DroppedBox[], dt: number): DroppedBox[] | undefined {
  // Lowest first, so a box lands on where the one below it is now.
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.box.y - boxes[b]!.box.y)
  const next = [...boxes]
  let moved = false
  for (const i of order) {
    const { box, floor, speed } = next[i]!
    let rest = floor
    for (const j of order) {
      const other = next[j]!.box
      const top = other.y + other.height
      if (j !== i && top <= box.y + 1e-3 && top > rest && overlap(box, other)) rest = top
    }
    if (box.y <= rest) continue
    moved = true
    const v = speed + GRAVITY * dt
    const y = Math.max(rest, box.y - v * dt)
    next[i] = { box: { ...box, y }, floor, speed: y === rest ? 0 : v }
  }
  return moved ? next : undefined
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
