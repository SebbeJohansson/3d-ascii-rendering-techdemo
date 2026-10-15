import type { Environment } from '~/environments'
import type { Lens, LensShape } from '~/lib/lens'
import { cameraBasis, distance } from '~/lib/math'

/** Seconds for the scan line to sweep across and back. */
const SCAN_PERIOD = 8

/** Lens shape and size, shared by all environments and saved across reloads. */
export function useLensSettings() {
  return {
    shape: usePersistentState<LensShape>('lens-shape', () => 'mouse'),
    /** 1..10. */
    size: usePersistentState('lens-size', () => 4),
  }
}

/**
 * The lens for this frame, updated every animation frame: around the pointer, around what
 * the camera looks at (the dragon or car when riding), or behind a line sweeping across the
 * view. `pointer` is in CSS pixels over the view, or null while it's elsewhere.
 */
export function useLens(env: Environment, pointer: Ref<{ x: number, y: number } | null>) {
  const { shape, size } = useLensSettings()
  const view = useCameraView(env)
  const lens = shallowRef<Lens>({ kind: 'none' })
  let frameId = 0

  // Only hand out a new lens when it changed: every new one makes the ASCII view redraw.
  function set(next: Lens) {
    if (JSON.stringify(next) !== JSON.stringify(lens.value)) lens.value = next
  }

  function update(now: number) {
    frameId = requestAnimationFrame(update)
    const { position, target } = view.value
    const reach = distance(position, target)
    if (shape.value === 'mouse') {
      set(pointer.value ? { kind: 'circle', ...pointer.value, radius: size.value * 40 } : { kind: 'none' })
    }
    else if (shape.value === 'focus') {
      // Scaled to the view, so it covers the same share of the screen however far out you are.
      set({ kind: 'sphere', center: [...target], radius: reach * size.value * 0.08 })
    }
    else {
      // A vertical plane facing the camera's right, swinging left and right across the view.
      const { right } = cameraBasis(position, target)
      const l = Math.hypot(right[0], right[2]) || 1
      const normal: [number, number, number] = [right[0] / l, 0, right[2] / l]
      const offset = Math.sin((2 * Math.PI * now) / 1000 / SCAN_PERIOD) * reach * 0.9
      set({ kind: 'plane', point: [target[0] + normal[0] * offset, target[1], target[2] + normal[2] * offset], normal })
    }
  }

  onMounted(() => (frameId = requestAnimationFrame(update)))
  onBeforeUnmount(() => cancelAnimationFrame(frameId))
  return lens
}
