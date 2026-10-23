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
/** Candidate split planes per axis for the surface area heuristic, plus one. */
const BINS = 16
const binCounts = new Uint32Array(BINS)
const binBounds = new Float64Array(BINS * 6)
const leftAreas = new Float64Array(BINS)
const rightAreas = new Float64Array(BINS)
const leftCounts = new Uint32Array(BINS)
const rightCounts = new Uint32Array(BINS)

/**
 * Accumulates bins from `from` in direction `step`: area[b] and count[b] are the surface area
 * and triangle count of bins from..b together.
 */
function sweep(from: number, step: number, area: Float64Array, count: Uint32Array) {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let n = 0
  for (let b = from; b >= 0 && b < BINS; b += step) {
    n += binCounts[b]!
    if (binCounts[b]) {
      minX = Math.min(minX, binBounds[b * 6]!)
      minY = Math.min(minY, binBounds[b * 6 + 1]!)
      minZ = Math.min(minZ, binBounds[b * 6 + 2]!)
      maxX = Math.max(maxX, binBounds[b * 6 + 3]!)
      maxY = Math.max(maxY, binBounds[b * 6 + 4]!)
      maxZ = Math.max(maxZ, binBounds[b * 6 + 5]!)
    }
    const x = maxX - minX
    const y = maxY - minY
    const z = maxZ - minZ
    area[b] = n ? x * y + y * z + z * x : 0
    count[b] = n
  }
}

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

  const order = new Uint32Array(triCount)
  for (let i = 0; i < triCount; i++) order[i] = i
  // A binary tree with leaves of >= 1 triangle has fewer than 2 × triCount nodes.
  const bounds = new Float32Array(Math.max(1, triCount * 2) * 6)
  const nodes = new Uint32Array(Math.max(1, triCount * 2) * 2)
  let nodeCount = 1

  // Build iteratively: node, first, count per work item. Plain numbers and typed arrays
  // throughout: allocating per node made building the dragon's BVH several times slower.
  const stack = new Uint32Array(Math.max(1, triCount) * 3 * 2)
  let top = 0
  stack[top++] = 0
  stack[top++] = 0
  stack[top++] = triCount
  const lo = new Float64Array(3)
  const hi = new Float64Array(3)
  const clo = new Float64Array(3)
  const chi = new Float64Array(3)
  while (top > 0) {
    const count = stack[--top]!
    const first = stack[--top]!
    const node = stack[--top]!
    // Bounds of this node's triangles, and of their centroids (to pick the split axis).
    lo.fill(Infinity)
    hi.fill(-Infinity)
    clo.fill(Infinity)
    chi.fill(-Infinity)
    for (let i = first; i < first + count; i++) {
      const t = order[i]!
      for (let axis = 0; axis < 3; axis++) {
        const tl = triBounds[t * 6 + axis]!
        const th = triBounds[t * 6 + 3 + axis]!
        const c = centroids[t * 3 + axis]!
        if (tl < lo[axis]!) lo[axis] = tl
        if (th > hi[axis]!) hi[axis] = th
        if (c < clo[axis]!) clo[axis] = c
        if (c > chi[axis]!) chi[axis] = c
      }
    }
    const o = node * 6
    bounds[o] = lo[0]!
    bounds[o + 1] = lo[1]!
    bounds[o + 2] = lo[2]!
    bounds[o + 3] = hi[0]!
    bounds[o + 4] = hi[1]!
    bounds[o + 5] = hi[2]!

    const ex = chi[0]! - clo[0]!
    const ey = chi[1]! - clo[1]!
    const ez = chi[2]! - clo[2]!
    if (count <= LEAF_SIZE || (ex <= 0 && ey <= 0 && ez <= 0)) {
      nodes[node * 2] = first
      nodes[node * 2 + 1] = count
      continue
    }

    // Split where the surface area heuristic says rays will test the fewest triangles:
    // bin the centroids along each axis, and weigh each candidate plane's two halves by
    // their box areas (how likely a ray is to enter them) times their triangle counts.
    let bestAxis = -1
    let bestPlane = 0
    let bestCost = Infinity
    for (let axis = 0; axis < 3; axis++) {
      const extent = axis === 0 ? ex : axis === 1 ? ey : ez
      if (extent === 0) continue
      binCounts.fill(0)
      for (let b = 0; b < BINS; b++) {
        binBounds[b * 6] = binBounds[b * 6 + 1] = binBounds[b * 6 + 2] = Infinity
        binBounds[b * 6 + 3] = binBounds[b * 6 + 4] = binBounds[b * 6 + 5] = -Infinity
      }
      const scale = BINS / extent
      const from = clo[axis]!
      for (let i = first; i < first + count; i++) {
        const t = order[i]!
        const b = Math.min(BINS - 1, Math.floor((centroids[t * 3 + axis]! - from) * scale))
        binCounts[b]!++
        const bb = b * 6
        const tb = t * 6
        for (let c = 0; c < 3; c++) {
          if (triBounds[tb + c]! < binBounds[bb + c]!) binBounds[bb + c] = triBounds[tb + c]!
          if (triBounds[tb + 3 + c]! > binBounds[bb + 3 + c]!) binBounds[bb + 3 + c] = triBounds[tb + 3 + c]!
        }
      }
      // Sweep from the right to get each plane's right-hand area and count, then from the left.
      sweep(BINS - 1, -1, rightAreas, rightCounts)
      sweep(0, 1, leftAreas, leftCounts)
      for (let plane = 1; plane < BINS; plane++) {
        const cost = leftAreas[plane - 1]! * leftCounts[plane - 1]! + rightAreas[plane]! * rightCounts[plane]!
        if (leftCounts[plane - 1]! && rightCounts[plane]! && cost < bestCost) {
          bestCost = cost
          bestAxis = axis
          bestPlane = plane
        }
      }
    }

    let leftCount = count >> 1
    if (bestAxis >= 0) {
      const axis = bestAxis
      const scale = BINS / (axis === 0 ? ex : axis === 1 ? ey : ez)
      const from = clo[axis]!
      let i = first
      let j = first + count - 1
      while (i <= j) {
        if (Math.min(BINS - 1, Math.floor((centroids[order[i]! * 3 + axis]! - from) * scale)) < bestPlane) i++
        else {
          const tmp = order[i]!
          order[i] = order[j]!
          order[j--] = tmp
        }
      }
      leftCount = i - first
    }
    // Every centroid in one bin (many identical centroids): split in half.
    if (leftCount === 0 || leftCount === count) leftCount = count >> 1

    const left = nodeCount
    nodeCount += 2
    nodes[node * 2] = left
    nodes[node * 2 + 1] = 0
    stack[top++] = left
    stack[top++] = first
    stack[top++] = leftCount
    stack[top++] = left + 1
    stack[top++] = first + leftCount
    stack[top++] = count - leftCount
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
/** With `skip`, the subtree under that node is left out (traced some other way). */
export function intersectBvh(bvh: Bvh, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, anyHit: boolean, skip = -1): number {
  const { bounds, nodes, order, positions: p, indices } = bvh
  const ix = 1 / (dx || 1e-12)
  const iy = 1 / (dy || 1e-12)
  const iz = 1 / (dz || 1e-12)
  let best = maxT
  let top = 0
  stack[top++] = 0

  while (top > 0) {
    const node = stack[--top]!
    if (node === skip) continue

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
 * backwards fixes every child before its parent needs it. With `only` (ascending, from
 * nodesHolding()), just those nodes are refitted: the ones that can have moved.
 */
export function refitBvh(bvh: Bvh, only?: Uint32Array) {
  const { bounds: b, nodes, order, positions: p, indices } = bvh
  for (let k = (only ? only.length : nodes.length / 2) - 1; k >= 0; k--) {
    const node = only ? only[k]! : k
    const o = node * 6
    const count = nodes[node * 2 + 1]!
    if (count === 0) {
      const l = nodes[node * 2]! * 6
      const r = l + 6
      b[o] = b[l]! < b[r]! ? b[l]! : b[r]!
      b[o + 1] = b[l + 1]! < b[r + 1]! ? b[l + 1]! : b[r + 1]!
      b[o + 2] = b[l + 2]! < b[r + 2]! ? b[l + 2]! : b[r + 2]!
      b[o + 3] = b[l + 3]! > b[r + 3]! ? b[l + 3]! : b[r + 3]!
      b[o + 4] = b[l + 4]! > b[r + 4]! ? b[l + 4]! : b[r + 4]!
      b[o + 5] = b[l + 5]! > b[r + 5]! ? b[l + 5]! : b[r + 5]!
      continue
    }
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let k2 = nodes[node * 2]!, end = k2 + count; k2 < end; k2++) {
      const t3 = order[k2]! * 3
      for (let corner = 0; corner < 3; corner++) {
        const v = indices[t3 + corner]! * 3
        const x = p[v]!
        const y = p[v + 1]!
        const z = p[v + 2]!
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
    b[o] = minX
    b[o + 1] = minY
    b[o + 2] = minZ
    b[o + 3] = maxX
    b[o + 4] = maxY
    b[o + 5] = maxZ
  }
}

/**
 * The nodes whose boxes can change when the vertices `moving` says yes to move: the leaves
 * holding a triangle with one, and every node above those. Ascending, for refitBvh().
 */
export function nodesHolding(bvh: Bvh, moving: Uint8Array) {
  const { nodes, order, indices } = bvh
  const count = nodes.length / 2
  const parent = new Int32Array(count).fill(-1)
  const dirty = new Uint8Array(count)
  for (let n = 0; n < count; n++) {
    if (nodes[n * 2 + 1] === 0) parent[nodes[n * 2]!] = parent[nodes[n * 2]! + 1] = n
  }
  for (let n = 0; n < count; n++) {
    const leaf = nodes[n * 2 + 1]!
    if (!leaf) continue
    let moves = false
    for (let k = nodes[n * 2]!, end = k + leaf; k < end && !moves; k++) {
      const t3 = order[k]! * 3
      moves = !!(moving[indices[t3]!] || moving[indices[t3 + 1]!] || moving[indices[t3 + 2]!])
    }
    for (let q = n; moves && q >= 0 && !dirty[q]; q = parent[q]!) dirty[q] = 1
  }
  const list: number[] = []
  for (let n = 0; n < count; n++) if (dirty[n]) list.push(n)
  return new Uint32Array(list)
}

/**
 * Where node `i` of the second of two joined BVHs ends up (see joinBvhs()), given the first's
 * node count. Its root goes right after the first's, the rest after all of the first's nodes.
 */
export const joinedNode = (i: number, firstNodes: number) => (i === 0 ? 2 : firstNodes + 1 + i)

/**
 * One BVH over two meshes' triangles, under a new root with each BVH as a child: node 1 is
 * `a`'s root and node 2 `b`'s, and each keeps its own subtree. Unlike one BVH built over both,
 * `b` can be rebuilt on its own later and written back in place (joinedNode() says where),
 * without touching `a` or loosening its boxes. `b`'s vertices and triangles come after `a`'s.
 */
export function joinBvhs(a: Bvh, b: Bvh): Bvh {
  const aNodes = a.nodes.length / 2
  const bNodes = b.nodes.length / 2
  const aVertices = a.positions.length / 3
  const aTriangles = a.indices.length / 3
  const positions = new Float32Array(a.positions.length + b.positions.length)
  positions.set(a.positions)
  positions.set(b.positions, a.positions.length)
  const indices = new Uint32Array(a.indices.length + b.indices.length)
  indices.set(a.indices)
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i]! + aVertices
  const order = new Uint32Array(a.order.length + b.order.length)
  order.set(a.order)
  for (let i = 0; i < b.order.length; i++) order[a.order.length + i] = b.order[i]! + aTriangles

  const count = 1 + aNodes + bNodes
  const bounds = new Float32Array(count * 6)
  const nodes = new Uint32Array(count * 2)
  // a: root to 1, the rest two further on, so a node's children stay next to each other.
  const mapA = (i: number) => (i === 0 ? 1 : i + 2)
  const copy = (from: Bvh, i: number, to: number, map: (i: number) => number, firstTriangle: number) => {
    bounds.set(from.bounds.subarray(i * 6, i * 6 + 6), to * 6)
    const leafCount = from.nodes[i * 2 + 1]!
    nodes[to * 2] = leafCount ? from.nodes[i * 2]! + firstTriangle : map(from.nodes[i * 2]!)
    nodes[to * 2 + 1] = leafCount
  }
  for (let i = 0; i < aNodes; i++) copy(a, i, mapA(i), mapA, 0)
  for (let i = 0; i < bNodes; i++) copy(b, i, joinedNode(i, aNodes), j => joinedNode(j, aNodes), aTriangles)
  nodes[0] = 1
  nodes[1] = 0
  joinRoot(bounds)
  return { bounds, nodes, order, positions, indices }
}

/** Sets the joined root's box (node 0) to hold its two children's, nodes 1 and 2. */
export function joinRoot(bounds: Float32Array) {
  for (let k = 0; k < 3; k++) {
    bounds[k] = Math.min(bounds[6 + k]!, bounds[12 + k]!)
    bounds[3 + k] = Math.max(bounds[9 + k]!, bounds[15 + k]!)
  }
}
