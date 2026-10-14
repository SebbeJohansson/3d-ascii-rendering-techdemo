/**
 * Finds the cells that sit on an edge of the scene, so they can be drawn as line characters
 * (| / \ - _) instead of shading. That makes silhouettes and corners read like line art.
 *
 * A cell is on an edge when a neighbor is:
 * - sky (a silhouette),
 * - clearly farther away (this cell is the front of a depth jump), or
 * - facing a very different way at about the same depth (a crease, like a box corner).
 *   Only one of the two cells across a crease gets marked, so lines stay one cell thick.
 *
 * The line's direction comes from which neighbors differ: if the cells to the right differ,
 * the edge runs vertically ('|'); if the ones below differ, it runs horizontally ('_'); and
 * so on for the diagonals.
 */

/** Line characters, in the order of the codes findOutlines writes (1-based). */
export const OUTLINE_CHARS = '|/\\-_'
const VERTICAL = 1
const RISING = 2 // '/'
const FALLING = 3 // '\'
const TOP = 4 // '-'
const BOTTOM = 5 // '_'

/** A neighbor counts as farther away beyond this ratio of depth (plus a small fixed margin). */
const DEPTH_RATIO = 1.05
const DEPTH_MARGIN = 0.5
/** Surfaces meet at a crease when their normals' dot product is below this (about 60°). */
const CREASE_DOT = 0.5 * 127 * 127

/** Writes an outline code per cell into `out`: 0 for none, else 1..5 for OUTLINE_CHARS. */
export function findOutlines(cols: number, rows: number, depths: Float32Array, normals: Int8Array, out: Uint8Array) {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const d = depths[i]!
      out[i] = 0
      if (d === Infinity) continue

      const nx = normals[i * 3]!
      const ny = normals[i * 3 + 1]!
      const nz = normals[i * 3 + 2]!
      const farther = d * DEPTH_RATIO + DEPTH_MARGIN
      // Direction toward the differing neighbors; diagonals count a little less.
      let vx = 0
      let vy = 0
      let sideways = 0
      let upDown = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= rows) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= cols) continue
          const j = yy * cols + xx
          const dj = depths[j]!
          let differs = dj === Infinity || dj > farther
          if (!differs && j > i && Math.abs(dj - d) < d * (DEPTH_RATIO - 1) + DEPTH_MARGIN) {
            differs = nx * normals[j * 3]! + ny * normals[j * 3 + 1]! + nz * normals[j * 3 + 2]! < CREASE_DOT
          }
          if (!differs) continue
          const w = dx !== 0 && dy !== 0 ? 0.7 : 1
          vx += dx * w
          vy += dy * w
          if (dy === 0) sideways++
          if (dx === 0) upDown++
        }
      }
      if (vx === 0 && vy === 0 && sideways === 0 && upDown === 0) continue

      // Differences on opposite sides cancel out (e.g. a pole one cell wide): pick by count.
      if (Math.abs(vx) + Math.abs(vy) < 0.3) {
        out[i] = sideways >= upDown ? VERTICAL : TOP
        continue
      }
      // The edge runs perpendicular to the direction of the differing neighbors (y is down).
      const angle = Math.atan2(vy, vx)
      const a = ((angle % Math.PI) + Math.PI) % Math.PI
      if (a < Math.PI / 8 || a > (7 * Math.PI) / 8) out[i] = VERTICAL
      else if (a < (3 * Math.PI) / 8) out[i] = RISING
      else if (a < (5 * Math.PI) / 8) out[i] = vy > 0 ? BOTTOM : TOP
      else out[i] = FALLING
    }
  }
}
