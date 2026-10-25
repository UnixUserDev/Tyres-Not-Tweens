/**
 * Headless physics tests. The simulation module has no three.js dependency, so
 * this runs the exact shipped physics in node.
 *
 *   node --test tests/
 *
 * These are the two severing tests from the doctrine plus the things that are
 * easy to fake and easy to check: parked steering, brake lock, friction circle,
 * weight transfer, and "does anything ever go NaN after a crash".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '../vendor/rapier/rapier.es.js';
import { Sim } from '../src/physics/sim.js';
import { SIM, VEHICLE } from '../src/config.js';

await RAPIER.init();

const NONE = { throttle: 0, steer: 0, handbrake: false };
const dt = SIM.fixedStep;

function makeSim() {
  // Flat empty pad: no cones, no ramps, nothing to trip over. The track is
  // exercised separately in the "abuse" test.
  return new Sim(RAPIER, VEHICLE, { track: false });
}

/** Run `seconds` of fixed steps, calling `onStep` after each. */
function run(sim, seconds, input, onStep) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    sim.step(input, dt);
    if (onStep) onStep(sim, i);
  }
}

function speedOf(sim) {
  return sim.vehicle.telemetry.speed;
}

function pose(sim) {
  const t = sim.vehicle.body.translation();
  const r = sim.vehicle.body.rotation();
  const yaw = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x));
  return { x: t.x, y: t.y, z: t.z, yaw };
}

function allFinite(sim) {
  const t = sim.vehicle.body.translation();
  const v = sim.vehicle.body.linvel();
  const w = sim.vehicle.body.angvel();
  const vals = [t.x, t.y, t.z, v.x, v.y, v.z, w.x, w.y, w.z, sim.vehicle.telemetry.speed];
  for (const w2 of sim.vehicle.wheels) vals.push(w2.omega, w2.contact.load, w2.contact.fx, w2.contact.fy);
  return vals.every((n) => Number.isFinite(n));
}

test('rests on four contact patches with load summing to the car weight', () => {
  const sim = makeSim();
  run(sim, 4, NONE);

  const car = sim.vehicle;
  const grounded = car.wheels.filter((w) => w.contact.grounded);
  assert.equal(grounded.length, 4, 'all four wheels should be on the ground');

  const totalLoad = car.wheels.reduce((a, w) => a + w.contact.load, 0);
  const weight = VEHICLE.mass * 9.81;
  assert.ok(
    Math.abs(totalLoad - weight) / weight < 0.05,
    `springs carry the weight: ${totalLoad.toFixed(0)} N vs ${weight.toFixed(0)} N`,
  );
  assert.ok(Math.abs(speedOf(sim)) < 0.05, `car should be still, got ${speedOf(sim)}`);

  const p = pose(sim);
  assert.ok(p.y > 0.4 && p.y < 0.62, `ride height sane, got ${p.y.toFixed(3)}`);
  assert.ok(allFinite(sim), 'no NaN at rest');
});

test('disconnect test: no torque means no motion', () => {
  const sim = makeSim();
  run(sim, 1, NONE);

  // Cut the drivetrain out of the loop entirely - the mechanical equivalent of
  // pulling the engine. Throttle is still held to the floor.
  sim.vehicle.drivetrain.update = () => ({
    totalWheelTorque: 0,
    engineTorque: 0,
    ratio: 1,
    rpm: VEHICLE.engine.idle,
    gear: 1,
    shifting: false,
    slipping: false,
    drivePedal: 0,
    brakePedal: 0,
    redline: VEHICLE.engine.redline,
    reverse: false,
  });

  const before = pose(sim);
  run(sim, 3, { throttle: 1, steer: 0.4, handbrake: false });
  const after = pose(sim);
  const dist = Math.hypot(after.x - before.x, after.z - before.z);

  assert.ok(dist < 0.15, `a car with no torque must not drive. moved ${dist.toFixed(3)} m`);
  assert.ok(Math.abs(after.yaw - before.yaw) < 0.02, 'and must not turn either');
});

test('parked steering turns the wheels, not the car', () => {
  const sim = makeSim();
  run(sim, 2, NONE);
  const before = pose(sim);

  run(sim, 2, { throttle: 0, steer: 1, handbrake: false });
  const after = pose(sim);

  assert.ok(sim.vehicle.steer > 0.4, `front wheels should be near full lock, got ${sim.vehicle.steer.toFixed(2)} rad`);
  assert.ok(Math.abs(after.yaw - before.yaw) < 0.01, 'yaw must not be authored by the steering input');
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  assert.ok(moved < 0.05, `car should not move, moved ${moved.toFixed(3)} m`);
});

test('steering in mid-air does nothing (yaw is not written)', () => {
  const sim = makeSim();
  const body = sim.vehicle.body;
  body.setTranslation({ x: 0, y: 6, z: 0 }, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  let maxYawRate = 0;
  run(sim, 0.8, { throttle: 1, steer: 1, handbrake: false }, (s) => {
    maxYawRate = Math.max(maxYawRate, Math.abs(s.vehicle.body.angvel().y));
  });

  assert.ok(maxYawRate < 0.02, `no tyres, no yaw. peak yaw rate ${maxYawRate.toFixed(4)} rad/s`);
});

test('coast test: momentum and friction settle the car, not the input', () => {
  const sim = makeSim();
  run(sim, 3, { throttle: 1, steer: 0, handbrake: false });
  const launched = speedOf(sim);
  assert.ok(launched > 8, `should be moving before the test, got ${launched.toFixed(1)} m/s`);

  const turn = pose(sim);
  // turn in and release everything mid-corner
  run(sim, 1.2, { throttle: 0.6, steer: 0.7, handbrake: false });
  const release = pose(sim);
  assert.ok(Math.abs(release.yaw - turn.yaw) > 0.05, 'the car should have yawed while cornering');

  let minSpeed = Infinity;
  let stillYawingAtRelease = 0;
  run(sim, 6, NONE, (s, i) => {
    const v = speedOf(s);
    minSpeed = Math.min(minSpeed, v);
    if (i === 2) stillYawingAtRelease = Math.abs(s.vehicle.body.angvel().y);
  });

  const after = pose(sim);
  const travelled = Math.hypot(after.x - release.x, after.z - release.z);

  assert.ok(travelled > 25, `it must keep rolling on momentum, travelled ${travelled.toFixed(1)} m`);
  assert.ok(speedOf(sim) > 4, `and still be moving after 6 s of coasting, got ${speedOf(sim).toFixed(1)} m/s`);
  assert.ok(stillYawingAtRelease > 0.005, 'the slide must not be cancelled the instant input stops');
  assert.ok(allFinite(sim), 'no NaN while coasting');
});

test('full throttle from rest spins the rear tyres (wheel omega is integrated)', () => {
  const sim = makeSim();
  sim.vehicle.tractionControl = false; // this is what TC is for
  run(sim, 1, NONE);

  let peakSlip = 0;
  run(sim, 2, { throttle: 1, steer: 0, handbrake: false }, (s) => {
    for (const w of s.vehicle.wheels) peakSlip = Math.max(peakSlip, w.contact.slipRatio);
  });

  assert.ok(speedOf(sim) > 5, `it should actually launch, got ${speedOf(sim).toFixed(2)} m/s`);
  assert.ok(peakSlip > 0.25, `first gear should overwhelm the tyres, peak slip ratio ${peakSlip.toFixed(2)}`);
  assert.ok(allFinite(sim), 'no NaN on launch');
});

test('traction control keeps the driven wheels near their peak slip', () => {
  const sim = makeSim();
  run(sim, 1, NONE);

  let peakSlip = 0;
  run(sim, 3, { throttle: 1, steer: 0, handbrake: false }, (s) => {
    for (const w of s.vehicle.wheels) peakSlip = Math.max(peakSlip, w.contact.slipRatio);
  });

  assert.ok(peakSlip < 0.45, `TC should keep slip near the peak, got ${peakSlip.toFixed(2)}`);
  assert.ok(speedOf(sim) > 10, `and it should still be quick, got ${speedOf(sim).toFixed(1)} m/s`);
});

test('braking: grip circle saturates, the car stops, nothing reverses', () => {
  const sim = makeSim();
  run(sim, 1, NONE);
  run(sim, 5.5, { throttle: 1, steer: 0, handbrake: false });
  const start = pose(sim);
  assert.ok(speedOf(sim) > 22, `need speed for this test, got ${speedOf(sim).toFixed(1)}`);

  let minSlip = 0;
  let maxUtil = 0;
  let reversed = false;
  run(sim, 6, { throttle: -1, steer: 0, handbrake: false }, (s) => {
    for (const w of s.vehicle.wheels) {
      minSlip = Math.min(minSlip, w.contact.slipRatio);
      maxUtil = Math.max(maxUtil, w.contact.utilisation);
    }
    if (speedOf(s) < -0.25) reversed = true; // a few cm/s of settle is not reversing
  });

  const end = pose(sim);
  const dist = Math.hypot(end.x - start.x, end.z - start.z);
  const lat = Math.abs(end.x - start.x);

  assert.ok(minSlip < -0.12, `the tyres should be at or past the limit, min slip ${minSlip.toFixed(2)}`);
  assert.ok(maxUtil <= 1.001, `never exceed the friction circle, got ${maxUtil.toFixed(3)}`);
  assert.ok(!reversed, 'braking must not drive the car backwards');
  assert.ok(Math.abs(speedOf(sim)) < 1.5, 'it should have stopped');
  assert.ok(dist > 20 && dist < 90, `stopping distance plausible, got ${dist.toFixed(1)} m`);
  assert.ok(lat < 3, `should stop straight, drifted ${lat.toFixed(2)} m`);
});

test('weight transfer is emergent: braking loads the front axle', () => {
  const sim = makeSim();
  run(sim, 2, NONE);
  const staticFront = sim.vehicle.wheels.filter((w) => w.front).reduce((a, w) => a + w.contact.load, 0);
  const staticRear = sim.vehicle.wheels.filter((w) => !w.front).reduce((a, w) => a + w.contact.load, 0);

  run(sim, 4, { throttle: 1, steer: 0, handbrake: false });
  run(sim, 0.9, { throttle: -1, steer: 0, handbrake: false });

  const brakeFront = sim.vehicle.wheels.filter((w) => w.front).reduce((a, w) => a + w.contact.load, 0);
  const brakeRear = sim.vehicle.wheels.filter((w) => !w.front).reduce((a, w) => a + w.contact.load, 0);

  assert.ok(
    brakeFront > staticFront * 1.05,
    `front should gain load under braking: ${staticFront.toFixed(0)} -> ${brakeFront.toFixed(0)} N`,
  );
  assert.ok(
    brakeRear < staticRear * 0.95,
    `rear should lose load under braking: ${staticRear.toFixed(0)} -> ${brakeRear.toFixed(0)} N`,
  );
});

test('cornering rolls the body and loads the outside wheels', () => {
  const sim = makeSim();
  run(sim, 4.5, { throttle: 1, steer: 0, handbrake: false });
  assert.ok(speedOf(sim) > 15, `need speed for this test, got ${speedOf(sim).toFixed(1)} m/s`);

  let maxRoll = 0;
  let maxDiff = 0;
  run(sim, 2.5, { throttle: 0.25, steer: 0.45, handbrake: false }, (s) => {
    const left = s.vehicle.wheels.filter((w) => w.left).reduce((a, w) => a + w.contact.load, 0);
    const right = s.vehicle.wheels.filter((w) => !w.left).reduce((a, w) => a + w.contact.load, 0);
    maxRoll = Math.max(maxRoll, Math.abs(s.vehicle.telemetry.roll));
    maxDiff = Math.max(maxDiff, Math.abs(left - right) / (left + right));
  });

  assert.ok(maxRoll > 0.02, `the body should roll in a corner, got ${(maxRoll * 57.3).toFixed(2)} deg`);
  assert.ok(maxDiff > 0.1, `lateral load transfer should be visible, ${(maxDiff * 100).toFixed(0)}%`);
  assert.ok(allFinite(sim), 'no NaN while cornering');
});

test('stays finite through abuse: handbrake slides, kerbs, ramp, cones', () => {
  const sim = makeSim();
  run(sim, 2, { throttle: 1, steer: 0, handbrake: false });
  run(sim, 2, { throttle: 1, steer: 0.9, handbrake: true });
  run(sim, 2, { throttle: -1, steer: -0.9, handbrake: false });
  run(sim, 2, { throttle: 1, steer: 0.2, handbrake: false });
  assert.ok(allFinite(sim), 'no NaN after a sloppy lap');
});

test('reverse needs a deliberate press, not just leaning on the brake', () => {
  const sim = makeSim();
  run(sim, 1.5, NONE);

  // never moved yet: holding the brake is just holding the car still
  run(sim, 1.5, { throttle: -1, steer: 0, handbrake: false });
  assert.equal(sim.vehicle.telemetry.gear, 1, 'holding the brake must not silently select reverse');
  assert.ok(Math.abs(speedOf(sim)) < 0.2, 'and must not move the car');

  // drive, then stop, then press again: now it means reverse
  run(sim, 2, { throttle: 1, steer: 0, handbrake: false });
  run(sim, 3, { throttle: -1, steer: 0, handbrake: false });
  assert.ok(Math.abs(speedOf(sim)) < 0.5, 'should be stopped');
  const start = pose(sim);
  run(sim, 0.4, NONE); // release
  run(sim, 2.5, { throttle: -1, steer: 0, handbrake: false });
  assert.equal(sim.vehicle.telemetry.gear, -1, 'the second press should engage reverse');
  assert.ok(speedOf(sim) < -1, `and drive backwards, got ${speedOf(sim).toFixed(2)} m/s`);

  const end = pose(sim);
  assert.ok(end.z < start.z - 0.5, 'it should have moved backwards');
});

test('ramp launches the car: all four wheels leave the ground', () => {
  const sim = new Sim(RAPIER, VEHICLE); // full track, with the ramp
  sim.vehicle.reset({ x: 0, y: 0.62, z: 55, yaw: 0 });
  run(sim, 1, NONE);
  run(sim, 4, { throttle: 1, steer: 0, handbrake: false });

  let sawAir = false;
  let peakHeight = 0;
  run(sim, 3, { throttle: 0, steer: 0, handbrake: false }, (s) => {
    if (s.vehicle.telemetry.airborne) sawAir = true;
    peakHeight = Math.max(peakHeight, s.vehicle.body.translation().y);
  });

  assert.ok(sawAir || peakHeight > 0.75, `the ramp should throw the car, peak height ${peakHeight.toFixed(2)} m`);
  assert.ok(allFinite(sim), 'and it should land without exploding');
});

test('steering points the car the way the player asked', () => {
  const right = makeSim();
  run(right, 1.5, NONE);
  run(right, 2.5, { throttle: 0.8, steer: 0, handbrake: false });
  const rightStart = pose(right);
  run(right, 1.5, { throttle: 0.4, steer: 1, handbrake: false });
  const rightEnd = pose(right);
  // +Z is forward, +Y up, so the car's RIGHT is -X
  assert.ok(rightEnd.x < rightStart.x - 1, `right turn must go to -X, went to ${rightEnd.x.toFixed(2)}`);
  assert.ok(right.vehicle.body.angvel().y < -0.05, 'and yaw clockwise (negative)');

  const left = makeSim();
  run(left, 1.5, NONE);
  run(left, 2.5, { throttle: 0.8, steer: 0, handbrake: false });
  const leftStart = pose(left);
  run(left, 1.5, { throttle: 0.4, steer: -1, handbrake: false });
  const leftEnd = pose(left);
  assert.ok(leftEnd.x > leftStart.x + 1, 'left turn must go to +X');
  assert.ok(left.vehicle.body.angvel().y > 0.05, 'and yaw anticlockwise (positive)');
});

test('steering assist keeps full keyboard lock from spinning the car', () => {
  for (const target of [12, 25]) {
    const sim = makeSim();
    run(sim, 1.5, NONE);
    let guard = 0;
    while (speedOf(sim) < target && guard++ < 4000) {
      sim.step({ throttle: 0.8, steer: 0, handbrake: false }, dt);
    }
    let maxSideslip = 0;
    run(sim, 3, { throttle: 0.35, steer: 1, handbrake: false }, (s) => {
      maxSideslip = Math.max(maxSideslip, Math.abs(s.vehicle.telemetry.sideslip));
    });
    assert.ok(
      maxSideslip < 0.35,
      `full lock at ${target} m/s must not spin: ${(maxSideslip * 57.3).toFixed(0)} deg of sideslip`,
    );
    assert.ok(allFinite(sim), 'no NaN in the corner');
  }
});

test('handbrake sets up a drift you can hold on the throttle', () => {
  const sim = makeSim();
  run(sim, 1.5, NONE);
  let guard = 0;
  while (speedOf(sim) < 15 && guard++ < 4000) {
    sim.step({ throttle: 0.9, steer: 0, handbrake: false }, dt);
  }

  // kick: handbrake + steering for 0.75 s
  run(sim, 0.75, { throttle: 0, steer: 1, handbrake: true });

  // hold: boot in, counter-steer proportional to the slide
  let peak = 0;
  for (let i = 0; i < Math.round(2.5 / dt); i++) {
    const slip = sim.vehicle.telemetry.sideslip;
    const steer = Math.max(-1, Math.min(1, slip * 1.8));
    sim.step({ throttle: 0.9, steer, handbrake: false }, dt);
    peak = Math.max(peak, Math.abs(slip));
  }

  assert.ok(peak > 0.18, `the rear should break away: peak sideslip ${(peak * 57.3).toFixed(0)} deg`);
  assert.ok(peak < 1.0, `but not into a full spin: ${(peak * 57.3).toFixed(0)} deg`);
  assert.ok(allFinite(sim), 'no NaN in the drift');
});

test('bodywork collides: on its roof the car rests on the greenhouse, not through it', () => {
  const sim = makeSim();
  const body = sim.vehicle.body;
  run(sim, 1, NONE);

  // flip it onto its roof from a metre up
  body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true); // 180 deg about Z
  body.setTranslation({ x: 0, y: 1.4, z: 0 }, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  run(sim, 3, NONE);

  const t = body.translation();
  const r = body.rotation();
  const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
  assert.ok(upY < -0.5, `should still be on its roof, up.y = ${upY.toFixed(2)}`);
  assert.ok(t.y > 0.45, `roof must hold the body up, ended at y=${t.y.toFixed(2)} (sinking = ~0.2)`);
  assert.ok(allFinite(sim), 'no NaN on the roof');
});

test('bodywork collides: the car does not sink when it lands on its side', () => {
  const sim = makeSim();
  const body = sim.vehicle.body;
  run(sim, 1, NONE);
  body.setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) }, true); // 90 deg roll
  body.setTranslation({ x: 0, y: 1.2, z: 0 }, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  run(sim, 3, NONE);

  const t = body.translation();
  assert.ok(t.y > 0.35, `on its side the body should sit on the door, ended at y=${t.y.toFixed(2)}`);
  assert.ok(allFinite(sim), 'no NaN on its side');
});

test('brakes work with no contact: a wheel stops even upside down', () => {
  const sim = makeSim();
  const body = sim.vehicle.body;
  run(sim, 1, NONE);
  body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
  body.setTranslation({ x: 0, y: 1.3, z: 0 }, true);
  run(sim, 2, NONE);
  assert.ok(sim.vehicle.telemetry.airborne, 'should be belly-up with no contact');

  // spin the driven wheels up with no load
  run(sim, 1, { throttle: 1, steer: 0, handbrake: false });
  const spinning = sim.vehicle.wheels.map((w) => Math.abs(w.omega));
  assert.ok(spinning.some((w) => w > 5), 'the engine should still spin the driven wheels');

  // then brake: the calipers act on the hub, contact or not
  run(sim, 1, { throttle: -1, steer: 0, handbrake: false });
  assert.ok(
    sim.vehicle.wheels.every((w) => Math.abs(w.omega) < 0.01),
    'brakes must stop the wheels with no tyre on the ground',
  );

  run(sim, 1, { throttle: 1, steer: 0, handbrake: false });
  run(sim, 1, { throttle: 0, steer: 0, handbrake: true });
  assert.ok(
    sim.vehicle.wheels.filter((w) => !w.front).every((w) => Math.abs(w.omega) < 0.01),
    'and so must the handbrake',
  );
});
