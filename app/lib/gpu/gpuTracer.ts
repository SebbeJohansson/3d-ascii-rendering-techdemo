/// <reference types="@webgpu/types" />
/**
 * The ray tracer on the GPU: the scene is built on the CPU exactly as for the CPU tracer
 * (buildRaycastScene, the same grid and BVHs), uploaded once, and every frame one compute
 * shader invocation per cell traces it (raytrace.wgsl.ts). The result is read back into the
 * same TracedFrame the CPU tracers produce, so drawing, outlines and the lens are shared.
 *
 * Given a canvas, it skips the readback instead: a second shader (present.wgsl.ts) draws the
 * output buffer onto the canvas, one cell per pixel, and onFrame gets a frame with only its
 * size and timing.
 */
import { getEnvironment } from '../../environments'
import type { EnvironmentScene } from '../../environments/types'
import { NOON } from '../../environments/lighting'
import type { Bvh } from '../bvh'
import { linearToSrgbByte } from '../color'
import { cameraBasis } from '../math'
import { buildRaycastScene, type RaycastPlayer, type RaycastScene } from '../raycaster'
import { createPlayerSlot, poseScene, type TracedFrame, type Tracer, type TracerEvents } from '../tracers'
import { PRESENT_WGSL } from './present.wgsl'
import { RAYTRACE_WGSL } from './raytrace.wgsl'

const WORKGROUP = 8
/** Words per cell in the output buffer: rgb + ink, depth, normal. */
const CELL_WORDS = 3
/** 19 vec4s; see Params in the shader. */
const PARAMS_BYTES = 19 * 16

let devicePromise: Promise<GPUDevice | null> | undefined

/** One device for every GPU tracer, or null where WebGPU isn't available. */
export function getGpuDevice() {
  devicePromise ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) return null
    return adapter.requestDevice()
  })()
  return devicePromise
}

/** Whether this browser has WebGPU at all. The device can still fail to start. */
export const hasWebGpu = () => typeof navigator !== 'undefined' && !!navigator.gpu

/** A BVH's floats and integers, laid out as the shader expects: see raytrace.wgsl.ts. */
function packBvh(source: { bvh: Bvh, normals: Float32Array, albedo: Float32Array }) {
  const { bvh, normals, albedo } = source
  const floats = new Float32Array(bvh.bounds.length + bvh.positions.length + normals.length + albedo.length)
  const positions = bvh.bounds.length
  const normalsAt = positions + bvh.positions.length
  const albedoAt = normalsAt + normals.length
  floats.set(bvh.bounds, 0)
  floats.set(bvh.positions, positions)
  floats.set(normals, normalsAt)
  floats.set(albedo, albedoAt)
  const uints = new Uint32Array(bvh.nodes.length + bvh.order.length + bvh.indices.length)
  uints.set(bvh.nodes, 0)
  uints.set(bvh.order, bvh.nodes.length)
  uints.set(bvh.indices, bvh.nodes.length + bvh.order.length)
  return { floats, uints, offsets: { positions, normals: normalsAt, albedo: albedoAt, order: bvh.nodes.length, indices: bvh.nodes.length + bvh.order.length } }
}

type PackedBvh = ReturnType<typeof packBvh>

export function createGpuTracer({ onScene, onFrame }: TracerEvents, canvas?: HTMLCanvasElement): Tracer {
  let device: GPUDevice | null | undefined
  let pipeline: GPUComputePipeline | undefined
  /** With a canvas: what draws the output buffer onto it. */
  let present: { context: GPUCanvasContext, pipeline: GPURenderPipeline, params: GPUBuffer, bindGroup?: GPUBindGroup } | undefined
  let disposed = false
  let busy = false

  let generated: EnvironmentScene | undefined
  let scene: RaycastScene | undefined
  let currentEnv = ''
  const player = createPlayerSlot()
  /** The player whose BVH is on the GPU, to notice when another one is spawned. */
  let uploadedPlayer: RaycastPlayer | undefined

  const params = new ArrayBuffer(PARAMS_BYTES)
  const pf = new Float32Array(params)
  const pu = new Uint32Array(params)
  let buffers: Record<'params' | 'prims' | 'grid' | 'meshF' | 'meshU' | 'playerF' | 'playerU', GPUBuffer> | undefined
  let mesh: PackedBvh | undefined
  let playerPacked: PackedBvh | undefined
  /** No readback buffer when drawing to a canvas: the cells never leave the GPU. */
  let output: { cells: number, buffer: GPUBuffer, readback?: GPUBuffer } | undefined
  let bindGroup: GPUBindGroup | undefined
  /** Set before the device is ready; applied once it is. */
  let pendingScene: [string, number, number] | undefined

  const ready = getGpuDevice().then((d) => {
    device = d
    if (!d || disposed) return
    pipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code: RAYTRACE_WGSL }), entryPoint: 'main' },
    })
    if (canvas) {
      const format = navigator.gpu.getPreferredCanvasFormat()
      const context = canvas.getContext('webgpu')!
      context.configure({ device: d, format, alphaMode: 'opaque' })
      const module = d.createShaderModule({ code: PRESENT_WGSL })
      present = {
        context,
        pipeline: d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        }),
        params: d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      }
    }
    if (pendingScene) setScene(...pendingScene)
  })

  /** A storage buffer holding `data` (at least 16 bytes: WebGPU has no empty buffers). */
  function storage(data: ArrayBufferView, extraUsage = 0) {
    const buffer = device!.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage })
    if (data.byteLength) device!.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength)
    return buffer
  }

  function replace(key: keyof NonNullable<typeof buffers>, buffer: GPUBuffer) {
    buffers![key]?.destroy()
    buffers![key] = buffer
    bindGroup = undefined
  }

  function setScene(envId: string, seed: number, size: number) {
    if (!device) {
      pendingScene = [envId, seed, size]
      return
    }
    const env = getEnvironment(envId)
    generated = env.generate(seed, size)
    scene = buildRaycastScene(env, generated)
    currentEnv = envId

    const count = scene.shapes.length
    const prims = new Float32Array(count * 10)
    for (let p = 0; p < count; p++) {
      prims.set(scene.bounds.subarray(p * 6, p * 6 + 6), p * 10)
      prims.set(scene.colors.subarray(p * 3, p * 3 + 3), p * 10 + 6)
      prims[p * 10 + 9] = scene.shapes[p]! + 256 * scene.windows[p]!
    }
    const grid = new Uint32Array(scene.cellStart.length + scene.cellItems.length)
    grid.set(scene.cellStart, 0)
    grid.set(scene.cellItems, scene.cellStart.length)
    mesh = scene.mesh && packBvh(scene.mesh)

    buffers ??= {} as NonNullable<typeof buffers>
    if (!buffers.params) buffers.params = device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    replace('prims', storage(prims))
    replace('grid', storage(grid))
    replace('meshF', storage(mesh?.floats ?? new Float32Array(4)))
    replace('meshU', storage(mesh?.uints ?? new Uint32Array(4)))
    if (!buffers.playerF) {
      replace('playerF', storage(new Float32Array(4)))
      replace('playerU', storage(new Uint32Array(4)))
    }
    onScene(generated.summary)
  }

  /** Uploads a newly spawned player's BVH, or the parts that move (all of it, for a flapping dragon). */
  function syncPlayer(p: RaycastPlayer | undefined) {
    if (!p) return
    if (p !== uploadedPlayer) {
      playerPacked = packBvh(p)
      replace('playerF', storage(playerPacked.floats))
      replace('playerU', storage(playerPacked.uints))
      uploadedPlayer = p
    }
    else writeMoved(buffers!.playerF, p.bvh, p.normals, playerPacked!)
  }

  /** Re-uploads the parts of a BVH that animation changes: node bounds, positions, normals. */
  function writeMoved(buffer: GPUBuffer, bvh: { bounds: Float32Array, positions: Float32Array }, normals: Float32Array, packed: PackedBvh) {
    // The arrays are plain (never shared) buffers; TypeScript can't tell from the type.
    const write = (at: number, data: Float32Array) => device!.queue.writeBuffer(buffer, at * 4, data as Float32Array<ArrayBuffer>)
    write(0, bvh.bounds)
    write(packed.offsets.positions, bvh.positions)
    write(packed.offsets.normals, normals)
  }

  function writeParams(camera: Parameters<Tracer['render']>[0], cols: number, rows: number) {
    const s = scene!
    const { forward, right, up } = cameraBasis(camera.position, camera.target)
    const L = s.light
    const set = (slot: number, v: readonly number[], w: number) => pf.set([v[0]!, v[1]!, v[2]!, w], slot * 4)
    set(0, camera.position, Math.tan((camera.fov * Math.PI) / 360))
    set(1, forward, camera.aspect)
    set(2, right, s.half)
    set(3, up, s.maxHeight)
    set(4, L.sun, s.cellSize)
    set(5, L.sunLight, s.fogNear)
    set(6, L.hemiSky, s.fogFar)
    set(7, L.hemiGround, L.night)
    set(8, L.sky, L.maxLight)
    set(9, L.windowGlow, L.minLight)
    set(10, s.ground, s.reflectance)
    const p = s.player
    set(11, p ? [p.x, p.y, p.z] : [0, 0, 0], p?.scale ?? 1)
    set(12, [p?.cos ?? 1, p?.sin ?? 0, 0], 0)
    pu.set([cols, rows, s.cells, s.shapes.length], 13 * 4)
    pu.set(mesh ? [mesh.offsets.positions, mesh.offsets.normals, mesh.offsets.albedo, 1] : [0, 0, 0, 0], 14 * 4)
    pu.set(mesh ? [mesh.offsets.order, mesh.offsets.indices, 0, 0] : [0, 0, 0, 0], 15 * 4)
    pu.set(p && playerPacked ? [playerPacked.offsets.positions, playerPacked.offsets.normals, playerPacked.offsets.albedo, 1] : [0, 0, 0, 0], 16 * 4)
    pu.set(p && playerPacked ? [playerPacked.offsets.order, playerPacked.offsets.indices, 0, 0] : [0, 0, 0, 0], 17 * 4)
    pu.set([s.cellStart.length, s.occlusion ? 1 : 0, 0, 0], 18 * 4)
    device!.queue.writeBuffer(buffers!.params, 0, params)
  }

  function ensureOutput(count: number) {
    if (output && output.cells >= count) return
    output?.buffer.destroy()
    output?.readback?.destroy()
    const size = Math.max(16, count * CELL_WORDS * 4)
    output = {
      cells: count,
      buffer: device!.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      readback: present ? undefined : device!.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    }
    bindGroup = undefined
    if (present) present.bindGroup = undefined
  }

  async function render(camera: Parameters<Tracer['render']>[0], cols: number, rows: number, time: number, pose?: Parameters<Tracer['render']>[4], timeOfDay = NOON, occlusion = false) {
    if (busy || !device || !pipeline || !scene || !generated || !buffers) return
    busy = true
    const start = performance.now()
    const env = getEnvironment(currentEnv)

    // Light, animate and place everything on the CPU, as the CPU tracers do; then upload
    // only what moved.
    poseScene(currentEnv, generated, scene, time, timeOfDay)
    if (env.animate && scene.mesh && mesh) writeMoved(buffers.meshF, scene.mesh.bvh, scene.mesh.normals, mesh)
    player.attach(scene, pose, time)
    syncPlayer(scene.player)
    scene.occlusion = occlusion

    const count = cols * rows
    ensureOutput(count)
    writeParams(camera, cols, rows)
    bindGroup ??= device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [buffers.params, buffers.prims, buffers.grid, buffers.meshF, buffers.meshU, buffers.playerF, buffers.playerU, output!.buffer]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    })

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(cols / WORKGROUP), Math.ceil(rows / WORKGROUP))
    pass.end()
    if (present) {
      drawToCanvas(encoder, present, cols, rows)
      device.queue.submit([encoder.finish()])
      await device.queue.onSubmittedWorkDone()
      if (disposed) return
      busy = false
      const none = { ink: new Uint8Array(0), rgb: new Uint8Array(0), depths: new Float32Array(0), normals: new Int8Array(0) }
      onFrame({ cols, rows, ...none, traceMs: performance.now() - start })
      return
    }
    const bytes = count * CELL_WORDS * 4
    const readback = output!.readback!
    encoder.copyBufferToBuffer(output!.buffer, 0, readback, 0, bytes)
    device.queue.submit([encoder.finish()])

    await readback.mapAsync(GPUMapMode.READ, 0, bytes)
    if (disposed) return
    const words = new Uint32Array(readback.getMappedRange(0, bytes).slice(0))
    readback.unmap()

    const frame: TracedFrame = {
      cols,
      rows,
      ink: new Uint8Array(count),
      rgb: new Uint8Array(count * 3),
      depths: new Float32Array(count),
      normals: new Int8Array(count * 3),
      traceMs: 0,
    }
    const depthBits = new Uint32Array(frame.depths.buffer)
    for (let i = 0; i < count; i++) {
      const c = words[i * 3]!
      frame.rgb[i * 3] = c & 255
      frame.rgb[i * 3 + 1] = (c >>> 8) & 255
      frame.rgb[i * 3 + 2] = (c >>> 16) & 255
      frame.ink[i] = c >>> 24
      depthBits[i] = words[i * 3 + 1]!
      const n = words[i * 3 + 2]!
      frame.normals[i * 3] = (n << 24) >> 24
      frame.normals[i * 3 + 1] = (n << 16) >> 24
      frame.normals[i * 3 + 2] = (n << 8) >> 24
    }
    frame.traceMs = performance.now() - start
    busy = false
    onFrame(frame)
  }

  function drawToCanvas(encoder: GPUCommandEncoder, p: NonNullable<typeof present>, cols: number, rows: number) {
    const sky = scene!.light.sky.map(c => linearToSrgbByte(c) / 255)
    device!.queue.writeBuffer(p.params, 0, new Float32Array([cols, rows, canvas!.width, canvas!.height, ...sky, 1]))
    p.bindGroup ??= device!.createBindGroup({
      layout: p.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: p.params } }, { binding: 1, resource: { buffer: output!.buffer } }],
    })
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: p.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    })
    pass.setPipeline(p.pipeline)
    pass.setBindGroup(0, p.bindGroup)
    pass.draw(3)
    pass.end()
  }

  return {
    label: 'WebGPU compute',
    get busy() {
      return busy
    },
    setScene,
    setPlayer: player.set,
    render(...args) {
      void render(...args).catch((error) => {
        busy = false
        console.error('GPU ray tracer:', error)
      })
    },
    dispose() {
      disposed = true
      for (const buffer of Object.values(buffers ?? {})) buffer.destroy()
      present?.params.destroy()
      present?.context.unconfigure()
      output?.buffer.destroy()
      output?.readback?.destroy()
    },
  }
}
