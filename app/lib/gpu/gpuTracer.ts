/// <reference types="@webgpu/types" />
/**
 * The ray tracer on the GPU: the scene is built on the CPU exactly as for the CPU tracer
 * (buildRaycastScene, the same grid and BVHs), uploaded once, and every frame one compute
 * shader invocation per cell traces it (raytrace.wgsl.ts). The result is read back into the
 * same TracedFrame the CPU tracers produce, so drawing, outlines and the lens are shared.
 *
 * Given a canvas, it can skip the readback instead and draw the output buffer onto the canvas
 * itself; onFrame then gets a frame with only its size and timing (`presented`):
 * - 'pixels' mode always does, one cell per pixel (present.wgsl.ts).
 * - 'glyphs' mode does as characters (glyphs.wgsl.ts) whenever setGlyphs gave it what it
 *   needs, and reads the frame back otherwise, e.g. for the lens, which the CPU draws.
 */
import { getEnvironment } from '../../environments'
import type { Mesh, Primitive } from '../../environments/types'
import { NOON } from '../../environments/lighting'
import type { Bvh } from '../bvh'
import { linearToSrgbByte } from '../color'
import { cameraBasis } from '../math'
import type { RaycastPlayer, RaycastScene } from '../raycaster'
import { createPlayerSlot, createSceneSlot, pickScene, poseScene, type TracedFrame, type Tracer, type TracerEvents } from '../tracers'
import { GLYPH_FLAGS, GLYPH_WORKGROUP, GLYPHS_WGSL } from './glyphs.wgsl'
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

/** How 'glyphs' mode draws characters: the grid and atlas of glyphRenderer.ts, and the style. */
export interface GpuGlyphs {
  /** Cell size in canvas pixels, and the full grid (a coarse frame traces fewer cells). */
  cellW: number
  cellH: number
  cols: number
  rows: number
  /** Glyph coverage, one byte per pixel: the glyphs side by side, `cellW` apart. */
  atlas: Uint8Array
  atlasWidth: number
  color: boolean
  cellBackground: boolean
  outlines: boolean
  fogNear: number
  fogFar: number
  /** How strongly glyphs stand out from their cell's background, 0..1. */
  shade: number
  /** Sky color, 0..255. */
  sky: readonly number[]
}

export type GpuTracer = Tracer & {
  /** 'glyphs' mode: draw the next frames on the GPU like this, or read them back with null. */
  setGlyphs: (glyphs: GpuGlyphs | null) => void
}

export function createGpuTracer({ onScene, onFrame }: TracerEvents, canvas?: HTMLCanvasElement, mode: 'pixels' | 'glyphs' = 'pixels'): GpuTracer {
  let device: GPUDevice | null | undefined
  let pipeline: GPUComputePipeline | undefined
  /** With a canvas: what draws the output buffer onto it. */
  let present: { context: GPUCanvasContext, pipeline: GPURenderPipeline, params: GPUBuffer, bindGroup?: GPUBindGroup } | undefined
  /** 'glyphs' mode: what styles and draws the cells, with its own buffers. */
  let glyphPass: {
    context: GPUCanvasContext
    style: GPUComputePipeline
    draw: GPURenderPipeline
    params: GPUBuffer
    styled?: GPUBuffer
    atlas?: GPUTexture
    /** The atlas array uploaded to `atlas`, to notice a new one. */
    atlasSource?: Uint8Array
    styleBindGroup?: GPUBindGroup
    drawBindGroup?: GPUBindGroup
    /** Whether the canvas shows a frame, which must go when frames are read back instead. */
    shown: boolean
  } | undefined
  let glyphs: GpuGlyphs | null = null
  let disposed = false
  let busy = false

  const slot = createSceneSlot()
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
    if (canvas && mode === 'glyphs') {
      const format = navigator.gpu.getPreferredCanvasFormat()
      const context = canvas.getContext('webgpu')!
      // Not opaque: cleared to transparent, it shows the CPU-drawn canvas underneath.
      context.configure({ device: d, format, alphaMode: 'premultiplied' })
      const module = d.createShaderModule({ code: GLYPHS_WGSL })
      glyphPass = {
        context,
        style: d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'style' } }),
        draw: d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        }),
        params: d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        shown: false,
      }
    }
    else if (canvas) {
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
    const summary = slot.set(envId, seed, size)
    const scene = slot.scene!

    buffers ??= {} as NonNullable<typeof buffers>
    if (!buffers.params) buffers.params = device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    uploadPrimitives(scene)
    uploadMeshes(scene)
    if (!buffers.playerF) {
      replace('playerF', storage(new Float32Array(4)))
      replace('playerU', storage(new Uint32Array(4)))
    }
    onScene(summary)
  }

  function setBoxes(boxes: Primitive[]) {
    const summary = slot.setBoxes(boxes)
    if (!summary || !buffers) return
    uploadPrimitives(slot.scene!)
    onScene(summary)
  }

  function setShapes(meshes: Mesh[]) {
    const summary = slot.setShapes(meshes)
    if (!summary || !buffers) return
    uploadMeshes(slot.scene!)
    onScene(summary)
  }

  /** Uploads the merged mesh's BVH. */
  function uploadMeshes(scene: RaycastScene) {
    mesh = scene.mesh && packBvh(scene.mesh)
    replace('meshF', storage(mesh?.floats ?? new Float32Array(4)))
    replace('meshU', storage(mesh?.uints ?? new Uint32Array(4)))
  }

  /** Uploads the primitives and the grid that finds them. */
  function uploadPrimitives(scene: RaycastScene) {
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
    replace('prims', storage(prims))
    replace('grid', storage(grid))
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
    const s = slot.scene!
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
    if (glyphPass) {
      glyphPass.styled?.destroy()
      glyphPass.styled = device!.createBuffer({ size: Math.max(16, count * 8), usage: GPUBufferUsage.STORAGE })
      glyphPass.styleBindGroup = glyphPass.drawBindGroup = undefined
    }
  }

  async function render(camera: Parameters<Tracer['render']>[0], cols: number, rows: number, time: number, pose?: Parameters<Tracer['render']>[4], timeOfDay = NOON, occlusion = false) {
    const { scene, generated, envId } = slot
    if (busy || !device || !pipeline || !scene || !generated || !buffers) return
    busy = true
    const start = performance.now()
    const env = getEnvironment(envId)

    // Light, animate and place everything on the CPU, as the CPU tracers do; then upload
    // only what moved.
    poseScene(envId, generated, scene, time, timeOfDay)
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
    if (glyphPass && glyphs) {
      drawGlyphs(encoder, glyphPass, glyphs, cols, rows)
      device.queue.submit([encoder.finish()])
      const submitted = performance.now()
      await device.queue.onSubmittedWorkDone()
      if (disposed) return
      busy = false
      const none = { ink: new Uint8Array(0), rgb: new Uint8Array(0), depths: new Float32Array(0), normals: new Int8Array(0) }
      const end = performance.now()
      onFrame({ cols, rows, ...none, traceMs: end - start, stages: { prep: submitted - start, gpu: end - submitted }, presented: true })
      return
    }
    if (glyphPass?.shown) {
      // Frames are read back and drawn by the CPU underneath now: clear the GPU's last one.
      encoder.beginRenderPass({
        colorAttachments: [{ view: glyphPass.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      }).end()
      glyphPass.shown = false
    }
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
    const submitted = performance.now()

    await device.queue.onSubmittedWorkDone()
    const traced = performance.now()
    await readback.mapAsync(GPUMapMode.READ, 0, bytes)
    if (disposed) return
    const words = new Uint32Array(readback.getMappedRange(0, bytes).slice(0))
    readback.unmap()
    const mapped = performance.now()

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
    const end = performance.now()
    frame.traceMs = end - start
    frame.stages = { prep: submitted - start, gpu: traced - submitted, map: mapped - traced, unpack: end - mapped }
    busy = false
    onFrame(frame)
  }

  /** Styles the traced cells, then draws them as characters onto the canvas. */
  function drawGlyphs(encoder: GPUCommandEncoder, p: NonNullable<typeof glyphPass>, g: GpuGlyphs, cols: number, rows: number) {
    const d = device!
    if (g.atlas !== p.atlasSource) {
      p.atlas?.destroy()
      const height = g.atlas.length / g.atlasWidth
      p.atlas = d.createTexture({ size: [g.atlasWidth, height], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      d.queue.writeTexture({ texture: p.atlas }, g.atlas as Uint8Array<ArrayBuffer>, { bytesPerRow: g.atlasWidth }, [g.atlasWidth, height])
      p.atlasSource = g.atlas
      p.drawBindGroup = undefined
    }
    const flags = (g.color ? GLYPH_FLAGS.color : 0) | (g.cellBackground ? GLYPH_FLAGS.cellBackground : 0) | (g.outlines ? GLYPH_FLAGS.outlines : 0)
    const data = new ArrayBuffer(64)
    new Uint32Array(data, 0, 8).set([cols, rows, flags, 0, g.cellW, g.cellH, g.cols, g.rows])
    new Float32Array(data, 32, 8).set([g.fogNear, g.fogFar, g.shade, 0, g.sky[0]!, g.sky[1]!, g.sky[2]!, 0])
    d.queue.writeBuffer(p.params, 0, data)

    p.styleBindGroup ??= d.createBindGroup({
      layout: p.style.getBindGroupLayout(0),
      entries: [p.params, output!.buffer, p.styled!].map((buffer, binding) => ({ binding, resource: { buffer } })),
    })
    p.drawBindGroup ??= d.createBindGroup({
      layout: p.draw.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: p.params } },
        { binding: 3, resource: { buffer: p.styled! } },
        { binding: 4, resource: p.atlas!.createView() },
      ],
    })
    const compute = encoder.beginComputePass()
    compute.setPipeline(p.style)
    compute.setBindGroup(0, p.styleBindGroup)
    compute.dispatchWorkgroups(Math.ceil(cols / GLYPH_WORKGROUP), Math.ceil(rows / GLYPH_WORKGROUP))
    compute.end()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: p.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    })
    pass.setPipeline(p.draw)
    pass.setBindGroup(0, p.drawBindGroup)
    pass.draw(3)
    pass.end()
    p.shown = true
  }

  function drawToCanvas(encoder: GPUCommandEncoder, p: NonNullable<typeof present>, cols: number, rows: number) {
    const sky = slot.scene!.light.sky.map(c => linearToSrgbByte(c) / 255)
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
    setBoxes,
    setShapes,
    setPlayer: player.set,
    async pick(camera, u, v) {
      const { scene, generated } = slot
      return scene && generated ? pickScene(slot.envId, generated, scene, player.name, camera, u, v) : null
    },
    setGlyphs(next) {
      glyphs = next
    },
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
      glyphPass?.params.destroy()
      glyphPass?.styled?.destroy()
      glyphPass?.atlas?.destroy()
      glyphPass?.context.unconfigure()
      output?.buffer.destroy()
      output?.readback?.destroy()
    },
  }
}
