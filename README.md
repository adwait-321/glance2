# Glance — Screen-Aware AI Mentor

A desktop voice assistant that teaches you to use software. It sees your screen, tells you the next step out loud, and points at the exact button. **It points, you act.** It never clicks for you.

> All 7 modules from the deck are implemented, including MongoDB session history.

## Quick start

```bash
npm install
cp .env.example .env        # then put your GEMINI_API_KEYS=key1,key2,… (and MONGODB_URI) in .env
npm start
```

**MongoDB:** install MongoDB Community Server (it runs as a Windows service on `mongodb://127.0.0.1:27017`) or paste a free MongoDB Atlas URI into `MONGODB_URI`. `npm run db-check` verifies the connection and lists stored sessions. The header badge shows **MongoDB** (connected), **local DB** (Mongo unreachable → history kept in a local JSON file) or **no DB**.

There is no panel. The only UI is a **thin type bar** (bottom-centre; it jumps to the top edge if Glance needs you to click something underneath it). It is click-through unless you hover it.

Press **Ctrl + Shift + G** (⌘ + Shift + G on macOS) to focus the bar. Type or speak a goal, e.g. "draw a 400×300 frame in Figma". Glance speaks the step, shows it in the bar (with progress like `2/5 ·`), and the pointer shows the exact gesture:

| Gesture | Pointer |
|---|---|
| Click / double-click / right-click / hover | pulsing reticle + caption (`DOUBLE-CLICK · Open the layer`) |
| **Drag** (draw a frame, resize, move, slider, reorder, select) | reticle at the press point, dashed arrow to a **RELEASE** ring, a ghost cursor that animates press → move → release, and the outline of the box being drawn |
| Scroll | reticle with bouncing arrows in the scroll direction |
| Type | reticle on the field + the exact text in the caption |
| Key combo | caption with the keys |

The pointer stays until the next step replaces it. Do the step yourself; when the screen changes and settles, Glance checks it and moves on.

In the bar while a session runs:
- type a remark / answer / correction and press **Enter** ("I used the Rectangle tool instead", "us-east-1")
- **Enter** on an empty bar = check my screen now
- `repeat` = say the step again, `stop` (or **Esc**) = end the session

Sessions are still saved to MongoDB (`npm run db-check` lists them) and reused automatically for similar goals.

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
│  step loop             IPC   calls the vision LLM     │ ◄────► Gemini 3.8 Flash (fallback)
│  screen-change watcher  │    coordinate conversion    │        screenshot → step + [y,x]
│  voice in / out      preload model fallback + retry   │
│                      bridge  global hotkey            │
└───────────────────────────────────────────────────────┘
```

The renderer is sandboxed: `sandbox: true`, `contextIsolation`, no Node, strict CSP. The preload bridge exposes the four core functions (`nextStep`, `sampleScreen`, `setInteractive`, `onMainEvent`) plus `history(action)` for the database, whose actions are whitelisted in main. All OS and DB access stays in the main process.

| # | Module | File |
|---|--------|------|
| 1 | Capture | `src/main/capture.js` |
| 2 | Vision & Reasoning | `src/main/vision.js` |
| 3 | Coordinate Mapper | `src/main/coords.js` |
| 4 | Overlay & Pointer (type bar, gesture guides) | `src/renderer/index.html`, `styles.css`, `renderer.js`, `src/main/main.js` (window) |
| 5 | Session & Loop | `src/renderer/renderer.js`, `src/renderer/phash.js` |
| 6 | Voice I/O | `src/renderer/voice.js` |
| 7 | Database (MongoDB) | `src/main/db.js` |

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
- On Linux and macOS, cells covered by Glance's own bar or reticle are masked out so it never reacts to itself. On Windows the overlay is excluded from capture, so nothing is masked (masking would hide the very element you are asked to click).
- Once a change is seen and two samples in a row are stable, the next step is fetched with the full history replayed. If the screen never goes quiet (video, spinner) it fetches after 8 s anyway.
- After an API error the watcher stops until you press **Enter**, so a failing or rate-limited API is never hammered in a loop.
- **Close-up check (Windows):** while a pointer is on screen, the watcher also looks at a finer crop around it (a ~20% window). A few typed letters or a toolbar highlight there count as a change if they are still there on two samples in a row (so a blinking caret is ignored). While you are still typing, it keeps waiting until you pause. Set `GLANCE_FOCUS=0` to turn this off.
- Changes elsewhere that are tiny (a toggle far from the pointer, one typed character) can still stay under the threshold. Press **Enter** or say `next` for those. `GLANCE_DEBUG=1 npm start` prints a `[watch] cells=… bits=…` line for every sample that differs, which shows how close a missed step was to firing (the limits are 4 cells / 10 bits).

## Multi-step guidance
Each model turn returns `observation`, `plan[]`, `plan_index`, `status`, `action` (click · double_click · right_click · hover · drag · scroll · type · key · none), `step`, `hint`, `target`, `type_text`, `keys`, `scroll`, `point`, `end_point` (drag release), `done`. Both `point` and `end_point` go through the same two-stage 0–1000 → pixels → display mapping.

| status | meaning | what Glance does |
|---|---|---|
| `next` | previous step worked | new step + pointer |
| `retry` | nothing happened yet | repeats/rephrases, re-points |
| `recover` | error, wrong page, dialog in the way | explains, guides back |
| `wait` | loading / installing | keeps pointer, re-checks every 3.5 s |
| `ask` | needs the user's choice or info | asks; reply in the box |
| `done` | goal visible on screen | pointer turns green, session saved as completed |

The full history is replayed every turn (last 10 turns verbatim, older ones summarised), so long procedures such as an AWS deployment keep context without blowing up the prompt. When a new goal resembles one you completed before, the earlier steps are given to the model as a reference.

## Database schema
```
users     { username (unique), displayName, createdAt, lastSeenAt, stats{sessions, completed} }
sessions  { userId, goal, status: active|completed|stopped|abandoned, startedAt, endedAt, reusedFrom,
            plan[], planIndex, stepCount, models[],
            steps[{ i, at, trigger, userNote, observation, status, step, target, type_text, keys,
                    point[y,x], pointer{x,y}, planIndex, model }] }
```
Screenshots are not stored.

## Model strategy and API keys
- The primary model is `gemini-3-flash-preview` and the fallback is `gemini-3.8-flash`. `GLANCE_FALLBACK_MODEL` can be a comma-separated list that is tried in order. All run on the `v1beta` endpoint through `@google/generative-ai`, and you can change them in `.env`.
- `GEMINI_API_KEYS=k1,k2,k3` holds any number of keys. Requests are spread across them round-robin. On a **429** the key rests (for Google's suggested retry delay, or 60 s; 30 min if the daily quota is gone) and the same request is retried at once on the next key.
- Quotas are tracked per key **and per model**: when every key is out of quota on the primary model, the fallback model is tried with the same keys.
- Gemini limits apply **per project, not per key**, so create each key in a separate project or they share one quota.
- A key rejected as invalid is disabled for the run. If every key is rate-limited the bar shows how long until the next one frees up (short waits up to 15 s are absorbed silently).
- 503/500 errors back off with jitter and retry, then fall through to the next model. A model that just overloaded is tried last for the next 45 s. A 404 (unknown or retired model) skips that model for the rest of the run. If nothing works, the error lists why each model failed.

## Voice
- **TTS**: Web Speech `speechSynthesis`.
- **STT**: Web Speech `SpeechRecognition` when it's available. The mic is also recorded to 16 kHz WAV at the same time. If recognition fails, which is common inside Electron, the audio goes to Gemini with the first request and Gemini transcribes the goal.

## Dev tools
```bash
npm test                                              # mapper, hash, prompt, DB tests (MONGODB_TEST_URI=... also runs them on MongoDB)
npm run db-check                                      # check MongoDB + list stored sessions
npm run point-test -- shot.png "open the Git panel"   # check pointing on any screenshot, writes point-test.html
GLANCE_DEBUG=1 npm start                              # saves every screenshot + mapping JSON to <userData>/debug
```
For a HiDPI screenshot, pass the display size in points, e.g. `npm run point-test -- shot.png "goal" 1440 900`.
