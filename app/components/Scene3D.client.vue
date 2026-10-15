<script setup lang="ts">
import type * as THREE from 'three/webgpu'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Environment } from '~/environments'
import { createFrameMeter, type FramePerf } from '~/lib/frameMeter'
import { backendName, createEnvironmentScene, createOrbitControls, getSharedRenderer } from '~/lib/three'

const props = defineProps<{
  env: Environment
  seed: number
  size: number
}>()

const emit = defineEmits<{
  stats: [stats: string]
  perf: [perf: FramePerf]
}>()

const container = ref<HTMLDivElement>()
const view = useCameraView(props.env)
const playerKind = usePlayerKind()
const playerPose = usePlayerPose(props.env)
/** A spawned player owns the camera; mouse orbiting is off until it is removed. */
const following = computed(() => !!playerPose.value)

const { scene, camera, build, animate, setPlayer, placePlayer, dispose } = createEnvironmentScene()
let renderer: THREE.WebGPURenderer | undefined
let controls: OrbitControls | undefined
let resizeObserver: ResizeObserver | undefined
let unmounted = false
const meter = createFrameMeter(perf => emit('perf', perf))

function rebuild() {
  const summary = build(props.env, props.seed, props.size)
  emit('stats', `${summary} · ${renderer ? backendName(renderer) : ''}`)
}

function resize() {
  if (!renderer || !container.value) return
  const { clientWidth: w, clientHeight: h } = container.value
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

onMounted(async () => {
  // .client components render their template after mount; wait for the refs to exist.
  await nextTick()
  const gpu = await getSharedRenderer()
  // Navigated away (or hot-reloaded) while the GPU was starting up.
  if (unmounted) return
  renderer = gpu
  container.value!.appendChild(renderer.domElement)

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
    // Orbit controls would pull the chase camera out to their minimum distance.
    if (!following.value) controls!.update()
    renderer!.render(scene, camera)
    meter.frame(performance.now() - start)
    meter.tick()
  })
})

watch(() => [props.env, props.seed, props.size], rebuild)
watch([playerKind, () => props.seed], ([kind, seed]) => setPlayer(kind, seed), { immediate: true })
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
  dispose()
})
</script>

<template>
  <div ref="container" class="scene" />
</template>

<style scoped>
.scene {
  position: absolute;
  inset: 0;
}
</style>
