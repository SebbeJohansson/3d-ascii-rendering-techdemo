import type { Environment, Primitive } from '~/environments'
import { dropBox, fallBoxes, type DroppedBox, type DropSpot } from '~/lib/boxes'

const NONE: DroppedBox[] = []

/**
 * The boxes mode: orbiting, where a click drops a box instead of naming what is there. Picked
 * in the panel instead of a player. Shared by every view.
 */
export function useBoxMode() {
  return useState('box-mode', () => false)
}

/** Whether dropped boxes fall. Off, they stay where they were dropped, in the air if need be. */
export function useBoxGravity() {
  return usePersistentState('box-gravity', () => true)
}

/** The fall running per environment, so only one steps its boxes however many views share them. */
const falling = new Map<string, number>()

/**
 * Boxes dropped into an environment, shared by its views. They belong to one world: a new
 * seed or size starts without any.
 */
export function useBoxes(env: Environment) {
  const { seed, size } = useSceneSettings(env)
  const gravity = useBoxGravity()
  const state = useState<{ world: string, items: DroppedBox[] }>(`boxes-${env.id}`, () => ({ world: '', items: NONE }))
  const world = computed(() => `${seed.value}:${size.value}`)
  const items = () => (state.value.world === world.value ? state.value.items : NONE)

  // Raw, so the boxes can be posted to workers as they are.
  function set(next: DroppedBox[]) {
    state.value = { world: world.value, items: markRaw(next) }
  }

  /** Steps falling boxes every frame until all of them rest, or gravity is turned off. */
  function fall() {
    if (!gravity.value || falling.has(env.id)) return
    let last = performance.now()
    const tick = (now: number) => {
      // Capped, so a frame after a stall (tab hidden) doesn't drop boxes through each other.
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const next = gravity.value ? fallBoxes(items(), dt) : undefined
      if (!next) {
        falling.delete(env.id)
        return
      }
      set(next)
      falling.set(env.id, requestAnimationFrame(tick))
    }
    falling.set(env.id, requestAnimationFrame(tick))
  }

  return {
    boxes: computed<Primitive[]>(() => markRaw(items().map(b => b.box))),
    drop(spot: DropSpot) {
      set([...items(), dropBox(spot)])
      fall()
    },
    /** Lets boxes left in the air fall, after gravity is turned on. */
    fall,
    clear() {
      state.value = { world: '', items: NONE }
    },
  }
}
