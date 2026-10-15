# Tech demo ideas

Ideas for what to add next, best first within each group. Time estimates are rough.

## ASCII rendering

- [x] **Ambient occlusion.** A few extra short rays per cell darken corners and creases, so the dragon and the street canyons get depth. Costs speed, so make it a toggle. ~1 h
- [x] **Lower resolution while dragging.** Trace at a coarser grid while the camera moves and sharpen when it stops, so 3 px characters stay smooth on any machine. ~30 min

## World and lighting

- [x] **Day/night cycle.** Move the sun so shadows sweep across the city; at night, building windows light up. Uses the `animate` hook. ~2 h
- [ ] **Mountains / terrain.** Noise-based heightmap terrain. Needs a heightmap shape in both renderers. ~2–3 h
- [ ] **Ocean with islands.** Terrain islands in a reflective sea. Reflections are cheap in the ray tracer, harder in the 3D view. ~3 h
- [ ] **Dragon flying over the city.** Combine two environments and animate the dragon along a flight path. ~1–2 h

## Interaction and tech comparisons

- [x] **GPU ray tracing.** Port the ray tracer to a WebGPU compute shader, with a CPU/GPU toggle and fps side by side. ~half a day
- [ ] **Fly mode.** WASD + mouse first-person camera in both views. ~1 h
- [ ] **Click to inspect.** Click a building or tree to see what it is; the ray tracer already knows what each cell hit. ~45 min
- [ ] **Export ASCII.** Copy the current frame as plain text, or record a GIF. ~30–45 min
- [ ] **`ssh` into the city.** A small SSH server that streams the terminal version (`yarn ascii`) to anyone who connects, so `ssh localhost -p 2222` drops you into the city with nothing installed. Rendering stays on the server. ~3 h
