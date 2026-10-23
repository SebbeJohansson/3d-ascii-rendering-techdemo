/**
 * A tiny CPU ray tracer. No 3D engine, no GPU: every character cell on screen shoots one ray
 * into the environment's primitives (boxes, upright cylinders and cones, ellipsoids).
 *
 * Primitives are bucketed by their bounding boxes into a uniform grid on the ground plane,
 * so a ray only tests the primitives in the cells it actually crosses (2D DDA traversal).
 * Triangle meshes go into a BVH (see bvh.ts) instead. A spawned player has a BVH of its own,
 * built once in the player's own space; rays are moved into that space instead of moving
 * its triangles every time it moves.
 */
import type { Environment, EnvironmentScene, Mesh, Primitive, Shape } from '../environments/types'
import type { PlayerPose } from '../players/types'
import { lightingAt, NOON, type Lighting } from '../environments/lighting'
import { buildBvh, bvhHit, intersectBvh, refitBvh, type Bvh } from './bvh'
import { linearRgb, linearToSrgbByte } from './color'
import { cameraBasis, scale, type Vec3 } from './math'
import { WINDOW_COLOR, WINDOW_GLOW, windowLit } from './windows'

export interface RaycastScene {
  /** minX, minY, minZ, maxX, maxY, maxZ per primitive. */
  bounds: Float32Array
  shapes: Uint8Array
  /** Diffuse albedo per primitive: linear r, g, b in 0..1, already scaled by (1 - metalness). */
  colors: Float32Array
  /** Which primitives have windows that light up at night. */
  windows: Uint8Array
  ground: Vec3
  /** How much a sea mirrors looking straight down (Environment.reflectance), 0 for solid ground. */
  reflectance: number
  /** The current time of day's light; see setLighting(). */
  light: SceneLight
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
    /** Each source mesh's indices, to tell whether new meshes are the same ones moved. */
    sources: Uint32Array[]
  }
  /** The spawned player, if any. Not part of the environment: set and cleared by the caller. */
  player?: RaycastPlayer
  /** Darken corners and creases with ambient occlusion rays. Set by the caller per frame. */
  occlusion: boolean
}

/** A Lighting, worked out into the terms the shading loop uses. */
interface SceneLight {
  /** Unit vector toward the sun (or moon). */
  sun: Vec3
  /** Irradiance from the sun (or moon) and the hemisphere light, linear rgb. */
  sunLight: Vec3
  hemiSky: Vec3
  hemiGround: Vec3
  /** Sky and fog color, linear rgb. */
  sky: Vec3
  /** Radiance of a lit window, linear rgb: 0 by day. */
  windowGlow: Vec3
  /** How much a lit window takes away from its cell's ink: 0 by day, up to 1 at night. */
  night: number
  /** The most and least light a surface can get, for scaling ink. */
  maxLight: number
  minLight: number
}

/** A player's mesh in its own space, and where it currently is. */
export interface RaycastPlayer {
  bvh: Bvh
  normals: Float32Array
  /** Diffuse albedo per vertex, like RaycastScene.mesh. */
  albedo: Float32Array
  scale: number
  x: number
  y: number
  z: number
  /** cos and sin of the heading. */
  cos: number
  sin: number
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
const PLAYER = -4

// Ink comes from how much light reaches a surface, not from its color: dark materials (pines)
// and light ones get the same range of characters, and density shows lit vs shadowed sides.
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b
// Even fully lit surfaces get a light character, so they don't vanish into the sky.
const MIN_INK = 0.25

/**
 * Sets the time of day's light for the next renderScene(). Shading follows three's
 * MeshStandardMaterial so both views match: colors are converted to linear light, lit with
 * Lambert diffuse (albedo / π × irradiance) from the sun plus a hemisphere light, fogged, and
 * converted back to sRGB. Specular is left out; at high roughness it is small.
 */
export function setLighting(s: RaycastScene, lighting: Lighting) {
  const sunLight = scale(linearRgb(lighting.color), lighting.intensity / Math.PI)
  const hemiSky = scale(linearRgb(lighting.hemiSky), lighting.hemiIntensity / Math.PI)
  const hemiGround = scale(linearRgb(lighting.hemiGround), lighting.hemiIntensity / Math.PI)
  s.light = {
    sun: lighting.direction,
    sunLight,
    hemiSky,
    hemiGround,
    sky: linearRgb(lighting.sky),
    windowGlow: scale(linearRgb(WINDOW_COLOR), WINDOW_GLOW * lighting.night),
    night: lighting.night,
    // Brightest: facing straight up into the sun. Darkest: facing down, lit by the ground only.
    maxLight: luminance(...hemiSky) + luminance(...sunLight),
    minLight: luminance(...hemiGround),
  }
}

export function buildRaycastScene(env: Environment, { primitives, extent, meshes = [] }: EnvironmentScene): RaycastScene {
  const scene: RaycastScene = {
    bounds: new Float32Array(0),
    shapes: new Uint8Array(0),
    colors: new Float32Array(0),
    windows: new Uint8Array(0),
    ground: linearRgb(env.ground),
    reflectance: env.reflectance ?? 0,
    light: undefined!,
    fogNear: env.fogNear,
    fogFar: env.fogFar,
    half: extent / 2,
    maxHeight: 1,
    primitivesHeight: 1,
    cellSize: CELL_SIZE,
    cells: Math.ceil(extent / CELL_SIZE),
    cellStart: new Uint32Array(0),
    cellItems: new Uint32Array(0),
    stamp: new Uint32Array(0),
    rayId: 0,
    occlusion: false,
  }
  setMeshes(scene, meshes)
  setPrimitives(scene, primitives)
  setLighting(scene, lightingAt(NOON, env.sky))
  return scene
}

/**
 * Replaces the scene's primitives and rebuilds their grid, keeping its meshes. Cheap next to
 * building the scene again, so dropped boxes can be added one at a time.
 */
export function setPrimitives(s: RaycastScene, primitives: Primitive[]) {
  const { half, cells } = s
  const count = primitives.length
  const bounds = new Float32Array(count * 6)
  const shapes = new Uint8Array(count)
  const colors = new Float32Array(count * 3)
  const windows = new Uint8Array(count)
  let maxHeight = 1

  primitives.forEach((p, i) => {
    bounds.set([p.x - p.width / 2, p.y, p.z - p.depth / 2, p.x + p.width / 2, p.y + p.height, p.z + p.depth / 2], i * 6)
    shapes[i] = SHAPE_CODES[p.shape]
    colors.set(scale(linearRgb(p.color), 1 - (p.metalness ?? 0)), i * 3)
    windows[i] = p.windows ? 1 : 0
    maxHeight = Math.max(maxHeight, p.y + p.height)
  })

  // Bucket primitives into grid cells: count, prefix-sum, then fill.
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

  Object.assign(s, { bounds, shapes, colors, windows, cellStart, cellItems, stamp: new Uint32Array(count), primitivesHeight: maxHeight })
  s.maxHeight = s.mesh ? Math.max(maxHeight, s.mesh.bvh.bounds[4]!) : maxHeight
}

/** Whether two index arrays are equal, value by value. */
function sameIndices(a: Uint32Array, b: Uint32Array) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Replaces the scene's meshes, merged into one so one BVH covers them all. Meshes that are
 * the same as before, only moved (a falling shape), are copied in and the BVH refitted, which
 * is much cheaper than building it again. Returns whether it was built again.
 */
export function setMeshes(s: RaycastScene, meshes: readonly Mesh[]) {
  const old = s.mesh
  if (old && old.sources.length === meshes.length && meshes.every((m, i) => sameIndices(m.indices, old.sources[i]!))) {
    let offset = 0
    for (const m of meshes) {
      old.bvh.positions.set(m.positions, offset)
      old.normals.set(m.normals, offset)
      offset += m.positions.length
    }
    refitBvh(old.bvh)
    s.maxHeight = Math.max(s.primitivesHeight, old.bvh.bounds[4]!)
    return false
  }
  s.mesh = undefined
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
    s.mesh = { bvh: buildBvh(positions, indices), normals, albedo, sources: meshes.map(m => m.indices) }
  }
  s.maxHeight = s.mesh ? Math.max(s.primitivesHeight, s.mesh.bvh.bounds[4]!) : s.primitivesHeight
  return true
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

/**
 * Builds the ray tracer's copy of a player. The BVH shares the mesh's position and normal
 * arrays, so after animating the mesh, placePlayer(..., true) refits it.
 */
export function buildRaycastPlayer(mesh: Mesh, scale: number): RaycastPlayer {
  const keep = 1 - (mesh.metalness ?? 0)
  return {
    bvh: buildBvh(mesh.positions, mesh.indices),
    normals: mesh.normals,
    albedo: mesh.colors.map(c => c * keep),
    scale,
    x: 0,
    y: 0,
    z: 0,
    cos: 1,
    sin: 0,
  }
}

/** Moves a player to a pose. Pass `animated` when its mesh changed shape since the last call. */
export function placePlayer(p: RaycastPlayer, { position, heading }: PlayerPose, animated: boolean) {
  ;[p.x, p.y, p.z] = position
  p.cos = Math.cos(heading)
  p.sin = Math.sin(heading)
  if (animated) refitBvh(p.bvh)
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
 * Finds the nearest primitive or ground hit along a ray, closer than maxT. With anyHit set it
 * returns as soon as anything blocks the ray, which is all a shadow ray needs; it then also
 * skips the ground.
 */
function trace(s: RaycastScene, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, anyHit: boolean, maxT: number): boolean {
  const ix = 1 / (dx || 1e-12)
  const iy = 1 / (dy || 1e-12)
  const iz = 1 / (dz || 1e-12)

  let best = maxT
  hit.prim = MISS

  // The player first: it can be outside the environment's box, which is clipped to below.
  // Its triangles stay in its own space, so turn the ray into that space instead: undo the
  // position, heading and scale. A point t along the ray stays at t along the moved ray.
  const pl = s.player
  if (pl) {
    const k = 1 / pl.scale
    const rx = ox - pl.x
    const rz = oz - pl.z
    const t = intersectBvh(
      pl.bvh,
      (rx * pl.cos - rz * pl.sin) * k, (oy - pl.y) * k, (rx * pl.sin + rz * pl.cos) * k,
      (dx * pl.cos - dz * pl.sin) * k, dy * k, (dx * pl.sin + dz * pl.cos) * k,
      best, anyHit,
    )
    if (t < best) {
      if (anyHit) return true
      best = t
      hit.prim = PLAYER
      hit.triangle = bvhHit.triangle
      hit.u = bvhHit.u
      hit.v = bvhHit.v
    }
  }

  // The ground covers the whole environment at y = 0; a sea reaches the horizon.
  if (!anyHit && dy < 0) {
    const tg = -oy * iy
    if (tg > 0 && tg < best && (s.reflectance || (Math.abs(ox + dx * tg) <= s.half && Math.abs(oz + dz * tg) <= s.half))) {
      best = tg
      hit.prim = GROUND
      hit.nx = 0
      hit.ny = 1
      hit.nz = 0
    }
  }

  // Clip the ray to the environment's bounding box.
  let t0 = 0
  let t1 = maxT
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
  if (t0 > t1) {
    hit.t = best
    return hit.prim !== MISS
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
    return hit.prim !== MISS
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
  return hit.prim !== MISS
}

/** How far ambient occlusion rays look, in world units: about two floors of a building. */
export const AO_RADIUS = 6
/** How dark a fully enclosed surface gets: the hemisphere light is scaled by 1 - this. */
export const AO_STRENGTH = 0.85
/**
 * Ambient occlusion directions around a normal pointing up the z axis: two staggered rings of
 * four, low and high. Fixed rather than random, so a still frame doesn't shimmer.
 */
export const AO_DIRS = [[0.35, 0], [0.8, Math.PI / 4]].flatMap(([lift, turn]) => [0, 1, 2, 3].map((k) => {
  const angle = turn! + (k * Math.PI) / 2
  const up = Math.sin(lift! * (Math.PI / 2))
  const out = Math.sqrt(1 - up * up)
  return [out * Math.cos(angle), out * Math.sin(angle), up] as const
}))

/**
 * The share of AO_DIRS rays from a surface point that travel AO_RADIUS without hitting
 * anything (the ground included), turned into a factor for the hemisphere light.
 */
function ambientOcclusion(s: RaycastScene, px: number, py: number, pz: number, nx: number, ny: number, nz: number) {
  // A tangent frame around the normal (Duff et al. 2017, "Building an Orthonormal Basis, Revisited").
  const sign = nz >= 0 ? 1 : -1
  const a = -1 / (sign + nz)
  const b = nx * ny * a
  const tx = 1 + sign * nx * nx * a
  const ty = sign * b
  const tz = -sign * nx
  const bx = b
  const by = sign + ny * ny * a
  const bz = -ny
  let blocked = 0
  for (const [u, v, w] of AO_DIRS) {
    const dx = tx * u + bx * v + nx * w
    const dy = ty * u + by * v + ny * w
    const dz = tz * u + bz * v + nz * w
    if ((dy < 0 && py + dy * AO_RADIUS < 0) || trace(s, px, py, pz, dx, dy, dz, true, AO_RADIUS)) blocked++
  }
  return 1 - AO_STRENGTH * (blocked / AO_DIRS.length)
}

/** What shade() worked out for the last hit: unfogged linear color, ink 0..1 and normal. */
const shaded = { r: 0, g: 0, b: 0, ink: 0, nx: 0, ny: 0, nz: 0 }

/**
 * Shades the hit trace() just found for the ray from (ox, oy, oz) along unit (dx, dy, dz),
 * into `shaded`. Its ink is how shadowed the surface is, before fog.
 */
function shade(s: RaycastScene, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
  const { ground, colors, windows } = s
  const { sun, sunLight, hemiSky, hemiGround, windowGlow, night, maxLight, minLight } = s.light
  const { t, prim } = hit
  let { nx, ny, nz } = hit
  // Scalars instead of a [r, g, b] array: no allocation per hit.
  let br: number
  let bg: number
  let bb: number
  // Light the surface gives off itself: lit windows at night.
  let er = 0
  let eg = 0
  let eb = 0
  if (prim === MESH || prim === PLAYER) {
    // Blend the triangle's three vertex normals and colors by where the ray hit it,
    // which makes the faceted mesh look smooth.
    const { normals: vertexNormals, albedo, bvh } = prim === MESH ? s.mesh! : s.player!
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
    if (prim === PLAYER) {
      // From the player's space back to the world: turn by its heading.
      const { cos, sin } = s.player!
      const wx = nx * cos + nz * sin
      nz = -nx * sin + nz * cos
      nx = wx
    }
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
    // Walls only: boxes get exact axis normals, so ny is 0 on every side.
    if (night && windows[prim] && ny === 0) {
      const face = nx > 0 ? 0 : nx < 0 ? 1 : nz > 0 ? 2 : 3
      if (windowLit(face, nx ? oz + dz * t : ox + dx * t, oy + dy * t)) {
        er = windowGlow[0]
        eg = windowGlow[1]
        eb = windowGlow[2]
      }
    }
  }

  // Hemisphere light: blend of ground and sky color by how much the surface points up.
  const w = ny * 0.5 + 0.5
  let lr = hemiGround[0] + (hemiSky[0] - hemiGround[0]) * w
  let lg = hemiGround[1] + (hemiSky[1] - hemiGround[1]) * w
  let lb = hemiGround[2] + (hemiSky[2] - hemiGround[2]) * w

  // Start secondary rays slightly off the surface so they don't hit the surface itself.
  const px = ox + dx * t + nx * 0.05
  const py = oy + dy * t + ny * 0.05
  const pz = oz + dz * t + nz * 0.05

  // Corners and creases see less of the sky.
  if (s.occlusion) {
    const ao = ambientOcclusion(s, px, py, pz, nx, ny, nz)
    lr *= ao
    lg *= ao
    lb *= ao
  }

  // Sun light, blocked if a shadow ray toward the sun hits anything.
  const facing = nx * sun[0] + ny * sun[1] + nz * sun[2]
  if (facing > 0) {
    if (!trace(s, px, py, pz, sun[0], sun[1], sun[2], true, Infinity)) {
      lr += sunLight[0] * facing
      lg += sunLight[1] * facing
      lb += sunLight[2] * facing
    }
  }

  shaded.r = br * lr + er
  shaded.g = bg * lg + eg
  shaded.b = bb * lb + eb
  // A lit window is as bright as it gets: the lightest characters.
  const shadow = er ? 1 - night : Math.min(1, Math.max(0, (maxLight - luminance(lr, lg, lb)) / (maxLight - minLight)))
  shaded.ink = MIN_INK + (1 - MIN_INK) * shadow
  shaded.nx = nx
  shaded.ny = ny
  shaded.nz = nz
}

/** Fog like three's: smoothstep on view depth. */
function fogAt(s: RaycastScene, depth: number) {
  const fogT = Math.min(1, Math.max(0, (depth - s.fogNear) / (s.fogFar - s.fogNear)))
  return fogT * fogT * (3 - 2 * fogT)
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
  const { sky } = s.light

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
      if (!trace(s, ox, oy, oz, dx, dy, dz, false, Infinity)) {
        ink[i] = 0
        depths[i] = Infinity
        continue
      }
      const { t, prim } = hit
      const forward = dx * f[0] + dy * f[1] + dz * f[2]
      const depth = t * forward
      const fog = fogAt(s, depth)
      // Ground lost in the fog (the far sea) is plain sky: no shading, no reflection.
      if (fog >= 1 && prim === GROUND) {
        rgb[i * 3] = linearToSrgbByte(sky[0])
        rgb[i * 3 + 1] = linearToSrgbByte(sky[1])
        rgb[i * 3 + 2] = linearToSrgbByte(sky[2])
        ink[i] = 0
        depths[i] = depth
        normals[i * 3] = 0
        normals[i * 3 + 1] = 127
        normals[i * 3 + 2] = 0
        continue
      }
      shade(s, ox, oy, oz, dx, dy, dz)
      let { r: cr, g: cg, b: cb, ink: cellInk } = shaded
      const { nx, ny, nz } = shaded

      // A sea mirrors what is above it: trace on from the water, upward, and blend in what
      // that ray sees (or the sky), more of it at grazing angles (Schlick's Fresnel).
      if (prim === GROUND && s.reflectance) {
        const k = s.reflectance + (1 - s.reflectance) * (1 + dy) ** 5
        let mr = sky[0]
        let mg = sky[1]
        let mb = sky[2]
        let mInk = 0
        const hx = ox + dx * t
        const hz = oz + dz * t
        // Anything farther than the fog's far end mirrors as plain sky: look no further.
        const reach = s.fogFar / forward - t
        if (reach > 0 && trace(s, hx, 0, hz, dx, -dy, dz, false, reach)) {
          // Fogged as far away as it looks: the mirror image lies behind the water.
          const fog = fogAt(s, (t + hit.t) * forward)
          shade(s, hx, 0, hz, dx, -dy, dz)
          mr = shaded.r * (1 - fog) + sky[0] * fog
          mg = shaded.g * (1 - fog) + sky[1] * fog
          mb = shaded.b * (1 - fog) + sky[2] * fog
          mInk = shaded.ink * (1 - fog)
        }
        cr += (mr - cr) * k
        cg += (mg - cg) * k
        cb += (mb - cb) * k
        cellInk += (mInk - cellInk) * k
      }

      // Fog blended in linear space.
      rgb[i * 3] = linearToSrgbByte(cr * (1 - fog) + sky[0] * fog)
      rgb[i * 3 + 1] = linearToSrgbByte(cg * (1 - fog) + sky[1] * fog)
      rgb[i * 3 + 2] = linearToSrgbByte(cb * (1 - fog) + sky[2] * fog)
      ink[i] = cellInk * (1 - fog) * 255
      depths[i] = depth
      normals[i * 3] = nx * 127
      normals[i * 3 + 1] = ny * 127
      normals[i * 3 + 2] = nz * 127
    }
  }
}

/** What a single ray hit: a primitive or mesh triangle by index, the ground, or the player. */
export type RayHit = (
  | { kind: 'primitive', index: number }
  | { kind: 'mesh', triangle: number }
  | { kind: 'ground' | 'player' }
) & {
  distance: number
  point: Vec3
  /** Unit surface normal there, facing the ray's side for meshes as they are built. */
  normal: Vec3
}

/**
 * Traces the one ray through (u, v) of the camera's view, both 0..1 from the top left, the
 * way renderScene() traces a cell's center. Undefined if it hits nothing.
 */
export function castRay(s: RaycastScene, cam: Camera, u: number, v: number): RayHit | undefined {
  const { forward: f, right: r, up: up } = cameraBasis(cam.position, cam.target)
  const tanHalf = Math.tan((cam.fov * Math.PI) / 360)
  const sx = (u * 2 - 1) * tanHalf * cam.aspect
  const sy = (1 - v * 2) * tanHalf
  const d = [0, 1, 2].map(k => f[k]! + r[k]! * sx + up[k]! * sy)
  const len = Math.hypot(d[0]!, d[1]!, d[2]!)
  const [ox, oy, oz] = cam.position
  if (!trace(s, ox, oy, oz, d[0]! / len, d[1]! / len, d[2]! / len, false, Infinity)) return undefined
  const { t: distance, prim } = hit
  const point: Vec3 = [ox + (d[0]! / len) * distance, oy + (d[1]! / len) * distance, oz + (d[2]! / len) * distance]
  const normal = hitNormal(s)
  if (prim === GROUND) return { kind: 'ground', distance, point, normal }
  if (prim === PLAYER) return { kind: 'player', distance, point, normal }
  if (prim === MESH) return { kind: 'mesh', triangle: hit.triangle, distance, point, normal }
  return { kind: 'primitive', index: prim, distance, point, normal }
}

/** The last hit's normal, in world space. A player's is left in its own space: close enough to tell up from sideways. */
function hitNormal(s: RaycastScene): Vec3 {
  if (hit.prim !== MESH && hit.prim !== PLAYER) return [hit.nx, hit.ny, hit.nz]
  const { normals, bvh } = hit.prim === MESH ? s.mesh! : s.player!
  const t3 = hit.triangle * 3
  const w = [1 - hit.u - hit.v, hit.u, hit.v]
  const n: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const i = bvh.indices[t3 + k]! * 3
    for (let c = 0; c < 3; c++) n[c]! += normals[i + c]! * w[k]!
  }
  const len = Math.hypot(...n) || 1
  return [n[0] / len, n[1] / len, n[2] / len]
}

/**
 * Height of the first surface straight below (x, y, z), leaving out the player and the
 * primitives `skip` says yes to. 0 (the ground's height) if nothing is below. `below`, if
 * given, gets the mesh triangle found there, or -1 for anything else.
 */
export function heightBelow(s: RaycastScene, x: number, y: number, z: number, skip: (primitive: number) => boolean, below?: { triangle: number }) {
  const player = s.player
  s.player = undefined
  let height = 0
  if (below) below.triangle = -1
  while (trace(s, x, y, z, 0, -1, 0, false, Infinity)) {
    height = y - hit.t
    if (below && hit.prim === MESH) below.triangle = hit.triangle
    if (hit.prim < 0 || !skip(hit.prim)) break
    // Carry on from just under the skipped primitive.
    y = s.bounds[hit.prim * 6 + 1]! - EPS
    height = 0
  }
  s.player = player
  return height
}
