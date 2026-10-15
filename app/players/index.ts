import { car } from './car'
import { dragon } from './dragon'
import type { Player, PlayerKind } from './types'

export type { Player, PlayerKind, PlayerModel, PlayerPose } from './types'

/** Everything that can be spawned, in the order the panel lists them. */
export const PLAYERS: Player[] = [dragon, car]

export function getPlayer(kind: PlayerKind): Player {
  return PLAYERS.find(p => p.id === kind)!
}
