import type { Environment } from '~/environments'
import { boxOutline } from '~/lib/boxes'
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
 * while Shift is held, as an SVG path. `pickAt` picks at a point of the view.
 */
export function useDropPreview(env: Environment, pickAt: (x: number, y: number) => ViewPick | undefined | Promise<ViewPick | undefined>) {
  const boxMode = useBoxMode()
  const { boxes, preview } = useBoxes(env)
  const outline = shallowRef<string>()
  let pointer: { x: number, y: number } | undefined
  let shift = false
  let dragging = false
  // One pick at a time; a move during one picks again after it.
  let busy = false
  let again = false

  async function update() {
    if (!boxMode.value || dragging || !pointer) {
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
    outline.value = picked && picked.kind !== 'player' && pointer && !dragging && boxMode.value
      ? boxOutline(preview(picked, shift), view.camera, view.width, view.height)
      : undefined
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
  })
  // A drop changes what is there and rolls the next box.
  watch([boxes, boxMode], update)

  return {
    outline,
    /** The pointer is at (x, y) of the view; hidden while dragging. */
    move(x: number, y: number, shiftKey: boolean, drag: boolean) {
      pointer = { x, y }
      shift = shiftKey
      dragging = drag
      update()
    },
    leave() {
      pointer = undefined
      update()
    },
  }
}
