import type { Environment, EnvironmentScene } from '~/environments'
import { withBoxes } from '~/lib/boxes'
import { defaultChase, followPlayer, orbitChase, spawnPose, stepPlayer, swapPose, zoomChase, type ChaseCamera, type PlayerMotion } from '~/lib/playerMotion'
import { getPlayer, type Player, type PlayerKind, type PlayerPose } from '~/players'

/** Which player is spawned, if any. Shared by every environment and view. */
export function usePlayerKind() {
  return useState<PlayerKind | null>('player-kind', () => null)
}

/** Where the player is in an environment, shared by its 3D and ASCII views. */
export function usePlayerPose(env: Environment) {
  return useState<PlayerPose | undefined>(`player-${env.id}`, () => undefined)
}

/**
 * The chase camera around the spawned player. Both views turn mouse input into orbit() and
 * zoom() calls, with the same feel as orbiting without a player.
 */
export function useChaseCamera() {
  const chase = useState<ChaseCamera>('chase-camera', () => defaultChase())
  return {
    chase,
    /** Rotates around the player. dx/dy are pointer movement in pixels. */
    orbit: (dx: number, dy: number, viewportHeight: number) => orbitChase(chase.value, dx, dy, viewportHeight),
    /** Moves toward or away from the player. deltaY is a wheel delta. */
    zoom: (deltaY: number) => zoomChase(chase.value, deltaY),
    reset(player: Player) {
      chase.value = defaultChase(player)
    },
  }
}

const KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['Space'],
  down: ['ShiftLeft', 'ShiftRight'],
}
const HANDLED = new Set(Object.values(KEYS).flat())

/**
 * Drives the spawned player from the keyboard and moves the environment's camera behind it.
 * Call once per page: every view on the page follows the shared pose and camera.
 */
export function usePlayerDriver(env: Environment) {
  const kind = usePlayerKind()
  const pose = usePlayerPose(env)
  const view = useCameraView(env)
  const { seed, size } = useSceneSettings(env)
  const chaseCamera = useChaseCamera()
  const { boxes } = useBoxes(env)
  const held = new Set<string>()
  const motion: PlayerMotion = { speed: 0, cameraHeading: 0 }
  let frameId = 0
  let last = 0
  /** The environment as generated, when first needed, and with dropped boxes: the solids to collide with. */
  let generated: EnvironmentScene | undefined
  let world: EnvironmentScene | undefined
  watch([seed, size], () => (generated = world = undefined))
  watch(boxes, () => (world = undefined))

  function getWorld() {
    return (world ??= withBoxes(generated ??= env.generate(seed.value, size.value), boxes.value))
  }

  watch(kind, (k, previous) => {
    held.clear()
    if (!k) {
      pose.value = undefined
      return
    }
    const player = getPlayer(k)
    chaseCamera.reset(player)
    if (!pose.value) {
      pose.value = spawnPose(env, size.value, view.value, player, getWorld())
      motion.speed = 0
      motion.cameraHeading = pose.value.heading
    }
    else if (previous) pose.value = swapPose(pose.value, player, getWorld())
  }, { immediate: true })

  const pressed = (names: string[]) => names.some(n => held.has(n))

  function step(dt: number) {
    if (!kind.value || !pose.value) return
    const player = getPlayer(kind.value)
    const from = pose.value
    const input = {
      throttle: Number(pressed(KEYS.forward)) - Number(pressed(KEYS.back)),
      steer: Number(pressed(KEYS.left)) - Number(pressed(KEYS.right)),
      climb: Number(pressed(KEYS.up)) - Number(pressed(KEYS.down)),
    }
    pose.value = stepPlayer(player, from, motion, input, getWorld(), dt)
    view.value = followPlayer(player, from, pose.value, motion, chaseCamera.chase.value, dt)
  }

  function tick(now: number) {
    frameId = requestAnimationFrame(tick)
    // Capped, so a frame after a stall (tab hidden, breakpoint) doesn't jump far.
    const dt = Math.min(0.1, (now - (last || now)) / 1000)
    last = now
    step(dt)
  }

  function typing(e: KeyboardEvent) {
    return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
  }

  function onKey(e: KeyboardEvent) {
    if (!kind.value || !HANDLED.has(e.code) || typing(e)) return
    // Stops arrows and Space from scrolling or pressing a focused button.
    e.preventDefault()
    if (e.type === 'keydown') held.add(e.code)
    else held.delete(e.code)
  }

  function onBlur() {
    held.clear()
  }

  onMounted(() => {
    if (kind.value && pose.value) motion.cameraHeading = pose.value.heading
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    frameId = requestAnimationFrame(tick)
  })

  onBeforeUnmount(() => {
    cancelAnimationFrame(frameId)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('keyup', onKey)
    window.removeEventListener('blur', onBlur)
  })
}
