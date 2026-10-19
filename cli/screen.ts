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

/** Colors this close (per channel, out of 255) look the same: not worth the bytes to change. */
const NEAR = 3
const near = (a: number, b: number) =>
  Math.abs((a >>> 16) - (b >>> 16)) <= NEAR && Math.abs(((a >>> 8) & 255) - ((b >>> 8) & 255)) <= NEAR && Math.abs((a & 255) - (b & 255)) <= NEAR

/** Decimal digits of 0..999 as bytes: numbers in escape codes are written with one lookup. */
const DIGITS = Array.from({ length: 1000 }, (_, n) => Buffer.from(String(n)))
const GLYPH_BYTES = [...GLYPHS].map(g => Buffer.from(g))
const UPPER_HALF_BYTES = Buffer.from(UPPER_HALF)
const [BYTE_ESC, BYTE_BRACKET, BYTE_SEMI] = [0x1B, 0x5B, 0x3B]
/** The most one cell can add: a cursor move, two colors and a 3-byte character. */
const MAX_CELL_BYTES = 64

/**
 * A frame's output, written straight into a reused byte buffer. Building a string and having
 * Node encode it cost as much as everything else in drawing.
 */
function createByteWriter() {
  let buf = Buffer.alloc(1 << 16)
  let len = 0
  const bytes = (b: Uint8Array) => {
    buf.set(b, len)
    len += b.length
  }
  const num = (n: number) => (n < 1000 ? bytes(DIGITS[n]!) : (len += buf.write(String(n), len, 'latin1')))
  return {
    get length() {
      return len
    },
    reset() {
      len = 0
    },
    /** Makes room for `n` more bytes. */
    reserve(n: number) {
      if (len + n <= buf.length) return
      const grown = Buffer.alloc(Math.max(buf.length * 2, len + n))
      buf.copy(grown, 0, 0, len)
      buf = grown
    },
    bytes,
    text(t: string) {
      len += buf.write(t, len, 'latin1')
    },
    /** CSI y ; x H */
    moveTo(y: number, x: number) {
      buf[len++] = BYTE_ESC
      buf[len++] = BYTE_BRACKET
      num(y)
      buf[len++] = BYTE_SEMI
      num(x)
      buf[len++] = 0x48
    },
    /** CSI 38;2;r;g;b m (or 48 for the background), or CSI 38;5;n m in 256 colors. */
    color(layer: 38 | 48, rgb: number, trueColor: boolean) {
      buf[len++] = BYTE_ESC
      buf[len++] = BYTE_BRACKET
      num(layer)
      buf[len++] = BYTE_SEMI
      const r = rgb >>> 16
      const g = (rgb >>> 8) & 255
      const b = rgb & 255
      if (trueColor) {
        buf[len++] = 0x32
        buf[len++] = BYTE_SEMI
        num(r)
        buf[len++] = BYTE_SEMI
        num(g)
        buf[len++] = BYTE_SEMI
        num(b)
      }
      else {
        buf[len++] = 0x35
        buf[len++] = BYTE_SEMI
        num(cube(r, g, b))
      }
      buf[len++] = 0x6D
    },
    /** A copy of what was written: the buffer is reused while a write may still be pending. */
    take: () => Buffer.from(buf.subarray(0, len)),
  }
}

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
  const w = createByteWriter()

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

  /** Draws a frame of the grid resize() returned. Returns the bytes written and how long writing took. */
  function draw(cells: Cells, options: ScreenOptions) {
    const grid = traced()
    if (cells.ink.length !== grid.cols * grid.rows) return { bytes: 0, writeMs: 0 }
    pickGlyphs(cells, grid.cols, grid.rows, options, glyphs, edgeStrength, edges)
    const blocks = resolution === 'blocks'
    const sky = (options.sky[0]! << 16) | (options.sky[1]! << 8) | options.sky[2]!
    // Synchronized output (2026): the terminal shows the frame once it has all of it, not half drawn.
    w.reset()
    w.text(`${ESC}?2026h`)
    const empty = w.length
    let fg = -1
    let bg = -1
    for (let y = 0; y < rows; y++) {
      // Whether the cursor sits right after the last cell written, so the next can follow on.
      let inPlace = false
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        let packed: number
        let cellBg: number
        let glyph: Uint8Array
        if (blocks) {
          const top = pixel(cells, 2 * y * cols + x, options, sky)
          cellBg = pixel(cells, (2 * y + 1) * cols + x, options, sky)
          // Both halves alike: a plain space on the background says the same in fewer bytes.
          packed = top === cellBg ? 0 : (BLOCK | top) >>> 0
          glyph = top === cellBg ? GLYPH_BYTES[0]! : UPPER_HALF_BYTES
        }
        else {
          const g = glyphs[i]!
          cellColors(cells.rgb, i, edgeStrength[i]!, options, 1, options.sky, colors)
          // Rays that hit nothing have no color of their own: show the sky.
          if (!g) colors.set(options.sky, 3)
          packed = (g * 0x1000000 + (g ? pack(colors, 0) : 0)) >>> 0
          cellBg = pack(colors, 3)
          glyph = GLYPH_BYTES[g]!
        }
        const glyphBits = (packed & BLOCK) >>> 0
        let cellFg = packed & 0xFFFFFF
        // On screen already, give or take a shade. The shown colors are what was actually
        // written, so skipped changes never add up to more than NEAR.
        const shown = shownFg[i]!
        if (shownBg[i] !== UNKNOWN && (shown & BLOCK) >>> 0 === glyphBits && near(shown & 0xFFFFFF, cellFg) && near(shownBg[i]!, cellBg)) {
          inPlace = false
          continue
        }
        // A color close to the one already set saves an escape code.
        if (bg >= 0 && near(cellBg, bg)) cellBg = bg
        if (fg >= 0 && near(cellFg, fg)) cellFg = fg
        shownFg[i] = (glyphBits | cellFg) >>> 0
        shownBg[i] = cellBg
        w.reserve(MAX_CELL_BYTES)
        // +2: terminal rows count from 1, and the status bar takes the first.
        if (!inPlace) w.moveTo(y + 2, x + 1)
        inPlace = true
        if (cellBg !== bg) {
          w.color(48, cellBg, trueColor)
          bg = cellBg
        }
        if (glyph !== GLYPH_BYTES[0] && cellFg !== fg) {
          w.color(38, cellFg, trueColor)
          fg = cellFg
        }
        w.bytes(glyph)
      }
    }
    if (w.length === empty) return { bytes: 0, writeMs: 0 }
    // Then a status request (5n), answered once the terminal has read everything before it.
    w.reserve(MAX_CELL_BYTES)
    w.text(`${ESC}?2026l${ESC}5n`)
    const frame = w.take()
    const start = performance.now()
    out.write(frame)
    return { bytes: frame.length, writeMs: performance.now() - start }
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
