/**
 * Draws the ray tracer's output buffer (see raytrace.wgsl.ts) straight onto a WebGPU canvas,
 * one traced cell per pixel: the full-resolution view. Nothing is read back to the CPU. When
 * fewer cells were traced than the canvas has pixels (while dragging), each pixel takes its
 * nearest cell.
 */
export const PRESENT_WGSL = /* wgsl */ `
struct Present {
  grid: vec4f, // traced cols, rows; canvas width, height in pixels
  sky: vec4f,  // sky color, sRGB 0..1
}

@group(0) @binding(0) var<uniform> V: Present;
@group(0) @binding(1) var<storage, read> cells: array<u32>;

// One triangle that covers the whole screen.
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let cols = u32(V.grid.x);
  let rows = u32(V.grid.y);
  let x = min(u32(pos.x * V.grid.x / V.grid.z), cols - 1u);
  let y = min(u32(pos.y * V.grid.y / V.grid.w), rows - 1u);
  let i = y * cols + x;
  if (cells[i * 3u + 1u] == 0x7f800000u) { return vec4f(V.sky.rgb, 1.0); }
  let c = cells[i * 3u];
  return vec4f(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u), 255.0) / 255.0;
}
`
