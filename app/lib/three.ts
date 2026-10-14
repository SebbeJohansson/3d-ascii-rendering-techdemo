import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Ref } from 'vue'
import type { Environment, EnvironmentScene, Primitive, Shape } from '../environments/types'
import { HEMI_GROUND_COLOR, HEMI_INTENSITY, HEMI_SKY_COLOR, SUN_COLOR, SUN_INTENSITY, SUN_POSITION } from '../environments/lighting'
import { CAMERA_FOV, MAX_DISTANCE, MAX_POLAR_ANGLE, MIN_DISTANCE, type CameraView } from './camera'
import type { Vec3 } from './math'

/**
 * Unit shapes with their base at y = 0, scaled per instance to each primitive's
 * width × height × depth. Same conventions as the ray tracer.
 */
const UNIT_GEOMETRY: Record<Shape, () => THREE.BufferGeometry> = {
  box: () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0),
  cone: () => new THREE.ConeGeometry(0.5, 1, 12).translate(0, 0.5, 0),
  sphere: () => new THREE.SphereGeometry(0.5, 16, 12).translate(0, 0.5, 0),
}

/** Builds the three scene graph for an environment. Rendering is left to the caller. */
export function createEnvironmentScene() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 5000)
  const content = new THREE.Group()
  scene.add(content)

  scene.add(new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY))
  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY)
  sun.position.set(...SUN_POSITION)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.bias = -0.0005
  const s = sun.shadow.camera
  s.left = s.bottom = -600
  s.right = s.top = 600
  s.far = 2000
  scene.add(sun)

  function clear() {
    for (const child of content.children) {
      const mesh = child as THREE.Mesh
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      if (mesh instanceof THREE.InstancedMesh) mesh.dispose()
    }
    content.clear()
  }

  /** The environment and generated scene on show, for animate(). */
  let current: { env: Environment, scene: EnvironmentScene, geometries: THREE.BufferGeometry[] } | undefined

  /** Replaces the current content. Returns the environment's summary, e.g. "530 buildings". */
  function build(env: Environment, seed: number, size: number) {
    clear()
    const generated = env.generate(seed, size)
    const { primitives, meshes = [], extent, summary } = generated
    current = { env, scene: generated, geometries: [] }

    scene.background = new THREE.Color(env.sky)
    scene.fog = new THREE.Fog(env.sky, env.fogNear, env.fogFar)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(extent, extent).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: env.ground, roughness: 1 }),
    )
    ground.receiveShadow = true
    content.add(ground)

    // One instanced mesh (one draw call) per shape + material combination.
    const groups = new Map<string, Primitive[]>()
    for (const p of primitives) {
      const key = `${p.shape}|${p.roughness ?? 1}|${p.metalness ?? 0}`
      const group = groups.get(key)
      if (group) group.push(p)
      else groups.set(key, [p])
    }
    const m = new THREE.Matrix4()
    const color = new THREE.Color()
    for (const group of groups.values()) {
      const { shape, roughness = 1, metalness = 0 } = group[0]!
      const mesh = new THREE.InstancedMesh(
        UNIT_GEOMETRY[shape](),
        new THREE.MeshStandardMaterial({ roughness, metalness }),
        group.length,
      )
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.forEach((p, i) => {
        m.makeScale(p.width, p.height, p.depth).setPosition(p.x, p.y, p.z)
        mesh.setMatrixAt(i, m)
        mesh.setColorAt(i, color.setHex(p.color))
      })
      content.add(mesh)
    }

    for (const m of meshes) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(m.colors, 3))
      geometry.setIndex(new THREE.BufferAttribute(m.indices, 1))
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: m.roughness ?? 1, metalness: m.metalness ?? 0 }),
      )
      mesh.castShadow = true
      mesh.receiveShadow = true
      // Moving vertices make the precomputed bounding sphere wrong; don't cull with it.
      mesh.frustumCulled = !env.animate
      content.add(mesh)
      current.geometries.push(geometry)
    }
    return summary
  }

  /** Poses an animated environment for `time` (seconds) and uploads the moved vertices. */
  function animate(time: number) {
    if (!current?.env.animate) return
    current.env.animate(current.scene, time)
    for (const geometry of current.geometries) {
      geometry.attributes.position!.needsUpdate = true
      geometry.attributes.normal!.needsUpdate = true
    }
  }

  return { scene, camera, build, animate, dispose: clear }
}

export function backendName(renderer: THREE.WebGPURenderer) {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'
}

let sharedRenderer: Promise<THREE.WebGPURenderer> | undefined

/**
 * One renderer for the whole session, reused across page visits. Disposing it destroys
 * the GPU device while three still has pipeline error checks pending, which then fail
 * with "Instance dropped in popErrorScope".
 */
export function getSharedRenderer() {
  sharedRenderer ??= (async () => {
    const renderer = new THREE.WebGPURenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    await renderer.init()
    return renderer
  })()
  return sharedRenderer
}

/** Orbit controls that start from, and keep writing to, a shared camera view. */
export function createOrbitControls(camera: THREE.PerspectiveCamera, element: HTMLElement, view: Ref<CameraView>) {
  const controls = new OrbitControls(camera, element)
  controls.enableDamping = true
  controls.maxPolarAngle = MAX_POLAR_ANGLE
  controls.minDistance = MIN_DISTANCE
  controls.maxDistance = MAX_DISTANCE

  camera.position.set(...view.value.position)
  controls.target.set(...view.value.target)
  controls.update()

  // Fires every frame while damping settles, so the saved view is always the one on screen.
  controls.addEventListener('change', () => {
    view.value = {
      position: camera.position.toArray() as Vec3,
      target: controls.target.toArray() as Vec3,
    }
  })

  return controls
}
