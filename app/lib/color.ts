import type { Vec3 } from './math'

/** 0xRRGGBB to r, g, b in 0..1 (still sRGB). */
export function hexToRgb(hex: number): Vec3 {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]
}

/** 0xRRGGBB to r, g, b in 0..255. */
export function hexToBytes(hex: number): Vec3 {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
}

export function hexToCss(hex: number) {
  return `#${hex.toString(16).padStart(6, '0')}`
}

export function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** 0xRRGGBB to linear-light r, g, b in 0..1, the space lighting is calculated in. */
export function linearRgb(hex: number): Vec3 {
  return hexToRgb(hex).map(srgbToLinear) as Vec3
}

// Linear 0..1 to sRGB 0..255, via a table: a pow() per channel per cell adds up at 100k cells.
const SRGB_STEPS = 4096
const SRGB_TABLE = new Uint8Array(SRGB_STEPS + 1).map((_, i) => {
  const c = i / SRGB_STEPS
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055))
})

export function linearToSrgbByte(c: number) {
  return SRGB_TABLE[Math.round(Math.min(1, Math.max(0, c)) * SRGB_STEPS)]!
}
