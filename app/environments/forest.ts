import { between, createValueNoise, mulberry32, pick } from '../lib/random'
import type { Environment, Primitive } from './types'

/** The forest is laid out on square plots; the size slider sets plots per side. */
const PLOT = 32
const TRUNK_COLORS = [0x5e412a, 0x6b4a2f, 0x4f3a28]
const PINE_COLORS = [0x2e5a3a, 0x355f3f, 0x24503a, 0x3c6b46]
const LEAF_COLORS = [0x4d7a35, 0x5f8a3a, 0x6f9440, 0x86983e, 0xa08a3a]
const ROCK_COLORS = [0x8b8a84, 0x77766f, 0x9a968c]

export const forest: Environment = {
  id: 'forest',
  name: 'Forest',
  sky: 0xcbdbe0,
  ground: 0x5b7a3c, // grass
  groundLabel: 'Grass',
  // Denser fog than the city: the trees fade into a haze.
  fogNear: 200,
  fogFar: 1100,
  size: { min: 2, max: 30, default: 12, label: n => `${n} × ${n} plots` },

  generate(seed, plots) {
    const rand = mulberry32(seed)
    // Low density areas become clearings; the second noise decides pine vs leafy groves.
    const density = createValueNoise(seed, PLOT * 4)
    const pineness = createValueNoise(seed + 1, PLOT * 6)
    const primitives: Primitive[] = []
    const extent = plots * PLOT
    const half = extent / 2
    let trees = 0

    for (let px = 0; px < plots; px++) {
      for (let pz = 0; pz < plots; pz++) {
        const plotX = -half + px * PLOT
        const plotZ = -half + pz * PLOT
        const d = density(plotX + PLOT / 2, plotZ + PLOT / 2)

        // Clearings get a few rocks instead of trees.
        if (d < 0.28) {
          if (rand() < 0.5) addRock(primitives, rand, plotX + between(rand, 4, PLOT - 4), plotZ + between(rand, 4, PLOT - 4))
          continue
        }

        const count = Math.round(between(rand, 3, 5 + (d - 0.3) * 14))
        for (let i = 0; i < count; i++) {
          const x = plotX + between(rand, 2, PLOT - 2)
          const z = plotZ + between(rand, 2, PLOT - 2)
          if (rand() < 0.3 + 0.5 * pineness(x, z)) addPine(primitives, rand, x, z)
          else addLeafyTree(primitives, rand, x, z)
          trees++
        }
      }
    }

    return { primitives, extent, summary: `${trees} trees` }
  },
}

function trunk(rand: () => number, x: number, z: number, width: number, height: number, label: string): Primitive {
  return { shape: 'cylinder', x, y: 0, z, width, depth: width, height, color: pick(rand, TRUNK_COLORS), label }
}

/** A trunk with three stacked cones, each narrower than the one below. */
function addPine(out: Primitive[], rand: () => number, x: number, z: number) {
  const height = between(rand, 14, 30)
  const width = height * between(rand, 0.35, 0.45)
  const color = pick(rand, PINE_COLORS)
  const label = `Pine · ${Math.round(height)} m`
  out.push(trunk(rand, x, z, height * 0.06, height * 0.3, label))
  for (let tier = 0; tier < 3; tier++) {
    const w = width * (1 - tier * 0.25)
    out.push({ shape: 'cone', x, y: height * (0.18 + tier * 0.22), z, width: w, depth: w, height: height * 0.42, color, label })
  }
}

/** A trunk with a round crown, sometimes with a smaller second crown to break the outline. */
function addLeafyTree(out: Primitive[], rand: () => number, x: number, z: number) {
  const height = between(rand, 10, 20)
  const crown = height * between(rand, 0.6, 0.8)
  const color = pick(rand, LEAF_COLORS)
  const label = `Leafy tree · ${Math.round(height)} m`
  out.push(trunk(rand, x, z, height * 0.1, height * 0.55, label))
  out.push({ shape: 'sphere', x, y: height - crown, z, width: crown, depth: crown, height: crown * 0.9, color, label })
  if (rand() < 0.5) {
    const small = crown * 0.6
    out.push({
      shape: 'sphere',
      x: x + between(rand, -0.3, 0.3) * crown,
      y: height - crown * 0.75,
      z: z + between(rand, -0.3, 0.3) * crown,
      width: small,
      depth: small,
      height: small * 0.9,
      color,
      label,
    })
  }
}

/** A flattened boulder, sunk slightly into the ground. */
function addRock(out: Primitive[], rand: () => number, x: number, z: number) {
  const width = between(rand, 2, 6)
  out.push({
    shape: 'sphere',
    x,
    y: -0.5,
    z,
    width,
    depth: width * between(rand, 0.7, 1.2),
    height: width * between(rand, 0.4, 0.7),
    color: pick(rand, ROCK_COLORS),
    label: 'Boulder',
  })
}
