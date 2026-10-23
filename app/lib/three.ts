import * as THREE from 'three/webgpu'
import { abs, cameraPosition, color, float, floor, fract, normalWorld, positionWorld, pow, reflector, select, step, uniform } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Ref } from 'vue'
import type { Environment, EnvironmentScene, Mesh, Primitive, Shape } from '../environments/types'
import { getPlayer, type PlayerKind, type PlayerModel, type PlayerPose } from '../players'
import { HEMI_GROUND_COLOR, HEMI_INTENSITY, HEMI_SKY_COLOR, lightingAt, NOON, SUN_COLOR, SUN_INTENSITY, SUN_POSITION } from '../environments/lighting'
import { CAMERA_FOV, MAX_DISTANCE, MAX_POLAR_ANGLE, MIN_DISTANCE, type CameraView } from './camera'
import { withBoxes } from './boxes'
import { withShapes } from './shapes'
import type { Vec3 } from './math'
import { FLOOR_HEIGHT, GLASS_X, GLASS_Y, HASH_COLUMN, HASH_FACE, HASH_ROW, LIT_SHARE, WINDOW_COLOR, WINDOW_GLOW, WINDOW_SPACING } from './windows'

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

/**
 * Glow of lit windows, for a material's emissiveNode: the same steps as windowLit() in
 * lib/windows.ts, per pixel. `night` (0..1) dims it to nothing by day.
 */
function windowGlow(night: THREE.UniformNode<'float', number>) {
  const facesX = abs(normalWorld.x).greaterThan(0.5)
  // Position along the wall, and which way the wall faces: 0..3 for +x, -x, +z, -z.
  const u = select(facesX, positionWorld.z, positionWorld.x)
  const face = select(facesX, select(normalWorld.x.greaterThan(0), float(0), float(1)), select(normalWorld.z.greaterThan(0), float(2), float(3)))
  const fy = positionWorld.y.div(FLOOR_HEIGHT)
  const row = floor(fy)
  const gy = fy.sub(row)
  const fx = u.div(WINDOW_SPACING)
  const column = floor(fx)
  const gx = fx.sub(column)
  const glass = step(GLASS_X[0], gx).mul(step(gx, GLASS_X[1])).mul(step(GLASS_Y[0], gy)).mul(step(gy, GLASS_Y[1]))
  // windowHash(), in the shader's own 32-bit floats.
  const n = row.mul(HASH_ROW).add(column.mul(HASH_COLUMN)).add(face.mul(HASH_FACE))
  const p1 = fract(n.mul(0.1031))
  const p2 = p1.mul(p1.add(33.33))
  const p3 = p2.mul(p2.add(p2))
  const lit = step(fract(p3), LIT_SHARE)
  // Walls only, not roofs.
  const wall = step(abs(normalWorld.y), 0.5)
  return color(WINDOW_COLOR).mul(glass.mul(lit).mul(wall).mul(night).mul(WINDOW_GLOW))
}

/** A shadow-casting three mesh for one of our triangle meshes. */
function createMesh(m: Mesh) {
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
  return mesh
}

/**
 * A calm sea `size` wide, which mirrors the scene above it: its own color is lit as usual and
 * the mirror image is added on top, more of it at grazing angles (Schlick's Fresnel). The same
 * blend as the ray tracer's.
 */
function createSea(water: number, reflectance: number, size: number) {
  const mirror = reflector({ resolutionScale: 0.5, bounces: false })
  // The mirror plane is the target's xy plane: turn it to lie flat, facing up.
  mirror.target.rotateX(-Math.PI / 2)
  const view = cameraPosition.sub(positionWorld).normalize()
  const k = pow(float(1).sub(view.y.max(0)), 5).mul(1 - reflectance).add(reflectance)
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 1 })
  material.colorNode = color(water).mul(float(1).sub(k))
  material.emissiveNode = mirror.rgb.mul(k)
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), material)
  sea.add(mirror.target)
  // Its render target isn't freed with the material.
  sea.userData.dispose = () => mirror.dispose()
  return sea
}

function disposeMesh(mesh: THREE.Mesh) {
  mesh.geometry.dispose()
  ;(mesh.material as THREE.Material).dispose()
}

/**
 * One instanced mesh (one draw call) for primitives of one shape and material, which come
 * from the first of them. `night` (0..1) lights windows.
 */
function createInstances(group: Primitive[], night: THREE.UniformNode<'float', number>) {
  const { shape, roughness = 1, metalness = 0, windows } = group[0]!
  const material = new THREE.MeshStandardMaterial({ roughness, metalness })
  if (windows) material.emissiveNode = windowGlow(night)
  const mesh = new THREE.InstancedMesh(UNIT_GEOMETRY[shape](), material, group.length)
  mesh.castShadow = true
  mesh.receiveShadow = true
  placeInstances(mesh, group)
  return mesh
}

/** Moves, sizes and colors each instance as its primitive. */
function placeInstances(mesh: THREE.InstancedMesh, group: Primitive[]) {
  const m = new THREE.Matrix4()
  const color = new THREE.Color()
  group.forEach((p, i) => {
    m.makeScale(p.width, p.height, p.depth).setPosition(p.x, p.y, p.z)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, color.setHex(p.color))
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  // Three culls with bounds it worked out once; falling boxes move out of them.
  mesh.computeBoundingSphere()
}

/** Builds the three scene graph for an environment. Rendering is left to the caller. */
export function createEnvironmentScene() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 5000)
  const content = new THREE.Group()
  scene.add(content)

  const hemi = new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY)
  scene.add(hemi)
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
  const sunDistance = Math.hypot(...SUN_POSITION)
  const night = uniform(0)
  let timeOfDay = NOON

  function clear() {
    for (const child of content.children) {
      const mesh = child as THREE.Mesh
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      if (mesh instanceof THREE.InstancedMesh) mesh.dispose()
      mesh.userData.dispose?.()
    }
    content.clear()
  }

  /** The environment and generated scene on show, for animate(). */
  let current: { env: Environment, scene: EnvironmentScene, geometries: THREE.BufferGeometry[] } | undefined

  /** Replaces the current content. Returns the environment's summary, e.g. "530 buildings". */
  function build(env: Environment, seed: number, size: number) {
    clear()
    const generated = env.generate(seed, size)
    const { primitives, meshes = [], extent } = generated
    current = { env, scene: generated, geometries: [] }
    withDropped = undefined

    scene.background = new THREE.Color(env.sky)
    scene.fog = new THREE.Fog(env.sky, env.fogNear, env.fogFar)
    applyLighting()

    const ground = env.reflectance ? createSea(env.ground, env.reflectance, extent + env.fogFar * 2) : new THREE.Mesh(
      new THREE.PlaneGeometry(extent, extent).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: env.ground, roughness: 1 }),
    )
    ground.receiveShadow = true
    content.add(ground)

    // One instanced mesh (one draw call) per shape + material combination.
    const groups = new Map<string, Primitive[]>()
    for (const p of primitives) {
      const key = `${p.shape}|${p.roughness ?? 1}|${p.metalness ?? 0}|${!!p.windows}`
      const group = groups.get(key)
      if (group) group.push(p)
      else groups.set(key, [p])
    }
    for (const group of groups.values()) content.add(createInstances(group, night))

    for (const m of meshes) {
      const mesh = createMesh(m)
      // Moving vertices make the precomputed bounding sphere wrong; don't cull with it.
      mesh.frustumCulled = !env.animate
      content.add(mesh)
      current.geometries.push(mesh.geometry)
    }
    return shown()!.summary
  }

  /** Dropped boxes, kept outside `content` so they change without rebuilding the environment. */
  let boxes: Primitive[] = []
  let boxMesh: THREE.InstancedMesh | undefined
  /** The generated scene with the boxes added, made when first asked for. */
  let withDropped: EnvironmentScene | undefined

  /** Replaces the dropped boxes. Returns the summary counting them, once something is built. */
  function setBoxes(next: Primitive[]) {
    boxes = next
    withDropped = undefined
    // Same boxes, moved (falling): no new mesh needed.
    if (boxMesh && boxMesh.count === boxes.length) {
      placeInstances(boxMesh, boxes)
      return shown()?.summary
    }
    if (boxMesh) {
      scene.remove(boxMesh)
      disposeMesh(boxMesh)
      boxMesh.dispose()
      boxMesh = undefined
    }
    if (boxes.length) scene.add(boxMesh = createInstances(boxes, night))
    return shown()?.summary
  }

  /** Meshes of drawn shapes, kept outside `content` like the boxes. */
  let shapes: Mesh[] = []
  let shapeMeshes: THREE.Mesh[] = []

  /** Replaces the drawn shapes' meshes. Returns the summary counting them, once something is built. */
  function setShapes(next: Mesh[]) {
    shapes = next
    withDropped = undefined
    for (const mesh of shapeMeshes) {
      scene.remove(mesh)
      disposeMesh(mesh)
    }
    shapeMeshes = shapes.map(createMesh)
    if (shapeMeshes.length) scene.add(...shapeMeshes)
    return shown()?.summary
  }

  /** Lights the scene for the time of day (see lighting.ts). */
  function applyLighting() {
    if (!current) return
    const light = lightingAt(timeOfDay, current.env.sky)
    sun.position.set(...(light.direction.map(v => v * sunDistance) as Vec3))
    sun.color.setHex(light.color)
    sun.intensity = light.intensity
    hemi.color.setHex(light.hemiSky)
    hemi.groundColor.setHex(light.hemiGround)
    hemi.intensity = light.hemiIntensity
    ;(scene.background as THREE.Color).setHex(light.sky)
    ;(scene.fog as THREE.Fog).color.setHex(light.sky)
    night.value = light.night
  }

  function setTimeOfDay(t: number) {
    if (t === timeOfDay) return
    timeOfDay = t
    applyLighting()
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

  /** The spawned player, kept outside `content` so rebuilding the environment keeps it. */
  let player: { model: PlayerModel, mesh: THREE.Mesh } | undefined

  /** Spawns a player (or removes it, with null). Its colors come from the seed. */
  function setPlayer(kind: PlayerKind | null, seed: number) {
    if (player) {
      scene.remove(player.mesh)
      disposeMesh(player.mesh)
      player = undefined
    }
    if (!kind) return
    const type = getPlayer(kind)
    const model = type.build(seed)
    const mesh = createMesh(model.mesh)
    mesh.scale.setScalar(type.scale)
    mesh.frustumCulled = !model.animate
    mesh.visible = false
    scene.add(mesh)
    player = { model, mesh }
  }

  /** Poses the player for `time` (seconds) and moves it to `pose`. */
  function placePlayer(pose: PlayerPose | undefined, time: number) {
    if (!player) return
    const { model, mesh } = player
    mesh.visible = !!pose
    if (!pose) return
    mesh.position.set(...pose.position)
    mesh.rotation.y = pose.heading
    if (model.animate) {
      model.animate(time)
      mesh.geometry.attributes.position!.needsUpdate = true
      mesh.geometry.attributes.normal!.needsUpdate = true
    }
  }

  function dispose() {
    clear()
    setBoxes([])
    setShapes([])
    setPlayer(null, 0)
  }

  /** The generated scene on show with the dropped boxes and drawn shapes, which animate() keeps posed. */
  function shown() {
    return current && (withDropped ??= withShapes(withBoxes(current.scene, boxes), shapes))
  }

  return { scene, camera, build, setBoxes, setShapes, animate, setPlayer, placePlayer, setTimeOfDay, generated: shown, dispose }
}

export function backendName(renderer: THREE.WebGPURenderer) {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'
}

const sharedRenderers = new Map<string, Promise<THREE.WebGPURenderer>>()

/**
 * One renderer per name for the whole session, reused across page visits: '3d' for the 3D
 * view, others for views that need their own canvas next to it. Disposing a renderer destroys
 * the GPU device while three still has pipeline error checks pending, which then fail with
 * "Instance dropped in popErrorScope".
 */
export function getSharedRenderer(name = '3d') {
  let renderer = sharedRenderers.get(name)
  if (!renderer) {
    renderer = (async () => {
      const r = new THREE.WebGPURenderer({ antialias: true })
      r.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      r.shadowMap.enabled = true
      r.shadowMap.type = THREE.PCFShadowMap
      await r.init()
      return r
    })()
    sharedRenderers.set(name, renderer)
  }
  return renderer
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
