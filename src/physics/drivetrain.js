/**
 * Engine + clutch + gearbox. An actuator chain, nothing more.
 *
 *   pedal -> throttle plate -> engine torque -> clutch -> gears -> wheel torque
 *
 * It never knows where the car is, only how fast the driven wheels turn. The
 * rpm is *read off the drivetrain* (wheel speed x ratio), which is the one kind
 * of "authored" value the fidelity ladder allows: crank speed is constrained by
 * the mechanism, not by the designer.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Drivetrain {
  constructor(cfg) {
    this.cfg = cfg;
    this.gear = 1;
    this.rpm = cfg.engine.idle;
    this.shiftTimer = 0;
    this.reverseTimer = 0;
    this.reverse = false;
    this.slipping = true;
    this.lastShift = 0;
    this.hasMoved = false;
    this.reverseArmed = false;
    this.shiftLock = 0;
  }

  get gearCount() {
    return this.cfg.engine.gears.length;
  }

  /** Engine torque at a crank speed (Nm), interpolated off the curve. */
  torqueAt(rpm) {
    const curve = this.cfg.engine.curve;
    const r = clamp(rpm, curve[0][0], curve[curve.length - 1][0]);
    for (let i = 1; i < curve.length; i++) {
      if (r <= curve[i][0]) {
        const [r0, t0] = curve[i - 1];
        const [r1, t1] = curve[i];
        const f = (r - r0) / (r1 - r0);
        return t0 + (t1 - t0) * f;
      }
    }
    return curve[curve.length - 1][1];
  }

  ratio() {
    const e = this.cfg.engine;
    const g = this.reverse ? -e.reverse : e.gears[this.gear - 1];
    return g * e.finalDrive;
  }

  /** Split of the total wheel torque between axles. */
  driveSplit() {
    const mode = this.cfg.engine.drivetrain;
    if (mode === 'fwd') return { front: 1, rear: 0 };
    if (mode === 'awd') {
      const f = this.cfg.engine.awdFrontSplit;
      return { front: f, rear: 1 - f };
    }
    return { front: 0, rear: 1 };
  }

  /**
   * @param {object} input     { throttle: -1..1 }  positive = forward pedal
   * @param {number} wheelOmega mean angular velocity of the driven wheels (rad/s)
   * @param {number} speed     chassis forward speed (m/s), signed
   * @param {number} dt
   */
  update(input, wheelOmega, speed, dt, drivenSlip = 0) {
    const e = this.cfg.engine;
    const pedal = clamp(input.throttle, -1, 1);
    const rawDrive = clamp(pedal, 0, 1);
    const rawBrake = clamp(-pedal, 0, 1);

    // ---- reverse: keep the brake down at a standstill *after releasing it
    // once*, and it becomes the drive pedal. Holding the pedal all the way
    // down from the stop itself just holds the car still.
    if (Math.abs(speed) > 1.0) this.hasMoved = true;
    if (Math.abs(speed) < 0.5) {
      // armed only after actually driving: a car that has never moved, or one
      // still rolling, cannot be put into reverse by leaning on the brake
      if (rawBrake < 0.1 && this.hasMoved) this.reverseArmed = true;
    } else {
      this.reverseArmed = false;
    }

    if (this.reverse && speed < 0.4 && rawDrive > 0.15) {
      this.reverse = false;
      this.gear = 1;
      this.reverseTimer = 0;
    } else if (!this.reverse && this.reverseArmed && speed < 0.4 && rawBrake > 0.55) {
      this.reverseTimer += dt;
      if (this.reverseTimer > 0.45) {
        this.reverse = true;
        this.gear = 1;
        this.rpm = e.idle;
        this.reverseArmed = false;
        this.reverseTimer = 0;
      }
    } else {
      this.reverseTimer = 0;
    }

    const drivePedal = this.reverse ? rawBrake : rawDrive;
    const brakePedal = this.reverse ? rawDrive : rawBrake;

    // ---- rpm read off the drivetrain
    const ratio = this.ratio();
    const wheelRpm = ((wheelOmega * ratio) / (2 * Math.PI)) * 60;
    const rpmFromWheels = Math.abs(wheelRpm);

    // ---- clutch: below idle the engine has to slip, that's the launch
    const slipping = rpmFromWheels < e.clutchEngageRpm;
    this.slipping = slipping;

    let rpm;
    if (slipping) {
      // slipping clutch: engine sits just above idle, the driver keeps it alive
      rpm = e.idle + drivePedal * 900 + Math.max(0, rpmFromWheels) * 0.35;
    } else {
      rpm = rpmFromWheels;
    }
    rpm = clamp(rpm, e.idle, e.limiter - 1);
    this.rpm += (rpm - this.rpm) * Math.min(1, dt * 14);

    // ---- gearbox
    this.shiftLock = Math.max(0, this.shiftLock - dt);

    // kickdown: floor it at a lazy rpm and the box drops a gear so the tyres
    // actually have something to argue with (this is what makes a power
    // oversteer drift possible out of a corner)
    if (this.shiftLock <= 0 && !slipping && !this.reverse && this.gear > 2 && drivenSlip < 0.3) {
      if (drivePedal > 0.8 && rpmFromWheels < 5200) {
        const lowerRatio = e.gears[this.gear - 3] * e.finalDrive;
        const rpmInLower = rpmFromWheels * (lowerRatio / ratio);
        if (rpmInLower < 6200) {
          this.gear--;
          this.shiftTimer = e.shiftTime;
          this.shiftLock = 0.7;
        }
      }
    }
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
    } else if (
      !this.reverse &&
      !slipping &&
      this.shiftLock <= 0 &&
      Math.abs(speed) > 2 &&
      drivenSlip < 0.5 // don't grab another gear off a wheelspin
    ) {
      if (rpmFromWheels > e.shiftUpRpm && this.gear < this.gearCount) {
        this.gear++;
        this.shiftTimer = e.shiftTime;
        this.shiftLock = 0.5;
      } else if (rpmFromWheels < e.shiftDownRpm && this.gear > 1) {
        this.gear--;
        this.shiftTimer = e.shiftTime;
        this.shiftLock = 0.5;
      }
    }

    // ---- torque
    let engineTorque = this.torqueAt(this.rpm) * drivePedal;
    // rev limiter: fuel cut, not a soft ceiling
    if (this.rpm > e.redline) engineTorque = 0;
    // engine braking: closed throttle still drags the crank around, but only
    // when the clutch is actually closed - at a standstill the clutch is
    // slipping and it must not push the car around.
    let engineBrake = this.slipping ? 0 : (1 - drivePedal) * e.frictionTorque;
    if (this.shiftTimer > 0) {
      engineTorque = 0;
      engineBrake = 0;
    }
    const totalWheelTorque = (engineTorque - engineBrake) * this.ratio() * e.efficiency;

    return {
      totalWheelTorque, // Nm, sum over the driven wheels
      engineTorque,
      ratio: this.ratio(),
      rpm: this.rpm,
      gear: this.reverse ? -1 : this.gear,
      shifting: this.shiftTimer > 0,
      slipping: this.slipping,
      drivePedal,
      brakePedal,
      redline: e.redline,
      reverse: this.reverse,
    };
  }
}
