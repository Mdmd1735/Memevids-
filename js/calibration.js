// Your resting face: a mean and a wobble (sigma) for every blendshape channel.
// Ported from Baseline / Collector / calibration_warnings in its_giving_v2.py.
import { CALIB, GENERIC_MEAN, GENERIC_SIGMA } from "./config.js";

export class Baseline {
  constructor(mean = null, sigma = null, samples = 0, made = null) {
    this.mean = mean || {};
    this.sigma = sigma || {};
    this.samples = samples;
    this.made = made;
    this.generic = Object.keys(this.mean).length === 0;
  }

  /** How far above your neutral this channel is, in standard deviations. */
  z(name, value) {
    const m = this.generic ? undefined : this.mean[name];
    if (m === undefined) return (value - (GENERIC_MEAN[name] ?? 0.02)) / GENERIC_SIGMA;
    return (value - m) / (this.sigma[name] ?? CALIB.sigmaCeil);
  }

  get neutralTurn() {
    return this.generic ? 0 : (this.mean.turn_signed ?? 0);
  }

  save() {
    try {
      localStorage.setItem(CALIB.storageKey, JSON.stringify({
        version: CALIB.version, made: this.made, samples: this.samples,
        mean: this.mean, sigma: this.sigma,
      }));
    } catch { /* private mode / blocked storage: calibration just won't persist */ }
  }

  static load() {
    try {
      const data = JSON.parse(localStorage.getItem(CALIB.storageKey) || "null");
      if (!data || data.version !== CALIB.version || !data.mean) return new Baseline();
      return new Baseline(data.mean, data.sigma || {}, data.samples || 0, data.made);
    } catch {
      return new Baseline();
    }
  }
}

/** Running mean and standard deviation per channel over the calibration window. */
export class Collector {
  constructor() {
    this.n = 0;
    this.s = {};
    this.ss = {};
  }

  add(face) {
    this.n += 1;
    const entries = Object.entries(face.bs);
    entries.push(["turn_signed", face.turnSigned]);
    for (const [name, v] of entries) {
      this.s[name] = (this.s[name] || 0) + v;
      this.ss[name] = (this.ss[name] || 0) + v * v;
    }
  }

  finish() {
    const mean = {}, sigma = {};
    const r5 = (x) => Math.round(x * 1e5) / 1e5;
    for (const [name, total] of Object.entries(this.s)) {
      const m = total / this.n;
      const v = Math.max(this.ss[name] / this.n - m * m, 0);
      mean[name] = r5(m);
      sigma[name] = r5(Math.min(Math.max(Math.sqrt(v), CALIB.sigmaFloor), CALIB.sigmaCeil));
    }
    sigma.turn_signed = Math.min(Math.max(sigma.turn_signed ?? 0.02, 0.01), 0.10);
    const made = new Date().toISOString().slice(0, 16).replace("T", " ");
    return new Baseline(mean, sigma, this.n, made);
  }
}

/** The two ways a calibration goes wrong: mid-expression, or fidgeting. */
export function calibrationWarnings(base) {
  const out = [];
  const m = base.mean;
  if ((m.jawOpen ?? 0) > 0.30) out.push("your mouth looked open — don't talk during calibration");
  if (Math.max(m.noseSneerLeft ?? 0, m.noseSneerRight ?? 0) > 0.15)
    out.push("your nose was scrunched — hold a bored face, not a reaction");
  if (Math.max(m.browInnerUp ?? 0, m.browOuterUpLeft ?? 0) > 0.35) out.push("your eyebrows were up — relax them");
  const pinned = Object.values(base.sigma).filter((v) => v >= CALIB.sigmaCeil).length;
  if (pinned > 12) out.push("you moved a lot — sit still and try again");
  return out;
}
