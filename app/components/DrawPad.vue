<script setup lang="ts">
// The pad shapes are drawn on in the panel. Spin: drag to draw half an outline, mirrored
// across the axis as it will look spun. Extrude: click or drag to paint grid cells; starting
// on a filled cell erases instead.
import { GRID } from '~/lib/shapes'

const props = defineProps<{
  tool: 'spin' | 'extrude'
}>()
const profile = defineModel<[number, number][]>('profile', { required: true })
const cells = defineModel<number[]>('cells', { required: true })

/** Profile points closer than this (a share of the pad) are left out while drawing. */
const MIN_STEP = 0.015

const canvas = ref<HTMLCanvasElement>()
/** The profile being drawn, shown while dragging and saved on release. */
let draft: [number, number][] | undefined
/** While painting cells: whether the drag fills them or clears them. */
let paint: boolean | undefined

/** The pointer in the pad, 0..1 from the top left. */
function at(e: PointerEvent): [number, number] {
  const rect = canvas.value!.getBoundingClientRect()
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return [clamp((e.clientX - rect.left) / rect.width), clamp((e.clientY - rect.top) / rect.height)]
}

/** A point of the pad as [r, h] of the profile: drawn on either side of the axis. */
const toProfile = ([u, v]: [number, number]): [number, number] => [Math.min(0.5, Math.abs(u - 0.5)), 1 - v]

function cellAt([u, v]: [number, number]) {
  const c = Math.min(GRID - 1, Math.floor(u * GRID))
  const r = Math.min(GRID - 1, Math.floor(v * GRID))
  return r * GRID + c
}

function paintCell(cell: number) {
  const filled = cells.value.includes(cell)
  if (paint && !filled) cells.value = [...cells.value, cell]
  else if (!paint && filled) cells.value = cells.value.filter(i => i !== cell)
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  canvas.value!.setPointerCapture(e.pointerId)
  const p = at(e)
  if (props.tool === 'spin') draft = [toProfile(p)]
  else {
    const cell = cellAt(p)
    paint = !cells.value.includes(cell)
    paintCell(cell)
  }
  draw()
}

function onPointerMove(e: PointerEvent) {
  const p = at(e)
  if (draft) {
    const next = toProfile(p)
    const last = draft.at(-1)!
    if (Math.hypot(next[0] - last[0], next[1] - last[1]) < MIN_STEP) return
    draft.push(next)
    draw()
  }
  else if (paint !== undefined) paintCell(cellAt(p))
}

function onPointerUp() {
  // A click without a drag draws nothing worth keeping.
  if (draft && draft.length >= 2) profile.value = draft.map(([r, h]) => [+r.toFixed(3), +h.toFixed(3)])
  draft = undefined
  paint = undefined
  draw()
}

function draw() {
  const el = canvas.value
  if (!el) return
  const dpr = window.devicePixelRatio || 1
  const size = el.clientWidth
  if (el.width !== Math.round(size * dpr)) el.width = el.height = Math.round(size * dpr)
  const ctx = el.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)

  // Grid lines: the extrude grid's cells, or a coarser guide for spinning.
  const lines = props.tool === 'extrude' ? GRID : 8
  ctx.strokeStyle = 'rgb(0 0 0 / 0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 1; i < lines; i++) {
    const p = Math.round((i * size) / lines) + 0.5
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
  }
  ctx.stroke()

  if (props.tool === 'extrude') {
    const cell = size / GRID
    ctx.fillStyle = '#2b5d8a'
    for (const i of cells.value) ctx.fillRect((i % GRID) * cell + 0.5, Math.floor(i / GRID) * cell + 0.5, cell - 1, cell - 1)
    return
  }

  // The axis, then the outline on both sides of it, filled in as the solid it spins into.
  ctx.strokeStyle = 'rgb(0 0 0 / 0.35)'
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(size / 2, 0)
  ctx.lineTo(size / 2, size)
  ctx.stroke()
  ctx.setLineDash([])
  const points = draft ?? profile.value
  if (points.length < 2) return
  const x = (r: number, side: number) => size / 2 + side * r * size
  const y = (h: number) => (1 - h) * size
  ctx.beginPath()
  points.forEach(([r, h], i) => (i ? ctx.lineTo(x(r, 1), y(h)) : ctx.moveTo(x(r, 1), y(h))))
  for (const [r, h] of [...points].reverse()) ctx.lineTo(x(r, -1), y(h))
  ctx.closePath()
  ctx.fillStyle = 'rgb(43 93 138 / 0.25)'
  ctx.fill()
  ctx.strokeStyle = '#2b5d8a'
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.beginPath()
  points.forEach(([r, h], i) => (i ? ctx.lineTo(x(r, 1), y(h)) : ctx.moveTo(x(r, 1), y(h))))
  ctx.stroke()
}

onMounted(draw)
watch(() => [props.tool, profile.value, cells.value], draw)
</script>

<template>
  <canvas
    ref="canvas"
    class="pad"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  />
</template>

<style scoped>
.pad {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  background: white;
  border-radius: 6px;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.15);
  cursor: crosshair;
  touch-action: none;
}
</style>
