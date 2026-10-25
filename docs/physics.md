# The physics, in the order it happens

Every number here is in `src/config.js`. The point of this file is that you can
re-derive the model without reading the code.

## Per step (1/120 s), per wheel

```
attach      = body position + rotation * (±0.8, 0, ±1.31)
ray         = cast down the chassis axis, max length 0.315 + 0.33
dist        = ray hit distance
travel      = clamp(dist - 0.33, 0.185, 0.315)      # suspension length
compression = 0.32 - travel
rate        = clamp((compression - prev) / dt, ±6)  # shaft speed, clamped

Fz = k*compression + c*rate            # k 49 kN/m, c 3.3 kNs/m, clamp 0..42 kN
Fz += arb * (compression - partnerCompression)      # anti-roll bar, 11 k / 2.5 k

body.applyImpulseAtPoint(up * Fz * dt, attach)      # spring pushes the chassis
```

Pitch and roll are the *difference between four of those*. There is no
"weight transfer" formula anywhere in the codebase.

```
vContact = bodyVelocity + bodyAngularVelocity × (contact - centreOfMass)
vLong    = vContact · wheelForward      (wheel frame, steered)
vLat     = vContact · wheelRight

kappa = (omega*R - vLong) / max(|vLong|, 2.2)
alpha = atan2(vLat, |vLong| + 1.2)

mu    = 1.02 * (1 - 0.16*(Fz/3500 - 1))             # load sensitivity, clamped
Fx    =  mu*Fz * sin(1.65 * atan(11   * kappa))
Fy    = -mu*Fz * sin(1.75 * atan( 6.5 * alpha)) * 1/(1 + 0.45*|kappa|)
(Fx,Fy) = clampToCircle(Fx, Fy, mu*Fz)              # one grip budget

body.applyImpulseAtPoint((Fx*fwd + Fy*right) * dt, contactPatch)
```

The two multipliers worth understanding: **load sensitivity** is why leaning on
the outside tyre costs grip, and the **combined-slip attenuation** is why a
spinning rear axle loses lateral grip (without it, power oversteer is impossible
and the car always straightens out).

## Wheel spin (implicit, and it matters)

```
k  = dFx/dv at the current slip, floored at 2% of the linear slope, capped 1e5
f0 = Fx at the current slip
I  = I_wheel + I_engine * ratio² / drivenWheels     # reflected drivetrain inertia

omega' = (I*omega + dt*(Tdrive - R*f0 + k*R²*omega)) / (I + dt*k*R²)
```

Explicit integration diverges: the tyre is a spring with a ~0.4 ms time constant
against a 1.35 kg·m² wheel. A parked car crept away on numerical noise until this
was made implicit. Past peak slip the slope goes negative, hence the floor — that
floor is a numerical device, declared in the README.

## Drivetrain

Crank speed is read off the drivetrain (`omega * ratio`), the clutch slips below
~1100 rpm, the gearbox shifts on shaft speed with a 0.16 s torque cut and
kickdown, and traction control trims drive torque when driven slip passes 12 %
(suspended while the handbrake is down, or you cannot hold a drift).

ABS trims brake torque when a wheel's slip passes -0.22. Brakes and drive act on
the wheel **regardless of contact**, so a car on its roof can still be stopped
from spinning its wheels.

## Degrees of freedom

| DOF | Free? | Driven by |
|---|---|---|
| chassis x/y/z | free | tyre forces, springs, gravity |
| yaw / pitch / roll | free | Σ r×F and the four spring forces |
| wheel omega ×4 | free | engine torque, brake torque, tyre reaction |
| front steer | constrained | input (joint angle) |
| suspension travel | constrained | spring/damper vs the ground ray |
| engine rpm, gear | constrained | drivetrain; shifts on its own |
| camera, reset, gearbox policy | authored | input |

## Fidelity

Level 3 of 4: real tyre model and load transfer, simplified clutch, no thermal or
wear model, one rigid body (no chassis flex). `README.md` lists every authored
DOF and every simplification — keep it accurate if you change the model.
