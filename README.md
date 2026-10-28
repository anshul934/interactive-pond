# Serene WebGL Koi Pond

The pond is split into a simulation module and interchangeable input providers.
The simulation consumes a single input state (`x`, `y`, `active`, `moved`, and
`action`) and does not need to know whether it came from a pointer or a camera.

## Run locally

Camera access requires a secure browser context. With Node.js installed, serve
this folder from `localhost` rather than opening the HTML file directly:

```powershell
node .\serve.mjs
```

Then open `http://localhost:8000/serene_webgl_koi_pond_simulation.html` and
allow camera access when prompted. Camera input uses MediaPipe hand tracking;
move an index finger to steer and pinch to trigger the selected pond action.
It tracks up to four hands as separate visitor targets; movement, pinch
actions, and stationary-hand interactions are processed independently for
each hand. Nearby koi approach stationary hands after all available food has
been eaten.
Pointer and touch input remain available without enabling the camera.
Keep the terminal open while using the simulation and press `Ctrl+C` to stop
the server. To use a different port, set `PORT` before starting it, for example
`$env:PORT = 8001; node .\serve.mjs`.

The local camera adapter is loaded with the app, before the camera button is
used. MediaPipe is loaded only when camera input is enabled, with CDN fallbacks
for its JavaScript and WASM runtime.

## Modules

- `src/main.js` composes the simulation and connects the camera control.
- `src/PondSimulation.js` contains pond rendering, fish behavior, and settings.
- `src/input/InputManager.js` exposes source-independent interaction state.
- `src/input/PointerInput.js` adapts pointer and touch events.
- `src/input/CameraInput.js` adapts the MediaPipe hand tracker.
- `src/simulation/FrogNpc.js` provides non-interactive frog pond visitors.
