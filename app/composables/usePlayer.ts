import type { Environment } from '~/environments'
import type { Vec3 } from '~/lib/math'
import { getPlayer, type PlayerKind, type PlayerPose } from '~/players'

/** Which player is spawned, if any. Shared by every environment and view. */
export function usePlayerKind() {
  return useState<PlayerKind | null>('player-kind', () => null)
}

/** Where the player is in an environment, shared by its 3D and ASCII views. */
export function usePlayerPose(env: Environment) {
  return useState<PlayerPose | undefined>(`player-${env.id}`, () => undefined)
}

/** Dragon climb and dive speed, world units per second. */
const CLIMB_SPEED = 30
const MAX_ALTITUDE = 300
/** How fast the chase camera swings round behind a turning player. Higher is snappier. */
const CAMERA_FOLLOW = 4

const KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['Space'],
  down: ['ShiftLeft', 'ShiftRight'],
}
const HANDLED = new Set(Object.values(KEYS).flat())

/** Shortest signed angle from a to b. */
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

/**
 * Drives the spawned player from the keyboard and moves the environment's camera behind it.
 * Call once per page: every view on the page follows the shared pose and camera.
 */
export function usePlayerDriver(env: Environment) {
  const kind = usePlayerKind()
  const pose = usePlayerPose(env)
  const view = useCameraView(env)
  const { size } = useSceneSettings(env)
  const held = new Set<string>()
  let speed = 0
  let cameraHeading = 0
  let frameId = 0
  let last = 0

  function spawn() {
    const { position: p, target: t } = view.value
    const [x, , z] = env.spawn?.(size.value, view.value) ?? t
    // Face away from the camera, so it starts out behind the player.
    const heading = Math.atan2(-(t[2] - p[2]), t[0] - p[0])
    pose.value = { position: [x, 0, z], heading }
    cameraHeading = heading
    speed = 0
  }

  watch(kind, (k, previous) => {
    held.clear()
    if (!k) pose.value = undefined
    else if (!pose.value) spawn()
    // Swapping dragon for car mid-flight: land where the dragon was.
    else if (previous && !getPlayer(k).flies) pose.value = { ...pose.value, position: [pose.value.position[0], 0, pose.value.position[2]] }
  }, { immediate: true })

  const pressed = (names: string[]) => names.some(n => held.has(n))

  function step(dt: number) {
    if (!kind.value || !pose.value) return
    const player = getPlayer(kind.value)
    let { position: [x, y, z], heading } = pose.value

    const throttle = Number(pressed(KEYS.forward)) - Number(pressed(KEYS.back))
    const steer = Number(pressed(KEYS.left)) - Number(pressed(KEYS.right))
    // Brake twice as hard as accelerating; with no throttle, coast to a stop.
    const accel = throttle * speed < 0 ? player.acceleration * 2 : player.acceleration
    if (throttle) speed += throttle * accel * dt
    else speed -= Math.sign(speed) * Math.min(Math.abs(speed), player.acceleration * 0.5 * dt)
    speed = Math.min(player.speed, Math.max(-player.speed / 3, speed))

    // A dragon turns on the spot; a car only turns while rolling, and steers backward in reverse.
    const grip = player.flies ? 1 : Math.min(1, Math.max(-1, speed / 8))
    heading += steer * player.turnRate * grip * dt

    x += Math.cos(heading) * speed * dt
    z -= Math.sin(heading) * speed * dt
    if (player.flies) {
      const climb = Number(pressed(KEYS.up)) - Number(pressed(KEYS.down))
      y = Math.min(MAX_ALTITUDE, Math.max(0, y + climb * CLIMB_SPEED * dt))
    }
    else y = 0
    pose.value = { position: [x, y, z], heading }

    // Chase camera: behind and above, swinging round after the player with a short lag.
    cameraHeading += angleTo(cameraHeading, heading) * (1 - Math.exp(-CAMERA_FOLLOW * dt))
    const { distance, height, lookHeight } = player.camera
    const camera: Vec3 = [
      x - Math.cos(cameraHeading) * distance,
      Math.max(1, y + height),
      z + Math.sin(cameraHeading) * distance,
    ]
    view.value = { position: camera, target: [x, y + lookHeight, z] }
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
    if (kind.value && pose.value) cameraHeading = pose.value.heading
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
