/**
 * Shapes drawn in the panel and placed into an environment by clicking it, three ways:
 *
 * - Spin: half an outline (a profile) spun around an upright axis into a vase, bottle or tower.
 * - Extrude: cells painted on a grid, pulled up into a solid: walls, letters, logos. Made of
 *   boxes, so players bump into it and dropped boxes land on it.
 * - Blobs: spheres that melt into each other, meshed from a blended SDF with surface nets,
 *   like the dragon.
 *
 * Spun shapes and blobs are triangle meshes added on top of the generated scene, the way
 * dropped boxes are added as primitives.
 */
import type { EnvironmentScene, Mesh, Primitive } from '../environments/types'
import { linearRgb } from './color'
import type { DropSpot } from './boxes'
import type { Vec3 } from './math'
import type { Camera } from './raycaster'
import type { SdfShape } from './sdf'
import { polygonize } from './surfaceNets'

export type DrawTool = 'spin' | 'extrude' | 'blobs'
export const DRAW_TOOLS: DrawTool[] = ['spin', 'extrude', 'blobs']

/** Cells per side of the extrude grid. */
export const GRID = 16

/** The profile drawn to start with: a vase. */
export const DEFAULT_PROFILE: [number, number][] = [[0.16, 0], [0.28, 0.12], [0.33, 0.32], [0.26, 0.58], [0.14, 0.78], [0.13, 0.9], [0.2, 1]]

/** The cells drawn to start with: a heart. */
export const DEFAULT_CELLS = [
  '................',
  '................',
  '..XXXX....XXXX..',
  '.XXXXXX..XXXXXX.',
  'XXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXX',
  '.XXXXXXXXXXXXXX.',
  '..XXXXXXXXXXXX..',
  '...XXXXXXXXXX...',
  '....XXXXXXXX....',
  '.....XXXXXX.....',
  '......XXXX......',
  '.......XX.......',
  '................',
  '................',
].flatMap((row, r) => [...row].flatMap((c, col) => (c === 'X' ? [r * GRID + col] : [])))

/**
 * What is drawn in the panel. The profile is [r, h] points, r out from the axis in 0..0.5 and
 * h up in 0..1, both times the size. Cells are indices row * GRID + column, row 0 at the top.
 */
export interface Drawing {
  profile: [number, number][]
  cells: number[]
  /** Height of a spun shape, width of an extruded one, diameter of a blob: m. */
  size: number
  /** How far an extruded shape is pulled up, m. */
  height: number
}

export type DrawnShape =
  | { kind: 'spin', x: number, y: number, z: number, size: number, profile: [number, number][], color: number }
  /** `forward` is the world direction, x and z, the top of the grid points to. */
  | { kind: 'extrude', x: number, y: number, z: number, size: number, height: number, cells: number[], forward: [number, number], color: number }
  | { kind: 'blob', x: number, y: number, z: number, radius: number, color: number }

export const COLORS = [0xe74c3c, 0xf39c12, 0xf1c40f, 0x2ecc71, 0x1abc9c, 0x3498db, 0x9b59b6, 0xecf0f1]

/** Space left between a shape and the wall it was placed against. */
const GAP = 0.01
/** Segments around a spun shape. */
const SEGMENTS = 40
/** Profile corners sharper than this (between segment normals) stay sharp; gentler ones are smoothed. */
const SMOOTH_ANGLE = Math.cos((40 * Math.PI) / 180)
/** How far apart blobs blend, as a share of their mean radius. */
const BLOB_SMOOTHING = 0.8
/** Blob meshes are sampled at no more than this many cells across, however far apart the blobs are. */
const MAX_BLOB_CELLS = 140

/** Whether the drawing has enough in it for the tool to place something. */
export function canPlace(tool: DrawTool, drawing: Drawing) {
  if (tool === 'spin') return drawing.profile.length >= 2 && drawing.profile.some(([r]) => r > 0.01)
  if (tool === 'extrude') return drawing.cells.length > 0
  return true
}

/** The filled cells' bounding rectangle, in columns and rows. */
function cellBounds(cells: readonly number[]) {
  let c0 = GRID
  let c1 = -1
  let r0 = GRID
  let r1 = -1
  for (const i of cells) {
    const c = i % GRID
    const r = Math.floor(i / GRID)
    c0 = Math.min(c0, c)
    c1 = Math.max(c1, c)
    r0 = Math.min(r0, r)
    r1 = Math.max(r1, r)
  }
  return { c0, c1, r0, r1 }
}

/** Half the shape's footprint along x and z, and its height, as it would be placed. */
function extent(tool: DrawTool, drawing: Drawing, forward: [number, number]) {
  if (tool === 'spin') {
    const r = Math.max(...drawing.profile.map(([r]) => r)) * drawing.size
    const hs = drawing.profile.map(([, h]) => h)
    return { hx: r, hz: r, height: (Math.max(...hs) - Math.min(...hs)) * drawing.size }
  }
  if (tool === 'extrude') {
    const { c0, c1, r0, r1 } = cellBounds(drawing.cells)
    const cell = drawing.size / GRID
    const across = ((c1 - c0 + 1) * cell) / 2
    const along = ((r1 - r0 + 1) * cell) / 2
    return forward[0] ? { hx: along, hz: across, height: drawing.height } : { hx: across, hz: along, height: drawing.height }
  }
  const r = drawing.size / 2
  return { hx: r, hz: r, height: r * 2 }
}

/** The ground direction, x and z, closest to where the camera looks. */
function cameraForward(camera: Camera): [number, number] {
  const fx = camera.target[0] - camera.position[0]
  const fz = camera.target[2] - camera.position[2]
  return Math.abs(fx) > Math.abs(fz) ? [Math.sign(fx) || 1, 0] : [0, Math.sign(fz) || 1]
}

/**
 * The shape the drawing makes at a clicked spot, like a dropped box: on top of a roof, under a
 * ceiling, or on the floor against a wall on the side clicked. A blob sinks halfway into what
 * was clicked, so blobs clicked onto blobs melt into them. An extruded shape is turned so the
 * top of the grid points away from the camera, as drawn.
 */
export function placeShape(tool: DrawTool, drawing: Drawing, spot: DropSpot, camera: Camera, color: number): DrawnShape | undefined {
  if (!canPlace(tool, drawing)) return
  const [px, py, pz] = spot.point
  const [nx, ny, nz] = spot.normal
  if (tool === 'blobs') {
    const radius = drawing.size / 2
    return { kind: 'blob', x: px + nx * radius * 0.5, y: py + ny * radius * 0.5, z: pz + nz * radius * 0.5, radius, color }
  }
  const forward = cameraForward(camera)
  const { hx, hz, height } = extent(tool, drawing, forward)
  let x = px
  let y = py
  let z = pz
  if (ny <= -0.5) y -= height
  else if (ny < 0.5) {
    if (Math.abs(nx) > Math.abs(nz)) x += Math.sign(nx) * (hx + GAP)
    else z += Math.sign(nz) * (hz + GAP)
    y = spot.floor
  }
  if (tool === 'spin') {
    // Standing on its lowest point, wherever on the pad it was drawn.
    const bottom = Math.min(...drawing.profile.map(([, h]) => h))
    return { kind: 'spin', x, y, z, size: drawing.size, profile: drawing.profile.map(([r, h]) => [r, h - bottom]), color }
  }
  return { kind: 'extrude', x, y, z, size: drawing.size, height: drawing.height, cells: drawing.cells, forward, color }
}

/** The box a shape fills, for outlining where a click would place it. */
export function shapeBounds(shape: DrawnShape): Primitive {
  const { x, y, z, color } = shape
  if (shape.kind === 'blob') {
    const d = shape.radius * 2
    return { shape: 'box', x, y: y - shape.radius, z, width: d, depth: d, height: d, color }
  }
  const drawing = { profile: [], cells: [], height: 0, ...shape }
  const { hx, hz, height } = extent(shape.kind, drawing, shape.kind === 'extrude' ? shape.forward : [0, 1])
  return { shape: 'box', x, y, z, width: hx * 2, depth: hz * 2, height, color }
}

/** One color per vertex, linear, for a mesh of `count` vertices. */
function solidColors(count: number, color: number) {
  const rgb = linearRgb(color)
  const colors = new Float32Array(count * 3)
  for (let v = 0; v < count; v++) colors.set(rgb, v * 3)
  return colors
}

/**
 * The surface a profile sweeps out spun around its shape's axis. Each profile segment gets
 * rings of its own, so sharp corners (a rim, a flat bottom) stay sharp; at gentle bends the
 * normals are shared, so curves look smooth. Ends off the axis are closed with flat caps.
 */
export function spinMesh(shape: Extract<DrawnShape, { kind: 'spin' }>, drawn: number): Mesh {
  let points = shape.profile.map(([r, h]) => [Math.max(0, r) * shape.size, h * shape.size] as [number, number])
  points = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1]![0], p[1] - points[i - 1]![1]) > 1e-4)
  // Closed against the axis, the outline should run counterclockwise in (r, h), so that
  // (dh, -dr) along it points outward.
  const closed: [number, number][] = [...points, [0, points.at(-1)![1]], [0, points[0]![1]]]
  let area = 0
  for (let i = 0; i < closed.length; i++) {
    const a = closed[i]!
    const b = closed[(i + 1) % closed.length]!
    area += a[0] * b[1] - b[0] * a[1]
  }
  if (area < 0) points.reverse()
  if (points[0]![0] > 1e-4) points.unshift([0, points[0]![1]])
  if (points.at(-1)![0] > 1e-4) points.push([0, points.at(-1)![1]])

  const normals2d = points.slice(1).map((b, i) => {
    const a = points[i]!
    const dr = b[0] - a[0]
    const dh = b[1] - a[1]
    const l = Math.hypot(dr, dh)
    return [dh / l, -dr / l] as [number, number]
  })
  /** Segment `s`'s normal at its end `end` (0 or 1), smoothed with the next segment's at a gentle bend. */
  const endNormal = (s: number, end: 0 | 1): [number, number] => {
    const n = normals2d[s]!
    const m = normals2d[s + (end ? 1 : -1)]
    if (!m || n[0] * m[0] + n[1] * m[1] < SMOOTH_ANGLE) return n
    const l = Math.hypot(n[0] + m[0], n[1] + m[1])
    return [(n[0] + m[0]) / l, (n[1] + m[1]) / l]
  }

  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const ring = (r: number, h: number, [nr, nh]: [number, number]) => {
    const first = positions.length / 3
    for (let j = 0; j < SEGMENTS; j++) {
      const angle = (j / SEGMENTS) * Math.PI * 2
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      positions.push(shape.x + r * cos, shape.y + h, shape.z + r * sin)
      normals.push(nr * cos, nh, nr * sin)
    }
    return first
  }
  const triangle = (a: number, b: number, c: number) => {
    // Wound to face the way its vertex normals point.
    const p = (v: number, k: number) => positions[v * 3 + k]!
    const u = [0, 1, 2].map(k => p(b, k) - p(a, k))
    const w = [0, 1, 2].map(k => p(c, k) - p(a, k))
    const f = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
    let facing = 0
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) facing += f[k]! * normals[v * 3 + k]!
    if (facing >= 0) indices.push(a, b, c)
    else indices.push(a, c, b)
  }
  normals2d.forEach((_, s) => {
    const [ra, ha] = points[s]!
    const [rb, hb] = points[s + 1]!
    const a = ring(ra, ha, endNormal(s, 0))
    const b = ring(rb, hb, endNormal(s, 1))
    for (let j = 0; j < SEGMENTS; j++) {
      const k = (j + 1) % SEGMENTS
      // A ring on the axis is one point: one triangle per step, not two.
      if (ra > 1e-4) triangle(a + j, a + k, b + j)
      if (rb > 1e-4) triangle(a + k, b + k, b + j)
    }
  })

  const count = positions.length / 3
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: solidColors(count, shape.color),
    indices: new Uint32Array(indices),
    roughness: 0.6,
    label: `Spun shape · ${Math.round(Math.max(...points.map(([, h]) => h)) - Math.min(...points.map(([, h]) => h)))} m tall`,
    drawn,
  }
}

/**
 * An extruded shape as boxes: each row's runs of cells, merged with the runs below them that
 * span the same columns, so a solid block is one box.
 */
export function extrudeBoxes(shape: Extract<DrawnShape, { kind: 'extrude' }>, drawn: number): Primitive[] {
  const filled = new Set(shape.cells)
  const { c0, c1, r0, r1 } = cellBounds(shape.cells)
  const cell = shape.size / GRID
  // Rectangles of cells: column from..to, row from..to.
  const rects: { c: number, c2: number, r: number, r2: number }[] = []
  let open: typeof rects = []
  for (let r = r0; r <= r1; r++) {
    const runs: [number, number][] = []
    for (let c = c0; c <= c1; c++) {
      if (!filled.has(r * GRID + c)) continue
      if (runs.at(-1)?.[1] === c - 1) runs.at(-1)![1] = c
      else runs.push([c, c])
    }
    const next: typeof rects = []
    for (const [c, c2] of runs) {
      const above = open.find(o => o.c === c && o.c2 === c2)
      if (above) {
        above.r2 = r
        next.push(above)
      }
      else {
        const rect = { c, c2, r, r2: r }
        rects.push(rect)
        next.push(rect)
      }
    }
    open = next
  }

  // Grid coordinates, centered on the filled cells, to the world: columns run to the right of
  // `forward`, rows against it.
  const [fx, fz] = shape.forward
  const midC = (c0 + c1 + 1) / 2
  const midR = (r0 + r1 + 1) / 2
  const w = (c1 - c0 + 1) * cell
  const d = (r1 - r0 + 1) * cell
  const label = `Extruded shape · ${+(fx ? d : w).toFixed(1)} × ${+(fx ? w : d).toFixed(1)} × ${+shape.height.toFixed(1)} m`
  return rects.map(({ c, c2, r, r2 }) => {
    const across = ((c + c2 + 1) / 2 - midC) * cell
    const along = (midR - (r + r2 + 1) / 2) * cell
    const cols = (c2 - c + 1) * cell
    const rows = (r2 - r + 1) * cell
    return {
      shape: 'box',
      // Right of forward is (-fz, fx).
      x: shape.x + across * -fz + along * fx,
      y: shape.y,
      z: shape.z + across * fx + along * fz,
      width: fx ? rows : cols,
      depth: fx ? cols : rows,
      height: shape.height,
      color: shape.color,
      roughness: 0.7,
      label,
      drawn,
    }
  })
}

/** A sphere's exact distance field. */
function sphere([cx, cy, cz]: Vec3, r: number, part: number): SdfShape {
  return {
    min: [cx - r, cy - r, cz - r],
    max: [cx + r, cy + r, cz + r],
    part,
    distance: (x, y, z) => Math.hypot(x - cx, y - cy, z - cz) - r,
  }
}

/**
 * Every blob melted into one mesh, each part colored as the blob nearest it. `drawn` is the
 * index of each blob among the drawn shapes.
 */
export function blobMesh(blobs: Extract<DrawnShape, { kind: 'blob' }>[], drawn: number[]): Mesh {
  const shapes = blobs.map((b, i) => sphere([b.x, b.y, b.z], b.radius, i % 256))
  const radii = blobs.map(b => b.radius)
  const smoothing = (BLOB_SMOOTHING * radii.reduce((a, b) => a + b, 0)) / radii.length
  const span = Math.max(...[0, 1, 2].map(k => Math.max(...shapes.map(s => s.max[k]!)) - Math.min(...shapes.map(s => s.min[k]!)))) + smoothing * 2
  const voxel = Math.max(Math.min(...radii) / 5, span / MAX_BLOB_CELLS)
  const mesh = polygonize(shapes, voxel, smoothing)
  const colors = new Float32Array(mesh.positions.length)
  const byPart = blobs.slice(0, 256).map(b => linearRgb(b.color))
  for (let v = 0; v < mesh.parts.length; v++) colors.set(byPart[mesh.parts[v]!]!, v * 3)
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    colors,
    indices: mesh.indices,
    roughness: 0.5,
    label: `Blob sculpture · ${blobs.length} ${blobs.length === 1 ? 'blob' : 'blobs'}`,
    drawn: drawn[0],
  }
}

/** The meshes of the drawn shapes: one per spun shape, then all blobs as one. */
export function shapeMeshes(shapes: readonly DrawnShape[]): Mesh[] {
  const meshes: Mesh[] = []
  const blobs: Extract<DrawnShape, { kind: 'blob' }>[] = []
  const blobIndices: number[] = []
  shapes.forEach((s, i) => {
    if (s.kind === 'spin') meshes.push(spinMesh(s, i))
    else if (s.kind === 'blob') {
      blobs.push(s)
      blobIndices.push(i)
    }
  })
  if (blobs.length) meshes.push(blobMesh(blobs, blobIndices))
  return meshes
}

/** The boxes of the drawn shapes: those of every extruded one. */
export function shapeBoxes(shapes: readonly DrawnShape[]): Primitive[] {
  return shapes.flatMap((s, i) => (s.kind === 'extrude' ? extrudeBoxes(s, i) : []))
}

/**
 * The shapes without the one a click landed on: `drawn` is what the click hit
 * (Mesh.drawn or Primitive.drawn). A click on the blob sculpture takes out the blob nearest
 * to where it landed.
 */
export function removeShape(shapes: readonly DrawnShape[], drawn: number, point: Vec3): DrawnShape[] {
  let i = drawn
  if (shapes[i]?.kind === 'blob') {
    let best = Infinity
    shapes.forEach((s, j) => {
      if (s.kind !== 'blob') return
      const d = Math.hypot(s.x - point[0], s.y - point[1], s.z - point[2]) - s.radius
      if (d < best) {
        best = d
        i = j
      }
    })
  }
  return shapes.filter((_, j) => j !== i)
}

/** Drawn shapes in a scene: one per spun or extruded shape, one for all the blobs. */
function countShapes(scene: EnvironmentScene) {
  const drawn = new Set<number>()
  for (const p of scene.primitives) if (p.drawn !== undefined) drawn.add(p.drawn)
  for (const m of scene.meshes ?? []) if (m.drawn !== undefined) drawn.add(m.drawn)
  return drawn.size
}

/** The scene with the drawn shapes' meshes added; their boxes come with the dropped boxes. */
export function withShapes(scene: EnvironmentScene, meshes: readonly Mesh[]): EnvironmentScene {
  const next = meshes.length ? { ...scene, meshes: [...(scene.meshes ?? []), ...meshes] } : scene
  const count = countShapes(next)
  if (!count) return next
  return { ...next, summary: `${scene.summary} · ${count} drawn ${count === 1 ? 'shape' : 'shapes'}` }
}
