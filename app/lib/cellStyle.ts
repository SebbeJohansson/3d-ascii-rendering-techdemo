/**
 * Decides what each traced cell looks like: which character, in which colors. Shared by the
 * browser's canvas renderer (glyphRenderer.ts) and the terminal version (cli/), so both pick
 * the same characters.
 */
import { findOutlines, OUTLINE_CHARS } from './outlines'

// Shading ramps, sparse to dense, each step a denser version of the one before so neighboring
// cells never clash. The first character is a space so the sky stays blank. A cell's surface
// picks the ramp: strokes that lie along it read as that surface.
/** Slopes and roofs, and the shader view, which has no normals. */
export const RAMP = ' .:-=+*#%@'
/** Faces up (sea, flat ground): horizontal strokes. */
const FLAT_RAMP = ' .-~=+*#'
/** Near vertical (walls, cliffs): vertical strokes. */
const STEEP_RAMP = ' .:!|I#'
const RAMPS = [RAMP, FLAT_RAMP, STEEP_RAMP]
/** Each shading character once. */
const SHADES = [...new Set(RAMPS.join(''))].join('')
/** Every character a cell can get: the shading characters, then the outline characters. */
export const GLYPHS = SHADES + OUTLINE_CHARS
/** Glyph of outline code 1 (see outlines.ts). */
export const OUTLINE_GLYPH = SHADES.length
/** RAMPS back to back as GLYPHS indices, with where each starts and how long it is, for the shaders. */
export const RAMP_GLYPHS = RAMPS.flatMap(ramp => [...ramp].map(c => SHADES.indexOf(c)))
export const RAMP_STARTS = RAMPS.map((_, k) => RAMPS.slice(0, k).join('').length)
export const RAMP_LENGTHS = RAMPS.map(ramp => ramp.length)
/** Normals are ×127: a surface with |ny| at least FLAT_NY faces up (~0.85), at most STEEP_NY is steep (~0.35). */
export const FLAT_NY = 108
export const STEEP_NY = 44

/** Which of RAMPS a surface with this normal y (×127) is drawn with. */
export function rampFor(ny: number) {
  const up = Math.abs(ny)
  return up >= FLAT_NY ? 1 : up <= STEEP_NY ? 2 : 0
}

/**
 * 4×4 ordered dither. Flat surfaces like the sea change ink slowly, so without dither a whole
 * row switches character at once and shows a wide band; with it, the two characters either
 * side of the switch interleave in a regular pattern instead of random speckle.
 */
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/**
 * Step of a ramp `length` long for ink v (1..255) at cell (x, y): v's share of the ramp, moved
 * by the cell's Bayer value by up to half a step either way. Integer math throughout, so
 * glyphGl.ts and gpu/glyphs.wgsl.ts get exactly the same steps. Never 0: dither never turns a
 * cell into sky.
 */
export function rampStep(v: number, length: number, x: number, y: number) {
  const b = BAYER[(y & 3) * 4 + (x & 3)]!
  const n = Math.max(0, 32 * v * length + (2 * b - 15) * 255)
  return Math.min(length - 1, Math.max(1, Math.floor(n / 8160)))
}

// Dark ink for the single-color mode: readable on a light sky.
export const MONO: [number, number, number] = [0x1D, 0x2B, 0x38]

export interface StyleOptions {
  /** Characters in their surface color; otherwise dark mono ink. */
  color: boolean
  /** Fill each cell with its surface color and draw the character in a shade of it. */
  cellBackground: boolean
  /** Stretch this frame's ink range over the whole ramp, so every frame uses all characters. */
  stretch: boolean
  /** Draw edges as line characters (see outlines.ts). */
  outlines: boolean
  /** The environment's fog range: outlines fade out with distance like everything else. */
  fogNear: number
  fogFar: number
}

/** What the tracer produced for one frame. */
export interface Cells {
  ink: Uint8Array
  rgb: Uint8Array
  depths: Float32Array
  normals: Int8Array
}

/** Outlines further into the fog than this (0 = fully fogged) aren't drawn. */
export const MIN_OUTLINE_STRENGTH = 0.15

/**
 * Line color for an outline: well darker than a light surface, well lighter than a dark one,
 * eased back toward the surface color as it fades into the fog (strength 1 → 0).
 */
function outlineShade(c: number, lightSurface: boolean, strength: number) {
  return lightSurface ? (c * (1 - 0.7 * strength)) | 0 : (c + (255 - c) * 0.5 * strength) | 0
}

/**
 * The character's own color when cells have a background: a darker shade on light surfaces,
 * a lighter one on dark surfaces, so the glyph stays visible against its cell. `strength`
 * (0..1) scales how far the shade moves from the surface color.
 */
function glyphShade(c: number, lightSurface: boolean, strength: number) {
  return lightSurface ? (c * (1 - 0.4 * strength)) | 0 : (c + (255 - c) * 0.35 * strength) | 0
}

function isLight(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 100
}

/**
 * Picks each cell's glyph (index into GLYPHS) and, for outline cells, the outline's strength.
 * Cells with glyph 0 are left as sky. `edges` is scratch space, one byte per cell.
 */
export function pickGlyphs(cells: Cells, cols: number, rows: number, options: StyleOptions, glyphs: Uint8Array, edgeStrength: Float32Array, edges: Uint8Array) {
  const { ink, depths, normals } = cells
  const inkFor = inkTable(ink, options.stretch)
  for (let y = 0, i = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++, i++) {
      const v = inkFor[ink[i]!]!
      if (!v) {
        glyphs[i] = 0
        continue
      }
      const k = rampFor(normals[i * 3 + 1]!)
      glyphs[i] = RAMP_GLYPHS[RAMP_STARTS[k]! + rampStep(v, RAMP_LENGTHS[k]!, x, y)]!
    }
  }
  edgeStrength.fill(0)
  if (!options.outlines) return
  findOutlines(cols, rows, depths, normals, edges)
  const { fogNear, fogFar } = options
  for (let i = 0; i < edges.length; i++) {
    if (!edges[i]) continue
    const strength = 1 - Math.min(1, Math.max(0, (depths[i]! - fogNear) / (fogFar - fogNear)))
    if (strength < MIN_OUTLINE_STRENGTH) continue
    glyphs[i] = OUTLINE_GLYPH + edges[i]! - 1
    edgeStrength[i] = strength
  }
}

// Share of cells ignored at each end when stretching, so a few outliers don't set the range.
const STRETCH_CLIP = 0.01
const SAME_INK = new Uint8Array(256).map((_, v) => v)

/**
 * Ink to the ink the ramps see, for one frame. Without stretching it is unchanged; with it,
 * the frame's ink range (from a histogram, ignoring the outer 1%) maps onto 1..255.
 * Ink 0 stays 0: those cells hit nothing.
 */
function inkTable(ink: Uint8Array, stretch: boolean) {
  if (!stretch) return SAME_INK
  const histogram = new Uint32Array(256)
  for (let i = 0; i < ink.length; i++) histogram[ink[i]!]!++
  const total = ink.length - histogram[0]!
  if (!total) return SAME_INK

  const clip = total * STRETCH_CLIP
  let low = 1
  for (let seen = histogram[1]!; seen <= clip && low < 255; seen += histogram[++low]!);
  let high = 255
  for (let seen = histogram[255]!; seen <= clip && high > low; seen += histogram[--high]!);

  const table = new Uint8Array(256)
  for (let v = 1; v < 256; v++) {
    const k = high > low ? Math.min(1, Math.max(0, (v - low) / (high - low))) : 1
    table[v] = 1 + Math.round(k * 254)
  }
  return table
}

/**
 * Foreground and background color of cell i, written to `out` as fg r, g, b, bg r, g, b.
 * Without cell backgrounds the background is the sky. `shade` (0..1) is how strongly glyphs
 * stand out from their own cell's background.
 */
export function cellColors(rgb: Uint8Array, i: number, edge: number, { color, cellBackground }: Pick<StyleOptions, 'color' | 'cellBackground'>, shade: number, sky: readonly number[], out: Uint8Array | number[]) {
  const backgrounds = color && cellBackground
  const r = color ? rgb[i * 3]! : MONO[0]
  const g = color ? rgb[i * 3 + 1]! : MONO[1]
  const b = color ? rgb[i * 3 + 2]! : MONO[2]
  out[3] = backgrounds ? r : sky[0]!
  out[4] = backgrounds ? g : sky[1]!
  out[5] = backgrounds ? b : sky[2]!
  if (edge && color) {
    const light = isLight(r, g, b)
    out[0] = outlineShade(r, light, edge)
    out[1] = outlineShade(g, light, edge)
    out[2] = outlineShade(b, light, edge)
  }
  else if (backgrounds) {
    const light = isLight(r, g, b)
    out[0] = glyphShade(r, light, shade)
    out[1] = glyphShade(g, light, shade)
    out[2] = glyphShade(b, light, shade)
  }
  else {
    out[0] = r
    out[1] = g
    out[2] = b
  }
}
