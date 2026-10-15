import { dragon as dragonEnvironment, flapWings } from '../environments/dragon'
import type { Player } from './types'

/** Mesh detail for the rideable dragon. It is shrunk to a quarter, so finer detail is wasted. */
const DETAIL = 2

/** The dragon from the dragon environment, shrunk to ride over cities and forests. */
export const dragon: Player = {
  id: 'dragon',
  name: 'Dragon',
  scale: 0.25,
  flies: true,
  speed: 70,
  acceleration: 40,
  turnRate: 1.4,
  camera: { distance: 42, height: 14, lookHeight: 10 },

  build(seed) {
    // A different seed than the environment's, so a dragon ridden past the dragon
    // environment's own one usually gets other colors.
    const mesh = dragonEnvironment.generate(seed + 1, DETAIL).meshes![0]!
    return { mesh, animate: time => flapWings(mesh, time) }
  },
}
