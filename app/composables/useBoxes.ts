import type { Environment, Primitive } from '~/environments'
import { dropBox, fallBoxes, removeBox, type DroppedBox, type DropSpot } from '~/lib/boxes'
import { mulberry32 } from '~/lib/random'

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

/** Whether a dropped box sticks to the face it was dropped on, and so doesn't fall. */
export function useBoxStick() {
  return usePersistentState('box-stick', () => false)
}

const newRoll = () => Math.floor(Math.random() * 2 ** 32)

/** The fall running per environment, so only one steps its boxes however many views share them. */
const falling = new Map<string, number>()

/**
 * Boxes dropped into an environment, shared by its views, with the tower game's and those of
 * extruded shapes on show too. They belong to one world: a new seed or size starts without any.
 */
export function useBoxes(env: Environment) {
  const { seed, size } = useSceneSettings(env)
  const gravity = useBoxGravity()
  const stick = useBoxStick()
  /** Seeds the size and color of the next box, so a preview shows the box a click drops. */
  const roll = useState('box-roll', newRoll)
  const tower = useTower(env)
  const shapes = useShapes(env)
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
    /** The dropped boxes, then the tower game's and extruded shapes': what the views show and players bump into. */
    boxes: computed<Primitive[]>(() => markRaw([...items().map(b => b.box), ...tower.boxes.value, ...shapes.boxes.value])),
    /** Boxes dropped in the boxes mode. */
    count: computed(() => items().length),
    /** With `air`, out from the face clicked instead of against it. */
    drop(spot: DropSpot, air = false) {
      set([...items(), dropBox(spot, { boxes: items(), stick: stick.value, air }, mulberry32(roll.value))])
      roll.value = newRoll()
      fall()
    },
    /** The box a click there with `air` would drop. */
    preview(spot: DropSpot, air = false) {
      return dropBox(spot, { boxes: items(), stick: stick.value, air }, mulberry32(roll.value)).box
    },
    /** Takes out the box at index `i`; what it held up falls. */
    remove(i: number) {
      set(removeBox(items(), i))
      fall()
    },
    /** Lets boxes left in the air fall, after gravity is turned on. */
    fall,
    clear() {
      state.value = { world: '', items: NONE }
    },
  }
}
