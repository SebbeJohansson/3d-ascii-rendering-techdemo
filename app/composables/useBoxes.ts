import type { Environment, Primitive } from '~/environments'
import { dropBox, type DropSpot } from '~/lib/boxes'

const NONE: Primitive[] = []

/** Whether a click drops a box instead of naming what is there. Shared by every view. */
export function useBoxMode() {
  return useState('box-mode', () => false)
}

/**
 * Boxes dropped into an environment, shared by its views. They belong to one world: a new
 * seed or size starts without any.
 */
export function useBoxes(env: Environment) {
  const { seed, size } = useSceneSettings(env)
  const state = useState<{ world: string, boxes: Primitive[] }>(`boxes-${env.id}`, () => ({ world: '', boxes: NONE }))
  const world = computed(() => `${seed.value}:${size.value}`)
  return {
    boxes: computed(() => (state.value.world === world.value ? state.value.boxes : NONE)),
    drop(spot: DropSpot) {
      const boxes = state.value.world === world.value ? state.value.boxes : NONE
      // Raw, so the boxes can be posted to workers as they are.
      state.value = { world: world.value, boxes: markRaw([...boxes, dropBox(spot)]) }
    },
    clear() {
      state.value = { world: '', boxes: NONE }
    },
  }
}
