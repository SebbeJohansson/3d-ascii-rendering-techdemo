export interface FramePerf {
  /** Frames actually drawn per second. 0 means nothing was redrawn in the last window. */
  fps: number
  /** Average time spent producing one frame, in milliseconds. */
  ms: number
  /** Optional breakdown of `ms`, averaged the same way. */
  parts?: Record<string, number>
}

/**
 * Averages frame timings over short windows. Call frame() after each drawn frame
 * and tick() on every animation frame, drawn or not.
 */
export function createFrameMeter(report: (perf: FramePerf) => void, windowMs = 500) {
  let frames = 0
  let total = 0
  let lastMs = 0
  let parts: Record<string, number> = {}
  let lastParts: Record<string, number> | undefined
  let start = performance.now()

  return {
    frame(ms: number, breakdown?: Record<string, number>) {
      frames++
      total += ms
      for (const key in breakdown) parts[key] = (parts[key] ?? 0) + breakdown[key]!
    },
    tick() {
      const now = performance.now()
      if (now - start < windowMs) return
      if (frames) {
        lastMs = total / frames
        lastParts = Object.keys(parts).length
          ? Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v / frames]))
          : undefined
      }
      report({ fps: (frames * 1000) / (now - start), ms: lastMs, parts: lastParts })
      frames = 0
      total = 0
      parts = {}
      start = now
    },
  }
}
