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

const { scene, camera, build, dispose } = createEnvironmentScene()
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
  rebuild()

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container.value!)
  resize()

  renderer.setAnimationLoop(() => {
    // CPU time to update and submit the frame. The GPU finishes the work asynchronously.
    const start = performance.now()
    controls!.update()
    renderer!.render(scene, camera)
    meter.frame(performance.now() - start)
    meter.tick()
  })
})

watch(() => [props.env, props.seed, props.size], rebuild)

onBeforeUnmount(() => {
  unmounted = true
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
