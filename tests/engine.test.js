import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DetectionEngine, DEFAULT_SETTINGS, eyeAspectRatio, mouthAspectRatio,
  RIGHT_EYE, MOUTH,
} from '../js/engine.js';

const FPS = 30;
const STEP = 1000 / FPS;

function frame({ ear = 0.3, mar = 0.1, blend = {}, nose = { x: 320, y: 240 } } = {}) {
  return { ear, mar, blend, nose, faceWidth: 200 };
}

// Runs `fn(i, t)` -> frame for `sec` seconds; collects all events.
function run(engine, sec, fn, t0 = 0) {
  const events = [];
  let t = t0, out;
  const n = Math.round(sec * FPS);
  for (let i = 0; i < n; i++) {
    t = t0 + i * STEP;
    out = engine.update(fn(i, t), t);
    events.push(...out.events);
  }
  return { events, state: out.state, t: t + STEP };
}

const alerts = (events, type) => events.filter((e) => e.type === type);

test('EAR / MAR geometry', () => {
  const lm = [];
  // open eye: width 30, vertical gaps 9 -> EAR 0.3
  const pts = { 33: [0, 0], 160: [10, -4.5], 158: [20, -4.5], 133: [30, 0], 153: [20, 4.5], 144: [10, 4.5] };
  for (const [i, [x, y]] of Object.entries(pts)) lm[i] = { x, y };
  assert.ok(Math.abs(eyeAspectRatio(lm, RIGHT_EYE) - 0.3) < 1e-9);
  // aspect scaling: normalised coords on a 2:1 frame
  const n = [];
  for (const [i, [x, y]] of Object.entries(pts)) n[i] = { x: x / 640, y: y / 320 };
  assert.ok(Math.abs(eyeAspectRatio(n, RIGHT_EYE, 640, 320) - 0.3) < 1e-9);

  const m = [];
  m[MOUTH.left] = { x: 0, y: 0 }; m[MOUTH.right] = { x: 50, y: 0 };
  m[MOUTH.top] = { x: 25, y: -20 }; m[MOUTH.bottom] = { x: 25, y: 20 };
  assert.equal(mouthAspectRatio(m), 0.8);
});

test('alert-free when driver is attentive and blinking normally', () => {
  const e = new DetectionEngine();
  // blink (150ms closed) every 4s for 90s
  const { events, state } = run(e, 90, (i, t) => frame({ ear: t % 4000 < 150 ? 0.12 : 0.3 }));
  assert.equal(alerts(events, 'drowsy').length, 0);
  assert.equal(alerts(events, 'stress').length, 0);
  assert.ok(state.blinkRate > 10 && state.blinkRate < 20, `blink rate ${state.blinkRate}`);
  assert.ok(state.perclos < 0.1);
});

test('microsleep: eyes closed longer than threshold triggers one drowsy alert', () => {
  const e = new DetectionEngine();
  run(e, 3, () => frame());
  const { events } = run(e, 3, () => frame({ ear: 0.1 }), 3000);
  const d = alerts(events, 'drowsy');
  assert.equal(d.length, 1);
  assert.equal(d[0].reason, 'Eyes closed');
  assert.ok(d[0].t - 3000 >= 1500 && d[0].t - 3000 < 1600, 'fires at ~1.5s');
  assert.ok(d[0].metrics && d[0].metrics.ear < 0.21);
});

test('eye-closure threshold and duration are adjustable', () => {
  // ear 0.24 is "open" with default 0.21 threshold ...
  const a = new DetectionEngine();
  assert.equal(alerts(run(a, 4, () => frame({ ear: 0.24 })).events, 'drowsy').length, 0);
  // ... but "closed" with threshold 0.26
  const b = new DetectionEngine({ earThreshold: 0.26 });
  assert.equal(alerts(run(b, 4, () => frame({ ear: 0.24 })).events, 'drowsy').length, 1);
  // longer duration requirement suppresses a 2s closure
  const c = new DetectionEngine({ eyeClosedSec: 3 });
  assert.equal(alerts(run(c, 2, () => frame({ ear: 0.1 })).events, 'drowsy').length, 0);
  // setSettings works at runtime
  c.setSettings({ eyeClosedSec: 1 });
  c.reset();
  assert.equal(alerts(run(c, 2, () => frame({ ear: 0.1 })).events, 'drowsy').length, 1);
});

test('PERCLOS: frequent long-ish closures trigger fatigue alert', () => {
  const e = new DetectionEngine({ eyeClosedSec: 5 }); // isolate PERCLOS from microsleep
  // closed 1s out of every 2.5s = 40%
  const { events, state } = run(e, 30, (i, t) => frame({ ear: t % 2500 < 1000 ? 0.1 : 0.3 }));
  assert.ok(state.perclos > 0.35 && state.perclos < 0.45, `perclos ${state.perclos}`);
  assert.ok(alerts(events, 'drowsy').some((d) => d.reason === 'High PERCLOS'));
});

test('yawning: counts yawns and alerts at the configured count', () => {
  const e = new DetectionEngine({ yawnCountThreshold: 3 });
  // a 2s yawn every 10s
  const { events, state } = run(e, 35, (i, t) => frame({ mar: t % 10000 < 2000 ? 0.8 : 0.1 }));
  assert.equal(events.filter((x) => x.reason === 'Yawn').length, 4);
  assert.equal(state.yawnCount, 4);
  const y = alerts(events, 'drowsy').filter((d) => d.reason === 'Frequent yawning');
  // alerts at the 3rd yawn, and again for the 4th (still above count, new yawn, cooldown elapsed)
  assert.equal(y.length, 2);
  assert.ok(y[0].t > 20000 && y[0].t < 23000);
  // short mouth openings (talking) are not yawns
  const f = new DetectionEngine();
  const r = run(f, 20, (i, t) => frame({ mar: t % 1000 < 400 ? 0.8 : 0.1 }));
  assert.equal(r.state.yawnCount, 0);
});

test('stress: sustained brow furrow + lip press raises score and alerts', () => {
  const e = new DetectionEngine();
  run(e, 3, () => frame());
  const tense = { browDownLeft: 0.5, browDownRight: 0.5, mouthPressLeft: 0.4, mouthPressRight: 0.4, eyeSquintLeft: 0.4, eyeSquintRight: 0.4, mouthFrownLeft: 0.3, mouthFrownRight: 0.3 };
  const { events, state } = run(e, 6, () => frame({ blend: tense }), 3000);
  assert.ok(state.stressScore > 60, `score ${state.stressScore}`);
  const s = alerts(events, 'stress');
  assert.equal(s.length, 1);
  assert.ok(s[0].t - 3000 >= 3000, 'requires sustain time');
});

test('stress threshold and sensitivity are adjustable; calibration removes baseline', () => {
  const tense = { browDownLeft: 0.5, browDownRight: 0.5, mouthPressLeft: 0.4, mouthPressRight: 0.4, eyeSquintLeft: 0.4, eyeSquintRight: 0.4, mouthFrownLeft: 0.3, mouthFrownRight: 0.3 };
  const hi = new DetectionEngine({ stressThreshold: 90 });
  assert.equal(alerts(run(hi, 8, () => frame({ blend: tense })).events, 'stress').length, 0);
  const sens = new DetectionEngine({ stressThreshold: 90, stressSensitivity: 2 });
  assert.equal(alerts(run(sens, 8, () => frame({ blend: tense })).events, 'stress').length, 1);

  // A person whose neutral face already has these values should not be flagged after calibration.
  const cal = new DetectionEngine();
  cal.startCalibration(0, 3);
  let calibration = null;
  for (let i = 0; i < 4 * FPS; i++) {
    const out = cal.update(frame({ blend: tense, ear: 0.28 }), i * STEP);
    if (out.calibration) calibration = out.calibration;
  }
  assert.ok(calibration?.ok);
  assert.equal(calibration.suggestedEar, 0.21);
  const r = run(cal, 8, () => frame({ blend: tense }), 4000);
  assert.ok(r.state.stressScore < 10);
  assert.equal(alerts(r.events, 'stress').length, 0);
});

test('a smile (cheek squint + brow) is not mistaken for stress', () => {
  const e = new DetectionEngine();
  const smiling = { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, eyeSquintLeft: 0.9, eyeSquintRight: 0.9, browDownLeft: 0.6, browDownRight: 0.6 };
  const { events, state } = run(e, 8, () => frame({ blend: smiling }));
  assert.ok(state.stressScore < 20, `score ${state.stressScore}`);
  assert.equal(alerts(events, 'stress').length, 0);
});

test('face lost for too long raises an attention alert; 0 disables it', () => {
  const e = new DetectionEngine();
  run(e, 2, () => frame());
  const { events } = run(e, 6, () => null, 2000);
  const d = alerts(events, 'drowsy');
  assert.equal(d.length, 1);
  assert.equal(d[0].reason, 'Face not visible');

  const off = new DetectionEngine({ noFaceSec: 0 });
  run(off, 2, () => frame());
  assert.equal(alerts(run(off, 6, () => null, 2000).events, 'drowsy').length, 0);
});

test('cooldown limits repeated alerts of the same type', () => {
  const e = new DetectionEngine({ alertCooldownSec: 10 });
  // repeated 2s closures separated by 0.5s open, for 20s
  const { events } = run(e, 20, (i, t) => frame({ ear: t % 2500 < 2000 ? 0.1 : 0.3 }));
  const n = alerts(events, 'drowsy').length;
  assert.ok(n >= 2 && n <= 3, `got ${n}`);
  assert.ok(DEFAULT_SETTINGS.alertCooldownSec > 0);
});
