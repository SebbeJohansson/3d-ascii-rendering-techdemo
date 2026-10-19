import { cameraBasis, distance, type Vec3 } from './math'

export interface CameraView {
  position: Vec3
  target: Vec3
}

export const DEFAULT_VIEW: CameraView = { position: [260, 220, 260], target: [0, 0, 0] }
export const CAMERA_FOV = 50
export const MIN_DISTANCE = 20
export const MAX_DISTANCE = 1200
export const MAX_POLAR_ANGLE = Math.PI / 2.1

// Orbit, pan and zoom with the same feel and limits as three's OrbitControls, as pure
// functions on a view. The 3D view uses OrbitControls itself; the ASCII view uses these.

/** Rotates around the target. dx/dy are pointer movement in pixels. */
export function orbitView({ position: p, target: t }: CameraView, dx: number, dy: number, viewportHeight: number): CameraView {
  const offset: Vec3 = [p[0] - t[0], p[1] - t[1], p[2] - t[2]]
  const radius = Math.hypot(...offset)
  const theta = Math.atan2(offset[0], offset[2]) - (2 * Math.PI * dx) / viewportHeight
  const phi = Math.min(MAX_POLAR_ANGLE, Math.max(0.01, Math.acos(offset[1] / radius) - (2 * Math.PI * dy) / viewportHeight))
  return {
    position: [
      t[0] + radius * Math.sin(phi) * Math.sin(theta),
      t[1] + radius * Math.cos(phi),
      t[2] + radius * Math.sin(phi) * Math.cos(theta),
    ],
    target: t,
  }
}

/** Slides camera and target together, so the point under the pointer follows it. */
export function panView({ position: p, target: t }: CameraView, dx: number, dy: number, viewportHeight: number): CameraView {
  const { right, up } = cameraBasis(p, t)
  const k = (2 * distance(p, t) * Math.tan((CAMERA_FOV * Math.PI) / 360)) / viewportHeight
  const move = [0, 1, 2].map(i => (-right[i]! * dx + up[i]! * dy) * k) as Vec3
  return {
    position: p.map((v, i) => v + move[i]!) as Vec3,
    target: t.map((v, i) => v + move[i]!) as Vec3,
  }
}

/** Moves toward or away from the target. deltaY is a wheel delta. */
export function zoomView({ position: p, target: t }: CameraView, deltaY: number): CameraView {
  const current = distance(p, t)
  const next = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, current * Math.exp(deltaY * 0.001)))
  return { position: p.map((v, i) => t[i]! + (v - t[i]!) * (next / current)) as Vec3, target: t }
}

/**
 * The benchmark's camera path, `u` from 0 to 1: one full circle around the environment's
 * starting view, zooming in towards the middle of the lap and back out.
 */
export function benchmarkView({ position: p, target: t }: CameraView, u: number): CameraView {
  const ox = p[0] - t[0]
  const oz = p[2] - t[2]
  const radius = Math.hypot(ox, oz)
  const angle = Math.atan2(ox, oz) + 2 * Math.PI * u
  const zoom = 1 - 0.35 * Math.sin(Math.PI * u)
  const position: Vec3 = [t[0] + radius * zoom * Math.sin(angle), t[1] + (p[1] - t[1]) * zoom, t[2] + radius * zoom * Math.cos(angle)]
  return { position, target: [...t] }
}
