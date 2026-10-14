import { linearRgb } from '../lib/color'
import type { Vec3 } from '../lib/math'
import { pick, mulberry32 } from '../lib/random'
import { chain, ellipsoid, taperedCapsule, thickTriangle, type SdfShape } from '../lib/sdf'
import { polygonize, type SurfaceMesh } from '../lib/surfaceNets'
import type { Environment } from './types'

// Parts, for coloring.
const BODY = 0
const MEMBRANE = 1
const HORN = 2
const EYE = 3

/** Color schemes; the seed picks one. */
const PALETTES = [
  { name: 'Crimson', body: 0x8e1f1f, belly: 0xd9a45b, membrane: 0x5a1414, horn: 0xe8dcc0, eye: 0xffd23a },
  { name: 'Emerald', body: 0x1f6b3a, belly: 0xcfc58a, membrane: 0x2d4a2a, horn: 0xd8d0b0, eye: 0xff8a1a },
  { name: 'Azure', body: 0x1f4e8e, belly: 0xbfd0e0, membrane: 0x2a3550, horn: 0xeeeeee, eye: 0x7fffd4 },
  { name: 'Obsidian', body: 0x26232b, belly: 0x6b5f73, membrane: 0x3b1f4a, horn: 0xbfb59a, eye: 0xff3b3b },
  { name: 'Gold', body: 0xb8862b, belly: 0xf0d58c, membrane: 0x7a4f1a, horn: 0xfff1cf, eye: 0x3bd1ff },
]

/** Mesh resolution per detail level: the size of one sampling cell, in world units. */
const VOXEL_SIZES = [2, 1.5, 1, 0.75, 0.6]
/** How far apart parts blend into each other. Larger = more organic, less defined. */
const SMOOTHING = 2.5

/**
 * The dragon, facing +x and standing on the ground, built from ~60 simple SDF shapes.
 * Points are [x, y, z, radius]. Both sides are mirrored with s = ±1.
 */
function dragonShapes(voxel: number): SdfShape[] {
  const shapes: SdfShape[] = []
  // Membranes must be well over one cell thick, or meshing misses them in places (holes).
  const membrane = Math.max(1, voxel * 1.1)

  // Torso and neck: an S-curve rising to the head.
  shapes.push(...chain([[-20, 22, 0, 10], [-6, 25, 0, 12.5], [8, 27, 0, 12], [16, 28, 0, 10]], BODY))
  shapes.push(...chain([[16, 28, 0, 9], [23, 35, 0, 7], [26, 43, 0, 6], [29, 50, 0, 5.2], [34, 54, 0, 5]], BODY))

  // Head: skull, snout and lower jaw.
  shapes.push(ellipsoid([38, 55, 0], [7, 5.5, 5.2], BODY))
  shapes.push(taperedCapsule([40, 54, 0], [51, 51.5, 0], 4.6, 2.6, BODY))
  shapes.push(taperedCapsule([37, 50, 0], [49, 48, 0], 3.6, 2, BODY))

  // Tail: sweeps back and curls to one side, ending in a spade.
  shapes.push(...chain([[-20, 22, 0, 9.5], [-34, 17, 4, 7], [-48, 11, 10, 5], [-62, 7, 10, 3.6], [-73, 5, 3, 2.5], [-79, 6, -6, 1.6], [-80, 9, -12, 0.9]], BODY))
  shapes.push(ellipsoid([-81, 10, -14], [2.5, 1, 3.5], HORN))

  // Spikes along the back, neck and tail, leaning backward.
  const spikes: [number, number, number, number][] = [
    [27, 55, 0, 3], [24, 48, 0, 3.5], [20, 41, 0, 4], [12, 37, 0, 5], [4, 39, 0, 5.5], [-6, 37.5, 0, 5],
    [-16, 32, 0, 4.5], [-28, 25, 1.5, 4], [-40, 18, 6, 3.2], [-52, 13, 9, 2.6], [-63, 10, 9, 2], [-72, 8, 3, 1.5],
  ]
  for (const [x, y, z, h] of spikes) shapes.push(taperedCapsule([x, y - 1, z], [x - 1.5, y + h, z], (1.6 * h) / 5, 0.15, HORN))

  for (const s of [1, -1]) {
    // Brow ridges, eyes and two pairs of swept-back horns.
    shapes.push(taperedCapsule([37, 58, 3 * s], [43, 56.5, 2.5 * s], 1.6, 1, BODY))
    shapes.push(ellipsoid([42, 56, 3.4 * s], [1.3, 1, 1], EYE))
    shapes.push(...chain([[36, 59, 3 * s, 1.8], [31, 64, 5 * s, 1.2], [24, 67, 6 * s, 0.3]], HORN))
    shapes.push(...chain([[39, 59, 4 * s, 1], [36, 62, 7 * s, 0.2]], HORN))

    // Front legs: shoulder, elbow, wrist, foot and three claws.
    shapes.push(...chain([[12, 24, 8 * s, 5.5], [16, 13, 11 * s, 3.6], [17, 3, 11 * s, 2.8]], BODY))
    shapes.push(ellipsoid([19, 1.8, 11 * s], [4.2, 1.8, 3.2], BODY))
    for (const dz of [-1.8, 0, 1.8]) shapes.push(taperedCapsule([21, 1.5, (11 + dz) * s], [24.5, 0.4, (11 + dz * 1.3) * s], 0.9, 0.2, HORN))

    // Hind legs: a heavier thigh and a backward-bending ankle.
    shapes.push(...chain([[-18, 22, 9 * s, 8], [-10, 13, 13 * s, 5], [-15, 5, 13 * s, 3.2], [-14, 2, 13 * s, 2.8]], BODY))
    shapes.push(ellipsoid([-11, 1.8, 13 * s], [5, 1.8, 3.5], BODY))
    for (const dz of [-2, 0, 2]) shapes.push(taperedCapsule([-7, 1.5, (13 + dz) * s], [-3.5, 0.4, (13 + dz * 1.3) * s], 1, 0.2, HORN))

    // Wings: an arm (shoulder, elbow, wrist), four finger bones fanning out from the wrist,
    // and membranes stretched between them and back to the body.
    const shoulder: Vec3 = [6, 30, 8 * s]
    const elbow: Vec3 = [4, 44, 18 * s]
    const wrist: Vec3 = [-2, 54, 30 * s]
    const fingers: Vec3[] = [[-12, 52, 54 * s], [-24, 44, 50 * s], [-32, 34, 38 * s], [-30, 28, 22 * s]]
    const flank: Vec3 = [-18, 26, 8 * s]
    shapes.push(...chain([[...shoulder, 3.2], [...elbow, 2.2], [...wrist, 1.6]], BODY))
    for (const tip of fingers) shapes.push(taperedCapsule(wrist, tip, 1.3, 0.4, BODY))
    for (let f = 0; f < fingers.length - 1; f++) shapes.push(thickTriangle(wrist, fingers[f]!, fingers[f + 1]!, membrane, MEMBRANE))
    shapes.push(thickTriangle(elbow, wrist, fingers[3]!, membrane, MEMBRANE))
    shapes.push(thickTriangle(shoulder, elbow, fingers[3]!, membrane, MEMBRANE))
    shapes.push(thickTriangle(shoulder, fingers[3]!, flank, membrane, MEMBRANE))
  }
  return shapes
}

// Meshing is the slow part and doesn't depend on the seed, so keep one mesh per detail level.
const meshCache = new Map<number, SurfaceMesh>()

function dragonMesh(detail: number) {
  const voxel = VOXEL_SIZES[Math.min(VOXEL_SIZES.length, Math.max(1, detail)) - 1]!
  let mesh = meshCache.get(voxel)
  if (!mesh) {
    mesh = polygonize(dragonShapes(voxel), voxel, SMOOTHING)
    meshCache.set(voxel, mesh)
  }
  return mesh
}

export const dragon: Environment = {
  id: 'dragon',
  name: 'Dragon',
  sky: 0xd7e0e8,
  ground: 0x8f969c,
  fogNear: 500,
  fogFar: 1500,
  size: { min: 1, max: VOXEL_SIZES.length, default: 3, label: n => `detail ${n} of ${VOXEL_SIZES.length}` },
  camera: { position: [95, 55, 115], target: [-8, 26, 0] },

  generate(seed, detail) {
    const mesh = dragonMesh(detail)
    const palette = pick(mulberry32(seed), PALETTES)
    const body = linearRgb(palette.body)
    const belly = linearRgb(palette.belly)
    const byPart = [body, linearRgb(palette.membrane), linearRgb(palette.horn), linearRgb(palette.eye)]

    // Per-vertex colors. The underside of the body fades into the lighter belly color.
    const count = mesh.parts.length
    const colors = new Float32Array(count * 3)
    for (let v = 0; v < count; v++) {
      const part = mesh.parts[v]!
      let color = byPart[part]!
      if (part === BODY) {
        const down = Math.min(1, Math.max(0, -mesh.normals[v * 3 + 1]! * 1.5))
        color = [0, 1, 2].map(i => body[i]! + (belly[i]! - body[i]!) * down) as Vec3
      }
      colors.set(color, v * 3)
    }

    return {
      primitives: [],
      meshes: [{ positions: mesh.positions, normals: mesh.normals, colors, indices: mesh.indices, roughness: 0.8 }],
      // Big enough that the floor's edge disappears into the fog.
      extent: 3000,
      summary: `${palette.name} dragon · ${(mesh.indices.length / 3).toLocaleString('en-US')} triangles`,
    }
  },
}
