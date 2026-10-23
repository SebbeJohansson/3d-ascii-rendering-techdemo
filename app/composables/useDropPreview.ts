import type { Environment } from '~/environments'
import { boxOutline } from '~/lib/boxes'
import { towerBase } from '~/lib/tower'
import type { Camera } from '~/lib/raycaster'
import type { Picked } from '~/lib/tracers'

/** What is under a point of a view, picked with the camera the view shows. */
export interface ViewPick {
  picked: Picked | null
  camera: Camera
  /** The view's size in CSS pixels. */
  width: number
  height: number
}

/**
 * Over a view in the boxes mode, the outline of the box a click would drop there, in the air
 * while Shift is held, as an SVG path. In the tower mode, between games, the outline of the
 * base a click would start a tower with; in the draw mode, of the box the drawn shape would
 * fill. `pickAt` picks at a point of the view.
 */
export function useDropPreview(env: Environment, pickAt: (x: number, y: number) => ViewPick | undefined | Promise<ViewPick | undefined>) {
  const boxMode = useBoxMode()
  const { boxes, preview } = useBoxes(env)
  const towerMode = useTowerMode()
  const { game } = useTower(env)
  const drawMode = useDrawMode()
  const { drawing, ready } = useDrawing()
  const shapes = useShapes(env)
  const active = () => boxMode.value || (towerMode.value && (!game.value || game.value.over)) || (drawMode.value && ready.value)
  const outline = shallowRef<string>()
  let pointer: { x: number, y: number } | undefined
  let shift = false
  let dragging = false
  // One pick at a time; a move during one picks again after it.
  let busy = false
  let again = false

  async function update() {
    if (!active() || dragging || !pointer) {
      outline.value = undefined
      return
    }
    if (busy) {
      again = true
      return
    }
    busy = true
    const view = await pickAt(pointer.x, pointer.y)
    busy = false
    if (again) {
      again = false
      return update()
    }
    const picked = view?.picked
    if (!view || !picked || picked.kind === 'player' || !pointer || dragging || !active()) {
      outline.value = undefined
      return
    }
    const shown = boxMode.value ? preview(picked, shift) : drawMode.value ? shapes.preview(picked, view.camera) : towerBase(picked)
    outline.value = shown && boxOutline(shown, view.camera, view.width, view.height)
  }

  /** The frame an update is waiting for: pointer moves come faster than frames, so they wait for one. */
  let frame = 0
  function schedule() {
    frame ||= requestAnimationFrame(() => {
      frame = 0
      update()
    })
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Shift' || e.shiftKey === shift || e.repeat) return
    shift = e.shiftKey
    update()
  }
  onMounted(() => {
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('keyup', onKey)
    cancelAnimationFrame(frame)
  })
  // A drop changes what is there and rolls the next box.
  // Counts, not the boxes and shapes themselves: picking every frame while they fall is slow.
  watch([() => boxes.value.length, boxMode, towerMode, drawMode, shapes.count, drawing], update)

  return {
    outline,
    /** The pointer is at (x, y) of the view; hidden while dragging. */
    move(x: number, y: number, shiftKey: boolean, drag: boolean) {
      pointer = { x, y }
      shift = shiftKey
      dragging = drag
      schedule()
    },
    leave() {
      pointer = undefined
      update()
    },
  }
}
