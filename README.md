# Glance — Screen-Aware AI Mentor

A desktop voice assistant that teaches you to use software. It sees your screen, tells you the next step out loud, and points at the exact button. **It points, you act.** It never clicks for you.

> This build covers the core system: modules 1–6 from the deck. MongoDB (module 7) will be added later.

## Quick start

```bash
npm install
cp .env.example .env        # then put your GEMINI_API_KEY in .env
npm start
```

Press **Ctrl + Shift + G** (⌘ + Shift + G on macOS). Type or speak a goal, e.g. "create a new branch in VS Code". Glance speaks the first step and puts a pulsing reticle on the element. Do the step yourself. When the screen changes and settles, Glance fetches the next step automatically.

- **Next step**: force a refresh, e.g. if your action didn't visibly change the screen
- **Repeat**: say the current step again
- **Esc / ✕**: stop and collapse

To try the UI and the loop without an API key, run `npm run start:mock`. Every step then points at the centre of the screen.

### Permissions
- **macOS**: allow *Screen Recording* and *Microphone* for Electron/Glance in System Settings → Privacy & Security, then restart the app.
- **Windows**: none. The overlay hides itself from screen capture on Windows 10 2004 or later.
- **Linux (X11)**: works. The overlay is hidden for an instant while each screenshot is taken. Electron can't pass mouse hover through to the panel on Linux, so press the hotkey to make the panel clickable.

## Architecture

```
┌──────────────── ELECTRON DESKTOP APP ─────────────────┐
│ RENDERER (sandboxed)        MAIN PROCESS (privileged) │        VISION LLM (cloud)
│  overlay UI + reticle  ◄──►  native screen capture    │ HTTPS  Gemini 3 Flash (primary)
│  step loop             IPC   calls the vision LLM     │ ◄────► Gemini 2.5 Flash (fallback)
│  screen-change watcher  │    coordinate conversion    │        screenshot → step + [y,x]
│  voice in / out      preload model fallback + retry   │
│                      bridge  global hotkey            │
└───────────────────────────────────────────────────────┘
```

The renderer is sandboxed: `sandbox: true`, `contextIsolation`, no Node, strict CSP. The preload bridge exposes exactly four functions: `nextStep`, `sampleScreen`, `setInteractive`, `onMainEvent`. All OS access stays in the main process.

| # | Module | File |
|---|--------|------|
| 1 | Capture | `src/main/capture.js` |
| 2 | Vision & Reasoning | `src/main/vision.js` |
| 3 | Coordinate Mapper | `src/main/coords.js` |
| 4 | Overlay & Pointer | `src/renderer/index.html`, `styles.css`, `src/main/main.js` (window) |
| 5 | Session & Loop | `src/renderer/renderer.js`, `src/renderer/phash.js` |
| 6 | Voice I/O | `src/renderer/voice.js` |
| 7 | Database (MongoDB) | *not yet built* |

## Pixel normalization (the key data transform)

```
Model output [y, x] normalized 0–1000  →  screenshot pixels  →  on-screen position
```

1. **Capture** grabs the screen at its native pixel resolution (`bounds × scaleFactor`). It reports both `imagePx`, the real screenshot size, and `displayBounds`, the display in points/DIP.
2. **Gemini** returns `point: [y, x]` on a 0–1000 grid, y first.
3. **Stage 1** maps the grid to screenshot pixels: `px.x = x/1000 · imagePx.width`, `px.y = y/1000 · imagePx.height`. This rescales against the **true capture size**.
4. **Stage 2** maps screenshot pixels to display points: `local = px · (displayBounds / imagePx)` and `global = local + displayBounds.origin`.

The overlay window covers exactly that display, so the reticle is drawn at `local`. This lands on the right element on any resolution or DPI scaling (Retina 2×, Windows 125%/150%) and on secondary monitors. The tests in `test/coords.test.js` cover these cases.

## Screen-change watcher
- Every 600 ms it takes a **32×18 grayscale** sample of the screen.
- It compares the sample with the one taken right after the step was shown, using an average hash (Hamming distance) plus a per-cell luminance diff.
- Cells covered by Glance's own panel or reticle are masked out, so Glance never reacts to itself.
- When a change is seen, the reticle hides. Once two samples in a row are stable, the next step is fetched with the full history replayed.

## Model strategy
- The primary model is `gemini-3-flash-preview` and the fallback is `gemini-2.5-flash`. Both run on the `v1beta` endpoint through `@google/generative-ai`, and you can change them in `.env`.
- On 503, 429 or 500 errors it retries with exponential backoff and jitter, then switches to the fallback model.
- A 404 (unknown model name) goes straight to the fallback.

## Voice
- **TTS**: Web Speech `speechSynthesis`.
- **STT**: Web Speech `SpeechRecognition` when it's available. The mic is also recorded to 16 kHz WAV at the same time. If recognition fails, which is common inside Electron, the audio goes to Gemini with the first request and Gemini transcribes the goal.

## Dev tools
```bash
npm test                                              # mapper, hash and prompt-building tests
npm run point-test -- shot.png "open the Git panel"   # check pointing on any screenshot, writes point-test.html
GLANCE_DEBUG=1 npm start                              # saves every screenshot + mapping JSON to <userData>/debug
```
For a HiDPI screenshot, pass the display size in points, e.g. `npm run point-test -- shot.png "goal" 1440 900`.
