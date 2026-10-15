import { linearRgb } from '../lib/color'
import type { Vec3 } from '../lib/math'
import { pick, mulberry32 } from '../lib/random'
import { chain, ellipsoid, taperedCapsule, thickTriangle, type SdfShape } from '../lib/sdf'
import { polygonize, type SurfaceMesh } from '../lib/surfaceNets'
import type { Environment, Mesh } from './types'

// Parts, for coloring.
const BODY = 0
const MEMBRANE = 1
const HORN = 2
const EYE = 3
/** Wing bones: colored like the body, but they move with the wing. */
const WING = 4

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
    shapes.push(...chain([[...shoulder, 3.2], [...elbow, 2.2], [...wrist, 1.6]], WING))
    for (const tip of fingers) shapes.push(taperedCapsule(wrist, tip, 1.3, 0.4, WING))
    for (let f = 0; f < fingers.length - 1; f++) shapes.push(thickTriangle(wrist, fingers[f]!, fingers[f + 1]!, membrane, MEMBRANE))
    shapes.push(thickTriangle(elbow, wrist, fingers[3]!, membrane, MEMBRANE))
    shapes.push(thickTriangle(shoulder, elbow, fingers[3]!, membrane, MEMBRANE))
    shapes.push(thickTriangle(shoulder, fingers[3]!, flank, membrane, MEMBRANE))
  }
  return shapes
}

// Wing flapping. The mesh is bent per frame instead of re-meshed (which takes ~0.25 s):
// each wing vertex rotates around a hinge running along the body, by the flap angle times
// its weight. Weights rise from 0 at the shoulder to 1 further out, so the wing bends
// smoothly out of the body, and the outer wing gets an extra, slightly delayed stroke.
const HINGE_PIVOT: Vec3 = [6, 30, 8] // z is mirrored per side
const HINGE_AXIS: Vec3 = (() => {
  const d: Vec3 = [24, 4, 0] // from the flank to the shoulder, along the body
  const l = Math.hypot(...d)
  return [d[0] / l, d[1] / l, d[2] / l]
})()
/** Wing beats per second, in radians. */
const FLAP_SPEED = 2 * Math.PI * 0.6
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Which vertices move, how much, and their rest pose. Built once per mesh. */
interface WingRig {
  vertices: Uint32Array
  /** Weight of the whole-wing flap, rising from the shoulder. */
  inner: Float32Array
  /** Weight of the extra outer-wing stroke. */
  outer: Float32Array
  /** +1 or -1: which side of the body. */
  side: Int8Array
  restPositions: Float32Array
  restNormals: Float32Array
}

function buildWingRig(mesh: SurfaceMesh): WingRig {
  const vertices: number[] = []
  const inner: number[] = []
  const outer: number[] = []
  const side: number[] = []
  for (let v = 0; v < mesh.parts.length; v++) {
    const part = mesh.parts[v]!
    if (part !== MEMBRANE && part !== WING) continue
    const z = mesh.positions[v * 3 + 2]!
    const w = smoothstep(10, 18, Math.abs(z))
    if (w === 0) continue
    vertices.push(v)
    inner.push(w)
    outer.push(smoothstep(26, 44, Math.abs(z)))
    side.push(z < 0 ? -1 : 1)
  }
  return {
    vertices: new Uint32Array(vertices),
    inner: new Float32Array(inner),
    outer: new Float32Array(outer),
    side: new Int8Array(side),
    restPositions: mesh.positions,
    restNormals: mesh.normals,
  }
}

/**
 * Rotates (x, y, z) around HINGE_AXIS by an angle (Rodrigues' formula), adds (tx, ty, tz)
 * and writes the result to out at o.
 */
function rotateInto(out: Float32Array, o: number, x: number, y: number, z: number, cos: number, sin: number, tx = 0, ty = 0, tz = 0) {
  const [ax, ay, az] = HINGE_AXIS
  const dot = (ax * x + ay * y + az * z) * (1 - cos)
  out[o] = x * cos + (ay * z - az * y) * sin + ax * dot + tx
  out[o + 1] = y * cos + (az * x - ax * z) * sin + ay * dot + ty
  out[o + 2] = z * cos + (ax * y - ay * x) * sin + az * dot + tz
}

const rigs = new Map<SurfaceMesh, WingRig>()
/** Links each generated (and therefore animatable) mesh to its rig. */
const meshRigs = new WeakMap<Mesh, WingRig>()

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
  // Beside the dragon rather than inside it.
  spawn: () => [10, 0, 70],

  generate(seed, detail) {
    const mesh = dragonMesh(detail)
    const palette = pick(mulberry32(seed), PALETTES)
    const body = linearRgb(palette.body)
    const belly = linearRgb(palette.belly)
    const byPart = [body, linearRgb(palette.membrane), linearRgb(palette.horn), linearRgb(palette.eye), body]

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

    let rig = rigs.get(mesh)
    if (!rig) {
      rig = buildWingRig(mesh)
      rigs.set(mesh, rig)
    }
    // Own copies of positions and normals: animate() writes into them every frame.
    const posed: Mesh = { positions: mesh.positions.slice(), normals: mesh.normals.slice(), colors, indices: mesh.indices, roughness: 0.8 }
    meshRigs.set(posed, rig)

    return {
      primitives: [],
      meshes: [posed],
      // Big enough that the floor's edge disappears into the fog.
      extent: 3000,
      summary: `${palette.name} dragon · ${(mesh.indices.length / 3).toLocaleString('en-US')} triangles`,
    }
  },

  animate(scene, time) {
    const mesh = scene.meshes?.[0]
    if (mesh) flapWings(mesh, time)
  },
}

/** Poses a mesh from dragon.generate() with its wings at `time` (seconds), in place. */
export function flapWings(mesh: Mesh, time: number) {
  const rig = meshRigs.get(mesh)
  if (!rig) return
  const { vertices, inner, outer, side, restPositions, restNormals } = rig
  // Positive angles swing the wings down. The whole wing beats around a slightly raised
  // middle; the outer part adds a delayed stroke on top, like a wave along the wing.
  const flap = 0.15 + 0.45 * Math.sin(time * FLAP_SPEED)
  const lag = 0.35 * Math.sin(time * FLAP_SPEED - 0.7)
  for (let k = 0; k < vertices.length; k++) {
    const o = vertices[k]! * 3
    const s = side[k]!
    const angle = s * (inner[k]! * flap + outer[k]! * lag)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // Rotate around the hinge: relative to the pivot for positions, as-is for normals.
    const [px, py] = HINGE_PIVOT
    const pz = HINGE_PIVOT[2] * s
    rotateInto(mesh.positions, o, restPositions[o]! - px, restPositions[o + 1]! - py, restPositions[o + 2]! - pz, cos, sin, px, py, pz)
    rotateInto(mesh.normals, o, restNormals[o]!, restNormals[o + 1]!, restNormals[o + 2]!, cos, sin)
  }
}
