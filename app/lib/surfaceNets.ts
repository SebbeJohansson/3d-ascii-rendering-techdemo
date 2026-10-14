/**
 * Turns a blend of SDF shapes into a triangle mesh with "surface nets":
 *
 * 1. Sample the blended distance field on a 3D grid of `voxel`-sized cells.
 * 2. Every cell whose corners are partly inside and partly outside contains surface: put one
 *    vertex there, at the average of the points where the surface crosses the cell's edges.
 * 3. Every grid edge the surface crosses is shared by four cells: connect their four vertices
 *    into a quad (two triangles).
 *
 * Simpler than marching cubes (no lookup tables) and gives smoother, more even triangles.
 */
import { smoothMin, type SdfShape } from './sdf'

export interface SurfaceMesh {
  positions: Float32Array
  /** Outward unit normals per vertex, from the distance field's gradient. */
  normals: Float32Array
  /** The model part nearest each vertex (SdfShape.part), for coloring. */
  parts: Uint8Array
  indices: Uint32Array
}

/** Corner offsets of a cell: bit 0 = +x, bit 1 = +y, bit 2 = +z. */
const CORNERS = [0, 1, 2, 3, 4, 5, 6, 7].map(c => [c & 1, (c >> 1) & 1, (c >> 2) & 1] as const)
/** The 12 cell edges, as pairs of corners that differ in one axis. */
const EDGES = CORNERS.flatMap((_, c) => [1, 2, 4].filter(bit => !(c & bit)).map(bit => [c, c | bit] as const))

export function polygonize(shapes: SdfShape[], voxel: number, smoothing: number): SurfaceMesh {
  // A shape only affects the blend within `smoothing` of its surface. Sample a little beyond
  // that so every cell next to the surface has all its corners filled in.
  const margin = smoothing + voxel * 2
  const lo = [0, 1, 2].map(i => Math.min(...shapes.map(s => s.min[i]!)) - margin)
  const hi = [0, 1, 2].map(i => Math.max(...shapes.map(s => s.max[i]!)) + margin)
  const [nx, ny, nz] = [0, 1, 2].map(i => Math.ceil((hi[i]! - lo[i]!) / voxel) + 1) as [number, number, number]
  const sx = 1
  const sy = nx
  const sz = nx * ny

  // 1. Sample. Each shape only writes into the grid points near it, so the cost is the sum
  // of the shapes' (small) bounding volumes, not grid size × shape count.
  const field = new Float32Array(nx * ny * nz).fill(1e6)
  const nearest = new Float32Array(nx * ny * nz).fill(1e6)
  const part = new Uint8Array(nx * ny * nz)
  for (const shape of shapes) {
    const from = [0, 1, 2].map(i => Math.max(0, Math.floor((shape.min[i]! - margin - lo[i]!) / voxel)))
    const to = [0, 1, 2].map((i) => {
      const n = [nx, ny, nz][i]!
      return Math.min(n - 1, Math.ceil((shape.max[i]! + margin - lo[i]!) / voxel))
    })
    for (let z = from[2]!; z <= to[2]!; z++) {
      const pz = lo[2]! + z * voxel
      for (let y = from[1]!; y <= to[1]!; y++) {
        const py = lo[1]! + y * voxel
        for (let x = from[0]!, i = x + y * sy + z * sz; x <= to[0]!; x++, i++) {
          const d = shape.distance(lo[0]! + x * voxel, py, pz)
          field[i] = smoothMin(field[i]!, d, smoothing)
          if (d < nearest[i]!) {
            nearest[i] = d
            part[i] = shape.part
          }
        }
      }
    }
  }

  // 2. One vertex per cell that the surface passes through.
  const cellVertex = new Int32Array(nx * ny * nz).fill(-1)
  const positions: number[] = []
  const normals: number[] = []
  const parts: number[] = []
  const corner = new Float64Array(8)
  const cornerOffset = CORNERS.map(([cx, cy, cz]) => cx * sx + cy * sy + cz * sz)

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const i = x + y * sy + z * sz
        let inside = 0
        for (let c = 0; c < 8; c++) {
          corner[c] = field[i + cornerOffset[c]!]!
          if (corner[c]! < 0) inside++
        }
        if (inside === 0 || inside === 8) continue

        // Average of the edge crossings, each found by linear interpolation along the edge.
        let vx = 0
        let vy = 0
        let vz = 0
        let crossings = 0
        for (const [a, b] of EDGES) {
          const fa = corner[a]!
          const fb = corner[b]!
          if ((fa < 0) === (fb < 0)) continue
          const t = fa / (fa - fb)
          vx += CORNERS[a]![0] + (CORNERS[b]![0] - CORNERS[a]![0]) * t
          vy += CORNERS[a]![1] + (CORNERS[b]![1] - CORNERS[a]![1]) * t
          vz += CORNERS[a]![2] + (CORNERS[b]![2] - CORNERS[a]![2]) * t
          crossings++
        }

        // Normal: the field's gradient across the cell, which points away from the surface.
        let gx = 0
        let gy = 0
        let gz = 0
        let closest = 0
        for (let c = 0; c < 8; c++) {
          const f = corner[c]!
          gx += CORNERS[c]![0] ? f : -f
          gy += CORNERS[c]![1] ? f : -f
          gz += CORNERS[c]![2] ? f : -f
          if (Math.abs(f) < Math.abs(corner[closest]!)) closest = c
        }
        const gl = Math.hypot(gx, gy, gz) || 1

        cellVertex[i] = positions.length / 3
        positions.push(lo[0]! + (x + vx / crossings) * voxel, lo[1]! + (y + vy / crossings) * voxel, lo[2]! + (z + vz / crossings) * voxel)
        normals.push(gx / gl, gy / gl, gz / gl)
        parts.push(part[i + cornerOffset[closest]!]!)
      }
    }
  }

  // 3. A quad around every grid edge the surface crosses, joining the four cells that share it.
  const indices: number[] = []
  const strides = [sx, sy, sz]
  const pos = positions
  const nrm = normals
  const triangle = (a: number, b: number, c: number) => {
    // Wind each triangle so its face points the same way as its vertex normals (outward).
    const ux = pos[b * 3]! - pos[a * 3]!
    const uy = pos[b * 3 + 1]! - pos[a * 3 + 1]!
    const uz = pos[b * 3 + 2]! - pos[a * 3 + 2]!
    const wx = pos[c * 3]! - pos[a * 3]!
    const wy = pos[c * 3 + 1]! - pos[a * 3 + 1]!
    const wz = pos[c * 3 + 2]! - pos[a * 3 + 2]!
    const fx = uy * wz - uz * wy
    const fy = uz * wx - ux * wz
    const fz = ux * wy - uy * wx
    let facing = 0
    for (const v of [a, b, c]) facing += fx * nrm[v * 3]! + fy * nrm[v * 3 + 1]! + fz * nrm[v * 3 + 2]!
    if (facing >= 0) indices.push(a, b, c)
    else indices.push(a, c, b)
  }

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const i = x + y * sy + z * sz
        if (cellVertex[i]! < 0) continue
        const coord = [x, y, z]
        for (let axis = 0; axis < 3; axis++) {
          const u = (axis + 1) % 3
          const v = (axis + 2) % 3
          if (coord[u] === 0 || coord[v] === 0) continue
          // Does the surface cross the edge from this cell's first corner along `axis`?
          if ((field[i]! < 0) === (field[i + strides[axis]!]! < 0)) continue
          const du = strides[u]!
          const dv = strides[v]!
          const q = [cellVertex[i]!, cellVertex[i - du]!, cellVertex[i - du - dv]!, cellVertex[i - dv]!]
          if (q.some(n => n < 0)) continue
          triangle(q[0]!, q[1]!, q[2]!)
          triangle(q[0]!, q[2]!, q[3]!)
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    parts: new Uint8Array(parts),
    indices: new Uint32Array(indices),
  }
}
