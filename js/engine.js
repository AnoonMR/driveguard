// Driver drowsiness & stress detection engine.
// Pure logic (no DOM) so it can be unit-tested in Node and reused in the browser.

export const DEFAULT_SETTINGS = Object.freeze({
  // Drowsiness — eyes
  earThreshold: 0.21,        // Eye Aspect Ratio below this = eyes closed
  eyeClosedSec: 1.5,         // continuous closure that triggers a microsleep alert
  perclosThreshold: 0.30,    // fraction of time eyes closed in the window
  perclosWindowSec: 60,
  // Drowsiness — yawning
  marThreshold: 0.60,        // Mouth Aspect Ratio above this = mouth wide open
  yawnMinSec: 1.2,           // mouth must stay open this long to count as a yawn
  yawnCountThreshold: 3,     // yawns within the window that trigger a fatigue alert
  yawnWindowSec: 120,
  // Drowsiness — head / attention
  noFaceSec: 4,              // face lost (head dropped / looking away) for this long; 0 = off
  // Stress
  stressThreshold: 60,       // stress score (0-100) that counts as stressed
  stressSustainSec: 3,       // score must stay above threshold this long
  stressSensitivity: 1.0,    // multiplier on the raw stress score
  blinkRateHigh: 30,         // blinks/min above this adds to stress
  // Alerts
  alertCooldownSec: 6,
  soundOn: true,
  voiceOn: false,
});

// MediaPipe Face Mesh landmark indices
export const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
export const LEFT_EYE = [362, 385, 387, 263, 373, 380];
export const MOUTH = { top: 13, bottom: 14, left: 78, right: 308 };
export const CHEEKS = [234, 454];
export const NOSE_TIP = 1;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// Landmarks are normalised to [0,1] per axis, so scale by the frame size
// before measuring distances, otherwise the aspect ratio skews the result.
export function dist(a, b, w = 1, h = 1) {
  return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
}

// Eye Aspect Ratio (Soukupová & Čech, 2016)
export function eyeAspectRatio(lm, idx, w = 1, h = 1) {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
  const horiz = dist(p1, p4, w, h);
  if (!horiz) return 0;
  return (dist(p2, p6, w, h) + dist(p3, p5, w, h)) / (2 * horiz);
}

export function mouthAspectRatio(lm, w = 1, h = 1) {
  const horiz = dist(lm[MOUTH.left], lm[MOUTH.right], w, h);
  if (!horiz) return 0;
  return dist(lm[MOUTH.top], lm[MOUTH.bottom], w, h) / horiz;
}

// Turn one MediaPipe result into the compact frame the engine consumes.
export function extractFrame(landmarks, blendshapeCategories, w, h) {
  const blend = {};
  for (const c of blendshapeCategories || []) blend[c.categoryName] = c.score;
  const earL = eyeAspectRatio(landmarks, LEFT_EYE, w, h);
  const earR = eyeAspectRatio(landmarks, RIGHT_EYE, w, h);
  return {
    ear: (earL + earR) / 2,
    mar: mouthAspectRatio(landmarks, w, h),
    blend,
    nose: { x: landmarks[NOSE_TIP].x * w, y: landmarks[NOSE_TIP].y * h },
    faceWidth: dist(landmarks[CHEEKS[0]], landmarks[CHEEKS[1]], w, h),
  };
}

const STRESS_FEATURES = {
  // name: [blendshapes averaged, value treated as "full", weight]
  browFurrow: [['browDownLeft', 'browDownRight'], 0.5, 0.30],
  browRaise: [['browInnerUp'], 0.5, 0.15],
  lipPress: [['mouthPressLeft', 'mouthPressRight'], 0.4, 0.20],
  frown: [['mouthFrownLeft', 'mouthFrownRight'], 0.3, 0.10],
  squint: [['eyeSquintLeft', 'eyeSquintRight'], 0.5, 0.10],
  sneer: [['noseSneerLeft', 'noseSneerRight'], 0.3, 0.05],
};
const BLINK_WEIGHT = 0.05;
const JITTER_WEIGHT = 0.05;
// A genuine smile also raises cheeks (eye squint) and lowers brows, which would
// otherwise read as tension. Smiling dampens those features and the total score.
const SMILE_KEYS = ['mouthSmileLeft', 'mouthSmileRight'];
const SMILE_FULL = 0.5;
const SMILE_MASKED = ['squint', 'browFurrow'];
const BLEND_KEYS = [...new Set([...Object.values(STRESS_FEATURES).flatMap((f) => f[0]), ...SMILE_KEYS])];

export class DetectionEngine {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.baseline = { blend: {}, ear: null };
    this.reset();
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
  }

  reset() {
    this.lastT = null;
    this.closedSince = null;
    this.microsleepFired = false;
    this.eyeSamples = [];      // {t, dt, closed}
    this.blinks = [];          // timestamps (ms)
    this.mouthOpenSince = null;
    this.yawns = [];           // timestamps (ms)
    this.yawnAlertedAt = -Infinity;
    this.noses = [];           // {t, x, y, fw}
    this.stressScore = 0;
    this.stressSince = null;
    this.stressFired = false;
    this.lastFaceT = null;
    this.noFaceFired = false;
    this.lastAlert = {};
    this.startT = null;
    this.calib = null;
    this.state = this._emptyState();
  }

  _emptyState() {
    return {
      face: false, ear: 0, mar: 0, eyesClosed: false, closedFor: 0,
      perclos: 0, blinkRate: 0, yawnCount: 0, drowsyScore: 0,
      stressScore: 0, stressFeatures: {}, calibrating: false,
    };
  }

  // --- calibration -------------------------------------------------------
  startCalibration(t, durationSec = 5) {
    this.calib = { start: t, end: t + durationSec * 1000, ears: [], blends: [] };
  }

  _calibrate(t, f) {
    const c = this.calib;
    c.ears.push(f.ear);
    c.blends.push(f.blend);
    if (t < c.end) return null;
    this.calib = null;
    if (c.ears.length < 5) return { ok: false, reason: 'Not enough face samples — keep your face in view.' };
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const blend = {};
    for (const k of BLEND_KEYS) blend[k] = mean(c.blends.map((b) => b[k] || 0));
    const ear = mean(c.ears);
    this.baseline = { blend, ear };
    const suggestedEar = Math.round(clamp(ear * 0.75, 0.1, 0.4) * 100) / 100;
    return { ok: true, baselineEar: ear, suggestedEar };
  }

  // --- main update -------------------------------------------------------
  // frame: output of extractFrame(), or null when no face was found.
  // t: timestamp in ms.  Returns { state, events, calibration }.
  update(frame, t) {
    const s = this.settings;
    const events = [];
    let calibration = null;
    if (this.startT === null) this.startT = t;
    const dt = this.lastT === null ? 0 : Math.min(t - this.lastT, 250);
    this.lastT = t;

    if (!frame) {
      this._handleNoFace(t, events);
      this.state = { ...this.state, face: false, calibrating: !!this.calib };
      this._attachMetrics(events);
      return { state: this.state, events, calibration };
    }
    this.lastFaceT = t;
    this.noFaceFired = false;

    if (this.calib) calibration = this._calibrate(t, frame);

    // ---- eyes: closure, blinks, PERCLOS
    const closed = frame.ear < s.earThreshold;
    if (closed) {
      if (this.closedSince === null) this.closedSince = t;
    } else if (this.closedSince !== null) {
      const dur = t - this.closedSince;
      if (dur >= 50 && dur < s.eyeClosedSec * 1000) this.blinks.push(t);
      this.closedSince = null;
      this.microsleepFired = false;
    }
    const closedFor = this.closedSince === null ? 0 : (t - this.closedSince) / 1000;
    if (closedFor >= s.eyeClosedSec && !this.microsleepFired) {
      this.microsleepFired = true;
      this._emit(events, t, 'drowsy', 'Eyes closed',
        `Eyes closed for ${closedFor.toFixed(1)}s — possible microsleep!`);
    }

    this.eyeSamples.push({ t, dt, closed });
    const winStart = t - s.perclosWindowSec * 1000;
    while (this.eyeSamples.length && this.eyeSamples[0].t < winStart) this.eyeSamples.shift();
    let total = 0, closedTime = 0;
    for (const e of this.eyeSamples) { total += e.dt; if (e.closed) closedTime += e.dt; }
    const perclos = total > 0 ? closedTime / total : 0;
    // Only judge PERCLOS once a reasonable slice of the window has been observed.
    const perclosReady = total >= Math.min(10000, s.perclosWindowSec * 500);
    if (perclosReady && perclos >= s.perclosThreshold) {
      this._emit(events, t, 'drowsy', 'High PERCLOS',
        `Eyes closed ${(perclos * 100).toFixed(0)}% of the last ${s.perclosWindowSec}s — fatigue detected.`);
    }

    while (this.blinks.length && this.blinks[0] < t - 60000) this.blinks.shift();
    const observedSec = Math.max(5, Math.min(60, (t - this.startT) / 1000));
    const blinkRate = this.blinks.length * (60 / observedSec);

    // ---- mouth: yawns
    if (frame.mar > s.marThreshold) {
      if (this.mouthOpenSince === null) this.mouthOpenSince = t;
    } else if (this.mouthOpenSince !== null) {
      if (t - this.mouthOpenSince >= s.yawnMinSec * 1000) {
        this.yawns.push(t);
        events.push({ type: 'info', t, reason: 'Yawn', message: 'Yawn detected' });
      }
      this.mouthOpenSince = null;
    }
    while (this.yawns.length && this.yawns[0] < t - s.yawnWindowSec * 1000) this.yawns.shift();
    const yawnCount = this.yawns.length;
    if (yawnCount >= s.yawnCountThreshold && this.yawns[this.yawns.length - 1] > this.yawnAlertedAt) {
      if (this._emit(events, t, 'drowsy', 'Frequent yawning',
        `${yawnCount} yawns in the last ${Math.round(s.yawnWindowSec / 60 * 10) / 10} min — take a break.`)) {
        this.yawnAlertedAt = this.yawns[this.yawns.length - 1];
      }
    }

    const drowsyScore = 100 * clamp(Math.max(
      closedFor / s.eyeClosedSec,
      perclosReady ? perclos / s.perclosThreshold : 0,
      yawnCount / s.yawnCountThreshold,
    ));

    // ---- stress
    const { raw, features } = this._stressRaw(frame, t, blinkRate);
    const k = 1 - Math.exp(-dt / 800); // ~0.8s smoothing
    this.stressScore = dt === 0 ? raw : this.stressScore + (raw - this.stressScore) * k;
    if (this.stressScore >= s.stressThreshold) {
      if (this.stressSince === null) this.stressSince = t;
      if ((t - this.stressSince) / 1000 >= s.stressSustainSec && !this.stressFired) {
        if (this._emit(events, t, 'stress', 'Stress indicators',
          `Stress level ${Math.round(this.stressScore)}/100 sustained for ${s.stressSustainSec}s — breathe slowly, relax your grip.`)) {
          this.stressFired = true;
        }
      }
    } else if (this.stressScore < s.stressThreshold - 5) { // hysteresis
      this.stressSince = null;
      this.stressFired = false;
    }

    this.state = {
      face: true, ear: frame.ear, mar: frame.mar, eyesClosed: closed, closedFor,
      perclos, perclosReady, blinkRate, yawnCount, drowsyScore,
      stressScore: this.stressScore, stressFeatures: features, calibrating: !!this.calib,
    };
    this._attachMetrics(events);
    return { state: this.state, events, calibration };
  }

  _stressRaw(frame, t, blinkRate) {
    const s = this.settings;
    const features = {};
    const rel = (keys) => keys.reduce((a, key) => a + Math.max(0,
      (frame.blend[key] || 0) - (this.baseline.blend[key] || 0)), 0) / keys.length;
    const smile = clamp(rel(SMILE_KEYS) / SMILE_FULL);
    let sum = 0;
    for (const [name, [keys, full, weight]] of Object.entries(STRESS_FEATURES)) {
      let v = clamp(rel(keys) / full);
      if (SMILE_MASKED.includes(name)) v *= 1 - smile;
      features[name] = v;
      sum += v * weight;
    }
    features.blinkRate = clamp((blinkRate - s.blinkRateHigh) / s.blinkRateHigh);
    sum += features.blinkRate * BLINK_WEIGHT;

    // Head jitter: std-dev of nose position over 2s, relative to face width.
    this.noses.push({ t, x: frame.nose.x, y: frame.nose.y, fw: frame.faceWidth || 1 });
    while (this.noses.length && this.noses[0].t < t - 2000) this.noses.shift();
    let jitter = 0;
    if (this.noses.length > 5) {
      const n = this.noses.length;
      const mx = this.noses.reduce((a, p) => a + p.x, 0) / n;
      const my = this.noses.reduce((a, p) => a + p.y, 0) / n;
      const fw = this.noses.reduce((a, p) => a + p.fw, 0) / n;
      const sd = Math.sqrt(this.noses.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / n);
      jitter = clamp(sd / fw / 0.05);
    }
    features.headJitter = jitter;
    sum += jitter * JITTER_WEIGHT;

    features.smile = smile;
    return { raw: 100 * clamp(sum * s.stressSensitivity * (1 - 0.5 * smile)), features };
  }

  _handleNoFace(t, events) {
    const s = this.settings;
    this.closedSince = null;
    this.mouthOpenSince = null;
    this.stressSince = null;
    if (this.lastFaceT === null || !s.noFaceSec) return;
    const lost = (t - this.lastFaceT) / 1000;
    if (lost >= s.noFaceSec && !this.noFaceFired) {
      this.noFaceFired = true;
      this._emit(events, t, 'drowsy', 'Face not visible',
        `Face not visible for ${lost.toFixed(1)}s — head dropped or looking away?`);
    }
  }

  // Emits an alert unless the same alert type is still in cooldown.
  _emit(events, t, type, reason, message) {
    const last = this.lastAlert[type];
    if (last !== undefined && t - last < this.settings.alertCooldownSec * 1000) return false;
    this.lastAlert[type] = t;
    events.push({ type, t, reason, message });
    return true;
  }

  _attachMetrics(events) {
    const st = this.state;
    for (const e of events) {
      if (e.type === 'info') continue;
      e.metrics = {
        face: st.face,
        ear: +st.ear.toFixed(3),
        mar: +st.mar.toFixed(3),
        perclos: +st.perclos.toFixed(3),
        blinkRate: Math.round(st.blinkRate),
        yawns: st.yawnCount,
        drowsy: Math.round(st.drowsyScore),
        stress: Math.round(st.stressScore),
      };
    }
  }
}
