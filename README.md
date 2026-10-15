# 3D model rendering tech demo

Procedurally generated scenes drawn two ways: as a normal 3D view with three.js, and as ASCII art from a small CPU ray tracer written from scratch.

Live demo: https://sebbejohansson.github.io/3dmodel-rendering-techdemo/

<img width="1440" height="832" alt="image" src="https://github.com/user-attachments/assets/f7841753-19cd-43dd-b70a-70cccdc4394d" />

## What's in it

There are three environments. Each one is generated from a seed, so the same seed always gives the same world.

- City: a street grid where buildings get taller toward the center.
- Forest: trees built from cylinders, cones and spheres.
- Dragon: a model made by blending simple signed distance shapes, then meshed into about 50k triangles. Its wings flap.

You can look at each environment three ways:

- `/city` is a regular 3D view using three.js and its WebGPU renderer (it falls back to WebGL2).
- `/city/ascii` is the ray-traced ASCII view. Every character cell shoots one ray into the scene, the lighting decides which character it gets, and edges are drawn with `| / \ - _` so silhouettes look like line art.
- `/city/split` shows both next to each other with the cameras synced.

Swap `city` for `forest` or `dragon` to change scene.

### Riding a dragon or a car

The panel's `Dragon` and `Car` buttons spawn one into the current environment, with a third-person camera behind it. `W` `S` set speed and `A` `D` turn; the dragon also climbs with `Space` and dives with `Shift`. Drag to look around it and scroll to zoom; once it moves and the mouse is left alone for 1.5 seconds, the camera eases back behind it. It bumps into buildings, trees and rocks, drives up onto curbs, and the dragon can land on roofs. The dragon starts in the air, above the tallest building or tree. `Orbit` removes it. It works in all three views, and in `/split` both halves follow the same player.

## How the ASCII renderer works

It runs on the CPU without a 3D engine. The code is in `app/lib/`:

- `raycaster.ts` intersects rays with boxes, cylinders, cones and ellipsoids. Primitives go into a grid on the ground plane, so a ray only tests the ones in cells it crosses.
- `bvh.ts` holds triangle meshes in a bounding volume hierarchy, so a ray against the dragon tests a few dozen boxes instead of 50k triangles.
- `sdf.ts` and `surfaceNets.ts` turn a blend of simple distance-field shapes into a triangle mesh.
- `tracers.ts` runs the tracer on the main thread or across a pool of Web Workers, each taking every Nth row.
- `outlines.ts` finds silhouettes, depth jumps and creases and picks a line character for each.
- `glyphRenderer.ts` writes pre-rendered glyph masks straight into an `ImageData` buffer. In testing this was about twice as fast as calling `fillText` per character.

The control panel shows fps and frame time, which helps when comparing settings.

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
