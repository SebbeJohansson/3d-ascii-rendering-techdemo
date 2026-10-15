/**
 * Draws traced frames into the terminal with ANSI escape codes, in 24-bit color (or the
 * 256-color palette where that isn't supported), between a status bar on top and a key bar at
 * the bottom. Only cells that changed since the last frame are rewritten, which keeps the
 * output small enough for 30+ fps.
 *
 * Two resolutions:
 * - characters: one traced cell per terminal cell, drawn as a character, like the browser.
 * - blocks: two traced pixels per terminal cell, stacked. '▀' paints the top half in the
 *   foreground color and the bottom half in the background color: twice the detail, but
 *   colored pixels instead of characters.
 */
import { cellColors, GLYPHS, pickGlyphs, type Cells, type StyleOptions } from '../app/lib/cellStyle'

const ESC = '\x1b['
/** Marks a cell as unknown, so the next frame rewrites it. Never a real packed cell. */
const UNKNOWN = 0xFFFFFFFF
const UPPER_HALF = '▀'
/** In the packed foreground: this cell is a block, not a ramp character. */
const BLOCK = 0xFF000000

export type Resolution = 'characters' | 'blocks'

export interface ScreenOptions extends StyleOptions {
  sky: readonly number[]
}

/** Nearest color in the 256-color palette's 6×6×6 cube. */
function cube(r: number, g: number, b: number) {
  const level = (c: number) => (c < 48 ? 0 : c < 115 ? 1 : Math.min(5, Math.floor((c - 35) / 40)))
  return 16 + 36 * level(r) + 6 * level(g) + level(b)
}

const pack = (c: Uint8Array, o: number) => (c[o]! << 16) | (c[o + 1]! << 8) | c[o + 2]!

export function createScreen(out: NodeJS.WriteStream, trueColor: boolean) {
  let cols = 0
  /** Terminal rows the frame takes, between the two bars. */
  let rows = 0
  let resolution: Resolution = 'characters'
  // Per terminal cell, as last drawn: glyph (or BLOCK) and foreground packed into one
  // number, and the background.
  let shownFg = new Uint32Array(0)
  let shownBg = new Uint32Array(0)
  // Per traced cell: scratch space for picking characters and outlines.
  let glyphs = new Uint8Array(0)
  let edges = new Uint8Array(0)
  let edgeStrength = new Float32Array(0)
  let shownBars = ['', '']
  const colors = new Uint8Array(6)

  const color = (layer: 38 | 48, rgb: number) => {
    const r = rgb >>> 16
    const g = (rgb >>> 8) & 255
    const b = rgb & 255
    return trueColor ? `${ESC}${layer};2;${r};${g};${b}m` : `${ESC}${layer};5;${cube(r, g, b)}m`
  }

  /** The grid the tracer should fill: one cell per character, or two stacked per block. */
  const traced = () => ({ cols, rows: resolution === 'blocks' ? rows * 2 : rows })

  /**
   * Sizes the frame for a terminal of `columns` × `lines` (the bars take a line each) and
   * forgets what was on screen. Returns the grid to trace.
   */
  function resize(columns: number, lines: number, res: Resolution) {
    cols = columns
    rows = Math.max(1, lines - 2)
    resolution = res
    shownFg = new Uint32Array(cols * rows).fill(UNKNOWN)
    shownBg = new Uint32Array(cols * rows).fill(UNKNOWN)
    const { rows: tracedRows } = traced()
    glyphs = new Uint8Array(cols * tracedRows)
    edges = new Uint8Array(cols * tracedRows)
    edgeStrength = new Float32Array(cols * tracedRows)
    shownBars = ['', '']
    out.write(`${ESC}0m${ESC}2J`)
    return traced()
  }

  /** A traced pixel's color for block mode: its surface, its outline, or the sky. */
  function pixel(cells: Cells, i: number, options: ScreenOptions, sky: number) {
    if (!glyphs[i]) return sky
    const edge = edgeStrength[i]!
    cellColors(cells.rgb, i, edge, { color: options.color, cellBackground: true }, 1, options.sky, colors)
    return edge ? pack(colors, 0) : pack(colors, 3)
  }

  /** Draws a frame of the grid resize() returned. */
  function draw(cells: Cells, options: ScreenOptions) {
    const grid = traced()
    if (cells.ink.length !== grid.cols * grid.rows) return
    pickGlyphs(cells, grid.cols, grid.rows, options, glyphs, edgeStrength, edges)
    const blocks = resolution === 'blocks'
    const sky = (options.sky[0]! << 16) | (options.sky[1]! << 8) | options.sky[2]!
    const parts: string[] = []
    let fg = -1
    let bg = -1
    for (let y = 0; y < rows; y++) {
      // Whether the cursor sits right after the last cell written, so the next can follow on.
      let inPlace = false
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        let packed: number
        let cellBg: number
        let glyph: string
        if (blocks) {
          const top = pixel(cells, 2 * y * cols + x, options, sky)
          cellBg = pixel(cells, (2 * y + 1) * cols + x, options, sky)
          // Both halves alike: a plain space on the background says the same in fewer bytes.
          packed = top === cellBg ? 0 : (BLOCK | top) >>> 0
          glyph = top === cellBg ? ' ' : UPPER_HALF
        }
        else {
          const g = glyphs[i]!
          cellColors(cells.rgb, i, edgeStrength[i]!, options, 1, options.sky, colors)
          // Rays that hit nothing have no color of their own: show the sky.
          if (!g) colors.set(options.sky, 3)
          packed = (g * 0x1000000 + (g ? pack(colors, 0) : 0)) >>> 0
          cellBg = pack(colors, 3)
          glyph = GLYPHS[g]!
        }
        if (shownFg[i] === packed && shownBg[i] === cellBg) {
          inPlace = false
          continue
        }
        shownFg[i] = packed
        shownBg[i] = cellBg
        // +2: terminal rows count from 1, and the status bar takes the first.
        if (!inPlace) parts.push(`${ESC}${y + 2};${x + 1}H`)
        inPlace = true
        if (cellBg !== bg) {
          parts.push(color(48, cellBg))
          bg = cellBg
        }
        const cellFg = packed & 0xFFFFFF
        if (glyph !== ' ' && cellFg !== fg) {
          parts.push(color(38, cellFg))
          fg = cellFg
        }
        parts.push(glyph)
      }
    }
    if (parts.length) out.write(parts.join(''))
  }

  /** Writes the status bar above the frame and the key bar below it, where they changed. */
  function bars(top: string, bottom: string) {
    // One short of the full width: writing the bottom-right corner makes some terminals scroll.
    const width = cols - 1
    const fit = (text: string) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))
    const lines = [fit(top), fit(bottom)]
    const at = [1, rows + 2]
    lines.forEach((line, k) => {
      if (line === shownBars[k]) return
      out.write(`${ESC}${at[k]};1H${ESC}0m${ESC}7m${line}${ESC}0m`)
      shownBars[k] = line
    })
  }

  /** Switches to a separate screen, like full-screen programs (vim, less) do. */
  function enter() {
    out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`)
  }

  /** Back to the normal screen, with the cursor and colors restored. */
  function leave() {
    out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`)
  }

  return { resize, draw, bars, enter, leave }
}
