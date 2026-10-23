import { linearRgb } from '../lib/color'
import type { Vec3 } from '../lib/math'
import { between, createValueNoise, mulberry32, pick } from '../lib/random'
import type { Environment, Mesh, Primitive } from './types'

/** The size slider sets the land's side in tiles of this many world units. */
const TILE = 100
/** Spacing of the land's height samples, in world units, at most... */
const STEP = 4
/** ...and at most this many per side, so a big range doesn't take long to build a BVH for. */
const MAX_SAMPLES = 201
/** Height of the tallest ridges, before noise. */
const PEAK = 210
/** Height of the valley floor. */
const FLOOR = 3

const GRASS = [0x6b8f3e, 0x58803a]
const FOREST_FLOOR = 0x3f5f2f
const MEADOW = 0x8a8a52
const ROCK = 0x7d776f
const SNOW = 0xf2f4f6
const TRUNK_COLORS = [0x5e412a, 0x6b4a2f, 0x4f3a28]
const PINE_COLORS = [0x2e5a3a, 0x355f3f, 0x24503a, 0x3c6b46]
const ROCK_COLORS = [0x8b8a84, 0x77766f, 0x9a968c]

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Blends two linear colors, k = 0 → a, 1 → b. */
const mixLinear = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

/**
 * The land's height at any point: ridged noise (sharp crests where smooth noise crosses its
 * middle) in octaves, so ranges get spurs and side ridges. Low in a valley around the middle
 * and at the edges, so the range stands on a plain instead of ending in a cliff.
 */
function createHeightmap(seed: number, half: number) {
  const octaves = [240, 120, 60, 30, 15].map((spacing, k) => createValueNoise(seed + 10 + k, spacing))
  const ranges = createValueNoise(seed + 20, 220)
  const hills = createValueNoise(seed + 21, 50)
  const valley = Math.min(120, half * 0.35)
  return (x: number, z: number) => {
    let ridged = 0
    let weight = 1
    let total = 0
    for (const noise of octaves) {
      // Each octave's crests are sharper where the ones before it were high, so peaks get
      // rugged and valleys stay smooth.
      const r = 1 - Math.abs(2 * noise(x, z) - 1)
      ridged += r * r * weight
      total += weight
      weight *= 0.5 * (0.6 + 0.8 * r)
    }
    ridged /= total
    const edge = Math.max(Math.abs(x), Math.abs(z))
    const mask = smoothstep(valley * 0.5, valley * 1.8, Math.hypot(x, z)) * smoothstep(half, half * 0.75, edge)
    const high = mask * (0.25 + 0.9 * smoothstep(0.25, 0.65, ranges(x, z)))
    return FLOOR + PEAK * high * ridged ** 1.6 + 8 * hills(x, z) * (1 - high)
  }
}

/** Height samples `step` apart covering the land, and the height between them as the mesh has it. */
function sampleHeights(height: (x: number, z: number) => number, extent: number) {
  const n = Math.min(MAX_SAMPLES, Math.floor(extent / STEP) + 1)
  const step = extent / (n - 1)
  const start = -extent / 2
  const heights = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) heights[i * n + j] = height(start + i * step, start + j * step)
  }
  // Interpolates on the same two triangles per square as landMesh(), so players and trees
  // stand exactly on the drawn surface.
  const at = (x: number, z: number) => {
    const fx = Math.min(n - 1.0001, Math.max(0, (x - start) / step))
    const fz = Math.min(n - 1.0001, Math.max(0, (z - start) / step))
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const u = fx - i
    const v = fz - j
    const a = heights[i * n + j]!
    const a1 = heights[i * n + j + 1]!
    const b = heights[(i + 1) * n + j]!
    const b1 = heights[(i + 1) * n + j + 1]!
    return u + v <= 1 ? a + (b - a) * u + (a1 - a) * v : b1 + (a1 - b1) * (1 - u) + (b - b1) * (1 - v)
  }
  return { n, step, start, heights, at }
}

/** The land as one triangle mesh: grass in the valleys, rock on cliffs, snow on the peaks. */
function landMesh({ n, step, start, heights }: ReturnType<typeof sampleHeights>, seed: number): Mesh {
  const indices = new Uint32Array((n - 1) * (n - 1) * 6)
  let t = 0
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j
      const b = a + n
      // Counterclockwise seen from above, so the faces point up.
      indices.set([a, a + 1, b, b, a + 1, b + 1], t)
      t += 6
    }
  }

  const grass = createValueNoise(seed + 5, 25)
  const snowline = createValueNoise(seed + 6, 60)
  const positions = new Float32Array(n * n * 3)
  const normals = new Float32Array(n * n * 3)
  const colors = new Float32Array(n * n * 3)
  const [forest, meadow, rock, snow] = [FOREST_FLOOR, MEADOW, ROCK, SNOW].map(linearRgb) as [Vec3, Vec3, Vec3, Vec3]
  const [lush, dry] = GRASS.map(linearRgb) as [Vec3, Vec3]
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = i * n + j
      const x = start + i * step
      const z = start + j * step
      const y = heights[k]!
      positions.set([x, y, z], k * 3)

      // Normal from the slope between the neighbours (one-sided at the grid's edge).
      const hx = (heights[Math.min(n - 1, i + 1) * n + j]! - heights[Math.max(0, i - 1) * n + j]!) / (2 * step)
      const hz = (heights[i * n + Math.min(n - 1, j + 1)]! - heights[i * n + Math.max(0, j - 1)]!) / (2 * step)
      const len = Math.hypot(hx, 1, hz)
      const ny = 1 / len
      normals.set([-hx / len, ny, -hz / len], k * 3)

      // Grass in the valley, darker under the forest, meadow above the tree line, rock on steep
      // slopes, and snow above a ragged snowline wherever it isn't too steep to stick.
      let color = mixLinear(lush, dry, grass(x, z))
      color = mixLinear(color, forest, smoothstep(12, 25, y) * smoothstep(75, 60, y))
      color = mixLinear(color, meadow, smoothstep(65, 85, y))
      color = mixLinear(color, rock, Math.max(smoothstep(0.72, 0.55, ny), smoothstep(85, 110, y)))
      const line = 75 + 25 * snowline(x, z)
      color = mixLinear(color, snow, smoothstep(line - 8, line + 8, y) * smoothstep(0.4, 0.55, ny))
      colors.set(color, k * 3)
    }
  }
  return { positions, normals, colors, indices, heightfield: { n, start, step } }
}

export const mountains: Environment = {
  id: 'mountains',
  name: 'Mountains',
  sky: 0xc6dceb,
  ground: GRASS[0]!,
  groundLabel: 'Valley floor',
  fogNear: 800,
  fogFar: 2400,
  camera: { position: [560, 330, 560], target: [0, 20, 0] },
  size: { min: 4, max: 12, default: 8, label: n => `${n * TILE} × ${n * TILE} range` },

  generate(seed, tiles) {
    const rand = mulberry32(seed)
    const extent = tiles * TILE
    const half = extent / 2
    const land = sampleHeights(createHeightmap(seed, half), extent)
    const mesh = landMesh(land, seed)

    // Pines on the lower slopes, thinning out toward the tree line; boulders on the meadows.
    const density = createValueNoise(seed + 7, 70)
    const primitives: Primitive[] = []
    let trees = 0
    let peak = 0
    for (const y of land.heights) peak = Math.max(peak, y)
    const tries = Math.round(extent * extent * 0.006)
    for (let k = 0; k < tries; k++) {
      const x = between(rand, -half + 4, half - 4)
      const z = between(rand, -half + 4, half - 4)
      const y = land.at(x, z)
      const slope = Math.hypot(land.at(x + 1, z) - y, land.at(x, z + 1) - y)
      if (slope > 0.7) continue
      const treeLine = smoothstep(75, 55, y)
      if (rand() < treeLine * smoothstep(0.3, 0.7, density(x, z))) {
        addPine(primitives, rand, x, y, z, 0.6 + 0.4 * treeLine)
        trees++
      }
      else if (y > 60 && y < 110 && rand() < 0.03) addRock(primitives, rand, x, y, z)
    }

    return {
      primitives,
      meshes: [{ ...mesh, roughness: 1, label: 'Mountainside', ground: true }],
      extent,
      summary: `${Math.round(peak)} m peak · ${trees} trees`,
      groundHeight: land.at,
    }
  },
}

/** A trunk with three stacked cones, each narrower than the one below; smaller near the tree line. */
function addPine(out: Primitive[], rand: () => number, x: number, y: number, z: number, scale: number) {
  const height = between(rand, 12, 24) * scale
  const width = height * between(rand, 0.35, 0.45)
  const color = pick(rand, PINE_COLORS)
  const label = `Pine · ${Math.round(height)} m`
  // Sunk a little, so the downhill side doesn't float.
  const base = y - 1
  out.push({ shape: 'cylinder', x, y: base, z, width: height * 0.06, depth: height * 0.06, height: height * 0.3 + 1, color: pick(rand, TRUNK_COLORS), label })
  for (let tier = 0; tier < 3; tier++) {
    const w = width * (1 - tier * 0.25)
    out.push({ shape: 'cone', x, y: base + 1 + height * (0.18 + tier * 0.22), z, width: w, depth: w, height: height * 0.42, color, label })
  }
}

/** A flattened boulder, sunk into the slope. */
function addRock(out: Primitive[], rand: () => number, x: number, y: number, z: number) {
  const width = between(rand, 2, 6)
  out.push({
    shape: 'sphere',
    x,
    y: y - width * 0.25,
    z,
    width,
    depth: width * between(rand, 0.7, 1.2),
    height: width * between(rand, 0.4, 0.7),
    color: pick(rand, ROCK_COLORS),
    label: 'Boulder',
  })
}
