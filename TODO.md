# Tech demo ideas

Ideas for what to add next, best first within each group. Time estimates are rough.

## ASCII rendering

- [x] **Ambient occlusion.** A few extra short rays per cell darken corners and creases, so the dragon and the street canyons get depth. Costs speed, so make it a toggle. ~1 h
- [x] **Lower resolution while dragging.** Trace at a coarser grid while the camera moves and sharpen when it stops, so 3 px characters stay smooth on any machine. ~30 min

## World and lighting

- [x] **Day/night cycle.** Move the sun so shadows sweep across the city; at night, building windows light up. Uses the `animate` hook. ~2 h
- [x] **Mountains / terrain.** Noise-based heightmap terrain. Needs a heightmap shape in both renderers. ~2–3 h
- [x] **Ocean with islands.** Terrain islands in a reflective sea. Reflections are cheap in the ray tracer, harder in the 3D view. ~3 h

## Interaction and tech comparisons

- [x] **GPU ray tracing.** Port the ray tracer to a WebGPU compute shader, with a CPU/GPU toggle and fps side by side. ~half a day
- [x] **Click to inspect.** Click a building or tree to see what it is; the ray tracer already knows what each cell hit. ~45 min

## Building and games

- [x] **Drop boxes.** A Build mode next to the car and dragon: click any surface to drop a box of random size and color there, using the hit from click to inspect. ~1–2 h
- [x] **Stack onto faces.** Click a box's face to stick a new box onto it, Minecraft-style, so you build in 3D directly. ~2 h
- [x] **Stacking tower game.** Boxes fall straight down without rotating and land on what's below; score is the tower's height. ~half a day
- [ ] **Car smashes boxes.** Boxes tumble when the car hits them. Needs a physics library (e.g. Rapier) and rotated boxes. ~1 day

## Drawing shapes

- [ ] **Spin a profile.** Draw half an outline and spin it into a vase, bottle or tower. ~half a day
- [ ] **Extrude an outline.** Draw a 2D shape on a grid and pull it up into a solid: walls, letters, logos. ~half a day
- [ ] **Sculpt with blobs.** Place spheres that melt together, reusing the dragon's SDF and surface nets code. ~1 day
