export class PointerInput {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = {
      normX: 0,
      normY: 0,
      active: false
    };
    this.moved = false;
    this.pressed = false;

    canvas.addEventListener("pointermove", (event) => {
      this.updatePosition(event);
    });

    canvas.addEventListener("pointerdown", (event) => {
      this.updatePosition(event);
      this.pressed = true;
    });

    canvas.addEventListener("pointerup", (event) => {
      if (event.pointerType !== "mouse") {
        this.state.active = false;
      }
    });

    canvas.addEventListener("pointerleave", () => {
      this.state.active = false;
    });

    canvas.addEventListener("pointercancel", () => {
      this.state.active = false;
      this.pressed = false;
    });
  }

  updatePosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    this.state.normX = (event.clientX - rect.left) / rect.width;
    this.state.normY = (event.clientY - rect.top) / rect.height;
    this.state.active = true;
    this.moved = true;
  }

  read() {
    const state = {
      ...this.state,
      moved: this.moved,
      pressed: this.pressed
    };
    this.moved = false;
    this.pressed = false;
    return state;
  }
}
