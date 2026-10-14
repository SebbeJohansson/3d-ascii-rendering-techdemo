import { city } from './city'
import type { Environment } from './types'

export type { Environment, EnvironmentScene, Primitive, Shape } from './types'

/** Every environment, in the order the panel lists them. */
export const ENVIRONMENTS: Environment[] = [city]

export function findEnvironment(id: unknown): Environment | undefined {
  return ENVIRONMENTS.find(env => env.id === id)
}

export function getEnvironment(id: string): Environment {
  const env = findEnvironment(id)
  if (!env) throw new Error(`Unknown environment: ${id}`)
  return env
}
