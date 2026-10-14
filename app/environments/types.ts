export type Shape = 'box'

/**
 * One solid in an environment, described by the box it fills: a footprint centered on
 * (x, z), standing on y, `width` × `depth` wide and `height` tall.
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

export interface EnvironmentScene {
  primitives: Primitive[]
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
  /** The size slider in the panel. */
  size: { min: number, max: number, default: number, label: (size: number) => string }
  generate: (seed: number, size: number) => EnvironmentScene
}
