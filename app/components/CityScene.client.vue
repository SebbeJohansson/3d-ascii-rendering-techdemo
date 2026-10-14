<script setup lang="ts">
import * as THREE from 'three/webgpu'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const props = defineProps<{
  seed: number
  blocks: number
}>()

const emit = defineEmits<{
  stats: [stats: { buildings: number, backend: string }]
}>()

const container = ref<HTMLDivElement>()

const { scene, camera, buildCity, dispose } = createCityScene()
let renderer: THREE.WebGPURenderer | undefined
let controls: OrbitControls | undefined
let resizeObserver: ResizeObserver | undefined
let unmounted = false

function rebuild() {
  const buildings = buildCity(props.seed, props.blocks)
  emit('stats', { buildings, backend: renderer ? backendName(renderer) : '' })
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

  controls = createOrbitControls(camera, renderer.domElement)
  rebuild()

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container.value!)
  resize()

  renderer.setAnimationLoop(() => {
    controls!.update()
    renderer!.render(scene, camera)
  })
})

watch(() => [props.seed, props.blocks], rebuild)

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
