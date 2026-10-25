/**
 * The world: tarmac, a couple of ramps, walls, and things to hit.
 *
 * This module owns the Rapier world and the car. It has no rendering
 * dependency, so the exact same simulation runs headless in the node tests.
 * The scene builder mirrors the geometry defined here - one source of truth.
 */

import { SIM, VEHICLE } from '../config.js';
import { Vehicle } from './vehicle.js';

/**
 * Ramp profiles. Straight-sided wedges are the reason cars pitch over: the
 * crest is a point, so the front wheels leave it while the rear is still
 * climbing, and the rear springs then throw the car into a rotation.
 *
 *   hump   - sine dome. Concave down everywhere, so the crest is round AND the
 *            solid is convex: one convex-hull collider, matching the mesh.
 *   kicker - soft concave transition into a lip (a jump face). Not convex, so
 *            it is built from convex slices.
 */
export function rampProfile(kind, length, height, segments = 28) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Slope must start at ZERO at the foot, or the car meets a wall of angle
    // the instant the tyre touches it (the 0-to-17-degrees step).
    //
    //   hump   : parabola up to the crest at 2/3 of the length, then a STRAIGHT
    //            slanted face down. The crest at 2/3 is what makes the two
    //            slopes match (2h/(t_c L) = h/((1-t_c)L) -> t_c = 2/3), so the
    //            crest is not a kink either.
    //   kicker : t^2(2-t) -> zero slope at the foot, h/L at the lip.
    let shape;
    if (kind === 'kicker') {
      shape = t * t * (2 - t);
    } else {
      const crest = 2 / 3;
      shape = t <= crest ? (t / crest) ** 2 : (1 - t) / (1 - crest);
    }
    pts.push([t * length, height * shape]);
  }
  return pts;
}

/** Closed 2D outline (z, y) of a ramp, ready to extrude or hull. */
export function rampOutline(kind, length, height, segments) {
  const outline = rampProfile(kind, length, height, segments);
  if (kind === 'kicker') outline.push([length, 0]);
  return outline;
}

export const TRACK = {
  size: 420,
  skidpad: { x: 30, z: 55, radius: 17 },
  // Arena walls, shared by every scenario. [x, z, sizeX, sizeZ, yaw]
  walls: [
    [0, 200, 320, 1.2, 0],
    [0, -60, 320, 1.2, 0],
    [-155, 70, 1.2, 262, 0],
    [155, 70, 1.2, 262, 0],
  ],
};

/**
 * Test scenarios. The walls and ground are shared; each scenario swaps the
 * ramps and the props so you can change what you are testing.
 */
export const SCENARIOS = {
  playground: {
    label: 'playground',
    spawn: { x: 0, y: 0.68, z: 6, yaw: 0 },
    ramps: [
      { x: 0, z: 82, yaw: 0, length: 14, width: 5.0, height: 0.55 },
      { x: 20, z: 82, yaw: 0, length: 14, width: 5.0, height: 0.55 },
      { x: 0, z: 118, yaw: 0, length: 4, width: 12, height: 0.12 }, // speed bump
      { x: -34, z: 40, yaw: 0, length: 4, width: 12, height: 0.12 }, // speed bump
    ],
    props: [
    // slalom
    [-1.6, 26], [1.6, 32], [-1.6, 38], [1.6, 44], [-1.6, 50], [1.6, 56],
    // brake markers
    [-4, 8], [-6, 8], [-8, 8], [-10, 8],
    // skidpad ring
    [30 + 17 * Math.cos(0.0), 55 + 17 * Math.sin(0.0)],
    [30 + 17 * Math.cos(1.05), 55 + 17 * Math.sin(1.05)],
    [30 + 17 * Math.cos(2.1), 55 + 17 * Math.sin(2.1)],
    [30 + 17 * Math.cos(3.14), 55 + 17 * Math.sin(3.14)],
    [30 + 17 * Math.cos(4.19), 55 + 17 * Math.sin(4.19)],
    ],
  },

  // Speed bumps of increasing size, then a washboard: damper and ARB test.
  suspension: {
    label: 'suspension',
    spawn: { x: 0, y: 0.68, z: 10, yaw: 0 },
    ramps: [
      { x: 0, z: 24, yaw: 0, length: 4, width: 14, height: 0.05 },
      { x: 0, z: 38, yaw: 0, length: 4, width: 14, height: 0.09 },
      { x: 0, z: 52, yaw: 0, length: 4, width: 14, height: 0.13 },
      { x: 0, z: 66, yaw: 0, length: 4, width: 14, height: 0.18 },
      // washboard
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        x: 0, z: 86 + i * 2.4, yaw: 0, length: 1.4, width: 14, height: 0.06,
      })),
      // one-sided kerb: the left wheels only
      { x: -3.5, z: 120, yaw: 0, length: 16, width: 3.0, height: 0.12 },
    ],
    props: [],
  },

  // Kickers of increasing size with flat landings.
  jumps: {
    label: 'jumps',
    spawn: { x: 0, y: 0.68, z: 14, yaw: 0 },
    ramps: [
      { x: 0, z: 30, yaw: 0, length: 6, width: 6, height: 0.5, kind: 'kicker' },
      { x: 0, z: 60, yaw: 0, length: 7, width: 6, height: 0.9, kind: 'kicker' },
      { x: 0, z: 95, yaw: 0, length: 9, width: 6, height: 1.3, kind: 'kicker' },
      { x: 0, z: 135, yaw: 0, length: 12, width: 6, height: 1.7, kind: 'kicker' },
    ],
    props: [[-8, 45, 0.7], [8, 78, 0.7], [-8, 118, 0.7], [8, 160, 0.7]],
  },

  // Big open circle for steady-state cornering, plus a slalom.
  skidpad: {
    label: 'skidpad',
    spawn: { x: 30, y: 0.68, z: 74, yaw: 0 },
    ramps: [],
    props: [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
        const a = (i / 12) * Math.PI * 2;
        return [30 + 17 * Math.cos(a), 55 + 17 * Math.sin(a)];
      }),
      ...[-24, -20, -16, -12].map((x) => [x, 90]),
    ],
  },
};

export class Sim {
  constructor(RAPIER, cfg = VEHICLE, opts = {}) {
    this.RAPIER = RAPIER;
    this.cfg = cfg;
    this.world = new RAPIER.World({ x: 0, y: SIM.gravity, z: 0 });
    this.world.timestep = SIM.fixedStep;
    // A few more solver iterations for a car resting on four raycast springs.
    this.world.integrationParameters.numSolverIterations = 8;

    this.props = []; // { kind, body, size|radius|halfHeight }
    this.ramps = [];
    this.staticBoxes = [];

    this.scenarioBodies = [];
    this.scenario = opts.scenario || 'playground';

    this._buildGround();
    if (opts.track !== false) {
      this._buildWalls();
      this._buildScenario(this.scenario);
    }

    this.vehicle = new Vehicle(RAPIER, this.world, cfg);
    this.time = 0;
  }

  /** Tear down the current scenario and build another. */
  loadScenario(name = 'playground') {
    for (const body of this.scenarioBodies) this.world.removeRigidBody(body);
    this.scenarioBodies = [];
    this.ramps = [];
    this.props = [];
    this.scenario = name;
    this._buildScenario(name);
    if (this.vehicle) {
      const spawn = (SCENARIOS[name] || SCENARIOS.playground).spawn;
      this.vehicle.reset(spawn);
    }
    return this;
  }

  _buildScenario(name) {
    const sc = SCENARIOS[name] || SCENARIOS.playground;
    this._buildRamps(sc.ramps || []);
    this._buildProps(sc.props || []);
  }

  get scenarioInfo() {
    return (SCENARIOS[this.scenario] || SCENARIOS.playground);
  }

  _buildGround() {
    const { RAPIER, world } = this;
    const groundBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(1000, 1, 1000).setFriction(1.0).setRestitution(0.0),
      groundBody,
    );
    this.ground = groundBody;
  }

  _buildWalls() {
    const { RAPIER, world } = this;
    // walls are permanent, they are not part of a scenario
    for (const [x, z, sx, sz, yaw] of TRACK.walls) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(x, 0.45, z)
          .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(sx / 2, 0.45, sz / 2).setFriction(0.7).setRestitution(0.2),
        body,
      );
      this.staticBoxes.push({ x, y: 0.45, z, yaw, sx, sy: 0.9, sz });
    }
  }

  _buildRamps(ramps) {
    const { RAPIER, world } = this;
    for (const r of ramps) {
      const kind = r.kind || 'hump';
      const outline = rampOutline(kind, r.length, r.height, kind === 'hump' ? 20 : 24);
      const hw = r.width / 2;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(r.x, 0, r.z)
          .setRotation({ x: 0, y: Math.sin(r.yaw / 2), z: 0, w: Math.cos(r.yaw / 2) }),
      );

      // A curved ramp is not convex, and a convex hull of one flattens the feet
      // back into a straight face - exactly the 0-to-17-degrees step we are
      // trying to get rid of. So the collider is a stack of convex slices.
      for (let i = 0; i < outline.length - 1; i++) {
        const [z0, y0] = outline[i];
        const [z1, y1] = outline[i + 1];
        if (Math.abs(y1 - y0) < 1e-6 && y1 < 1e-6) continue; // skip flat tails
        const pts = new Float32Array([
          -hw, y0, z0, hw, y0, z0,
          -hw, y1, z1, hw, y1, z1,
          -hw, 0, z0, hw, 0, z0,
          -hw, 0, z1, hw, 0, z1,
        ]);
        const desc = RAPIER.ColliderDesc.convexHull(pts);
        if (desc) world.createCollider(desc.setFriction(0.9).setRestitution(0.05), body);
      }

      this.ramps.push({ ...r, kind, outline });
      this.scenarioBodies.push(body);
    }
  }

  /** props: [x, z] for a cone, [x, z, size] for a crate. */
  _buildProps(props) {
    const { RAPIER, world } = this;
    for (const entry of props) {
      const [x, z, size] = entry;
      if (size) {
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(x, size / 2 + 0.02, z)
            .setAngularDamping(0.3),
        );
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(size / 2, size / 2, size / 2)
            .setMass(22)
            .setFriction(0.7)
            .setRestitution(0.05),
          body,
        );
        this.props.push({ kind: 'crate', body, size });
        this.scenarioBodies.push(body);
      } else {
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.32, z).setAngularDamping(0.4),
        );
        world.createCollider(
          RAPIER.ColliderDesc.cone(0.32, 0.2).setMass(2.4).setFriction(0.85).setRestitution(0.1),
          body,
        );
        this.props.push({ kind: 'cone', body, radius: 0.2, halfHeight: 0.32 });
        this.scenarioBodies.push(body);
      }
    }
  }

  /** Advance one fixed step. `input` only ever reaches actuators. */
  step(input, dt = SIM.fixedStep) {
    this.vehicle.step(input, dt);
    this.world.step();
    this.time += dt;
  }

  reset() {
    const sc = this.scenarioInfo;
    this.vehicle.reset(sc.spawn || this.cfg.spawn);
    this.time = 0;
    // put the furniture back where the scenario put it
    let i = 0;
    for (const entry of sc.props || []) {
      const [x, z, size] = entry;
      const p = this.props[i++];
      if (!p) break;
      p.body.setTranslation({ x, y: size ? size / 2 + 0.02 : 0.32, z }, true);
      p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }
}
