import { linearRgb } from '../lib/color'
import type { Vec3 } from '../lib/math'
import { between, createValueNoise, mulberry32, pick } from '../lib/random'
import type { Environment, Mesh, Primitive } from './types'

/** The size slider sets the sea's side in tiles of this many world units. */
const TILE = 100
/** Spacing of the land's height samples, in world units. */
const STEP = 3
/** Depth of the sea floor around the islands. */
const SEABED = -8

const WET_SAND = 0xb59a68
const SAND = 0xe3cf98
const GRASS = [0x5f8a3a, 0x4d7a35]
const ROCK = 0x8b8478
const PALM_TRUNK = 0x8a6a45
const PALM_LEAVES = [0x3f7a32, 0x4f8a36, 0x5c9440]
const BUSH_COLORS = [0x3d6b30, 0x4b7a34]
const ROCK_COLORS = [0x8b8a84, 0x77766f, 0x9a968c]

interface Island {
  x: number
  z: number
  radius: number
  peak: number
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Blends two linear colors, k = 0 → a, 1 → b. */
const mixLinear = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

/**
 * The land's height at any point: a rounded hill per island with a ragged coastline, plus
 * smaller hills on top. Below 0 is under the sea.
 */
function createHeightmap(seed: number, islands: Island[]) {
  const coast = createValueNoise(seed + 2, 40)
  const coastFine = createValueNoise(seed + 3, 12)
  const hills = createValueNoise(seed + 4, 30)
  return (x: number, z: number) => {
    // Stretch every island's radius by noise, so coastlines get bays and headlands.
    const wobble = 0.7 + 0.5 * coast(x, z) + 0.2 * coastFine(x, z)
    let land = 0
    let peak = 0
    for (const island of islands) {
      const d = Math.hypot(x - island.x, z - island.z) / (island.radius * wobble)
      const k = 1 - smoothstep(0, 1, d)
      if (k > land) {
        land = k
        peak = island.peak
      }
    }
    // Flat-ish beaches near the coast, steeper toward the middle.
    return SEABED + (peak - SEABED) * land ** 1.6 + (hills(x, z) - 0.5) * 10 * land ** 2
  }
}

/** The islands' land as one triangle mesh, colored by height and slope. Leaves out the sea floor. */
function landMesh(height: (x: number, z: number) => number, extent: number, seed: number): Mesh {
  const n = Math.floor(extent / STEP) + 1
  const start = -((n - 1) * STEP) / 2
  const heights = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) heights[i * n + j] = height(start + i * STEP, start + j * STEP)
  }

  // Only squares with a corner near or above the water: the rest is hidden under the sea.
  const remap = new Int32Array(n * n).fill(-1)
  const indices: number[] = []
  let vertexCount = 0
  const vertex = (k: number) => (remap[k] === -1 ? (remap[k] = vertexCount++) : remap[k]!)
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j
      const b = a + n
      if (Math.max(heights[a]!, heights[a + 1]!, heights[b]!, heights[b + 1]!) < -1) continue
      // Counterclockwise seen from above, so the faces point up.
      const [va, vb, va1, vb1] = [vertex(a), vertex(b), vertex(a + 1), vertex(b + 1)]
      indices.push(va, va1, vb, vb, va1, vb1)
    }
  }

  const grass = createValueNoise(seed + 5, 25)
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const colors = new Float32Array(vertexCount * 3)
  const [wetSand, sand, rock] = [WET_SAND, SAND, ROCK].map(linearRgb) as [Vec3, Vec3, Vec3]
  const [lush, dry] = GRASS.map(linearRgb) as [Vec3, Vec3]
  for (let k = 0; k < n * n; k++) {
    const v = remap[k]!
    if (v === -1) continue
    const i = Math.floor(k / n)
    const j = k % n
    const x = start + i * STEP
    const z = start + j * STEP
    const y = heights[k]!
    positions.set([x, y, z], v * 3)

    // Normal from the slope between the neighbours (one-sided at the grid's edge).
    const hx = (heights[Math.min(n - 1, i + 1) * n + j]! - heights[Math.max(0, i - 1) * n + j]!) / (2 * STEP)
    const hz = (heights[i * n + Math.min(n - 1, j + 1)]! - heights[i * n + Math.max(0, j - 1)]!) / (2 * STEP)
    const len = Math.hypot(hx, 1, hz)
    const ny = 1 / len
    normals.set([-hx / len, ny, -hz / len], v * 3)

    // Wet sand under the water, dry sand on the beach, grass inland, rock on cliffs and peaks.
    let color = mixLinear(wetSand, sand, smoothstep(-0.5, 0.5, y))
    color = mixLinear(color, mixLinear(lush, dry, grass(x, z)), smoothstep(1.5, 3, y))
    color = mixLinear(color, rock, Math.max(smoothstep(0.8, 0.6, ny), smoothstep(22, 30, y)))
    colors.set(color, v * 3)
  }
  return { positions, normals, colors, indices: new Uint32Array(indices) }
}

export const ocean: Environment = {
  id: 'ocean',
  name: 'Ocean',
  sky: 0xbfe0f0,
  ground: 0x1f5f78, // the sea
  reflectance: 0.2,
  fogNear: 500,
  fogFar: 1600,
  size: { min: 3, max: 12, default: 7, label: n => `${n * TILE} × ${n * TILE} sea` },

  generate(seed, tiles) {
    const rand = mulberry32(seed)
    const extent = tiles * TILE
    const half = extent / 2

    // One big island near the middle, then smaller ones scattered around it.
    const islands: Island[] = [{ x: between(rand, -30, 30), z: between(rand, -30, 30), radius: between(rand, 80, 110), peak: between(rand, 22, 32) }]
    const count = Math.round(tiles * tiles * 0.2)
    for (let attempt = 0; islands.length <= count && attempt < count * 20; attempt++) {
      const radius = between(rand, 25, 70)
      const x = between(rand, -half + radius, half - radius)
      const z = between(rand, -half + radius, half - radius)
      // Keep some open water between islands.
      if (islands.some(o => Math.hypot(o.x - x, o.z - z) < (o.radius + radius) * 0.9)) continue
      islands.push({ x, z, radius, peak: between(rand, 4, 8) + radius * between(rand, 0.08, 0.2) })
    }

    const height = createHeightmap(seed, islands)
    const mesh = landMesh(height, extent, seed)

    // Palms near the beaches, bushes further inland, rocks along the shore.
    const primitives: Primitive[] = []
    let palms = 0
    for (const island of islands) {
      const tries = Math.round(island.radius ** 2 * 0.05)
      for (let k = 0; k < tries; k++) {
        const angle = rand() * Math.PI * 2
        const r = Math.sqrt(rand()) * island.radius * 1.1
        const x = island.x + Math.cos(angle) * r
        const z = island.z + Math.sin(angle) * r
        const y = height(x, z)
        const slope = Math.hypot(height(x + 1, z) - y, height(x, z + 1) - y)
        if (y < 0.8 || slope > 0.6) continue
        if (y < 10 && rand() < 0.6) {
          addPalm(primitives, rand, x, y, z)
          palms++
        }
        else if (y < 24 && rand() < 0.5) addBush(primitives, rand, x, y, z)
        else if (y < 3) addRock(primitives, rand, x, y, z)
      }
    }

    return {
      primitives,
      meshes: [{ ...mesh, roughness: 1 }],
      extent,
      summary: `${islands.length} islands · ${palms} palms`,
      groundHeight: (x, z) => Math.max(0, height(x, z)),
    }
  },
}

/** A tall thin trunk with a crown of two crossed, flattened ellipsoids: fronds seen from afar. */
function addPalm(out: Primitive[], rand: () => number, x: number, y: number, z: number) {
  const height = between(rand, 9, 15)
  const span = height * between(rand, 0.6, 0.75)
  const color = pick(rand, PALM_LEAVES)
  const top = y + height
  out.push({ shape: 'cylinder', x, y: y - 0.5, z, width: 0.8, depth: 0.8, height: height + 0.5, color: PALM_TRUNK })
  out.push({ shape: 'sphere', x, y: top - 1.2, z, width: span, depth: span * 0.3, height: 1.6, color })
  out.push({ shape: 'sphere', x, y: top - 1.2, z, width: span * 0.3, depth: span, height: 1.6, color })
  out.push({ shape: 'sphere', x, y: top - 0.6, z, width: 1.8, depth: 1.8, height: 1.4, color: PALM_TRUNK })
}

function addBush(out: Primitive[], rand: () => number, x: number, y: number, z: number) {
  const width = between(rand, 3, 7)
  out.push({ shape: 'sphere', x, y: y - width * 0.2, z, width, depth: width, height: width * 0.7, color: pick(rand, BUSH_COLORS) })
}

/** A flattened boulder, sunk slightly into the sand. */
function addRock(out: Primitive[], rand: () => number, x: number, y: number, z: number) {
  const width = between(rand, 2, 5)
  out.push({
    shape: 'sphere',
    x,
    y: y - 0.6,
    z,
    width,
    depth: width * between(rand, 0.7, 1.2),
    height: width * between(rand, 0.4, 0.7),
    color: pick(rand, ROCK_COLORS),
  })
}
