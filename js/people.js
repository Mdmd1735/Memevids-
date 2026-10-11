// Multi-person tracking: who is who from one frame to the next.
//
// MediaPipe finds up to PEOPLE.max faces per frame but doesn't say which face
// is which person over time. This keeps a stable Person for each one by
// matching every new face to the nearest face from the previous frame
// (distance measured in face widths, so it works near and far), then hands
// each person the hands and body that are closest to them. Each Person has its
// own meme state, hand-motion history and smoothed position, so friends can
// pull different faces at the same time.
import { FACE_MEMORY_MS, PEOPLE } from "./config.js";
import { Face, Motion, PoseTracker, dist } from "./face.js";

export class Person {
  constructor(id, face, now) {
    this.id = id;
    this.tracker = new PoseTracker();
    this.motion = new Motion();
    this.baseline = null;        // this person's own calibration, if they were in frame for it
    this.center = [...face.center];
    this.faceH = face.h;
    this.hands = [];
    this.body = null;
    this.see(face, now);
  }

  see(face, now) {
    this.face = face;
    this.lastFace = face;
    this.lastSeen = now;
    // Smooth the meme's position and size so it doesn't jitter.
    this.center = [0.7 * this.center[0] + 0.3 * face.center[0], 0.7 * this.center[1] + 0.3 * face.center[1]];
    this.faceH = 0.7 * this.faceH + 0.3 * face.h;
  }

  /** The face to judge poses on: the real one, or where it was a moment ago if hidden. */
  faceOrGhost(handsUp) {
    if (this.face) return this.face;
    if (!handsUp) return null;
    return Object.assign(Object.create(Face.prototype), this.lastFace, { ghost: true });
  }

  /** Last known face (real or remembered), for distances. */
  get anchor() {
    return this.face || this.lastFace;
  }
}

export class People {
  constructor() {
    this.list = [];
    this.nextId = 1;
    this.max = PEOPLE.max;   // 1 when group mode is off
  }

  reset() {
    this.list = [];
  }

  /** Match this frame's faces, hands and bodies to people. */
  update(faces, hands, bodies, now) {
    // 1. Faces -> people: closest pairs first, each used once.
    const pairs = [];
    this.list.forEach((p, pi) => faces.forEach((f, fi) => {
      const a = p.anchor;
      const d = dist(a.center, f.center) / Math.max(a.w, f.w, 1);
      if (d < PEOPLE.matchDist) pairs.push([d, pi, fi]);
    }));
    pairs.sort((x, y) => x[0] - y[0]);
    const takenP = new Set(), takenF = new Set();
    for (const [, pi, fi] of pairs) {
      if (takenP.has(pi) || takenF.has(fi)) continue;
      takenP.add(pi);
      takenF.add(fi);
      this.list[pi].see(faces[fi], now);
    }
    this.list.forEach((p, pi) => { if (!takenP.has(pi)) p.face = null; });

    // 2. Forget people who have been gone too long; welcome new faces.
    this.list = this.list.filter((p) => p.face || now - p.lastSeen < FACE_MEMORY_MS);
    faces.forEach((f, fi) => {
      if (!takenF.has(fi) && this.list.length < this.max) this.list.push(new Person(this.nextId++, f, now));
    });
    this.list.sort((a, b) => a.id - b.id);

    // 3. Hands -> the nearest person (at most two each, the closest two).
    for (const p of this.list) p.hands = [];
    const handPairs = [];
    hands.forEach((h, hi) => this.list.forEach((p) => {
      const a = p.anchor;
      const d = dist(h.palm, a.center) / Math.max(a.w, 1);
      if (d < PEOPLE.handReach) handPairs.push([d, hi, p]);
    }));
    handPairs.sort((x, y) => x[0] - y[0]);
    const usedH = new Set();
    for (const [, hi, p] of handPairs) {
      if (usedH.has(hi) || p.hands.length >= 2) continue;
      usedH.add(hi);
      p.hands.push(hands[hi]);
    }

    // 4. Bodies -> the person whose face sits just above the shoulders.
    for (const p of this.list) p.body = null;
    const bodyPairs = [];
    bodies.forEach((b, bi) => this.list.forEach((p) => {
      const a = p.anchor;
      const mid = [(b.shoulders[0][0] + b.shoulders[1][0]) / 2, (b.shoulders[0][1] + b.shoulders[1][1]) / 2];
      if (mid[1] < a.center[1]) return;   // shoulders must be below the face
      const d = dist(mid, a.center) / Math.max(a.w, 1);
      if (d < PEOPLE.bodyReach) bodyPairs.push([d, bi, p]);
    }));
    bodyPairs.sort((x, y) => x[0] - y[0]);
    const usedB = new Set();
    for (const [, bi, p] of bodyPairs) {
      if (usedB.has(bi) || p.body) continue;
      usedB.add(bi);
      p.body = bodies[bi];
    }
    return this.list;
  }
}
