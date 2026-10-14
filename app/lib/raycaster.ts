/**
 * A tiny CPU ray tracer. No 3D engine, no GPU: every character cell on screen shoots one ray
 * into the environment's primitives (boxes, upright cylinders and cones, ellipsoids).
 *
 * Primitives are bucketed by their bounding boxes into a uniform grid on the ground plane,
 * so a ray only tests the primitives in the cells it actually crosses (2D DDA traversal).
 * Triangle meshes go into a BVH (see bvh.ts) instead.
 */
import type { Environment, EnvironmentScene, Shape } from '../environments/types'
import { HEMI_GROUND_COLOR, HEMI_INTENSITY, HEMI_SKY_COLOR, SUN_COLOR, SUN_INTENSITY, SUN_POSITION } from '../environments/lighting'
import { buildBvh, bvhHit, intersectBvh, refitBvh, type Bvh } from './bvh'
import { linearRgb, linearToSrgbByte } from './color'
import { cameraBasis, normalize, scale, type Vec3 } from './math'

export interface RaycastScene {
  /** minX, minY, minZ, maxX, maxY, maxZ per primitive. */
  bounds: Float32Array
  shapes: Uint8Array
  /** Diffuse albedo per primitive: linear r, g, b in 0..1, already scaled by (1 - metalness). */
  colors: Float32Array
  ground: Vec3
  sky: Vec3
  fogNear: number
  fogFar: number
  half: number
  /** Top of everything, for clipping rays. Updated when meshes move. */
  maxHeight: number
  /** Top of the primitives alone. */
  primitivesHeight: number
  cellSize: number
  cells: number
  /** cellItems[cellStart[c] .. cellStart[c + 1]] are the primitives overlapping cell c. */
  cellStart: Uint32Array
  cellItems: Uint32Array
  /** Last ray id that tested each primitive, so one spanning several cells is tested once per ray. */
  stamp: Uint32Array
  rayId: number
  /** All of the environment's meshes merged into one, if it has any. */
  mesh?: {
    bvh: Bvh
    normals: Float32Array
    /** Diffuse albedo per vertex: linear r, g, b, already scaled by (1 - metalness). */
    albedo: Float32Array
  }
}

export interface Camera {
  position: Vec3
  target: Vec3
  /** Vertical field of view in degrees. */
  fov: number
  /** Width / height of the viewport in pixels. */
  aspect: number
}

const CELL_SIZE = 8
const EPS = 1e-4
const BOX = 0
const CYLINDER = 1
const CONE = 2
const SPHERE = 3
const SHAPE_CODES: Record<Shape, number> = { box: BOX, cylinder: CYLINDER, cone: CONE, sphere: SPHERE }
const GROUND = -1
const MISS = -2
const MESH = -3

// Shading follows three's MeshStandardMaterial so both views match: colors are converted to
// linear light, lit with Lambert diffuse (albedo / π × irradiance) from the sun plus a hemisphere
// light, fogged, and converted back to sRGB. Specular is left out; at high roughness it is small.
const SUN = normalize(SUN_POSITION)
const SUN_LIGHT = scale(linearRgb(SUN_COLOR), SUN_INTENSITY / Math.PI)
const HEMI_SKY = scale(linearRgb(HEMI_SKY_COLOR), HEMI_INTENSITY / Math.PI)
const HEMI_GROUND = scale(linearRgb(HEMI_GROUND_COLOR), HEMI_INTENSITY / Math.PI)

// Ink comes from how much light reaches a surface, not from its color: dark materials (pines)
// and light ones get the same range of characters, and density shows lit vs shadowed sides.
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b
// Brightest: facing straight up into the sun. Darkest: facing down, lit by the ground only.
const MAX_LIGHT = luminance(...HEMI_SKY) + luminance(...SUN_LIGHT)
const MIN_LIGHT = luminance(...HEMI_GROUND)
// Even fully lit surfaces get a light character, so they don't vanish into the sky.
const MIN_INK = 0.25

export function buildRaycastScene(env: Environment, { primitives, extent, meshes = [] }: EnvironmentScene): RaycastScene {
  const half = extent / 2
  const count = primitives.length
  const bounds = new Float32Array(count * 6)
  const shapes = new Uint8Array(count)
  const colors = new Float32Array(count * 3)
  let maxHeight = 1

  primitives.forEach((p, i) => {
    bounds.set([p.x - p.width / 2, p.y, p.z - p.depth / 2, p.x + p.width / 2, p.y + p.height, p.z + p.depth / 2], i * 6)
    shapes[i] = SHAPE_CODES[p.shape]
    colors.set(scale(linearRgb(p.color), 1 - (p.metalness ?? 0)), i * 3)
    maxHeight = Math.max(maxHeight, p.y + p.height)
  })

  // Bucket primitives into grid cells: count, prefix-sum, then fill.
  const cells = Math.ceil(extent / CELL_SIZE)
  const toCell = (v: number) => Math.min(cells - 1, Math.max(0, Math.floor((v + half) / CELL_SIZE)))
  const cellStart = new Uint32Array(cells * cells + 1)
  const forEachCell = (i: number, fn: (cell: number) => void) => {
    const o = i * 6
    for (let cx = toCell(bounds[o]!); cx <= toCell(bounds[o + 3]!); cx++) {
      for (let cz = toCell(bounds[o + 2]!); cz <= toCell(bounds[o + 5]!); cz++) fn(cx * cells + cz)
    }
  }
  for (let i = 0; i < count; i++) forEachCell(i, c => cellStart[c + 1]!++)
  for (let c = 0; c < cells * cells; c++) cellStart[c + 1]! += cellStart[c]!
  const cursor = cellStart.slice(0, -1)
  const cellItems = new Uint32Array(cellStart[cells * cells]!)
  for (let i = 0; i < count; i++) forEachCell(i, c => cellItems[cursor[c]!++] = i)

  // Merge every mesh into one, so one BVH covers them all.
  let mesh: RaycastScene['mesh']
  if (meshes.length) {
    const vertexCount = meshes.reduce((n, m) => n + m.positions.length / 3, 0)
    const positions = new Float32Array(vertexCount * 3)
    const normals = new Float32Array(vertexCount * 3)
    const albedo = new Float32Array(vertexCount * 3)
    const indices = new Uint32Array(meshes.reduce((n, m) => n + m.indices.length, 0))
    let v = 0
    let t = 0
    for (const m of meshes) {
      positions.set(m.positions, v * 3)
      normals.set(m.normals, v * 3)
      const keep = 1 - (m.metalness ?? 0)
      for (let i = 0; i < m.colors.length; i++) albedo[v * 3 + i] = m.colors[i]! * keep
      for (let i = 0; i < m.indices.length; i++) indices[t + i] = m.indices[i]! + v
      v += m.positions.length / 3
      t += m.indices.length
    }
    mesh = { bvh: buildBvh(positions, indices), normals, albedo }
  }
  const primitivesHeight = maxHeight
  if (mesh) maxHeight = Math.max(maxHeight, mesh.bvh.bounds[4]!)

  return {
    bounds,
    shapes,
    colors,
    ground: linearRgb(env.ground),
    sky: linearRgb(env.sky),
    fogNear: env.fogNear,
    fogFar: env.fogFar,
    half,
    maxHeight,
    primitivesHeight,
    cellSize: CELL_SIZE,
    cells,
    cellStart,
    cellItems,
    stamp: new Uint32Array(count),
    rayId: 0,
    mesh,
  }
}

/**
 * Copies moved mesh vertices (from Environment.animate) into the ray tracer's merged mesh
 * and refits its BVH. `scene` must be the one this RaycastScene was built from.
 */
export function updateMeshes(s: RaycastScene, { meshes = [] }: EnvironmentScene) {
  if (!s.mesh) return
  const { bvh, normals } = s.mesh
  let offset = 0
  for (const m of meshes) {
    bvh.positions.set(m.positions, offset)
    normals.set(m.normals, offset)
    offset += m.positions.length
  }
  refitBvh(bvh)
  s.maxHeight = Math.max(s.primitivesHeight, bvh.bounds[4]!)
}

/** Result of the last trace() call. Reused to avoid allocating per ray. */
const hit = { t: 0, prim: MISS, nx: 0, ny: 0, nz: 0, triangle: 0, u: 0, v: 0 }

// Surface normal of the last candidate hit, written by the shape tests in trace() and below.
let cnx = 0
let cny = 0
let cnz = 0

/** Flat circular cap at height capY. Returns t if it is hit closer than `best`, else `best`. */
function hitDisc(capY: number, ny: number, r: number, X: number, oy: number, Z: number, dx: number, dy: number, dz: number, best: number) {
  const t = (capY - oy) / dy
  if (t > EPS && t < best) {
    const px = X + t * dx
    const pz = Z + t * dz
    if (px * px + pz * pz <= r * r) {
      cnx = 0
      cny = ny
      cnz = 0
      return t
    }
  }
  return best
}

/** Upright cylinder filling the bounds at offset o. X/Z are the ray origin relative to its axis. */
function hitCylinder(b: Float32Array, o: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
  const r = (b[o + 3]! - b[o]!) / 2
  const X = ox - (b[o]! + r)
  const Z = oz - (b[o + 2]! + b[o + 5]!) / 2
  const y0 = b[o + 1]!
  const y1 = b[o + 4]!
  let best = Infinity

  // Side wall: solve |(X, Z) + t (dx, dz)| = r.
  const a = dx * dx + dz * dz
  if (a > 1e-12) {
    const hb = X * dx + Z * dz
    const disc = hb * hb - a * (X * X + Z * Z - r * r)
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      let t = (-hb - sq) / a
      let y = oy + t * dy
      if (t <= EPS || y < y0 || y > y1) {
        t = (-hb + sq) / a
        y = oy + t * dy
      }
      if (t > EPS && y >= y0 && y <= y1) {
        best = t
        cnx = (X + t * dx) / r
        cny = 0
        cnz = (Z + t * dz) / r
      }
    }
  }
  if (dy !== 0) {
    best = hitDisc(y1, 1, r, X, oy, Z, dx, dy, dz, best)
    best = hitDisc(y0, -1, r, X, oy, Z, dx, dy, dz, best)
  }
  return best
}

/** Checks one root of the cone equation: in front of the ray and between base and tip. */
function coneSide(t: number, X: number, Z: number, oy: number, dx: number, dy: number, dz: number, y0: number, y1: number, k: number) {
  if (!(t > EPS)) return Infinity
  const py = oy + t * dy
  if (py < y0 || py > y1) return Infinity
  const px = X + t * dx
  const pz = Z + t * dz
  // Gradient of x² + z² − k²(y1 − y)²: outward, tilted up by the cone's slope.
  const ny = k * k * (y1 - py)
  const len = Math.hypot(px, ny, pz) || 1
  cnx = px / len
  cny = ny / len
  cnz = pz / len
  return t
}

/** Upright cone filling the bounds: circular base at the bottom, point at the top. */
function hitCone(b: Float32Array, o: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
  const r = (b[o + 3]! - b[o]!) / 2
  const X = ox - (b[o]! + r)
  const Z = oz - (b[o + 2]! + b[o + 5]!) / 2
  const y0 = b[o + 1]!
  const y1 = b[o + 4]!
  const k = r / (y1 - y0)
  const k2 = k * k
  const Y = y1 - oy
  let best = Infinity

  // Side: x² + z² = k² (y1 − y)², a quadratic a t² + 2 hb t + c = 0 along the ray.
  const a = dx * dx + dz * dz - k2 * dy * dy
  const hb = X * dx + Z * dz + k2 * Y * dy
  const c = X * X + Z * Z - k2 * Y * Y
  if (Math.abs(a) > 1e-12) {
    const disc = hb * hb - a * c
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      const t1 = (-hb - sq) / a
      const t2 = (-hb + sq) / a
      best = coneSide(Math.min(t1, t2), X, Z, oy, dx, dy, dz, y0, y1, k)
      if (best === Infinity) best = coneSide(Math.max(t1, t2), X, Z, oy, dx, dy, dz, y0, y1, k)
    }
  }
  else if (hb !== 0) {
    // Ray parallel to the cone's slope: the equation is linear.
    best = coneSide(-c / (2 * hb), X, Z, oy, dx, dy, dz, y0, y1, k)
  }
  if (dy !== 0) best = hitDisc(y0, -1, r, X, oy, Z, dx, dy, dz, best)
  return best
}

/** Ellipsoid filling the bounds: squash space so it becomes a unit sphere, then solve. */
function hitSphere(b: Float32Array, o: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
  const rx = (b[o + 3]! - b[o]!) / 2
  const ry = (b[o + 4]! - b[o + 1]!) / 2
  const rz = (b[o + 5]! - b[o + 2]!) / 2
  const X = (ox - b[o]! - rx) / rx
  const Y = (oy - b[o + 1]! - ry) / ry
  const Z = (oz - b[o + 2]! - rz) / rz
  const DX = dx / rx
  const DY = dy / ry
  const DZ = dz / rz
  const a = DX * DX + DY * DY + DZ * DZ
  const hb = X * DX + Y * DY + Z * DZ
  const disc = hb * hb - a * (X * X + Y * Y + Z * Z - 1)
  if (disc < 0) return Infinity
  const sq = Math.sqrt(disc)
  let t = (-hb - sq) / a
  if (t <= EPS) t = (-hb + sq) / a
  if (t <= EPS) return Infinity
  // Normal of an ellipsoid: the squashed-space position divided by the radii once more.
  const nx = (X + t * DX) / rx
  const ny = (Y + t * DY) / ry
  const nz = (Z + t * DZ) / rz
  const len = Math.hypot(nx, ny, nz)
  cnx = nx / len
  cny = ny / len
  cnz = nz / len
  return t
}

/**
 * Finds the nearest primitive or ground hit along a ray. With anyHit set it returns as soon as
 * anything blocks the ray, which is all a shadow ray needs.
 */
function trace(s: RaycastScene, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, anyHit: boolean): boolean {
  const ix = 1 / (dx || 1e-12)
  const iy = 1 / (dy || 1e-12)
  const iz = 1 / (dz || 1e-12)

  // Clip the ray to the environment's bounding box first.
  let t0 = 0
  let t1 = Infinity
  let a = (-s.half - ox) * ix
  let b = (s.half - ox) * ix
  t0 = Math.max(t0, Math.min(a, b))
  t1 = Math.min(t1, Math.max(a, b))
  a = (0 - oy) * iy
  b = (s.maxHeight - oy) * iy
  t0 = Math.max(t0, Math.min(a, b))
  t1 = Math.min(t1, Math.max(a, b))
  a = (-s.half - oz) * iz
  b = (s.half - oz) * iz
  t0 = Math.max(t0, Math.min(a, b))
  t1 = Math.min(t1, Math.max(a, b))
  hit.prim = MISS
  if (t0 > t1) return false

  let best = Infinity
  // The ground covers the whole environment at y = 0.
  if (!anyHit && dy < 0) {
    const tg = -oy * iy
    if (tg >= t0 && tg <= t1) {
      best = tg
      hit.prim = GROUND
      hit.nx = 0
      hit.ny = 1
      hit.nz = 0
    }
  }

  // Meshes: one BVH query. The grid walk below then only accepts primitives closer than this.
  if (s.mesh) {
    const t = intersectBvh(s.mesh.bvh, ox, oy, oz, dx, dy, dz, best, anyHit)
    if (t < best) {
      if (anyHit) return true
      best = t
      hit.prim = MESH
      hit.triangle = bvhHit.triangle
      hit.u = bvhHit.u
      hit.v = bvhHit.v
    }
  }

  // No primitives (e.g. a mesh-only environment on a huge floor): skip walking empty cells.
  if (s.cellItems.length === 0) {
    hit.t = best
    return best < Infinity
  }

  if (++s.rayId === 0xFFFFFFFF) {
    s.stamp.fill(0)
    s.rayId = 1
  }
  const rayId = s.rayId
  const { bounds, shapes, cellStart, cellItems, stamp, cells, cellSize, half } = s

  // 2D DDA across grid cells, starting where the ray enters the environment.
  let cx = Math.min(cells - 1, Math.max(0, Math.floor((ox + dx * t0 + half) / cellSize)))
  let cz = Math.min(cells - 1, Math.max(0, Math.floor((oz + dz * t0 + half) / cellSize)))
  const stepX = dx > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  let tMaxX = ((cx + (dx > 0 ? 1 : 0)) * cellSize - half - ox) * ix
  let tMaxZ = ((cz + (dz > 0 ? 1 : 0)) * cellSize - half - oz) * iz
  const tDeltaX = cellSize * Math.abs(ix)
  const tDeltaZ = cellSize * Math.abs(iz)

  for (;;) {
    const cell = cx * cells + cz
    for (let k = cellStart[cell]!, end = cellStart[cell + 1]!; k < end; k++) {
      const p = cellItems[k]!
      if (stamp[p] === rayId) continue
      stamp[p] = rayId

      // Slab test against the bounding box. For boxes it is the exact test, and the axis
      // the ray entered through gives the face normal. Other shapes are only tested exactly
      // when their bounding box is hit closer than the best hit so far.
      const o = p * 6
      let near = -Infinity
      let far = Infinity
      let axis = 0
      a = (bounds[o]! - ox) * ix
      b = (bounds[o + 3]! - ox) * ix
      if (Math.min(a, b) > near) { near = Math.min(a, b); axis = 0 }
      far = Math.min(far, Math.max(a, b))
      a = (bounds[o + 1]! - oy) * iy
      b = (bounds[o + 4]! - oy) * iy
      if (Math.min(a, b) > near) { near = Math.min(a, b); axis = 1 }
      far = Math.min(far, Math.max(a, b))
      a = (bounds[o + 2]! - oz) * iz
      b = (bounds[o + 5]! - oz) * iz
      if (Math.min(a, b) > near) { near = Math.min(a, b); axis = 2 }
      far = Math.min(far, Math.max(a, b))
      if (near > far || far <= EPS || near >= best) continue

      const shape = shapes[p]
      let t: number
      if (shape === BOX) {
        if (near <= EPS) continue
        t = near
        const sign = -Math.sign(axis === 0 ? dx : axis === 1 ? dy : dz)
        cnx = axis === 0 ? sign : 0
        cny = axis === 1 ? sign : 0
        cnz = axis === 2 ? sign : 0
      }
      else {
        t = shape === CYLINDER
          ? hitCylinder(bounds, o, ox, oy, oz, dx, dy, dz)
          : shape === CONE
            ? hitCone(bounds, o, ox, oy, oz, dx, dy, dz)
            : hitSphere(bounds, o, ox, oy, oz, dx, dy, dz)
        if (t >= best) continue
      }

      if (anyHit) return true
      best = t
      hit.prim = p
      hit.nx = cnx
      hit.ny = cny
      hit.nz = cnz
    }

    const cellExit = Math.min(tMaxX, tMaxZ, t1)
    // Nothing in a later cell can be closer than a hit inside this one.
    if (best <= cellExit || cellExit >= t1) break
    if (tMaxX < tMaxZ) {
      cx += stepX
      tMaxX += tDeltaX
    }
    else {
      cz += stepZ
      tMaxZ += tDeltaZ
    }
    if (cx < 0 || cx >= cells || cz < 0 || cz >= cells) break
  }

  hit.t = best
  return best < Infinity
}

/**
 * Traces one ray per cell of a cols × rows grid, rows top to bottom. Writes the shaded color
 * into `rgb` (3 bytes per cell) and into `ink` how shadowed the surface is (0..255). The ink
 * decides how dense a character to draw: 0 means draw nothing, because the cell missed
 * everything or has faded into the fog. Also writes each cell's view depth (Infinity for
 * sky) and surface normal (3 bytes, ×127), which the outline pass uses to find edges.
 *
 * With rowStart/rowStep it traces only every rowStep-th row starting at rowStart, packed
 * tightly into ink/rgb. Interleaving rows like this gives each worker an even mix of
 * cheap sky rows and expensive scenery rows.
 */
export function renderScene(
  s: RaycastScene, cam: Camera, cols: number, rows: number,
  ink: Uint8Array, rgb: Uint8Array, depths: Float32Array, normals: Int8Array,
  rowStart = 0, rowStep = 1,
) {
  const { forward: f, right: r, up: u } = cameraBasis(cam.position, cam.target)
  const tanHalf = Math.tan((cam.fov * Math.PI) / 360)
  const [ox, oy, oz] = cam.position
  const { sky, ground, colors, fogNear, fogFar } = s

  for (let y = rowStart, row = 0; y < rows; y += rowStep, row++) {
    const sy = (1 - ((y + 0.5) / rows) * 2) * tanHalf
    for (let x = 0; x < cols; x++) {
      const sx = (((x + 0.5) / cols) * 2 - 1) * tanHalf * cam.aspect
      let dx = f[0] + r[0] * sx + u[0] * sy
      let dy = f[1] + r[1] * sx + u[1] * sy
      let dz = f[2] + r[2] * sx + u[2] * sy
      const len = Math.hypot(dx, dy, dz)
      dx /= len
      dy /= len
      dz /= len

      const i = row * cols + x
      if (!trace(s, ox, oy, oz, dx, dy, dz, false)) {
        ink[i] = 0
        depths[i] = Infinity
        continue
      }

      const { t, prim } = hit
      let { nx, ny, nz } = hit
      // Scalars instead of a [r, g, b] array: no allocation per hit.
      let br: number
      let bg: number
      let bb: number
      if (prim === MESH) {
        // Blend the triangle's three vertex normals and colors by where the ray hit it,
        // which makes the faceted mesh look smooth.
        const { normals: vertexNormals, albedo, bvh } = s.mesh!
        const t3 = hit.triangle * 3
        const i0 = bvh.indices[t3]! * 3
        const i1 = bvh.indices[t3 + 1]! * 3
        const i2 = bvh.indices[t3 + 2]! * 3
        const w1 = hit.u
        const w2 = hit.v
        const w0 = 1 - w1 - w2
        nx = vertexNormals[i0]! * w0 + vertexNormals[i1]! * w1 + vertexNormals[i2]! * w2
        ny = vertexNormals[i0 + 1]! * w0 + vertexNormals[i1 + 1]! * w1 + vertexNormals[i2 + 1]! * w2
        nz = vertexNormals[i0 + 2]! * w0 + vertexNormals[i1 + 2]! * w1 + vertexNormals[i2 + 2]! * w2
        const nl = Math.hypot(nx, ny, nz) || 1
        // Seen from behind (e.g. through a gap): shade the side facing the camera.
        const flip = nx * dx + ny * dy + nz * dz > 0 ? -1 / nl : 1 / nl
        nx *= flip
        ny *= flip
        nz *= flip
        br = albedo[i0]! * w0 + albedo[i1]! * w1 + albedo[i2]! * w2
        bg = albedo[i0 + 1]! * w0 + albedo[i1 + 1]! * w1 + albedo[i2 + 1]! * w2
        bb = albedo[i0 + 2]! * w0 + albedo[i1 + 2]! * w1 + albedo[i2 + 2]! * w2
      }
      else if (prim === GROUND) {
        br = ground[0]
        bg = ground[1]
        bb = ground[2]
      }
      else {
        br = colors[prim * 3]!
        bg = colors[prim * 3 + 1]!
        bb = colors[prim * 3 + 2]!
      }

      // Hemisphere light: blend of ground and sky color by how much the surface points up.
      const w = ny * 0.5 + 0.5
      let lr = HEMI_GROUND[0] + (HEMI_SKY[0] - HEMI_GROUND[0]) * w
      let lg = HEMI_GROUND[1] + (HEMI_SKY[1] - HEMI_GROUND[1]) * w
      let lb = HEMI_GROUND[2] + (HEMI_SKY[2] - HEMI_GROUND[2]) * w

      // Sun light, blocked if a shadow ray toward the sun hits anything.
      const facing = nx * SUN[0] + ny * SUN[1] + nz * SUN[2]
      if (facing > 0) {
        // Start the shadow ray slightly off the surface so it doesn't hit its own surface.
        const px = ox + dx * t + nx * 0.05
        const py = oy + dy * t + ny * 0.05
        const pz = oz + dz * t + nz * 0.05
        if (!trace(s, px, py, pz, SUN[0], SUN[1], SUN[2], true)) {
          lr += SUN_LIGHT[0] * facing
          lg += SUN_LIGHT[1] * facing
          lb += SUN_LIGHT[2] * facing
        }
      }

      // Fog like three's: smoothstep on view depth, blended in linear space.
      const depth = t * (dx * f[0] + dy * f[1] + dz * f[2])
      const fogT = Math.min(1, Math.max(0, (depth - fogNear) / (fogFar - fogNear)))
      const fog = fogT * fogT * (3 - 2 * fogT)
      const cr = linearToSrgbByte(br * lr * (1 - fog) + sky[0] * fog)
      const cg = linearToSrgbByte(bg * lg * (1 - fog) + sky[1] * fog)
      const cb = linearToSrgbByte(bb * lb * (1 - fog) + sky[2] * fog)
      rgb[i * 3] = cr
      rgb[i * 3 + 1] = cg
      rgb[i * 3 + 2] = cb
      const shadow = Math.min(1, Math.max(0, (MAX_LIGHT - luminance(lr, lg, lb)) / (MAX_LIGHT - MIN_LIGHT)))
      ink[i] = (MIN_INK + (1 - MIN_INK) * shadow) * (1 - fog) * 255
      depths[i] = depth
      normals[i * 3] = nx * 127
      normals[i * 3 + 1] = ny * 127
      normals[i * 3 + 2] = nz * 127
    }
  }
}
