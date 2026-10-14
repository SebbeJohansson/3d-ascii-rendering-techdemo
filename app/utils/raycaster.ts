/**
 * A tiny CPU ray tracer for the city. No 3D engine, no GPU: every character cell
 * on screen shoots one ray into a list of axis-aligned boxes.
 *
 * Boxes are bucketed into a uniform grid on the ground plane, so a ray only
 * tests the boxes in the cells it actually crosses (2D DDA traversal).
 */
import {
  BLOCK_SIZE, BUILDING_METALNESS, FOG_FAR, FOG_NEAR, HEMI_GROUND_COLOR, HEMI_INTENSITY, HEMI_SKY_COLOR,
  ROAD_COLOR, ROAD_WIDTH, SIDEWALK_COLOR, SIDEWALK_HEIGHT, SKY_COLOR, SUN_COLOR, SUN_INTENSITY, SUN_POSITION,
  type City,
} from './city'
import type { Vec3 } from '../composables/useCitySettings'

export interface RaycastScene {
  /** minX, minY, minZ, maxX, maxY, maxZ per box. */
  boxes: Float32Array
  /** Diffuse albedo per box: linear r, g, b in 0..1, already scaled by (1 - metalness). */
  colors: Float32Array
  half: number
  maxHeight: number
  cellSize: number
  cells: number
  /** cellItems[cellStart[c] .. cellStart[c + 1]] are the boxes overlapping cell c. */
  cellStart: Uint32Array
  cellItems: Uint32Array
  /** Last ray id that tested each box, so a box spanning several cells is tested once per ray. */
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
// Shading follows three's MeshStandardMaterial so both views match: colors are converted to
// linear light, lit with Lambert diffuse (albedo / π × irradiance) from the sun plus a hemisphere
// light, fogged, and converted back to sRGB. Specular is left out; at roughness 0.8 it is small.
const SUN = normalize(SUN_POSITION)
const SUN_LIGHT = scale(linearRgb(SUN_COLOR), SUN_INTENSITY / Math.PI)
const HEMI_SKY = scale(linearRgb(HEMI_SKY_COLOR), HEMI_INTENSITY / Math.PI)
const HEMI_GROUND = scale(linearRgb(HEMI_GROUND_COLOR), HEMI_INTENSITY / Math.PI)
const ROAD_RGB = linearRgb(ROAD_COLOR)
const SKY_LINEAR = linearRgb(SKY_COLOR)
const SKY_RGB = hexToRgb(SKY_COLOR)
// Distance from the sky color to black: the most a cell can stand out from the background.
const MAX_CONTRAST = Math.hypot(...SKY_RGB) * 255
const GROUND = -1
const MISS = -2

function hexToRgb(hex: number): Vec3 {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]
}

function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearRgb(hex: number): Vec3 {
  return hexToRgb(hex).map(srgbToLinear) as Vec3
}

function scale(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k]
}

// Linear 0..1 to sRGB 0..255, via a table: a pow() per channel per cell adds up at 100k cells.
const SRGB_STEPS = 4096
const SRGB_TABLE = new Uint8Array(SRGB_STEPS + 1).map((_, i) => {
  const c = i / SRGB_STEPS
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055))
})

function toSrgb(c: number) {
  return SRGB_TABLE[Math.round(Math.min(1, Math.max(0, c)) * SRGB_STEPS)]!
}

function normalize([x, y, z]: Vec3): Vec3 {
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Forward, right and up unit vectors for a camera looking at its target. */
export function cameraBasis(position: Vec3, target: Vec3) {
  const forward = normalize([target[0] - position[0], target[1] - position[1], target[2] - position[2]])
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  return { forward, right, up }
}

export function buildRaycastScene(city: City, blocks: number): RaycastScene {
  const half = city.size / 2
  const count = blocks * blocks + city.buildings.length
  const boxes = new Float32Array(count * 6)
  const colors = new Float32Array(count * 3)
  let n = 0
  let maxHeight = SIDEWALK_HEIGHT

  function push(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, color: number, metalness = 0) {
    boxes.set([minX, minY, minZ, maxX, maxY, maxZ], n * 6)
    colors.set(scale(linearRgb(color), 1 - metalness), n * 3)
    maxHeight = Math.max(maxHeight, maxY)
    n++
  }

  // Same layout as the 3D view: a sidewalk slab per block, buildings standing on it.
  const pitch = BLOCK_SIZE + ROAD_WIDTH
  for (let bx = 0; bx < blocks; bx++) {
    for (let bz = 0; bz < blocks; bz++) {
      const x = -half + ROAD_WIDTH + bx * pitch
      const z = -half + ROAD_WIDTH + bz * pitch
      push(x, 0, z, x + BLOCK_SIZE, SIDEWALK_HEIGHT, z + BLOCK_SIZE, SIDEWALK_COLOR)
    }
  }
  for (const b of city.buildings) {
    push(
      b.x - b.width / 2, SIDEWALK_HEIGHT, b.z - b.depth / 2,
      b.x + b.width / 2, SIDEWALK_HEIGHT + b.height, b.z + b.depth / 2,
      b.color,
      BUILDING_METALNESS,
    )
  }

  // Bucket boxes into grid cells: count, prefix-sum, then fill.
  const cells = Math.ceil(city.size / CELL_SIZE)
  const toCell = (v: number) => Math.min(cells - 1, Math.max(0, Math.floor((v + half) / CELL_SIZE)))
  const cellStart = new Uint32Array(cells * cells + 1)
  const forEachCell = (box: number, fn: (cell: number) => void) => {
    const o = box * 6
    for (let cx = toCell(boxes[o]!); cx <= toCell(boxes[o + 3]!); cx++) {
      for (let cz = toCell(boxes[o + 2]!); cz <= toCell(boxes[o + 5]!); cz++) fn(cx * cells + cz)
    }
  }
  for (let i = 0; i < count; i++) forEachCell(i, c => cellStart[c + 1]!++)
  for (let c = 0; c < cells * cells; c++) cellStart[c + 1]! += cellStart[c]!
  const cursor = cellStart.slice(0, -1)
  const cellItems = new Uint32Array(cellStart[cells * cells]!)
  for (let i = 0; i < count; i++) forEachCell(i, c => cellItems[cursor[c]!++] = i)

  return { boxes, colors, half, maxHeight, cellSize: CELL_SIZE, cells, cellStart, cellItems, stamp: new Uint32Array(count), rayId: 0 }
}

/** Result of the last trace() call. Reused to avoid allocating per ray. */
const hit = { t: 0, box: MISS, axis: 0, sign: 0 }

/**
 * Finds the nearest box or ground hit along a ray. With anyHit set it returns as soon as
 * anything blocks the ray, which is all a shadow ray needs.
 */
function trace(s: RaycastScene, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, anyHit: boolean): boolean {
  const ix = 1 / (dx || 1e-12)
  const iy = 1 / (dy || 1e-12)
  const iz = 1 / (dz || 1e-12)

  // Clip the ray to the city's bounding box first.
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
  hit.box = MISS
  if (t0 > t1) return false

  let best = Infinity
  // The ground is the road surface, everywhere inside the city.
  if (!anyHit && dy < 0) {
    const tg = -oy * iy
    if (tg >= t0 && tg <= t1) {
      best = tg
      hit.box = GROUND
      hit.axis = 1
      hit.sign = 1
    }
  }

  if (++s.rayId === 0xFFFFFFFF) {
    s.stamp.fill(0)
    s.rayId = 1
  }
  const rayId = s.rayId
  const { boxes, cellStart, cellItems, stamp, cells, cellSize, half } = s

  // 2D DDA across grid cells, starting where the ray enters the city.
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
      const box = cellItems[k]!
      if (stamp[box] === rayId) continue
      stamp[box] = rayId

      // Slab test, tracking which axis the ray entered through for the face normal.
      const o = box * 6
      let near = -Infinity
      let far = Infinity
      let axis = 0
      a = (boxes[o]! - ox) * ix
      b = (boxes[o + 3]! - ox) * ix
      if (Math.min(a, b) > near) { near = Math.min(a, b); axis = 0 }
      far = Math.min(far, Math.max(a, b))
      a = (boxes[o + 1]! - oy) * iy
      b = (boxes[o + 4]! - oy) * iy
      if (Math.min(a, b) > near) { near = Math.min(a, b); axis = 1 }
      far = Math.min(far, Math.max(a, b))
      a = (boxes[o + 2]! - oz) * iz
      b = (boxes[o + 5]! - oz) * iz
      if (Math.min(a, b) > near) { near = Math.min(a, b); axis = 2 }
      far = Math.min(far, Math.max(a, b))

      if (near <= far && near > 1e-4 && near < best) {
        if (anyHit) return true
        best = near
        hit.box = box
        hit.axis = axis
        hit.sign = -Math.sign(axis === 0 ? dx : axis === 1 ? dy : dz)
      }
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
 * cheap sky rows and expensive city rows.
 */
export function renderCity(
  s: RaycastScene, cam: Camera, cols: number, rows: number, ink: Uint8Array, rgb: Uint8Array,
  rowStart = 0, rowStep = 1,
) {
  const { forward: f, right: r, up: u } = cameraBasis(cam.position, cam.target)
  const tanHalf = Math.tan((cam.fov * Math.PI) / 360)
  const [ox, oy, oz] = cam.position

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

      const { t, box, axis, sign } = hit
      // Scalars instead of a [r, g, b] array: no allocation per hit.
      const br = box === GROUND ? ROAD_RGB[0] : s.colors[box * 3]!
      const bg = box === GROUND ? ROAD_RGB[1] : s.colors[box * 3 + 1]!
      const bb = box === GROUND ? ROAD_RGB[2] : s.colors[box * 3 + 2]!
      const nx = axis === 0 ? sign : 0
      const ny = axis === 1 ? sign : 0
      const nz = axis === 2 ? sign : 0

      // Hemisphere light: blend of ground and sky color by how much the face points up.
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
      const fogT = Math.min(1, Math.max(0, (depth - FOG_NEAR) / (FOG_FAR - FOG_NEAR)))
      const fog = fogT * fogT * (3 - 2 * fogT)
      const cr = toSrgb(br * lr * (1 - fog) + SKY_LINEAR[0] * fog)
      const cg = toSrgb(bg * lg * (1 - fog) + SKY_LINEAR[1] * fog)
      const cb = toSrgb(bb * lb * (1 - fog) + SKY_LINEAR[2] * fog)
      rgb[i * 3] = cr
      rgb[i * 3 + 1] = cg
      rgb[i * 3 + 2] = cb
      const contrast = Math.hypot(cr - SKY_RGB[0] * 255, cg - SKY_RGB[1] * 255, cb - SKY_RGB[2] * 255)
      ink[i] = Math.min(255, (contrast / MAX_CONTRAST) * 255)
    }
  }
}
