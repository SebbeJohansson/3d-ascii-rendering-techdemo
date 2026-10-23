import type { CameraView } from '../lib/camera'
import type { Vec3 } from '../lib/math'

export type Shape = 'box' | 'cylinder' | 'cone' | 'sphere'

/**
 * One solid in an environment. Every shape is described by the box it fills: a footprint
 * centered on (x, z), standing on y, `width` × `depth` wide and `height` tall.
 * Cylinders and cones stand upright on a circle of diameter `width` (keep depth = width);
 * cones taper to a point at the top. Spheres are ellipsoids filling the box.
 */
export interface Primitive {
  shape: Shape
  x: number
  y: number
  z: number
  width: number
  depth: number
  height: number
  color: number
  /** Defaults to 1 (fully matte). */
  roughness?: number
  /** Defaults to 0. */
  metalness?: number
  /** Gets rows of windows that light up at night (see lib/windows.ts). */
  windows?: boolean
  /** What it is, shown when it is clicked: e.g. "Pine · 22 m". Parts of one thing share it. */
  label?: string
  /** A box dropped in by a click (see lib/boxes.ts), not part of the environment. */
  dropped?: boolean
  /** Part of a shape drawn in the panel (see lib/shapes.ts): its index among them. */
  drawn?: number
}

/**
 * A free-form triangle mesh, for shapes primitives can't express (like the dragon).
 * Rendered by three directly and by the ray tracer through a BVH.
 */
export interface Mesh {
  positions: Float32Array
  /** Unit normal per vertex, for smooth shading. */
  normals: Float32Array
  /** Linear-light r, g, b per vertex, in 0..1 (three's convention for vertex colors). */
  colors: Float32Array
  /** Three vertex indices per triangle. */
  indices: Uint32Array
  /** Defaults to 1 (fully matte). */
  roughness?: number
  /** Defaults to 0. */
  metalness?: number
  /** What it is, shown when it is clicked. */
  label?: string
  /** A shape drawn in the panel (see lib/shapes.ts): its index among them. */
  drawn?: number
}

export interface EnvironmentScene {
  primitives: Primitive[]
  meshes?: Mesh[]
  /** Side length of the square ground, centered on the origin. */
  extent: number
  /** Shown in the panel, e.g. "530 buildings". */
  summary: string
  /**
   * Height of the land at (x, z), for environments whose land isn't flat (islands). Players
   * stand on it. Defaults to the flat ground at y = 0.
   */
  groundHeight?: (x: number, z: number) => number
}

export interface Environment {
  id: string
  name: string
  sky: number
  ground: number
  /**
   * Makes the ground a calm sea: it reaches the horizon and mirrors the sky and everything
   * above it. This is how much it reflects looking straight down, 0..1; at grazing angles it
   * rises toward a full mirror (Fresnel).
   */
  reflectance?: number
  /** What the ground is, shown when it is clicked. Defaults to "Sea" with reflectance, else "Ground". */
  groundLabel?: string
  fogNear: number
  fogFar: number
  /** Where the camera starts. Defaults to an overview from above. */
  camera?: CameraView
  /** The size slider in the panel. */
  size: { min: number, max: number, default: number, label: (size: number) => string }
  generate: (seed: number, size: number) => EnvironmentScene
  /**
   * Where a spawned player appears, given the size and the current camera. Only x and z are
   * used. Defaults to the point the camera looks at.
   */
  spawn?: (size: number, view: CameraView) => Vec3
  /**
   * Makes the environment move. Called before every frame with a scene from generate() and
   * the time in seconds; it updates that scene's mesh positions and normals in place.
   * Renderers keep redrawing continuously for environments that have it.
   */
  animate?: (scene: EnvironmentScene, time: number) => void
}
