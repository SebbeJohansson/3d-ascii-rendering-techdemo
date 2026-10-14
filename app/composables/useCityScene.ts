import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CAMERA_FOV, MAX_DISTANCE, MAX_POLAR_ANGLE, MIN_DISTANCE, type Vec3 } from './useCitySettings'
import {
  BLOCK_SIZE, BUILDING_METALNESS, FOG_FAR, FOG_NEAR, HEMI_GROUND_COLOR, HEMI_INTENSITY, HEMI_SKY_COLOR,
  ROAD_COLOR, ROAD_WIDTH, SIDEWALK_COLOR, SIDEWALK_HEIGHT, SKY_COLOR, SUN_COLOR, SUN_INTENSITY, SUN_POSITION,
} from '../utils/city'

/** Builds the scene graph for a city. Rendering is left to the caller. */
export function createCityScene() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 5000)

  const cityGroup = new THREE.Group()
  scene.add(cityGroup)

  // One unit cube with its base at y=0, scaled per instance.
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
  const buildingMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: BUILDING_METALNESS })

  scene.background = new THREE.Color(SKY_COLOR)
  scene.fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR)

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

  function disposeCity() {
    for (const child of cityGroup.children) {
      const mesh = child as THREE.Mesh
      if (mesh.geometry !== boxGeometry) mesh.geometry.dispose()
      if (mesh.material !== buildingMaterial) (mesh.material as THREE.Material).dispose()
      if (mesh instanceof THREE.InstancedMesh) mesh.dispose()
    }
    cityGroup.clear()
  }

  /** Replaces the current city. Returns the number of buildings. */
  function buildCity(seed: number, blocks: number) {
    disposeCity()
    const { buildings, size } = generateCity({ seed, blocks, blockSize: BLOCK_SIZE, roadWidth: ROAD_WIDTH })

    // Asphalt underneath everything, then raised sidewalk slabs per block.
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: ROAD_COLOR, roughness: 1 }),
    )
    road.receiveShadow = true
    cityGroup.add(road)

    const pitch = BLOCK_SIZE + ROAD_WIDTH
    const sidewalks = new THREE.InstancedMesh(
      boxGeometry,
      new THREE.MeshStandardMaterial({ color: SIDEWALK_COLOR, roughness: 1 }),
      blocks * blocks,
    )
    sidewalks.receiveShadow = true
    const m = new THREE.Matrix4()
    let i = 0
    for (let bx = 0; bx < blocks; bx++) {
      for (let bz = 0; bz < blocks; bz++) {
        const x = -size / 2 + ROAD_WIDTH + bx * pitch + BLOCK_SIZE / 2
        const z = -size / 2 + ROAD_WIDTH + bz * pitch + BLOCK_SIZE / 2
        m.makeScale(BLOCK_SIZE, SIDEWALK_HEIGHT, BLOCK_SIZE).setPosition(x, 0, z)
        sidewalks.setMatrixAt(i++, m)
      }
    }
    cityGroup.add(sidewalks)

    // All buildings in a single draw call.
    const mesh = new THREE.InstancedMesh(boxGeometry, buildingMaterial, buildings.length)
    mesh.castShadow = true
    mesh.receiveShadow = true
    const color = new THREE.Color()
    buildings.forEach((b, idx) => {
      m.makeScale(b.width, b.height, b.depth).setPosition(b.x, SIDEWALK_HEIGHT, b.z)
      mesh.setMatrixAt(idx, m)
      mesh.setColorAt(idx, color.setHex(b.color))
    })
    cityGroup.add(mesh)

    return buildings.length
  }

  function dispose() {
    disposeCity()
    boxGeometry.dispose()
    buildingMaterial.dispose()
  }

  return { scene, camera, buildCity, dispose }
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

/** Orbit controls that read and write the shared camera view. */
export function createOrbitControls(camera: THREE.PerspectiveCamera, element: HTMLElement) {
  const view = useCameraView()

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
