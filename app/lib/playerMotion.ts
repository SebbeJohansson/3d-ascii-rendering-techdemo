/**
 * How the spawned dragon or car moves, collides and is followed by the camera. Plain
 * functions on plain state, so the browser views and the terminal version share them.
 */
import type { Environment, Primitive } from '../environments/types'
import type { Player, PlayerPose } from '../players/types'
import type { CameraView } from './camera'
import { resolveCollisions } from './collision'

/** Where the chase camera sits around the player, set by dragging and the mouse wheel. */
export interface ChaseCamera {
  /** Radians around the player, added to its heading. 0 is straight behind. */
  yaw: number
  /** Radians above the horizon. */
  pitch: number
  /** Multiplies the player's camera distance. */
  zoom: number
  /** performance.now() of the last drag or scroll, for easing back behind the player. */
  touched: number
}

/** What the controls ask for this frame, each -1, 0 or 1. */
export interface PlayerInput {
  throttle: number
  /** Positive turns left. */
  steer: number
  /** Positive climbs. Only flyers use it. */
  climb: number
}

/** Motion carried between frames. */
export interface PlayerMotion {
  /** Forward speed in world units per second; negative is reverse. */
  speed: number
  /** The chase camera's heading, lagging behind the player's. */
  cameraHeading: number
}

/** The environment as far as moving around it goes. */
export interface World {
  primitives: Primitive[]
  extent: number
}

const MIN_PITCH = 0.02
const MAX_PITCH = 1.45
const MIN_ZOOM = 0.35
const MAX_ZOOM = 4
/** Seconds after the last drag or scroll before a moving player's camera eases back behind it. */
const RECENTER_DELAY = 1.5
/** How fast it eases back. Higher is snappier. */
const RECENTER_RATE = 1.5
/** Slower than this (world units per second) counts as standing still. */
const MOVING_SPEED = 1
/** Dragon climb and dive speed, world units per second. */
const CLIMB_SPEED = 30
const MAX_ALTITUDE = 300
/** How far above the tallest building or tree a dragon starts. */
const TAKEOFF_CLEARANCE = 15
/** How fast the chase camera swings round behind a turning player. Higher is snappier. */
const CAMERA_FOLLOW = 4

/** Shortest signed angle from a to b. */
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

/** The pitch a player's camera settings give, before any dragging. */
const defaultPitch = ({ camera }: Player) => Math.atan2(camera.height - camera.lookHeight, camera.distance)

/** Straight behind the player, at its own tilt and distance. */
export function defaultChase(player?: Player): ChaseCamera {
  return { yaw: 0, pitch: player ? defaultPitch(player) : 0.3, zoom: 1, touched: 0 }
}

/** Rotates the chase camera around the player. dx/dy are pointer movement in pixels (or cells). */
export function orbitChase(chase: ChaseCamera, dx: number, dy: number, viewportHeight: number) {
  chase.yaw -= (2 * Math.PI * dx) / viewportHeight
  chase.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, chase.pitch + (2 * Math.PI * dy) / viewportHeight))
  chase.touched = performance.now()
}

/** Moves the chase camera toward or away from the player. deltaY is a wheel delta. */
export function zoomChase(chase: ChaseCamera, deltaY: number) {
  chase.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, chase.zoom * Math.exp(deltaY * 0.001)))
  chase.touched = performance.now()
}

/** Eases a little way back to defaultChase(), for a frame `dt` seconds long. */
function recenterChase(chase: ChaseCamera, player: Player, dt: number) {
  const k = 1 - Math.exp(-RECENTER_RATE * dt)
  chase.yaw += angleTo(chase.yaw, 0) * k
  chase.pitch += (defaultPitch(player) - chase.pitch) * k
  // In log space, so zooming in and out ease back at the same pace.
  chase.zoom = Math.exp(Math.log(chase.zoom) * (1 - k))
}

/** Where a flyer starts: clear above everything in the environment. */
function takeoffHeight(world: World) {
  return world.primitives.reduce((top, p) => Math.max(top, p.y + p.height), 0) + TAKEOFF_CLEARANCE
}

/**
 * A fresh player: where the environment says (or the camera looks), facing away from the
 * camera so it starts out behind it. Flyers start above everything.
 */
export function spawnPose(env: Environment, size: number, view: CameraView, player: Player, world: World): PlayerPose {
  const { position: p, target: t } = view
  const [x, , z] = env.spawn?.(size, view) ?? t
  const heading = Math.atan2(-(t[2] - p[2]), t[0] - p[0])
  return { position: [x, player.flies ? takeoffHeight(world) : 0, z], heading }
}

/**
 * The pose after swapping to another player in place. A dragon takes off from where the car
 * was; a car drops to the ground under the dragon.
 */
export function swapPose({ position: [x, y, z], heading }: PlayerPose, player: Player, world: World): PlayerPose {
  return { position: [x, player.flies ? Math.max(y, takeoffHeight(world)) : 0, z], heading }
}

/** Moves the player for a frame `dt` seconds long. Updates motion.speed. */
export function stepPlayer(player: Player, pose: PlayerPose, motion: PlayerMotion, { throttle, steer, climb }: PlayerInput, world: World, dt: number): PlayerPose {
  let { position: [x, y, z], heading } = pose
  let { speed } = motion

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
  if (player.flies) y = Math.min(MAX_ALTITUDE, Math.max(0, y + climb * CLIMB_SPEED * dt))

  // Keep out of buildings, trees and rocks, and on the environment's ground.
  const collided = resolveCollisions(world.primitives, [x, y, z], player.collider, player.flies)
  ;[x, y, z] = collided.position
  // Scraping along a wall bleeds off speed.
  if (collided.hit) speed *= Math.exp(-4 * dt)
  const edge = world.extent / 2 - player.collider.radius
  x = Math.min(edge, Math.max(-edge, x))
  z = Math.min(edge, Math.max(-edge, z))

  motion.speed = speed
  return { position: [x, y, z], heading }
}

/**
 * The chase camera's view after the player moved from `from` to `pose` in a frame `dt`
 * seconds long. Swings round after the player with a short lag, at the angle and distance
 * the mouse set; once the player moves and the mouse has been left alone a moment, it eases
 * back behind. Updates motion.cameraHeading and `chase`.
 */
export function followPlayer(player: Player, from: PlayerPose, pose: PlayerPose, motion: PlayerMotion, chase: ChaseCamera, dt: number): CameraView {
  const [x, y, z] = pose.position
  const moving = Math.hypot(x - from.position[0], y - from.position[1], z - from.position[2]) > MOVING_SPEED * dt
  if (moving && performance.now() - chase.touched > RECENTER_DELAY * 1000) recenterChase(chase, player, dt)

  motion.cameraHeading += angleTo(motion.cameraHeading, pose.heading) * (1 - Math.exp(-CAMERA_FOLLOW * dt))
  const { distance, height, lookHeight } = player.camera
  const { yaw, pitch, zoom } = chase
  const around = motion.cameraHeading + yaw
  const reach = Math.hypot(distance, height - lookHeight) * zoom
  const ty = y + lookHeight
  return {
    position: [
      x - Math.cos(around) * Math.cos(pitch) * reach,
      Math.max(1, ty + Math.sin(pitch) * reach),
      z + Math.sin(around) * Math.cos(pitch) * reach,
    ],
    target: [x, ty, z],
  }
}
