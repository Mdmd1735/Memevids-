// Face / hand / body geometry, expression measures and the pose decision.
// Ported from Face / Hand / Body / Motion / tongue_score / measure / decide in
// its_giving_v2.py — same landmarks, same thresholds, same order.
//
// Everything works in the coordinates of the frame as displayed. Head turn is
// normalised to the mirrored convention so a calibration survives toggling the
// mirror.
import { Z, Z_CAP, Z_DISGUST_UNCALIBRATED, FLOOR, T, GESTURE, ARM, DEFAULT_ARM, HOLD_FRAMES, POSES } from "./config.js";

// Mid-cheek points (left, right): a patch of plain skin to compare the mouth against.
const CHEEKS = [205, 425];
const INNER_LIPS = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class Face {
  constructor(landmarks, blendshapes, W, H, mirrored = true) {
    const p = landmarks.map((l) => [l.x * W, l.y * H]);
    this.pts = p;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    this.box = [x0, y0, x1, y1];
    this.w = x1 - x0;
    this.h = y1 - y0;
    this.center = [(x0 + x1) / 2, (y0 + y1) / 2];
    this.nose = p[1];
    this.chin = p[152];
    this.top = p[10];
    this.mouth = [(p[13][0] + p[14][0]) / 2, (p[13][1] + p[14][1]) / 2];
    this.eyeY = (p[33][1] + p[263][1]) / 2;
    const cl = p[234], cr = p[454];
    const turn = (this.nose[0] - cl[0]) / Math.max(cr[0] - cl[0], 1e-3) - 0.5;
    this.turnSigned = mirrored ? turn : -turn;
    this.bs = {};
    for (const c of blendshapes?.categories || []) this.bs[c.categoryName] = c.score;
  }

  b(name) {
    return this.bs[name] ?? 0;
  }
}

export class Hand {
  constructor(landmarks, W, H) {
    const p = landmarks.map((l) => [l.x * W, l.y * H]);
    const avg = (ids) => [ids.reduce((a, i) => a + p[i][0], 0) / ids.length, ids.reduce((a, i) => a + p[i][1], 0) / ids.length];
    this.palm = avg([0, 5, 9, 13, 17]);
    this.thumb = p[4];
    this.index = p[8];
    this.middle = p[12];
    const dx = p[9][0] - p[0][0], dy = p[9][1] - p[0][1];
    this.horizontal = Math.abs(dx) > 1.5 * Math.abs(dy);
    this.vertical = Math.abs(dy) > 1.5 * Math.abs(dx);
    // A finger is extended when its tip is clearly further from the wrist than its middle joint.
    const ext = [8, 12, 16, 20].filter((t) => dist(p[0], p[t]) > 1.2 * dist(p[0], p[t - 2])).length;
    this.open = ext >= 3;
  }
}

/** Upper-body pose: shoulders 11/12, elbows 13/14, wrists 15/16. */
export class Body {
  constructor(landmarks, W, H) {
    const p = (i) => [landmarks[i].x * W, landmarks[i].y * H];
    this.shoulders = [p(11), p(12)];
    this.elbows = [p(13), p(14)];
    this.seen = Math.min(...[11, 12, 13, 14].map((i) => landmarks[i].visibility ?? 1)) > 0.5;
    const shoulderY = (this.shoulders[0][1] + this.shoulders[1][1]) / 2;
    this.elbowsUp = this.seen && this.elbows.every((e) => e[1] < shoulderY);
  }
}

/**
 * Hand gesturing, measured over the last GESTURE.window seconds:
 *   speed  — how far the hand travelled, in face widths per second
 *   swings — how many big moves ended in a reversal (back-and-forth)
 * Follows one hand (the one nearest where it was last frame).
 */
export class Motion {
  constructor() {
    this.fw = 200;
    this.reset();
  }

  reset() {
    this.track = null;
    this.samples = [];   // { t (s), x, y (face widths) }
    this.lastHandAt = -Infinity;
    this.result = { speed: 0, swings: 0 };
  }

  update(hands, face, nowMs) {
    if (face) this.fw = Math.max(face.w, 1);
    const t = nowMs / 1000;
    if (!hands.length) {
      // A fast hand blurs and the tracker misses it for a frame or two: keep the
      // history (and the last reading) through short gaps instead of starting over.
      if (t - this.lastHandAt > GESTURE.gap) this.reset();
      return this.result;
    }

    let p = hands[0].palm;
    if (this.track) {
      p = hands.map((h) => h.palm).reduce((a, b) => (dist(a, this.track) <= dist(b, this.track) ? a : b));
      // A jump further than a fast wave could cover since we last saw it = a different hand.
      const dt = Math.max(t - this.lastHandAt, 1 / 60);
      if (dist(p, this.track) / this.fw > 1 + 8 * dt) this.samples = [];
    }
    this.track = p;
    this.lastHandAt = t;

    this.samples.push({ t, x: p[0] / this.fw, y: p[1] / this.fw });
    while (this.samples.length && t - this.samples[0].t > GESTURE.window) this.samples.shift();
    const span = this.samples.length > 1 ? t - this.samples[0].t : 0;
    if (span < GESTURE.window * 0.4) return (this.result = { speed: 0, swings: 0 });

    let path = 0, swings = 0;
    const runs = { x: 0, y: 0 };
    for (let i = 1; i < this.samples.length; i++) {
      const dx = this.samples[i].x - this.samples[i - 1].x;
      const dy = this.samples[i].y - this.samples[i - 1].y;
      const step = Math.hypot(dx, dy);
      if (step < GESTURE.jitter) continue;
      path += step;
      for (const [axis, d] of [["x", dx], ["y", dy]]) {
        const run = runs[axis];
        if (run === 0 || Math.sign(d) === Math.sign(run)) runs[axis] = run + d;
        else {
          if (Math.abs(run) >= GESTURE.swing) swings++;
          runs[axis] = d;
        }
      }
    }
    return (this.result = { speed: path / span, swings });
  }
}

/** Is the hand-gesture reading strong enough for talking_to_wall? */
export const waving = (g) => g.swings >= GESTURE.minSwings && g.speed >= GESTURE.speed;

/** Every expression channel, raw and in sigma above your own neutral. */
export function measure(face, base) {
  const zpair = (n) => (base.z(n + "Left", face.b(n + "Left")) + base.z(n + "Right", face.b(n + "Right"))) / 2;
  const pair = (n) => (face.b(n + "Left") + face.b(n + "Right")) / 2;
  const m = {
    jaw: face.b("jawOpen"), z_jaw: base.z("jawOpen", face.b("jawOpen")),
    sneer: pair("noseSneer"), z_sneer: zpair("noseSneer"),
    z_brow: zpair("browDown"), z_frown: zpair("mouthFrown"), z_lip: zpair("mouthUpperUp"),
    squint: Math.max(pair("eyeSquint"), pair("eyeBlink")),
    z_squint: Math.max(zpair("eyeSquint"), zpair("eyeBlink")),
    turn: Math.abs(face.turnSigned - base.neutralTurn),
    z_stretch: zpair("mouthStretch"),
    smile: pair("mouthSmile"),
    generic: base.generic,
  };
  const cap = (v, c = Z_CAP) => Math.min(v, c);
  // MediaPipe's nose-scrunch barely registers on most real disgusted faces; the
  // grimace does (lips stretched wide, corners down). Stretch is capped lower so
  // it can't fire on its own — it needs a frown, brow or lip raise alongside.
  m.z_disgust = 2 * cap(m.z_sneer) + cap(m.z_brow) + cap(m.z_frown) + cap(m.z_lip) + cap(m.z_stretch, 6);
  return m;
}

/** Sigma above your neutral AND a raw floor. */
export const over = (key, m, zkey, rawkey) => m[zkey] >= Z[key] && m[rawkey] >= FLOOR[key];

/**
 * How much of the mouth opening is tongue, 0..1.
 *
 * Fixed "pink" colour thresholds break with phone white balance, dim light and
 * different skin tones, so this compares the inside of the mouth with *your own
 * cheeks*: skin leans orange, tongue leans pink-red (its hue sits clearly
 * toward magenta from your skin's), teeth are pale, and the back of the throat
 * is dark. Comparing hue, not "how red", is what works on warm, darker skin.
 *
 * Out vs. in: an open mouth shows your tongue too, lying at the bottom with
 * teeth or dark throat above it. A tongue sticking *out* fills the opening up
 * to the top lip. So the top half of the opening has to be tongue as well, and
 * hardly any dark throat can show. A gasp shows mostly dark throat and teeth; a
 * tongue sticking out fills the opening with red.
 * `ctx` is the clean (no overlay) frame.
 */
export function tongueScore(ctx, face, hands, jawReady) {
  if (!jawReady) return 0;
  // A hand near the mouth is skin-coloured and confuses the comparison.
  if (hands.some((h) => dist(h.palm, face.mouth) < 0.7 * face.w)) return 0;
  const poly = INNER_LIPS.map((i) => face.pts[i]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // The lips have to be properly apart, relative to your face size.
  if (x1 - x0 < 8 || y1 - y0 < Math.max(6, 0.06 * face.h)) return 0;

  const skin = skinTone(ctx, face);
  if (!skin) return 0;

  x0 = Math.max(Math.floor(x0), 0);
  y0 = Math.max(Math.floor(y0), 0);
  x1 = Math.min(Math.ceil(x1), ctx.canvas.width - 1);
  y1 = Math.min(Math.ceil(y1), ctx.canvas.height - 1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return 0;

  // Stay a little inside the inner lip line so the lips themselves don't count.
  const cx = poly.reduce((s, q) => s + q[0], 0) / poly.length;
  const cy = poly.reduce((s, q) => s + q[1], 0) / poly.length;
  const shrunk = poly.map(([x, y]) => [cx + (x - cx) * 0.88, cy + (y - cy) * 0.88]);

  const data = ctx.getImageData(x0, y0, w, h).data;
  const midY = (Math.min(...shrunk.map((q) => q[1])) + Math.max(...shrunk.map((q) => q[1]))) / 2;
  let n = 0, red = 0, dark = 0, nTop = 0, redTop = 0;
  for (let yy = 0; yy < h; yy++) {
    const top = y0 + yy + 0.5 < midY;
    for (let xx = 0; xx < w; xx++) {
      if (!inside(shrunk, x0 + xx + 0.5, y0 + yy + 0.5)) continue;
      n++;
      if (top) nTop++;
      const i = (yy * w + xx) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b);
      if (max < skin.max * 0.35) { dark++; continue; }              // back of the throat
      if ((max - Math.min(r, g, b)) / max < 0.18) continue;          // teeth: pale, unsaturated
      // Degrees the pixel's hue sits toward pink/magenta from your skin's.
      const toward = ((skin.hue - hue(r, g, b) + 540) % 360) - 180;
      if (toward >= 10 && toward <= 70) {
        red++;
        if (top) redTop++;
      }
    }
  }
  if (n < 30 || nTop < 10) return 0;
  // Throat showing = the tongue is inside your mouth, not out.
  if (dark / n > 0.2) return 0;
  // Tongue all the way up the opening, not just lying along the bottom.
  return Math.min(red / n, redTop / nTop);
}

function hue(r, g, b) {
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  let h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return h < 0 ? h + 360 : h;
}

// Average colour of both cheeks: its hue and its brightness.
function skinTone(ctx, face) {
  let r = 0, g = 0, b = 0, max = 0, n = 0;
  const half = Math.max(2, Math.round(face.w * 0.03));
  for (const id of CHEEKS) {
    const [px, py] = face.pts[id];
    const x = Math.round(px) - half, y = Math.round(py) - half, s = half * 2 + 1;
    if (x < 0 || y < 0 || x + s > ctx.canvas.width || y + s > ctx.canvas.height) continue;
    const d = ctx.getImageData(x, y, s, s).data;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2];
      max += Math.max(d[i], d[i + 1], d[i + 2]);
      n++;
    }
  }
  if (!n) return null;
  return { hue: hue(r / n, g / n, b / n), max: max / n };
}

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}


/** Return the raw pose for this frame, or null. Same order as the Python. */
export function decide(face, hands, body, tongue, gesture, m) {
  if (!face) {
    const gone = !hands.length && (!body || !body.seen);
    return gone ? "spin" : null;
  }

  const fw = face.w;
  const near = (a, b, k) => dist(a, b) < k * fw;
  const elbowsUp = !!body?.elbowsUp;
  const screaming = over("scream_jaw", m, "z_jaw", "jaw");
  // Where hands go to cover your nose and mouth.
  const lowerFace = [(face.nose[0] + face.mouth[0]) / 2, (face.nose[1] + face.mouth[1]) / 2];

  // Movement first: a waving hand passes through every static pose on the way
  // (hand_up especially), so check for waving before reading the hand shape.
  if (waving(gesture)) return "talking_to_wall";

  // Face hidden behind your hands: we only know where it was, and that a hand is on it.
  if (face.ghost) {
    return hands.some((h) => near(h.palm, face.center, 0.7)) ? "cover_nose" : null;
  }

  if (hands.length >= 2) {
    const [a, b] = hands;
    for (const [top, under] of [[a, b], [b, a]]) {
      if (top.horizontal && under.vertical && top.palm[1] < under.palm[1] && near(under.middle, top.palm, 0.6))
        return "time_out";
    }
    if (near(a.index, b.index, 0.3) && near(a.thumb, b.thumb, 0.3) && a.index[1] + b.index[1] < a.thumb[1] + b.thumb[1])
      return "heart";
    if (near(a.palm, lowerFace, 0.7) && near(b.palm, lowerFace, 0.7)) return "cover_nose";
    const onHead = (h) => h.palm[1] < face.eyeY && Math.abs(h.palm[0] - face.nose[0]) < 1.1 * fw &&
      h.palm[1] > face.top[1] - 0.8 * face.h;
    if (onHead(a) && onHead(b) && screaming) return "crashing_out";
  }

  // Two overlapping hands often read as one: a flat open hand over the nose and
  // mouth counts too. (A pinch is a closed hand; flirty is a fingertip, palm away.)
  // A fingertip right on the lips is flirty, not a cover.
  if (hands.some((h) => h.open && near(h.palm, lowerFace, 0.4) && !near(h.index, face.mouth, 0.15))) return "cover_nose";

  // Hands behind your head are often invisible, so no hands counts as "all near the head".
  const nearHead = (h) => Math.abs(h.palm[0] - face.nose[0]) < 1.3 * fw && h.palm[1] < face.eyeY + 0.3 * face.h;
  if (elbowsUp && hands.every(nearHead)) return screaming ? "crashing_out" : "dance";

  for (const h of hands) {
    // Pinch: thumb and index both at the nose — and closer to it than to the
    // mouth, or a finger on the lips (flirty) reads as a pinch.
    const atNose = (p) => near(p, face.nose, 0.35) && dist(p, face.nose) < dist(p, face.mouth);
    if (atNose(h.thumb) && atNose(h.index) && near(h.thumb, h.index, 0.3)) return "nose_closed";
    if (near(h.index, face.mouth, 0.22) && !near(h.palm, face.mouth, 0.3)) return "flirty";
    if (h.open && h.palm[1] < face.nose[1] && Math.abs(h.palm[0] - face.nose[0]) > 0.8 * fw) return "hand_up";
  }

  if (tongue > T.tongue) return "tongue_out";
  if (over("jaw_open", m, "z_jaw", "jaw")) return "open_mouth";
  // ...but a big grin stretches the lips too, so not while smiling.
  const disgustBar = m.generic ? Z_DISGUST_UNCALIBRATED : Z.disgust;
  if ((over("sneer", m, "z_sneer", "sneer") || m.z_disgust >= disgustBar) && m.smile < T.smile) return "disgusted";
  if (m.turn > T.head_turn && over("squint", m, "z_squint", "squint")) return "suspicious";
  return null;
}

/** Arm / hold: a pose must persist ARM frames to fire, then lingers HOLD_FRAMES. */
export class PoseTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.arm = Object.fromEntries(POSES.map((p) => [p, 0]));
    this.shown = null;
    this.hold = 0;
    this.shownSince = 0;
    this.forced = null;
    this.forcedUntil = 0;
  }

  force(pose, now, ms = 2000) {
    this.forced = pose;
    this.forcedUntil = now + ms;
  }

  update(raw, now) {
    let fired = null;
    for (const p of POSES) {
      this.arm[p] = raw === p ? this.arm[p] + 1 : 0;
      if (raw === p && this.arm[p] >= (ARM[p] ?? DEFAULT_ARM)) fired = p;
    }
    if (this.forced && now < this.forcedUntil) fired = this.forced;
    if (fired) {
      if (fired !== this.shown) this.shownSince = now;
      this.shown = fired;
      this.hold = HOLD_FRAMES;
    } else if (this.hold > 0) {
      this.hold -= 1;
    } else {
      this.shown = null;
    }
    return this.shown;
  }
}

export { dist };
