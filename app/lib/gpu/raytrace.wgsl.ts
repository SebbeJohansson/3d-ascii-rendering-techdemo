/**
 * The ray tracer of lib/raycaster.ts as a WebGPU compute shader: one invocation per character
 * cell, the same steps in the same order, so both produce (nearly) the same frame. Kept close
 * to the TypeScript on purpose; when one changes, change the other.
 *
 * Buffers (see gpuTracer.ts for how they're packed):
 *   prims    10 floats per primitive: bounds (min xyz, max xyz), albedo rgb, shape + 256·windows
 *   grid     cellStart (cells² + 1 entries), then cellItems
 *   meshF    the environment's merged mesh: BVH node bounds, positions, normals, albedo
 *   meshU    its BVH nodes, triangle order and indices
 *   playerF  / playerU: the same for the spawned player, in its own space
 *   cells    output, 3 words per cell: rgb + ink bytes, view depth bits, normal bytes
 */
import { AO_DIRS, AO_RADIUS, AO_STRENGTH } from '../raycaster'
import { FLOOR_HEIGHT, GLASS_X, GLASS_Y, HASH_COLUMN, HASH_FACE, HASH_ROW, LIT_SHARE, WINDOW_SPACING } from '../windows'

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`)

export const RAYTRACE_WGSL = /* wgsl */ `
struct Params {
  camPos: vec4f,      // w: tan(fov / 2)
  forward: vec4f,     // w: aspect
  right: vec4f,       // w: half the environment's extent
  up: vec4f,          // w: maxHeight
  sun: vec4f,         // w: grid cell size
  sunLight: vec4f,    // w: fogNear
  hemiSky: vec4f,     // w: fogFar
  hemiGround: vec4f,  // w: night
  sky: vec4f,         // w: maxLight
  windowGlow: vec4f,  // w: minLight
  ground: vec4f,
  player: vec4f,      // xyz: position, w: scale
  playerRot: vec4f,   // x: cos(heading), y: sin(heading)
  dims: vec4u,        // cols, rows, grid cells per side, primitive count
  mesh: vec4u,        // meshF offsets: positions, normals, albedo; w: 1 if there is a mesh
  meshIdx: vec4u,     // meshU offsets: order, indices
  player2: vec4u,     // playerF offsets: positions, normals, albedo; w: 1 if there is a player
  playerIdx: vec4u,   // playerU offsets: order, indices
  gridItems: vec4u,   // x: offset of cellItems in grid; y: 1 for ambient occlusion
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> prims: array<f32>;
@group(0) @binding(2) var<storage, read> grid: array<u32>;
@group(0) @binding(3) var<storage, read> meshF: array<f32>;
@group(0) @binding(4) var<storage, read> meshU: array<u32>;
@group(0) @binding(5) var<storage, read> playerF: array<f32>;
@group(0) @binding(6) var<storage, read> playerU: array<u32>;
@group(0) @binding(7) var<storage, read_write> cells: array<u32>;

const EPS = 1e-4;
const INF = 3.0e38;
const GROUND = -1;
const MISS = -2;
const MESH = -3;
const PLAYER = -4;
const BOX = 0u;
const CYLINDER = 1u;
const CONE = 2u;
const MIN_INK = 0.25;

struct Hit {
  t: f32,
  prim: i32,
  n: vec3f,
  tri: u32,
  u: f32,
  v: f32,
}

// Inverse direction, with 1e-12 standing in for 0 like the TypeScript.
fn inverse(d: vec3f) -> vec3f {
  return 1.0 / select(d, vec3f(1e-12), d == vec3f(0.0));
}

// ---- BVH (lib/bvh.ts), for the environment's mesh (player = false) or the player's. ----

fn bvhBound(player: bool, i: u32) -> f32 {
  if (player) { return playerF[i]; }
  return meshF[i];
}

fn bvhPos(player: bool, i: u32) -> vec3f {
  if (player) { return vec3f(playerF[i], playerF[i + 1u], playerF[i + 2u]); }
  return vec3f(meshF[i], meshF[i + 1u], meshF[i + 2u]);
}

fn bvhU(player: bool, i: u32) -> u32 {
  if (player) { return playerU[i]; }
  return meshU[i];
}

// Nearest triangle hit closer than maxT (returns maxT if none); fills tri/u/v of h.
fn intersectBvh(player: bool, o: vec3f, d: vec3f, maxT: f32, anyHit: bool, h: ptr<function, Hit>) -> f32 {
  var posOff = P.mesh.x;
  var orderOff = P.meshIdx.x;
  var idxOff = P.meshIdx.y;
  if (player) {
    posOff = P.player2.x;
    orderOff = P.playerIdx.x;
    idxOff = P.playerIdx.y;
  }
  let inv = inverse(d);
  var best = maxT;
  var stack: array<u32, 64>;
  var top = 1u;
  stack[0] = 0u;
  loop {
    if (top == 0u) { break; }
    top -= 1u;
    let node = stack[top];
    let o6 = node * 6u;
    let bmin = vec3f(bvhBound(player, o6), bvhBound(player, o6 + 1u), bvhBound(player, o6 + 2u));
    let bmax = vec3f(bvhBound(player, o6 + 3u), bvhBound(player, o6 + 4u), bvhBound(player, o6 + 5u));
    let a = (bmin - o) * inv;
    let b = (bmax - o) * inv;
    let lo = min(a, b);
    let hi = max(a, b);
    let near = max(max(lo.x, lo.y), lo.z);
    let far = min(min(hi.x, hi.y), hi.z);
    if (near > far || far < 0.0 || near >= best) { continue; }

    let count = bvhU(player, node * 2u + 1u);
    if (count == 0u) {
      let left = bvhU(player, node * 2u);
      stack[top] = left + 1u;
      stack[top + 1u] = left;
      top += 2u;
      continue;
    }
    let first = bvhU(player, node * 2u);
    for (var k = first; k < first + count; k++) {
      let tri = bvhU(player, orderOff + k);
      let p0 = bvhPos(player, posOff + bvhU(player, idxOff + tri * 3u) * 3u);
      let p1 = bvhPos(player, posOff + bvhU(player, idxOff + tri * 3u + 1u) * 3u);
      let p2 = bvhPos(player, posOff + bvhU(player, idxOff + tri * 3u + 2u) * 3u);
      let e1 = p1 - p0;
      let e2 = p2 - p0;
      let pv = cross(d, e2);
      let det = dot(e1, pv);
      if (abs(det) < 1e-12) { continue; }
      let invDet = 1.0 / det;
      let tv = o - p0;
      let u = dot(tv, pv) * invDet;
      if (u < 0.0 || u > 1.0) { continue; }
      let q = cross(tv, e1);
      let v = dot(d, q) * invDet;
      if (v < 0.0 || u + v > 1.0) { continue; }
      let t = dot(e2, q) * invDet;
      if (t <= EPS || t >= best) { continue; }
      best = t;
      (*h).tri = tri;
      (*h).u = u;
      (*h).v = v;
      if (anyHit) { return best; }
    }
  }
  return best;
}

// ---- Primitives (the hit* functions in raycaster.ts). Each returns normal xyz and t in w. ----

fn primBounds(p: u32) -> array<f32, 6> {
  let o = p * 10u;
  return array<f32, 6>(prims[o], prims[o + 1u], prims[o + 2u], prims[o + 3u], prims[o + 4u], prims[o + 5u]);
}

fn hitDisc(capY: f32, ny: f32, r: f32, X: f32, oy: f32, Z: f32, d: vec3f, best: vec4f) -> vec4f {
  let t = (capY - oy) / d.y;
  if (t > EPS && t < best.w) {
    let px = X + t * d.x;
    let pz = Z + t * d.z;
    if (px * px + pz * pz <= r * r) { return vec4f(0.0, ny, 0.0, t); }
  }
  return best;
}

fn hitCylinder(b: array<f32, 6>, o: vec3f, d: vec3f) -> vec4f {
  let r = (b[3] - b[0]) / 2.0;
  let X = o.x - (b[0] + r);
  let Z = o.z - (b[2] + b[5]) / 2.0;
  let y0 = b[1];
  let y1 = b[4];
  var best = vec4f(0.0, 0.0, 0.0, INF);
  let a = d.x * d.x + d.z * d.z;
  if (a > 1e-12) {
    let hb = X * d.x + Z * d.z;
    let disc = hb * hb - a * (X * X + Z * Z - r * r);
    if (disc >= 0.0) {
      let sq = sqrt(disc);
      var t = (-hb - sq) / a;
      var y = o.y + t * d.y;
      if (t <= EPS || y < y0 || y > y1) {
        t = (-hb + sq) / a;
        y = o.y + t * d.y;
      }
      if (t > EPS && y >= y0 && y <= y1) {
        best = vec4f((X + t * d.x) / r, 0.0, (Z + t * d.z) / r, t);
      }
    }
  }
  if (d.y != 0.0) {
    best = hitDisc(y1, 1.0, r, X, o.y, Z, d, best);
    best = hitDisc(y0, -1.0, r, X, o.y, Z, d, best);
  }
  return best;
}

fn coneSide(t: f32, X: f32, Z: f32, oy: f32, d: vec3f, y0: f32, y1: f32, k: f32) -> vec4f {
  let miss = vec4f(0.0, 0.0, 0.0, INF);
  if (!(t > EPS)) { return miss; }
  let py = oy + t * d.y;
  if (py < y0 || py > y1) { return miss; }
  let px = X + t * d.x;
  let pz = Z + t * d.z;
  let ny = k * k * (y1 - py);
  var len = length(vec3f(px, ny, pz));
  if (len == 0.0) { len = 1.0; }
  return vec4f(px / len, ny / len, pz / len, t);
}

fn hitCone(b: array<f32, 6>, o: vec3f, d: vec3f) -> vec4f {
  let r = (b[3] - b[0]) / 2.0;
  let X = o.x - (b[0] + r);
  let Z = o.z - (b[2] + b[5]) / 2.0;
  let y0 = b[1];
  let y1 = b[4];
  let k = r / (y1 - y0);
  let k2 = k * k;
  let Y = y1 - o.y;
  var best = vec4f(0.0, 0.0, 0.0, INF);
  let a = d.x * d.x + d.z * d.z - k2 * d.y * d.y;
  let hb = X * d.x + Z * d.z + k2 * Y * d.y;
  let c = X * X + Z * Z - k2 * Y * Y;
  if (abs(a) > 1e-12) {
    let disc = hb * hb - a * c;
    if (disc >= 0.0) {
      let sq = sqrt(disc);
      let t1 = (-hb - sq) / a;
      let t2 = (-hb + sq) / a;
      best = coneSide(min(t1, t2), X, Z, o.y, d, y0, y1, k);
      if (best.w >= INF) { best = coneSide(max(t1, t2), X, Z, o.y, d, y0, y1, k); }
    }
  }
  else if (hb != 0.0) {
    best = coneSide(-c / (2.0 * hb), X, Z, o.y, d, y0, y1, k);
  }
  if (d.y != 0.0) { best = hitDisc(y0, -1.0, r, X, o.y, Z, d, best); }
  return best;
}

fn hitSphere(b: array<f32, 6>, o: vec3f, d: vec3f) -> vec4f {
  let rad = vec3f(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2.0;
  let P0 = (o - vec3f(b[0], b[1], b[2]) - rad) / rad;
  let D = d / rad;
  let a = dot(D, D);
  let hb = dot(P0, D);
  let disc = hb * hb - a * (dot(P0, P0) - 1.0);
  let miss = vec4f(0.0, 0.0, 0.0, INF);
  if (disc < 0.0) { return miss; }
  let sq = sqrt(disc);
  var t = (-hb - sq) / a;
  if (t <= EPS) { t = (-hb + sq) / a; }
  if (t <= EPS) { return miss; }
  let n = normalize((P0 + t * D) / rad);
  return vec4f(n, t);
}

// ---- trace() ----

fn trace(o: vec3f, d: vec3f, anyHit: bool, maxT: f32) -> Hit {
  var h: Hit;
  h.prim = MISS;
  var best = maxT;

  // The player first, in its own space: undo position, heading and scale.
  if (P.player2.w == 1u) {
    let k = 1.0 / P.player.w;
    let c = P.playerRot.x;
    let s = P.playerRot.y;
    let rx = o.x - P.player.x;
    let rz = o.z - P.player.z;
    let lo = vec3f((rx * c - rz * s) * k, (o.y - P.player.y) * k, (rx * s + rz * c) * k);
    let ld = vec3f((d.x * c - d.z * s) * k, d.y * k, (d.x * s + d.z * c) * k);
    let t = intersectBvh(true, lo, ld, best, anyHit, &h);
    if (t < best) {
      h.prim = PLAYER;
      if (anyHit) { return h; }
      best = t;
    }
  }

  // Clip the ray to the environment's bounding box.
  let inv = inverse(d);
  let half = P.right.w;
  var t0 = 0.0;
  var t1 = maxT;
  var a = (-half - o.x) * inv.x;
  var b = (half - o.x) * inv.x;
  t0 = max(t0, min(a, b));
  t1 = min(t1, max(a, b));
  a = (0.0 - o.y) * inv.y;
  b = (P.up.w - o.y) * inv.y;
  t0 = max(t0, min(a, b));
  t1 = min(t1, max(a, b));
  a = (-half - o.z) * inv.z;
  b = (half - o.z) * inv.z;
  t0 = max(t0, min(a, b));
  t1 = min(t1, max(a, b));
  if (t0 > t1) {
    h.t = best;
    return h;
  }

  if (!anyHit && d.y < 0.0) {
    let tg = -o.y * inv.y;
    if (tg >= t0 && tg <= t1 && tg < best) {
      best = tg;
      h.prim = GROUND;
      h.n = vec3f(0.0, 1.0, 0.0);
    }
  }

  if (P.mesh.w == 1u) {
    let t = intersectBvh(false, o, d, best, anyHit, &h);
    if (t < best) {
      h.prim = MESH;
      if (anyHit) { return h; }
      best = t;
    }
  }

  if (P.dims.w == 0u) {
    h.t = best;
    return h;
  }

  // 2D DDA across grid cells, starting where the ray enters the environment.
  let cellsN = i32(P.dims.z);
  let cellSize = P.sun.w;
  var cx = clamp(i32(floor((o.x + d.x * t0 + half) / cellSize)), 0, cellsN - 1);
  var cz = clamp(i32(floor((o.z + d.z * t0 + half) / cellSize)), 0, cellsN - 1);
  let stepX = select(-1, 1, d.x > 0.0);
  let stepZ = select(-1, 1, d.z > 0.0);
  var tMaxX = (f32(cx + select(0, 1, d.x > 0.0)) * cellSize - half - o.x) * inv.x;
  var tMaxZ = (f32(cz + select(0, 1, d.z > 0.0)) * cellSize - half - o.z) * inv.z;
  let tDeltaX = cellSize * abs(inv.x);
  let tDeltaZ = cellSize * abs(inv.z);

  loop {
    let cell = u32(cx * cellsN + cz);
    for (var k = grid[cell]; k < grid[cell + 1u]; k++) {
      let p = grid[P.gridItems.x + k];
      let bb = primBounds(p);
      var near = -INF;
      var far = INF;
      var axis = 0;
      a = (bb[0] - o.x) * inv.x;
      b = (bb[3] - o.x) * inv.x;
      if (min(a, b) > near) { near = min(a, b); axis = 0; }
      far = min(far, max(a, b));
      a = (bb[1] - o.y) * inv.y;
      b = (bb[4] - o.y) * inv.y;
      if (min(a, b) > near) { near = min(a, b); axis = 1; }
      far = min(far, max(a, b));
      a = (bb[2] - o.z) * inv.z;
      b = (bb[5] - o.z) * inv.z;
      if (min(a, b) > near) { near = min(a, b); axis = 2; }
      far = min(far, max(a, b));
      if (near > far || far <= EPS || near >= best) { continue; }

      let shape = u32(prims[p * 10u + 9u]) & 255u;
      var hitT: vec4f;
      if (shape == BOX) {
        if (near <= EPS) { continue; }
        var sgn = 1.0;
        if (axis == 0) { sgn = -sign(d.x); }
        else if (axis == 1) { sgn = -sign(d.y); }
        else { sgn = -sign(d.z); }
        hitT = vec4f(select(0.0, sgn, axis == 0), select(0.0, sgn, axis == 1), select(0.0, sgn, axis == 2), near);
      }
      else {
        if (shape == CYLINDER) { hitT = hitCylinder(bb, o, d); }
        else if (shape == CONE) { hitT = hitCone(bb, o, d); }
        else { hitT = hitSphere(bb, o, d); }
        if (hitT.w >= best) { continue; }
      }

      h.prim = i32(p);
      if (anyHit) { return h; }
      best = hitT.w;
      h.n = hitT.xyz;
    }

    let cellExit = min(min(tMaxX, tMaxZ), t1);
    if (best <= cellExit || cellExit >= t1) { break; }
    if (tMaxX < tMaxZ) {
      cx += stepX;
      tMaxX += tDeltaX;
    }
    else {
      cz += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (cx < 0 || cx >= cellsN || cz < 0 || cz >= cellsN) { break; }
  }

  h.t = best;
  return h;
}

// ---- Ambient occlusion (ambientOcclusion() in raycaster.ts) ----

const AO_RADIUS = ${f(AO_RADIUS)};
const AO_STRENGTH = ${f(AO_STRENGTH)};
var<private> AO_DIRS: array<vec3f, ${AO_DIRS.length}> = array<vec3f, ${AO_DIRS.length}>(${AO_DIRS.map(d => `vec3f(${d.map(f).join(', ')})`).join(', ')});

fn ambientOcclusion(p: vec3f, n: vec3f) -> f32 {
  let sgn = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (sgn + n.z);
  let b = n.x * n.y * a;
  let tan1 = vec3f(1.0 + sgn * n.x * n.x * a, sgn * b, -sgn * n.x);
  let tan2 = vec3f(b, sgn + n.y * n.y * a, -n.y);
  var blocked = 0.0;
  for (var k = 0u; k < ${AO_DIRS.length}u; k++) {
    let l = AO_DIRS[k];
    let d = tan1 * l.x + tan2 * l.y + n * l.z;
    if ((d.y < 0.0 && p.y + d.y * AO_RADIUS < 0.0) || trace(p, d, true, AO_RADIUS).prim != MISS) { blocked += 1.0; }
  }
  return 1.0 - AO_STRENGTH * (blocked / ${f(AO_DIRS.length)});
}

// ---- Shading (renderScene() in raycaster.ts) ----

// The CPU converts through a 4096-step table; quantize the same way so bytes match.
fn srgbByte(c: f32) -> u32 {
  let q = round(clamp(c, 0.0, 1.0) * 4096.0) / 4096.0;
  var s: f32;
  if (q <= 0.0031308) { s = q * 12.92; } else { s = 1.055 * pow(q, 1.0 / 2.4) - 0.055; }
  return u32(round(255.0 * s));
}

fn luminance(c: vec3f) -> f32 {
  return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
}

// windowLit() of lib/windows.ts.
fn windowLit(face: f32, u: f32, y: f32) -> bool {
  let fy = y / ${f(FLOOR_HEIGHT)};
  let row = floor(fy);
  let fx = u / ${f(WINDOW_SPACING)};
  let column = floor(fx);
  let gx = fx - column;
  let gy = fy - row;
  if (gx < ${f(GLASS_X[0])} || gx > ${f(GLASS_X[1])} || gy < ${f(GLASS_Y[0])} || gy > ${f(GLASS_Y[1])}) { return false; }
  var p = fract((row * ${f(HASH_ROW)} + column * ${f(HASH_COLUMN)} + face * ${f(HASH_FACE)}) * 0.1031);
  p = p * (p + 33.33);
  p = p * (p + p);
  return fract(p) <= ${f(LIT_SHARE)};
}

fn blend3(player: bool, off: u32, i0: u32, i1: u32, i2: u32, w0: f32, w1: f32, w2: f32) -> vec3f {
  return bvhPos(player, off + i0) * w0 + bvhPos(player, off + i1) * w1 + bvhPos(player, off + i2) * w2;
}

fn toByte(v: f32) -> u32 {
  return u32(i32(trunc(v))) & 255u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let cols = P.dims.x;
  let rows = P.dims.y;
  if (id.x >= cols || id.y >= rows) { return; }
  let i = id.y * cols + id.x;
  let tanHalf = P.camPos.w;
  let sy = (1.0 - ((f32(id.y) + 0.5) / f32(rows)) * 2.0) * tanHalf;
  let sx = (((f32(id.x) + 0.5) / f32(cols)) * 2.0 - 1.0) * tanHalf * P.forward.w;
  let f = P.forward.xyz;
  let d = normalize(f + P.right.xyz * sx + P.up.xyz * sy);
  let o = P.camPos.xyz;

  let h = trace(o, d, false, INF);
  if (h.prim == MISS) {
    cells[i * 3u] = 0u;
    cells[i * 3u + 1u] = 0x7f800000u; // +Infinity: sky
    cells[i * 3u + 2u] = 0u;
    return;
  }

  let t = h.t;
  var n = h.n;
  var albedo: vec3f;
  var emit = vec3f(0.0);
  if (h.prim == MESH || h.prim == PLAYER) {
    let player = h.prim == PLAYER;
    var idxOff = P.meshIdx.y;
    var normOff = P.mesh.y;
    var albOff = P.mesh.z;
    if (player) {
      idxOff = P.playerIdx.y;
      normOff = P.player2.y;
      albOff = P.player2.z;
    }
    let i0 = bvhU(player, idxOff + h.tri * 3u) * 3u;
    let i1 = bvhU(player, idxOff + h.tri * 3u + 1u) * 3u;
    let i2 = bvhU(player, idxOff + h.tri * 3u + 2u) * 3u;
    let w1 = h.u;
    let w2 = h.v;
    let w0 = 1.0 - w1 - w2;
    n = blend3(player, normOff, i0, i1, i2, w0, w1, w2);
    if (player) {
      let c = P.playerRot.x;
      let s = P.playerRot.y;
      n = vec3f(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
    }
    var nl = length(n);
    if (nl == 0.0) { nl = 1.0; }
    n = n * select(1.0 / nl, -1.0 / nl, dot(n, d) > 0.0);
    albedo = blend3(player, albOff, i0, i1, i2, w0, w1, w2);
  }
  else if (h.prim == GROUND) {
    albedo = P.ground.xyz;
  }
  else {
    let p = u32(h.prim);
    albedo = vec3f(prims[p * 10u + 6u], prims[p * 10u + 7u], prims[p * 10u + 8u]);
    let windows = (u32(prims[p * 10u + 9u]) >> 8u) != 0u;
    if (P.hemiGround.w > 0.0 && windows && n.y == 0.0) {
      var face = 3.0;
      if (n.x > 0.0) { face = 0.0; } else if (n.x < 0.0) { face = 1.0; } else if (n.z > 0.0) { face = 2.0; }
      let hp = o + d * t;
      if (windowLit(face, select(hp.x, hp.z, n.x != 0.0), hp.y)) { emit = P.windowGlow.xyz; }
    }
  }

  let w = n.y * 0.5 + 0.5;
  var light = P.hemiGround.xyz + (P.hemiSky.xyz - P.hemiGround.xyz) * w;
  let sp = o + d * t + n * 0.05;
  if (P.gridItems.y == 1u) { light *= ambientOcclusion(sp, n); }
  let sun = P.sun.xyz;
  let facing = dot(n, sun);
  if (facing > 0.0) {
    if (trace(sp, sun, true, INF).prim == MISS) { light += P.sunLight.xyz * facing; }
  }

  let depth = t * dot(d, f);
  let fogT = clamp((depth - P.sunLight.w) / (P.hemiSky.w - P.sunLight.w), 0.0, 1.0);
  let fog = fogT * fogT * (3.0 - 2.0 * fogT);
  let col = (albedo * light + emit) * (1.0 - fog) + P.sky.xyz * fog;
  let maxLight = P.sky.w;
  let minLight = P.windowGlow.w;
  var shadow = clamp((maxLight - luminance(light)) / (maxLight - minLight), 0.0, 1.0);
  if (emit.x > 0.0) { shadow = 1.0 - P.hemiGround.w; }
  let ink = u32(clamp(floor((MIN_INK + (1.0 - MIN_INK) * shadow) * (1.0 - fog) * 255.0), 0.0, 255.0));
  cells[i * 3u] = srgbByte(col.x) | (srgbByte(col.y) << 8u) | (srgbByte(col.z) << 16u) | (ink << 24u);
  cells[i * 3u + 1u] = bitcast<u32>(depth);
  cells[i * 3u + 2u] = toByte(n.x * 127.0) | (toByte(n.y * 127.0) << 8u) | (toByte(n.z * 127.0) << 16u);
}
`
