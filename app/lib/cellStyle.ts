/**
 * Decides what each traced cell looks like: which character, in which colors. Shared by the
 * browser's canvas renderer (glyphRenderer.ts) and the terminal version (cli/), so both pick
 * the same characters.
 */
import { findOutlines, OUTLINE_CHARS } from './outlines'

// Sparse to dense. The first character is a space so the sky stays blank.
export const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'
/** Every character a cell can get: the ramp, then the outline characters. */
export const GLYPHS = RAMP + OUTLINE_CHARS
// Ink (0..255) to ramp index, so the draw loops do one table lookup per cell.
const GLYPH = new Uint8Array(256).map((_, v) => Math.min(RAMP.length - 1, Math.floor((v / 255) * RAMP.length)))
/** One ramp step in ink. */
export const DITHER_STEP = 255 / RAMP.length

/**
 * Ink offset for cell (x, y), up to half a ramp step either way. Flat surfaces like the sea
 * change ink slowly, so without it a whole row switches character at once and the sea shows
 * wide bands; with it, neighboring cells cross to the next character at different points.
 * The noise is an integer hash of the cell, so glyphGl.ts and gpu/glyphs.wgsl.ts get exactly
 * the same offsets; smooth noise formulas left visible diagonal patterns on the coarse grid.
 */
export function dither(x: number, y: number) {
  let h = (Math.imul(x, 0x27D4EB2D) ^ Math.imul(y, 0x165667B1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D) >>> 0
  h = (h ^ (h >>> 12)) >>> 0
  return Math.floor(((h & 0xFFFF) / 65536 - 0.5) * DITHER_STEP + 0.5)
}

/** dither() for every cell of the last grid size asked for. */
let ditherGrid = { cols: 0, rows: 0, offsets: new Int8Array(0) }
function ditherOffsets(cols: number, rows: number) {
  if (ditherGrid.cols !== cols || ditherGrid.rows !== rows) {
    const offsets = new Int8Array(cols * rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) offsets[y * cols + x] = dither(x, y)
    ditherGrid = { cols, rows, offsets }
  }
  return ditherGrid.offsets
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
  const { ink, depths } = cells
  const glyphFor = glyphTable(ink, options.stretch)
  const offsets = ditherOffsets(cols, rows)
  for (let i = 0; i < ink.length; i++) {
    const v = ink[i]!
    // Cells that hit something keep a character: dithering never turns one into sky.
    glyphs[i] = glyphFor[v]! && Math.max(1, glyphFor[Math.min(255, Math.max(1, v + offsets[i]!))]!)
  }
  edgeStrength.fill(0)
  if (!options.outlines) return
  findOutlines(cols, rows, depths, cells.normals, edges)
  const { fogNear, fogFar } = options
  for (let i = 0; i < edges.length; i++) {
    if (!edges[i]) continue
    const strength = 1 - Math.min(1, Math.max(0, (depths[i]! - fogNear) / (fogFar - fogNear)))
    if (strength < MIN_OUTLINE_STRENGTH) continue
    glyphs[i] = RAMP.length + edges[i]! - 1
    edgeStrength[i] = strength
  }
}

// Share of cells ignored at each end when stretching, so a few outliers don't set the range.
const STRETCH_CLIP = 0.01

/**
 * Ink to ramp index for one frame. Without stretching it is the fixed GLYPH table; with it,
 * the frame's ink range (from a histogram, ignoring the outer 1%) maps onto the whole ramp.
 * Ink 0 stays 0: those cells hit nothing.
 */
function glyphTable(ink: Uint8Array, stretch: boolean) {
  if (!stretch) return GLYPH
  const histogram = new Uint32Array(256)
  for (let i = 0; i < ink.length; i++) histogram[ink[i]!]!++
  const total = ink.length - histogram[0]!
  if (!total) return GLYPH

  const clip = total * STRETCH_CLIP
  let low = 1
  for (let seen = histogram[1]!; seen <= clip && low < 255; seen += histogram[++low]!);
  let high = 255
  for (let seen = histogram[255]!; seen <= clip && high > low; seen += histogram[--high]!);

  const table = new Uint8Array(256)
  for (let v = 1; v < 256; v++) {
    const k = high > low ? Math.min(1, Math.max(0, (v - low) / (high - low))) : 1
    table[v] = 1 + Math.min(RAMP.length - 2, Math.floor(k * (RAMP.length - 1)))
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
