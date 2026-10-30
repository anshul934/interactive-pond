const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (from, to, amount) => from + (to - from) * amount;
const easeInOut = (value) => value * value * (3 - 2 * value);

export class FrogNpc {
  constructor() {
    this.state = "waiting";
    this.waitTimer = 2 + Math.random() * 8;
    this.x = 0;
    this.y = 0;
    this.angle = 0;
    this.hopTime = 0;
    this.hopDuration = 0.55;
    this.hopStart = null;
    this.hopEnd = null;
    this.exitSide = 1;
    this.targetPad = null;
    this.color = ["#a7d948", "#c2e36b", "#82c955"][Math.floor(Math.random() * 3)];
    this.bobPhase = Math.random() * Math.PI * 2;
    this.swimPhase = Math.random() * Math.PI * 2;
    this.waterRippleEvents = [];
    this.splashEvents = []; // droplet splashes, consumed by the simulation
  }

  update(dt, width, height, lilyPads, enabled, depthAt = () => 1) {
    // How "deep" the frog's current spot is: 1 = deep (full speed), lower = shallow (slower)
    const wade = 0.45 + 0.55 * depthAt(this.x, this.y);

    // While swimming in or out through the shallows, leave a small ripple every 0.28s
    if ((this.state === "swimmingIn" || this.state === "swimmingOut") && wade < 0.8) {
      this.wadeTimer = (this.wadeTimer ?? 0) - dt;
      if (this.wadeTimer <= 0) {
        this.wadeTimer = 0.28;
        this.waterRippleEvents.push({ x: this.x, y: this.y + 4, intensity: 0.25 });
      }
    }

    this.bobPhase += dt * 4;
    if (this.state === "swimmingIn" || this.state === "swimmingOut" || this.state === "leaving") {
      this.swimPhase += dt * 12;
    }

    if (this.state === "waiting") {
      if (!enabled || lilyPads.length === 0) return;
      this.waitTimer -= dt;
      if (this.waitTimer <= 0) this.enter(width, height, lilyPads);
      return;
    }

    if (this.state === "swimmingIn") {
      const target = this.targetPad;
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const distance = Math.hypot(dx, dy);
      this.angle = Math.atan2(dy, dx);
      if (distance <= target.radius * 1.15) {
        this.beginHop(
          { x: this.x, y: this.y },
          {
            x: target.x + Math.cos(target.notchAngle) * target.radius * 0.2,
            y: target.y + Math.sin(target.notchAngle) * target.radius * 0.2
          },
          "perching"
        );
      } else {
        this.moveTowards(dx, dy, 72 * wade, dt);
      }
      return;
    }

    if (this.state === "hoppingToPad" || this.state === "hoppingToWater") {
      this.updateHop(dt);
      return;
    }

    if (this.state === "treading") {
      // Frog has just dropped into the water: it floats in place for a moment
      // before it swims away.
      this.waitTimer -= dt;

      // A small, fainter follow-up ripple as the water settles
      if (!this.settleRippleDone && this.waitTimer < this.treadDuration * 0.5) {
        this.settleRippleDone = true;
        this.waterRippleEvents.push({ x: this.x, y: this.y + 4, intensity: 0.7 });
      }

      if (this.waitTimer <= 0) this.state = "swimmingOut";
      return;
    }

    if (this.state === "perching") {
        // Ride along with the floating pad
        if (this.padAnchor && this.targetPad) {
          this.x += this.targetPad.x - this.padAnchor.x;
          this.y += this.targetPad.y - this.padAnchor.y;
          this.padAnchor = { x: this.targetPad.x, y: this.targetPad.y };
        }
        this.waitTimer -= dt;
      if (this.waitTimer <= 0) {
        const pad = this.targetPad;
        this.beginHop(
          { x: this.x, y: this.y },
          {
            x: pad.x + this.exitSide * pad.radius * 1.45,
            y: pad.y + pad.radius * 0.45
          },
          "swimmingOut"
        );
        this.state = "hoppingToWater";
      }
      return;
    }

    if (this.state === "swimmingOut") {
      const targetX = this.exitSide < 0 ? -45 : width + 45;
      const targetY = clamp(this.y + Math.sin(this.bobPhase) * 0.4, 25, height - 25);
      const dx = targetX - this.x;
      const dy = targetY - this.y;
      this.angle = Math.atan2(dy, dx);
      this.moveTowards(dx, dy, 90 * wade, dt);

      if ((this.exitSide < 0 && this.x < -35) || (this.exitSide > 0 && this.x > width + 35)) {
        this.state = "waiting";
        this.waitTimer = 4 + Math.random() * 11;
      }
    }

    if (this.state === "leaving") {
      this.x += Math.cos(this.angle) * 90 * dt;
      this.y += Math.sin(this.angle) * 90 * dt;

      if (
        this.x < -45 ||
        this.x > width + 45 ||
        this.y < -45 ||
        this.y > height + 45
      ) {
        this.state = "waiting";
        this.waitTimer = 4 + Math.random() * 11;
      }
    }
  }

  enter(width, height, lilyPads) {
    this.exitSide = Math.random() < 0.5 ? -1 : 1;
    this.x = this.exitSide < 0 ? -32 : width + 32;
    this.y = height * (0.25 + Math.random() * 0.5);
    this.targetPad = lilyPads[Math.floor(Math.random() * lilyPads.length)];
    this.state = "swimmingIn";
  }

  disableLilyPads() {
    if (this.state === "perching" && this.targetPad) {
      // The pad vanished under the frog: it drops into the water with a splash,
      // treads water for a beat, then swims away.
      this.exitSide = Math.cos(this.angle) < 0 ? -1 : 1;

      this.waterRippleEvents.push(
        { x: this.x, y: this.y, intensity: 3.0 },
        { x: this.x - 12, y: this.y + 7, intensity: 1.4 },
        { x: this.x + 12, y: this.y + 7, intensity: 1.4 }
      );
      this.splashEvents.push({ x: this.x, y: this.y, power: 1.4 });

      this.targetPad = null;
      this.padAnchor = null;
      this.treadDuration = 0.45 + Math.random() * 0.25;  // buffer before swimming away
      this.waitTimer = this.treadDuration;
      this.settleRippleDone = false;
      this.state = "treading";
      return;
    }
    if (this.state === "swimmingIn" || this.state === "hoppingToPad") {
      this.targetPad = null;
      this.state = "leaving";
    }
  }

  moveTowards(dx, dy, speed, dt) {
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return;
    const step = Math.min(distance, speed * dt);
    this.x += (dx / distance) * step;
    this.y += (dy / distance) * step;
  }

  beginHop(from, to, nextState, rippleIntensity = 0.18, rippleOnLanding = false) {
    this.hopStart = from;
    this.hopEnd = to;
    this.hopTime = 0;
    this.hopDuration = 0.45 + Math.random() * 0.2;
    this.landingRipple = rippleOnLanding
      ? { x: to.x, y: to.y, intensity: rippleIntensity }
      : null;

    if (!rippleOnLanding) {
      const ripplePosition = nextState === "perching" ? from : to;
      this.waterRippleEvents.push({
        x: ripplePosition.x,
        y: ripplePosition.y,
        intensity: rippleIntensity
      });
    }

    this.state = nextState === "perching" ? "hoppingToPad" : "hoppingToWater";
  }

  consumeWaterRippleEvents() {
    return this.waterRippleEvents.splice(0);
  }

  consumeSplashEvents() {
    return this.splashEvents.splice(0);
  }

  updateHop(dt) {
    this.hopTime += dt;
    const progress = clamp(this.hopTime / this.hopDuration, 0, 1);
    const eased = easeInOut(progress);
    this.x = lerp(this.hopStart.x, this.hopEnd.x, eased);
    this.y = lerp(this.hopStart.y, this.hopEnd.y, eased) -
      Math.sin(progress * Math.PI) * 34;
    this.angle = Math.atan2(
      this.hopEnd.y - this.hopStart.y,
      this.hopEnd.x - this.hopStart.x
    );

    if (progress < 1) return;

    this.x = this.hopEnd.x;
    this.y = this.hopEnd.y;
    if (this.landingRipple) {
      this.waterRippleEvents.push(this.landingRipple);
      this.landingRipple = null;
    }
    if (this.state === "hoppingToPad") {
      this.state = "perching";
      this.waitTimer = 2 + Math.random() * 5;
      this.padAnchor = this.targetPad
        ? { x: this.targetPad.x, y: this.targetPad.y }
        : null;
    } else {
      this.state = "swimmingOut";
    }
  }

  draw(ctx) {
    if (this.state === "waiting") return;

    const airborne = this.state === "hoppingToPad" || this.state === "hoppingToWater";
    const swimming =
      this.state === "swimmingIn" ||
      this.state === "swimmingOut" ||
      this.state === "leaving";
    const bob = this.state === "perching"
      ? Math.sin(this.bobPhase) * 1.2
      : this.state === "treading"
        ? Math.sin(this.bobPhase * 1.5) * 1.6
        : swimming ? Math.sin(this.swimPhase * 2) * 1.1 : 0;
    ctx.save();
    ctx.translate(this.x, this.y + bob);
    const facingLeft = Math.cos(this.angle) < 0;
    ctx.scale(facingLeft ? -1.3 : 1.3, 1.3);

    ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
    ctx.beginPath();
    ctx.ellipse(0, airborne ? 15 : 8, 13, airborne ? 4 : 6, 0, 0, Math.PI * 2);
    ctx.fill();

    const kick = swimming ? (1 - Math.cos(this.swimPhase)) * 0.5 : 0;
    this.drawHindLeg(ctx, -1, kick);
    this.drawHindLeg(ctx, 1, kick);

    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(-2, 0, 11, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(7, -1, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#d8f09a";
    ctx.beginPath();
    ctx.arc(8, -5, 2.5, 0, Math.PI * 2);
    ctx.arc(12, -4, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#152419";
    ctx.beginPath();
    ctx.arc(9, -5, 1, 0, Math.PI * 2);
    ctx.arc(13, -4, 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(3, 3);
    ctx.lineTo(9, 8);
    ctx.moveTo(-2, 4);
    ctx.lineTo(3, 9);
    ctx.stroke();

    ctx.restore();
  }

  drawHindLeg(ctx, side, kick) {
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-6, side * 3);
    ctx.quadraticCurveTo(-10, side * (8 + kick * 2), -13 - kick * 4, side * (8 + kick * 3));
    ctx.lineTo(-14 - kick * 8, side * (10 + kick * 7));
    ctx.stroke();

    const footX = -14 - kick * 8;
    const footY = side * (10 + kick * 7);
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(footX, footY);
    ctx.lineTo(footX - 4, footY - side * 3);
    ctx.moveTo(footX, footY);
    ctx.lineTo(footX - 5, footY);
    ctx.moveTo(footX, footY);
    ctx.lineTo(footX - 4, footY + side * 3);
    ctx.stroke();
  }
}
