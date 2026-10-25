/** DOM dashboard. Reads telemetry, writes text. */

const MAX_LOAD = 9000; // N for the load bars

export class Hud {
  constructor() {
    this.speed = document.getElementById('speed-value');
    this.gear = document.getElementById('gear-value');
    this.rpm = document.getElementById('rpm-value');
    this.rpmFill = document.getElementById('rpm-fill');
    this.thrFill = document.getElementById('thr-fill');
    this.brkFill = document.getElementById('brk-fill');
    this.grip = document.getElementById('grip-value');
    this.g = document.getElementById('g-value');
    this.roll = document.getElementById('roll-value');
    this.contact = document.getElementById('contact-value');
    this.mode = document.getElementById('drive-mode');
    this.flags = document.getElementById('flags');
    this.grid = document.getElementById('wheel-grid');

    this.cells = [];
    this._buildCells();
    this._buildFlags();
  }

  _buildCells() {
    const ids = ['FL', 'FR', 'RL', 'RR'];
    for (const id of ids) {
      const cell = document.createElement('div');
      cell.className = 'wheel-cell';
      cell.innerHTML = `
        <div class="top"><span>${id}</span><span class="load">0 N</span></div>
        <div class="load-bar"><i></i></div>
        <div class="grip-bar"><i></i></div>
        <div class="slip">κ 0.00 · α 0.0°</div>`;
      this.grid.appendChild(cell);
      this.cells.push({
        el: cell,
        load: cell.querySelector('.load'),
        loadBar: cell.querySelector('.load-bar i'),
        gripBar: cell.querySelector('.grip-bar i'),
        slip: cell.querySelector('.slip'),
      });
    }
  }

  _buildFlags() {
    this.flagEls = {};
    for (const [key, label, hot] of [
      ['spin', 'wheelspin', false],
      ['lock', 'lockup', true],
      ['drift', 'slide', true],
      ['air', 'airborne', false],
      ['power', 'handbrake', false],
      ['tc', 'tc cutting', false],
    ]) {
      const el = document.createElement('span');
      el.className = `flag${hot ? ' hot' : ''}`;
      el.textContent = label;
      this.flags.appendChild(el);
      this.flagEls[key] = el;
    }
  }

  update(sim, input) {
    const car = sim.vehicle;
    const t = car.telemetry;
    const kmh = Math.abs(t.speed) * 3.6;

    this.speed.textContent = kmh.toFixed(0);
    this.gear.textContent = t.gear === -1 ? 'R' : t.gear === 0 ? 'N' : String(t.gear);

    const maxRpm = 7600;
    this.rpm.textContent = Math.round(t.rpm);
    this.rpmFill.style.width = `${Math.min(100, (t.rpm / maxRpm) * 100)}%`;

    this.thrFill.style.width = `${Math.max(0, input.throttle) * 100}%`;
    this.brkFill.style.width = `${Math.max(0, -input.throttle) * 100}%`;

    let gripMax = 0;
    let airborne = 0;
    let spin = false;
    let lock = false;
    // slip is measured along the car's forward axis, so in reverse a locked
    // wheel has the opposite sign. Flags have to be direction-aware or the car
    // spends the whole reverse gear "locked up".
    const forward = t.speed >= 0 ? 1 : -1;
    const moving = Math.abs(t.speed) > 0.4;

    car.wheels.forEach((w, i) => {
      const c = w.contact;
      const cell = this.cells[i];
      gripMax = Math.max(gripMax, c.utilisation);
      if (!c.grounded) airborne++;

      if (moving) {
        const directionalSlip = c.slipRatio * forward;
        if (directionalSlip > 0.2) spin = true;
        if (directionalSlip < -0.15) lock = true;
      }

      cell.load.textContent = `${Math.round(c.load)} N`;
      cell.loadBar.style.width = `${Math.min(100, (c.load / MAX_LOAD) * 100)}%`;
      cell.gripBar.style.width = `${Math.min(100, c.utilisation * 100)}%`;
      cell.slip.textContent = `κ ${c.slipRatio.toFixed(2)} · α ${((c.slipAngle * 180) / Math.PI).toFixed(0)}°`;
      cell.el.classList.toggle('sliding', c.grounded && c.utilisation > 0.995);
      cell.el.classList.toggle('airborne', !c.grounded);
    });

    this.grip.textContent = gripMax.toFixed(2);
    this.g.textContent = `${t.lateralG.toFixed(2)} / ${t.longG.toFixed(2)}`;
    this.roll.textContent = `${((t.roll * 180) / Math.PI).toFixed(1)}°`;
    this.contact.textContent = `${4 - airborne}/4`;

    this.flagEls.spin.classList.toggle('on', spin);
    this.flagEls.lock.classList.toggle('on', lock);
    // SLIDE means the car's velocity vector has genuinely diverged from where
    // it points - a corner at the grip limit (3-6 deg of body slip) is not a
    // slide, and neither is wheelspin in a straight line. Hysteresis so it
    // does not flicker on the threshold.
    const slipDeg = Math.abs(t.sideslip);
    // forward only: reversing points the velocity vector 180 deg away from the
    // nose, which would read as a permanent slide
    const fast = t.speed > 3;
    const wasSliding = this.flagEls.drift.classList.contains('on');
    const sliding = fast && slipDeg > (wasSliding ? 0.12 : 0.17);
    this.flagEls.drift.classList.toggle('on', sliding);
    this.flagEls.air.classList.toggle('on', airborne > 0);
    this.flagEls.power.classList.toggle('on', !!input.handbrake);
    this.flagEls.tc.classList.toggle('on', !!t.tcActive);
  }
}
