import { CameraInput } from "./CameraInput.js";
import { PointerInput } from "./PointerInput.js";

const CAMERA_MOVEMENT_DEADBAND_MIN_PX = 28;
const CAMERA_MOVEMENT_DEADBAND_RATIO = 0.035;

export class InputManager {
  constructor(canvas, videoElement, statusElement) {
    this.canvas = canvas;
    this.videoElement = videoElement;
    this.statusElement = statusElement;
    this.pointer = new PointerInput(canvas);
    this.camera = null;
    this.cameraEnabled = false;
    this.previousPosition = null;
    this.previousProvider = null;
    this.cameraPositions = new Map();
    this.cameraMovementAnchors = new Map();
    this.lastCameraVisitorCount = null;
  }

  async startCamera() {
    if (this.camera?.isReady) {
      this.cameraEnabled = true;
      return true;
    }

    this.camera ??= new CameraInput(this.videoElement, this.statusElement);

    const ready = await this.camera.init();
    this.cameraEnabled = ready;
    this.previousPosition = null;
    this.previousProvider = null;
    this.cameraPositions.clear();
    this.cameraMovementAnchors.clear();
    return ready;
  }

  stopCamera() {
    this.cameraEnabled = false;
    this.camera?.stop();
    this.previousPosition = null;
    this.previousProvider = null;
    this.cameraPositions.clear();
    this.cameraMovementAnchors.clear();
  }

  update() {
    const rect = this.canvas.getBoundingClientRect();
    const pointerState = this.pointer.read();
    let providerState = pointerState;
    let provider = "pointer";
    let visitors = [];

    if (this.cameraEnabled && this.camera) {
      this.camera.update();
      const cameraVisitors = this.camera.getVisitors()
        .filter(visitor => visitor.active);
      if (cameraVisitors.length !== this.lastCameraVisitorCount) {
        this.lastCameraVisitorCount = cameraVisitors.length;
        if (this.statusElement) {
          this.statusElement.textContent = cameraVisitors.length
            ? `Camera on (${cameraVisitors.length} hand${cameraVisitors.length === 1 ? "" : "s"})`
            : "Camera on (no hands detected)";
        }
      }
      if (cameraVisitors.length > 0) {
        const providerChanged = this.previousProvider !== "camera";
        const movementThreshold = Math.max(
          CAMERA_MOVEMENT_DEADBAND_MIN_PX,
          Math.min(rect.width, rect.height) * CAMERA_MOVEMENT_DEADBAND_RATIO
        );
        visitors = cameraVisitors.map(visitor => {
          const x = rect.left + visitor.normX * rect.width;
          const y = rect.top + visitor.normY * rect.height;
          const palmLandmarks = [0, 5, 9, 13, 17]
            .map(index => visitor.landmarks?.[index])
            .filter(Boolean);
          const motionX = palmLandmarks.length
            ? rect.left + palmLandmarks.reduce((sum, point) => sum + point.x, 0) /
              palmLandmarks.length * rect.width
            : x;
          const motionY = palmLandmarks.length
            ? rect.top + palmLandmarks.reduce((sum, point) => sum + point.y, 0) /
              palmLandmarks.length * rect.height
            : y;
          const previous = this.cameraPositions.get(visitor.id);
          let anchor = this.cameraMovementAnchors.get(visitor.id);
          let moved = providerChanged || !previous;
          let speed = previous ? Math.hypot(motionX - previous.x, motionY - previous.y) : 0;

          if (!anchor || providerChanged) {
            anchor = { x: motionX, y: motionY };
          } else if (Math.hypot(motionX - anchor.x, motionY - anchor.y) >= movementThreshold) {
            moved = true;
            speed = Math.hypot(motionX - anchor.x, motionY - anchor.y);
            anchor = { x: motionX, y: motionY };
          }

          this.cameraPositions.set(visitor.id, { x: motionX, y: motionY });
          this.cameraMovementAnchors.set(visitor.id, anchor);
          return {
            id: visitor.id,
            x,
            y,
            landmarks: visitor.landmarks,
            depth: visitor.depth,
            dipped: visitor.dipped,
            active: true,
            moved,
            speed,
            action: visitor.isClicked
          };
        });

        const activeIds = new Set(cameraVisitors.map(visitor => visitor.id));
        for (const id of this.cameraPositions.keys()) {
          if (!activeIds.has(id)) {
            this.cameraPositions.delete(id);
            this.cameraMovementAnchors.delete(id);
          }
        }

        const primaryVisitor = visitors[0];
        providerState = {
          normX: cameraVisitors[0].normX,
          normY: cameraVisitors[0].normY,
          active: true,
          moved: primaryVisitor.moved,
          pressed: visitors.some(visitor => visitor.action)
        };
        provider = "camera";
      }
    }

    if (!providerState.active || !rect.width || !rect.height) {
      this.previousPosition = null;
      this.previousProvider = null;
      return {
        x: 0,
        y: 0,
        speed: 0,
        active: false,
        moved: false,
        action: false,
        visitors: []
      };
    }

    const x = rect.left + providerState.normX * rect.width;
    const y = rect.top + providerState.normY * rect.height;
    const dx = this.previousPosition ? x - this.previousPosition.x : 0;
    const dy = this.previousPosition ? y - this.previousPosition.y : 0;
    const providerChanged = this.previousProvider !== provider;
    let moved = providerState.moved || providerChanged;
    let speed = Math.hypot(dx, dy);

    if (provider === "pointer") {
      this.cameraPositions.clear();
      this.cameraMovementAnchors.clear();
      this.lastCameraVisitorCount = null;
      visitors = [{
        id: "pointer",
        x,
        y,
        active: true,
        moved,
        speed,
        action: providerState.pressed
      }];
    }

    this.previousPosition = { x, y };
    this.previousProvider = provider;

    return {
      x,
      y,
      speed,
      active: true,
      moved,
      action: providerState.pressed,
      visitors
    };
  }
}
