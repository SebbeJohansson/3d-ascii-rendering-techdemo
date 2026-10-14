// Lighting shared by every environment and both renderers, so the ASCII ray tracer
// can reproduce the 3D view's shading.
import type { Vec3 } from '../lib/math'

export const SUN_COLOR = 0xfff4e0
export const SUN_INTENSITY = 2.4
export const SUN_POSITION: Vec3 = [300, 500, 200]
export const HEMI_SKY_COLOR = 0xdfefff
export const HEMI_GROUND_COLOR = 0x5a5040
export const HEMI_INTENSITY = 1.2
