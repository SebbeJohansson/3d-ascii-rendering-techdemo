import type { Environment, Mesh, Primitive } from '~/environments'
import type { DropSpot } from '~/lib/boxes'
import type { Camera } from '~/lib/raycaster'
import { canPlace, DRAW_TOOLS, COLORS, DEFAULT_CELLS, DEFAULT_PROFILE, fallShapes, GRID, placeShape, removeShape, shapeBounds, shapeBoxes, shapeMeshes, type DrawnShape, type Drawing, type DrawTool } from '~/lib/shapes'

/**
 * The draw mode: orbiting, where a click places the shape drawn in the panel. Picked in the
 * panel instead of a player. Shared by every view.
 */
export function useDrawMode() {
  return useState('draw-mode', () => false)
}

/** A JSON value saved like usePersistentState, read back through `valid`. */
function usePersistentJson<T>(key: string, init: () => T, valid: (value: unknown) => value is T) {
  const raw = usePersistentState(key, () => JSON.stringify(init()))
  return computed<T>({
    get() {
      try {
        const value = JSON.parse(raw.value)
        if (valid(value)) return value
      }
      catch {
        // Corrupt: fall back to the default.
      }
      return init()
    },
    set(value) {
      raw.value = JSON.stringify(value)
    },
  })
}

const isProfile = (v: unknown): v is [number, number][] =>
  Array.isArray(v) && v.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number'))
const isCells = (v: unknown): v is number[] => Array.isArray(v) && v.every(n => Number.isInteger(n) && n >= 0 && n < GRID * GRID)

/** What is drawn in the panel, and with which tool. Shared by every environment and saved across reloads. */
export function useDrawing() {
  const toolSetting = usePersistentState<string>('draw-tool', () => 'spin')
  const tool = computed<DrawTool>({
    get: () => (DRAW_TOOLS.includes(toolSetting.value as DrawTool) ? toolSetting.value as DrawTool : 'spin'),
    set: (t) => {
      toolSetting.value = t
    },
  })
  const profile = usePersistentJson('draw-profile', () => DEFAULT_PROFILE, isProfile)
  const cells = usePersistentJson('draw-cells', () => DEFAULT_CELLS, isCells)
  const spinSize = usePersistentState('draw-spin-size', () => 12)
  const extrudeSize = usePersistentState('draw-extrude-size', () => 16)
  const extrudeHeight = usePersistentState('draw-extrude-height', () => 3)
  const blobSize = usePersistentState('draw-blob-size', () => 4)
  /** One of COLORS, or -1 for a random one per shape. */
  const color = usePersistentState<number>('draw-color', () => -1)
  const sizes = { spin: spinSize, extrude: extrudeSize, blobs: blobSize }

  return {
    tool,
    profile,
    cells,
    sizes,
    extrudeHeight,
    color,
    /** The drawing for the current tool. */
    drawing: computed<Drawing>(() => ({ profile: profile.value, cells: cells.value, size: sizes[tool.value].value, height: extrudeHeight.value })),
    /** Whether there is enough drawn for a click to place something. */
    ready: computed(() => canPlace(tool.value, { profile: profile.value, cells: cells.value, size: 1, height: 1 })),
    resetProfile: () => (profile.value = DEFAULT_PROFILE),
    resetCells: () => (cells.value = DEFAULT_CELLS),
  }
}

const newRoll = () => Math.floor(Math.random() * COLORS.length)
const NONE: DrawnShape[] = []

/** The fall running per environment, so only one steps its shapes however many views share them. */
const falling = new Map<string, number>()

/**
 * Shapes drawn into an environment, shared by its views. With the boxes' gravity on, shapes
 * placed in the air fall. They belong to one world: a new seed or size starts without any.
 */
export function useShapes(env: Environment) {
  const { seed, size } = useSceneSettings(env)
  const { tool, drawing, color } = useDrawing()
  const gravity = useBoxGravity()
  /** The random color of the next shape, so a preview could show it. */
  const roll = useState('shape-roll', newRoll)
  const state = useState<{ world: string, items: DrawnShape[] }>(`shapes-${env.id}`, () => ({ world: '', items: NONE }))
  const world = computed(() => `${seed.value}:${size.value}`)
  const items = computed(() => (state.value.world === world.value ? state.value.items : NONE))

  // Raw, so the meshes can be posted to workers as they are.
  function set(next: DrawnShape[]) {
    state.value = { world: world.value, items: markRaw(next) }
  }

  /** Steps falling shapes every frame until all of them rest, or gravity is turned off. */
  function fall() {
    if (!gravity.value || falling.has(env.id)) return
    let last = performance.now()
    const tick = (now: number) => {
      // Capped, so a frame after a stall (tab hidden) doesn't drop shapes through what is below.
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const next = gravity.value ? fallShapes(items.value, dt) : undefined
      if (!next) {
        falling.delete(env.id)
        return
      }
      set(next)
      falling.set(env.id, requestAnimationFrame(tick))
    }
    falling.set(env.id, requestAnimationFrame(tick))
  }

  const shape = (spot: DropSpot, camera: Camera) =>
    placeShape(tool.value, drawing.value, spot, camera, COLORS[color.value] ?? COLORS[roll.value]!)

  return {
    /** Spun shapes and the blob sculpture, as meshes for the views. */
    meshes: computed<Mesh[]>(() => markRaw(shapeMeshes(items.value))),
    /** Extruded shapes, as boxes: they go with the dropped boxes. */
    boxes: computed<Primitive[]>(() => markRaw(shapeBoxes(items.value))),
    count: computed(() => items.value.length),
    /** Places the drawn shape at a clicked spot, seen with `camera`. */
    place(spot: DropSpot, camera: Camera) {
      const next = shape(spot, camera)
      if (!next) return
      set([...items.value, next])
      roll.value = newRoll()
      fall()
    },
    /** The box a click there would fill. */
    preview(spot: DropSpot, camera: Camera) {
      const next = shape(spot, camera)
      return next && shapeBounds(next)
    },
    /** Takes out the drawn shape a click landed on. */
    remove({ drawn, point }: { drawn?: number, point: DropSpot['point'] }) {
      if (drawn !== undefined) set(removeShape(items.value, drawn, point))
    },
    /** Lets shapes left in the air fall, after gravity is turned on. */
    fall,
    undo() {
      set(items.value.slice(0, -1))
    },
    clear() {
      state.value = { world: '', items: NONE }
    },
  }
}
