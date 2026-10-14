export const BLOCK_SIZE = 24
export const ROAD_WIDTH = 8
export const SIDEWALK_HEIGHT = 0.3
export const ROAD_COLOR = 0x3a3d42
export const SIDEWALK_COLOR = 0x9a9890
/** Sky and fog color, shared by the 3D and ASCII views. */
export const SKY_COLOR = 0xbfd4e6
export const FOG_NEAR = 400
export const FOG_FAR = 1400

// Lighting for the 3D view.
export const SUN_COLOR = 0xfff4e0
export const SUN_INTENSITY = 2.4
export const SUN_POSITION: [number, number, number] = [300, 500, 200]
export const HEMI_SKY_COLOR = 0xdfefff
export const HEMI_GROUND_COLOR = 0x5a5040
export const HEMI_INTENSITY = 1.2
export const BUILDING_METALNESS = 0.1

export interface Building {
  x: number
  z: number
  width: number
  depth: number
  height: number
  color: number
}

export interface CityOptions {
  seed: number
  /** Number of blocks along each side of the square city. */
  blocks: number
  blockSize: number
  roadWidth: number
}

export interface City {
  buildings: Building[]
  /** Total width of the city, roads included. */
  size: number
}

const PALETTE = [0xd8d4cc, 0xb9b4aa, 0x8f9aa3, 0x6d7a86, 0xc7b299, 0xa3866a, 0x5c6670, 0xe6e1d6]

/** Small, fast seeded PRNG so the same seed always gives the same city. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateCity({ seed, blocks, blockSize, roadWidth }: CityOptions): City {
  const rand = mulberry32(seed)
  const buildings: Building[] = []
  const pitch = blockSize + roadWidth
  const size = blocks * pitch + roadWidth
  const half = size / 2
  const maxDist = Math.hypot(half, half)

  for (let bx = 0; bx < blocks; bx++) {
    for (let bz = 0; bz < blocks; bz++) {
      const blockX = -half + roadWidth + bx * pitch
      const blockZ = -half + roadWidth + bz * pitch

      // Some blocks become parks: no buildings.
      if (rand() < 0.06) continue

      // Split each block into a grid of lots. Bigger lots give chunkier buildings.
      const lotsX = 1 + Math.floor(rand() * 3)
      const lotsZ = 1 + Math.floor(rand() * 3)
      const lotW = blockSize / lotsX
      const lotD = blockSize / lotsZ

      for (let lx = 0; lx < lotsX; lx++) {
        for (let lz = 0; lz < lotsZ; lz++) {
          const margin = 0.6 + rand() * 1.2
          const width = lotW - margin * 2
          const depth = lotD - margin * 2
          const x = blockX + lx * lotW + lotW / 2
          const z = blockZ + lz * lotD + lotD / 2

          // Downtown in the middle is tall, suburbs at the edge are low.
          const centrality = 1 - Math.hypot(x, z) / maxDist
          const base = 4 + centrality ** 2.2 * 70
          const height = Math.max(3, base * (0.35 + rand() * 0.9) + (rand() < 0.04 ? 40 * centrality : 0))

          buildings.push({
            x,
            z,
            width,
            depth,
            height,
            color: PALETTE[Math.floor(rand() * PALETTE.length)]!,
          })
        }
      }
    }
  }

  return { buildings, size }
}
