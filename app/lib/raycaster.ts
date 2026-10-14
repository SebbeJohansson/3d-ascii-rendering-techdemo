/**
 * A tiny CPU ray tracer. No 3D engine, no GPU: every character cell on screen shoots one ray
 * into the environment's primitives (axis-aligned boxes).
 *
 * Primitives are bucketed by their bounding boxes into a uniform grid on the ground plane,
 * so a ray only tests the primitives in the cells it actually crosses (2D DDA traversal).
 */
import type { Environment, EnvironmentScene, Shape } from '../environments/types'
import { HEMI_GROUND_COLOR, HEMI_INTENSITY, HEMI_SKY_COLOR, SUN_COLOR, SUN_INTENSITY, SUN_POSITION } from '../environments/lighting'
import { hexToBytes, linearRgb, linearToSrgbByte } from './color'
import { cameraBasis, normalize, scale, type Vec3 } from './math'

export interface RaycastScene {
  /** minX, minY, minZ, maxX, maxY, maxZ per primitive. */
  bounds: Float32Array
  shapes: Uint8Array
  /** Diffuse albedo per primitive: linear r, g, b in 0..1, already scaled by (1 - metalness). */
  colors: Float32Array
  ground: Vec3
  sky: Vec3
  /** Sky as sRGB bytes, what characters are judged against. */
  skyBytes: Vec3
  /** Distance from the sky color to black: the most a cell can stand out from the background. */
  maxContrast: number
  fogNear: number
  fogFar: number
  half: number
  maxHeight: number
  cellSize: number
  cells: number
  /** cellItems[cellStart[c] .. cellStart[c + 1]] are the primitives overlapping cell c. */
  cellStart: Uint32Array
  cellItems: Uint32Array
  /** Last ray id that tested each primitive, so one spanning several cells is tested once per ray. */
  stamp: Uint32Array
  rayId: number
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
const SHAPE_CODES: Record<Shape, number> = { box: BOX }
const GROUND = -1
const MISS = -2

// Shading follows three's MeshStandardMaterial so both views match: colors are converted to
// linear light, lit with Lambert diffuse (albedo / π × irradiance) from the sun plus a hemisphere
// light, fogged, and converted back to sRGB. Specular is left out; at high roughness it is small.
const SUN = normalize(SUN_POSITION)
const SUN_LIGHT = scale(linearRgb(SUN_COLOR), SUN_INTENSITY / Math.PI)
const HEMI_SKY = scale(linearRgb(HEMI_SKY_COLOR), HEMI_INTENSITY / Math.PI)
const HEMI_GROUND = scale(linearRgb(HEMI_GROUND_COLOR), HEMI_INTENSITY / Math.PI)

export function buildRaycastScene(env: Environment, { primitives, extent }: EnvironmentScene): RaycastScene {
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

  const skyBytes = hexToBytes(env.sky)
  return {
    bounds,
    shapes,
    colors,
    ground: linearRgb(env.ground),
    sky: linearRgb(env.sky),
    skyBytes,
    maxContrast: Math.hypot(...skyBytes),
    fogNear: env.fogNear,
    fogFar: env.fogFar,
    half,
    maxHeight,
    cellSize: CELL_SIZE,
    cells,
    cellStart,
    cellItems,
    stamp: new Uint32Array(count),
    rayId: 0,
  }
}

/** Result of the last trace() call. Reused to avoid allocating per ray. */
const hit = { t: 0, prim: MISS, nx: 0, ny: 0, nz: 0 }

// Surface normal of the last candidate hit, written by the shape test in trace().
let cnx = 0
let cny = 0
let cnz = 0

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

  if (++s.rayId === 0xFFFFFFFF) {
    s.stamp.fill(0)
    s.rayId = 1
  }
  const rayId = s.rayId
  const { bounds, cellStart, cellItems, stamp, cells, cellSize, half } = s

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

      // Slab test: the axis the ray entered through gives the face normal.
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

      if (near <= EPS) continue
      const t = near
      const sign = -Math.sign(axis === 0 ? dx : axis === 1 ? dy : dz)
      cnx = axis === 0 ? sign : 0
      cny = axis === 1 ? sign : 0
      cnz = axis === 2 ? sign : 0

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
 * into `rgb` (3 bytes per cell) and into `ink` how much that color stands out from the sky
 * (0..255). The ink decides how dense a character to draw: 0 means draw nothing, because the
 * cell missed everything or has faded into the fog.
 *
 * With rowStart/rowStep it traces only every rowStep-th row starting at rowStart, packed
 * tightly into ink/rgb. Interleaving rows like this gives each worker an even mix of
 * cheap sky rows and expensive scenery rows.
 */
export function renderScene(
  s: RaycastScene, cam: Camera, cols: number, rows: number, ink: Uint8Array, rgb: Uint8Array,
  rowStart = 0, rowStep = 1,
) {
  const { forward: f, right: r, up: u } = cameraBasis(cam.position, cam.target)
  const tanHalf = Math.tan((cam.fov * Math.PI) / 360)
  const [ox, oy, oz] = cam.position
  const { sky, skyBytes, maxContrast, ground, colors, fogNear, fogFar } = s

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
        continue
      }

      const { t, prim, nx, ny, nz } = hit
      // Scalars instead of a [r, g, b] array: no allocation per hit.
      const br = prim === GROUND ? ground[0] : colors[prim * 3]!
      const bg = prim === GROUND ? ground[1] : colors[prim * 3 + 1]!
      const bb = prim === GROUND ? ground[2] : colors[prim * 3 + 2]!

      // Hemisphere light: blend of ground and sky color by how much the surface points up.
      const w = ny * 0.5 + 0.5
      let lr = HEMI_GROUND[0] + (HEMI_SKY[0] - HEMI_GROUND[0]) * w
      let lg = HEMI_GROUND[1] + (HEMI_SKY[1] - HEMI_GROUND[1]) * w
      let lb = HEMI_GROUND[2] + (HEMI_SKY[2] - HEMI_GROUND[2]) * w

      // Sun light, blocked if a shadow ray toward the sun hits anything.
      const facing = nx * SUN[0] + ny * SUN[1] + nz * SUN[2]
      if (facing > 0) {
        const px = ox + dx * t + nx * 0.01
        const py = oy + dy * t + ny * 0.01
        const pz = oz + dz * t + nz * 0.01
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
      const contrast = Math.hypot(cr - skyBytes[0], cg - skyBytes[1], cb - skyBytes[2])
      ink[i] = Math.min(255, (contrast / maxContrast) * 255)
    }
  }
}
