import { ASSETS, CALIB, GESTURE, GROUP_DEFAULT, IS_PHONE, MEDIAPIPE, MIRROR_DEFAULT, PEOPLE, PHOTOBOOTH_CONFIG, POSES, TEST_KEYS, Z } from "./config.js";
import { Baseline, Collector, calibrationWarnings } from "./calibration.js";
import { Body, Face, Hand, PoseTracker, decide, measure, over, tongueScore, waving } from "./face.js";
import { People } from "./people.js";
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
const groupToggle = $("groupToggle");
const debugBtn = $("debugBtn");
const testPose = $("testPose");

const renderer = new OverlayRenderer(canvas);
const people = new People();
// "spin" (everyone left the frame) belongs to nobody, so it has its own tracker.
const roomTracker = new PoseTracker();
let base = Baseline.load();        // saved calibration (the main person's)
const GENERIC = new Baseline();    // for people nobody calibrated
let lastSpot = null;               // where the last person was, for the spin meme
let faceLandmarker = null, handLandmarker = null, poseLandmarker = null;
let FaceLandmarker, HandLandmarker, PoseLandmarker, FilesetResolver;
let mirror = loadMirror();
let group = loadPref("itsgiving.group", GROUP_DEFAULT);
let reconfiguring = false;   // true while the detectors switch between group and solo
let assets = {};
let lastVideoTime = -1;
let lastTs = -1;
let calibration = null;   // { collectors: Map(personId -> Collector), start, seen } while calibrating
let boothRunning = false;
let stripPhotos = [];
let fps = 0, fpsFrames = 0, fpsSince = performance.now();
let frameNo = 0, lastBodies = [];

const setStatus = (msg) => { statusText.textContent = msg; };

function readyStatus() {
  return base.generic
    ? "Ready — not calibrated yet, so reactions are harder to trigger. Click 'Calibrate Face' first."
    : `Ready — calibrated ${base.made} on ${base.samples} frames. Pull a face! (Friends joining? Calibrate with everyone in frame.)`;
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

  // Ask for the camera straight away and load the models alongside it, so the
  // permission prompt appears immediately and you see yourself while they load.
  setStatus("Starting the camera…");
  const models = loadModels();
  models.catch(() => {});   // handled below; don't report it twice

  try {
    await startCamera();
  } catch (err) {
    console.error("Camera error:", err);
    const name = err?.name || "";
    if (name === "NotAllowedError") setStatus("Camera permission was denied. Allow camera access for this page and reload.");
    else if (name === "NotFoundError") setStatus("No camera found. Plug one in and reload.");
    else if (name === "NotReadableError") setStatus("The camera is busy in another app (Zoom, OBS, the Python version?). Close it and reload.");
    else setStatus(`Couldn't start the camera: ${err?.message || err}`);
    return;
  }
  requestAnimationFrame(loop);
  if (!faceLandmarker) setStatus("Camera on — loading the face, hand and body models (the first visit downloads about 40 MB)…");

  try {
    await models;
  } catch (err) {
    console.error("Model loading error:", err);
    setStatus(`Couldn't load the models: ${err?.message || err}. Check your connection and reload.`);
    return;
  }
  calibrateBtn.disabled = false;
  startBoothBtn.disabled = false;
  setStatus(readyStatus());
}

async function startCamera() {
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
}

async function loadModels() {
  const wasmPath = await loadMediaPipe();
  const fileset = await FilesetResolver.forVisionTasks(wasmPath);
  const [loadedAssets, face, hand, pose] = await Promise.all([
    loadAssets(ASSETS),
    create(FaceLandmarker, fileset, MEDIAPIPE.faceModel, { numFaces: counts().faces, outputFaceBlendshapes: true }),
    create(HandLandmarker, fileset, MEDIAPIPE.handModel, { numHands: counts().hands }),
    create(PoseLandmarker, fileset, MEDIAPIPE.poseModel, { numPoses: counts().faces }),
  ]);
  // The first detection compiles GPU programs and can stall for a moment; do it
  // on a blank frame now rather than on the first live one.
  const warm = document.createElement("canvas");
  warm.width = 320;
  warm.height = 240;
  warm.getContext("2d").fillRect(0, 0, 320, 240);
  for (const lm of [face, hand, pose]) lm.detectForVideo(warm, nextTs());
  // Only now hand them to the render loop, all at once.
  assets = loadedAssets;
  [faceLandmarker, handLandmarker, poseLandmarker] = [face, hand, pose];
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
  if (!faceLandmarker || reconfiguring) {   // models loading / switching: just show the camera
    renderer.compose([]);
    return;
  }
  const ts = nextTs();
  const now = performance.now();
  const fr = faceLandmarker.detectForVideo(frame, ts);
  const faces = (fr.faceLandmarks || []).map((l, i) => new Face(l, fr.faceBlendshapes?.[i], W, H, mirror));

  if (calibration) {
    people.update(faces, [], [], now);
    stepCalibration(now);
    return;
  }

  const hr = handLandmarker.detectForVideo(frame, ts);
  const hands = (hr.landmarks || []).map((l) => new Hand(l, W, H));
  if (frameNo++ % PEOPLE.poseEvery === 0) {
    const pr = poseLandmarker.detectForVideo(frame, ts);
    lastBodies = (pr.landmarks || []).map((l) => new Body(l, W, H));
  }
  const bodies = lastBodies;
  people.update(faces, hands, bodies, now);

  // Each person gets judged on their own face, hands and body, with their own meme.
  const overlays = [];
  for (const p of people.list) {
    const gesture = p.motion.update(p.hands, p.face, now);
    // Face hidden behind hands, or blurring past: keep judging hand poses on where it was.
    const face = p.faceOrGhost(p.hands.length > 0 || waving(gesture));
    const b = baselineFor(p);
    const m = p.face ? measure(p.face, b) : {};
    const tongue = p.face ? tongueScore(renderer.fctx, p.face, p.hands, over("tongue_jaw", m, "z_jaw", "jaw")) : 0;
    const raw = face ? decide(face, p.hands, p.body, tongue, gesture, m) : null;
    const shown = p.tracker.update(raw, now);
    p.debug = { raw, shown, m, tongue, gesture, ghost: !p.face && !!face };
    if (shown) overlays.push({ asset: assets[shown], elapsed: now - p.tracker.shownSince, center: p.center, faceH: p.faceH });
    lastSpot = { center: [...p.center], faceH: p.faceH };
  }

  // Everyone gone (no faces, hands or bodies): spin, where the last person was.
  const empty = !people.list.length && !hands.length && !bodies.some((b) => b.seen);
  const roomShown = roomTracker.update(empty ? "spin" : null, now);
  if (roomShown && !people.list.length && lastSpot) {
    overlays.push({ asset: assets[roomShown], elapsed: now - roomTracker.shownSince, ...lastSpot });
  }

  renderer.compose(overlays);
  if (debugOn()) {
    const claimed = new Set(people.list.flatMap((p) => p.hands));
    renderer.drawDebug(debugLayer, people.list, hands.filter((h) => !claimed.has(h)), bodies);
    drawHud(people.list, hands.length, roomShown);
  }
}

/** Your own calibration if you were in frame for it; otherwise the saved one when you're alone. */
function baselineFor(p) {
  if (p.baseline) return p.baseline;
  return people.list.length === 1 ? base : GENERIC;
}

/** "Preview a meme": show it on everyone in frame (or where the last person was). */
function forcePose(pose) {
  const now = performance.now();
  for (const p of people.list) p.tracker.force(pose, now);
  roomTracker.force(pose, now);
}

const debugOn = () => !hud.classList.contains("hidden");

function setDebug(on) {
  hud.classList.toggle("hidden", !on);
  debugLayer.classList.toggle("hidden", !on);
  debugBtn.setAttribute("aria-pressed", String(on));
  if (!on) debugLayer.getContext("2d").clearRect(0, 0, debugLayer.width, debugLayer.height);
}

// ---- group mode ----------------------------------------------------------
// MediaPipe only skips its search for new faces / hands once it is tracking the
// most it was asked for, so allowing 4 people costs a little every frame even
// when you're alone. Group mode off goes back to the one-person setup.

function counts() {
  return group ? { faces: PEOPLE.max, hands: PEOPLE.hands } : { faces: 1, hands: 2 };
}

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

async function setGroup(on) {
  group = on;
  groupToggle.checked = on;
  people.max = counts().faces;
  people.reset();
  try { localStorage.setItem("itsgiving.group", on ? "1" : "0"); } catch { /* not persisted */ }
  if (!faceLandmarker) return;   // models not loaded yet: they'll be created with the right counts
  reconfiguring = true;
  try {
    const { faces, hands } = counts();
    await Promise.all([
      faceLandmarker.setOptions({ numFaces: faces }),
      handLandmarker.setOptions({ numHands: hands }),
      poseLandmarker.setOptions({ numPoses: faces }),
    ]);
  } finally {
    reconfiguring = false;
  }
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
  // Positions jump to the other side; start tracking everyone afresh.
  people.reset();
}

// ---- calibration ---------------------------------------------------------

function startCalibration() {
  if (calibration || boothRunning || !faceLandmarker) return;
  calibration = { collectors: new Map(), start: performance.now(), seen: 0 };
  calibrateBtn.disabled = true;
  startBoothBtn.disabled = true;
  setStatus(`Everyone in frame: hold a bored face for ${CALIB.seconds} seconds. Blinking is fine — don't talk, smile or raise your eyebrows.`);
}

// Calibrates everyone in frame at once: each person gets their own neutral face.
function stepCalibration(now) {
  const c = calibration;
  const elapsed = (now - c.start) / 1000;
  if (people.list.some((p) => p.face)) c.seen++;
  if (elapsed > CALIB.warmup) {
    for (const p of people.list) {
      if (!p.face || !Object.keys(p.face.bs).length) continue;
      if (!c.collectors.has(p.id)) c.collectors.set(p.id, new Collector());
      c.collectors.get(p.id).add(p.face);
    }
  }
  const most = Math.max(0, ...[...c.collectors.values()].map((k) => k.n));
  renderer.compose([]);
  // Normally done at CALIB.seconds; a slow machine keeps going until it has enough frames.
  const enough = most >= CALIB.minSamples;
  const progress = enough ? elapsed / CALIB.seconds : Math.min(elapsed / CALIB.seconds, most / CALIB.minSamples);
  renderer.drawCalibration(progress, most, people.list.some((p) => p.face), people.list.filter((p) => p.face).length);
  if (elapsed < CALIB.seconds || (!enough && elapsed < CALIB.maxSeconds)) return;

  calibration = null;
  calibrateBtn.disabled = false;
  startBoothBtn.disabled = false;
  // Everyone still in frame with enough frames gets their own baseline.
  const done = [];
  // (A slow phone that ran out of time still counts with fewer frames.)
  const need = enough ? CALIB.minSamples : CALIB.minSamplesSlow;
  for (const p of people.list) {
    const k = c.collectors.get(p.id);
    if (k && k.n >= need) {
      p.baseline = k.finish();
      done.push(p);
    }
  }
  if (!done.length) {
    setStatus(`Calibration failed: only ${most} usable frames${c.seen ? "" : " — no face was detected"}. ` +
      "Light your face from the front, sit head-and-shoulders in frame, and try again.");
    return;
  }
  // The biggest face (closest to the camera) is saved for next time.
  const main = done.reduce((a, b) => (b.faceH > a.faceH ? b : a));
  base = main.baseline;
  base.save();
  for (const p of people.list) {
    p.tracker.reset();
    p.motion.reset();
  }
  const warn = calibrationWarnings(base);
  const who = done.length > 1 ? `${done.length} people` : `on ${base.samples} frames`;
  setStatus(warn.length
    ? `Calibrated ${who}, but ${warn.join("; ")}. Consider recalibrating.`
    : `Calibrated ${who}. Pull a face or throw up a hand sign!`);
}

// ---- debug HUD (press D) ------------------------------------------------

function drawHud(list, handCount, roomShown) {
  const f = (v, d = 1) => (v ?? 0).toFixed(d);
  const s = (v) => `${(v ?? 0) >= 0 ? "+" : ""}${f(v)}σ`;
  const lines = [
    `people: ${list.length}/${people.max}${group ? "" : " (group mode off)"}   hands: ${handCount}   ${fps.toFixed(0)} fps   ${mirror ? "mirrored" : "true view"}` +
      (roomShown ? `   room: ${roomShown}` : ""),
  ];
  list.forEach((p, i) => {
    const d = p.debug || {}, m = d.m || {}, g = d.gesture || { speed: 0, swings: 0 };
    const b = baselineFor(p);
    lines.push(
      `P${i + 1} showing: ${d.shown || "-"}   raw: ${d.raw || "-"}   face: ${p.face ? "yes" : d.ghost ? "hidden" : "no"}   ` +
        `hands: ${p.hands.length}   elbows up: ${p.body?.elbowsUp ? "Y" : "n"}   ` +
        `${p.baseline ? "own calibration" : b.generic ? "NOT calibrated" : "saved calibration"}`,
    );
    if (i === 0 || list.length <= 2) {
      lines.push(
        `   jaw ${f(m.jaw, 2)} = ${s(m.z_jaw)} / ${Z.jaw_open}   squint ${f(m.squint, 2)} = ${s(m.z_squint)} / ${Z.squint}   ` +
          `tongue ${f(d.tongue, 2)}   turn ${f(m.turn, 2)}   wave ${f(g.speed)}/${GESTURE.speed} fw/s, ${g.swings}/${GESTURE.minSwings} swings`,
        `   disgust ${s(m.z_disgust)} / ${Z.disgust} = 2x sneer ${s(m.z_sneer)} + brow ${s(m.z_brow)} + frown ${s(m.z_frown)} + lip ${s(m.z_lip)} + stretch ${s(m.z_stretch)}   smile ${f(m.smile, 2)}`,
      );
    }
  });
  lines.push(`keys: D debug   C calibrate   M mirror   test: ${POSES.map((p, i) => `${TEST_KEYS[i]} ${p}`).join("  ")}`);
  hud.textContent = lines.join("\n");
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
  if (testPose.value) forcePose(testPose.value);
  testPose.value = "";
});
mirrorToggle.checked = mirror;
groupToggle.checked = group;
people.max = counts().faces;
groupToggle.addEventListener("change", () => setGroup(groupToggle.checked));
mirrorToggle.addEventListener("change", () => setMirror(mirrorToggle.checked));

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "d") setDebug(!debugOn());
  else if (k === "c") startCalibration();
  else if (k === "m") setMirror(!mirror);
  else {
    const i = TEST_KEYS.indexOf(k);
    if (i >= 0 && i < POSES.length) forcePose(POSES[i]);
  }
});

init();
