# 3D model rendering tech demo

Procedurally generated scenes drawn two ways: as a normal 3D view with three.js, and as ASCII art from a small CPU ray tracer written from scratch.

Live demo: https://sebbejohansson.github.io/3dmodel-rendering-techdemo/

<img width="1440" height="832" alt="image" src="https://github.com/user-attachments/assets/f7841753-19cd-43dd-b70a-70cccdc4394d" />

## What's in it

There are five environments. Each one is generated from a seed, so the same seed always gives the same world.

- City: a street grid where buildings get taller toward the center.
- Forest: trees built from cylinders, cones and spheres.
- Ocean: islands made from a noise heightmap, with beaches, palms and bushes, in a calm sea that mirrors them.
- Mountains: ranges made from ridged noise around a green valley, with pine forest on the lower slopes, rock on the cliffs and snow on the peaks.
- Dragon: a model made by blending simple signed distance shapes, then meshed into about 50k triangles. Its wings flap.

You can look at each environment three ways:

- `/city` is a regular 3D view using three.js and its WebGPU renderer (it falls back to WebGL2).
- `/city/ascii` is the ray-traced ASCII view. Every character cell shoots one ray into the scene, the lighting decides which character it gets, and edges are drawn with `| / \ - _` so silhouettes look like line art.
- `/city/split` shows both next to each other with the cameras synced.
- `/city/lens` shows the 3D view with the ASCII view on top, but only inside a lens: a circle around the mouse, a bubble around what the camera looks at (it follows the dragon or car when riding), or behind a line sweeping across the view. Both views use the same camera, so the characters sit exactly over what they show.

Swap `city` for `forest`, `ocean`, `mountains` or `dragon` to change scene.

### Day and night

The **Time** slider in the panel moves the sun across the sky, and **Day and night cycle** runs a full day every two minutes. The sun gets lower and warmer towards the evening, the sky goes orange and then dark blue, and at night a dim moon takes over the shadows while windows in the city light up. The 3D view and the ray tracer compute the same lighting and the same lit windows (see `app/environments/lighting.ts` and `app/lib/windows.ts`).

### The sea

In the ocean the ground is a sea that reaches the horizon and mirrors the islands and the sky. The ray tracer sends a second ray up from the water where a cell's ray hits it; the 3D view renders the scene again from below the water with three's `reflector()`. Both blend the mirror image in the same way: a little looking straight down, almost all of it at grazing angles. Players stand on the islands' land.

### Click to inspect

Click anything to see what it is and how far away: a building and its floors, a pine and its height, the sea, the dragon. It works in every view, the terminal included, where the name shows in the top bar. The ray tracer casts one ray through the click; the 3D view builds the ray tracer's copy of the scene on the first click to do the same.

### Dropping boxes

The panel's `Boxes` mode orbits like `Orbit`, but a click drops a box of random size and color instead of naming what is there: onto the roof or box you clicked, under a ceiling, or against the wall you clicked with its middle at the click's height. With **Gravity** on, boxes fall at 9.81 m/s² onto what is below them, so they stack into towers; turn it off and they stay where they appear, in the air if need be, until it is turned on again. The boxes stay when you switch to the dragon or the car, which bump into them like anything else. **Clear boxes** removes them, and a new seed or size starts without any. They are only added on top of the generated scene: the ray tracer rebuilds its grid of primitives and the 3D view moves one instanced mesh, without generating the environment again (see `app/lib/boxes.ts`). The terminal has it too, on `4`.

### Riding a dragon or a car

The panel's `Dragon` and `Car` buttons spawn one into the current environment, with a third-person camera behind it. `W` `S` set speed and `A` `D` turn; the dragon also climbs with `Space` and dives with `Shift`. Drag to look around it and scroll to zoom; once it moves and the mouse is left alone for 1.5 seconds, the camera eases back behind it. It bumps into buildings, trees and rocks, drives up onto curbs, and the dragon can land on roofs. The dragon starts in the air, above the tallest building or tree. `Orbit` removes it. It works in all three views, and in `/split` both halves follow the same player.

### In a terminal

The ASCII view also runs in a terminal, with the same ray tracer on Node worker threads. Without cloning, `npx 3d-ascii` runs it (Node 20 or newer). From the repo:

```bash
yarn ascii              # the city
yarn ascii forest --seed 42
yarn ascii --help       # every option
```

`1` orbits, `2` rides the dragon and `3` the car. `4` is the boxes mode: a click drops a box, `G` turns gravity on and off and `X` clears them. WASD or the arrows move (or look around while orbiting), the mouse drags and zooms like in the browser and a click names what is under it, `Tab` switches to the next environment, `R` switches between characters and blocks, `T` starts or stops the day and night cycle, `,` and `.` move the time an hour, `N` makes a new world and `Esc` quits. Blocks (`--blocks`) split every cell into two colored pixels with `▀`, for twice the detail but no characters. For more cells in either mode, make the terminal's font smaller. It needs a terminal with 24-bit color for the best look (it falls back to 256 colors).

To publish a new version to npm, follow the versioning and release steps in `AGENTS.md`. The build bundles `cli/` and the code it uses from `app/` into two files with no dependencies.

Terminals that support the kitty keyboard protocol (kitty, WezTerm, Ghostty, foot, Alacritty) report when a key is let go, so holding `W` drives smoothly. Elsewhere a key counts as held while its key repeats keep coming, which adds a short pause after the first press, like holding a key in a text editor. The status line says which one your terminal does. If input misbehaves, `--log-input FILE` records everything the terminal sends. `--benchmark` flies the browser benchmark's camera path for 12 seconds, then prints the fps and how each frame's time splits between tracing, building escape codes, writing to the terminal and waiting.

## How the ASCII renderer works

It runs on the CPU without a 3D engine. The code is in `app/lib/`:

- `raycaster.ts` intersects rays with boxes, cylinders, cones and ellipsoids. Primitives go into a grid on the ground plane, so a ray only tests the ones in cells it crosses.
- `bvh.ts` holds triangle meshes in a bounding volume hierarchy, so a ray against the dragon tests a few dozen boxes instead of 50k triangles.
- `sdf.ts` and `surfaceNets.ts` turn a blend of simple distance-field shapes into a triangle mesh.
- `tracers.ts` runs the tracer on the main thread or across a pool of Web Workers, each taking every Nth row.
- `outlines.ts` finds silhouettes, depth jumps and creases and picks a line character for each.
- `glyphRenderer.ts` writes pre-rendered glyph masks straight into an `ImageData` buffer. In testing this was about twice as fast as calling `fillText` per character.

The control panel shows fps and frame time, which helps when comparing settings. **Benchmark 3D vs ASCII renderers** flies the camera along the same 12-second path in the 3D view and then the ASCII view with each renderer below, one after the other, and shows average fps, ms per frame and the worst fps side by side.

### Three ways to make the ASCII view

The ASCII settings pick how the characters are made:

- **CPU**: the ray tracer above, in JavaScript, on the main thread or in Web Workers.
- **GPU**: the same ray tracer as a WebGPU compute shader (`app/lib/gpu/raytrace.wgsl.ts`), one invocation per character cell. The scene is built on the CPU exactly as for the CPU tracer and uploaded once; only what moves is uploaded per frame. The result is read back into the same per-cell data, so characters, outlines and the lens are drawn the same way. Its output matches the CPU tracer's to within 1 of 255 in color.
- **Shader**: the usual way ASCII effects are made. The 3D view is rendered as normal and a post-processing shader (`app/lib/gpu/shaderAscii.ts`) cuts the image into cells and picks each cell's character by how dark it is. Nothing is ray traced, so there are no outlines, and characters follow how dark a color looks rather than how much light reaches the surface.

## Running it locally

Needs Node 24 and Yarn 4. Run `corepack enable` once to get the Yarn version pinned in `package.json`.

```bash
yarn install
yarn dev
```

Then open http://localhost:3000.

Other scripts:

| Command          | What it does                                 |
| ---------------- | -------------------------------------------- |
| `yarn generate`  | Static build into `.output/public`           |
| `yarn preview`   | Serve the production build                   |
| `yarn typecheck` | Run `vue-tsc` over the project               |

## Deployment

Every push to `main` builds the site with `yarn generate` and publishes it to GitHub Pages (see `.github/workflows/deploy.yml`). The workflow sets `NUXT_APP_BASE_URL` to the repo name so assets load from the `/3dmodel-rendering-techdemo/` subpath.

## Ideas

See [TODO.md](TODO.md) for what might come next.
