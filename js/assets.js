import { PHOTOBOOTH_CONFIG } from "./config.js";

// Meme assets: still images and animated GIFs, decoded into frames so the
// canvas can play them (drawImage on an <img> only ever shows a GIF's first
// frame in Chrome and Safari).

export class Asset {
  constructor(frames, durations) {
    this.frames = frames;          // canvases or ImageBitmaps
    this.durations = durations;    // ms per frame
    this.cum = [];
    let t = 0;
    for (const d of durations) this.cum.push((t += d));
    this.total = t;
    this.aspect = frames[0].width / frames[0].height;
  }

  frameAt(ms) {
    if (this.frames.length === 1) return this.frames[0];
    const t = ms % this.total;
    const i = this.cum.findIndex((c) => c > t);
    return this.frames[i < 0 ? this.frames.length - 1 : i];
  }
}

const canvasOf = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

function placeholder(label) {
  const c = canvasOf(300, 300);
  const g = c.getContext("2d");
  g.fillStyle = "rgba(220, 38, 38, 0.86)";
  g.beginPath();
  g.arc(150, 150, 140, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 26px sans-serif";
  g.textAlign = "center";
  g.fillText(label, 150, 160);
  return new Asset([c], [100]);
}

async function loadStill(path) {
  const img = new Image();
  img.src = path;
  await img.decode();
  const c = canvasOf(img.naturalWidth, img.naturalHeight);
  c.getContext("2d").drawImage(img, 0, 0);
  return new Asset([c], [100]);
}

// Decoding happens in a worker (gif-worker.js); frames come back as RGBA and
// become ImageBitmaps, which draw as fast as canvases and cost less memory.
let worker = null, nextId = 0;
const pending = new Map();

function gifWorker() {
  if (!worker) {
    worker = new Worker(new URL("./gif-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data);
    };
  }
  return worker;
}

async function loadGif(path) {
  const url = new URL(path, document.baseURI).href;
  const data = await new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    gifWorker().postMessage({ id, url, maxSize: PHOTOBOOTH_CONFIG.gifMaxSize });
  });
  const frames = await Promise.all(data.frames.map((buf) =>
    createImageBitmap(new ImageData(new Uint8ClampedArray(buf), data.W, data.H))));
  return new Asset(frames, data.durations);
}

/**
 * Load every asset; failures become placeholders, never crashes.
 *
 * Stills load before this resolves. Big GIFs (two of them are ~10 MB) show
 * their first frame straight away and swap in the full animation once it has
 * decoded in the background, so startup doesn't wait on them.
 */
export async function loadAssets(map) {
  const out = {};
  const report = (pose, path) =>
    console.log(`asset ${pose}: ${path} (${out[pose].frames.length} frame${out[pose].frames.length > 1 ? "s" : ""})`);
  const fail = (pose, path, e) => {
    console.warn(`asset ${pose}: could not load ${path} (${e.message}) -> placeholder`);
    out[pose] = placeholder(pose);
  };

  await Promise.all(Object.entries(map).map(async ([pose, path]) => {
    try {
      out[pose] = await loadStill(path);   // for a GIF: its first frame, for now
    } catch (e) {
      fail(pose, path, e);
      return;
    }
    if (!path.toLowerCase().endsWith(".gif")) {
      report(pose, path);
      return;
    }
    // Decode the animation in the background worker, one GIF at a time.
    queueGif(async () => {
      try {
        out[pose] = await loadGif(path);
        report(pose, path);
      } catch (e) {
        console.warn(`asset ${pose}: animation failed (${e.message}), keeping first frame`);
      }
    });
  }));
  return out;
}

let gifQueue = Promise.resolve();
function queueGif(job) {
  gifQueue = gifQueue.then(job);
}
