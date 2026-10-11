// Draws the mirrored camera frame and the meme on top of it.
//
// The mirror happens *in the canvas*, not with CSS, so meme text always reads
// the right way round and the photos you save match what you saw. Turning the
// mirror off gives the true view, where text on your clothes reads correctly.
import { MEME } from "./config.js";

const PERSON_COLOURS = ["#22c55e", "#f59e0b", "#ec4899", "#38bdf8"];

export class OverlayRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    // Clean mirrored frame: what MediaPipe sees and what the tongue check reads.
    this.frame = document.createElement("canvas");
    this.fctx = this.frame.getContext("2d", { willReadFrequently: true });
    this.resize(canvas.width, canvas.height);
  }

  resize(W, H) {
    this.canvas.width = this.frame.width = W;
    this.canvas.height = this.frame.height = H;
    this.W = W;
    this.H = H;
  }

  /** Copy the webcam into the clean frame (mirrored like a selfie, or not). */
  capture(video, mirror) {
    const g = this.fctx;
    g.save();
    if (mirror) g.setTransform(-1, 0, 0, 1, this.W, 0);
    g.drawImage(video, 0, 0, this.W, this.H);
    g.restore();
    return this.frame;
  }

  /**
   * Composite the clean frame + one meme per person onto the visible canvas.
   * `overlays`: [{ asset, elapsed, center: [x, y], faceH }] — positions already smoothed.
   */
  compose(overlays = []) {
    const { ctx, W, H } = this;
    ctx.drawImage(this.frame, 0, 0);
    for (const { asset, elapsed, center, faceH } of overlays) {
      if (!asset) continue;
      const sprite = asset.frameAt(elapsed);
      const h = Math.max(8, Math.floor(Math.min(faceH * MEME.scale, H * 0.98, (W * 0.98) / asset.aspect)));
      const w = Math.round(h * asset.aspect);
      const x = center[0] - w / 2;
      const y = center[1] + MEME.bottom * faceH - h;   // bottom edge just below the nose
      ctx.drawImage(sprite, x, y, w, h);
    }
  }

  /** Debug marks on a separate layer, so they never end up in a photo. */
  drawDebug(debugCanvas, people, strayHands = [], bodies = []) {
    if (debugCanvas.width !== this.W || debugCanvas.height !== this.H) {
      debugCanvas.width = this.W;
      debugCanvas.height = this.H;
    }
    const g = debugCanvas.getContext("2d");
    g.clearRect(0, 0, this.W, this.H);
    const dot = (p, r, colour) => {
      g.fillStyle = colour;
      g.beginPath();
      g.arc(p[0], p[1], r, 0, Math.PI * 2);
      g.fill();
    };
    for (const b of bodies) if (b.seen) for (const p of [...b.shoulders, ...b.elbows]) dot(p, 7, "#60a5fa");
    for (const h of strayHands) dot(h.palm, 8, "#94a3b8");   // hands nobody claimed
    people.forEach((person, i) => {
      const colour = PERSON_COLOURS[i % PERSON_COLOURS.length];
      const f = person.anchor;
      const [x0, y0, x1, y1] = f.box;
      g.strokeStyle = colour;
      g.lineWidth = 3;
      g.setLineDash(person.face ? [] : [8, 6]);   // dashed = hidden / remembered
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.setLineDash([]);
      g.fillStyle = colour;
      g.font = "bold 22px sans-serif";
      g.fillText(`P${i + 1}`, x0 + 4, y0 - 8);
      dot(f.nose, 4, colour);
      dot(f.mouth, 4, colour);
      for (const h of person.hands) {
        dot(h.palm, 9, colour);
        dot(h.thumb, 5, "#38bdf8");
        dot(h.index, 5, "#f472b6");
      }
    });
  }

  drawCalibration(progress, samples, hasFace, count = 1) {
    const { ctx, W } = this;
    ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
    ctx.fillRect(0, 0, W, 96);
    ctx.fillStyle = "#fff";
    ctx.font = "600 26px 'Plus Jakarta Sans', sans-serif";
    ctx.fillText("CALIBRATING — hold a bored face", 18, 38);
    ctx.font = "600 18px 'Plus Jakarta Sans', sans-serif";
    ctx.fillStyle = hasFace ? "#cbd5e1" : "#fb923c";
    const who = count > 1 ? `${count} people   ` : "";
    ctx.fillText(`${who}${samples} frames${hasFace ? "" : "   NO FACE"}`, 18, 68);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(0, 84, W * Math.min(progress, 1), 12);
  }
}
