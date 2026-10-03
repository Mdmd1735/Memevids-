// Tuning block — ported from its_giving_v2.py. Same names, same meaning.

// Checked top to bottom by decide(); first match wins. Put a new pose above
// anything it might be mistaken for.
export const POSES = [
  "time_out", "heart", "cover_nose", "crashing_out", "dance", "nose_closed", "flirty", "hand_up",
  "tongue_out", "open_mouth", "disgusted", "talking_to_wall", "suspicious", "spin",
];

// One file per pose in assets/. Missing or unreadable -> red placeholder.
export const ASSETS = {
  time_out: "assets/time_out.jpeg",
  heart: "assets/heart.jpeg",
  cover_nose: "assets/cover_nose.jpeg",
  crashing_out: "assets/crashing_out.jpeg",
  dance: "assets/dance.jpeg",
  nose_closed: "assets/nose_closed.gif",
  flirty: "assets/flirty.jpeg",
  hand_up: "assets/hand_up.jpeg",
  tongue_out: "assets/tongue_out.jpeg",
  open_mouth: "assets/open_mouth.jpeg",
  disgusted: "assets/disgusted.jpeg",
  talking_to_wall: "assets/talking_to_wall.gif",
  suspicious: "assets/suspicious.jpeg",
  spin: "assets/spin.gif",
};

// One key per pose, matched by position in POSES: forces it on screen for 2 s.
export const TEST_KEYS = "1234567890-=[]";

// Meme size and placement. The meme sits on the top of your head so your mouth
// and chin stay visible (you can see your own gasp / tongue next to the meme).
export const MEME = {
  scale: 1.0,    // meme height = your face height x this (was 2.0, which covered the whole face)
  bottom: 0.1,   // the meme's bottom edge sits this far below the middle of your face, in face heights
                 // (0.1 is about your nose tip; raise it to cover more of the face, lower it to show more)
};
export const HOLD_FRAMES = 10;     // linger after the pose stops
export const ARM = {
  spin: 15, suspicious: 8, talking_to_wall: 6, dance: 6, crashing_out: 4,
  open_mouth: 4, tongue_out: 5, disgusted: 5,
};
export const DEFAULT_ARM = 3;

// Sigma above your own neutral face.
// sneer / disgust are lower than the Python's (4.5 / 14): MediaPipe's nose-scrunch
// channel barely moves for most faces, so the old bar was close to unreachable.
export const Z = { jaw_open: 6.0, scream_jaw: 3.5, tongue_jaw: 2.0, sneer: 3.0, disgust: 9.0, squint: 4.0 };
export const Z_CAP = 8.0;
// Before you calibrate, faces vary too much for the lower bar: use the old one.
export const Z_DISGUST_UNCALIBRATED = 14.0;
// ...and a raw floor, so a tiny sigma can't become a hair trigger.
// tongue_jaw is low on purpose: sticking your tongue out barely opens the jaw.
export const FLOOR = { jaw_open: 0.30, scream_jaw: 0.18, tongue_jaw: 0.08, sneer: 0.04, squint: 0.18 };
// tongue: share of the mouth opening (top half included) that is tongue-coloured.
export const T = { tongue: 0.65, head_turn: 0.15, smile: 0.35 };

// talking_to_wall: big, repeated back-and-forth hand movement, not just a hand
// that moves. Distances are in face widths, so it works at any distance; times
// are in seconds, so it behaves the same at 10 fps on a phone or 30 on a laptop.
export const GESTURE = {
  window: 1.5,      // look at the last 1.5 s of hand movement
  jitter: 0.02,     // ignore per-frame wobble smaller than this (tracking noise)
  swing: 0.35,      // a "swing" is a move of at least this far before reversing
  minSwings: 2,     // ...and you need this many in the window (there-and-back, twice)
  speed: 1.5,       // ...with the hand covering at least this many face widths per second
  gap: 0.4,         // fast hands blur and drop out for a frame or two; keep the history this long
};

// Hands over your face often make the face detector lose it. Remember where the
// face was for this long, so hand poses (cover_nose especially) still work.
export const FACE_MEMORY_MS = 700;

export const CALIB = {
  seconds: 5.0,          // Python uses 7; shorter suits a photobooth
  warmup: 1.0,           // ignore the first second while you settle
  minSamples: 30,
  maxSeconds: 12.0,      // slow machines keep collecting past `seconds` until minSamples
  sigmaFloor: 0.015,
  sigmaCeil: 0.080,
  version: 1,
  storageKey: "itsgiving.calibration.v1",
};

export const GENERIC_SIGMA = 0.035;
export const GENERIC_MEAN = {
  jawOpen: 0.08, eyeSquintLeft: 0.10, eyeSquintRight: 0.10,
  eyeBlinkLeft: 0.10, eyeBlinkRight: 0.10, noseSneerLeft: 0.03, noseSneerRight: 0.03,
  browDownLeft: 0.06, browDownRight: 0.06, mouthFrownLeft: 0.05, mouthFrownRight: 0.05,
  mouthUpperUpLeft: 0.05, mouthUpperUpRight: 0.05, mouthStretchLeft: 0.08, mouthStretchRight: 0.08,
};

// Mirror the camera like a selfie (default) or show the true view, where text
// on your shirt reads correctly. Toggle in the page; remembered per browser.
export const MIRROR_DEFAULT = true;

// Phones / tablets (touch-first) get a lighter setup: smaller camera frames and
// GIF frames, so three detectors and ~150 MB of GIF frames don't choke Safari.
export const IS_PHONE = matchMedia("(pointer: coarse)").matches;

export const PHOTOBOOTH_CONFIG = {
  camera: IS_PHONE ? { width: 640, height: 480 } : { width: 1280, height: 720 },
  gifMaxSize: IS_PHONE ? 320 : 0,   // longest side of decoded GIF frames; 0 = full size
  boothSequence: { photoCount: 4, countdownSeconds: 3, delayBetweenPhotosMs: 1200 },
};

// Pinned and served locally from vendor/ — same reasoning as requirements.txt.
const TASKS_VISION = "1.0.1";
export const MEDIAPIPE = {
  wasmPath: "vendor/tasks-vision/wasm",
  localBundle: "../vendor/tasks-vision/vision_bundle.mjs",   // relative to js/
  cdnBase: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION}`,
  get cdnBundle() { return `${this.cdnBase}/vision_bundle.mjs`; },
  faceModel: "models/face_landmarker.task",
  handModel: "models/hand_landmarker.task",
  poseModel: "models/pose_landmarker_lite.task",
};
