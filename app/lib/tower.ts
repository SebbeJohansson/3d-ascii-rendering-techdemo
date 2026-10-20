/**
 * The stacking tower game. A box swings back and forth above the tower, along x and z by
 * turns; dropping it lets it fall straight down. The part over the box below stays, and the
 * next box is that size; the overhang is cut off and falls past. Missing the tower ends the
 * game. The score is the number of boxes stacked.
 */
import type { Primitive } from '../environments/types'
import { fallBoxes, type DroppedBox, type DropSpot } from './boxes'

/** Sides of the base, m. */
const BASE_SIDE = 8
const BASE_HEIGHT = 2
/** Height of every stacked box, m. */
const LAYER = 1.5
/** Gap between the swinging box and the top of the tower, m. */
const ABOVE = 3
/** How far past the top box the swing reaches on either side, m. */
const REACH = 5
/** Swing speed, m/s: it starts at SPEED and speeds up with every box stacked. */
const SPEED = 6
const SPEED_UP = 0.4
const MAX_SPEED = 20
/** A drop this close to the box below lands exactly on it. */
const SNAP = 0.25
/** Less overlap than this is a miss. */
const MIN_SIDE = 0.05

export interface TowerGame {
  /** The base, the stacked boxes and the cut-off pieces, then the swinging box while playing. */
  boxes: DroppedBox[]
  /** Index in `boxes` of the top of the tower. */
  top: number
  /** Height of the top of the tower, once the box falling onto it has landed. */
  height: number
  /** Boxes stacked. */
  score: number
  /** Missed: nothing swings any more. */
  over: boolean
  /** Seconds the box has been swinging. */
  swing: number
}

/** The tower's colors run through the hues, one step per box. */
function layerColor(layer: number) {
  const h = ((layer * 23) % 360) / 60
  const c = 0.55
  const x = c * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  const byte = (v: number) => Math.round((v + 0.35) * 255)
  return (byte(r) << 16) | (byte(g) << 8) | byte(b)
}

const box = (fields: Pick<Primitive, 'x' | 'y' | 'z' | 'width' | 'depth' | 'height' | 'color' | 'label'>): Primitive =>
  ({ shape: 'box', roughness: 0.6, dropped: true, ...fields })

/** Starts a tower with its base on a clicked spot. */
export function startTower({ point: [x, y, z], normal, floor }: DropSpot): TowerGame {
  // On top of what was clicked, or on the floor beside a wall.
  const bottom = normal[1] >= 0.5 ? y : floor
  const base = box({ x, y: bottom, z, width: BASE_SIDE, depth: BASE_SIDE, height: BASE_HEIGHT, color: layerColor(0), label: 'Tower base' })
  return withSwing({ boxes: [{ box: base, floor: bottom, speed: 0, stuck: true }], top: 0, height: bottom + BASE_HEIGHT, score: 0, over: false, swing: 0 })
}

/** Whether the box swings along x; z otherwise. */
const alongX = (game: TowerGame) => game.score % 2 === 0

/** The swinging box where it is after `game.swing` seconds: back and forth over the top box. */
function swingingBox(game: TowerGame): Primitive {
  const top = game.boxes[game.top]!.box
  const x = alongX(game)
  const reach = (x ? top.width : top.depth) + REACH
  const speed = Math.min(MAX_SPEED, SPEED + SPEED_UP * game.score)
  // From one end to the other and back, starting at the near end.
  const f = ((game.swing * speed) / (2 * reach)) % 1
  const offset = reach * (f < 0.5 ? 4 * f - 1 : 3 - 4 * f)
  return box({
    x: top.x + (x ? offset : 0),
    y: game.height + ABOVE,
    z: top.z + (x ? 0 : offset),
    width: top.width,
    depth: top.depth,
    height: LAYER,
    color: layerColor(game.score + 1),
    label: `Tower box ${game.score + 1}`,
  })
}

/** Adds the swinging box, stuck where it swings until dropped. */
function withSwing(game: TowerGame): TowerGame {
  const floor = game.boxes[0]!.floor
  return { ...game, boxes: [...game.boxes, { box: swingingBox(game), floor, speed: 0, stuck: true }] }
}

/**
 * Moves the swinging box and lets dropped boxes and pieces fall for `dt` seconds. Undefined
 * when nothing moves: the game is over and everything has landed.
 */
export function stepTower(game: TowerGame, dt: number): TowerGame | undefined {
  let next = game
  if (!game.over) {
    next = { ...game, swing: game.swing + dt, boxes: [...game.boxes] }
    const last = next.boxes.length - 1
    next.boxes[last] = { ...next.boxes[last]!, box: swingingBox(next) }
  }
  const fallen = fallBoxes(next.boxes, dt)
  if (fallen) return { ...next, boxes: fallen }
  return game.over ? undefined : next
}

/**
 * Drops the swinging box: the part over the top box falls onto it and the overhang falls
 * past. A miss falls whole and ends the game.
 */
export function dropTower(game: TowerGame): TowerGame {
  if (game.over) return game
  const boxes = game.boxes.slice(0, -1)
  const { box: swung, floor } = game.boxes.at(-1)!
  const top = game.boxes[game.top]!.box
  const x = alongX(game)
  const key = x ? 'x' : 'z'
  const side = x ? 'width' : 'depth'
  const at = Math.abs(swung[key] - top[key]) < SNAP ? top[key] : swung[key]
  const from = at - swung[side] / 2
  const to = at + swung[side] / 2
  const lo = Math.max(from, top[key] - top[side] / 2)
  const hi = Math.min(to, top[key] + top[side] / 2)
  const falling = (b: Primitive): DroppedBox => ({ box: b, floor, speed: 0 })
  if (hi - lo < MIN_SIDE) return { ...game, boxes: [...boxes, falling(swung)], over: true }

  const part = (a: number, b: number, label: string | undefined) => ({ ...swung, [key]: (a + b) / 2, [side]: b - a, label })
  boxes.push(falling(part(lo, hi, swung.label)))
  const placed = boxes.length - 1
  if (from < lo) boxes.push(falling(part(from, lo, 'Cut-off piece')))
  if (to > hi) boxes.push(falling(part(hi, to, 'Cut-off piece')))
  return withSwing({ boxes, top: placed, height: game.height + LAYER, score: game.score + 1, over: false, swing: 0 })
}
