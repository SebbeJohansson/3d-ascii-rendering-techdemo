/**
 * Draws traced frames into the terminal with ANSI escape codes, in as many colors as the
 * terminal shows (24-bit, the 256-color palette, the 16 basic colors, or none), between a status
 * bar on top and a key bar at the bottom. Only cells that changed since the last frame are rewritten, which keeps the
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

/** How many colors to draw in. 'none' is characters only, in the terminal's own colors. */
export type ColorDepth = '24bit' | '256' | '16' | 'none'
export const COLOR_DEPTHS: readonly ColorDepth[] = ['24bit', '256', '16', 'none']
export const COLOR_DEPTH_NAMES: Record<ColorDepth, string> = { '24bit': '24-bit color', '256': '256 colors', '16': '16 colors', 'none': 'no color' }

/** The most colors the terminal shows. Node reads NO_COLOR, FORCE_COLOR, TERM and COLORTERM. */
export function detectColorDepth(out: NodeJS.WriteStream): ColorDepth {
  if (out.hasColors(2 ** 24)) return '24bit'
  if (out.hasColors(256)) return '256'
  if (out.hasColors(16)) return '16'
  return 'none'
}

/** Nearest color in the 256-color palette's 6×6×6 cube. */
function cube(rgb: number) {
  const level = (c: number) => (c < 48 ? 0 : c < 115 ? 1 : Math.min(5, Math.floor((c - 35) / 40)))
  return 16 + 36 * level(rgb >>> 16) + 6 * level((rgb >>> 8) & 255) + level(rgb & 255)
}

/** The 16 basic colors as xterm shows them by default. Themes change them, so this is a guess. */
const BASIC = [
  0x000000, 0xCD0000, 0x00CD00, 0xCDCD00, 0x0000EE, 0xCD00CD, 0x00CDCD, 0xE5E5E5,
  0x7F7F7F, 0xFF0000, 0x00FF00, 0xFFFF00, 0x5C5CFF, 0xFF00FF, 0x00FFFF, 0xFFFFFF,
]

/**
 * Nearest of the first `count` basic colors, per color at 5 bits a channel, looked up rather
 * than searched for every cell.
 */
function basicTable(count: number) {
  const table = new Uint8Array(1 << 15)
  for (let i = 0; i < table.length; i++) {
    const [r, g, b] = [(i >> 10) * 8 + 4, ((i >> 5) & 31) * 8 + 4, (i & 31) * 8 + 4]
    let best = Infinity
    for (let k = 0; k < count; k++) {
      const c = BASIC[k]!
      const d = 2 * (r - (c >>> 16)) ** 2 + 4 * (g - ((c >>> 8) & 255)) ** 2 + 3 * (b - (c & 255)) ** 2
      if (d < best) {
        best = d
        table[i] = k
      }
    }
  }
  return (rgb: number) => table[((rgb >>> 19) << 10) | (((rgb >>> 11) & 31) << 5) | ((rgb >>> 3) & 31)]!
}

/**
 * Turns colors into what gets written for them: the color itself in 24-bit, else a palette
 * index. Backgrounds get only the first 8 basic colors: the Linux console has no bright ones.
 */
function createPalette(depth: ColorDepth) {
  const identity = (rgb: number) => rgb
  if (depth === '24bit') return { fg: identity, bg: identity }
  if (depth === '256') return { fg: cube, bg: cube }
  if (depth === 'none') return { fg: () => 0, bg: () => 0 }
  return { fg: basicTable(16), bg: basicTable(8) }
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
    /**
     * A color createPalette() made: CSI 38;2;r;g;b m (or 48 for the background) in 24-bit,
     * CSI 38;5;n m in 256 colors, CSI 3n m / 9n m (4n m) in 16. Nothing without color.
     */
    color(layer: 38 | 48, code: number, depth: ColorDepth) {
      if (depth === 'none') return
      buf[len++] = BYTE_ESC
      buf[len++] = BYTE_BRACKET
      if (depth === '16') {
        num(code < 8 ? layer - 8 + code : layer + 52 + code - 8)
        buf[len++] = 0x6D
        return
      }
      num(layer)
      buf[len++] = BYTE_SEMI
      if (depth === '24bit') {
        buf[len++] = 0x32
        buf[len++] = BYTE_SEMI
        num(code >>> 16)
        buf[len++] = BYTE_SEMI
        num((code >>> 8) & 255)
        buf[len++] = BYTE_SEMI
        num(code & 255)
      }
      else {
        buf[len++] = 0x35
        buf[len++] = BYTE_SEMI
        num(code)
      }
      buf[len++] = 0x6D
    },
    /** A copy of what was written: the buffer is reused while a write may still be pending. */
    take: () => Buffer.from(buf.subarray(0, len)),
  }
}

export function createScreen(out: NodeJS.WriteStream) {
  let depth: ColorDepth = '24bit'
  let palette = createPalette(depth)
  /** Whether two colors look the same. Only 24-bit has shades close enough to skip. */
  let same = near
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
   * Sizes the frame for a terminal of `columns` × `lines` (the bars take a line each), in `colors`,
   * and forgets what was on screen. Returns the grid to trace.
   */
  function resize(columns: number, lines: number, res: Resolution, colors: ColorDepth) {
    if (colors !== depth) palette = createPalette(colors)
    depth = colors
    same = depth === '24bit' ? near : (a: number, b: number) => a === b
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
          const bottom = pixel(cells, (2 * y + 1) * cols + x, options, sky)
          cellBg = palette.bg(bottom)
          // Both halves alike: a plain space on the background says the same in fewer bytes.
          packed = top === bottom ? 0 : (BLOCK | palette.fg(top)) >>> 0
          glyph = top === bottom ? GLYPH_BYTES[0]! : UPPER_HALF_BYTES
        }
        else {
          const g = glyphs[i]!
          cellColors(cells.rgb, i, edgeStrength[i]!, options, 1, options.sky, colors)
          // Rays that hit nothing have no color of their own: show the sky.
          if (!g) colors.set(options.sky, 3)
          cellBg = palette.bg(pack(colors, 3))
          let fgCode = g ? palette.fg(pack(colors, 0)) : 0
          // In 16 colors a shade often lands on its own background: the bright one stays readable.
          if (depth === '16' && fgCode === cellBg) fgCode = cellBg + 8
          packed = (g * 0x1000000 + fgCode) >>> 0
          glyph = GLYPH_BYTES[g]!
        }
        const glyphBits = (packed & BLOCK) >>> 0
        let cellFg = packed & 0xFFFFFF
        // On screen already, give or take a shade. The shown colors are what was actually
        // written, so skipped changes never add up to more than NEAR.
        const shown = shownFg[i]!
        if (shownBg[i] !== UNKNOWN && (shown & BLOCK) >>> 0 === glyphBits && same(shown & 0xFFFFFF, cellFg) && same(shownBg[i]!, cellBg)) {
          inPlace = false
          continue
        }
        // A color close to the one already set saves an escape code.
        if (bg >= 0 && same(cellBg, bg)) cellBg = bg
        if (fg >= 0 && same(cellFg, fg)) cellFg = fg
        shownFg[i] = (glyphBits | cellFg) >>> 0
        shownBg[i] = cellBg
        w.reserve(MAX_CELL_BYTES)
        // +2: terminal rows count from 1, and the status bar takes the first.
        if (!inPlace) w.moveTo(y + 2, x + 1)
        inPlace = true
        if (cellBg !== bg) {
          w.color(48, cellBg, depth)
          bg = cellBg
        }
        if (glyph !== GLYPH_BYTES[0] && cellFg !== fg) {
          w.color(38, cellFg, depth)
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
