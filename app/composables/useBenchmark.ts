import type { Environment } from '~/environments'
import { DEFAULT_VIEW, type CameraView } from '~/lib/camera'
import type { FramePerf } from '~/lib/frameMeter'
import type { Vec3 } from '~/lib/math'

export type ViewMode = '3d' | 'ascii' | 'split'
type BenchmarkView = '3d' | 'ascii'

/** Seconds per view. The first WARMUP seconds (shader compiles, first trace) aren't counted. */
const DURATION = 12
const WARMUP = 2

export interface BenchmarkResult {
  view: BenchmarkView
  /** What drew it, e.g. "WebGPU" or "8 workers". */
  label: string
  /** Averages over the measured part of the run. */
  fps: number
  ms: number
  /** The slowest half-second window. */
  worstFps: number
}

interface BenchmarkState {
  env: string
  /** Views still to run, the current one first. */
  queue: BenchmarkView[]
  results: BenchmarkResult[]
  /** The page to come back to afterwards. */
  returnTo: string
  running: boolean
  /** Seconds into the current view's run, for the progress line. */
  elapsed: number
}

export function viewPath(envId: string, mode: ViewMode) {
  return mode === '3d' ? `/${envId}` : `/${envId}/${mode}`
}

/**
 * The benchmark's camera path, `u` from 0 to 1: one full circle around the environment's
 * starting view, zooming in towards the middle of the lap and back out.
 */
function benchmarkView({ position: p, target: t }: CameraView, u: number): CameraView {
  const ox = p[0] - t[0]
  const oz = p[2] - t[2]
  const radius = Math.hypot(ox, oz)
  const angle = Math.atan2(ox, oz) + 2 * Math.PI * u
  const zoom = 1 - 0.35 * Math.sin(Math.PI * u)
  const position: Vec3 = [t[0] + radius * zoom * Math.sin(angle), t[1] + (p[1] - t[1]) * zoom, t[2] + radius * zoom * Math.cos(angle)]
  return { position, target: [...t] }
}

/** Starting, stopping and reading the benchmark. Shared by every page. */
export function useBenchmark() {
  const state = useState<BenchmarkState | null>('benchmark', () => null)
  const playerKind = usePlayerKind()
  const route = useRoute()
  return {
    state,
    /** Runs the 3D view, then the ASCII view, then returns to the current page. */
    start(env: Environment) {
      // The player would steer the camera; the benchmark needs it on its own path.
      playerKind.value = null
      state.value = { env: env.id, queue: ['3d', 'ascii'], results: [], returnTo: route.fullPath, running: true, elapsed: 0 }
      return navigateTo(viewPath(env.id, '3d'))
    },
    stop() {
      if (state.value) state.value.running = false
    },
    clear() {
      state.value = null
    },
    duration: DURATION,
  }
}

/**
 * Runs this page's share of the benchmark when it is this view's turn: flies the camera,
 * collects the renderer's perf reports, then moves on to the next view. Call it from the
 * 3D and ASCII pages with the perf and stats their renderer emits.
 */
export function useBenchmarkRun(env: Environment, view: BenchmarkView, perf: Ref<FramePerf | undefined>, stats: Ref<string | undefined>) {
  const { state } = useBenchmark()
  const camera = useCameraView(env)
  let frameId = 0
  let samples: FramePerf[] = []
  let measuring = false
  let done = false

  const myTurn = () => !!state.value?.running && state.value.env === env.id && state.value.queue[0] === view

  function finish() {
    done = true
    const s = state.value!
    const avg = (f: (p: FramePerf) => number) => samples.reduce((n, p) => n + f(p), 0) / Math.max(1, samples.length)
    s.results.push({
      view,
      label: stats.value?.split(' · ').at(-1) ?? '',
      fps: avg(p => p.fps),
      ms: avg(p => p.ms),
      worstFps: Math.min(...samples.map(p => p.fps)),
    })
    s.queue.shift()
    if (!s.queue.length) s.running = false
    return navigateTo(s.queue.length ? viewPath(env.id, s.queue[0]!) : s.returnTo)
  }

  function begin() {
    done = false
    const start = structuredClone(env.camera ?? DEFAULT_VIEW)
    const t0 = performance.now()
    samples = []
    measuring = false
    const tick = (now: number) => {
      if (!state.value?.running) return
      const t = (now - t0) / 1000
      if (t >= DURATION) {
        camera.value = benchmarkView(start, 1)
        void finish()
        return
      }
      measuring = t >= WARMUP
      camera.value = benchmarkView(start, t / DURATION)
      // Tenths only, so the panel's progress line doesn't re-render every frame.
      state.value.elapsed = Math.floor(t * 10) / 10
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
  }

  watch(perf, (p) => {
    if (measuring && p) samples.push(p)
  })

  // Starting the benchmark from this very page doesn't remount it, so watch instead of onMounted.
  watch(myTurn, turn => turn && begin(), { immediate: true })

  onBeforeUnmount(() => {
    cancelAnimationFrame(frameId)
    // Left the page some other way mid-run: that's a cancel.
    if (myTurn() && !done) state.value!.running = false
  })
}
