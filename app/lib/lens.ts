/**
 * The ASCII lens: which character cells to show over the 3D view. Screen shapes go by where
 * a cell sits on screen; world shapes go by where its ray hit the scene, worked out from the
 * view depth the ray tracer stores per cell.
 */
import { cameraBasis, type Vec3 } from './math'
import type { Camera } from './raycaster'

export type LensShape = 'mouse' | 'focus' | 'scan'

export type Lens =
  /** A circle on screen, in CSS pixels from the view's top left corner. */
  | { kind: 'circle', x: number, y: number, radius: number }
  /** A ball in the world. */
  | { kind: 'sphere', center: Vec3, radius: number }
  /** Everything on the side of a plane that `normal` points away from. */
  | { kind: 'plane', point: Vec3, normal: Vec3 }
  /** Nothing: the pointer is elsewhere. */
  | { kind: 'none' }

/**
 * Sets out[i] to 1 for every cell inside the lens and 0 for the rest. `depths` and `cam` are
 * a traced frame's view depths and the camera it was traced with; cells are `cellWidth` ×
 * `cellHeight` CSS pixels.
 */
export function lensMask(lens: Lens, cam: Camera, depths: Float32Array, cols: number, rows: number, cellWidth: number, cellHeight: number, out: Uint8Array) {
  if (lens.kind === 'none') return out.fill(0)
  if (lens.kind === 'circle') {
    const r2 = lens.radius * lens.radius
    for (let y = 0; y < rows; y++) {
      const dy = (y + 0.5) * cellHeight - lens.y
      for (let x = 0; x < cols; x++) {
        const dx = (x + 0.5) * cellWidth - lens.x
        out[y * cols + x] = dx * dx + dy * dy <= r2 ? 1 : 0
      }
    }
    return out
  }

  // The hit point of a cell's ray, the same ray renderScene() traced: camera position plus the
  // unnormalized direction (forward + right·sx + up·sy) times the view depth.
  const { forward: f, right: r, up: u } = cameraBasis(cam.position, cam.target)
  const tanHalf = Math.tan((cam.fov * Math.PI) / 360)
  const [ox, oy, oz] = cam.position
  for (let y = 0; y < rows; y++) {
    const sy = (1 - ((y + 0.5) / rows) * 2) * tanHalf
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const depth = depths[i]!
      if (!Number.isFinite(depth)) {
        out[i] = 0
        continue
      }
      const sx = (((x + 0.5) / cols) * 2 - 1) * tanHalf * cam.aspect
      const px = ox + (f[0] + r[0] * sx + u[0] * sy) * depth
      const py = oy + (f[1] + r[1] * sx + u[1] * sy) * depth
      const pz = oz + (f[2] + r[2] * sx + u[2] * sy) * depth
      if (lens.kind === 'sphere') {
        const [cx, cy, cz] = lens.center
        out[i] = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2 <= lens.radius ** 2 ? 1 : 0
      }
      else {
        const [qx, qy, qz] = lens.point
        const [nx, ny, nz] = lens.normal
        out[i] = (px - qx) * nx + (py - qy) * ny + (pz - qz) * nz < 0 ? 1 : 0
      }
    }
  }
  return out
}
