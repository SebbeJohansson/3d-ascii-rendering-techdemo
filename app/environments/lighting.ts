// Lighting shared by every environment and both renderers, so the ASCII ray tracer
// can reproduce the 3D view's shading.
import type { Vec3 } from '../lib/math'

export const SUN_COLOR = 0xfff4e0
export const SUN_INTENSITY = 2.4
/** Where the sun is at noon. */
export const SUN_POSITION: Vec3 = [300, 500, 200]
export const HEMI_SKY_COLOR = 0xdfefff
export const HEMI_GROUND_COLOR = 0x5a5040
export const HEMI_INTENSITY = 1.2

/** Time of day as a share of 24 hours: 0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
export const NOON = 0.5
/** Seconds for a full day and night while cycling. */
export const DAY_LENGTH = 120

/** The light at one time of day. */
export interface Lighting {
  /** Unit vector toward the one light that casts shadows: the sun by day, the moon by night. */
  direction: Vec3
  color: number
  intensity: number
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  /** Sky and fog color. */
  sky: number
  /** 0 by day up to 1 at night: how brightly windows glow. */
  night: number
}

const LOW_SUN_COLOR = 0xff9e5e
const MOON_COLOR = 0xa9bcff
const MOON_INTENSITY = 0.5
const NIGHT_SKY = 0x0b1230
const TWILIGHT_SKY = 0xf2a16b
const NIGHT_HEMI_SKY = 0x26355e
const NIGHT_HEMI_GROUND = 0x15141a
const NIGHT_HEMI_INTENSITY = 0.35

const NOON_SUN = (() => {
  const l = Math.hypot(...SUN_POSITION)
  return { elevation: Math.asin(SUN_POSITION[1] / l), azimuth: Math.atan2(SUN_POSITION[2], SUN_POSITION[0]) }
})()

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Blends two 0xRRGGBB colors, k = 0 → a, 1 → b. */
function mix(a: number, b: number, k: number) {
  let out = 0
  for (const shift of [16, 8, 0]) {
    const ca = (a >> shift) & 255
    const cb = (b >> shift) & 255
    out |= Math.round(ca + (cb - ca) * k) << shift
  }
  return out
}

/**
 * The light at time of day `t` (see NOON), for an environment whose daytime sky is `daySky`.
 * At noon this is exactly the fixed lighting the scenes were made with.
 */
export function lightingAt(t: number, daySky: number): Lighting {
  // How high the sun is: 1 at noon, 0 at sunrise and sunset, -1 at midnight. It swings
  // half way round the sky over the day, from the east in the morning to the west at dusk.
  const height = Math.sin(2 * Math.PI * (t - 0.25))
  const elevation = height * NOON_SUN.elevation
  const azimuth = NOON_SUN.azimuth + (t - NOON) * Math.PI
  const sun: Vec3 = [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)]
  const up = height > 0

  // How far from night to day the ambient light and sky are, and how near the horizon the sun is.
  const day = smoothstep(-0.25, 0.25, height)
  const twilight = Math.exp(-((height / 0.15) ** 2))
  return {
    // Below the horizon, the moon stands opposite the sun.
    direction: up ? sun : [-sun[0], -sun[1], -sun[2]],
    color: up ? mix(LOW_SUN_COLOR, SUN_COLOR, smoothstep(0, 0.5, height)) : MOON_COLOR,
    intensity: up ? SUN_INTENSITY * smoothstep(-0.05, 0.3, height) : MOON_INTENSITY * smoothstep(0.05, -0.3, height),
    hemiSky: mix(NIGHT_HEMI_SKY, HEMI_SKY_COLOR, day),
    hemiGround: mix(NIGHT_HEMI_GROUND, HEMI_GROUND_COLOR, day),
    hemiIntensity: NIGHT_HEMI_INTENSITY + (HEMI_INTENSITY - NIGHT_HEMI_INTENSITY) * day,
    sky: mix(mix(NIGHT_SKY, daySky, day), TWILIGHT_SKY, twilight * 0.55),
    night: 1 - smoothstep(-0.15, 0.1, height),
  }
}

/** "06:30" for t = 0.2708. */
export function formatTimeOfDay(t: number) {
  const minutes = Math.round((((t % 1) + 1) % 1) * 24 * 60) % (24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
