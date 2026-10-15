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
import { cellColors, GLYPHS, pickGlyphs, type Cells, type StyleOptions } from './cellStyle'
import { hexToBytes, hexToCss } from './color'

// Line height relative to font size, so rows don't touch.
const LINE_SPACING = 7 / 6
const FONT_FAMILY = 'ui-monospace, Menlo, Consolas, monospace'
const MONO_CSS = '#1d2b38'

export interface DrawOptions extends StyleOptions {
  sky: number
  /** Use the glyph atlas instead of fillText. */
  atlas: boolean
  /**
   * One byte per cell: draw only the cells set to 1 and leave the rest of the canvas
   * transparent, so whatever is behind it shows through (the ASCII lens). Without it, every
   * cell is drawn on the sky.
   */
  mask?: Uint8Array
}

// At this character size and up, glyphs get the full shade. Smaller characters can't be
// read as letters anyway, and a strong shade only tints their cells (pale pines, row stripes).
const FULL_SHADE_FONT_SIZE = 12

export function createGlyphRenderer() {
  let cols = 0
  let rows = 0
  let cellW = 0
  let cellH = 0
  let charWidth = 0
  let lineHeight = 0
  let shade = 1
  let width = 0
  let height = 0
  let glyphAlpha = new Uint8Array(0)
  let atlasWidth = 0
  let frame = new ImageData(1, 1)
  let pixels = new Uint32Array(1)
  // Per-cell scratch buffers, reused every frame.
  let glyphs = new Uint8Array(0)
  let edges = new Uint8Array(0)
  let edgeStrength = new Float32Array(0)

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
    shade = Math.min(1, fontSize / FULL_SHADE_FONT_SIZE)
    cols = Math.max(1, Math.floor(canvas.width / cellW))
    rows = Math.max(1, Math.floor(canvas.height / cellH))

    // The atlas and frame buffer work in device pixels so glyphs stay sharp on high-DPI screens.
    atlasWidth = cellW * GLYPHS.length
    const atlas = document.createElement('canvas')
    atlas.width = atlasWidth
    atlas.height = cellH
    const atlasCtx = atlas.getContext('2d', { willReadFrequently: true })!
    atlasCtx.font = `${fontSize * dpr}px ${FONT_FAMILY}`
    atlasCtx.textBaseline = 'top'
    atlasCtx.fillStyle = '#fff'
    for (let g = 1; g < GLYPHS.length; g++) atlasCtx.fillText(GLYPHS[g]!, g * cellW, 0)
    const rgba = atlasCtx.getImageData(0, 0, atlasWidth, cellH).data
    glyphAlpha = new Uint8Array(atlasWidth * cellH)
    for (let i = 0; i < glyphAlpha.length; i++) glyphAlpha[i] = rgba[i * 4 + 3]!
    frame = new ImageData(canvas.width, canvas.height)
    pixels = new Uint32Array(frame.data.buffer)
    glyphs = new Uint8Array(cols * rows)
    edges = new Uint8Array(cols * rows)
    edgeStrength = new Float32Array(cols * rows)

    // Cell size in CSS pixels, for mapping screen positions to cells.
    return { cols, rows, cellWidth: charWidth, cellHeight: lineHeight }
  }

  function draw(ctx: CanvasRenderingContext2D, cells: Cells, options: DrawOptions) {
    if (cells.ink.length !== cols * rows) return
    pickGlyphs(cells, cols, rows, options, glyphs, edgeStrength, edges)
    if (options.atlas) drawWithAtlas(ctx, cells.rgb, options)
    else drawWithFillText(ctx, cells.rgb, options)
  }

  function drawWithFillText(ctx: CanvasRenderingContext2D, rgb: Uint8Array, options: DrawOptions) {
    const { sky, color, cellBackground } = options
    const backgrounds = color && cellBackground
    const { mask } = options
    const skyBytes = hexToBytes(sky)
    const skyCss = hexToCss(sky)
    const c = new Uint8Array(6)
    if (mask) ctx.clearRect(0, 0, width, height)
    else {
      ctx.fillStyle = skyCss
      ctx.fillRect(0, 0, width, height)
    }
    if (!color) ctx.fillStyle = MONO_CSS

    let lastStyle = ''
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        const g = glyphs[i]!
        if (mask) {
          if (!mask[i]) continue
          // The canvas starts out transparent: give the cell its sky first.
          if (!backgrounds || g === 0) {
            ctx.fillStyle = skyCss
            ctx.fillRect(x * charWidth, y * lineHeight, charWidth, lineHeight)
            lastStyle = ''
            if (!color) ctx.fillStyle = MONO_CSS
          }
        }
        if (g === 0) continue
        const edge = edgeStrength[i]!

        if (backgrounds || (edge && color)) {
          cellColors(rgb, i, edge, options, shade, skyBytes, c)
          if (backgrounds) {
            ctx.fillStyle = `rgb(${c[3]},${c[4]},${c[5]})`
            ctx.fillRect(x * charWidth, y * lineHeight, charWidth, lineHeight)
          }
          ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`
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
        ctx.fillText(GLYPHS[g]!, x * charWidth, y * lineHeight)
      }
    }
  }

  function drawWithAtlas(ctx: CanvasRenderingContext2D, rgb: Uint8Array, options: DrawOptions) {
    // Everything the hot loop touches is a local: closure variables per pixel are measurably
    // slower than locals at 100k+ cells.
    const backgrounds = options.color && options.cellBackground
    const { mask } = options
    const cellGlyphs = glyphs
    const cellEdges = edgeStrength
    const skyBytes = hexToBytes(options.sky)
    const [skyR, skyG, skyB] = skyBytes
    const c = new Uint8Array(6)
    const { width: frameW, height: frameH } = frame
    const px = pixels
    const alpha = glyphAlpha
    const stride = atlasWidth
    const gw = cellW
    const gh = cellH
    const strength = shade
    // ImageData is RGBA in memory, so a little-endian Uint32 pixel is 0xAABBGGRR.
    const skyPixel = 0xFF000000 | (skyB << 16) | (skyG << 8) | skyR
    // With a mask, start transparent: only the masked-in cells get drawn.
    px.fill(mask ? 0 : skyPixel)

    for (let y = 0; y < rows; y++) {
      const oy = y * gh
      const h = Math.min(gh, frameH - oy)
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        const g = cellGlyphs[i]!
        if (mask && !mask[i]) continue
        if (g === 0) {
          // Sky. Already there without a mask; with one, fill the cell.
          if (mask) {
            const w = Math.min(gw, frameW - x * gw)
            for (let yy = 0; yy < h; yy++) px.fill(skyPixel, (oy + yy) * frameW + x * gw, (oy + yy) * frameW + x * gw + w)
          }
          continue
        }
        const edge = cellEdges[i]!

        // Background and foreground of this cell. Without cell backgrounds the glyph sits on the sky.
        cellColors(rgb, i, edge, options, strength, skyBytes, c)
        const fgR = c[0]!
        const fgG = c[1]!
        const fgB = c[2]!
        const bgR = c[3]!
        const bgG = c[4]!
        const bgB = c[5]!

        const ox = x * gw
        const w = Math.min(gw, frameW - ox)
        for (let yy = 0; yy < h; yy++) {
          const dst = (oy + yy) * frameW + ox
          const src = yy * stride + g * gw
          for (let xx = 0; xx < w; xx++) {
            const a = alpha[src + xx]!
            // Blend by glyph coverage: background + (foreground - background) * coverage.
            if (a || backgrounds || mask) {
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
