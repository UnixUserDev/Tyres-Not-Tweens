/**
 * Every tunable in the simulation, in SI units.
 *
 * Nothing in this file may be read by the physics code as "where the car
 * should be". These are hardware numbers: mass, stiffness, gear ratios,
 * rubber. Where the car goes is decided by the integration.
 */

export const VEHICLE = {
  mass: 1400, // kg, with driver
  // Principal inertia about the body axes (x = right, y = up, z = forward).
  // Roll is deliberately low: real cars are ~500-700, a box would give ~360.
  inertia: { x: 2000, y: 2300, z: 600 },

  chassis: {
    // Collision half-extents. The collider is offset down so the visual body
    // can sink under the CoM without touching the tarmac at rest.
    half: { x: 0.92, y: 0.26, z: 1.95 },
    offset: { x: 0, y: -0.06, z: 0 },
    clearance: 0.2, // m from ground to the bottom of the collider at rest
  },

  wheel: {
    radius: 0.33,
    width: 0.24,
    inertia: 1.35, // kg m^2, wheel + brake disc + half shaft
    track: 1.6,
    wheelbase: 2.62,
  },

  // Raycast suspension. Ray starts at the hub attach point, straight down the
  // chassis axis, max length maxLength + wheelRadius.
  suspension: {
    restLength: 0.32, // m from attach to wheel centre when unloaded
    // Travel is deliberately short: 6.5 cm of bump and 6.5 cm of droop around
    // the static position. With 22 cm of travel the wheels visibly dropped out
    // of their arches in corners, which looks like the suspension fell apart.
    minLength: 0.185, // bump stop
    maxLength: 0.315, // full droop
    stiffness: 49000, // N/m  (wheel rate ~49 N/mm)
    damping: 3300, // N s/m (~0.4 critical for a 350 kg corner)
    maxForce: 42000, // N, bump-stop ceiling
    maxDamperSpeed: 6, // m/s shaft speed ceiling - stops ramps becoming a slam
    // Front anti-roll bar: roll stiffness without changing ride height. Kept on
    // the front axle only, like most road cars, so the car is stable at the
    // limit instead of snapping into power oversteer.
    arbFront: 11000, // N/m of compression difference
    arbRear: 2500,
  },

  steering: {
    maxAngle: 0.58, // rad of rack at standstill (33 deg)
    // Speed-sensitive lock, computed from the grip-limited cornering radius
    // rather than a linear falloff: at 20 m/s you get the lock the tyres can
    // actually use, which is what keeps a keyboard from putting the car into a
    // spin every time you tap "right".
    assist: {
      enabled: true,
      gripMultiplier: 1.5, // how far past the grip limit the lock allows
      minAngle: 0.02, // never fully dead
      rateFalloffSpeed: 26, // rack slows down with speed
      minRateFactor: 0.35,
    },
    rate: 3.4, // rad/s the rack can move toward the target
    returnRate: 5.6, // rad/s back to centre
  },

  engine: {
    // [rpm, Nm] - naturally aspirated 3.5 V6-ish
    curve: [
      [800, 220],
      [1500, 300],
      [2500, 360],
      [3500, 395],
      [4500, 400],
      [5500, 375],
      [6300, 330],
      [7000, 260],
      [7400, 90],
    ],
    idle: 850,
    redline: 7300,
    limiter: 7450,
    inertia: 0.22, // kg m^2, flywheel + crank
    frictionTorque: 22, // Nm engine braking at zero throttle
    gears: [3.42, 2.11, 1.53, 1.2, 0.98, 0.82],
    reverse: 3.1,
    finalDrive: 3.73,
    efficiency: 0.92,
    drivetrain: 'rwd', // 'rwd' | 'awd' | 'fwd'
    awdFrontSplit: 0.4,
    shiftUpRpm: 6400,
    shiftDownRpm: 2100,
    shiftTime: 0.16,
    clutchEngageRpm: 1100,
  },

  brakes: {
    frontTorque: 3200, // Nm per wheel at full pedal (locks well above grip)
    rearTorque: 1800,
    handbrakeTorque: 2600, // Nm on each rear wheel, locks it
    abs: true,
    absSlipThreshold: -0.22, // release below this slip ratio
    absReleaseRate: 14, // 1/s
    absApplyRate: 6,
  },

  tractionControl: {
    // A real modern car has one, so this one does too. It is an actuator: it
    // trims the drive torque, never the wheels' speed. Turn it off (T) if you
    // want to find out what the tyres can actually take.
    enabled: true,
    slipTarget: 0.12,
    cutRate: 5, // 1/s of torque trim
    recoverRate: 2.5,
  },

  aero: {
    dragArea: 0.68, // Cd * A, m^2
    liftArea: -0.55, // negative = downforce, m^2
    airDensity: 1.225,
    centreHeight: 0.22, // above the CoM, gives a small pitch moment
  },

  rollingResistance: 0.014, // coefficient, applied at each contact patch

  spawn: { x: 0, y: 0.68, z: 6, yaw: 0 },

  // Tyre model lives in tire.js; kept here so the HUD can read the numbers.
  tire: {
    mu: 1.02,
    loadSensitivity: 0.16, // mu falls as load rises - the reason weight transfer matters
    nominalLoad: 3500, // N per corner
    Bx: 11,
    Cx: 1.65,
    By: 6.5,
    Cy: 1.75,
  },
};

/** Wheel layout in body coordinates: x right, z forward, y at the CoM plane. */
// Frame: +Z is forward, +Y is up, so this right-handed frame puts the car's
// RIGHT-hand side at -X and its left at +X. (Same reason the chase camera sits
// at -Z: looking along +Z, -X ends up on the right of the screen.)
export const WHEELS = [
  { id: 'FL', x: 0.8, z: 1.31, front: true, left: true },
  { id: 'FR', x: -0.8, z: 1.31, front: true, left: false },
  { id: 'RL', x: 0.8, z: -1.31, front: false, left: true },
  { id: 'RR', x: -0.8, z: -1.31, front: false, left: false },
];

export const SIM = {
  fixedStep: 1 / 120,
  maxSubSteps: 6,
  gravity: -9.81,
};
