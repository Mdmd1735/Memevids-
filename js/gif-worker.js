// Decodes an animated GIF off the main thread, so a 10 MB GIF doesn't freeze
// the camera while it unpacks. Posts back full composited RGBA frames,
// optionally shrunk (phones) to save memory.
import { parseGIF, decompressFrames } from "../vendor/gifuct.mjs";

// Box-filter downscale: average the source pixels behind each target pixel.
function shrink(src, W, H, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * H) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * W) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * W + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}


self.onmessage = async ({ data: { id, url, maxSize } }) => {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gif = parseGIF(await res.arrayBuffer());
    const parts = decompressFrames(gif, true);
    if (!parts.length) throw new Error("no frames");

    const W = gif.lsd.width, H = gif.lsd.height;
    const canvas = new Uint8ClampedArray(W * H * 4);   // the GIF's running "screen"
    const frames = [], durations = [];

    for (const f of parts) {
      const { left, top, width, height } = f.dims;
      const before = f.disposalType === 3 ? canvas.slice() : null;

      // Draw the patch; fully transparent pixels leave what's underneath.
      for (let y = 0; y < height; y++) {
        const cy = top + y;
        if (cy < 0 || cy >= H) continue;
        for (let x = 0; x < width; x++) {
          const cx = left + x;
          if (cx < 0 || cx >= W) continue;
          const s = (y * width + x) * 4;
          if (f.patch[s + 3] === 0) continue;
          const d = (cy * W + cx) * 4;
          canvas[d] = f.patch[s];
          canvas[d + 1] = f.patch[s + 1];
          canvas[d + 2] = f.patch[s + 2];
          canvas[d + 3] = f.patch[s + 3];
        }
      }

      frames.push(canvas.slice().buffer);
      durations.push(Math.max(20, f.delay || 100));

      if (f.disposalType === 2) {
        for (let y = Math.max(top, 0); y < Math.min(top + height, H); y++) {
          canvas.fill(0, (y * W + Math.max(left, 0)) * 4, (y * W + Math.min(left + width, W)) * 4);
        }
      } else if (before) {
        canvas.set(before);
      }
    }
    if (maxSize && Math.max(W, H) > maxSize) {
      const k = maxSize / Math.max(W, H);
      const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
      const small = frames.map((buf) => shrink(new Uint8ClampedArray(buf), W, H, w, h).buffer);
      self.postMessage({ id, W: w, H: h, frames: small, durations }, small);
      return;
    }
    self.postMessage({ id, W, H, frames, durations }, frames);
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
