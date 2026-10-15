import { linearRgb } from '../lib/color'
import type { Vec3 } from '../lib/math'
import { mulberry32, pick } from '../lib/random'
import type { Player } from './types'

const PAINT = [0xc0392b, 0x2e6fb7, 0xf1c40f, 0x27ae60, 0xecf0f1, 0x2c3e50, 0xe67e22]
const GLASS = 0x26323d
const TIRE = 0x1d1d1f
const HEADLIGHT = 0xfff4c2
const TAILLIGHT = 0xd0201c

const WHEEL_RADIUS = 0.36
const WHEEL_SEGMENTS = 14

/** Collects flat-shaded triangles with a color per vertex. */
function meshBuilder() {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []

  /** A quad from four corners in counter-clockwise order, seen from outside. */
  function quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal: Vec3, color: Vec3) {
    const base = positions.length / 3
    for (const p of [a, b, c, d]) {
      positions.push(...p)
      normals.push(...normal)
      colors.push(...color)
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  /** An axis-aligned box from its min and max corners. */
  function box([x0, y0, z0]: Vec3, [x1, y1, z1]: Vec3, color: Vec3) {
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], color)
    quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], color)
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], color)
    quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0], color)
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], color)
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], color)
  }

  /** A wheel: a cylinder whose axis runs along z, from z0 to z1. */
  function wheel(x: number, y: number, z0: number, z1: number, r: number, color: Vec3) {
    const ring = (i: number): [number, number] => {
      const a = (i / WHEEL_SEGMENTS) * Math.PI * 2
      return [Math.cos(a), Math.sin(a)]
    }
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      const [c0, s0] = ring(i)
      const [c1, s1] = ring(i + 1)
      const [cm, sm] = ring(i + 0.5)
      quad([x + c0 * r, y + s0 * r, z0], [x + c1 * r, y + s1 * r, z0], [x + c1 * r, y + s1 * r, z1], [x + c0 * r, y + s0 * r, z1], [cm, sm, 0], color)
      // Caps as thin wedges from the hub, so every face is still a quad.
      quad([x, y, z1], [x + c0 * r, y + s0 * r, z1], [x + c1 * r, y + s1 * r, z1], [x, y, z1], [0, 0, 1], color)
      quad([x, y, z0], [x + c1 * r, y + s1 * r, z0], [x + c0 * r, y + s0 * r, z0], [x, y, z0], [0, 0, -1], color)
    }
  }

  function build() {
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      colors: new Float32Array(colors),
      indices: new Uint32Array(indices),
    }
  }

  return { box, wheel, build }
}

/** A small hatchback, 4.4 long and 1.9 wide, built from boxes and wheels. */
export const car: Player = {
  id: 'car',
  name: 'Car',
  scale: 1.4,
  flies: false,
  speed: 45,
  acceleration: 30,
  turnRate: 1.8,
  collider: { radius: 1.8, height: 2.4 },
  camera: { distance: 14, height: 5, lookHeight: 2 },

  build(seed) {
    const paint = linearRgb(pick(mulberry32(seed), PAINT))
    const b = meshBuilder()
    const r = WHEEL_RADIUS
    // Lower body and the cabin on top, set back from the hood.
    b.box([-2.2, r * 0.6, -0.95], [2.2, 1.05, 0.95], paint)
    b.box([-1.7, 1.05, -0.85], [0.7, 1.6, 0.85], linearRgb(GLASS))
    b.box([-1.6, 1.6, -0.8], [0.6, 1.68, 0.8], paint)
    // Lights, poking slightly out of the front and back.
    for (const z of [-0.65, 0.65]) {
      b.box([2.2, 0.75, z - 0.2], [2.25, 0.92, z + 0.2], linearRgb(HEADLIGHT))
      b.box([-2.25, 0.75, z - 0.2], [-2.2, 0.92, z + 0.2], linearRgb(TAILLIGHT))
    }
    for (const x of [-1.4, 1.4]) {
      b.wheel(x, r, 0.75, 1.0, r, linearRgb(TIRE))
      b.wheel(x, r, -1.0, -0.75, r, linearRgb(TIRE))
    }
    return { mesh: { ...b.build(), roughness: 0.5, metalness: 0.2 } }
  },
}
