import type { Primitive } from '../environments/types'
import type { Vec3 } from './math'

/** A player's collision shape: an upright cylinder standing on its position. */
export interface Collider {
  radius: number
  height: number
}

/** Anything this much higher than the player's feet is stepped onto instead of blocking. */
const STEP = 0.6

/**
 * Whether (x, z) lies on a primitive's footprint, grown by `margin`. Boxes are rectangles;
 * every other shape counts as the circle it stands on.
 */
function onFootprint(p: Primitive, x: number, z: number, margin: number) {
  if (p.shape === 'box') return Math.abs(x - p.x) <= p.width / 2 + margin && Math.abs(z - p.z) <= p.depth / 2 + margin
  const r = Math.max(p.width, p.depth) / 2 + margin
  return (x - p.x) ** 2 + (z - p.z) ** 2 <= r * r
}

/**
 * Moves a player at `position` out of every primitive it overlaps, sideways only, and lifts
 * it onto curbs and other low steps. `ground` is the height of the land under it. Returns the
 * corrected position, the height of what it stands on, and whether anything blocked it.
 */
export function resolveCollisions(primitives: Primitive[], position: Vec3, { radius, height }: Collider, flies: boolean, ground = 0) {
  let [x, y, z] = position

  // What it stands on: the highest top under its center that is low enough to step onto.
  let floor = ground
  for (const p of primitives) {
    const top = p.y + p.height
    if (top > floor && top <= y + STEP && onFootprint(p, x, z, 0)) floor = top
  }
  y = flies ? Math.max(y, floor) : floor

  // Then push out of anything taller that overlaps it. Twice, so being pushed out of one
  // primitive into a neighbour (an inside corner) gets corrected too.
  let hit = false
  for (let pass = 0; pass < 2; pass++) {
    for (const p of primitives) {
      if (p.y + p.height <= y + STEP || p.y >= y + height) continue
      if (!onFootprint(p, x, z, radius)) continue
      let nx: number
      let nz: number
      let depth: number
      if (p.shape === 'box') {
        const dx = x - Math.min(p.x + p.width / 2, Math.max(p.x - p.width / 2, x))
        const dz = z - Math.min(p.z + p.depth / 2, Math.max(p.z - p.depth / 2, z))
        const d = Math.hypot(dx, dz)
        if (d > 1e-6) {
          nx = dx / d
          nz = dz / d
          depth = radius - d
        }
        else {
          // Center inside the box: leave through the nearest side.
          const ox = p.width / 2 - Math.abs(x - p.x)
          const oz = p.depth / 2 - Math.abs(z - p.z)
          nx = ox < oz ? Math.sign(x - p.x) || 1 : 0
          nz = ox < oz ? 0 : Math.sign(z - p.z) || 1
          depth = Math.min(ox, oz) + radius
        }
      }
      else {
        const dx = x - p.x
        const dz = z - p.z
        const d = Math.hypot(dx, dz) || 1e-6
        nx = dx / d
        nz = dz / d
        depth = Math.max(p.width, p.depth) / 2 + radius - d
      }
      if (depth <= 0) continue
      x += nx * depth
      z += nz * depth
      hit = true
    }
  }
  return { position: [x, y, z] as Vec3, floor, hit }
}
