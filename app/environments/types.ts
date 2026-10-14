import type { CameraView } from '../lib/camera'

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
}

export interface EnvironmentScene {
  primitives: Primitive[]
  meshes?: Mesh[]
  /** Side length of the square ground, centered on the origin. */
  extent: number
  /** Shown in the panel, e.g. "530 buildings". */
  summary: string
}

export interface Environment {
  id: string
  name: string
  sky: number
  ground: number
  fogNear: number
  fogFar: number
  /** Where the camera starts. Defaults to an overview from above. */
  camera?: CameraView
  /** The size slider in the panel. */
  size: { min: number, max: number, default: number, label: (size: number) => string }
  generate: (seed: number, size: number) => EnvironmentScene
  /**
   * Makes the environment move. Called before every frame with a scene from generate() and
   * the time in seconds; it updates that scene's mesh positions and normals in place.
   * Renderers keep redrawing continuously for environments that have it.
   */
  animate?: (scene: EnvironmentScene, time: number) => void
}
