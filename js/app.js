import { DetectionEngine, DEFAULT_SETTINGS, extractFrame } from './engine.js';

const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const STORAGE_KEY = 'driveguard-settings-v1';
const MAX_CAPTURES = 30;

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), overlay: $('overlay'), stage: $('stage'), stageEmpty: $('stageEmpty'),
  modelStatus: $('modelStatus'), startCam: $('startCam'), videoFile: $('videoFile'), stopBtn: $('stopBtn'),
  calibrateBtn: $('calibrateBtn'), testAlertBtn: $('testAlertBtn'), calibInfo: $('calibInfo'),
  driverState: $('driverState'), fps: $('fps'), banner: $('banner'),
  drowsyScore: $('drowsyScore'), stressScore: $('stressScore'),
  drowsyMeters: $('drowsyMeters'), stressMeters: $('stressMeters'),
  settingsForm: $('settingsForm'), resetSettings: $('resetSettings'),
  gallery: $('gallery'), captureCount: $('captureCount'), clearCaptures: $('clearCaptures'),
  logBody: $('logBody'),
  modal: $('alertModal'), alertTitle: $('alertTitle'), alertTime: $('alertTime'), alertImg: $('alertImg'),
  alertMsg: $('alertMsg'), alertMetrics: $('alertMetrics'), alertDownload: $('alertDownload'),
  alertDismiss: $('alertDismiss'), toast: $('toast'),
};

// ---------------------------------------------------------------- settings
const SETTING_GROUPS = [
  { title: 'Eye closure (drowsiness)', items: [
    { key: 'earThreshold', label: 'Eye-closed threshold (EAR)', min: 0.10, max: 0.35, step: 0.01, fmt: (v) => v.toFixed(2),
      hint: 'Eyes count as closed below this Eye Aspect Ratio. Raise it if closures are missed.' },
    { key: 'eyeClosedSec', label: 'Microsleep duration', min: 0.5, max: 5, step: 0.1, fmt: (v) => `${v.toFixed(1)} s`,
      hint: 'Continuous eye closure that triggers an alert.' },
    { key: 'perclosThreshold', label: 'PERCLOS limit', min: 0.10, max: 0.80, step: 0.05, fmt: (v) => `${Math.round(v * 100)} %`,
      hint: 'Share of time eyes are closed over the window.' },
    { key: 'perclosWindowSec', label: 'PERCLOS window', min: 20, max: 180, step: 10, fmt: (v) => `${v} s` },
  ] },
  { title: 'Yawning & attention', items: [
    { key: 'marThreshold', label: 'Mouth-open threshold (MAR)', min: 0.30, max: 1.20, step: 0.05, fmt: (v) => v.toFixed(2),
      hint: 'Mouth Aspect Ratio above this counts as a wide-open mouth.' },
    { key: 'yawnMinSec', label: 'Minimum yawn length', min: 0.5, max: 4, step: 0.1, fmt: (v) => `${v.toFixed(1)} s` },
    { key: 'yawnCountThreshold', label: 'Yawns before alert', min: 1, max: 10, step: 1, fmt: (v) => `${v}` },
    { key: 'yawnWindowSec', label: 'Yawn counting window', min: 30, max: 600, step: 30, fmt: (v) => `${v / 60} min` },
    { key: 'noFaceSec', label: 'Face-lost alert after', min: 0, max: 15, step: 1, fmt: (v) => (v ? `${v} s` : 'off'),
      hint: 'Head dropped or looking away. 0 turns it off.' },
  ] },
  { title: 'Stress', items: [
    { key: 'stressThreshold', label: 'Stress score threshold', min: 20, max: 95, step: 1, fmt: (v) => `${v}`,
      hint: 'Score (0-100) built from brow furrow, lip press, frown, squint, blink rate and head jitter.' },
    { key: 'stressSustainSec', label: 'Must persist for', min: 1, max: 20, step: 1, fmt: (v) => `${v} s` },
    { key: 'stressSensitivity', label: 'Sensitivity', min: 0.5, max: 2.5, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
    { key: 'blinkRateHigh', label: 'High blink rate', min: 15, max: 60, step: 1, fmt: (v) => `${v}/min` },
  ] },
  { title: 'Alerts', items: [
    { key: 'alertCooldownSec', label: 'Cooldown between alerts', min: 2, max: 60, step: 1, fmt: (v) => `${v} s` },
    { key: 'soundOn', label: 'Alarm sound', type: 'bool' },
    { key: 'voiceOn', label: 'Spoken warning', type: 'bool' },
  ] },
];

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof saved[k] === typeof DEFAULT_SETTINGS[k]) out[k] = saved[k];
    }
    return out;
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(engine.settings)); } catch { /* storage unavailable */ }
}

const engine = new DetectionEngine(loadSettings());

function buildSettingsForm() {
  const form = els.settingsForm;
  form.innerHTML = '';
  for (const group of SETTING_GROUPS) {
    const fs = document.createElement('fieldset');
    fs.innerHTML = `<legend>${group.title}</legend>`;
    for (const it of group.items) {
      const v = engine.settings[it.key];
      if (it.type === 'bool') {
        const lab = document.createElement('label');
        lab.className = 'toggle';
        lab.innerHTML = `<input type="checkbox" name="${it.key}" ${v ? 'checked' : ''}> ${it.label}`;
        fs.append(lab);
        continue;
      }
      const wrap = document.createElement('div');
      wrap.className = 'setting';
      wrap.innerHTML = `
        <label class="setting-top" for="set-${it.key}"><span>${it.label}</span><output id="out-${it.key}">${it.fmt(v)}</output></label>
        <input type="range" id="set-${it.key}" name="${it.key}" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}">
        ${it.hint ? `<p class="hint">${it.hint}</p>` : ''}`;
      fs.append(wrap);
    }
    form.append(fs);
  }
}

const settingDefs = Object.fromEntries(SETTING_GROUPS.flatMap((g) => g.items).map((i) => [i.key, i]));

els.settingsForm.addEventListener('input', (e) => {
  const input = e.target;
  const def = settingDefs[input.name];
  if (!def) return;
  const value = def.type === 'bool' ? input.checked : parseFloat(input.value);
  engine.setSettings({ [def.key]: value });
  if (def.fmt) $(`out-${def.key}`).textContent = def.fmt(value);
  saveSettings();
  renderMeters(engine.state);
});

function setSetting(key, value) {
  engine.setSettings({ [key]: value });
  const input = els.settingsForm.elements[key];
  if (input) {
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
    const def = settingDefs[key];
    if (def.fmt) $(`out-${key}`).textContent = def.fmt(value);
  }
  saveSettings();
}

els.resetSettings.addEventListener('click', () => {
  engine.setSettings({ ...DEFAULT_SETTINGS });
  saveSettings();
  buildSettingsForm();
  renderMeters(engine.state);
  toast('Thresholds reset to defaults.');
});

// ---------------------------------------------------------------- meters
const s = () => engine.settings;
const DROWSY_METERS = [
  { id: 'ear', label: 'Eye openness (EAR)', get: (st) => st.ear, max: () => 0.45, tick: () => s().earThreshold,
    fmt: (v) => v.toFixed(3), bad: (v, st) => st.face && v < s().earThreshold },
  { id: 'closed', label: 'Eyes closed for', get: (st) => st.closedFor, max: () => s().eyeClosedSec * 1.5, tick: () => s().eyeClosedSec,
    fmt: (v) => `${v.toFixed(1)} s`, bad: (v) => v >= s().eyeClosedSec, mid: (v) => v > 0.4 },
  { id: 'perclos', label: 'PERCLOS', get: (st) => st.perclos, max: () => 1, tick: () => s().perclosThreshold,
    fmt: (v, st) => `${(v * 100).toFixed(0)} %${st.perclosReady ? '' : ' (warming up)'}`,
    bad: (v) => v >= s().perclosThreshold, mid: (v) => v >= s().perclosThreshold * 0.6 },
  { id: 'mar', label: 'Mouth opening (MAR)', get: (st) => st.mar, max: () => 1.2, tick: () => s().marThreshold,
    fmt: (v) => v.toFixed(2), mid: (v) => v > s().marThreshold },
  { id: 'yawns', label: 'Yawns in window', get: (st) => st.yawnCount, max: () => s().yawnCountThreshold * 1.5,
    tick: () => s().yawnCountThreshold, fmt: (v) => `${v}`, bad: (v) => v >= s().yawnCountThreshold, mid: (v) => v > 0 },
];
const STRESS_METERS = [
  { id: 'stress', label: 'Stress score', get: (st) => st.stressScore, max: () => 100, tick: () => s().stressThreshold,
    fmt: (v) => v.toFixed(0), bad: (v) => v >= s().stressThreshold, mid: (v) => v >= s().stressThreshold * 0.7 },
  { id: 'blink', label: 'Blink rate', get: (st) => st.blinkRate, max: () => 60, tick: () => s().blinkRateHigh,
    fmt: (v) => `${v.toFixed(0)} /min`, mid: (v) => v > s().blinkRateHigh },
];
const STRESS_FEATURE_LABELS = {
  browFurrow: 'Brow furrow', browRaise: 'Brow raise', lipPress: 'Lip press', frown: 'Frown',
  squint: 'Eye squint', sneer: 'Nose wrinkle', blinkRate: 'Fast blinking', headJitter: 'Head jitter',
  smile: 'Smile (reduces score)',
};

function meterHTML(m) {
  return `<div class="meter" id="m-${m.id}">
    <div class="meter-top"><span>${m.label}</span><b>–</b></div>
    <div class="bar"><div class="bar-fill"></div><div class="bar-tick" title="threshold"></div></div></div>`;
}
function buildMeters() {
  els.drowsyMeters.innerHTML = DROWSY_METERS.map(meterHTML).join('');
  els.stressMeters.innerHTML = STRESS_METERS.map(meterHTML).join('') +
    `<div class="sub-meters">${Object.entries(STRESS_FEATURE_LABELS).map(([k, l]) =>
      `<div id="f-${k}"><div class="meter-top"><span>${l}</span><b>0</b></div><div class="bar"><div class="bar-fill"></div></div></div>`).join('')}</div>`;
}
function renderMeters(st) {
  for (const m of [...DROWSY_METERS, ...STRESS_METERS]) {
    const node = $(`m-${m.id}`);
    const v = m.get(st) || 0;
    const pct = Math.min(100, (v / m.max()) * 100);
    const fill = node.querySelector('.bar-fill');
    fill.style.width = `${pct}%`;
    fill.className = 'bar-fill' + (m.bad?.(v, st) ? ' bad' : m.mid?.(v, st) ? ' mid' : '');
    node.querySelector('.bar-tick').style.left = `calc(${Math.min(100, (m.tick() / m.max()) * 100)}% - 1px)`;
    node.querySelector('b').textContent = st.face || m.id === 'yawns' ? m.fmt(v, st) : '–';
  }
  for (const k of Object.keys(STRESS_FEATURE_LABELS)) {
    const v = st.stressFeatures?.[k] || 0;
    const node = $(`f-${k}`);
    node.querySelector('.bar-fill').style.width = `${v * 100}%`;
    node.querySelector('.bar-fill').className = 'bar-fill' + (v > 0.6 ? ' mid' : '');
    node.querySelector('b').textContent = Math.round(v * 100);
  }
  const d = Math.round(st.drowsyScore || 0), sc = Math.round(st.stressScore || 0);
  els.drowsyScore.textContent = d;
  els.stressScore.textContent = sc;
  els.drowsyScore.parentElement.className = 'score' + (d >= 100 ? ' hot' : d >= 60 ? ' warm' : '');
  els.stressScore.parentElement.className = 'score' + (sc >= s().stressThreshold ? ' hot' : sc >= s().stressThreshold * 0.7 ? ' warm' : '');
}

// ---------------------------------------------------------------- model
let vision = null;
let landmarker = null;

async function loadModel() {
  try {
    vision = await import(`${VISION_URL}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try {
      landmarker = await vision.FaceLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch (err) {
      console.warn('GPU delegate unavailable, falling back to CPU', err);
      landmarker = await vision.FaceLandmarker.createFromOptions(fileset, opts('CPU'));
    }
    els.modelStatus.textContent = 'Model ready';
    els.modelStatus.className = 'pill pill-ok';
    els.startCam.disabled = false;
  } catch (err) {
    console.error(err);
    els.modelStatus.textContent = 'Model failed to load';
    els.modelStatus.className = 'pill pill-err';
    toast('Could not load the face model. Check your internet connection and reload.', 8000);
  }
}

// ---------------------------------------------------------------- capture loop
let running = false;
let rafId = 0;
let lastVideoTime = -1;
let mirror = false;
let stream = null;
let objectUrl = null;
let lastResult = null;
let fpsFrames = 0, fpsT0 = 0;

async function startCamera() {
  try {
    const cam = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false,
    });
    await startStream(cam, { mirror: true });
  } catch (err) {
    console.error(err);
    toast(err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access in the address bar and try again.'
      : `Could not open camera: ${err.message}`, 8000);
  }
}

async function startStream(mediaStream, opts = {}) {
  stopSource();
  stream = mediaStream;
  els.video.srcObject = mediaStream;
  els.video.loop = false;
  await beginPlayback(!!opts.mirror);
}

async function startFile(file) {
  stopSource();
  objectUrl = URL.createObjectURL(file);
  els.video.srcObject = null;
  els.video.src = objectUrl;
  els.video.loop = true;
  await beginPlayback(false);
}

async function beginPlayback(mirrored) {
  mirror = mirrored;
  els.stage.classList.toggle('mirror', mirror);
  await els.video.play();
  await new Promise((r) => (els.video.readyState >= 2 ? r() : els.video.addEventListener('loadeddata', r, { once: true })));
  els.overlay.width = els.video.videoWidth;
  els.overlay.height = els.video.videoHeight;
  engine.reset();
  ensureAudio();
  running = true;
  lastVideoTime = -1;
  fpsT0 = performance.now(); fpsFrames = 0;
  els.stageEmpty.hidden = true;
  els.stopBtn.disabled = false;
  els.calibrateBtn.disabled = false;
  els.testAlertBtn.disabled = false;
  scheduleNext();
}

// requestAnimationFrame stops entirely when the tab/window is hidden or covered;
// fall back to timers there so monitoring continues (at a lower frame rate).
let timerId = 0;
function scheduleNext() {
  cancelAnimationFrame(rafId);
  clearTimeout(timerId);
  if (!running) return;
  if (document.hidden) timerId = setTimeout(loop, 66);
  else rafId = requestAnimationFrame(loop);
}

function stopSource() {
  running = false;
  cancelAnimationFrame(rafId);
  clearTimeout(timerId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.srcObject = null;
}

function stop() {
  stopSource();
  els.overlay.getContext('2d').clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.stageEmpty.hidden = false;
  els.stopBtn.disabled = true;
  els.calibrateBtn.disabled = true;
  els.testAlertBtn.disabled = true;
  setDriverState('IDLE', 'idle');
  els.fps.textContent = '';
  hideBanner();
}

function loop() {
  if (!running) return;
  const now = performance.now();
  const v = els.video;
  if (landmarker && v.readyState >= 2 && v.currentTime !== lastVideoTime) {
    lastVideoTime = v.currentTime;
    let result;
    try {
      result = landmarker.detectForVideo(v, now);
    } catch (err) {
      console.error('detection error', err);
    }
    lastResult = result;
    const w = v.videoWidth, h = v.videoHeight;
    const face = result?.faceLandmarks?.[0];
    const frame = face ? extractFrame(face, result.faceBlendshapes?.[0]?.categories, w, h) : null;
    const out = engine.update(frame, now);
    drawOverlay(face, out.state);
    renderMeters(out.state);
    updateDriverState(out.state);
    if (out.calibration) onCalibrated(out.calibration);
    for (const ev of out.events) handleEvent(ev);
    fpsFrames++;
    if (now - fpsT0 > 1000) {
      els.fps.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsT0))} fps`;
      fpsFrames = 0; fpsT0 = now;
    }
  }
  scheduleNext();
}

function drawOverlay(face, st) {
  const c = els.overlay;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!face || !vision) return;
  const du = new vision.DrawingUtils(ctx);
  const FL = vision.FaceLandmarker;
  const eyeColor = st.eyesClosed ? '#ef4444' : '#22c55e';
  du.drawConnectors(face, FL.FACE_LANDMARKS_FACE_OVAL, { color: 'rgba(255,255,255,0.35)', lineWidth: 1 });
  du.drawConnectors(face, FL.FACE_LANDMARKS_RIGHT_EYE, { color: eyeColor, lineWidth: 2 });
  du.drawConnectors(face, FL.FACE_LANDMARKS_LEFT_EYE, { color: eyeColor, lineWidth: 2 });
  du.drawConnectors(face, FL.FACE_LANDMARKS_RIGHT_EYEBROW, { color: '#f59e0b', lineWidth: 2 });
  du.drawConnectors(face, FL.FACE_LANDMARKS_LEFT_EYEBROW, { color: '#f59e0b', lineWidth: 2 });
  du.drawConnectors(face, FL.FACE_LANDMARKS_LIPS, { color: st.mar > s().marThreshold ? '#f59e0b' : '#60a5fa', lineWidth: 2 });
}

let bannerUntil = 0;
function updateDriverState(st) {
  const now = performance.now();
  if (st.calibrating) setDriverState('CALIBRATING…', 'warn');
  else if (!st.face) setDriverState('NO FACE', 'warn');
  else if (st.eyesClosed && st.closedFor > 0.4) setDriverState('EYES CLOSED', 'danger');
  else if (st.drowsyScore >= 60) setDriverState('DROWSY', 'danger');
  else if (st.stressScore >= s().stressThreshold) setDriverState('STRESSED', 'warn');
  else setDriverState('ALERT & CALM', 'ok');
  if (bannerUntil && now > bannerUntil) hideBanner();
}
function setDriverState(text, kind) {
  if (els.driverState.textContent !== text) els.driverState.textContent = text;
  els.driverState.className = `state state-${kind}`;
}

// ---------------------------------------------------------------- alerts
const captures = [];

function handleEvent(ev) {
  addLog(ev);
  if (ev.type === 'info') return;
  const image = captureFrame(ev);
  const cap = { ...ev, image, when: new Date() };
  captures.unshift(cap);
  if (captures.length > MAX_CAPTURES) captures.pop();
  renderGallery();
  showBanner(ev);
  showModal(cap);
  playAlarm(ev.type);
  speak(ev);
}

function captureFrame(ev) {
  const v = els.video;
  const w = v.videoWidth || 640, h = v.videoHeight || 480;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (mirror) { g.translate(w, 0); g.scale(-1, 1); }
  try { g.drawImage(v, 0, 0, w, h); } catch { /* no frame yet */ }
  g.drawImage(els.overlay, 0, 0, w, h);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const barH = Math.max(40, Math.round(h * 0.11));
  g.fillStyle = ev.type === 'stress' ? 'rgba(217,119,6,0.88)' : 'rgba(220,38,38,0.88)';
  g.fillRect(0, h - barH, w, barH);
  g.fillStyle = '#fff';
  g.font = `bold ${Math.round(barH * 0.4)}px system-ui, sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(`${{ stress: 'STRESS', test: 'TEST' }[ev.type] || 'DROWSINESS'} — ${ev.reason}`, 12, h - barH / 2);
  g.font = `${Math.round(barH * 0.3)}px system-ui, sans-serif`;
  g.textAlign = 'right';
  g.fillText(new Date().toLocaleTimeString(), w - 12, h - barH / 2);
  return c.toDataURL('image/jpeg', 0.85);
}

function title(ev) {
  return ev.type === 'stress' ? 'Stress detected' : ev.type === 'test' ? 'Test alert' : 'Drowsiness detected';
}

function showBanner(ev) {
  els.banner.hidden = false;
  els.banner.className = `banner ${ev.type === 'stress' ? 'stress' : 'drowsy'}`;
  els.banner.textContent = `⚠ ${title(ev).toUpperCase()} — ${ev.reason}`;
  els.stage.classList.add('alerting');
  els.stage.classList.toggle('stress-alert', ev.type === 'stress');
  bannerUntil = performance.now() + 5000;
}
function hideBanner() {
  els.banner.hidden = true;
  els.stage.classList.remove('alerting', 'stress-alert');
  bannerUntil = 0;
}

function showModal(cap) {
  const box = els.modal.querySelector('.modal-box');
  box.classList.toggle('stress', cap.type === 'stress');
  els.alertTitle.textContent = title(cap);
  els.alertTime.textContent = `${cap.when.toLocaleString()} · ${cap.reason}`;
  els.alertImg.src = cap.image;
  els.alertMsg.textContent = cap.message;
  els.alertMetrics.innerHTML = cap.metrics ? [
    ['EAR', cap.metrics.ear], ['MAR', cap.metrics.mar], ['PERCLOS', `${Math.round(cap.metrics.perclos * 100)}%`],
    ['Blinks', `${cap.metrics.blinkRate}/min`], ['Yawns', cap.metrics.yawns],
    ['Drowsiness', cap.metrics.drowsy], ['Stress', cap.metrics.stress],
  ].map(([k, v]) => `<span>${k}: <b>${v}</b></span>`).join('') : '';
  els.alertDownload.href = cap.image;
  els.alertDownload.download = fileName(cap);
  els.modal.hidden = false;
  els.alertDismiss.focus({ preventScroll: true });
}
function hideModal() {
  els.modal.hidden = true;
  hideBanner();
  stopAlarm();
}
els.alertDismiss.addEventListener('click', hideModal);
els.modal.addEventListener('click', (e) => { if (e.target === els.modal) hideModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.modal.hidden) hideModal(); });

function fileName(cap) {
  const ts = cap.when.toISOString().replace(/[:.]/g, '-');
  return `alert-${cap.type}-${ts}.jpg`;
}

function renderGallery() {
  els.captureCount.textContent = captures.length;
  if (!captures.length) {
    els.gallery.innerHTML = '<p class="muted">No alerts yet. When drowsiness or stress is detected, the frame is captured here.</p>';
    return;
  }
  els.gallery.innerHTML = '';
  captures.forEach((cap) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'shot';
    b.innerHTML = `<img alt="">
      <div><span class="tag ${cap.type === 'stress' ? 'stress' : 'drowsy'}">${title(cap)}</span><br>
      ${escapeHTML(cap.reason)} · ${cap.when.toLocaleTimeString()}</div>`;
    b.querySelector('img').src = cap.image;
    b.querySelector('img').alt = `${title(cap)} at ${cap.when.toLocaleTimeString()}`;
    b.addEventListener('click', () => showModal(cap));
    els.gallery.append(b);
  });
}
els.clearCaptures.addEventListener('click', () => { captures.length = 0; renderGallery(); });

function addLog(ev) {
  const tr = document.createElement('tr');
  const label = ev.type === 'info' ? 'Info' : ev.type === 'stress' ? 'Stress' : ev.type === 'test' ? 'Test' : 'Drowsy';
  tr.innerHTML = `<td>${new Date().toLocaleTimeString()}</td><td class="${ev.type}">${label}</td>
    <td>${escapeHTML(ev.reason)}</td><td>${escapeHTML(ev.message)}</td>`;
  els.logBody.prepend(tr);
  while (els.logBody.children.length > 200) els.logBody.lastChild.remove();
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- sound
let audioCtx = null;
let alarmTimer = 0;
function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { audioCtx = null; }
}
function tone(freq, start, dur, type = 'square', vol = 0.18) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + 0.01);
  g.gain.setValueAtTime(vol, start + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, start + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(start); o.stop(start + dur);
}
function playAlarm(type) {
  if (!s().soundOn || !audioCtx) return;
  stopAlarm();
  let rounds = 0;
  const once = () => {
    const t = audioCtx.currentTime;
    if (type === 'stress') { tone(520, t, 0.35, 'sine', 0.2); tone(440, t + 0.4, 0.5, 'sine', 0.2); }
    else { for (let i = 0; i < 3; i++) tone(i % 2 ? 1100 : 880, t + i * 0.18, 0.15); }
  };
  once();
  // Drowsiness keeps sounding (up to ~6 s) until dismissed.
  if (type !== 'stress') alarmTimer = setInterval(() => (++rounds >= 5 ? stopAlarm() : once()), 1200);
}
function stopAlarm() { clearInterval(alarmTimer); alarmTimer = 0; }
function speak(ev) {
  if (!s().voiceOn || !('speechSynthesis' in window)) return;
  const text = ev.type === 'stress'
    ? 'You seem stressed. Take a deep breath and relax.'
    : 'Warning. You seem drowsy. Please pull over and rest.';
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// ---------------------------------------------------------------- calibration
function onCalibrated(res) {
  if (!res.ok) { els.calibInfo.textContent = res.reason; toast(res.reason); return; }
  setSetting('earThreshold', res.suggestedEar);
  els.calibInfo.textContent = `Calibrated: open-eye EAR ${res.baselineEar.toFixed(3)} → threshold ${res.suggestedEar.toFixed(2)}; neutral expression baseline stored.`;
  toast('Calibration complete — thresholds adapted to your face.');
}

// ---------------------------------------------------------------- misc UI
let toastTimer = 0;
function toast(msg, ms = 4000) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

els.startCam.addEventListener('click', startCamera);
els.videoFile.addEventListener('change', () => {
  const f = els.videoFile.files[0];
  if (!f) return;
  if (!landmarker) { toast('The face model is still loading — try again in a moment.'); return; }
  startFile(f).catch((err) => toast(`Could not play video: ${err.message}`));
  els.videoFile.value = '';
});
els.stopBtn.addEventListener('click', stop);
els.calibrateBtn.addEventListener('click', () => {
  engine.startCalibration(performance.now(), 5);
  els.calibInfo.textContent = 'Calibrating — look ahead with a relaxed, neutral face and eyes open…';
});
els.testAlertBtn.addEventListener('click', () => {
  ensureAudio();
  handleEvent({ type: 'test', t: performance.now(), reason: 'Manual test', message: 'This is a test of the alert, alarm and frame-capture system.',
    metrics: engine.state.face ? {
      ear: +engine.state.ear.toFixed(3), mar: +engine.state.mar.toFixed(3), perclos: +engine.state.perclos.toFixed(3),
      blinkRate: Math.round(engine.state.blinkRate), yawns: engine.state.yawnCount,
      drowsy: Math.round(engine.state.drowsyScore), stress: Math.round(engine.state.stressScore),
    } : null });
});

// Background tabs are throttled, so detection gets slower there.
document.addEventListener('visibilitychange', () => {
  scheduleNext();
  if (document.visibilityState === 'visible' && running) toast('Monitoring resumed. Keep this tab visible while driving — browsers pause detection in background tabs.', 6000);
});

buildSettingsForm();
buildMeters();
renderMeters(engine.state);
loadModel();

// Hooks for automated testing / debugging from the console.
window.DDS = {
  engine, captures, startStream, stop, setSetting,
  get ready() { return !!landmarker; },
  get running() { return running; },
  get lastResult() { return lastResult; },
};
