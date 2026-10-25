/**
 * Tyre model: combined-slip, load sensitive, friction-circle limited.
 *
 * The two inputs are the ones a tyre actually has: how fast its tread is
 * sliding relative to the road, in the rolling direction (slip ratio kappa) and
 * in the sideways direction (slip angle alpha).
 *
 *   Fx = Dx * sin(Cx * atan(Bx * kappa))
 *   Fy = -Dy * sin(Cy * atan(By * alpha))
 *
 * with D = mu(Fz) * Fz. Those are the D/C/B of a simplified Pacejka Magic
 * Formula: they rise linearly, peak, then fall away a little, which is why a
 * sliding tyre has less grip than one at the limit.
 */

export function muAtLoad(tire, fz) {
  // mu falls with load. Two things follow for free: the outside wheel loses
  // relative grip when the body rolls, and load transfer stops paying for
  // itself - exactly how a real car understeers when it leans on one side.
  const ratio = Math.max(0, fz) / tire.nominalLoad;
  const mu = tire.mu * (1 - tire.loadSensitivity * (ratio - 1));
  return clamp(mu, tire.mu * 0.55, tire.mu * 1.25);
}

export function lateralForce(tire, alpha, fz, mu) {
  const peak = mu * fz;
  if (peak <= 1e-6) return 0;
  return -peak * Math.sin(tire.Cy * Math.atan(tire.By * alpha));
}

export function longitudinalForce(tire, kappa, fz, mu) {
  const peak = mu * fz;
  if (peak <= 1e-6) return 0;
  return peak * Math.sin(tire.Cx * Math.atan(tire.Bx * kappa));
}

/**
 * Combined slip: a tread that is sliding lengthwise has almost no lateral
 * stiffness left. Without this the friction circle alone leaves ~84 % of the
 * lateral grip available at 500 % slip ratio, so a spinning rear axle still
 * holds the car straight and power oversteer never happens. Real tyres
 * collapse sideways once the contact patch is sliding forward - this factor is
 * that collapse, and it is what makes a drift possible.
 */
export function combinedSlipAttenuation(kappa) {
  return 1 / (1 + Math.abs(kappa) * 0.45);
}

/**
 * Keep the combined force inside the friction circle. A tyre has one budget of
 * grip to spend; ask for drive and cornering at once and both shrink. This is
 * what makes a rear-drive car go sideways out of a corner instead of simply
 * accelerating, and what makes braking while turning run wide.
 */
export function clampToFrictionCircle(fx, fy, limit) {
  if (limit <= 1e-6) return { fx: 0, fy: 0, utilisation: 0 };
  const mag = Math.hypot(fx, fy);
  if (mag <= limit) return { fx, fy, utilisation: mag / limit };
  const scale = limit / mag;
  return { fx: fx * scale, fy: fy * scale, utilisation: 1 };
}

/** Slip ratio, with a floor on the denominator so a stopped tyre doesn't divide by zero. */
export function slipRatio(wheelOmega, radius, vLong, floor = 2.2) {
  const denom = Math.max(Math.abs(vLong), floor);
  return (wheelOmega * radius - vLong) / denom;
}

/** Slip angle. Positive = the contact patch is sliding toward the wheel's right. */
export function slipAngle(vLong, vLat) {
  return Math.atan2(vLat, Math.abs(vLong) + 1.2);
}

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}
