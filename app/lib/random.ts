/** Small, fast seeded PRNG so the same seed always gives the same world. Returns 0..1. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Picks a random element. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!
}

/** Random number in [min, max). */
export function between(rand: () => number, min: number, max: number) {
  return min + rand() * (max - min)
}

/**
 * Smooth 2D value noise in 0..1. Random values on a grid `spacing` apart, blended with
 * smoothstep between them: nearby points get similar values, which makes natural-looking
 * patches (clearings, dense groves) instead of per-point randomness.
 */
export function createValueNoise(seed: number, spacing: number) {
  const lattice = (ix: number, iz: number) => {
    let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const smooth = (t: number) => t * t * (3 - 2 * t)

  return (x: number, z: number) => {
    const fx = x / spacing
    const fz = z / spacing
    const ix = Math.floor(fx)
    const iz = Math.floor(fz)
    const tx = smooth(fx - ix)
    const tz = smooth(fz - iz)
    const top = lattice(ix, iz) + (lattice(ix + 1, iz) - lattice(ix, iz)) * tx
    const bottom = lattice(ix, iz + 1) + (lattice(ix + 1, iz + 1) - lattice(ix, iz + 1)) * tx
    return top + (bottom - top) * tz
  }
}
