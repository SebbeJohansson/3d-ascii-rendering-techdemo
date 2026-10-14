export type Vec3 = [number, number, number]

export function normalize([x, y, z]: Vec3): Vec3 {
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function scale(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k]
}

export function distance(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Forward, right and up unit vectors for a camera looking at its target. */
export function cameraBasis(position: Vec3, target: Vec3) {
  const forward = normalize([target[0] - position[0], target[1] - position[1], target[2] - position[2]])
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  return { forward, right, up }
}
