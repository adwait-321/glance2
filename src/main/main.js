'use strict';
/**
 * Main process (privileged): native screen capture, vision LLM calls,
 * coordinate conversion, model fallback + retry, global hotkey.
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, session, systemPreferences } = require('electron');

require('dotenv').config({ path: path.join(app.getAppPath(), '.env') });

const { captureDisplay, sampleGray } = require('./capture');
const { mapModelPoint } = require('./coords');
const { Vision } = require('./vision');

const HOTKEY = process.env.GLANCE_HOTKEY || 'CommandOrControl+Shift+G';
const DEBUG = process.env.GLANCE_DEBUG === '1';
const IS_LINUX = process.platform === 'linux';

let overlay = null;
let currentDisplay = null;
let vision = null;
let visionError = null;

try {
  vision = new Vision({
    apiKey: process.env.GEMINI_API_KEY,
    primaryModel: process.env.GLANCE_PRIMARY_MODEL || 'gemini-3-flash-preview',
    fallbackModel: process.env.GLANCE_FALLBACK_MODEL || 'gemini-2.5-flash',
  });
} catch (e) {
  visionError = e.message;
}

// ───────────────────────── Overlay window ─────────────────────────
function createOverlay(display) {
  currentDisplay = display;
  const b = display.bounds;
  overlay = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep our own overlay out of screenshots (Windows 10 2004+/macOS). On Linux we hide it during capture instead.
  overlay.setContentProtection(true);
  setInteractive(false);
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.webContents.on('will-navigate', (e) => e.preventDefault());
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function setInteractive(on) {
  if (!overlay || overlay.isDestroyed()) return;
  // Click-through by default; mouse moves are still forwarded so the renderer can detect hover.
  overlay.setIgnoreMouseEvents(!on, { forward: true });
  if (on && IS_LINUX) overlay.focus(); // Linux can't forward mouse moves; activate explicitly
}

function moveOverlayTo(display) {
  if (!overlay || display.id === currentDisplay?.id) return;
  currentDisplay = display;
  overlay.setBounds(display.bounds);
}

/** On Linux, setContentProtection is a no-op, so hide the overlay for the instant of capture. */
async function withOverlayHidden(fn) {
  if (!IS_LINUX || !overlay) return fn();
  overlay.setOpacity(0);
  await new Promise((r) => setTimeout(r, 60));
  try { return await fn(); } finally { overlay.setOpacity(1); }
}

// ───────────────────────── IPC (exposed via preload) ─────────────────────────
ipcMain.handle('glance:next-step', async (_e, payload) => {
  if (!vision) return { ok: false, error: visionError || 'Vision not initialised' };
  try {
    const { goal = '', history = [], goalAudio = null } = payload || {};
    const display = currentDisplay || screen.getPrimaryDisplay();

    // 1. Capture at native resolution
    const cap = await withOverlayHidden(() => captureDisplay(display));
    const jpeg = cap.image.toJPEG(88);

    // 2. Reason
    const audio = goalAudio && goalAudio.data
      ? { mimeType: goalAudio.mimeType || 'audio/wav', data: Buffer.from(goalAudio.data).toString('base64') }
      : null;
    const res = await vision.nextStep({
      goal, history, goalAudio: audio,
      imageB64: jpeg.toString('base64'), imageMime: 'image/jpeg',
    });

    // 3. Locate: [y,x] 0–1000 → screenshot px → display point
    const pointer = mapModelPoint(res.point, cap.imagePx, cap.displayBounds);

    const out = {
      ok: true,
      goal: res.goal,
      step: res.step,
      target: res.target,
      point: Array.isArray(res.point) ? res.point : [],
      done: res.done,
      model: res.model,
      pointer,                               // { normalized, screenshotPx, local, global } | null
      capture: { imagePx: cap.imagePx, displayBounds: cap.displayBounds, scaleFactor: cap.scaleFactor },
    };

    if (DEBUG) {
      const dir = path.join(app.getPath('userData'), 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      fs.writeFileSync(path.join(dir, `${stamp}.jpg`), jpeg);
      fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(out, null, 2));
      console.log('[debug]', JSON.stringify({ point: out.point, pointer, capture: out.capture }));
    }
    return out;
  } catch (err) {
    console.error('[next-step]', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('glance:sample', async () => {
  try {
    const display = currentDisplay || screen.getPrimaryDisplay();
    return { ok: true, ...(await sampleGray(display)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('glance:set-interactive', (_e, on) => setInteractive(!!on));

// ───────────────────────── App lifecycle ─────────────────────────
app.whenReady().then(async () => {
  // Allow microphone for the overlay only; deny everything else.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* ignore */ }
  }

  createOverlay(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));

  const ok = globalShortcut.register(HOTKEY, () => {
    moveOverlayTo(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    setInteractive(true);
    overlay.show();
    overlay.focus();
    overlay.webContents.send('glance:event', { type: 'hotkey' });
  });
  if (!ok) console.error(`Could not register hotkey ${HOTKEY}`);

  overlay.webContents.once('did-finish-load', () => {
    overlay.webContents.send('glance:event', {
      type: 'status',
      hotkey: HOTKEY.replace('CommandOrControl', process.platform === 'darwin' ? '⌘' : 'Ctrl'),
      error: visionError,
      mock: process.env.GLANCE_MOCK === '1',
    });
  });

  screen.on('display-removed', () => moveOverlayTo(screen.getPrimaryDisplay()));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
