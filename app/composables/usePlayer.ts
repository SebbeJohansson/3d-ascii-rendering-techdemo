import type { Environment, EnvironmentScene } from '~/environments'
import { resolveCollisions } from '~/lib/collision'
import { getPlayer, type Player, type PlayerKind, type PlayerPose } from '~/players'

/** Which player is spawned, if any. Shared by every environment and view. */
export function usePlayerKind() {
  return useState<PlayerKind | null>('player-kind', () => null)
}

/** Where the player is in an environment, shared by its 3D and ASCII views. */
export function usePlayerPose(env: Environment) {
  return useState<PlayerPose | undefined>(`player-${env.id}`, () => undefined)
}

/** Where the chase camera sits around the player, set by dragging and the mouse wheel. */
interface ChaseCamera {
  /** Radians around the player, added to its heading. 0 is straight behind. */
  yaw: number
  /** Radians above the horizon. */
  pitch: number
  /** Multiplies the player's camera distance. */
  zoom: number
}

const MIN_PITCH = 0.02
const MAX_PITCH = 1.45
const MIN_ZOOM = 0.35
const MAX_ZOOM = 4

/** The pitch a player's camera settings give, before any dragging. */
const defaultPitch = ({ camera }: Player) => Math.atan2(camera.height - camera.lookHeight, camera.distance)

/**
 * The chase camera around the spawned player. Both views turn mouse input into orbit() and
 * zoom() calls, with the same feel as orbiting without a player.
 */
export function useChaseCamera() {
  const chase = useState<ChaseCamera>('chase-camera', () => ({ yaw: 0, pitch: 0.3, zoom: 1 }))
  return {
    chase,
    /** Rotates around the player. dx/dy are pointer movement in pixels. */
    orbit(dx: number, dy: number, viewportHeight: number) {
      const { yaw, pitch } = chase.value
      chase.value.yaw = yaw - (2 * Math.PI * dx) / viewportHeight
      chase.value.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch + (2 * Math.PI * dy) / viewportHeight))
    },
    /** Moves toward or away from the player. deltaY is a wheel delta. */
    zoom(deltaY: number) {
      chase.value.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, chase.value.zoom * Math.exp(deltaY * 0.001)))
    },
    reset(player: Player) {
      chase.value = { yaw: 0, pitch: defaultPitch(player), zoom: 1 }
    },
  }
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
  const { seed, size } = useSceneSettings(env)
  const chaseCamera = useChaseCamera()
  const { chase } = chaseCamera
  const held = new Set<string>()
  let speed = 0
  let cameraHeading = 0
  let frameId = 0
  let last = 0
  /** The environment's solids to collide with, generated when first needed. */
  let world: EnvironmentScene | undefined
  watch([seed, size], () => (world = undefined))

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
    if (k) chaseCamera.reset(getPlayer(k))
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

    // Keep out of buildings, trees and rocks, and on the environment's ground.
    world ??= env.generate(seed.value, size.value)
    const collided = resolveCollisions(world.primitives, [x, y, z], player.collider, player.flies)
    ;[x, y, z] = collided.position
    // Scraping along a wall bleeds off speed.
    if (collided.hit) speed *= Math.exp(-4 * dt)
    const edge = world.extent / 2 - player.collider.radius
    x = Math.min(edge, Math.max(-edge, x))
    z = Math.min(edge, Math.max(-edge, z))
    pose.value = { position: [x, y, z], heading }

    // Chase camera: swings round after the player with a short lag, at the angle and
    // distance the mouse set.
    cameraHeading += angleTo(cameraHeading, heading) * (1 - Math.exp(-CAMERA_FOLLOW * dt))
    const { distance, height, lookHeight } = player.camera
    const { yaw, pitch, zoom } = chase.value
    const around = cameraHeading + yaw
    const reach = Math.hypot(distance, height - lookHeight) * zoom
    const ty = y + lookHeight
    view.value = {
      position: [
        x - Math.cos(around) * Math.cos(pitch) * reach,
        Math.max(1, ty + Math.sin(pitch) * reach),
        z + Math.sin(around) * Math.cos(pitch) * reach,
      ],
      target: [x, ty, z],
    }
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
