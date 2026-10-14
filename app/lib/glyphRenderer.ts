/**
 * Turns traced cells (ink + color) into characters on a canvas.
 *
 * Two ways to draw:
 * - Glyph atlas (default): every ramp character is drawn once in white and kept as an alpha
 *   mask. Each frame writes glyph pixels straight into an ImageData buffer and shows it with
 *   one putImageData. Measured ~2x faster than fillText, and ~7x faster than stamping glyphs
 *   with drawImage (which runs per call in software when canvas isn't GPU-backed).
 * - fillText: one canvas text call per character. Kept for comparison.
 */
import { hexToBytes, hexToCss } from './color'

// Sparse to dense. The first character is a space so the sky stays blank.
const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'
// Ink (0..255) to ramp index, so the draw loops do one table lookup per cell.
const GLYPH = new Uint8Array(256).map((_, v) => Math.min(RAMP.length - 1, Math.floor((v / 255) * RAMP.length)))
// Line height relative to font size, so rows don't touch.
const LINE_SPACING = 7 / 6
const FONT_FAMILY = 'ui-monospace, Menlo, Consolas, monospace'
// Dark ink for the single-color mode: readable on a light sky.
const MONO: [number, number, number] = [0x1D, 0x2B, 0x38]
const MONO_CSS = '#1d2b38'

export interface DrawOptions {
  sky: number
  /** Characters in their surface color; otherwise dark mono ink. */
  color: boolean
  /** Fill each cell with its surface color and draw the character in a shade of it. */
  cellBackground: boolean
  /** Use the glyph atlas instead of fillText. */
  atlas: boolean
}

/**
 * The character's own color when cells have a background: a darker shade on light surfaces,
 * a lighter one on dark surfaces, so the glyph stays visible against its cell.
 */
function glyphShade(c: number, lightSurface: boolean) {
  return lightSurface ? (c * 0.6) | 0 : (c + (255 - c) * 0.35) | 0
}

function isLight(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 100
}

export function createGlyphRenderer() {
  let cols = 0
  let rows = 0
  let cellW = 0
  let cellH = 0
  let charWidth = 0
  let lineHeight = 0
  let width = 0
  let height = 0
  let glyphAlpha = new Uint8Array(0)
  let atlasWidth = 0
  let frame = new ImageData(1, 1)
  let pixels = new Uint32Array(1)

  /** Sizes the canvas and character grid. Returns the new grid size. */
  function resize(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, cssWidth: number, cssHeight: number, fontSize: number) {
    width = cssWidth
    height = cssHeight
    const dpr = Math.min(window.devicePixelRatio, 2)
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = `${fontSize}px ${FONT_FAMILY}`
    ctx.textBaseline = 'top'

    // Snap cells to whole device pixels. With fractional cells (e.g. 2.25 px at 125% display
    // scaling) rounding makes every 4th gap 1 px wider, which shows up as regular vertical
    // and horizontal lines across the image.
    cellW = Math.max(1, Math.round(ctx.measureText('M').width * dpr))
    cellH = Math.max(1, Math.round(fontSize * LINE_SPACING * dpr))
    charWidth = cellW / dpr
    lineHeight = cellH / dpr
    cols = Math.max(1, Math.floor(canvas.width / cellW))
    rows = Math.max(1, Math.floor(canvas.height / cellH))

    // The atlas and frame buffer work in device pixels so glyphs stay sharp on high-DPI screens.
    atlasWidth = cellW * RAMP.length
    const atlas = document.createElement('canvas')
    atlas.width = atlasWidth
    atlas.height = cellH
    const atlasCtx = atlas.getContext('2d', { willReadFrequently: true })!
    atlasCtx.font = `${fontSize * dpr}px ${FONT_FAMILY}`
    atlasCtx.textBaseline = 'top'
    atlasCtx.fillStyle = '#fff'
    for (let g = 1; g < RAMP.length; g++) atlasCtx.fillText(RAMP[g]!, g * cellW, 0)
    const rgba = atlasCtx.getImageData(0, 0, atlasWidth, cellH).data
    glyphAlpha = new Uint8Array(atlasWidth * cellH)
    for (let i = 0; i < glyphAlpha.length; i++) glyphAlpha[i] = rgba[i * 4 + 3]!
    frame = new ImageData(canvas.width, canvas.height)
    pixels = new Uint32Array(frame.data.buffer)

    return { cols, rows }
  }

  function draw(ctx: CanvasRenderingContext2D, ink: Uint8Array, rgb: Uint8Array, options: DrawOptions) {
    if (ink.length !== cols * rows) return
    if (options.atlas) drawWithAtlas(ctx, ink, rgb, options)
    else drawWithFillText(ctx, ink, rgb, options)
  }

  function drawWithFillText(ctx: CanvasRenderingContext2D, ink: Uint8Array, rgb: Uint8Array, { sky, color, cellBackground }: DrawOptions) {
    const backgrounds = color && cellBackground
    ctx.fillStyle = hexToCss(sky)
    ctx.fillRect(0, 0, width, height)
    if (!color) ctx.fillStyle = MONO_CSS

    let lastStyle = ''
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        const g = GLYPH[ink[i]!]!
        if (g === 0) continue

        if (backgrounds) {
          const r = rgb[i * 3]!
          const gr = rgb[i * 3 + 1]!
          const b = rgb[i * 3 + 2]!
          const light = isLight(r, gr, b)
          ctx.fillStyle = `rgb(${r},${gr},${b})`
          ctx.fillRect(x * charWidth, y * lineHeight, charWidth, lineHeight)
          ctx.fillStyle = `rgb(${glyphShade(r, light)},${glyphShade(gr, light)},${glyphShade(b, light)})`
          lastStyle = ''
        }
        else if (color) {
          // Quantize so consecutive cells can share a fillStyle.
          const style = `rgb(${rgb[i * 3]! & 0xF0},${rgb[i * 3 + 1]! & 0xF0},${rgb[i * 3 + 2]! & 0xF0})`
          if (style !== lastStyle) {
            ctx.fillStyle = style
            lastStyle = style
          }
        }
        ctx.fillText(RAMP[g]!, x * charWidth, y * lineHeight)
      }
    }
  }

  function drawWithAtlas(ctx: CanvasRenderingContext2D, ink: Uint8Array, rgb: Uint8Array, { sky, color, cellBackground }: DrawOptions) {
    // Everything the hot loop touches is a local: closure variables per pixel are measurably
    // slower than locals at 100k+ cells.
    const backgrounds = color && cellBackground
    const [skyR, skyG, skyB] = hexToBytes(sky)
    const { width: frameW, height: frameH } = frame
    const px = pixels
    const alpha = glyphAlpha
    const stride = atlasWidth
    const gw = cellW
    const gh = cellH
    // ImageData is RGBA in memory, so a little-endian Uint32 pixel is 0xAABBGGRR.
    px.fill(0xFF000000 | (skyB << 16) | (skyG << 8) | skyR)

    for (let y = 0; y < rows; y++) {
      const oy = y * gh
      const h = Math.min(gh, frameH - oy)
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        const g = GLYPH[ink[i]!]!
        if (g === 0) continue

        const r = color ? rgb[i * 3]! : MONO[0]
        const gr = color ? rgb[i * 3 + 1]! : MONO[1]
        const b = color ? rgb[i * 3 + 2]! : MONO[2]
        // Background and foreground of this cell. Without cell backgrounds the glyph sits on the sky.
        let bgR = skyR
        let bgG = skyG
        let bgB = skyB
        let fgR = r
        let fgG = gr
        let fgB = b
        if (backgrounds) {
          const light = isLight(r, gr, b)
          bgR = r
          bgG = gr
          bgB = b
          fgR = glyphShade(r, light)
          fgG = glyphShade(gr, light)
          fgB = glyphShade(b, light)
        }

        const ox = x * gw
        const w = Math.min(gw, frameW - ox)
        for (let yy = 0; yy < h; yy++) {
          const dst = (oy + yy) * frameW + ox
          const src = yy * stride + g * gw
          for (let xx = 0; xx < w; xx++) {
            const a = alpha[src + xx]!
            // Blend by glyph coverage: background + (foreground - background) * coverage.
            if (a || backgrounds) {
              px[dst + xx] = 0xFF000000
                | ((bgB + (((fgB - bgB) * a) >> 8)) << 16)
                | ((bgG + (((fgG - bgG) * a) >> 8)) << 8)
                | (bgR + (((fgR - bgR) * a) >> 8))
            }
          }
        }
      }
    }
    ctx.putImageData(frame, 0, 0)
  }

  return { resize, draw }
}
