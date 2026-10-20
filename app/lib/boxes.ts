/**
 * Boxes dropped into an environment by clicking it. They are plain primitives, added on top
 * of the generated scene by every renderer, and the player collides with them like any other.
 * With gravity on they fall onto the environment or onto each other. With sticking on, a
 * box sticks to the face it was dropped on and doesn't fall.
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
/** How far above where a click would put it a box dropped in the air appears. */
const AIR = 8
/** m/s². */
export const GRAVITY = 9.81

/** Where a click landed, as far as dropping a box there goes. */
export interface DropSpot {
  point: Vec3
  /** Unit normal of the surface clicked. */
  normal: Vec3
  /** Height of the environment straight below the spot, leaving out dropped boxes. */
  floor: number
  /** Index of the dropped box clicked, if one was. */
  box?: number
}

export interface DroppedBox {
  box: Primitive
  /** Height of the environment under it, which it can fall to with gravity on. */
  floor: number
  /** Downward speed while falling, m/s. */
  speed: number
  /** Stuck to what it was dropped on: it doesn't fall, but moves with the box it is stuck to. */
  stuck?: boolean
  /** Index of the dropped box it is stuck to. */
  on?: number
}

/**
 * A box of random size and color at a clicked spot: on top of a roof or box, under a
 * ceiling, or against a wall on the side that was clicked, its middle at the click's height.
 * With `stick`, it sticks there, and a box clicked gets the new one centered on its face.
 * With `air`, it appears AIR m above where it would go otherwise, stuck to nothing.
 */
export function dropBox(spot: DropSpot, { boxes = [], stick = false, air = false }: { boxes?: readonly DroppedBox[], stick?: boolean, air?: boolean } = {}, rand = Math.random): DroppedBox {
  const side = () => Math.round(between(rand, MIN_SIDE, MAX_SIDE) * 2) / 2
  const width = side()
  const depth = side()
  const height = side()
  const color = pick(rand, COLORS)
  const label = `Box · ${width} × ${depth} × ${height} m`
  const target = stick && !air && spot.box !== undefined ? boxes[spot.box]?.box : undefined
  if (target) {
    const [nx, ny, nz] = spot.normal
    let { x, y, z } = target
    // Middle of the target's height, then flush against the clicked face.
    y += target.height / 2 - height / 2
    if (Math.abs(ny) >= Math.abs(nx) && Math.abs(ny) >= Math.abs(nz)) y += Math.sign(ny) * (target.height + height) / 2
    else if (Math.abs(nx) > Math.abs(nz)) x += Math.sign(nx) * (target.width + width) / 2
    else z += Math.sign(nz) * (target.depth + depth) / 2
    const box: Primitive = { shape: 'box', x, y, z, width, depth, height, color, roughness: 0.7, label, dropped: true }
    return { box, floor: Math.min(spot.floor, y), speed: 0, stuck: true, on: spot.box }
  }
  let [x, y, z] = spot.point
  const [nx, ny, nz] = spot.normal
  const { floor } = spot
  // Clicked a top: it stands there as it is.
  if (ny <= -0.5) y -= height
  else if (ny < 0.5) {
    if (Math.abs(nx) > Math.abs(nz)) x += Math.sign(nx) * (width / 2 + GAP)
    else z += Math.sign(nz) * (depth / 2 + GAP)
    y = Math.max(floor, y - height / 2)
  }
  const rest = y
  if (air) y += AIR
  const box: Primitive = { shape: 'box', x, y, z, width, depth, height, color, roughness: 0.7, label, dropped: true }
  return { box, floor: Math.min(floor, rest), speed: 0, stuck: (stick && !air) || undefined }
}

const overlap = (a: Primitive, b: Primitive) =>
  Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2

/** Whether box `i` is stuck to box `to`, directly or through other boxes. */
function stuckTo(boxes: readonly DroppedBox[], i: number, to: number) {
  for (let on = boxes[i]!.on; on !== undefined; on = boxes[on]!.on) {
    if (on === to) return true
  }
  return false
}

/**
 * Lets the boxes fall for `dt` seconds, each onto its floor or the highest box below it.
 * A box falls together with the boxes stuck to it, until one of them lands; stuck boxes
 * don't fall on their own. Returns the moved boxes, or undefined when all of them are resting.
 */
export function fallBoxes(boxes: DroppedBox[], dt: number): DroppedBox[] | undefined {
  // Lowest first, so a box lands on where the one below it is now.
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.box.y - boxes[b]!.box.y)
  const next = [...boxes]
  let moved = false
  for (const i of order) {
    const { stuck, speed } = next[i]!
    if (stuck) continue
    const group = order.filter(j => j === i || stuckTo(next, j, i))
    // How far the group can fall before one of its boxes lands.
    let gap = Infinity
    for (const m of group) {
      const { box, floor } = next[m]!
      let rest = floor
      for (const j of order) {
        const other = next[j]!.box
        const top = other.y + other.height
        if (!group.includes(j) && top <= box.y + 1e-3 && top > rest && overlap(box, other)) rest = top
      }
      gap = Math.min(gap, box.y - rest)
    }
    if (gap <= 0) continue
    moved = true
    const v = speed + GRAVITY * dt
    const dy = Math.min(gap, v * dt)
    for (const m of group) next[m] = { ...next[m]!, box: { ...next[m]!.box, y: next[m]!.box.y - dy } }
    next[i] = { ...next[i]!, speed: dy === gap ? 0 : v }
  }
  return moved ? next : undefined
}

/**
 * The boxes without box `i`. Boxes stuck to it come loose, and can fall; the boxes stuck to
 * those stay stuck to them.
 */
export function removeBox(boxes: readonly DroppedBox[], i: number): DroppedBox[] {
  return boxes.filter((_, j) => j !== i).map((b) => {
    if (b.on === undefined || b.on < i) return b
    if (b.on > i) return { ...b, on: b.on - 1 }
    return { ...b, stuck: undefined, on: undefined }
  })
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
