import { mulberry32, pick } from '../lib/random'
import { FLOOR_HEIGHT } from '../lib/windows'
import type { Environment, Primitive } from './types'

const BLOCK_SIZE = 24
const ROAD_WIDTH = 8
const SIDEWALK_HEIGHT = 0.3
const SIDEWALK_COLOR = 0x9a9890
const BUILDING_PALETTE = [0xd8d4cc, 0xb9b4aa, 0x8f9aa3, 0x6d7a86, 0xc7b299, 0xa3866a, 0x5c6670, 0xe6e1d6]

export const city: Environment = {
  id: 'city',
  name: 'City',
  sky: 0xbfd4e6,
  ground: 0x3a3d42, // asphalt
  groundLabel: 'Street',
  fogNear: 400,
  fogFar: 1400,
  size: { min: 2, max: 30, default: 12, label: n => `${n} × ${n} blocks` },

  // The crossing nearest the camera's target, so a car starts on the road.
  spawn(blocks, { target }) {
    const pitch = BLOCK_SIZE + ROAD_WIDTH
    const first = -(blocks * pitch + ROAD_WIDTH) / 2 + ROAD_WIDTH / 2
    const snap = (v: number) => first + Math.min(blocks, Math.max(0, Math.round((v - first) / pitch))) * pitch
    return [snap(target[0]), 0, snap(target[2])]
  },

  generate(seed, blocks) {
    const rand = mulberry32(seed)
    const primitives: Primitive[] = []
    const pitch = BLOCK_SIZE + ROAD_WIDTH
    const extent = blocks * pitch + ROAD_WIDTH
    const half = extent / 2
    const maxDist = Math.hypot(half, half)
    let buildings = 0

    for (let bx = 0; bx < blocks; bx++) {
      for (let bz = 0; bz < blocks; bz++) {
        const blockX = -half + ROAD_WIDTH + bx * pitch
        const blockZ = -half + ROAD_WIDTH + bz * pitch
        primitives.push({
          shape: 'box',
          x: blockX + BLOCK_SIZE / 2,
          y: 0,
          z: blockZ + BLOCK_SIZE / 2,
          width: BLOCK_SIZE,
          depth: BLOCK_SIZE,
          height: SIDEWALK_HEIGHT,
          color: SIDEWALK_COLOR,
          label: 'Sidewalk',
        })

        // Some blocks become parks: no buildings.
        if (rand() < 0.06) continue

        // Split each block into a grid of lots. Bigger lots give chunkier buildings.
        const lotsX = 1 + Math.floor(rand() * 3)
        const lotsZ = 1 + Math.floor(rand() * 3)
        const lotW = BLOCK_SIZE / lotsX
        const lotD = BLOCK_SIZE / lotsZ

        for (let lx = 0; lx < lotsX; lx++) {
          for (let lz = 0; lz < lotsZ; lz++) {
            const margin = 0.6 + rand() * 1.2
            const x = blockX + lx * lotW + lotW / 2
            const z = blockZ + lz * lotD + lotD / 2

            // Downtown in the middle is tall, suburbs at the edge are low.
            const centrality = 1 - Math.hypot(x, z) / maxDist
            const base = 4 + centrality ** 2.2 * 70
            const height = Math.max(3, base * (0.35 + rand() * 0.9) + (rand() < 0.04 ? 40 * centrality : 0))

            primitives.push({
              shape: 'box',
              x,
              y: SIDEWALK_HEIGHT,
              z,
              width: lotW - margin * 2,
              depth: lotD - margin * 2,
              height,
              color: pick(rand, BUILDING_PALETTE),
              roughness: 0.8,
              metalness: 0.1,
              windows: true,
              label: `Building · ${Math.max(1, Math.round(height / FLOOR_HEIGHT))} floors`,
            })
            buildings++
          }
        }
      }
    }

    return { primitives, extent, summary: `${buildings} buildings` }
  },
}
