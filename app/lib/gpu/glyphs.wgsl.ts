/**
 * Draws the ray tracer's output buffer (see raytrace.wgsl.ts) as characters, without it ever
 * leaving the GPU. Two passes, the same steps as the CPU path (cellStyle.ts, outlines.ts,
 * glyphGl.ts):
 * - `style`, one invocation per traced cell: picks the glyph (shading or an outline
 *   character) and the cell's foreground and background color.
 * - `vs`/`fs`, one fragment per canvas pixel: finds the pixel's cell and blends its colors by
 *   the glyph's coverage in the atlas. While dragging, fewer cells were traced than the grid
 *   has: each grid cell takes its nearest traced cell, as upscaleFrame does.
 *
 * Stretched contrast and the lens still go through the CPU, which needs the whole frame.
 */
import { DITHER_STEP, MIN_OUTLINE_STRENGTH, MONO, RAMP } from '../cellStyle'
import { CREASE_DOT, DEPTH_MARGIN, DEPTH_RATIO } from '../outlines'

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n))

export const GLYPH_WORKGROUP = 8

/** Bits of Glyphs.traced.z. */
export const GLYPH_FLAGS = { color: 1, cellBackground: 2, outlines: 4 }

export const GLYPHS_WGSL = /* wgsl */ `
struct Glyphs {
  traced: vec4u, // traced cols, rows; flags (GLYPH_FLAGS)
  grid: vec4u,   // cell width, height in canvas pixels; grid cols, rows
  look: vec4f,   // fog near, far; glyph shade
  sky: vec4f,    // sky color, 0..255
}

@group(0) @binding(0) var<uniform> G: Glyphs;
// The tracer's output: rgb + ink bytes, depth bits, normal bytes.
@group(0) @binding(1) var<storage, read> cells: array<u32>;
// Two words per traced cell: foreground rgb + glyph, background rgb.
@group(0) @binding(2) var<storage, read_write> styledOut: array<u32>;
@group(0) @binding(3) var<storage, read> styled: array<u32>;
@group(0) @binding(4) var atlas: texture_2d<f32>;

const RAMP_LENGTH = ${RAMP.length}u;
const SKY_BITS = 0x7f800000u;
const DEPTH_RATIO = ${f(DEPTH_RATIO)};
const DEPTH_MARGIN = ${f(DEPTH_MARGIN)};
const CREASE_DOT = ${f(CREASE_DOT)};
const MIN_OUTLINE_STRENGTH = ${f(MIN_OUTLINE_STRENGTH)};
const MONO = vec3f(${MONO.map(f).join(', ')});
const PI = 3.141592653589793;

// dither() in cellStyle.ts.
fn dither(x: u32, y: u32) -> i32 {
  var h = (x * 0x27D4EB2Du) ^ (y * 0x165667B1u);
  h = (h ^ (h >> 15u)) * 0x2C1B3C6Du;
  h ^= h >> 12u;
  return i32(floor((f32(h & 0xFFFFu) / 65536.0 - 0.5) * ${f(DITHER_STEP)} + 0.5));
}

fn normalAt(i: u32) -> vec3f {
  let n = i32(cells[i * 3u + 2u]);
  return vec3f(f32(extractBits(n, 0u, 8u)), f32(extractBits(n, 8u, 8u)), f32(extractBits(n, 16u, 8u)));
}

// findOutlines() in outlines.ts, for one cell: 0 for none, else 1..5 for OUTLINE_CHARS.
fn outline(x: i32, y: i32, cols: i32, rows: i32) -> u32 {
  let i = y * cols + x;
  let d = bitcast<f32>(cells[u32(i) * 3u + 1u]);
  let n = normalAt(u32(i));
  let farther = d * DEPTH_RATIO + DEPTH_MARGIN;
  var vx = 0.0;
  var vy = 0.0;
  var sideways = 0u;
  var upDown = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    let yy = y + dy;
    if (yy < 0 || yy >= rows) { continue; }
    for (var dx = -1; dx <= 1; dx++) {
      let xx = x + dx;
      if ((dx == 0 && dy == 0) || xx < 0 || xx >= cols) { continue; }
      let j = yy * cols + xx;
      let bits = cells[u32(j) * 3u + 1u];
      let dj = bitcast<f32>(bits);
      var differs = bits == SKY_BITS || dj > farther;
      if (!differs && j > i && abs(dj - d) < d * (DEPTH_RATIO - 1.0) + DEPTH_MARGIN) {
        differs = dot(n, normalAt(u32(j))) < CREASE_DOT;
      }
      if (!differs) { continue; }
      let w = select(1.0, 0.7, dx != 0 && dy != 0);
      vx += f32(dx) * w;
      vy += f32(dy) * w;
      if (dy == 0) { sideways++; }
      if (dx == 0) { upDown++; }
    }
  }
  if (vx == 0.0 && vy == 0.0 && sideways == 0u && upDown == 0u) { return 0u; }
  if (abs(vx) + abs(vy) < 0.3) { return select(4u, 1u, sideways >= upDown); }
  var a = atan2(vy, vx);
  if (a < 0.0) { a += PI; }
  if (a >= PI) { a -= PI; }
  if (a < PI / 8.0 || a > 7.0 * PI / 8.0) { return 1u; }
  if (a < 3.0 * PI / 8.0) { return 2u; }
  if (a < 5.0 * PI / 8.0) { return select(4u, 5u, vy > 0.0); }
  return 3u;
}

fn isLight(c: vec3f) -> bool {
  return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z > 100.0;
}

fn pack(c: vec3f, w: u32) -> u32 {
  let b = vec3u(clamp(floor(c), vec3f(0.0), vec3f(255.0)));
  return b.x | (b.y << 8u) | (b.z << 16u) | (w << 24u);
}

// pickGlyphs() and cellColors() in cellStyle.ts, for one traced cell.
@compute @workgroup_size(${GLYPH_WORKGROUP}, ${GLYPH_WORKGROUP})
fn style(@builtin(global_invocation_id) id: vec3u) {
  let cols = G.traced.x;
  let rows = G.traced.y;
  if (id.x >= cols || id.y >= rows) { return; }
  let i = id.y * cols + id.x;
  let flags = G.traced.z;
  let c = cells[i * 3u];
  var glyph = min(RAMP_LENGTH - 1u, ((c >> 24u) * RAMP_LENGTH) / 255u);
  if (glyph != 0u) {
    let dithered = u32(clamp(i32(c >> 24u) + dither(id.x, id.y), 1, 255));
    glyph = max(1u, min(RAMP_LENGTH - 1u, (dithered * RAMP_LENGTH) / 255u));
  }
  var edge = 0.0;
  if ((flags & ${GLYPH_FLAGS.outlines}u) != 0u && cells[i * 3u + 1u] != SKY_BITS) {
    let code = outline(i32(id.x), i32(id.y), i32(cols), i32(rows));
    if (code != 0u) {
      let d = bitcast<f32>(cells[i * 3u + 1u]);
      let strength = 1.0 - clamp((d - G.look.x) / (G.look.y - G.look.x), 0.0, 1.0);
      if (strength >= MIN_OUTLINE_STRENGTH) {
        glyph = RAMP_LENGTH + code - 1u;
        edge = strength;
      }
    }
  }
  if (glyph == 0u) {
    styledOut[i * 2u] = pack(G.sky.xyz, 0u);
    styledOut[i * 2u + 1u] = pack(G.sky.xyz, 0u);
    return;
  }

  let color = (flags & ${GLYPH_FLAGS.color}u) != 0u;
  let backgrounds = color && (flags & ${GLYPH_FLAGS.cellBackground}u) != 0u;
  let surface = select(MONO, vec3f(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u)), color);
  let bg = select(G.sky.xyz, surface, backgrounds);
  let light = isLight(surface);
  var fg = surface;
  if (edge > 0.0 && color) {
    fg = select(surface + (255.0 - surface) * 0.5 * edge, surface * (1.0 - 0.7 * edge), light);
  }
  else if (backgrounds) {
    let shade = G.look.z;
    fg = select(surface + (255.0 - surface) * 0.35 * shade, surface * (1.0 - 0.4 * shade), light);
  }
  styledOut[i * 2u] = pack(fg, glyph);
  styledOut[i * 2u + 1u] = pack(bg, 0u);
}

// One triangle that covers the whole screen.
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

fn unpack(w: u32) -> vec3f {
  return vec3f(f32(w & 255u), f32((w >> 8u) & 255u), f32((w >> 16u) & 255u)) / 255.0;
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2u(pos.xy);
  let size = G.grid.xy;
  let cell = p / size;
  if (cell.x >= G.grid.z || cell.y >= G.grid.w) { return vec4f(G.sky.xyz / 255.0, 1.0); }
  let t = min(cell * G.traced.xy / G.grid.zw, G.traced.xy - 1u);
  let i = t.y * G.traced.x + t.x;
  let fg = styled[i * 2u];
  let local = p - cell * size;
  let a = textureLoad(atlas, vec2u((fg >> 24u) * size.x + local.x, local.y), 0).r;
  return vec4f(mix(unpack(styled[i * 2u + 1u]), unpack(fg), a), 1.0);
}
`
