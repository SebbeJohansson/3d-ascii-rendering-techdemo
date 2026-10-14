/**
 * Bounding volume hierarchy (BVH) for ray tracing triangle meshes.
 *
 * Testing a ray against all ~50k triangles of the dragon would be far too slow. A BVH is a
 * tree of boxes: the root box holds every triangle, each node splits its triangles in two
 * child boxes, down to leaves of a few triangles. A ray skips every subtree whose box it
 * misses, so it ends up testing a few dozen boxes and triangles instead of thousands.
 */

export interface Bvh {
  /** minX, minY, minZ, maxX, maxY, maxZ per node. Node 0 is the root. */
  bounds: Float32Array
  /**
   * Two values per node. Leaf: first triangle (in `order`) and triangle count.
   * Inner node: index of the left child (the right child follows it) and 0.
   */
  nodes: Uint32Array
  /** Triangle indices, grouped so each leaf's triangles are contiguous. */
  order: Uint32Array
  positions: Float32Array
  indices: Uint32Array
}

const LEAF_SIZE = 4

export function buildBvh(positions: Float32Array, indices: Uint32Array): Bvh {
  const triCount = indices.length / 3
  const centroids = new Float32Array(triCount * 3)
  const triBounds = new Float32Array(triCount * 6)
  for (let t = 0; t < triCount; t++) {
    for (let axis = 0; axis < 3; axis++) {
      const a = positions[indices[t * 3]! * 3 + axis]!
      const b = positions[indices[t * 3 + 1]! * 3 + axis]!
      const c = positions[indices[t * 3 + 2]! * 3 + axis]!
      triBounds[t * 6 + axis] = Math.min(a, b, c)
      triBounds[t * 6 + 3 + axis] = Math.max(a, b, c)
      centroids[t * 3 + axis] = (a + b + c) / 3
    }
  }

  const order = new Uint32Array(triCount).map((_, i) => i)
  // A binary tree with leaves of >= 1 triangle has fewer than 2 × triCount nodes.
  const bounds = new Float32Array(Math.max(1, triCount * 2) * 6)
  const nodes = new Uint32Array(Math.max(1, triCount * 2) * 2)
  let nodeCount = 1

  // Build iteratively: [node, first, count] work items.
  const stack: [number, number, number][] = [[0, 0, triCount]]
  while (stack.length) {
    const [node, first, count] = stack.pop()!
    // Bounds of this node's triangles, and of their centroids (to pick the split axis).
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    const clo = [Infinity, Infinity, Infinity]
    const chi = [-Infinity, -Infinity, -Infinity]
    for (let i = first; i < first + count; i++) {
      const t = order[i]!
      for (let axis = 0; axis < 3; axis++) {
        lo[axis] = Math.min(lo[axis]!, triBounds[t * 6 + axis]!)
        hi[axis] = Math.max(hi[axis]!, triBounds[t * 6 + 3 + axis]!)
        clo[axis] = Math.min(clo[axis]!, centroids[t * 3 + axis]!)
        chi[axis] = Math.max(chi[axis]!, centroids[t * 3 + axis]!)
      }
    }
    bounds.set([...lo, ...hi], node * 6)

    const extents = [0, 1, 2].map(axis => chi[axis]! - clo[axis]!)
    const axis = extents.indexOf(Math.max(...extents))
    if (count <= LEAF_SIZE || extents[axis] === 0) {
      nodes[node * 2] = first
      nodes[node * 2 + 1] = count
      continue
    }

    // Split at the middle of the widest axis: triangles with centroids below go left.
    const mid = (clo[axis]! + chi[axis]!) / 2
    let i = first
    let j = first + count - 1
    while (i <= j) {
      if (centroids[order[i]! * 3 + axis]! < mid) i++
      else {
        const tmp = order[i]!
        order[i] = order[j]!
        order[j--] = tmp
      }
    }
    let leftCount = i - first
    // Every centroid on one side (can happen with many identical centroids): split in half.
    if (leftCount === 0 || leftCount === count) leftCount = count >> 1

    const left = nodeCount
    nodeCount += 2
    nodes[node * 2] = left
    nodes[node * 2 + 1] = 0
    stack.push([left, first, leftCount], [left + 1, first + leftCount, count - leftCount])
  }

  return { bounds: bounds.slice(0, nodeCount * 6), nodes: nodes.slice(0, nodeCount * 2), order, positions, indices }
}

/** Result of the last intersectBvh() hit: triangle index and barycentric weights of vertices 1 and 2. */
export const bvhHit = { triangle: 0, u: 0, v: 0 }

const stack = new Uint32Array(64)
const EPS = 1e-4

/**
 * Nearest triangle hit closer than maxT, or Infinity. With anyHit it returns the first hit
 * found, which is all a shadow ray needs.
 */
export function intersectBvh(bvh: Bvh, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, anyHit: boolean): number {
  const { bounds, nodes, order, positions: p, indices } = bvh
  const ix = 1 / (dx || 1e-12)
  const iy = 1 / (dy || 1e-12)
  const iz = 1 / (dz || 1e-12)
  let best = maxT
  let top = 0
  stack[top++] = 0

  while (top > 0) {
    const node = stack[--top]!

    // Slab test against the node's box; skip it if it is missed or starts beyond the best hit.
    const o = node * 6
    let a = (bounds[o]! - ox) * ix
    let b = (bounds[o + 3]! - ox) * ix
    let near = Math.min(a, b)
    let far = Math.max(a, b)
    a = (bounds[o + 1]! - oy) * iy
    b = (bounds[o + 4]! - oy) * iy
    near = Math.max(near, Math.min(a, b))
    far = Math.min(far, Math.max(a, b))
    a = (bounds[o + 2]! - oz) * iz
    b = (bounds[o + 5]! - oz) * iz
    near = Math.max(near, Math.min(a, b))
    far = Math.min(far, Math.max(a, b))
    if (near > far || far < 0 || near >= best) continue

    const count = nodes[node * 2 + 1]!
    if (count === 0) {
      // Inner node. Visiting order barely matters here because `best` prunes the far child.
      const left = nodes[node * 2]!
      stack[top++] = left + 1
      stack[top++] = left
      continue
    }

    // Leaf: Möller–Trumbore ray/triangle test for each triangle.
    for (let k = nodes[node * 2]!, end = k + count; k < end; k++) {
      const t3 = order[k]! * 3
      const i0 = indices[t3]! * 3
      const i1 = indices[t3 + 1]! * 3
      const i2 = indices[t3 + 2]! * 3
      const e1x = p[i1]! - p[i0]!
      const e1y = p[i1 + 1]! - p[i0 + 1]!
      const e1z = p[i1 + 2]! - p[i0 + 2]!
      const e2x = p[i2]! - p[i0]!
      const e2y = p[i2 + 1]! - p[i0 + 1]!
      const e2z = p[i2 + 2]! - p[i0 + 2]!
      const px = dy * e2z - dz * e2y
      const py = dz * e2x - dx * e2z
      const pz = dx * e2y - dy * e2x
      const det = e1x * px + e1y * py + e1z * pz
      if (Math.abs(det) < 1e-12) continue
      const inv = 1 / det
      const tx = ox - p[i0]!
      const ty = oy - p[i0 + 1]!
      const tz = oz - p[i0 + 2]!
      const u = (tx * px + ty * py + tz * pz) * inv
      if (u < 0 || u > 1) continue
      const qx = ty * e1z - tz * e1y
      const qy = tz * e1x - tx * e1z
      const qz = tx * e1y - ty * e1x
      const v = (dx * qx + dy * qy + dz * qz) * inv
      if (v < 0 || u + v > 1) continue
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv
      if (t <= EPS || t >= best) continue
      best = t
      bvhHit.triangle = order[k]!
      bvhHit.u = u
      bvhHit.v = v
      if (anyHit) return best
    }
  }
  return best < maxT ? best : Infinity
}

/**
 * Updates the boxes after the mesh's vertices moved (e.g. flapping wings), keeping the tree's
 * structure. Much cheaper than a rebuild, and fine as long as the motion is moderate: boxes
 * just get a bit looser. Children always come after their parent in the node list, so going
 * backwards fixes every child before its parent needs it.
 */
export function refitBvh(bvh: Bvh) {
  const { bounds, nodes, order, positions: p, indices } = bvh
  for (let node = nodes.length / 2 - 1; node >= 0; node--) {
    const o = node * 6
    const count = nodes[node * 2 + 1]!
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    if (count === 0) {
      const left = nodes[node * 2]! * 6
      for (const c of [left, left + 6]) {
        minX = Math.min(minX, bounds[c]!)
        minY = Math.min(minY, bounds[c + 1]!)
        minZ = Math.min(minZ, bounds[c + 2]!)
        maxX = Math.max(maxX, bounds[c + 3]!)
        maxY = Math.max(maxY, bounds[c + 4]!)
        maxZ = Math.max(maxZ, bounds[c + 5]!)
      }
    }
    else {
      for (let k = nodes[node * 2]!, end = k + count; k < end; k++) {
        const t3 = order[k]! * 3
        for (let corner = 0; corner < 3; corner++) {
          const v = indices[t3 + corner]! * 3
          minX = Math.min(minX, p[v]!)
          minY = Math.min(minY, p[v + 1]!)
          minZ = Math.min(minZ, p[v + 2]!)
          maxX = Math.max(maxX, p[v]!)
          maxY = Math.max(maxY, p[v + 1]!)
          maxZ = Math.max(maxZ, p[v + 2]!)
        }
      }
    }
    bounds[o] = minX
    bounds[o + 1] = minY
    bounds[o + 2] = minZ
    bounds[o + 3] = maxX
    bounds[o + 4] = maxY
    bounds[o + 5] = maxZ
  }
}
