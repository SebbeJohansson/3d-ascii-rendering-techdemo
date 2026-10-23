/**
 * Ray tracing a terrain mesh laid out as a grid (Mesh.heightfield) by walking its cells
 * instead of a BVH. A ray over land runs long and flat, which a BVH handles badly: its boxes
 * along the way overlap and each gets tested. Walking the grid in order instead finds the
 * first hit cell by cell, and skips whole tiles of cells the ray passes above.
 *
 * Hits are the same triangles, with the same barycentric weights, as the BVH would find, so
 * shading them needs nothing new.
 */
import { bvhHit } from './bvh'

/** Cells per side of a tile, which the walk skips at once when the ray is above it. */
const TILE = 8

export interface Heightfield {
  /** Vertices per side; vertex i * n + j is at (start + i * step, start + j * step). */
  n: number
  start: number
  step: number
  /** Where the grid's vertices and triangles start in the arrays it is traced in. */
  firstVertex: number
  firstTriangle: number
  /** Tiles per side, and the highest point of each tile. */
  tiles: number
  tileMax: Float32Array
  top: number
}

export function buildHeightfield(positions: Float32Array, firstVertex: number, firstTriangle: number, { n, start, step }: { n: number, start: number, step: number }): Heightfield {
  const tiles = Math.ceil((n - 1) / TILE)
  const tileMax = new Float32Array(tiles * tiles).fill(-Infinity)
  const height = (i: number, j: number) => positions[(firstVertex + i * n + j) * 3 + 1]!
  let top = -Infinity
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const h = Math.max(height(i, j), height(i, j + 1), height(i + 1, j), height(i + 1, j + 1))
      const t = Math.floor(i / TILE) * tiles + Math.floor(j / TILE)
      if (h > tileMax[t]!) tileMax[t] = h
      if (h > top) top = h
    }
  }
  return { n, start, step, firstVertex, firstTriangle, tiles, tileMax, top }
}

/** Möller–Trumbore against the triangle of vertices a, b, c: its t, or Infinity. Sets u, v. */
let hu = 0
let hv = 0
function triangle(p: Float32Array, a: number, b: number, c: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
  const a3 = a * 3
  const b3 = b * 3
  const c3 = c * 3
  const e1x = p[b3]! - p[a3]!
  const e1y = p[b3 + 1]! - p[a3 + 1]!
  const e1z = p[b3 + 2]! - p[a3 + 2]!
  const e2x = p[c3]! - p[a3]!
  const e2y = p[c3 + 1]! - p[a3 + 1]!
  const e2z = p[c3 + 2]! - p[a3 + 2]!
  const px = dy * e2z - dz * e2y
  const py = dz * e2x - dx * e2z
  const pz = dx * e2y - dy * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (Math.abs(det) < 1e-12) return Infinity
  const inv = 1 / det
  const tx = ox - p[a3]!
  const ty = oy - p[a3 + 1]!
  const tz = oz - p[a3 + 2]!
  const u = (tx * px + ty * py + tz * pz) * inv
  if (u < 0 || u > 1) return Infinity
  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (dx * qx + dy * qy + dz * qz) * inv
  if (v < 0 || u + v > 1) return Infinity
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv
  if (t <= 1e-4) return Infinity
  hu = u
  hv = v
  return t
}

/**
 * The first hit on the grid closer than maxT, or Infinity; like intersectBvh(), it leaves the
 * triangle (counted in the arrays traced in) and barycentric weights in bvhHit.
 */
export function intersectHeightfield(h: Heightfield, p: Float32Array, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  const { n, start, step, tiles, tileMax, firstVertex: v0 } = h
  const ix = 1 / (dx || 1e-12)
  const iy = 1 / (dy || 1e-12)
  const iz = 1 / (dz || 1e-12)
  const end = start + (n - 1) * step
  // Clip to the grid's box.
  let t0 = 0
  let t1 = maxT
  let a = (start - ox) * ix
  let b = (end - ox) * ix
  t0 = Math.max(t0, Math.min(a, b))
  t1 = Math.min(t1, Math.max(a, b))
  a = (start - oz) * iz
  b = (end - oz) * iz
  t0 = Math.max(t0, Math.min(a, b))
  t1 = Math.min(t1, Math.max(a, b))
  if (dy >= 0) {
    if (oy > h.top) return Infinity
    t1 = Math.min(t1, (h.top - oy) * iy)
  }
  else if (oy > h.top) t0 = Math.max(t0, (h.top - oy) * iy)
  if (t0 > t1) return Infinity

  // A DDA over tiles; inside a tile the ray isn't above, a DDA over its cells.
  const tileSize = TILE * step
  const si = dx > 0 ? 1 : -1
  const sj = dz > 0 ? 1 : -1
  let ti = Math.min(tiles - 1, Math.max(0, Math.floor((ox + dx * t0 - start) / tileSize)))
  let tj = Math.min(tiles - 1, Math.max(0, Math.floor((oz + dz * t0 - start) / tileSize)))
  let tmx = ((ti + (dx > 0 ? 1 : 0)) * tileSize + start - ox) * ix
  let tmz = ((tj + (dz > 0 ? 1 : 0)) * tileSize + start - oz) * iz
  const tdx = tileSize * Math.abs(ix)
  const tdz = tileSize * Math.abs(iz)
  const cdx = step * Math.abs(ix)
  const cdz = step * Math.abs(iz)
  let tEnter = t0
  for (;;) {
    const tExit = Math.min(tmx, tmz, t1)
    if (Math.min(oy + dy * tEnter, oy + dy * tExit) <= tileMax[ti * tiles + tj]!) {
      const iLo = ti * TILE
      const iHi = Math.min(n - 2, iLo + TILE - 1)
      const jLo = tj * TILE
      const jHi = Math.min(n - 2, jLo + TILE - 1)
      const tm = tEnter + 1e-6
      let ci = Math.min(iHi, Math.max(iLo, Math.floor((ox + dx * tm - start) / step)))
      let cj = Math.min(jHi, Math.max(jLo, Math.floor((oz + dz * tm - start) / step)))
      let cmx = ((ci + (dx > 0 ? 1 : 0)) * step + start - ox) * ix
      let cmz = ((cj + (dz > 0 ? 1 : 0)) * step + start - oz) * iz
      for (;;) {
        // The cell's two triangles, as the terrain mesh lays them out.
        const k = v0 + ci * n + cj
        let t = triangle(p, k, k + 1, k + n, ox, oy, oz, dx, dy, dz)
        let second = 0
        let u = hu
        let v = hv
        const t2 = triangle(p, k + n, k + 1, k + n + 1, ox, oy, oz, dx, dy, dz)
        if (t2 < t) {
          t = t2
          second = 1
          u = hu
          v = hv
        }
        const cellExit = Math.min(cmx, cmz)
        if (t < maxT && t <= Math.min(cellExit, t1) + 1e-3) {
          bvhHit.triangle = h.firstTriangle + (ci * (n - 1) + cj) * 2 + second
          bvhHit.u = u
          bvhHit.v = v
          return t
        }
        if (cellExit >= tExit) break
        if (cmx < cmz) {
          ci += si
          cmx += cdx
        }
        else {
          cj += sj
          cmz += cdz
        }
        if (ci < iLo || ci > iHi || cj < jLo || cj > jHi) break
      }
    }
    if (tExit >= t1) return Infinity
    tEnter = tExit
    if (tmx < tmz) {
      ti += si
      tmx += tdx
    }
    else {
      tj += sj
      tmz += tdz
    }
    if (ti < 0 || ti >= tiles || tj < 0 || tj >= tiles) return Infinity
  }
}
