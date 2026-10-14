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

const STORAGE_PREFIX = 'city-generator:'

/**
 * Like useState, but also saved in localStorage so it survives reloads. A stored value of
 * the wrong type (e.g. from an older version) is ignored in favour of the default.
 */
export function usePersistentState<T extends string | number | boolean>(key: string, init: () => T) {
  const state = useState<T>(key, () => {
    const fallback = init()
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key)
      const stored = raw === null ? null : JSON.parse(raw)
      return typeof stored === typeof fallback ? stored : fallback
    }
    catch {
      // Storage blocked (private mode, disabled cookies) or corrupt JSON.
      return fallback
    }
  })
  watch(state, (value) => {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
    }
    catch {
      // Not being able to save is fine; the setting still works for this visit.
    }
  })
  return state
}

/** Seed and size shared by every view, so switching pages shows the same city. */
export function useCitySettings() {
  return {
    // Deliberately not saved: every visit starts with a new city.
    seed: useState('city-seed', () => Math.floor(Math.random() * 1e6)),
    blocks: usePersistentState('city-blocks', () => 12),
  }
}

/** Camera position and orbit target shared by every view. */
export function useCameraView() {
  return useState<CameraView>('city-camera', () => structuredClone(DEFAULT_VIEW))
}
