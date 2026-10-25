# AGENTS.md — working in this repo

A vehicle simulation where the car is moved by tyre forces at the contact patch.
three.js draws, Rapier integrates. ~1,700 lines of source, 19 headless tests,
no build step.

If you are an agent asked to change something here, read this file first. It is
the difference between a 10-minute change and three rounds of "the wheels look
weird".

## The law

**Input may only reach an actuator.** Steering joint angle, wheel torque, brake
torque. Never write body state:

- no `body.setTranslation/setRotation/setLinvel/setAngvel` outside `reset()`
- no `transform.rotation.y +=`, no `angularVelocity = up * yawRate`
- no `velocity = inputDir * speed`, no speed clamps

If you catch yourself "fixing" a car that won't turn by adding yaw, the real bug
is that the force was applied at the centre of mass. Move it to the contact
patch and yaw appears for free.

## The two tests that gate every change

```bash
npm test     # 19 tests, ~1s
```

- **disconnect** — zero engine torque must produce zero motion.
- **coast** — release everything mid-corner; momentum carries it, friction
  settles it, it does not snap straight.

If either fails, input is reaching the body somewhere. Fix that, do not adjust
the test.

## Files

| file | what lives there |
|---|---|
| `src/config.js` | every tunable, SI units. Mass, inertia, springs, gears, tyre coefficients |
| `src/physics/tire.js` | slip ratio/angle, magic-formula curves, friction circle, combined-slip attenuation |
| `src/physics/drivetrain.js` | engine curve, clutch, gearbox, reverse latching, traction control trim |
| `src/physics/vehicle.js` | the car: raycast suspension, contact-patch impulses, implicit wheel solve, per-wheel telemetry |
| `src/physics/sim.js` | Rapier world, ground, walls, ramp profiles, scenario data, cones/crates |
| `src/scene/carModel.js` | the shell: extruded side profile with cut wheel arches, glasshouse, lights, wheels, axles |
| `src/scene/track.js` | asphalt, markings, ramps, props, skidmarks, lights, environment |
| `src/scene/forces.js` | debug overlay: force vectors at the patches, load, moment arms |
| `src/ui/hud.js` | dashboard + flags |
| `src/ui/audio.js` | procedural engine / tyre / suspension sound |
| `src/main.js` | boot, input, fixed-timestep loop, cameras, scenario switching |

`src/physics/**` must never import three.js — that is what lets the tests run in
node against the exact shipped physics.

## Common changes

**Add a map**: add an entry to `SCENARIOS` in `src/physics/sim.js` with `spawn`,
`ramps` and `props`. `B` cycles them; visuals rebuild from the same data. Ramp
entries take `{x, z, yaw, length, width, height, kind}` where `kind` is `'hump'`
(symmetric, sine-parabola profile) or `'kicker'` (jump face).

**Change handling**: `src/config.js` only. Tyre `mu`, `Bx/By` (stiffness vs peak
slip), suspension `stiffness/damping`, `arbFront/arbRear`, steering assist. Run
`npm test` after — several tests assert balance and roll.

**Change the body**: `src/scene/carModel.js` is pure geometry, no physics. The
collision shape is five boxes in `vehicle.js`; they are deliberately independent,
so cosmetic changes cannot alter handling.

**Add a part**: build it in `carModel.js`, and if it is a light or a band on a
curved surface, place it by raycasting the body first (see `docs/car-model.md`).

## Traps (each of these cost a real debugging session)

1. **Never derive wheel positions from `contact.center`.** That value is computed
   *before* `world.step()`; the body is drawn *after* it, so wheels lag by `v·dt`
   — invisible at 5 m/s, 20 cm at 80 km/h. Position wheels in the body frame from
   `contact.travel`.
2. **`RigidBodyDesc.setAdditionalMassProperties` is a no-op** in rapier 0.14 —
   the body ends up mass 0. Use `ColliderDesc.setMassProperties`. Extra colliders
   get `.setDensity(0)` so they add collision without mass.
3. **Raycasts need one `world.step()` first**; the query pipeline is empty before.
   Use `castRayAndGetNormal` (plain `castRay` has no normal), and pass
   `solid: false` or a ray starting inside a collider returns `toi = 0`.
4. **A convex hull of a curved ramp flattens it.** Ramps are stacks of ~28 convex
   slices for this reason, and the mesh is extruded from the same outline.
5. **Do not force wheels world-upright** by decomposing body yaw: the Euler
   extraction is singular near ±90° of roll and throws the wheels to random
   angles. Wheels are rigid to the body; half-shafts show suspension travel.
6. **Serve with `python3 serve.py`, not `http.server`** — the latter sends no
   cache headers and a reload can silently run yesterday's module. The build tag
   in the HUD tells you which version is live.

## Style

SI units everywhere. `+Z` forward, `+Y` up, so the car's **right is -X** (a
positive steer angle points the wheels at -X and produces a negative yaw rate).
Comments explain *why* a number is what it is, not what the line does.
