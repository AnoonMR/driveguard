# DriveGuard Monitor — Driver Drowsiness & Stress Detection

*Project report · 11 October 2026*

## 1. Summary

DriveGuard Monitor is a website that watches a driver through a webcam and detects **drowsiness** and **stress** in real time. When it detects either one, it:

1. **captures the video frame** at that moment, with a stamp showing the alert type, reason and time,
2. **shows an alert popup** with the captured frame, a message and the measured values,
3. flashes a **banner** over the live view, sounds an **alarm** (and optionally speaks a warning),
4. adds the frame to a **gallery of captured alerts** and writes a line to the **event log**.

All thresholds can be changed live with sliders. Everything runs in the browser, so no video is uploaded anywhere.

## 2. How to run

```
cd C:\all\pojects\driver
npm start            (or double-click start.bat)
```
Open **http://localhost:8080** and press **Start camera**, or **Use video file** to analyse a recording. Then press **Calibrate (5 s)** while looking ahead with a neutral face. Node.js is the only requirement and there are no npm dependencies. An internet connection is needed the first time, to load the MediaPipe library and model from their CDN.

Run the tests with `npm test`.

## 3. How it works

```
Webcam / video ─► MediaPipe Face Landmarker (478 landmarks + 52 blendshapes, WASM/GPU)
                 ─► extractFrame(): EAR, MAR, blendshapes, nose position, face width
                 ─► DetectionEngine.update(): timers, windows, scores, alert events
                 ─► UI: meters, overlay, frame capture, popup, alarm, gallery, log
```

| Detector | Method |
|---|---|
| **Microsleep** | Eye Aspect Ratio, EAR = (‖p2−p6‖+‖p3−p5‖) / 2‖p1−p4‖, averaged over both eyes. An alert fires if EAR stays below the threshold for longer than the set duration. |
| **PERCLOS** | Time-weighted share of the rolling window during which the eyes are closed. This is the standard fatigue measure. |
| **Yawning** | Mouth Aspect Ratio over the threshold for at least the minimum yawn length counts as a yawn. Too many yawns inside the window raises a fatigue alert. Short mouth openings, such as talking, are ignored. |
| **Head drop / looking away** | No face detected for N seconds. |
| **Stress score (0–100)** | Weighted facial tension cues from the blendshapes: brow furrow 30%, brow raise 15%, lip press 20%, frown 10%, eye squint 10%, nose wrinkle 5%. Also blink rate above the "high" limit (5%) and head jitter, the std-dev of nose position over 2 s (5%). The score is smoothed (τ ≈ 0.8 s) and must stay above the threshold for the set time. A **smile** dampens the squint and brow cues, so a happy face isn't read as tense. |
| **Calibration** | 5 seconds of neutral face. It stores a personal baseline for each blendshape, which is subtracted afterwards, and sets the EAR threshold to 75% of the person's open-eye EAR. |

Distances are measured in pixel space, because MediaPipe landmarks are normalised per axis and the aspect ratio would otherwise skew EAR and MAR. Each alert type has a cooldown so a single episode doesn't produce a flood of alerts.

## 4. Threshold adjustment options

| Group | Setting | Default | Range |
|---|---|---|---|
| Eye closure | Eye-closed threshold (EAR) | 0.21 | 0.10 – 0.35 |
| | Microsleep duration | 1.5 s | 0.5 – 5 s |
| | PERCLOS limit | 30 % | 10 – 80 % |
| | PERCLOS window | 60 s | 20 – 180 s |
| Yawning & attention | Mouth-open threshold (MAR) | 0.60 | 0.30 – 1.20 |
| | Minimum yawn length | 1.2 s | 0.5 – 4 s |
| | Yawns before alert | 3 | 1 – 10 |
| | Yawn counting window | 2 min | 0.5 – 10 min |
| | Face-lost alert after | 4 s | off – 15 s |
| Stress | Stress score threshold | 60 | 20 – 95 |
| | Must persist for | 3 s | 1 – 20 s |
| | Sensitivity multiplier | ×1.0 | ×0.5 – ×2.5 |
| | High blink rate | 30 /min | 15 – 60 /min |
| Alerts | Cooldown between alerts | 6 s | 2 – 60 s |
| | Alarm sound / spoken warning | on / off | toggles |

Settings are saved in the browser and can be restored with **Reset defaults**. Every meter shows its current threshold as a tick mark, so you can see the effect of a change straight away.

## 5. Testing

**Unit tests (`npm test`): 11 of 11 pass.** They feed the engine synthetic 30 fps frame sequences and check:
- the EAR and MAR geometry, including correction for aspect ratio;
- that an attentive driver blinking normally for 90 s produces no false alarms;
- that a microsleep fires exactly once, at about 1.5 s;
- that the EAR threshold and closure duration change behaviour, including changes made at runtime;
- PERCLOS, yawn counting, and that talking is not counted as yawning;
- the stress score and sustain timer, the threshold and sensitivity settings, and that calibration removes a personal baseline;
- that a smiling face is not flagged as stress;
- the face-lost alert, and that setting it to 0 turns it off;
- that the cooldown limits repeated alerts.

**End-to-end in Chrome.** A public portrait photo (`tests/assets/face.jpg`) was fed to the page as a fake camera stream. Results:
- The model loaded, found the face, and drew the eye, brow and lip contours. EAR read 0.214 and MAR 0.204.
- **Drowsiness alert:** with the EAR threshold raised to 0.30, a microsleep alert fired after the closure time. It produced the popup with the captured frame, the banner, the red border, a gallery entry and a log line.
- **Stress alert:** with the threshold lowered, an amber stress popup appeared with the captured frame. A pixel check confirmed the captured frame is mirrored the same way as the live view.
- **Face-lost alert:** with the frame blanked, the alert fired after 5 s.
- **Calibration:** set the EAR threshold to 0.16, and the slider updated to match.
- **Reset defaults:** restored all sliders.
- No application errors appeared in the console.

Three issues were found and fixed during testing:
- A smiling face scored 48 of 100 for stress. With smile suppression added, it now scores 4.
- Chrome pauses `requestAnimationFrame` in hidden or covered tabs, which stopped detection completely. The loop now falls back to timers, so monitoring continues at a reduced rate.
- A leftover "Camera is off" overlay stayed visible over the video.

The live webcam path itself was not tested automatically, because it needs a person in front of a real camera. It uses the same pipeline as the stream test.

## 6. Limitations & future work

- The stress score is based on facial expression only, which is a proxy for stress. It is not a physiological measure. Adding heart rate, either through rPPG from the face video or a wearable, would improve it.
- The system struggles with sunglasses, strong backlight and night driving. An IR camera would be needed in a vehicle.
- EAR varies from person to person. That is why calibration exists, and it should be run once per driver.
- A browser tab is throttled when it is in the background. A dedicated in-car device or app would avoid this.
- This is a driver-assistance demo, not a certified safety system.

## 7. Files

| File | Purpose |
|---|---|
| `index.html`, `css/styles.css` | The dashboard UI, with light and dark themes and a responsive layout |
| `js/engine.js` | Detection logic: EAR, MAR, PERCLOS, yawns, stress score, calibration, alerts. Pure and testable. |
| `js/app.js` | Camera and video input, MediaPipe, overlay, meters, settings, frame capture, popup, alarm, gallery, log |
| `server.js`, `start.bat` | Zero-dependency local web server (camera access requires localhost or HTTPS) |
| `tests/engine.test.js` | Unit tests |
