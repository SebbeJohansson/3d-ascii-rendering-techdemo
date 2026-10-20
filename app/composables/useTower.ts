import type { Environment, Primitive } from '~/environments'
import type { DropSpot } from '~/lib/boxes'
import { dropTower, startTower, stepTower, type TowerGame } from '~/lib/tower'

/**
 * The tower mode: orbiting, where a click starts a stacking tower game or drops its swinging
 * box. Picked in the panel instead of a player. Shared by every view.
 */
export function useTowerMode() {
  return useState('tower-mode', () => false)
}

/** The highest tower stacked, over every game. */
export function useTowerBest() {
  return usePersistentState<number>('tower-best', () => 0)
}

/** The game running per environment, so only one steps it however many views share it. */
const running = new Map<string, number>()

/**
 * The tower game in an environment, shared by its views. It belongs to one world: a new seed
 * or size starts without one.
 */
export function useTower(env: Environment) {
  const { seed, size } = useSceneSettings(env)
  const best = useTowerBest()
  const state = useState<{ world: string, game?: TowerGame }>(`tower-${env.id}`, () => ({ world: '' }))
  const world = computed(() => `${seed.value}:${size.value}`)
  const game = computed(() => (state.value.world === world.value ? state.value.game : undefined))

  // Raw, so the boxes can be posted to workers as they are.
  function set(next: TowerGame | undefined) {
    state.value = { world: world.value, game: next && markRaw(next) }
    if (next && next.score > best.value) best.value = next.score
  }

  /** Steps the game every frame until it is over and everything has landed. */
  function run() {
    if (running.has(env.id)) return
    let last = performance.now()
    const tick = (now: number) => {
      // Capped, so a frame after a stall (tab hidden) doesn't drop boxes through each other.
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const next = game.value && stepTower(game.value, dt)
      if (!next) {
        running.delete(env.id)
        return
      }
      set(next)
      running.set(env.id, requestAnimationFrame(tick))
    }
    running.set(env.id, requestAnimationFrame(tick))
  }

  /** Drops the swinging box. */
  function drop() {
    if (!game.value || game.value.over) return
    set(dropTower(game.value))
    run()
  }

  return {
    game,
    best,
    boxes: computed<Primitive[]>(() => markRaw(game.value?.boxes.map(b => b.box) ?? [])),
    drop,
    /** Starts a new tower on the spot clicked, in place of the last one. */
    start(spot: DropSpot) {
      set(startTower(spot))
      run()
    },
    clear() {
      state.value = { world: '' }
    },
  }
}
