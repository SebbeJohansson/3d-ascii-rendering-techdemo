/**
 * ASCII the way most ASCII effects do it: render the 3D view as usual, then a full-screen
 * shader cuts the image into character cells. Each cell takes the scene's color at its center
 * and picks a character by how dark that color is, drawn from a texture of pre-rendered
 * characters. Everything runs on the GPU and nothing is ray traced; compare the ray tracers,
 * which pick characters from how much light reaches a surface and outline edges.
 */
import * as THREE from 'three/webgpu'
import { float, floor, fract, luminance, mix, pass, screenCoordinate, screenSize, select, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { MONO, RAMP } from '../cellStyle'

/** Atlas resolution per character, in texels. */
const ATLAS_CELL = { width: 24, height: 40 }
/** Even fully lit cells get a light character, like the ray tracers' MIN_INK. */
const MIN_INK = 0.25

/** The ramp's characters side by side, white on transparent, for the shader to sample. */
function createGlyphAtlas() {
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_CELL.width * RAMP.length
  canvas.height = ATLAS_CELL.height
  const ctx = canvas.getContext('2d')!
  ctx.font = `${ATLAS_CELL.height * 0.8}px ui-monospace, Menlo, Consolas, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  for (let g = 1; g < RAMP.length; g++) ctx.fillText(RAMP[g]!, (g + 0.5) * ATLAS_CELL.width, ATLAS_CELL.height / 2)
  const atlas = new THREE.CanvasTexture(canvas)
  atlas.colorSpace = THREE.NoColorSpace
  atlas.generateMipmaps = false
  atlas.minFilter = THREE.LinearFilter
  return atlas
}

export function createShaderAscii(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const atlas = createGlyphAtlas()
  /** Cell size in device pixels. */
  const cellSize = uniform(new THREE.Vector2(7, 14))
  /** Linear rgb, like the scene image. */
  const skyColor = uniform(new THREE.Vector3())
  const scratch = new THREE.Color()
  const backgrounds = uniform(1)
  const colored = uniform(1)

  const scenePass = pass(scene, camera)
  const image = scenePass.getTextureNode('output')
  const depth = scenePass.getTextureNode('depth')

  // Which cell this pixel is in, where in the cell it is, and the cell's center as a uv.
  const cellPos = screenCoordinate.xy.div(cellSize)
  const cell = floor(cellPos)
  const inCell = fract(cellPos)
  const centerUv = cell.add(0.5).mul(cellSize).div(screenSize)

  const surface = image.sample(centerUv).rgb
  const sky = depth.sample(centerUv).r.greaterThanEqual(1)
  // Darker cells get denser characters. Luminance of sRGB-ish values reads closer to how dark
  // a color looks than of linear ones.
  const look = luminance(surface.pow(1 / 2.2))
  const ink = float(MIN_INK).add(float(1 - MIN_INK).mul(look.oneMinus()))
  const glyph = floor(ink.mul(RAMP.length - 1)).clamp(1, RAMP.length - 1)
  const coverage = texture(atlas, vec2(glyph.add(inCell.x).div(RAMP.length), inCell.y.oneMinus())).a

  // Colors like the ray tracers' cell backgrounds: the surface fills the cell and the
  // character is a shade of it, darker on light surfaces and lighter on dark ones.
  const light = luminance(surface.pow(1 / 2.2)).greaterThan(100 / 255)
  const shade = select(light, surface.mul(0.6), surface.add(surface.oneMinus().mul(0.35)))
  const [mr, mg, mb] = MONO.map(c => (c / 255) ** 2.2) as [number, number, number]
  const mono = vec3(mr, mg, mb)
  const skyRgb = skyColor
  const background = select(backgrounds.greaterThan(0.5), surface, skyRgb)
  const foreground = select(colored.greaterThan(0.5), select(backgrounds.greaterThan(0.5), shade, surface), mono)
  const ascii = mix(background, foreground, coverage)

  const pipeline = new THREE.RenderPipeline(renderer)
  pipeline.outputNode = vec4(select(sky, skyRgb, ascii), 1)

  return {
    pipeline,
    /** Cell size in CSS pixels; the shader works in device pixels. */
    setCellSize(width: number, height: number) {
      const dpr = renderer.getPixelRatio()
      cellSize.value.set(width * dpr, height * dpr)
    },
    setStyle({ sky, color, cellBackground }: { sky: number, color: boolean, cellBackground: boolean }) {
      // THREE.Color converts the sRGB hex to linear.
      scratch.setHex(sky)
      skyColor.value.set(scratch.r, scratch.g, scratch.b)
      colored.value = color ? 1 : 0
      backgrounds.value = color && cellBackground ? 1 : 0
    },
    dispose() {
      atlas.dispose()
      pipeline.dispose()
    },
  }
}
