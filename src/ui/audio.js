/**
 * Procedural audio. Every parameter is driven by the simulation, not by the
 * input: the engine note is the crank speed the drivetrain is actually turning,
 * the squeal is the tyre's real slip, the wind is the real airspeed.
 *
 * Signal chain:
 *   crank rpm -> 4 detuned oscillators (firing harmonics) -> lowpass -> master
 *   throttle  -> intake noise -> bandpass
 *   slip/util -> noise -> resonant bandpass      (squeal)
 *   speed     -> noise -> lowpass                (wind)
 */

const FIRING_ORDER = 3; // V6, four-stroke: three firing events per revolution

export class CarAudio {
  constructor() {
    this.started = false;
    this.ready = false;
    this.muted = false;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.started = true;

    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;
    this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(this.muted ? 0.0001 : 0.85, ctx.currentTime, 0.25);

    // shared white noise
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    const noise = (dest) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(dest);
      src.start();
      return src;
    };

    // ---- engine
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 1.4;
    this.engineGain.connect(this.engineFilter);
    this.engineFilter.connect(this.master);

    this.oscillators = [];
    const partials = [
      ['sawtooth', 1, 0.5],
      ['sawtooth', 2, 0.2],
      ['square', 0.5, 0.3],
      ['sawtooth', 3, 0.1],
    ];
    for (const [type, mult, gain] of partials) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 60 * mult;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g);
      g.connect(this.engineGain);
      osc.start();
      this.oscillators.push({ osc, mult });
    }

    // ---- intake / exhaust rasp
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0.0001;
    const intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = 900;
    intakeFilter.Q.value = 1.0;
    this.intakeGain.connect(intakeFilter);
    intakeFilter.connect(this.master);
    noise(this.intakeGain);

    // ---- tyre squeal: two high resonant peaks so it shrieks instead of hums
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0.0001;
    this.tyreHigh = ctx.createBiquadFilter();
    this.tyreHigh.type = 'highpass';
    this.tyreHigh.frequency.value = 1200;
    this.tyreGain.connect(this.tyreHigh);

    this.tyreFilter = ctx.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 2100;
    this.tyreFilter.Q.value = 9;
    this.tyreHigh.connect(this.tyreFilter);
    this.tyreFilter.connect(this.master);

    this.tyreHarmonic = ctx.createBiquadFilter();
    this.tyreHarmonic.type = 'bandpass';
    this.tyreHarmonic.frequency.value = 3300;
    this.tyreHarmonic.Q.value = 12;
    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.55;
    this.tyreHigh.connect(this.tyreHarmonic);
    this.tyreHarmonic.connect(harmonicGain);
    harmonicGain.connect(this.master);
    noise(this.tyreGain);

    // ---- suspension rattle: a low bed of gravel for sustained fast travel,
    // plus one-shot clunks fired from update()
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0.0001;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 380;
    rumbleFilter.Q.value = 2.2;
    this.rumbleGain.connect(rumbleFilter);
    rumbleFilter.connect(this.master);
    noise(this.rumbleGain);
    this.lastBangAt = 0;
    this.wasBottomed = [false, false, false, false];

    // ---- wind
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0001;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 520;
    this.windGain.connect(windFilter);
    windFilter.connect(this.master);
    noise(this.windGain);

    this.ready = true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(muted ? 0.0001 : 0.85, this.ctx.currentTime, 0.08);
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * One-shot bump-stop bang: metal hitting metal, once, at the end of travel.
   * A low thump for the body, a short metallic crack for the contact, and a
   * fast attack so it reads as an impact rather than noise.
   */
  bang(intensity) {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // body thump
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, t);
    thump.frequency.exponentialRampToValueAtTime(42, t + 0.09);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.26 * intensity, t + 0.004);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    thump.connect(thumpGain);
    thumpGain.connect(this.master);
    thump.start(t);
    thump.stop(t + 0.3);

    // metallic crack: short, bright, gone in 30 ms
    const crack = ctx.createBufferSource();
    crack.buffer = this.noiseBuffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1700 + Math.random() * 900;
    band.Q.value = 3.2;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.0001, t);
    crackGain.gain.exponentialRampToValueAtTime(0.13 * intensity, t + 0.002);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    crack.connect(band);
    band.connect(crackGain);
    crackGain.connect(this.master);
    crack.start(t);
    crack.stop(t + 0.05);

    // a short low clank so it reads as parts meeting, not a drum hit
    const clank = ctx.createOscillator();
    clank.type = 'triangle';
    clank.frequency.setValueAtTime(220, t);
    clank.frequency.exponentialRampToValueAtTime(140, t + 0.05);
    const clankGain = ctx.createGain();
    clankGain.gain.setValueAtTime(0.0001, t);
    clankGain.gain.exponentialRampToValueAtTime(0.09 * intensity, t + 0.003);
    clankGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    clank.connect(clankGain);
    clankGain.connect(this.master);
    clank.start(t);
    clank.stop(t + 0.1);
  }

  update(car, input) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const tel = car.telemetry;
    const throttle = Math.max(0, input.throttle);
    const rpm = tel.rpm;

    // crank -> firing frequency
    const firing = Math.max(18, (rpm / 60) * FIRING_ORDER);
    for (const { osc, mult } of this.oscillators) {
      osc.frequency.setTargetAtTime(firing * mult, t, 0.035);
    }

    const load = 0.3 + 0.7 * throttle;
    this.engineGain.gain.setTargetAtTime(0.1 * load, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(420 + rpm * 0.16 + throttle * 1600, t, 0.06);
    this.intakeGain.gain.setTargetAtTime(0.05 * throttle * Math.min(1, rpm / 6500), t, 0.06);

    // Tyre squeal from the contact patch actually sliding. Grip *used* is not
    // sliding: a clean launch sits at ~100 % utilisation with the tread barely
    // slipping, and that used to squeal through the whole acceleration.
    let squeal = 0;
    if (car.telemetry.speed > 1.5) {
      for (const w of car.wheels) {
        const c = w.contact;
        if (!c.grounded) continue;
        const spin = Math.max(0, Math.abs(c.slipRatio) - 0.18);
        const slide = Math.max(0, Math.abs(c.slipAngle) - 0.14) * 1.4;
        squeal = Math.max(squeal, spin * 1.6 + slide);
      }
    }
    squeal = Math.min(1, squeal);
    this.tyreGain.gain.setTargetAtTime(0.26 * squeal, t, 0.06);
    this.tyreFilter.frequency.setTargetAtTime(1900 + 900 * squeal, t, 0.1);
    this.tyreHarmonic.frequency.setTargetAtTime(3000 + 1400 * squeal, t, 0.1);

    // ---- suspension: bang once, at the end of travel.
    // Not on shaft speed - that fires constantly over rough ground. A real car
    // is quiet until something hits something, which here is the bump stop.
    let impact = 0;
    for (let i = 0; i < car.wheels.length; i++) {
      const c = car.wheels[i].contact;
      if (!c.grounded) {
        this.wasBottomed[i] = false;
        continue;
      }
      const rate = Math.abs(c.compressionRate || 0);
      const justHit = c.bottomed && !this.wasBottomed[i];
      // a genuinely violent stroke is an impact even if it does not bottom out
      const hardHit = rate > 4.0;
      if (justHit) impact = Math.max(impact, 0.35 + rate / 5);
      else if (hardHit) impact = Math.max(impact, 0.25 + rate / 8);
      this.wasBottomed[i] = c.bottomed;
    }
    // one bang per event, not one per wheel: four stops hitting together is a
    // single impact to the ear, and a global cooldown stops it machine-gunning
    if (impact > 0 && t - this.lastBangAt > 0.28) {
      this.lastBangAt = t;
      this.bang(Math.min(1, impact));
    }
    this.rumbleGain.gain.setTargetAtTime(0.015, t, 0.1);

    // wind
    const v = Math.abs(tel.speed);
    this.windGain.gain.setTargetAtTime(0.07 * Math.min(1, (v / 55) ** 2), t, 0.2);
  }
}
