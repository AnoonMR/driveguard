# DriveGuard

Real-time driver **drowsiness** and **stress** detection that runs entirely in the browser (MediaPipe Face Landmarker). When drowsiness or stress is detected it captures the video frame, shows an alert popup with the photo and message, and sounds an alarm. All thresholds are adjustable with live sliders.

- Drowsiness: eye closure (EAR / microsleep), PERCLOS, yawning, face lost
- Stress: brow furrow, lip press, frown, squint, blink rate, head jitter (smile-compensated)
- Per-driver calibration, captured-frame gallery, event log

## Run locally

```
npm start        # or double-click start.bat
```
Open http://localhost:8080 and click **Start camera**. No dependencies besides Node.js.

## Tests

```
npm test
```

## Deploy

Static site — on Netlify import this repo; `netlify.toml` already sets no build command and publish directory `.`.

See [REPORT.md](REPORT.md) for the project report.
