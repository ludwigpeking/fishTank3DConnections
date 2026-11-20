# VOLUME / PATHS — an evolving, truly volumetric 3D pathfinder

A standalone, dependency-free HTML/JS/WebGL2 research prototype. It is **not** a 2D grid with elevation: the graph has `N³` nodes, and each node can traverse in X, Y and Z.

## Start

From this folder:

```bash
python -m http.server 8000
```

Open **http://localhost:8000** in Chrome or Edge. There is no install or build step. The visualization works offline. Browsers without WebGL2 use a slower Canvas 2D projection fallback. Webcam-based facial tracking fetches the MediaPipe JavaScript runtime, WASM, and Face Landmarker model from Google's CDN, so that feature requires internet access and permission for the webcam; it is opt-in. The video is processed locally in the browser and is not uploaded by the app. Webcam and WebGPU require HTTPS or localhost.

## Data structure

- `N × N × N` true volumetric lattice of nodes; index `i=x+N*(y+N*z)`. Z is height.
- `Float32Array(N³)` for spatially continuous 3D fBm-derived resistance and another `Float32Array(N³)` for evolving traffic memory; `Uint8Array(N³)` for impenetrable material.
- **Implicit edges**: generated on demand, never stored. 6 orthogonal, +20 diagonal, +24 3D knight moves (permutations of `(±2,±1,0)`) = 50 candidate transitions per interior node. Swept-voxel sampling rejects diagonal/knight transitions that cut through impassable nodes.
- Weighted A* is fast but not guaranteed globally optimal; the alternate **admissible A*** has a conservative lower-bound heuristic and targets optimal paths for the current graph. Negative edge costs are not permitted.
- Edge cost: Euclidean 3D displacement × Simpson-integrated trilinearly sampled 3D resistance × altitude-change factor × learned-traffic discount. The vertical penalty differentiates upward and downward movement. Every completed journey reinforces its visited nodes and their six nearest neighbors.
- Decay and six-neighbor diffusion periodically update the traffic-memory field on either **WebGPU compute shaders** or on the CPU if unavailable. The routing frontier itself still runs on the CPU; GPU parallel shortest path is intentionally *not* claimed.
- Three-dimensional routes are drawn with cubic Catmull–Rom splines, but the underlying routing remains on discrete valid graph edges. A displayed spline is aesthetic; it is not revalidated for obstacle clearance.

## Controls

- The volume fills the browser window with no boundary box, cross-section plane, or visible mover markers. Invisible movers deposit turquoise and amber traces that spread gently and fade into a cloud. Violet particle density and opacity represent effective terrain resistance; reinforced routes soften the density as resistance falls.
- Numbers, diagnostics, and the color legend are hidden until you click **Data**. Clear memory is inside that panel. There is no settings section.
- **Enable webcam** is a primary control on the opening screen and requests full screen when clicked. Once connected, the entire interface disappears, including the video preview, leaving only the spatial graphics. Press **Escape** to leave full screen and restore controls, or tap/click the scene to reveal or hide them. Dragging continues to orbit without opening the interface. Disconnecting the webcam restores controls. If the browser declines full screen, webcam control still works in the window.
- Lean closer to translate the camera into the volume; lean back to move away. World scale and perspective remain fixed. **Head translation** adds lateral movement; **Head-driven orbit** changes viewing angles. Center view or `C` recalibrates the neutral head pose. Facial measurements are approximate, not calibrated six-degree-of-freedom eye tracking.
- The playback dock contains Pause/Resume, Step, Reset view, and Full screen. Step pauses playback, generates one journey, and advances its traces by a short interval. Full screen is requested only when clicking Enable webcam or the Full screen button.
- Drag = orbit camera; mouse wheel = move closer/farther; shift/right-drag = pan. Space = run/pause; `N` = new random volume.
- The default simulation uses a 40³ grid, 50-move connectivity including 3D knight moves, and evolving traffic memory. Simulation parameters remain in `main.js`; shared camera and cloud behavior are in `scene.js`. WebGL and Canvas use the same spatial geometry.

## Reliability and verification

WebGPU uses validated WGSL and an asynchronous compute pipeline. Initialization failures, device loss, or readback errors fall back to CPU diffusion. Regenerating a field retires its buffers/device immediately; old results cannot replace the new field. Clearing memory invalidates pending readback results.

MediaPipe JavaScript and WASM are pinned together to `0.10.21` (the former `0.10.22` URL returned 404). Camera setup, playback, model loading, disconnects, and repeated detection errors all release acquired resources. Inference runs only on new decoded frames, at roughly 10 Hz. Temporarily losing the face holds the last camera offset to avoid a sudden jump; manual orbit remains available. Some MediaPipe builds print informational TensorFlow messages at console error level even when inference succeeds.

Run the camera lifecycle and 3D graph checks with:

```bash
node --test qa/lifecycle.test.cjs qa/scene.test.cjs
```

With the local server running, open `qa/browser-checks.html` to compare real WebGPU results with CPU diffusion at 24³, 40³, and 64³ and test device loss. Its separate MediaPipe check loads the actual model and runs inference on a blank canvas without requesting a camera. `qa/responsive.html` previews the app inside a 390 × 844 frame.

`Volume_Pathways_3D.html` is the portable, single-file copy. After editing the source modules, regenerate it with:

```bash
node build-standalone.cjs
```

Serve either entry point from localhost for reliable camera and WebGPU access. The live webcam/head-pose experience still needs a connected camera and browser permission.

## Limitations and next steps

WebGL2 is used for hardware-accelerated rendering. WebGPU is optional and currently accelerates only field-memory diffusion, not random-destination A*. At high resolutions, exact A* and 50-neighbor edge traversal can become expensive. Spline geometry can visually cross blocked material because it smooths a valid discrete path rather than routing in continuous space. A higher-fidelity version could add visibility-constrained spline smoothing, hierarchical pathfinding (HPA*), multi-resolution adaptive 3D structures, obstacle-aware 3D DDA line segment tests, parallel batched multi-source routing, and true screen-size calibration for head-coupled projection.
