import { getEnvironment, type Environment } from '~/environments'
import { DEFAULT_VIEW, type CameraView } from '~/lib/camera'

/** How the ASCII view is made: ray traced on the CPU or the GPU, or a shader over the 3D view. */
export type AsciiMethod = 'cpu' | 'gpu' | 'shader'

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

/**
 * Seed and size for an environment, shared by its 3D and ASCII views. The seed is shared by
 * all environments and deliberately not saved: every visit starts with a new world.
 */
export function useSceneSettings(env: Environment) {
  return {
    seed: useState('seed', () => Math.floor(Math.random() * 1e6)),
    size: usePersistentState(`${env.id}-size`, () => env.size.default),
  }
}

/** ASCII display settings, shared by all environments and saved across reloads. */
export function useAsciiSettings() {
  return {
    color: usePersistentState('ascii-color', () => true),
    cellBackground: usePersistentState('ascii-cell-background', () => true),
    outlines: usePersistentState('ascii-outlines', () => true),
    stretch: usePersistentState('ascii-stretch', () => false),
    atlas: usePersistentState('ascii-atlas', () => true),
    method: usePersistentState<AsciiMethod>('ascii-method', () => 'cpu'),
    worker: usePersistentState('ascii-worker', () => true),
    fontSize: usePersistentState('ascii-font-size', () => 12),
  }
}

/** Camera per environment, shared by its 3D and ASCII views. */
export function useCameraView(env: Environment) {
  return useState<CameraView>(`camera-${env.id}`, () => structuredClone(env.camera ?? DEFAULT_VIEW))
}

/** The environment named in the route, e.g. /forest/ascii. Pages validate it exists. */
export function useRouteEnvironment() {
  const route = useRoute()
  return computed(() => getEnvironment(route.params.env as string))
}
