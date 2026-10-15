/**
 * Lit windows on city buildings at night. The pattern is a grid over every wall, one window
 * per floor and bay, and a hash picks which ones are lit. The ray tracer uses windowLit()
 * below; the 3D view runs the same steps in a shader (lib/three.ts), so the hash is done in
 * 32-bit floats here to light the same windows as the GPU.
 */

export const FLOOR_HEIGHT = 3.2
export const WINDOW_SPACING = 2.6
/** The glass, as shares of a bay's width and a floor's height. */
export const GLASS_X: readonly [number, number] = [0.2, 0.8]
export const GLASS_Y: readonly [number, number] = [0.3, 0.8]
/** Share of windows lit at night. */
export const LIT_SHARE = 0.4
export const WINDOW_COLOR = 0xffc874
/** How bright lit windows are, as a multiple of WINDOW_COLOR. */
export const WINDOW_GLOW = 1.6
/** Spreads row, column and face into one hash input. */
export const HASH_ROW = 157
export const HASH_COLUMN = 311
export const HASH_FACE = 59

const f = Math.fround

/** A pseudo-random 0..1 from n (Dave Hoskins' hash11), step by step in float32 like a shader. */
export function windowHash(n: number) {
  let p = f(n * f(0.1031))
  p = f(p - Math.floor(p))
  p = f(p * f(p + f(33.33)))
  p = f(p * f(p + p))
  return f(p - Math.floor(p))
}

/**
 * Whether the wall point at height y is a lit window. `face` is 0..3 for walls facing +x, -x,
 * +z and -z; `u` is the point's position along the wall (z for x-facing walls, x otherwise).
 */
export function windowLit(face: number, u: number, y: number) {
  const fy = y / FLOOR_HEIGHT
  const row = Math.floor(fy)
  const fx = u / WINDOW_SPACING
  const column = Math.floor(fx)
  const gx = fx - column
  const gy = fy - row
  if (gx < GLASS_X[0] || gx > GLASS_X[1] || gy < GLASS_Y[0] || gy > GLASS_Y[1]) return false
  return windowHash(row * HASH_ROW + column * HASH_COLUMN + face * HASH_FACE) <= LIT_SHARE
}
