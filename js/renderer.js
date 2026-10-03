// Draws the mirrored camera frame and the meme on top of it.
//
// The mirror happens *in the canvas*, not with CSS, so meme text always reads
// the right way round and the photos you save match what you saw. Turning the
// mirror off gives the true view, where text on your clothes reads correctly.
import { MEME } from "./config.js";

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
    this.smCenter = [W / 2, H / 2];
    this.smFaceH = H * 0.25;   // smoothed face height
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

  /** Follow the face smoothly; keeps the last spot when the face is gone. */
  track(face) {
    if (!face) return;
    this.smCenter = [0.7 * this.smCenter[0] + 0.3 * face.center[0], 0.7 * this.smCenter[1] + 0.3 * face.center[1]];
    this.smFaceH = 0.7 * this.smFaceH + 0.3 * face.h;
  }

  /** Composite the clean frame + the current meme frame onto the visible canvas. */
  compose(asset, elapsedMs) {
    const { ctx, W, H } = this;
    ctx.drawImage(this.frame, 0, 0);
    if (!asset) return;
    const sprite = asset.frameAt(elapsedMs);
    const h = Math.max(8, Math.floor(Math.min(this.smFaceH * MEME.scale, H * 0.98, (W * 0.98) / asset.aspect)));
    const w = Math.round(h * asset.aspect);
    const x = this.smCenter[0] - w / 2;
    const y = this.smCenter[1] + MEME.bottom * this.smFaceH - h;   // bottom edge just below the nose
    ctx.drawImage(sprite, x, y, w, h);
  }

  /** Debug marks on a separate layer, so they never end up in a photo. */
  drawDebug(debugCanvas, face, hands, body) {
    if (debugCanvas.width !== this.W || debugCanvas.height !== this.H) {
      debugCanvas.width = this.W;
      debugCanvas.height = this.H;
    }
    const g = debugCanvas.getContext("2d");
    g.clearRect(0, 0, this.W, this.H);
    if (!face && !hands.length && !body) return;
    const dot = (p, r, colour) => {
      g.fillStyle = colour;
      g.beginPath();
      g.arc(p[0], p[1], r, 0, Math.PI * 2);
      g.fill();
    };
    if (face) {
      const [x0, y0, x1, y1] = face.box;
      g.strokeStyle = "#22c55e";
      g.lineWidth = 2;
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      dot(face.nose, 4, "#22c55e");
      dot(face.mouth, 4, "#22c55e");
    }
    for (const h of hands) {
      dot(h.palm, 8, "#f59e0b");
      dot(h.thumb, 5, "#38bdf8");
      dot(h.index, 5, "#f472b6");
    }
    if (body?.seen) for (const p of [...body.shoulders, ...body.elbows]) dot(p, 7, "#60a5fa");
  }

  drawCalibration(progress, samples, hasFace) {
    const { ctx, W } = this;
    ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
    ctx.fillRect(0, 0, W, 96);
    ctx.fillStyle = "#fff";
    ctx.font = "600 26px 'Plus Jakarta Sans', sans-serif";
    ctx.fillText("CALIBRATING — hold a bored face", 18, 38);
    ctx.font = "600 18px 'Plus Jakarta Sans', sans-serif";
    ctx.fillStyle = hasFace ? "#cbd5e1" : "#fb923c";
    ctx.fillText(`${samples} frames${hasFace ? "" : "   NO FACE"}`, 18, 68);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(0, 84, W * Math.min(progress, 1), 12);
  }
}
