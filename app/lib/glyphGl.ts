/**
 * Draws character cells with WebGL2: a fragment shader does the per-pixel work (find the cell,
 * look up the glyph's coverage in the atlas, blend foreground over background). The CPU atlas
 * path does the same per pixel in JavaScript, which at ~3M device pixels takes most of a frame.
 *
 * Two ways in:
 * - draw(): the CPU has picked each cell's glyph and colors (cellStyle.ts) into one small
 *   texture. Used for the lens and stretched contrast, which need the whole frame on the CPU.
 * - drawTraced(): the traced cells go up as they are and the shader picks glyphs, outlines
 *   and colors itself, the same steps as cellStyle.ts and outlines.ts (and glyphs.wgsl.ts for
 *   the GPU tracer), so the CPU does no per-cell work at all.
 */
import { BAYER, FLAT_NY, MIN_OUTLINE_STRENGTH, MONO, OUTLINE_GLYPH, RAMP_GLYPHS, RAMP_LENGTHS, RAMP_STARTS, STEEP_NY, type Cells } from './cellStyle'
import { CREASE_DOT, DEPTH_MARGIN, DEPTH_RATIO } from './outlines'

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n))
const ints = (a: number[]) => `int[${a.length}](${a.join(', ')})`

const VERTEX = `#version 300 es
void main() {
  // One triangle that covers the screen.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/** Uniforms and the pixel's cell, shared by both fragment shaders. */
const COMMON = `#version 300 es
precision highp float;
precision highp int;
// Glyph coverage, the glyphs side by side, one cell wide each.
uniform sampler2D atlas;
uniform ivec2 cellSize;
uniform ivec2 grid;
uniform int frameHeight;
// Past the last full row and column; alpha 0 with a lens mask.
uniform vec4 sky;
out vec4 color;

// The canvas pixel, top-down like the grid.
ivec2 pixel() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = frameHeight - 1 - p.y;
  return p;
}

float coverage(int glyph, ivec2 p, ivec2 cell) {
  ivec2 local = p - cell * cellSize;
  return texelFetch(atlas, ivec2(glyph * cellSize.x + local.x, local.y), 0).r;
}
`

const STYLED = `${COMMON}
// Two texels per cell: foreground rgb + glyph index, then background rgb + opacity.
uniform sampler2D cells;

void main() {
  ivec2 p = pixel();
  ivec2 c = p / cellSize;
  if (c.x >= grid.x || c.y >= grid.y) {
    color = vec4(sky.rgb * sky.a, sky.a);
    return;
  }
  vec4 fg = texelFetch(cells, ivec2(c.x * 2, c.y), 0);
  vec4 bg = texelFetch(cells, ivec2(c.x * 2 + 1, c.y), 0);
  float a = coverage(int(fg.a * 255.0 + 0.5), p, c);
  // Premultiplied, for the transparent cells outside a lens.
  color = vec4(mix(bg.rgb, fg.rgb, a) * bg.a, bg.a);
}`

/** Bits of the `flags` uniform. */
const FLAGS = { color: 1, cellBackground: 2, outlines: 4 }

const TRACED = `${COMMON}
uniform sampler2D ink;
uniform sampler2D rgb;
uniform highp sampler2D depths;
uniform sampler2D normals;
uniform int flags;
uniform vec3 look; // fog near, far; glyph shade

const int RAMP_GLYPHS[${RAMP_GLYPHS.length}] = ${ints(RAMP_GLYPHS)};
const int RAMP_STARTS[${RAMP_STARTS.length}] = ${ints(RAMP_STARTS)};
const int RAMP_LENGTHS[${RAMP_LENGTHS.length}] = ${ints(RAMP_LENGTHS)};
const int BAYER[16] = ${ints(BAYER)};
const int FLAT_NY = ${FLAT_NY};
const int STEEP_NY = ${STEEP_NY};
const int OUTLINE_GLYPH = ${OUTLINE_GLYPH};
const float DEPTH_RATIO = ${f(DEPTH_RATIO)};
const float DEPTH_MARGIN = ${f(DEPTH_MARGIN)};
const float CREASE_DOT = ${f(CREASE_DOT)};
const float MIN_OUTLINE_STRENGTH = ${f(MIN_OUTLINE_STRENGTH)};
const vec3 MONO = vec3(${MONO.map(f).join(', ')});
const float PI = 3.141592653589793;

float depthAt(ivec2 c) { return texelFetch(depths, c, 0).r; }

// The tracer's normals, x 127, as findOutlines() compares them.
vec3 normalAt(ivec2 c) { return round(max(texelFetch(normals, c, 0).rgb, -1.0) * 127.0); }

// rampFor() and rampStep() in cellStyle.ts: the shading glyph for ink v (1..255).
int shadeGlyph(int v, ivec2 c) {
  int up = int(abs(normalAt(c).y));
  int k = up >= FLAT_NY ? 1 : up <= STEEP_NY ? 2 : 0;
  int len = RAMP_LENGTHS[k];
  int b = BAYER[(c.y & 3) * 4 + (c.x & 3)];
  int n = max(0, 32 * v * len + (2 * b - 15) * 255);
  return RAMP_GLYPHS[RAMP_STARTS[k] + clamp(n / 8160, 1, len - 1)];
}

// findOutlines() in outlines.ts, for one cell: 0 for none, else 1..5 for OUTLINE_CHARS.
int outline(ivec2 c) {
  float d = depthAt(c);
  vec3 n = normalAt(c);
  float farther = d * DEPTH_RATIO + DEPTH_MARGIN;
  int i = c.y * grid.x + c.x;
  float vx = 0.0;
  float vy = 0.0;
  int sideways = 0;
  int upDown = 0;
  for (int dy = -1; dy <= 1; dy++) {
    int yy = c.y + dy;
    if (yy < 0 || yy >= grid.y) continue;
    for (int dx = -1; dx <= 1; dx++) {
      int xx = c.x + dx;
      if ((dx == 0 && dy == 0) || xx < 0 || xx >= grid.x) continue;
      ivec2 cj = ivec2(xx, yy);
      float dj = depthAt(cj);
      bool differs = isinf(dj) || dj > farther;
      if (!differs && yy * grid.x + xx > i && abs(dj - d) < d * (DEPTH_RATIO - 1.0) + DEPTH_MARGIN) {
        differs = dot(n, normalAt(cj)) < CREASE_DOT;
      }
      if (!differs) continue;
      float w = dx != 0 && dy != 0 ? 0.7 : 1.0;
      vx += float(dx) * w;
      vy += float(dy) * w;
      if (dy == 0) sideways++;
      if (dx == 0) upDown++;
    }
  }
  if (vx == 0.0 && vy == 0.0 && sideways == 0 && upDown == 0) return 0;
  if (abs(vx) + abs(vy) < 0.3) return sideways >= upDown ? 1 : 4;
  float a = atan(vy, vx);
  if (a < 0.0) a += PI;
  if (a >= PI) a -= PI;
  if (a < PI / 8.0 || a > 7.0 * PI / 8.0) return 1;
  if (a < 3.0 * PI / 8.0) return 2;
  if (a < 5.0 * PI / 8.0) return vy > 0.0 ? 5 : 4;
  return 3;
}

bool isLight(vec3 c) { return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z > 100.0; }

void main() {
  ivec2 p = pixel();
  ivec2 c = p / cellSize;
  vec3 skyBytes = sky.rgb * 255.0;
  if (c.x >= grid.x || c.y >= grid.y) {
    color = vec4(sky.rgb, 1.0);
    return;
  }
  // pickGlyphs() and cellColors() in cellStyle.ts.
  int cellInk = int(texelFetch(ink, c, 0).r * 255.0 + 0.5);
  int glyph = cellInk == 0 ? 0 : shadeGlyph(cellInk, c);
  float edge = 0.0;
  float d = depthAt(c);
  if ((flags & ${FLAGS.outlines}) != 0 && !isinf(d)) {
    int code = outline(c);
    if (code != 0) {
      float strength = 1.0 - clamp((d - look.x) / (look.y - look.x), 0.0, 1.0);
      if (strength >= MIN_OUTLINE_STRENGTH) {
        glyph = OUTLINE_GLYPH + code - 1;
        edge = strength;
      }
    }
  }
  if (glyph == 0) {
    color = vec4(sky.rgb, 1.0);
    return;
  }
  bool colored = (flags & ${FLAGS.color}) != 0;
  bool backgrounds = colored && (flags & ${FLAGS.cellBackground}) != 0;
  vec3 surface = colored ? round(texelFetch(rgb, c, 0).rgb * 255.0) : MONO;
  vec3 bg = backgrounds ? surface : skyBytes;
  bool light = isLight(surface);
  vec3 fg = surface;
  if (edge > 0.0 && colored) {
    fg = light ? surface * (1.0 - 0.7 * edge) : surface + (255.0 - surface) * 0.5 * edge;
  }
  else if (backgrounds) {
    fg = light ? surface * (1.0 - 0.4 * look.z) : surface + (255.0 - surface) * 0.35 * look.z;
  }
  fg = floor(fg);
  color = vec4(mix(bg, fg, coverage(glyph, p, c)) / 255.0, 1.0);
}`

export interface TracedStyle {
  color: boolean
  cellBackground: boolean
  outlines: boolean
  fogNear: number
  fogFar: number
  /** How strongly glyphs stand out from their cell's background, 0..1. */
  shade: number
}

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
  const vertex = compile(gl.VERTEX_SHADER, VERTEX)
  /** Links a program and binds its samplers to texture units, in the order given. */
  const link = (fragment: string, samplers: string[]) => {
    const program = gl.createProgram()
    gl.attachShader(program, vertex)
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'glyph program')
    gl.useProgram(program)
    const at = (name: string) => gl.getUniformLocation(program, name)
    samplers.forEach((name, unit) => gl.uniform1i(at(name), unit))
    return { program, at }
  }
  const styled = link(STYLED, ['atlas', 'cells'])
  const traced = link(TRACED, ['atlas', 'ink', 'rgb', 'depths', 'normals'])
  const tracedUniforms = { flags: traced.at('flags'), look: traced.at('look'), sky: traced.at('sky') }
  const styledSky = styled.at('sky')
  gl.bindVertexArray(gl.createVertexArray())
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

  const texture = () => {
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    return t
  }
  /** Binds `t` to texture unit `unit` and uploads `data` into it. */
  const upload = (unit: number, t: WebGLTexture, internal: number, w: number, h: number, format: number, type: number, data: ArrayBufferView) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data)
  }
  const atlasTexture = texture()
  const cellTexture = texture()
  const inkTexture = texture()
  const rgbTexture = texture()
  const depthTexture = texture()
  const normalTexture = texture()
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
      upload(0, atlasTexture, gl.R8, atlasWidth, cellH, gl.RED, gl.UNSIGNED_BYTE, atlas)
      for (const { program, at } of [styled, traced]) {
        gl.useProgram(program)
        gl.uniform2i(at('cellSize'), cellW, cellH)
        gl.uniform2i(at('grid'), cols, rows)
        gl.uniform1i(at('frameHeight'), height)
      }
    },
    /** `cells`: 8 bytes per cell, see the STYLED shader. */
    draw(cells: Uint8Array, sky: readonly number[], skyAlpha: number) {
      gl.useProgram(styled.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture)
      upload(1, cellTexture, gl.RGBA8, cols * 2, rows, gl.RGBA, gl.UNSIGNED_BYTE, cells)
      gl.uniform4f(styledSky, sky[0]! / 255, sky[1]! / 255, sky[2]! / 255, skyAlpha)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    /** A traced frame as it is: the shader picks glyphs, outlines and colors. */
    drawTraced(frame: Cells, style: TracedStyle, sky: readonly number[]) {
      gl.useProgram(traced.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture)
      upload(1, inkTexture, gl.R8, cols, rows, gl.RED, gl.UNSIGNED_BYTE, frame.ink)
      upload(2, rgbTexture, gl.RGB8, cols, rows, gl.RGB, gl.UNSIGNED_BYTE, frame.rgb)
      upload(3, depthTexture, gl.R32F, cols, rows, gl.RED, gl.FLOAT, frame.depths)
      upload(4, normalTexture, gl.RGB8_SNORM, cols, rows, gl.RGB, gl.BYTE, frame.normals)
      const flags = (style.color ? FLAGS.color : 0) | (style.cellBackground ? FLAGS.cellBackground : 0) | (style.outlines ? FLAGS.outlines : 0)
      gl.uniform1i(tracedUniforms.flags, flags)
      gl.uniform3f(tracedUniforms.look, style.fogNear, style.fogFar, style.shade)
      gl.uniform4f(tracedUniforms.sky, sky[0]! / 255, sky[1]! / 255, sky[2]! / 255, 1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    /** Leaves the canvas transparent, for when the 2D canvas underneath draws instead. */
    clear() {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    },
  }
}
