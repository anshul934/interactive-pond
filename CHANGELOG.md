# SERENE WEBGL KOI POND

## Changelog

All significant features, fixes, and structural changes, in order. Each entry
is an update.

---

## Update 1 — Modular Pond Application

* Split the original standalone pond page into ES modules for the app entry
  point, pond simulation, pointer/touch input, camera input, shared input
  management, and frog NPC behavior.
* Added a shared input interface so the simulation can respond to input without
  depending on whether it came from a pointer or a camera.
* Kept the HTML page as the application shell for the canvases, controls, and
  module entry point.
* Added a README covering the module layout and local run requirements.

## Update 2 — Camera Input and Module Loading

* Added a camera control and MediaPipe Hand Landmarker input, with index-finger
  movement and pinch actions.
* Load the local camera adapter through the static module graph instead of
  fetching it dynamically when the camera button is clicked. This avoids a
  button-time request for the local `CameraInput.js` module.
* Added camera lifecycle and error handling, GPU-to-CPU delegate fallback,
  alternate MediaPipe JavaScript/WASM sources, and lazy loading of the tracking
  runtime when camera input is enabled.
* Documented that camera access requires `localhost` or HTTPS, camera
  permission, and access to the tracking assets.

## Update 3 — Camera Smoothing and Stationary Visitors

* Added filtered hand positions and rejection of brief tracking jumps.
* Added a per-hand movement deadband so small camera jitter does not continually
  reset stationary-hand behavior.
* Retained hand positions while tracking briefly drops, and added stable hand
  IDs, pinch hysteresis, and gesture stabilization.

## Update 4 — Frog NPCs

* Added non-interactive frogs that enter the pond, swim to lily pads, hop onto
  and perch on them, return to the water, and swim out.
* Added simple frog animation, corrected frog facing/orientation, and refined
  the swimming motion so both hind legs pump together.
* Added small ripples where frogs enter and leave the water.

## Update 5 — Foreground Pond Elements and Interface Cleanup

* Added a transparent foreground canvas above the water shader for lily pads
  and frogs, preventing water refraction from appearing over the pads.
* Removed the top-left title/branding panel and bottom koi status badge.
* Preserved frog and lily rendering independently of the underwater canvas.

## Update 6 — Water, Ripple, and Palette Tuning

* Reduced the default water current drift and touch-wave force and synchronized
  their initial values with the controls.
* Made interactive ripples gentler, narrower, shorter-lived, and slower to
  expand.
* Reduced underwater caustic brightness and size and adjusted water reflection
  blending to retain more color depth.
* Tuned the daylight water and pebble colors toward a subtly richer teal, and
  adjusted the lily pad greens to remain muted but readable.

## Update 7 — Lily Pad Placement

* Added bounded retry placement for lily pads, with a minimum spacing check
  based on both pads' radii.
* Skip a pad if no non-overlapping position can be found after the retry
  limit, rather than placing it on top of another pad.

## Update 8 — Koi Food Priority and Visitor Behavior

* Added stationary visitor-hand approaches and nibbling, assigning each nearby
  koi to the closest eligible visitor.
* Made uneaten food take priority: koi do not leave available food to approach
  a visitor, and visitor attraction is enabled after all food pellets are
  eaten.
* Removed the per-visitor fish limit; every koi within the approach radius can
  be assigned to an idle visitor, with each fish assigned to at most one
  visitor at a time.

## Update 9 — Multi-Hand Camera Interaction

* Set MediaPipe to track at most four hands and preserve each tracked hand as a
  separate visitor target.
* Carry per-hand position, movement, stationary detection, and pinch actions
  through the input manager rather than collapsing camera input to one primary
  cursor.
* Process pond movement effects and pinch actions independently for every
  active hand.
* Display the current number of detected hands in the camera status.
* Lowered hand-detection confidence and relaxed duplicate-detection filtering
  to reduce missed hands and avoid merging nearby detections.

## Update 10 — Frame-Rate-Independent Fish Movement

* Scale koi movement, turning, swim animation, and behavior timers by elapsed
  time so slower animation frames do not make fish appear to swim in slow
  motion.
* Throttle hand-tracking inference to approximately 30 frames per second to
  reduce its impact on pond rendering.

## Update 11 — Local Node Server

* Added `serve.mjs`, a dependency-free Node.js static server for running the
  module-based app from `localhost`.
* Serve JavaScript modules and WebAssembly assets with appropriate MIME types,
  and return explicit not-found responses for missing files.
* Documented the PowerShell startup command, browser URL, port override, and
  how to stop the server. The server prints the app URL but does not open a
  browser automatically.

## Update 12 — Stable Decorations on Resize

* Preserve the existing lily pads and pebble layout when the browser viewport
  is resized, scaling their positions to fit the new dimensions instead of
  generating a new random arrangement.
* Recolor the existing pebbles when the atmosphere theme changes without
  changing their positions or individual color assignments.

---

## Current Status

* Active app: modular Three.js koi pond with Canvas 2D underwater and
  foreground rendering.
* Input: pointer/touch or camera hand tracking, with up to four independently
  processed camera hands.
* Koi: eat available food before approaching nearby stationary hands; all
  nearby koi may approach after food is gone.
* Ambient NPCs: frogs swim, perch on lilies, and return to the water with small
  splash ripples.
* Local run: `node .\serve.mjs`, then open the printed local pond URL.
