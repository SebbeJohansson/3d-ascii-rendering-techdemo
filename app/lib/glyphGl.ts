/**
 * Draws character cells with WebGL2: the CPU fills one small texture with each cell's glyph and
 * colors, and a fragment shader does the per-pixel work (find the cell, look up the glyph's
 * coverage in the atlas, blend foreground over background). The CPU atlas path does the same
 * per pixel in JavaScript, which at ~3M device pixels takes most of a frame.
 */

const VERTEX = `#version 300 es
void main() {
  // One triangle that covers the screen.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
// Two texels per cell: foreground rgb + glyph index, then background rgb + opacity.
uniform sampler2D cells;
// Glyph coverage, the glyphs side by side, one cell wide each.
uniform sampler2D atlas;
uniform ivec2 cellSize;
uniform ivec2 grid;
uniform int frameHeight;
// Past the last full row and column; alpha 0 with a lens mask.
uniform vec4 sky;
out vec4 color;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = frameHeight - 1 - p.y;
  ivec2 c = p / cellSize;
  if (c.x >= grid.x || c.y >= grid.y) {
    color = vec4(sky.rgb * sky.a, sky.a);
    return;
  }
  vec4 fg = texelFetch(cells, ivec2(c.x * 2, c.y), 0);
  vec4 bg = texelFetch(cells, ivec2(c.x * 2 + 1, c.y), 0);
  int glyph = int(fg.a * 255.0 + 0.5);
  ivec2 local = p - c * cellSize;
  float a = texelFetch(atlas, ivec2(glyph * cellSize.x + local.x, local.y), 0).r;
  // Premultiplied, for the transparent cells outside a lens.
  color = vec4(mix(bg.rgb, fg.rgb, a) * bg.a, bg.a);
}`

export type GlyphGl = NonNullable<ReturnType<typeof createGlyphGl>>

/** Null where WebGL2 isn't available. */
export function createGlyphGl(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: true })
  if (!gl) return null

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'glyph shader')
    return shader
  }
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'glyph program')
  gl.useProgram(program)
  const at = (name: string) => gl.getUniformLocation(program, name)
  const u = { cellSize: at('cellSize'), grid: at('grid'), frameHeight: at('frameHeight'), sky: at('sky') }
  gl.uniform1i(at('cells'), 0)
  gl.uniform1i(at('atlas'), 1)
  gl.bindVertexArray(gl.createVertexArray())
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

  const texture = (unit: number) => {
    const t = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    return t
  }
  const cellTexture = texture(0)
  const atlasTexture = texture(1)
  let cols = 0
  let rows = 0

  return {
    /** Sizes the canvas in device pixels and uploads the glyph atlas (one byte of coverage per pixel). */
    resize(width: number, height: number, gridCols: number, gridRows: number, cellW: number, cellH: number, atlas: Uint8Array, atlasWidth: number) {
      canvas.width = width
      canvas.height = height
      cols = gridCols
      rows = gridRows
      gl.viewport(0, 0, width, height)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlasWidth, cellH, 0, gl.RED, gl.UNSIGNED_BYTE, atlas)
      gl.uniform2i(u.cellSize, cellW, cellH)
      gl.uniform2i(u.grid, cols, rows)
      gl.uniform1i(u.frameHeight, height)
    },
    /** `cells`: 8 bytes per cell, see the shader. */
    draw(cells: Uint8Array, sky: readonly number[], skyAlpha: number) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, cellTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols * 2, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, cells)
      gl.uniform4f(u.sky, sky[0]! / 255, sky[1]! / 255, sky[2]! / 255, skyAlpha)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    /** Leaves the canvas transparent, for when the 2D canvas underneath draws instead. */
    clear() {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    },
  }
}
