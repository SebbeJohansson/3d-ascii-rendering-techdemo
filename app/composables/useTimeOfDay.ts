import { DAY_LENGTH, NOON } from '~/environments/lighting'

/**
 * The time of day (see lighting.ts), shared by every environment and view. It starts at noon
 * on every visit; whether it cycles is remembered.
 */
export function useTimeOfDay() {
  return {
    time: useState('time-of-day', () => NOON),
    cycling: usePersistentState('day-cycle', () => false),
  }
}

/** Moves the time of day along while cycling. Call once per page. */
export function useDayCycle() {
  const { time, cycling } = useTimeOfDay()
  let frameId = 0
  let last = 0

  function tick(now: number) {
    frameId = requestAnimationFrame(tick)
    // Capped, so a frame after a stall (tab hidden) doesn't skip hours.
    const dt = Math.min(0.1, (now - (last || now)) / 1000)
    last = now
    if (cycling.value) time.value = (time.value + dt / DAY_LENGTH) % 1
  }

  onMounted(() => (frameId = requestAnimationFrame(tick)))
  onBeforeUnmount(() => cancelAnimationFrame(frameId))
}
