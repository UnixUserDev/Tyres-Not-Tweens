/**
 * The car.
 *
 * READ THIS BEFORE ADDING ANYTHING TO step():
 * input may only reach an actuator - a steering joint angle, a wheel torque,
 * a brake torque. It may never touch body state. There is no rotation, no
 * velocity, no position written anywhere below except in reset(), which is a
 * teleport by definition and is labelled as such.
 *
 *   pedal -> engine torque -> wheel omega -> slip ratio -> tyre force at the
 *   CONTACT PATCH -> r x F -> integrated yaw, roll, pitch, trajectory
 *
 * FRAME CONVENTION - important, it bit us once:
 *   +Z is forward, +Y is up, so in a right-handed frame the car's RIGHT-hand
 *   side is -X (the left is +X). A positive steering angle therefore has to
 *   rotate the wheel toward -X, and `rPlane` (the lateral axis the tyre model
 *   measures slip along) is cross(forward, up) = -X. Turning right then gives a
 *   NEGATIVE yaw rate, which is the correct sign for a clockwise rotation.
 */

import {
  clamp,
  clampToFrictionCircle,
  combinedSlipAttenuation,
  lateralForce,
  longitudinalForce,
  muAtLoad,
  slipAngle,
  slipRatio,
} from './tire.js';
import { Drivetrain } from './drivetrain.js';
import { WHEELS } from '../config.js';

/** Rotate a vector by a quaternion (x,y,z,w). Kept local so this module has no three.js dependency. */
function qRot(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

const norm = (v) => {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
};

export class Vehicle {
  constructor(RAPIER, world, cfg) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.cfg = cfg;
    this.drivetrain = new Drivetrain(cfg);

    this.wheels = WHEELS.map((w, i) => ({
      ...w,
      partner: i % 2 === 0 ? i + 1 : i - 1, // other wheel on the same axle
      omega: 0,
      prevCompression: 0,
      absScale: 1,
      contact: {
        grounded: false,
        point: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        load: 0,
        compression: 0,
        travel: 0,
        slipRatio: 0,
        slipAngle: 0,
        fx: 0,
        fy: 0,
        utilisation: 0,
        driveTorque: 0,
        brakeTorque: 0,
        bottomed: false,
        spin: 0,
        center: { x: 0, y: 0, z: 0 },
      },
    }));

    this.steer = 0;
    this.tcScale = 1;
    this.tractionControl = true;
    this._prevVel = { x: 0, y: 0, z: 0 };
    this._lastCompression = [0, 0, 0, 0];
    this.telemetry = {
      speed: 0,
      lateralG: 0,
      longG: 0,
      yawRate: 0,
      rpm: cfg.engine.idle,
      gear: 1,
      aeroDrag: 0,
      roll: 0,
      pitch: 0,
      airborne: false,
    };

    this._createBody();
  }

  _createBody() {
    const { RAPIER, world, cfg } = this;
    const c = cfg.chassis;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(cfg.spawn.x, cfg.spawn.y, cfg.spawn.z)
      .setRotation({ x: 0, y: Math.sin(cfg.spawn.yaw / 2), z: 0, w: Math.cos(cfg.spawn.yaw / 2) })
      .setLinearDamping(0) // drag is explicit, at the aero centre
      .setAngularDamping(0.06) // tiny: air and bearings, not a stabiliser
      .setCanSleep(false) // a parked car must still answer the next impulse
      .setCcdEnabled(true);

    this.body = world.createRigidBody(bodyDesc);

    // Mass properties come from the collider. Note: RigidBodyDesc
    // .setAdditionalMassProperties is a no-op in rapier3d-compat 0.14 - it
    // reports mass 0 - so the car would be an immovable ghost. Collider
    // setMassProperties() works and is the one we use.
    const colliderDesc = RAPIER.ColliderDesc.cuboid(c.half.x, c.half.y, c.half.z)
      .setTranslation(c.offset.x, c.offset.y, c.offset.z)
      .setMassProperties(cfg.mass, { x: 0, y: 0, z: 0 }, cfg.inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.55)
      .setRestitution(0.08);

    this.collider = world.createCollider(colliderDesc, this.body);

    // The rest of the bodywork. The lower hull above is the only thing that
    // carries mass; these are density-0 shells so the car cannot phase through
    // the ground when it ends up on its roof, its nose or its wing.
    const shell = [
      // hx,   hy,    hz,    ox,  oy,    oz
      [0.74, 0.21, 0.88, 0, 0.39, -0.28], // greenhouse
      [0.84, 0.14, 0.16, 0, 0.0, 2.0], // nose cap
      [0.86, 0.14, 0.14, 0, 0.05, -2.0], // tail cap
      [0.83, 0.035, 0.17, 0, 0.47, -1.84], // rear wing
    ];
    for (const [hx, hy, hz, ox, oy, oz] of shell) {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(ox, oy, oz)
          .setDensity(0)
          .setFriction(0.45)
          .setRestitution(0.05),
        this.body,
      );
    }
  }

  /** Teleport. Only ever called from spawn/reset - never from the drive loop. */
  reset(position = this.cfg.spawn) {
    const { body } = this;
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    const yaw = position.yaw ?? 0;
    body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.resetForces(true);
    body.resetTorques(true);

    this.steer = 0;
    this.tcScale = 1;
    this.tractionControl = true;
    this._prevVel = { x: 0, y: 0, z: 0 };
    for (const w of this.wheels) {
      w.omega = 0;
      w.prevCompression = 0;
      w.absScale = 1;
      Object.assign(w.contact, {
        grounded: false,
        load: 0,
        compression: 0,
        slipRatio: 0,
        slipAngle: 0,
        fx: 0,
        fy: 0,
        utilisation: 0,
      });
    }
    this.drivetrain = new Drivetrain(this.cfg);
  }

  /**
   * Steering lock available at this speed. This is an ASSIST and is labelled as
   * one in the README: it is applied to the rack (the actuator), never to yaw.
   *
   * The lock is derived from the cornering radius the tyres could actually
   * hold at this speed, not from a linear taper. A keyboard only has 0 and 1,
   * so if the rack offered 26 deg at 60 km/h every tap would be a spin. The
   * player still decides where to point the wheels; the car decides what that
   * is worth.
   */
  maxSteerAtSpeed(speed) {
    const s = this.cfg.steering;
    const a = s.assist;
    const v = Math.abs(speed);
    if (!a.enabled || v < 2) return s.maxAngle;
    const mu = this.cfg.tire.mu;
    const gripRadius = (v * v) / (mu * 9.81);
    const lockForGrip = Math.atan(this.cfg.wheel.wheelbase / Math.max(gripRadius, 0.5));
    return clamp(Math.max(lockForGrip * a.gripMultiplier, a.minAngle), a.minAngle, s.maxAngle);
  }

  step(input, dt) {
    const { body, cfg, world } = this;
    const tire = cfg.tire;

    const t = body.translation();
    const com = body.worldCom();
    const q = body.rotation();
    const linvel = body.linvel();
    const angvel = body.angvel();

    const up = qRot(q, { x: 0, y: 1, z: 0 });
    const fwd = qRot(q, { x: 0, y: 0, z: 1 });
    const speed = dot(linvel, fwd);

    // ---------------- steering actuator (joint angle, not a turn rate) -------
    const steerTarget = clamp(input.steer, -1, 1) * this.maxSteerAtSpeed(speed);
    const s = cfg.steering;
    const returning = Math.abs(steerTarget) < Math.abs(this.steer) || steerTarget * this.steer < 0;
    const rateFactor = clamp(
      1 / (1 + Math.abs(speed) / s.assist.rateFalloffSpeed),
      s.assist.minRateFactor,
      1,
    );
    const rate = (returning ? s.returnRate : s.rate) * rateFactor * dt;
    this.steer += clamp(steerTarget - this.steer, -rate, rate);

    // ---------------- drivetrain (actuators: engine torque, brake torque) ----
    const split = this.drivetrain.driveSplit();
    const drivenWheels = this.wheels.filter((w) => (w.front ? split.front : split.rear) > 0);
    let drivenOmega = 0;
    for (const w of drivenWheels) drivenOmega += w.omega;
    if (drivenWheels.length) drivenOmega /= drivenWheels.length;

    let drivenSlip = 0;
    for (const w of drivenWheels) drivenSlip = Math.max(drivenSlip, Math.abs(w.contact.slipRatio));
    const drive = this.drivetrain.update(input, drivenOmega, speed, dt, drivenSlip);
    const brakePedal = drive.brakePedal;

    // ---- traction control: trims drive torque when the driven tyres are past
    // their peak slip. One step of lag (it uses last step's slip), exactly like
    // a real TC that reacts to measured wheel speed.
    // pulling the handbrake also parks the TC for a moment afterwards, or you
    // cannot keep the rear spinning once the handbrake is released
    this._tcSuppress = input.handbrake ? 1.2 : Math.max(0, (this._tcSuppress || 0) - dt);
    if (this.tractionControl && cfg.tractionControl.enabled && this._tcSuppress <= 0) {
      let maxSlip = 0;
      for (const w of drivenWheels) maxSlip = Math.max(maxSlip, w.contact.slipRatio);
      const excess = maxSlip - cfg.tractionControl.slipTarget;
      const desired = clamp(1 - excess * 4, 0.05, 1);
      this.tcScale += (desired - this.tcScale) * Math.min(1, dt * 14);
    } else {
      this.tcScale = 1;
    }
    const driveTorqueTotal = drive.totalWheelTorque * this.tcScale;
    this.telemetry.tcActive = this.tcScale < 0.98 && this._tcSuppress <= 0;

    // ---------------- per wheel: suspension load, then tyre force ------------
    let grounded = 0;
    for (const wheel of this.wheels) {
      const c = wheel.contact;
      const local = { x: wheel.x, y: 0, z: wheel.z };
      const attachLocal = qRot(q, local);
      const attach = { x: t.x + attachLocal.x, y: t.y + attachLocal.y, z: t.z + attachLocal.z };

      // steered wheel frame
      const delta = wheel.front ? this.steer : 0;
      const cd = Math.cos(delta);
      const sd = Math.sin(delta);
      // rotate the body's forward vector about the body's up axis. +steer is
      // the car's RIGHT, which is -X in this frame.
      const wheelFwdRaw = qRot(q, { x: -sd, y: 0, z: cd });

      // ---- suspension raycast down the chassis axis
      const down = { x: -up.x, y: -up.y, z: -up.z };
      const ray = new this.RAPIER.Ray(attach, down);
      const maxToi = cfg.suspension.maxLength + cfg.wheel.radius;
      // solid=false: with solid=true a ray whose ORIGIN is inside a collider
      // returns timeOfImpact 0, which reads as "the wheel is 33 cm underground"
      // and produces a full bump-stop spring force for a step. On a ramp, where
      // the hub can dip inside the surface, that is a catapult - it was vaulting
      // the car into the air. solid=false reports the surface it exits through
      // instead, and tiny hits are ignored below.
      let hit = world.castRayAndGetNormal(
        ray,
        maxToi,
        false,
        undefined,
        undefined,
        this.collider,
        body,
      );
      if (hit && hit.timeOfImpact < 0.02) {
        hit = null; // degenerate contact right at the hub, not a real surface
      }

      let springForce = 0;

      if (!hit) {
        c.grounded = false;
        c.load = 0;
        c.compression = 0;
        c.travel = cfg.suspension.maxLength;
        c.slipRatio = 0;
        c.slipAngle = 0;
        c.fx = 0;
        c.fy = 0;
        c.utilisation = 0;
        c.driveTorque = 0;
        c.brakeTorque = 0;
        c.bottomed = false;
        wheel.prevCompression = 0;
        // wheel centre hangs at full droop
        c.center = {
          x: attach.x + down.x * cfg.suspension.maxLength,
          y: attach.y + down.y * cfg.suspension.maxLength,
          z: attach.z + down.z * cfg.suspension.maxLength,
        };
        // free-spinning wheel: engine torque still accelerates it, nothing else.
        // Same effective inertia as on the ground, or the wheel spins up 14x
        // faster in the air and the gearbox shifts on thin air.
        const airAxleSplit = wheel.front ? split.front : split.rear;
        const airDriven = split.front > 0 && split.rear > 0 ? 4 : 2;
        const airI =
          cfg.wheel.inertia +
          (airAxleSplit > 0 ? (cfg.engine.inertia * drive.ratio * drive.ratio) / airDriven : 0);
        const share = airAxleSplit > 0 ? (airAxleSplit * driveTorqueTotal) / 2 : 0;

        // The brake is a caliper on the hub: it works whether or not the tyre is
        // touching anything. Without this, a wheel keeps spinning forever when
        // the car is on its roof.
        let airBrake = brakePedal > 0.001
          ? brakePedal * (wheel.front ? cfg.brakes.frontTorque : cfg.brakes.rearTorque)
          : 0;
        if (!wheel.front && input.handbrake) {
          airBrake = Math.max(airBrake, cfg.brakes.handbrakeTorque);
        }
        c.brakeTorque = airBrake;

        let airOmega = wheel.omega + (share / airI) * dt;
        if (airBrake > 0) {
          const delta = (airBrake / airI) * dt;
          if (Math.abs(airOmega) <= delta) airOmega = 0;
          else airOmega -= Math.sign(airOmega) * delta;
        }
        wheel.omega = airOmega * (1 - 0.02 * dt); // bearing drag
        c.spin += wheel.omega * dt;
        continue;
      }

      grounded++;
      c.grounded = true;
      const dist = hit.timeOfImpact;
      const travel = dist - cfg.wheel.radius; // attach -> wheel centre
      const bottomed = travel < cfg.suspension.minLength;
      const len = clamp(travel, cfg.suspension.minLength, cfg.suspension.maxLength);
      const compression = cfg.suspension.restLength - len;
      const compressionRate = clamp(
        (compression - wheel.prevCompression) / dt,
        -cfg.suspension.maxDamperSpeed,
        cfg.suspension.maxDamperSpeed,
      );
      wheel.prevCompression = compression;

      if (compression > 0) {
        springForce =
          cfg.suspension.stiffness * compression + cfg.suspension.damping * compressionRate;
      }
      // Anti-roll bar: an extra spring across the axle, driven by the
      // difference in compression. It adds no total load, only roll stiffness -
      // this is what stops the car from snapping into oversteer at the limit.
      const axleArb = wheel.front ? cfg.suspension.arbFront : cfg.suspension.arbRear;
      if (axleArb > 0) {
        const otherComp = this._lastCompression[wheel.partner] || 0;
        springForce += axleArb * (compression - otherComp);
      }
      springForce = clamp(springForce, 0, cfg.suspension.maxForce);

      // The spring pushes on the chassis at the hub, so the four of them
      // produce this body's pitch and roll. Weight transfer is not a formula
      // here - it is the difference between four spring forces.
      body.applyImpulseAtPoint(
        { x: up.x * springForce * dt, y: up.y * springForce * dt, z: up.z * springForce * dt },
        attach,
        true,
      );

      const n = hit.normal;
      const contact = {
        x: attach.x + down.x * dist,
        y: attach.y + down.y * dist,
        z: attach.z + down.z * dist,
      };
      c.point = contact;
      c.normal = n;
      c.load = springForce;
      c.compression = compression;
      c.compressionRate = compressionRate;
      c.travel = len;
      c.bottomed = bottomed;
      c.center = {
        x: attach.x + down.x * len,
        y: attach.y + down.y * len,
        z: attach.z + down.z * len,
      };

      // tyre plane on the (possibly sloped) ground
      const fDotN = dot(wheelFwdRaw, n);
      let fPlane = {
        x: wheelFwdRaw.x - n.x * fDotN,
        y: wheelFwdRaw.y - n.y * fDotN,
        z: wheelFwdRaw.z - n.z * fDotN,
      };
      if (Math.hypot(fPlane.x, fPlane.y, fPlane.z) < 1e-4) fPlane = fwd;
      fPlane = norm(fPlane);
      const rPlane = norm(cross(fPlane, n)); // +X is the car's LEFT, so this is its right
      c.fwd = fPlane;
      c.right = rPlane;

      // velocity of the contact patch: v + w x r, about the real centre of
      // mass (the collider is offset 6 cm below the body origin), not the origin
      const rx = contact.x - com.x;
      const ry = contact.y - com.y;
      const rz = contact.z - com.z;
      const vc = {
        x: linvel.x + (angvel.y * rz - angvel.z * ry),
        y: linvel.y + (angvel.z * rx - angvel.x * rz),
        z: linvel.z + (angvel.x * ry - angvel.y * rx),
      };
      const vLong = dot(vc, fPlane);
      const vLat = dot(vc, rPlane);

      // ---- tyre model
      const mu = muAtLoad(tire, springForce);
      const limit = mu * springForce;

      // slip ratio at the start of the step, used to decide ABS release
      const kappaGuess = slipRatio(wheel.omega, cfg.wheel.radius, vLong);
      const alpha = slipAngle(vLong, vLat);

      // driven wheel torque for this wheel
      const axleSplit = wheel.front ? split.front : split.rear;
      const driveTorque = axleSplit > 0 ? (axleSplit * driveTorqueTotal) / 2 : 0;

      // ---- brakes (with a crude ABS so a modern road car stops straight)
      let brakeTorque = 0;
      if (brakePedal > 0.001) {
        brakeTorque = brakePedal * (wheel.front ? cfg.brakes.frontTorque : cfg.brakes.rearTorque);
      }
      if (!wheel.front && input.handbrake) {
        brakeTorque = Math.max(brakeTorque, cfg.brakes.handbrakeTorque);
      }
      if (cfg.brakes.abs && brakePedal > 0.05 && !(input.handbrake && !wheel.front)) {
        if (kappaGuess < cfg.brakes.absSlipThreshold) {
          wheel.absScale = Math.max(0, wheel.absScale - cfg.brakes.absReleaseRate * dt);
        } else {
          wheel.absScale = Math.min(1, wheel.absScale + cfg.brakes.absApplyRate * dt);
        }
        brakeTorque *= wheel.absScale;
      } else {
        wheel.absScale = Math.min(1, wheel.absScale + cfg.brakes.absApplyRate * dt);
      }
      c.brakeTorque = brakeTorque;

      // ---- wheel spin, solved implicitly.
      // The tyre is a very stiff spring between tread and rim: at 3500 N of
      // load the linearised slope is ~60 kN per unit slip ratio, which against
      // a 1.35 kg m^2 wheel is a 0.4 ms time constant. Integrated explicitly at
      // 1/120 s that loop diverges (a parked car would creep away on numerical
      // noise). Treating the longitudinal force as damping on the wheel and
      // solving for the end-of-step omega is stable for any stiffness and is
      // still just torque -> omega -> slip -> force.
      // Effective inertia at the wheel: the rim, plus the engine and gearbox
      // reflected through the gearing - but ONLY for wheels the engine is
      // actually coupled to, and shared between them. Putting the reflection on
      // an undriven front wheel makes it 14x too heavy in first gear.
      const drivenOnAxle = split.front > 0 && split.rear > 0 ? 4 : 2;
      const reflected = axleSplit > 0 ? (cfg.engine.inertia * drive.ratio * drive.ratio) / drivenOnAxle : 0;
      const I = cfg.wheel.inertia + reflected;
      const R = cfg.wheel.radius;
      // Jacobian of the tyre force with respect to tread slip speed, at the
      // current operating point. On the rising part of the curve it is huge
      // (real tyres are very stiff) and the implicit solve keeps the wheel
      // stable. Past the peak it goes NEGATIVE - grip falls as slip grows -
      // which in an implicit solve amplifies, so it is floored at a small
      // positive value. That floor is a numerical device, not physics: it makes
      // a first-gear wheelspin settle instead of escalating. Declared in the
      // README under simplifications.
      const denom = Math.max(Math.abs(vLong), 2.2);
      const bxk = tire.Bx * kappaGuess;
      const slope = (limit * tire.Cx * tire.Bx * Math.cos(tire.Cx * Math.atan(bxk))) / (1 + bxk * bxk) / denom;
      const floor = 0.02 * ((limit * tire.Cx * tire.Bx) / denom);
      const stiffness = clamp(Math.max(slope, floor), 60, 1e5);
      // Newton step on I dw/dt = T - R*Fx(w): linearise the tyre around the
      // current slip (F = F0 + k*ds), keep k >= 0 so a falling force curve can
      // never destabilise the solver, and solve for the end-of-step omega.
      const f0 = longitudinalForce(tire, kappaGuess, springForce, mu);
      const omega0 = wheel.omega;
      let omega =
        (I * omega0 + dt * (driveTorque - R * f0 + stiffness * R * R * omega0)) /
        (I + dt * stiffness * R * R);
      if (brakeTorque > 0) {
        const delta = (brakeTorque / I) * dt;
        if (Math.abs(omega) <= delta) omega = 0;
        else omega -= Math.sign(omega) * delta;
      }

      const kappa = slipRatio(omega, R, vLong);
      let fx = longitudinalForce(tire, kappa, springForce, mu);
      // spinning or locked: the tread is sliding, so the lateral force collapses
      let fy = lateralForce(tire, alpha, springForce, mu) * combinedSlipAttenuation(kappa);

      // Rolling resistance: the carcass deforms, so this is a real force at the
      // contact patch. It opposes motion and scales with load.
      const rollDir = clamp(vLong / 0.5, -1, 1);
      fx -= cfg.rollingResistance * springForce * rollDir;

      // ---- static friction: a contact patch that isn't sliding doesn't creep.
      // Force needed to bring the contact velocity to zero within this step,
      // limited by the same friction circle. Only valid while the patch really
      // is static - once the wheel is spinning or locked we are in kinetic
      // friction and the tyre model owns it.
      const contactSpeed = Math.hypot(vLong, vLat);
      const patchSlip = Math.abs(omega * R - vLong);
      const driverInput = Math.abs(drive.drivePedal) + Math.abs(drive.brakePedal);
      if (contactSpeed < 1.2 && driverInput < 0.02 && Math.abs(omega) < 1.5) {
        const mEff = (cfg.mass / 4) * 0.75;
        const staticLong = clamp((-vLong * mEff) / dt, -limit, limit);
        const staticLat = clamp((-vLat * mEff) / dt, -limit, limit);
        fx = staticLong;
        fy = staticLat;
        c.staticFriction = true;
      } else {
        c.staticFriction = false;
      }

      const applied = clampToFrictionCircle(fx, fy, limit);
      c.fx = applied.fx;
      c.fy = applied.fy;
      c.utilisation = applied.utilisation;
      c.slipRatio = kappa;
      c.slipAngle = alpha;
      c.driveTorque = driveTorque;

      // THE POINT OF THE WHOLE PROGRAM: the force is applied at the contact
      // patch, not at the centre of mass. The moment arm is the tyre's leverage
      // on the car: yaw, roll, pitch and trajectory all fall out of it.
      body.applyImpulseAtPoint(
        { x: applied.fx * dt * fPlane.x + applied.fy * dt * rPlane.x,
          y: applied.fx * dt * fPlane.y + applied.fy * dt * rPlane.y,
          z: applied.fx * dt * fPlane.z + applied.fy * dt * rPlane.z },
        contact,
        true,
      );

      wheel.omega = omega;
      c.spin += omega * dt;
    }

    for (let i = 0; i < this.wheels.length; i++) {
      this._lastCompression[i] = this.wheels[i].contact.compression;
    }

    // ---------------- aero: drag and downforce at the aero centre -------------
    const aero = cfg.aero;
    const v2 = dot(linvel, linvel);
    const qv = Math.sqrt(v2);
    if (qv > 0.05) {
      const dragMag = 0.5 * aero.airDensity * aero.dragArea * v2;
      const dir = { x: -linvel.x / qv, y: -linvel.y / qv, z: -linvel.z / qv };
      const liftMag = 0.5 * aero.airDensity * aero.liftArea * v2; // negative = down
      const aeroPoint = {
        x: com.x + up.x * aero.centreHeight,
        y: com.y + up.y * aero.centreHeight,
        z: com.z + up.z * aero.centreHeight,
      };
      body.applyImpulseAtPoint(
        {
          x: (dir.x * dragMag + up.x * liftMag) * dt,
          y: (dir.y * dragMag + up.y * liftMag) * dt,
          z: (dir.z * dragMag + up.z * liftMag) * dt,
        },
        aeroPoint,
        true,
      );
      this.telemetry.aeroDrag = dragMag;
    } else {
      this.telemetry.aeroDrag = 0;
    }

    // ---------------- telemetry (read-only) ----------------------------------
    const q2 = body.rotation();
    const fwd2 = qRot(q2, { x: 0, y: 0, z: 1 });
    const right2 = qRot(q2, { x: 1, y: 0, z: 0 });
    const up2 = qRot(q2, { x: 0, y: 1, z: 0 });
    const vNow = body.linvel();
    const WORLD_UP = { x: 0, y: 1, z: 0 };
    const accel = {
      x: (vNow.x - this._prevVel.x) / dt,
      y: (vNow.y - this._prevVel.y) / dt,
      z: (vNow.z - this._prevVel.z) / dt,
    };
    this._prevVel = { x: vNow.x, y: vNow.y, z: vNow.z };

    // body +X is the car's LEFT, so negate it to get "right" for the readouts
    const carRight = { x: -right2.x, y: -right2.y, z: -right2.z };
    this.telemetry.speed = dot(vNow, fwd2);
    this.telemetry.yawRate = body.angvel().y; // negative = turning right
    this.telemetry.longG = dot(accel, fwd2) / 9.81;
    this.telemetry.lateralG = dot(accel, carRight) / 9.81;
    this.telemetry.sideslip = Math.atan2(dot(vNow, carRight), Math.abs(dot(vNow, fwd2)) + 0.5);
    this.telemetry.rpm = drive.rpm;
    this.telemetry.gear = drive.gear;
    this.telemetry.shifting = drive.shifting;
    this.telemetry.airborne = grounded === 0;
    this.telemetry.groundedWheels = grounded;
    // roll: how far the body's up axis leans toward the car's right
    // (negative in a right-hand corner, where the car leans left/outward).
    // Measured with the body's right axis against world up, not against
    // another body axis - those are always orthogonal.
    this.telemetry.roll = -Math.asin(clamp(dot(carRight, WORLD_UP), -1, 1));
    this.telemetry.pitch = Math.asin(clamp(dot(fwd2, WORLD_UP), -1, 1));
    this.telemetry.steer = this.steer;
    this.telemetry.gearing = drive.ratio;
    this.telemetry.slipping = drive.slipping;
  }
}
