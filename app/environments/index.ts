import { city } from './city'
import { dragon } from './dragon'
import { forest } from './forest'
import { mountains } from './mountains'
import { ocean } from './ocean'
import type { Environment } from './types'

export type { Environment, EnvironmentScene, Mesh, Primitive, Shape } from './types'

/** Every environment, in the order the panel lists them. */
export const ENVIRONMENTS: Environment[] = [city, forest, ocean, mountains, dragon]

export function findEnvironment(id: unknown): Environment | undefined {
  return ENVIRONMENTS.find(env => env.id === id)
}

export function getEnvironment(id: string): Environment {
  const env = findEnvironment(id)
  if (!env) throw new Error(`Unknown environment: ${id}`)
  return env
}
