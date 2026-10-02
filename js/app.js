import { ASSETS, CALIB, FACE_MEMORY_MS, GESTURE, IS_PHONE, MEDIAPIPE, MIRROR_DEFAULT, PHOTOBOOTH_CONFIG, POSES, TEST_KEYS, Z } from "./config.js";
import { Baseline, Collector, calibrationWarnings } from "./calibration.js";
import { Body, Face, Hand, Motion, PoseTracker, decide, measure, over, tongueScore, waving } from "./face.js";
import { loadAssets } from "./assets.js";
import { OverlayRenderer } from "./renderer.js";

const $ = (id) => document.getElementById(id);
const video = $("webcam");
const canvas = $("outputCanvas");
const calibrateBtn = $("calibrateBtn");
const startBoothBtn = $("startBoothBtn");
const downloadBtn = $("downloadBtn");
const statusText = $("statusText");
const countdownOverlay = $("countdownOverlay");
const stripPreview = $("stripPreview");
const hud = $("hud");
const debugLayer = $("debugCanvas");
const mirrorToggle = $("mirrorToggle");
const debugBtn = $("debugBtn");
const testPose = $("testPose");

const renderer = new OverlayRenderer(canvas);
const tracker = new PoseTracker();
let base = Baseline.load();
const motion = new Motion();
let faceLandmarker = null, handLandmarker = null, poseLandmarker = null;
let FaceLandmarker, HandLandmarker, PoseLandmarker, FilesetResolver;
let mirror = loadMirror();
let lastFace = null, lastFaceAt = -Infinity;
let assets = {};
let lastVideoTime = -1;
let lastTs = -1;
let calibration = null;   // { collector, start, seen } while calibrating
let boothRunning = false;
let stripPhotos = [];
let fps = 0, fpsFrames = 0, fpsSince = performance.now();

const setStatus = (msg) => { statusText.textContent = msg; };

function readyStatus() {
  return base.generic
    ? "Ready — not calibrated yet, so reactions are harder to trigger. Click 'Calibrate Face' first."
    : `Ready — calibrated ${base.made} on ${base.samples} frames. Pull a face!`;
}

// GPU where the browser allows it, CPU otherwise.
async function create(Task, fileset, modelAssetPath, options) {
  const make = (delegate) => Task.createFromOptions(fileset, {
    baseOptions: { modelAssetPath, delegate }, runningMode: "VIDEO", ...options,
  });
  return make("GPU").catch((e) => {
    console.warn(`GPU delegate failed for ${modelAssetPath}, using CPU:`, e);
    return make("CPU");
  });
}

async function init() {
  // Browsers only allow the camera on https:// pages and localhost.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus(location.protocol === "file:"
      ? "This page has to be served, not opened as a file. In this folder run:  python3 -m http.server 8000  then open http://localhost:8000"
      : "The camera only works on an https:// link (or localhost). Open the GitHub Pages / https link instead of a plain http:// address.");
    return;
  }
  try {
    setStatus("Loading memes and the face, hand and body models…");
    const wasmPath = await loadMediaPipe();
    const fileset = await FilesetResolver.forVisionTasks(wasmPath);
    [assets, faceLandmarker, handLandmarker, poseLandmarker] = await Promise.all([
      loadAssets(ASSETS),
      create(FaceLandmarker, fileset, MEDIAPIPE.faceModel, { numFaces: 1, outputFaceBlendshapes: true }),
      create(HandLandmarker, fileset, MEDIAPIPE.handModel, { numHands: 2 }),
      create(PoseLandmarker, fileset, MEDIAPIPE.poseModel, { numPoses: 1 }),
    ]);

    // The first detection compiles GPU programs and can stall for a moment;
    // do it now, behind the loading message, rather than on the first live frame.
    setStatus("Warming up the models…");
    await new Promise((r) => setTimeout(r, 0));
    const warm = document.createElement("canvas");
    warm.width = 320;
    warm.height = 240;
    warm.getContext("2d").fillRect(0, 0, 320, 240);
    for (const lm of [faceLandmarker, handLandmarker, poseLandmarker]) lm.detectForVideo(warm, nextTs());

    setStatus("Waiting for camera permission…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",   // front camera on phones
        width: { ideal: PHOTOBOOTH_CONFIG.camera.width },
        height: { ideal: PHOTOBOOTH_CONFIG.camera.height },
      },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= 1) resolve();
      else video.addEventListener("loadedmetadata", resolve, { once: true });
    });
    await video.play();
    renderer.resize(video.videoWidth || PHOTOBOOTH_CONFIG.camera.width, video.videoHeight || PHOTOBOOTH_CONFIG.camera.height);

    calibrateBtn.disabled = false;
    startBoothBtn.disabled = false;
    setStatus(readyStatus());
    requestAnimationFrame(loop);
  } catch (err) {
    console.error("Initialization error:", err);
    const name = err?.name || "";
    if (name === "NotAllowedError") setStatus("Camera permission was denied. Allow camera access for this page and reload.");
    else if (name === "NotFoundError") setStatus("No camera found. Plug one in and reload.");
    else if (name === "NotReadableError") setStatus("The camera is busy in another app (Zoom, OBS, the Python version?). Close it and reload.");
    else setStatus(`Couldn't start: ${err?.message || err}`);
  }
}

// Prefer the pinned copy in vendor/ (works offline); fall back to the same
// pinned version on the CDN if vendor/tasks-vision isn't there.
async function loadMediaPipe() {
  const local = await fetch(`${MEDIAPIPE.wasmPath}/vision_wasm_internal.wasm`, { method: "HEAD" })
    .then((r) => r.ok).catch(() => false);
  const base = local ? MEDIAPIPE.localBundle : MEDIAPIPE.cdnBundle;
  ({ FaceLandmarker, HandLandmarker, PoseLandmarker, FilesetResolver } = await import(base));
  if (!local) console.info(`vendor/tasks-vision not found, using ${MEDIAPIPE.cdnBase}`);
  return local ? MEDIAPIPE.wasmPath : `${MEDIAPIPE.cdnBase}/wasm`;
}

// Strictly increasing timestamps, which MediaPipe's VIDEO mode requires.
function nextTs() {
  lastTs = Math.max(Math.round(performance.now()), lastTs + 1);
  return lastTs;
}

function loop() {
  requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  fpsFrames++;
  if (performance.now() - fpsSince > 1000) {
    fps = (fpsFrames * 1000) / (performance.now() - fpsSince);
    fpsFrames = 0;
    fpsSince = performance.now();
  }

  // Phone rotated, or the camera changed resolution: follow it.
  if (video.videoWidth && (video.videoWidth !== renderer.W || video.videoHeight !== renderer.H)) {
    renderer.resize(video.videoWidth, video.videoHeight);
  }
  const { W, H } = renderer;
  const frame = renderer.capture(video, mirror);
  const ts = nextTs();
  const fr = faceLandmarker.detectForVideo(frame, ts);
  const face = fr.faceLandmarks?.length ? new Face(fr.faceLandmarks[0], fr.faceBlendshapes?.[0], W, H, mirror) : null;

  if (calibration) {
    stepCalibration(face);
    return;
  }

  const hr = handLandmarker.detectForVideo(frame, ts);
  const pr = poseLandmarker.detectForVideo(frame, ts);
  const hands = (hr.landmarks || []).map((l) => new Hand(l, W, H));
  const body = pr.landmarks?.length ? new Body(pr.landmarks[0], W, H) : null;

  const now = performance.now();
  if (face) {
    lastFace = face;
    lastFaceAt = now;
  }
  const gesture = motion.update(hands, face, now);
  // Face lost while your hands are up (covering it, or blurring past it): carry
  // on with where it was a moment ago, for hand poses only. Expressions are unknown.
  const ghost = !face && lastFace && now - lastFaceAt < FACE_MEMORY_MS && (hands.length || waving(gesture))
    ? Object.assign(Object.create(Face.prototype), lastFace, { ghost: true })
    : null;
  const m = face ? measure(face, base) : {};
  const tongue = face ? tongueScore(renderer.fctx, face, hands, over("tongue_jaw", m, "z_jaw", "jaw")) : 0;
  const raw = decide(face || ghost, hands, body, tongue, gesture, m);
  const shown = tracker.update(raw, now);

  renderer.track(face);
  renderer.compose(shown ? assets[shown] : null, now - tracker.shownSince);
  if (debugOn()) {
    renderer.drawDebug(debugLayer, face, hands, body);
    drawHud(shown, raw, face || ghost, hands, body, m, tongue, gesture);
  }
}

const debugOn = () => !hud.classList.contains("hidden");

function setDebug(on) {
  hud.classList.toggle("hidden", !on);
  debugLayer.classList.toggle("hidden", !on);
  debugBtn.setAttribute("aria-pressed", String(on));
  if (!on) debugLayer.getContext("2d").clearRect(0, 0, debugLayer.width, debugLayer.height);
}

// ---- mirror ----------------------------------------------------------------

function loadMirror() {
  try {
    const v = localStorage.getItem("itsgiving.mirror");
    return v === null ? MIRROR_DEFAULT : v === "1";
  } catch {
    return MIRROR_DEFAULT;
  }
}

function setMirror(on) {
  mirror = on;
  mirrorToggle.checked = on;
  try { localStorage.setItem("itsgiving.mirror", on ? "1" : "0"); } catch { /* not persisted */ }
  // Positions jump to the other side; don't let that read as a fast gesture.
  motion.reset();
}

// ---- calibration ---------------------------------------------------------

function startCalibration() {
  if (calibration || boothRunning || !faceLandmarker) return;
  calibration = { collector: new Collector(), start: performance.now(), seen: 0 };
  calibrateBtn.disabled = true;
  startBoothBtn.disabled = true;
  setStatus(`Hold a bored face for ${CALIB.seconds} seconds. Blinking is fine — don't talk, smile or raise your eyebrows.`);
}

function stepCalibration(face) {
  const c = calibration;
  const elapsed = (performance.now() - c.start) / 1000;
  if (face) {
    c.seen++;
    if (elapsed > CALIB.warmup && Object.keys(face.bs).length) c.collector.add(face);
  }
  renderer.compose(null, 0);
  // Normally done at CALIB.seconds; a slow machine keeps going until it has enough frames.
  const enough = c.collector.n >= CALIB.minSamples;
  const progress = enough ? elapsed / CALIB.seconds : Math.min(elapsed / CALIB.seconds, c.collector.n / CALIB.minSamples);
  renderer.drawCalibration(progress, c.collector.n, !!face);
  if (elapsed < CALIB.seconds || (!enough && elapsed < CALIB.maxSeconds)) return;

  calibration = null;
  calibrateBtn.disabled = false;
  startBoothBtn.disabled = false;
  if (c.collector.n < CALIB.minSamples) {
    setStatus(`Calibration failed: only ${c.collector.n} usable frames${c.seen ? "" : " — your face was never detected"}. ` +
      "Light your face from the front, sit head-and-shoulders in frame, and try again.");
    return;
  }
  base = c.collector.finish();
  base.save();
  tracker.reset();
  motion.reset();
  const warn = calibrationWarnings(base);
  setStatus(warn.length
    ? `Calibrated on ${base.samples} frames, but ${warn.join("; ")}. Consider recalibrating.`
    : `Calibrated on ${base.samples} frames. Pull a face or throw up a hand sign!`);
}

// ---- debug HUD (press D) ------------------------------------------------

function drawHud(shown, raw, face, hands, body, m, tongue, gesture) {
  const f = (v, d = 1) => (v ?? 0).toFixed(d);
  const s = (v) => `${(v ?? 0) >= 0 ? "+" : ""}${f(v)}σ`;
  hud.textContent = [
    `showing: ${shown || "-"}   raw: ${raw || "-"}   face: ${face ? (face.ghost ? "hidden" : "yes") : "no"}   hands: ${hands.length}   ` +
      `elbows up: ${body?.elbowsUp ? "Y" : "n"}   ${fps.toFixed(0)} fps   ${mirror ? "mirrored" : "true view"}`,
    `jaw ${f(m.jaw, 2)} = ${s(m.z_jaw)} / ${Z.jaw_open}   squint ${f(m.squint, 2)} = ${s(m.z_squint)} / ${Z.squint}   ` +
      `tongue ${f(tongue, 2)}   turn ${f(m.turn, 2)}   wave ${f(gesture.speed)}/${GESTURE.speed} fw/s, ${gesture.swings}/${GESTURE.minSwings} swings`,
    `disgust ${s(m.z_disgust)} / ${Z.disgust} = 2x sneer ${s(m.z_sneer)} + brow ${s(m.z_brow)} + frown ${s(m.z_frown)} + lip ${s(m.z_lip)} + stretch ${s(m.z_stretch)}   smile ${f(m.smile, 2)}`,
    base.generic ? "NOT CALIBRATED — generic baseline. Press C." : `calibrated ${base.made} on ${base.samples} frames`,
    `keys: D debug   C calibrate   M mirror   test: ${POSES.map((p, i) => `${TEST_KEYS[i]} ${p}`).join("  ")}`,
  ].join("\n");
}

// ---- photobooth --------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBooth() {
  if (boothRunning || calibration) return;
  boothRunning = true;
  startBoothBtn.disabled = calibrateBtn.disabled = downloadBtn.disabled = true;
  stripPreview.innerHTML = "";
  stripPhotos = [];

  const { photoCount, countdownSeconds, delayBetweenPhotosMs } = PHOTOBOOTH_CONFIG.boothSequence;
  for (let i = 0; i < photoCount; i++) {
    const slot = document.createElement("div");
    slot.className = "slot";
    slot.textContent = `Photo ${i + 1}`;
    stripPreview.appendChild(slot);
  }

  for (let i = 0; i < photoCount; i++) {
    setStatus(`Get ready for photo ${i + 1} of ${photoCount}!`);
    countdownOverlay.classList.remove("hidden");
    for (let n = countdownSeconds; n > 0; n--) {
      countdownOverlay.textContent = n;
      await sleep(1000);
    }
    countdownOverlay.textContent = "CHEESE!";
    const shot = document.createElement("canvas");
    shot.width = canvas.width;
    shot.height = canvas.height;
    shot.getContext("2d").drawImage(canvas, 0, 0);
    stripPhotos.push(shot);

    const img = document.createElement("img");
    img.alt = `Photo ${i + 1}`;
    img.src = shot.toDataURL("image/jpeg", 0.9);
    stripPreview.children[i].replaceWith(img);
    await sleep(300);
    countdownOverlay.classList.add("hidden");
    if (i < photoCount - 1) await sleep(delayBetweenPhotosMs);
  }

  setStatus("Photo strip complete! Download it, or go again.");
  boothRunning = false;
  startBoothBtn.disabled = calibrateBtn.disabled = downloadBtn.disabled = false;
  if (IS_PHONE) downloadBtn.textContent = "Save / share strip";
}

function downloadStrip() {
  if (!stripPhotos.length) return;
  const w = 600, pad = 24, gap = 16, footer = 70;
  const h = Math.round((w * stripPhotos[0].height) / stripPhotos[0].width);
  const out = document.createElement("canvas");
  out.width = w + pad * 2;
  out.height = pad + stripPhotos.length * (h + gap) - gap + footer;
  const g = out.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, out.width, out.height);
  stripPhotos.forEach((p, i) => g.drawImage(p, pad, pad + i * (h + gap), w, h));
  g.fillStyle = "#0f172a";
  g.font = "800 28px 'Plus Jakarta Sans', sans-serif";
  g.textAlign = "center";
  g.fillText("IT'S GIVING…", out.width / 2, out.height - footer / 2 + 4);
  g.fillStyle = "#94a3b8";
  g.font = "600 14px 'Plus Jakarta Sans', sans-serif";
  g.fillText(new Date().toLocaleDateString(), out.width / 2, out.height - footer / 2 + 26);

  out.toBlob(async (blob) => {
    const name = `its-giving-strip-${Date.now()}.jpg`;
    // On a phone the share sheet is nicer: "Save Image" puts it straight in Photos.
    if (IS_PHONE && navigator.canShare) {
      const file = new File([blob], name, { type: "image/jpeg" });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "It's giving…" });
          return;
        } catch (e) {
          if (e.name === "AbortError") return;   // they closed the sheet
        }
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, "image/jpeg", 0.92);
}

// ---- wiring -------------------------------------------------------------

calibrateBtn.addEventListener("click", startCalibration);
startBoothBtn.addEventListener("click", runBooth);
downloadBtn.addEventListener("click", downloadStrip);
debugBtn.addEventListener("click", () => setDebug(!debugOn()));
for (const p of POSES) {
  const opt = document.createElement("option");
  opt.value = p;
  opt.textContent = p.replace(/_/g, " ");
  testPose.appendChild(opt);
}
testPose.addEventListener("change", () => {
  if (testPose.value) tracker.force(testPose.value, performance.now());
  testPose.value = "";
});
mirrorToggle.checked = mirror;
mirrorToggle.addEventListener("change", () => setMirror(mirrorToggle.checked));

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "d") setDebug(!debugOn());
  else if (k === "c") startCalibration();
  else if (k === "m") setMirror(!mirror);
  else {
    const i = TEST_KEYS.indexOf(k);
    if (i >= 0 && i < POSES.length) tracker.force(POSES[i], performance.now());
  }
});

init();
