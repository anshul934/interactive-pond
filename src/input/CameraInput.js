// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

// One Euro filter (replaces the old lerp + dead zone). Coordinates are
// normalised 0..1. minCutoff = smoothing while the hand is still (lower = less
// jitter, more lag). beta = how quickly smoothing relaxes as the hand speeds up
// (higher = less lag while moving, more jitter).
const ONE_EURO_MIN_CUTOFF = 1.2;
const ONE_EURO_BETA = 20;
const ONE_EURO_D_CUTOFF = 1.0;

// Single-frame landmark teleports are rejected until they persist.
const MAX_PLAUSIBLE_SPEED = 8;     // norm-units/sec
const MIN_GLITCH_JUMP = 0.08;      // norm-units
const GLITCH_CONFIRM_FRAMES = 3;

// A lost hand is held in place this long before it disappears.
const TRACKING_GRACE_MS = 250;
const GESTURE_CONFIRMATION_MS = 140;
const HAND_CONFIDENCE_THRESHOLD = 0.6;
const MIN_INFERENCE_INTERVAL_MS = 1000 / 30;
const DIP_ENTER_SCALE = 1.3;
const DIP_EXIT_SCALE = 1.16;
const HAND_WARMUP_MS = 700; // new hands can't be "dipped" while the baseline settles

// Pinch thresholds are ratios of thumb-index distance to palm size, so they
// work at any distance from the camera.
const PINCH_RATIO = 0.30;
const RELEASE_RATIO = 0.50;
const PINCH_CONFIRM_MS = 45;       // a pinch change must persist this long
const POINTER_BLEND_START_RATIO = 0.80; // pointer slides from index tip to
                                        // pinch midpoint between this ratio
                                        // and PINCH_RATIO, so pinching does
                                        // not make the cursor jump

// Hand identity matching.
const MATCH_BASE_DISTANCE = 0.35;
const MATCH_SPEED_ALLOWANCE = 3.0; // extra norm-units allowed per second unseen
const MATCH_MAX_DISTANCE = 0.7;
const HANDEDNESS_MISMATCH_PENALTY = 1.15; // soft preference only: labels flip

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (t) => t * t * (3 - 2 * t);

class OneEuroFilter {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.prevRaw = null;
    this.prevFiltered = null;
    this.prevDeriv = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset(value) {
    this.prevRaw = value;
    this.prevFiltered = value;
    this.prevDeriv = 0;
    return value;
  }

  filter(value, dtSeconds) {
    if (this.prevFiltered === null) return this.reset(value);
    const dt = clamp(dtSeconds, 0.004, 0.1);
    const deriv = (value - this.prevRaw) / dt;
    this.prevDeriv += OneEuroFilter.alpha(this.dCutoff, dt) * (deriv - this.prevDeriv);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.prevDeriv);
    this.prevFiltered += OneEuroFilter.alpha(cutoff, dt) * (value - this.prevFiltered);
    this.prevRaw = value;
    return this.prevFiltered;
  }
}

export class CameraInput {
  constructor(videoElement, statusElement) {
    this.video = videoElement;
    this.statusEl = statusElement;
    this.statusMessage = "Camera off";

    this.handLandmarker = null;
    this.isReady = false;
    this.lastVideoTime = -1;
    this.lastTimestamp = -1;
    this.lastInferenceAt = -Infinity;

    this.wasPinching = false;
    this.pinchStarted = false;
    this.handStates = new Map();
    this.cameraVisitors = [];
    this.pinchStartedIds = new Set();
    this.suppressPinchStarts = false;
    this.nextHandId = 0;

    this.rawNormalizedState = {
      normX: 0,
      normY: 0,
      active: false,
      isPinching: false
    };
  }

  async init() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setStatus("Camera: Not Supported");
      return false;
    }

    try {
      this.setStatus("Requesting Camera...");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 480 },
          height: { ideal: 360 },
          frameRate: { ideal: 60, max: 60 },
          facingMode: "user"
        },
        audio: false
      });

      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;

      await this.video.play();
      this.video.parentElement?.classList.add("is-active");

      if (this.video.videoWidth === 0) {
        await new Promise((resolve, reject) => {
          this.video.addEventListener("loadeddata", resolve, { once: true });
          this.video.addEventListener("error", () => reject(new Error("Camera video failed to load")), { once: true });
        });
      }

      this.setStatus("Loading Hand Tracking Model...");

      const { FilesetResolver, HandLandmarker, vision } = await this.loadVisionTasks();

      const createLandmarker = (delegate) =>
        HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate
          },
          runningMode: "VIDEO",
          numHands: 4,
          minHandDetectionConfidence: HAND_CONFIDENCE_THRESHOLD,
          minHandPresenceConfidence: HAND_CONFIDENCE_THRESHOLD,
          minTrackingConfidence: HAND_CONFIDENCE_THRESHOLD
        });

      try {
        this.handLandmarker = await createLandmarker("GPU");
      } catch (gpuErr) {
        console.warn("[CameraInput] GPU delegate failed, falling back to CPU:", gpuErr);
        this.handLandmarker = await createLandmarker("CPU");
      }

      this.isReady = true;
      this.setStatus("Camera: Tracking Active");
      return true;
    } catch (err) {
      console.error("[CameraInput] Initialization failed:", err);
      this.setStatus(`Camera unavailable: ${err.message}`);
      this.stop();
      return false;
    }
  }

  async loadVisionTasks() {
    const sources = [
      {
        module: "https://esm.sh/@mediapipe/tasks-vision@0.10.0",
        wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
      },
      {
        module: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs",
        wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      },
      {
        module: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs",
        wasm: "https://unpkg.com/@mediapipe/tasks-vision@latest/wasm"
      }
    ];
    let lastError;

    for (const source of sources) {
      try {
        const { FilesetResolver, HandLandmarker } = await import(source.module);
        const vision = await FilesetResolver.forVisionTasks(source.wasm);
        return { FilesetResolver, HandLandmarker, vision };
      } catch (error) {
        lastError = error;
        console.warn(
          `[CameraInput] Could not load hand tracking from ${source.module} with ${source.wasm}:`,
          error
        );
      }
    }

    throw new Error(`Hand tracking library could not be loaded: ${lastError?.message ?? "unknown error"}`);
  }

  stop() {
    this.isReady = false;
    this.lastVideoTime = -1;
    this.lastTimestamp = -1;
    this.lastInferenceAt = -Infinity;
    this.suppressPinchStarts = false;
    this.handLandmarker?.close();
    this.handLandmarker = null;

    const stream = this.video.srcObject;
    if (stream && typeof stream.getTracks === "function") {
      stream.getTracks().forEach((track) => track.stop());
    }
    this.video.pause();
    this.video.srcObject = null;
    this.video.parentElement?.classList.remove("is-active");
    this.cameraVisitors = [];
    this.handStates.clear();
    this.pinchStartedIds.clear();
    this.pinchStarted = false;
    this.wasPinching = false;
    this.rawNormalizedState = {
      normX: 0,
      normY: 0,
      active: false,
      isPinching: false
    };
  }

  // Distances use x scaled by the video aspect ratio so they are isotropic.
  dist(a, b, aspect) {
    return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  }

  palmSize(landmarks, aspect) {
    return Math.max(
      this.dist(landmarks[0], landmarks[9], aspect),
      this.dist(landmarks[5], landmarks[17], aspect),
      0.02
    );
  }

  classifyGesture(landmarks, aspect) {
    if (!landmarks || landmarks.length < 21) return null;

    const wrist = landmarks[0];
    const fromWrist = (p) => this.dist(p, wrist, aspect);
    const fingers = [
      [landmarks[8], landmarks[6]],
      [landmarks[12], landmarks[10]],
      [landmarks[16], landmarks[14]],
      [landmarks[20], landmarks[18]]
    ];
    const extended = fingers.map(([tip, joint]) => fromWrist(tip) > fromWrist(joint) * 1.12);

    if (extended.every(Boolean)) return "open-palm";
    if (extended.every((e) => !e)) return "fist";
    return null;
  }

  stabilizeGesture(gesture, previous, now) {
    const candidateSince = previous?.gestureCandidate === gesture
      ? previous.gestureCandidateSince
      : now;
    const stableGesture = now - candidateSince >= GESTURE_CONFIRMATION_MS
      ? gesture
      : previous?.gesture ?? null;

    return {
      gesture: stableGesture,
      gestureCandidate: gesture,
      gestureCandidateSince: candidateSince
    };
  }

  // Drops duplicate detections of the same physical hand (MediaPipe sometimes
  // reports one hand twice, which showed up as a ghost visitor).
  buildDetections(results, aspect) {
    const all = (results.landmarks ?? [])
      .map((landmarks, index) => {
        const category = results.handedness?.[index]?.[0];
        return {
          landmarks,
          handedness: category?.categoryName ?? null,
          score: category?.score ?? 0
        };
      })
      .filter((d) => d.landmarks && d.landmarks.length >= 21)
      .map((d) => ({ ...d, palm: this.palmSize(d.landmarks, aspect) }))
      .sort((a, b) => b.score - a.score);

    const kept = [];
    for (const d of all) {
      const duplicate = kept.some((k) =>
        this.dist(k.landmarks[9], d.landmarks[9], aspect) < Math.max(k.palm, d.palm) * 0.22
      );
      if (!duplicate) kept.push(d);
    }
    return kept;
  }

  // Global nearest-first assignment of detections to known hands. Handedness
  // labels flip frame to frame, so they only bias the match slightly.
  matchDetections(detections, now) {
    const pairs = [];
    detections.forEach((det, i) => {
      const x = 1 - det.landmarks[8].x;
      const y = det.landmarks[8].y;
      for (const [id, state] of this.handStates) {
        const unseenSec = Math.max((now - state.lastSeenAt) / 1000, 0);
        const limit = Math.min(
          MATCH_BASE_DISTANCE + MATCH_SPEED_ALLOWANCE * unseenSec,
          MATCH_MAX_DISTANCE
        );
        const d = Math.hypot(state.rawX - x, state.rawY - y);
        if (d > limit) continue;
        const penalty = state.handedness === det.handedness ? 1 : HANDEDNESS_MISMATCH_PENALTY;
        pairs.push({ i, id, score: d * penalty });
      }
    });
    pairs.sort((a, b) => a.score - b.score);

    const ids = new Array(detections.length).fill(null);
    const usedIds = new Set();
    for (const { i, id } of pairs) {
      if (ids[i] !== null || usedIds.has(id)) continue;
      ids[i] = id;
      usedIds.add(id);
    }

    // Second pass: if a known, still-live hand has no detection while some
    // detection has no hand, assume it is the same hand that jumped (a tracker
    // glitch) rather than a brand new one. Glitch rejection in update() then
    // decides whether the jump is real. A genuinely additional hand is
    // unaffected: it only gets here when no known hand is left unmatched.
    const lostIds = [...this.handStates.entries()]
      .filter(([id, state]) => !usedIds.has(id) && now - state.lastSeenAt <= TRACKING_GRACE_MS)
      .map(([id]) => id);
    detections.forEach((det, i) => {
      if (ids[i] !== null || lostIds.length === 0) return;
      const x = 1 - det.landmarks[8].x;
      const y = det.landmarks[8].y;
      let best = 0;
      let bestDist = Infinity;
      lostIds.forEach((id, k) => {
        const state = this.handStates.get(id);
        const d = Math.hypot(state.rawX - x, state.rawY - y);
        if (d < bestDist) { bestDist = d; best = k; }
      });
      ids[i] = lostIds.splice(best, 1)[0];
    });
    return ids;
  }

  update() {
    if (
      !this.isReady ||
      !this.handLandmarker ||
      this.video.readyState < 2 ||
      this.video.currentTime === this.lastVideoTime ||
      performance.now() - this.lastInferenceAt < MIN_INFERENCE_INTERVAL_MS
    ) {
      return;
    }

    this.lastVideoTime = this.video.currentTime;

    try {
      this.pinchStarted = false;
      const now = performance.now();
      this.lastInferenceAt = now;
      const timestamp = Math.max(now, this.lastTimestamp + 1);
      this.lastTimestamp = timestamp;
      const suppressPinchStarts = this.suppressPinchStarts;
      const aspect = this.video.videoWidth && this.video.videoHeight
        ? this.video.videoWidth / this.video.videoHeight
        : 4 / 3;

      const results = this.handLandmarker.detectForVideo(this.video, timestamp);
      const detections = this.buildDetections(results, aspect);
      const matchedIds = this.matchDetections(detections, now);

      const currentHands = new Set();
      const detectedVisitors = detections.map((det, index) => {
        const { landmarks, handedness } = det;
        const normLandmarks = landmarks.map(({ x, y, z }) => ({ x: 1 - x, y, z }));
        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];

        let id = matchedIds[index];
        if (id === null) id = `camera:hand-${this.nextHandId++}`;
        currentHands.add(id);
        const previous = this.handStates.get(id);
        const firstSeenAt = previous?.firstSeenAt ?? now;
        const warmingUp = now - firstSeenAt < HAND_WARMUP_MS;
        const palmBaseline = previous?.palmBaseline ?? det.palm;
        const palmScale = det.palm / palmBaseline;
        const isDipped = warmingUp
          ? false
          : previous?.isDipped
            ? palmScale >= DIP_EXIT_SCALE
            : palmScale >= DIP_ENTER_SCALE;
        const depth = warmingUp
          ? 1
          : clamp(1 - (palmScale - 1) / (DIP_ENTER_SCALE - 1), 0, 1);
        const nextPalmBaseline = warmingUp
          ? palmBaseline + (det.palm - palmBaseline) * 0.25
          : isDipped
            ? palmBaseline
            : palmBaseline + (Math.min(det.palm, palmBaseline) - palmBaseline) * 0.01;

        // --- pinch measurement, normalised by hand size -------------------
        const pinchRatio = this.dist(indexTip, thumbTip, aspect) / det.palm;

        // --- pointer: index tip, sliding to the pinch midpoint on pinch ----
        const midX = 1 - (indexTip.x + thumbTip.x) / 2;
        const midY = (indexTip.y + thumbTip.y) / 2;
        const blend = smoothstep(clamp(
          (POINTER_BLEND_START_RATIO - pinchRatio) / (POINTER_BLEND_START_RATIO - PINCH_RATIO), 0, 1
        ));
        const rawX = (1 - indexTip.x) * (1 - blend) + midX * blend;
        const rawY = indexTip.y * (1 - blend) + midY * blend;

        const elapsed = previous
          ? Math.max((now - previous.lastSeenAt) / 1000, 0.008)
          : 0.016;

        // --- glitch rejection ---------------------------------------------
        let jumpFrames = 0;
        let resetFilters = false;
        if (previous) {
          const jump = Math.hypot(rawX - previous.rawX, rawY - previous.rawY);
          if (jump > MIN_GLITCH_JUMP && jump / elapsed > MAX_PLAUSIBLE_SPEED) {
            jumpFrames = (previous.jumpFrames ?? 0) + 1;
            if (jumpFrames < GLITCH_CONFIRM_FRAMES) {
              // Hold the last good state for this frame.
              this.handStates.set(id, { ...previous, jumpFrames, lastSeenAt: now });
              return {
                id,
                normX: previous.normX,
                normY: previous.normY,
                clickNormX: previous.normX,
                clickNormY: previous.normY,
                gesture: previous.gesture,
                landmarks: previous.landmarks,
                depth: previous.depth,
                dipped: previous.isDipped,
                active: true,
                isPinching: previous.isPinching,
                isClicked: false
              };
            }
            // The jump persisted: treat it as real and snap to it.
            resetFilters = true;
            jumpFrames = 0;
          }
        }

        // --- smoothing ----------------------------------------------------
        const filterX = resetFilters || !previous
          ? new OneEuroFilter(ONE_EURO_MIN_CUTOFF, ONE_EURO_BETA, ONE_EURO_D_CUTOFF)
          : previous.filterX;
        const filterY = resetFilters || !previous
          ? new OneEuroFilter(ONE_EURO_MIN_CUTOFF, ONE_EURO_BETA, ONE_EURO_D_CUTOFF)
          : previous.filterY;
        const normX = filterX.filter(rawX, elapsed);
        const normY = filterY.filter(rawY, elapsed);

        // --- pinch with hysteresis and a short confirmation window ----------
        const wasPinching = previous?.isPinching ?? false;
        const wantsPinch = wasPinching
          ? pinchRatio < RELEASE_RATIO
          : pinchRatio < PINCH_RATIO;
        let isPinching = wasPinching;
        let pinchFlipSince = null;
        if (wantsPinch !== wasPinching) {
          pinchFlipSince = previous?.pinchFlipSince ?? now;
          if (!previous || now - pinchFlipSince >= PINCH_CONFIRM_MS) {
            isPinching = wantsPinch;
            pinchFlipSince = null;
          }
        }

        const pinchStarted = isPinching && !wasPinching && !suppressPinchStarts;
        if (pinchStarted) this.pinchStartedIds.add(id);

        const stabilizedGesture = this.stabilizeGesture(
          this.classifyGesture(landmarks, aspect),
          previous,
          now
        );

        this.handStates.set(id, {
          ...stabilizedGesture,
          seq: previous?.seq ?? this.nextSeq(id),
          normX,
          normY,
          rawX,
          rawY,
          landmarks: normLandmarks,
          depth,
          isDipped,
          palmBaseline: nextPalmBaseline,
          firstSeenAt,
          filterX,
          filterY,
          jumpFrames,
          isPinching,
          pinchFlipSince,
          handedness: handedness ?? null,
          lastSeenAt: now
        });

        return {
          id,
          normX,
          normY,
          clickNormX: midX,
          clickNormY: midY,
          gesture: stabilizedGesture.gesture,
          landmarks: normLandmarks,
          depth,
          dipped: isDipped,
          active: true,
          isPinching,
          isClicked: pinchStarted
        };
      });

      if (suppressPinchStarts && detectedVisitors.some((v) => !v.isPinching)) {
        this.suppressPinchStarts = false;
      }

      const retainedVisitors = [];
      for (const id of [...this.handStates.keys()]) {
        if (currentHands.has(id)) continue;
        const previous = this.handStates.get(id);
        if (now - previous.lastSeenAt <= TRACKING_GRACE_MS) {
          retainedVisitors.push({
            id,
            normX: previous.normX,
            normY: previous.normY,
            landmarks: previous.landmarks,
            depth: previous.depth,
            dipped: previous.isDipped,
            gesture: previous.gesture,
            active: true,
            isPinching: previous.isPinching,
            isClicked: false
          });
        } else {
          this.handStates.delete(id);
        }
      }

      // Numeric order, so hand-10 does not sort before hand-2.
      const order = (v) => this.handStates.get(v.id)?.seq ?? Number.MAX_SAFE_INTEGER;
      this.cameraVisitors = [...detectedVisitors, ...retainedVisitors]
        .sort((a, b) => order(a) - order(b));

      const primaryHand = this.cameraVisitors[0];
      this.rawNormalizedState = primaryHand
        ? {
            normX: primaryHand.normX,
            normY: primaryHand.normY,
            active: true,
            isPinching: primaryHand.isPinching
          }
        : { normX: 0, normY: 0, active: false, isPinching: false };

      this.pinchStarted = this.pinchStartedIds.size > 0;
      this.wasPinching = this.cameraVisitors.some((hand) => hand.isPinching);
    } catch (err) {
      console.error("[CameraInput] Hand tracking failed:", err);
      this.cameraVisitors = [];
      this.handStates.clear();
      this.pinchStarted = false;
      this.pinchStartedIds.clear();
      this.wasPinching = false;
      this.suppressPinchStarts = true;
      this.rawNormalizedState = { normX: 0, normY: 0, active: false, isPinching: false };
    }
  }

  // Stable creation order for a hand id ("camera:hand-7" -> 7).
  nextSeq(id) {
    const n = Number(String(id).split("-").pop());
    return Number.isFinite(n) ? n : this.nextHandId;
  }

  getState() {
    return this.rawNormalizedState;
  }

  getVisitors() {
    const visitors = this.cameraVisitors.map((visitor) => ({
      ...visitor,
      isClicked: this.pinchStartedIds.has(visitor.id)
    }));
    this.pinchStartedIds.clear();
    this.pinchStarted = false;
    return visitors;
  }

  consumePinchStart() {
    const started = this.pinchStarted;
    this.pinchStarted = false;
    this.pinchStartedIds.clear();
    return started;
  }

  setStatus(message) {
    this.statusMessage = message;
    if (this.statusEl) {
      this.statusEl.textContent = message;
    }
  }
}
