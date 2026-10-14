export type Vec3 = [number, number, number]

export interface CameraView {
  position: Vec3
  target: Vec3
}

export const DEFAULT_VIEW: CameraView = { position: [260, 220, 260], target: [0, 0, 0] }
export const CAMERA_FOV = 50
export const MIN_DISTANCE = 20
export const MAX_DISTANCE = 1200
export const MAX_POLAR_ANGLE = Math.PI / 2.1

/** Seed and size shared by every view, so switching pages shows the same city. */
export function useCitySettings() {
  return {
    seed: useState('city-seed', () => Math.floor(Math.random() * 1e6)),
    blocks: useState('city-blocks', () => 12),
  }
}

/** Camera position and orbit target shared by every view. */
export function useCameraView() {
  return useState<CameraView>('city-camera', () => structuredClone(DEFAULT_VIEW))
}
