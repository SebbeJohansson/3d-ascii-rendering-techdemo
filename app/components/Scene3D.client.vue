<script setup lang="ts">
import type * as THREE from 'three/webgpu'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Environment } from '~/environments'
import { lightingAt } from '~/environments/lighting'
import { createFrameMeter, type FramePerf } from '~/lib/frameMeter'
import { createShaderAscii } from '~/lib/gpu/shaderAscii'
import { backendName, createEnvironmentScene, createOrbitControls, getSharedRenderer } from '~/lib/three'
import { createScenePicker, type Picked } from '~/lib/tracers'

const props = defineProps<{
  env: Environment
  seed: number
  size: number
  /**
   * Draw the view as ASCII with a post-processing shader instead (see lib/gpu/shaderAscii.ts),
   * on a canvas of its own so it can sit next to the plain 3D view.
   */
  ascii?: { fontSize: number, color: boolean, cellBackground: boolean }
}>()

const emit = defineEmits<{
  stats: [stats: string]
  perf: [perf: FramePerf]
  grid: [grid: { cols: number, rows: number }]
}>()

const container = ref<HTMLDivElement>()
const view = useCameraView(props.env)
const playerKind = usePlayerKind()
const playerPose = usePlayerPose(props.env)
/** A spawned player owns the camera: the mouse moves its chase camera, not the orbit controls. */
const following = computed(() => !!playerPose.value)
const chaseCamera = useChaseCamera()
let drag: { x: number, y: number } | undefined
/** Where the last press started: a press that ends near it is a click. */
let press: { x: number, y: number } | undefined
/** A press that moves less than this many pixels is a click, not a drag. */
const CLICK_SLOP = 4
/** What the last click landed on, shown beside where it landed until the next press. */
const inspected = ref<Picked & { x: number, y: number }>()
const picker = createScenePicker()
const boxMode = useBoxMode()
const { boxes, drop, remove } = useBoxes(props.env)

function onPointerDown(e: PointerEvent) {
  press = e.button === 0 || e.button === 2 ? { x: e.clientX, y: e.clientY } : undefined
  inspected.value = undefined
  if (!following.value) return
  container.value!.setPointerCapture(e.pointerId)
  drag = { x: e.clientX, y: e.clientY }
}

function onPointerMove(e: PointerEvent) {
  if (!drag || !following.value) return
  chaseCamera.orbit(e.clientX - drag.x, e.clientY - drag.y, container.value!.clientHeight)
  drag = { x: e.clientX, y: e.clientY }
}

function onPointerUp(e: PointerEvent) {
  if (press && e.type === 'pointerup' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < CLICK_SLOP) inspect(e)
  press = undefined
  drag = undefined
}

/**
 * Names what is under the pointer, with the ray tracer's copy of the scene on show, or drops
 * a box there: in the air with Shift. A right click takes out a box.
 */
function inspect(e: PointerEvent) {
  if (!boxMode.value && (e.button !== 0 || e.shiftKey)) return
  const generated = environmentScene()
  if (!generated) return
  const rect = container.value!.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const position = camera.position.toArray()
  const target = camera.position.clone().add(camera.getWorldDirection(camera.position.clone())).toArray()
  const picked = picker.pick(props.env, generated, playerPose.value, performance.now() / 1000, { position, target, fov: camera.fov, aspect: camera.aspect }, x / rect.width, y / rect.height)
  if (boxMode.value) {
    if (e.button === 2 && picked?.box !== undefined) remove(picked.box)
    else if (e.button !== 2 && picked && picked.kind !== 'player') drop(picked, e.shiftKey)
    return
  }
  inspected.value = picked ? { ...picked, x, y } : undefined
}

function onWheel(e: WheelEvent) {
  inspected.value = undefined
  if (!following.value) return
  e.preventDefault()
  chaseCamera.zoom(e.deltaY)
}

const { time: timeOfDay } = useTimeOfDay()

const { scene, camera, build, setBoxes, animate, setPlayer, placePlayer, setTimeOfDay, generated: environmentScene, dispose } = createEnvironmentScene()
let renderer: THREE.WebGPURenderer | undefined
let shaderAscii: ReturnType<typeof createShaderAscii> | undefined
let controls: OrbitControls | undefined
let resizeObserver: ResizeObserver | undefined
let unmounted = false
const meter = createFrameMeter(perf => emit('perf', perf))

function rebuild() {
  inspected.value = undefined
  showStats(build(props.env, props.seed, props.size))
}

function showStats(summary: string) {
  emit('stats', `${summary} · ${props.ascii ? 'shader ASCII · ' : ''}${renderer ? backendName(renderer) : ''}`)
}

function resize() {
  if (!renderer || !container.value) return
  const { clientWidth: w, clientHeight: h } = container.value
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  if (shaderAscii && props.ascii) {
    // The same character cell as the ray-traced ASCII view's: an 'M' wide, 7/6 of the font tall.
    const { fontSize } = props.ascii
    const measure = document.createElement('canvas').getContext('2d')!
    measure.font = `${fontSize}px ui-monospace, Menlo, Consolas, monospace`
    const cellWidth = measure.measureText('M').width
    const cellHeight = (fontSize * 7) / 6
    shaderAscii.setCellSize(cellWidth, cellHeight)
    emit('grid', { cols: Math.floor(w / cellWidth), rows: Math.floor(h / cellHeight) })
  }
}

onMounted(async () => {
  // .client components render their template after mount; wait for the refs to exist.
  await nextTick()
  const gpu = await getSharedRenderer(props.ascii ? 'shader-ascii' : '3d')
  // Navigated away (or hot-reloaded) while the GPU was starting up.
  if (unmounted) return
  renderer = gpu
  container.value!.appendChild(renderer.domElement)
  if (props.ascii) shaderAscii = createShaderAscii(renderer, scene, camera)

  controls = createOrbitControls(camera, renderer.domElement, view)
  controls.enabled = !following.value
  rebuild()

  // Dev only: lets the browser console reach the live scene, e.g.
  // __scene.traverse(o => o.material?.color?.set('hotpink'))
  if (import.meta.dev) Object.assign(window, { __scene: scene, __camera: camera, __renderer: renderer })

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container.value!)
  resize()

  renderer.setAnimationLoop(() => {
    // CPU time to update and submit the frame. The GPU finishes the work asynchronously.
    const start = performance.now()
    animate(start / 1000)
    placePlayer(playerPose.value, start / 1000)
    setTimeOfDay(timeOfDay.value)
    // Orbit controls would pull the chase camera out to their minimum distance.
    if (!following.value) controls!.update()
    if (shaderAscii && props.ascii) {
      const { color, cellBackground } = props.ascii
      shaderAscii.setStyle({ sky: lightingAt(timeOfDay.value, props.env.sky).sky, color, cellBackground })
      shaderAscii.pipeline.render()
    }
    else renderer!.render(scene, camera)
    meter.frame(performance.now() - start)
    meter.tick()
  })
})

watch(() => [props.env, props.seed, props.size], rebuild)
watch(boxes, (b) => {
  const summary = setBoxes(b)
  if (summary) showStats(summary)
}, { immediate: true })
watch(() => props.ascii?.fontSize, resize)
watch([playerKind, () => props.seed], ([kind, seed]) => {
  setPlayer(kind, seed)
  picker.setPlayer(kind, seed)
}, { immediate: true })
watch(following, (on) => {
  if (controls) controls.enabled = !on
})

// Follow camera moves made elsewhere (the ASCII half of the split view). Our own controls
// write here too, but then the camera already matches and nothing happens.
watch(view, ({ position, target }) => {
  if (!controls) return
  if (following.value) {
    camera.position.set(...position)
    camera.lookAt(...target)
    // Orbiting resumes around the player once it is removed.
    controls.target.set(...target)
    return
  }
  const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-6)
  if (same(camera.position.toArray(), position) && same(controls.target.toArray(), target)) return
  // Drop any glide left over from an earlier drag here: one undamped update applies and
  // clears it. Otherwise it keeps rotating this view away from the other one.
  controls.enableDamping = false
  controls.update()
  controls.enableDamping = true
  camera.position.set(...position)
  controls.target.set(...target)
  controls.update()
})

onBeforeUnmount(() => {
  unmounted = true
  if (import.meta.dev && (window as { __scene?: unknown }).__scene === scene) {
    Object.assign(window, { __scene: undefined, __camera: undefined, __renderer: undefined })
  }
  resizeObserver?.disconnect()
  renderer?.setAnimationLoop(null)
  controls?.dispose()
  // Keep the shared renderer alive for the next visit; only detach its canvas.
  renderer?.domElement.remove()
  shaderAscii?.dispose()
  dispose()
})
</script>

<template>
  <div
    ref="container"
    class="scene"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
    @contextmenu.prevent
  >
    <InspectLabel v-if="inspected" :picked="inspected" :x="inspected.x" :y="inspected.y" :left="inspected.x > container!.clientWidth / 2" />
  </div>
</template>

<style scoped>
.scene {
  position: absolute;
  inset: 0;
}
</style>
