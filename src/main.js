/**
 * Boot + render loop. This is the only file where three.js and Rapier meet.
 *
 * The camera, the HUD and the reset key are authored - they read state and are
 * allowed to. Nothing here writes a body transform except reset(), which is a
 * teleport and is labelled as one.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { SIM, VEHICLE } from './config.js';
import { Sim, SCENARIOS } from './physics/sim.js';
import { buildWorld } from './scene/track.js';
import { buildCarModel } from './scene/carModel.js';
import { ForceOverlay } from './scene/forces.js';
import { Hud } from './ui/hud.js';
import { CarAudio } from './ui/audio.js';

const BUILD = 'b46';

/** Yield long enough for the browser to actually paint what we have drawn. */
const nextFrame = () =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    // A backgrounded or occluded tab stops receiving frames, which would stall
    // the boot forever mid-stage. Time out instead and carry on.
    setTimeout(finish, 60);
  });

// ---- 1. renderer first, so the very first paint is the sky rather than a
// black page. Everything below is heavy (wasm decode, textures, a PMREM pass)
// and none of it can be seen if it all happens in one task.
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
renderer.setClearColor(0x9fc0e2, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.2, 1200);
camera.position.set(0, 4.2, -9);

renderer.render(scene, camera);
await nextFrame();

// ---- 2. physics
await RAPIER.init();
await nextFrame();
const sim = new Sim(RAPIER);

// ---- 3. track, rendered as soon as it exists
const world = buildWorld(scene, sim);
renderer.render(scene, camera);
await nextFrame();

// ---- 4. reflections: without an environment map every metalness=1 material
// (chrome rims, glass) renders black, which is why the wheels looked like holes
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(scene, 0.04).texture;
scene.environmentIntensity = 0.9;
pmrem.dispose();

// ---- 5. the car
const carModel = buildCarModel();
scene.add(carModel.root);
const forces = new ForceOverlay(scene);
const hud = new Hud();
const audio = new CarAudio();

// ------------------------------------------------------------------ controls
const keys = new Set();
const input = { throttle: 0, steer: 0, handbrake: false };
const state = { cameraMode: 0, paused: false };
const CAMERA_MODES = ['chase', 'hood', 'orbit'];

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  audio.start(); // browsers only allow audio after a gesture
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyM') audio.toggleMute();
  if (e.code === 'KeyR') resetCar();
  if (e.code === 'KeyC') state.cameraMode = (state.cameraMode + 1) % CAMERA_MODES.length;
  if (e.code === 'KeyF') forces.toggle();
  if (e.code === 'KeyT') sim.vehicle.tractionControl = !sim.vehicle.tractionControl;
  if (e.code === 'KeyG') cycleDriveMode();
  if (e.code === 'KeyB') cycleScenario();
  if (e.code === 'KeyP') state.paused = !state.paused;
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const orbit = { yaw: Math.PI, pitch: 0.35, dist: 9, dragging: false, lx: 0, ly: 0 };
canvas.addEventListener('pointerdown', (e) => {
  audio.start();
  orbit.dragging = true;
  orbit.lx = e.clientX;
  orbit.ly = e.clientY;
  if (state.cameraMode !== 2) state.cameraMode = 2;
});
window.addEventListener('pointerup', () => (orbit.dragging = false));
window.addEventListener('pointermove', (e) => {
  if (!orbit.dragging) return;
  orbit.yaw -= (e.clientX - orbit.lx) * 0.006;
  orbit.pitch = Math.max(0.02, Math.min(1.2, orbit.pitch + (e.clientY - orbit.ly) * 0.004));
  orbit.lx = e.clientX;
  orbit.ly = e.clientY;
});
window.addEventListener('wheel', (e) => {
  orbit.dist = Math.max(4, Math.min(30, orbit.dist + Math.sign(e.deltaY) * 0.8));
});

const DRIVE_MODES = ['rwd', 'awd', 'fwd'];

/** Cycle the drivetrain. The split is read from config every step, so this takes
 *  effect on the next physics tick - no rebuild. */
function cycleDriveMode() {
  const i = DRIVE_MODES.indexOf(VEHICLE.engine.drivetrain);
  VEHICLE.engine.drivetrain = DRIVE_MODES[(i + 1) % DRIVE_MODES.length];
  showDriveMode();
  toast(`drive · ${document.getElementById('drive-mode').textContent}`);
}

const SCENARIO_NAMES = Object.keys(SCENARIOS);

/** Swap the test map: ramps and props are rebuilt, the car goes back to spawn. */
function cycleScenario() {
  const i = (SCENARIO_NAMES.indexOf(sim.scenario) + 1) % SCENARIO_NAMES.length;
  sim.loadScenario(SCENARIO_NAMES[i]);
  world.rebuild();
  showScenario();
  toast(`map · ${sim.scenarioInfo.label}`);
}

let toastTimer = 0;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

function showScenario() {
  document.getElementById('scenario-value').textContent = sim.scenarioInfo.label;
}

function showDriveMode() {
  const mode = VEHICLE.engine.drivetrain;
  const split = VEHICLE.engine.awdFrontSplit;
  document.getElementById('drive-mode').textContent =
    mode === 'awd' ? `AWD ${Math.round(split * 100)}/${Math.round((1 - split) * 100)}` : mode.toUpperCase();
}

function resetCar() {
  sim.reset();
  world.skidmarks.clear();
}

function readGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (!pad) continue;
    const steer = pad.axes[0] || 0;
    const throttle = pad.buttons[7]?.value ?? 0;
    const brake = pad.buttons[6]?.value ?? 0;
    const handbrake = !!pad.buttons[0]?.pressed;
    // A plugged-in but untouched pad must not steal the keyboard: only claim
    // the input once it is actually being used.
    const touched =
      Math.abs(steer) > 0.05 ||
      throttle > 0.02 ||
      brake > 0.02 ||
      handbrake ||
      pad.buttons.some((b) => b.pressed);
    if (!touched) continue;
    gamepadSeen = true;
    return {
      throttle: throttle - brake,
      steer: Math.abs(steer) > 0.12 ? steer : 0,
      handbrake,
    };
  }
  return null;
}

let gamepadSeen = false;

function readInput() {
  const pad = readGamepad();
  const keysActive = keys.size > 0;
  if (pad && (gamepadSeen || !keysActive)) {
    input.throttle = pad.throttle;
    input.steer = pad.steer;
    input.handbrake = pad.handbrake;
    return input;
  }
  const forward = keys.has('KeyW') || keys.has('ArrowUp');
  const back = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');
  input.throttle = (forward ? 1 : 0) - (back ? 1 : 0);
  input.steer = (right ? 1 : 0) - (left ? 1 : 0);
  input.handbrake = keys.has('Space');
  return input;
}

// ------------------------------------------------------------------- camera
const camVec = new THREE.Vector3();
const lookVec = new THREE.Vector3();
const smoothPos = new THREE.Vector3(0, 4, -8);
const smoothLook = new THREE.Vector3(0, 1, 6);
const qTmp = new THREE.Quaternion();

function forwardOf(body) {
  const r = body.rotation();
  return new THREE.Vector3(0, 0, 1).applyQuaternion(qTmp.set(r.x, r.y, r.z, r.w));
}

function updateCamera(dt) {
  // debug hook: an explicit camera for screenshots/automated captures
  if (window.__cameraOverride) {
    const o = window.__cameraOverride;
    camera.position.set(o.pos[0], o.pos[1], o.pos[2]);
    camera.lookAt(o.target[0], o.target[1], o.target[2]);
    camera.fov = o.fov || 35;
    camera.updateProjectionMatrix();
    return;
  }
  const body = sim.vehicle.body;
  const t = body.translation();
  const fwd = forwardOf(body);
  const carPos = new THREE.Vector3(t.x, t.y, t.z);

  if (CAMERA_MODES[state.cameraMode] === 'chase') {
    camVec.copy(carPos).addScaledVector(fwd, -8.0).add(new THREE.Vector3(0, 3.1, 0));
    lookVec.copy(carPos).addScaledVector(fwd, 5.0).add(new THREE.Vector3(0, 0.9, 0));
  } else if (CAMERA_MODES[state.cameraMode] === 'hood') {
    camVec.copy(carPos).addScaledVector(fwd, 0.4).add(new THREE.Vector3(0, 0.62, 0));
    lookVec.copy(carPos).addScaledVector(fwd, 16).add(new THREE.Vector3(0, 0.8, 0));
  } else {
    const cy = Math.cos(orbit.pitch);
    camVec.set(
      carPos.x + Math.sin(orbit.yaw) * cy * orbit.dist,
      carPos.y + Math.sin(orbit.pitch) * orbit.dist,
      carPos.z + Math.cos(orbit.yaw) * cy * orbit.dist,
    );
    lookVec.copy(carPos).add(new THREE.Vector3(0, 0.4, 0));
  }

  const k = CAMERA_MODES[state.cameraMode] === 'orbit' ? 1 : 1 - Math.exp(-dt * 7);
  smoothPos.lerp(camVec, k);
  smoothLook.lerp(lookVec, CAMERA_MODES[state.cameraMode] === 'orbit' ? 1 : 1 - Math.exp(-dt * 10));
  camera.position.copy(smoothPos);
  camera.lookAt(smoothLook);
}

// --------------------------------------------------------------------- sync

function syncCar() {
  const car = sim.vehicle;
  const t = car.body.translation();
  const r = car.body.rotation();
  carModel.root.position.set(t.x, t.y, t.z);
  carModel.root.quaternion.set(r.x, r.y, r.z, r.w);

  car.wheels.forEach((w, i) => {
    const model = carModel.wheels[i];
    const c = w.contact;
    // Body-frame position, straight from the suspension travel. Do NOT use
    // contact.center here: that is computed before world.step(), so the wheels
    // would be drawn one physics step behind the body - at 80 km/h that is 20 cm
    // backwards, and it grows with speed.
    model.group.position.set(w.x, -c.travel, w.z);
    // Wheels are rigidly mounted to the body (plus steering), like the real
    // upright. Forcing them to stay world-upright needed a yaw extraction that
    // goes degenerate the moment the car rolls far enough, which flung them to
    // random angles. The half-shafts are what show the suspension travel.
    model.group.rotation.set(0, w.front ? -car.steer : 0, 0);
    model.spin.rotation.x = c.spin;
  });

  // Half-shafts run from the diff to each wheel centre, so they follow the
  // suspension and show body roll: one shaft angles up as the other angles down.
  const axleY = carModel.axleY;
  carModel.axles.forEach((axle, ai) => {
    axle.shafts.forEach((shaft, side) => {
      const w = car.wheels[ai * 2 + side];
      const sign = side === 0 ? 1 : -1;
      const x0 = sign * carModel.axleStartX; // out of the diff housing
      const x1 = sign * carModel.axleEndX; // into the back of the wheel
      const y1 = -w.contact.travel;
      shaft.position.set((x0 + x1) / 2, (axleY + y1) / 2, axle.z);
      shaft.scale.x = Math.hypot(x1 - x0, y1 - axleY);
      shaft.rotation.z = Math.atan2(y1 - axleY, x1 - x0);
    });
  });
}

// --------------------------------------------------------------------- loop
const step = SIM.fixedStep;
let accumulated = 0;
let last = performance.now() / 1000;

const MIN_FRAME = 1 / 130; // don't render faster than this, there is nothing to see

function frame(nowMs) {
  requestAnimationFrame(frame);
  const now = nowMs / 1000;
  const dt = Math.min(0.1, now - last);
  if (dt < MIN_FRAME) return; // leave `last` alone so the time is not lost
  last = now;

  const currentInput = readInput();

  if (!state.paused) {
    accumulated += dt;
    let n = 0;
    while (accumulated >= step && n < SIM.maxSubSteps) {
      sim.step(currentInput, step);
      accumulated -= step;
      n++;
    }
    if (n === SIM.maxSubSteps) accumulated = 0;
  }

  syncCar();
  world.update(sim.vehicle);
  forces.update(sim.vehicle);
  updateCamera(dt);
  hud.update(sim, currentInput);
  audio.update(sim.vehicle, currentInput);
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

showDriveMode();
showScenario();
document.getElementById('build-value').textContent = BUILD;
requestAnimationFrame((t) => {
  last = t / 1000;
  requestAnimationFrame(frame);
});

// exposed for the console and for automated checks
window.__sim = { sim, scene, camera, renderer, state, forces, orbit, audio };
