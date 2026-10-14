/**
 * Signed distance functions (SDFs): for any point, the distance to a shape's surface,
 * negative inside. Complex organic models (like the dragon) are built by blending many
 * simple SDF shapes with a smooth union, then turned into triangles by surfaceNets.ts.
 */
import type { Vec3 } from './math'

export interface SdfShape {
  /** Bounds of the shape itself. Outside them (plus a margin) it can be skipped. */
  min: Vec3
  max: Vec3
  distance: (x: number, y: number, z: number) => number
  /** Which part of the model this belongs to, so the mesh can be colored per part. */
  part: number
}

/**
 * Smooth minimum: like min(a, b), but blends the two surfaces together within distance k,
 * which turns sharp creases between parts into organic, rounded joints.
 */
export function smoothMin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/** A capsule whose radius changes linearly from ra at a to rb at b. Good for limbs, necks, horns. */
export function taperedCapsule(a: Vec3, b: Vec3, ra: number, rb: number, part: number): SdfShape {
  const [ax, ay, az] = a
  const bax = b[0] - ax
  const bay = b[1] - ay
  const baz = b[2] - az
  const invLen2 = 1 / (bax * bax + bay * bay + baz * baz)
  const r = Math.max(ra, rb)
  return {
    min: [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r],
    max: [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r],
    part,
    distance(x, y, z) {
      const pax = x - ax
      const pay = y - ay
      const paz = z - az
      const h = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) * invLen2))
      return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - (ra + (rb - ra) * h)
    },
  }
}

/** Consecutive tapered capsules through a list of [x, y, z, radius] points. */
export function chain(points: [number, number, number, number][], part: number): SdfShape[] {
  return points.slice(1).map((p, i) => {
    const q = points[i]!
    return taperedCapsule([q[0], q[1], q[2]], [p[0], p[1], p[2]], q[3], p[3], part)
  })
}

/** An ellipsoid with radii r. Uses a close approximation of the true distance, standard for SDF modeling. */
export function ellipsoid(center: Vec3, r: Vec3, part: number): SdfShape {
  const [cx, cy, cz] = center
  const [rx, ry, rz] = r
  return {
    min: [cx - rx, cy - ry, cz - rz],
    max: [cx + rx, cy + ry, cz + rz],
    part,
    distance(x, y, z) {
      const px = x - cx
      const py = y - cy
      const pz = z - cz
      const k0 = Math.hypot(px / rx, py / ry, pz / rz)
      const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz))
      return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1
    },
  }
}

/** A flat triangle with some thickness. Wing membranes are made of these. */
export function thickTriangle(a: Vec3, b: Vec3, c: Vec3, thickness: number, part: number): SdfShape {
  const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
  const cross = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]]
  const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
  const ba = sub(b, a)
  const cb = sub(c, b)
  const ac = sub(a, c)
  const normal = cross(ba, ac)
  const nn = dot(normal, normal)
  // Planes through each edge, perpendicular to the triangle: the point projects inside the
  // triangle when it is on the same side of all three.
  const edgeA = cross(ba, normal)
  const edgeB = cross(cb, normal)
  const edgeC = cross(ac, normal)

  /** Squared distance from p (given relative to the edge start) to an edge segment. */
  const edgeDist2 = (e: Vec3, px: number, py: number, pz: number) => {
    const h = Math.min(1, Math.max(0, (e[0] * px + e[1] * py + e[2] * pz) / dot(e, e)))
    const dx = e[0] * h - px
    const dy = e[1] * h - py
    const dz = e[2] * h - pz
    return dx * dx + dy * dy + dz * dz
  }

  return {
    min: [0, 1, 2].map(i => Math.min(a[i]!, b[i]!, c[i]!) - thickness) as Vec3,
    max: [0, 1, 2].map(i => Math.max(a[i]!, b[i]!, c[i]!) + thickness) as Vec3,
    part,
    distance(x, y, z) {
      const pa: Vec3 = [x - a[0], y - a[1], z - a[2]]
      const pb: Vec3 = [x - b[0], y - b[1], z - b[2]]
      const pc: Vec3 = [x - c[0], y - c[1], z - c[2]]
      const sides = Math.sign(dot(edgeA, pa)) + Math.sign(dot(edgeB, pb)) + Math.sign(dot(edgeC, pc))
      const d = Math.abs(sides) === 3
        ? Math.abs(dot(normal, pa)) / Math.sqrt(nn)
        : Math.sqrt(Math.min(edgeDist2(ba, ...pa), edgeDist2(cb, ...pb), edgeDist2(ac, ...pc)))
      return d - thickness
    },
  }
}
