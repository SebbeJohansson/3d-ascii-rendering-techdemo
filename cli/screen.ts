/**
 * Draws traced frames into the terminal with ANSI escape codes: one character per cell, in
 * 24-bit color (or the 256-color palette where that isn't supported). Only cells that changed
 * since the last frame are rewritten, which keeps the output small enough for 30+ fps.
 */
import { cellColors, GLYPHS, pickGlyphs, type Cells, type StyleOptions } from '../app/lib/cellStyle'

const ESC = '\x1b['
/** Marks a cell as unknown, so the next frame rewrites it. Never a real packed cell. */
const UNKNOWN = 0xFFFFFFFF

export interface ScreenOptions extends StyleOptions {
  sky: readonly number[]
}

/** Nearest color in the 256-color palette's 6×6×6 cube. */
function cube(r: number, g: number, b: number) {
  const level = (c: number) => (c < 48 ? 0 : c < 115 ? 1 : Math.min(5, Math.floor((c - 35) / 40)))
  return 16 + 36 * level(r) + 6 * level(g) + level(b)
}

export function createScreen(out: NodeJS.WriteStream, trueColor: boolean) {
  let cols = 0
  let rows = 0
  // Per cell: glyph and foreground packed into one number, and background, as last drawn.
  let shownFg = new Uint32Array(0)
  let shownBg = new Uint32Array(0)
  let glyphs = new Uint8Array(0)
  let edges = new Uint8Array(0)
  let edgeStrength = new Float32Array(0)
  let shownStatus = ''
  const colors = new Uint8Array(6)

  const color = (layer: 38 | 48, rgb: number) => {
    const r = rgb >>> 16
    const g = (rgb >>> 8) & 255
    const b = rgb & 255
    return trueColor ? `${ESC}${layer};2;${r};${g};${b}m` : `${ESC}${layer};5;${cube(r, g, b)}m`
  }

  /** Sizes the grid to `cols` × `rows` cells and forgets what was on screen. */
  function resize(c: number, r: number) {
    cols = c
    rows = r
    shownFg = new Uint32Array(cols * rows).fill(UNKNOWN)
    shownBg = new Uint32Array(cols * rows).fill(UNKNOWN)
    glyphs = new Uint8Array(cols * rows)
    edges = new Uint8Array(cols * rows)
    edgeStrength = new Float32Array(cols * rows)
    shownStatus = ''
    out.write(`${ESC}0m${ESC}2J`)
  }

  /** Draws a frame of `cols` × `rows` cells. */
  function draw(cells: Cells, options: ScreenOptions) {
    if (cells.ink.length !== cols * rows) return
    pickGlyphs(cells, cols, rows, options, glyphs, edgeStrength, edges)
    const parts: string[] = []
    let fg = -1
    let bg = -1
    for (let y = 0; y < rows; y++) {
      // Whether the cursor sits right after the last cell written, so the next can follow on.
      let inPlace = false
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        const g = glyphs[i]!
        cellColors(cells.rgb, i, edgeStrength[i]!, options, 1, options.sky, colors)
        const cellFg = g ? (colors[0]! << 16) | (colors[1]! << 8) | colors[2]! : 0
        const cellBg = (colors[3]! << 16) | (colors[4]! << 8) | colors[5]!
        const packed = (g * 0x1000000 + cellFg) >>> 0
        if (shownFg[i] === packed && shownBg[i] === cellBg) {
          inPlace = false
          continue
        }
        shownFg[i] = packed
        shownBg[i] = cellBg
        if (!inPlace) parts.push(`${ESC}${y + 1};${x + 1}H`)
        inPlace = true
        if (cellBg !== bg) {
          parts.push(color(48, cellBg))
          bg = cellBg
        }
        if (g && cellFg !== fg) {
          parts.push(color(38, cellFg))
          fg = cellFg
        }
        parts.push(GLYPHS[g]!)
      }
    }
    if (parts.length) out.write(parts.join(''))
  }

  /** Writes the status line under the frame, in the terminal's own colors, if it changed. */
  function status(text: string) {
    // One short of the full width: writing the bottom-right corner makes some terminals scroll.
    const width = cols - 1
    const line = text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
    if (line === shownStatus) return
    out.write(`${ESC}${rows + 1};1H${ESC}0m${ESC}7m${line}${ESC}0m`)
    shownStatus = line
  }

  /** Switches to a separate screen, like full-screen programs (vim, less) do. */
  function enter() {
    out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`)
  }

  /** Back to the normal screen, with the cursor and colors restored. */
  function leave() {
    out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`)
  }

  return { resize, draw, status, enter, leave }
}
