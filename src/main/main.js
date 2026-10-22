'use strict';
/**
 * Main process (privileged): native screen capture, vision LLM calls,
 * coordinate conversion, model fallback + retry, global hotkey, database.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, session, systemPreferences } = require('electron');

require('dotenv').config({ path: path.join(app.getAppPath(), '.env') });

const { captureDisplay, sampleGray } = require('./capture');
const { mapModelPoint } = require('./coords');
const { Vision } = require('./vision');
const { parseKeys } = require('./keypool');
const { sameRect, alignToOverlay } = require('./overlay-align');
const { Database } = require('./db');

const HOTKEY = process.env.GLANCE_HOTKEY || 'CommandOrControl+Shift+G';
const DEBUG = process.env.GLANCE_DEBUG === '1';
const IS_LINUX = process.platform === 'linux';

let overlay = null;
let currentDisplay = null;
let vision = null;
let visionError = null;
let db = null;
let dbStatus = { kind: 'none', error: null, user: null };

try {
  vision = new Vision({
    apiKeys: parseKeys(process.env),
    primaryModel: process.env.GLANCE_PRIMARY_MODEL || 'gemini-3-flash-preview',
    fallbackModel: process.env.GLANCE_FALLBACK_MODEL || 'gemini-3.8-flash',   // comma-separated list allowed
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
      backgroundThrottling: false,      // keep the watcher + reticle animation running when unfocused
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep our own overlay out of screenshots (Windows 10 2004+/macOS). On Linux we hide it during capture instead.
  overlay.setContentProtection(true);
  setInteractive(false);
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  overlay.once('ready-to-show', () => { fitOverlay(display); overlay.showInactive(); });
  overlay.webContents.on('will-navigate', (e) => e.preventDefault());
  if (DEBUG) {   // surface the renderer's [watch] lines in the terminal
    overlay.webContents.on('console-message', (...a) => {
      const msg = typeof a[2] === 'string' ? a[2] : a[0] && a[0].message;
      if (msg && String(msg).startsWith('[watch]')) console.log(msg);
    });
  }
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Windows can drop a topmost window behind others when focus moves (taskbar, fullscreen apps, UAC).
  // Re-assert z-order so the pointer never vanishes behind the app the user is clicking.
  const keepOnTop = () => {
    if (!overlay || overlay.isDestroyed()) return;
    if (!overlay.isVisible()) overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.moveTop();
  };
  overlay.on('blur', keepOnTop);
  overlay.on('hide', () => setTimeout(keepOnTop, 50));
  setInterval(keepOnTop, 1500);
}

function setInteractive(on) {
  if (!overlay || overlay.isDestroyed()) return;
  // Click-through by default; mouse moves are still forwarded so the renderer can detect hover.
  overlay.setIgnoreMouseEvents(!on, { forward: true });
  if (on && IS_LINUX) overlay.focus(); // Linux can't forward mouse moves; activate explicitly
}

/**
 * Put the overlay exactly on a display. Electron on Windows mis-sizes a window that crosses displays with
 * different scale factors; applying the bounds twice settles it. Verified, and logged if the OS still disagrees.
 */
function fitOverlay(display) {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setBounds(display.bounds);
  overlay.setBounds(display.bounds);
  const got = overlay.getBounds();
  if (!sameRect(got, display.bounds)) {
    console.warn(`[overlay] wanted ${JSON.stringify(display.bounds)} but window is ${JSON.stringify(got)} — pointer positions are corrected for the offset`);
  }
}

function moveOverlayTo(display) {
  if (!overlay || overlay.isDestroyed()) return;
  const switched = display.id !== currentDisplay?.id;
  currentDisplay = display;                                   // always keep fresh metrics (scale / bounds can change)
  if (switched || !sameRect(overlay.getBounds(), display.bounds)) fitOverlay(display);
}

/** Latest metrics for the display the overlay is on (never a stale snapshot). */
function activeDisplay() {
  const all = screen.getAllDisplays();
  return (currentDisplay && all.find((d) => d.id === currentDisplay.id)) || screen.getPrimaryDisplay();
}

/** On Linux, setContentProtection is a no-op, so hide the overlay for the instant of capture. */
async function withOverlayHidden(fn) {
  if (!IS_LINUX || !overlay) return fn();
  overlay.setOpacity(0);
  await new Promise((r) => setTimeout(r, 60));
  try { return await fn(); } finally { overlay.setOpacity(1); }
}

async function safeDb(fn, fallback = null) {
  if (!db || !db.store) return fallback;
  try { return await fn(); } catch (e) { console.error('[db]', e.message); return fallback; }
}

// ───────────────────────── IPC (exposed via preload) ─────────────────────────
ipcMain.handle('glance:next-step', async (_e, payload) => {
  if (!vision) return { ok: false, error: visionError || 'Vision not initialised' };
  try {
    const { goal = '', history = [], goalAudio = null, reuseFrom = null } = payload || {};
    let { sessionId = null } = payload || {};
    const display = activeDisplay();

    // Past guidance for reuse (first turn only)
    let reuse = null;
    if (history.length === 0) {
      reuse = reuseFrom
        ? await safeDb(() => db.reusableById(reuseFrom))
        : await safeDb(() => db.findReusable(goal));
    }

    // 1. Capture at native resolution
    const cap = await withOverlayHidden(() => captureDisplay(display));
    const jpeg = cap.image.toJPEG(88);

    // 2. Reason
    const audio = goalAudio && goalAudio.data
      ? { mimeType: goalAudio.mimeType || 'audio/wav', data: Buffer.from(goalAudio.data).toString('base64') }
      : null;
    const res = await vision.nextStep({
      goal, history, goalAudio: audio, reuse,
      imageB64: jpeg.toString('base64'), imageMime: 'image/jpeg',
    });

    // 3. Locate: [y,x] 0–1000 → screenshot px → display point
    const ob = overlay && !overlay.isDestroyed() ? overlay.getBounds() : null;
    const pointer = alignToOverlay(mapModelPoint(res.point, cap.imagePx, cap.displayBounds), ob);
    const pointerEnd = res.action === 'drag' ? alignToOverlay(mapModelPoint(res.end_point, cap.imagePx, cap.displayBounds), ob) : null;

    // 4. Persist
    if (!sessionId) sessionId = await safeDb(() => db.startSession(res.goal || goal || '(spoken goal)', reuse ? reuse.id : null));
    const last = history[history.length - 1] || {};
    if (sessionId) {
      await safeDb(() => db.appendStep(sessionId, {
        i: history.length,
        at: new Date(),
        trigger: history.length ? (last.trigger || 'change') : 'start',
        userNote: last.userNote || '',
        observation: res.observation,
        status: res.status,
        action: res.action,
        step: res.step,
        hint: res.hint,
        target: res.target,
        type_text: res.type_text,
        keys: res.keys,
        scroll: res.scroll,
        point: Array.isArray(res.point) ? res.point : [],
        end_point: Array.isArray(res.end_point) ? res.end_point : [],
        pointer: pointer ? pointer.local : null,
        pointerEnd: pointerEnd ? pointerEnd.local : null,
        planIndex: res.plan_index,
        model: res.model,
      }, { goal: res.goal, plan: res.plan, planIndex: res.plan_index, done: res.done }));
    }

    const out = {
      ok: true,
      sessionId,
      reused: reuse ? { id: reuse.id, goal: reuse.goal } : null,
      goal: res.goal,
      observation: res.observation,
      plan: res.plan,
      plan_index: res.plan_index,
      status: res.status,
      action: res.action,
      step: res.step,
      hint: res.hint,
      target: res.target,
      type_text: res.type_text,
      keys: res.keys,
      scroll: res.scroll,
      point: Array.isArray(res.point) ? res.point : [],
      end_point: Array.isArray(res.end_point) ? res.end_point : [],
      done: res.done,
      model: res.model,
      pointer,                               // { normalized, screenshotPx, local, global } | null
      pointerEnd,                            // drag release point, same shape | null
      capture: { imagePx: cap.imagePx, displayBounds: cap.displayBounds, scaleFactor: cap.scaleFactor },
    };

    if (DEBUG) {
      const dir = path.join(app.getPath('userData'), 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      fs.writeFileSync(path.join(dir, `${stamp}.jpg`), jpeg);
      fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(out, null, 2));
      console.log('[debug]', JSON.stringify({ status: out.status, action: out.action, point: out.point, end_point: out.end_point, pointer, pointerEnd, capture: out.capture }));
    }
    return out;
  } catch (err) {
    console.error('[next-step]', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('glance:sample', async (_e, focusIn) => {
  try {
    const focus = (Array.isArray(focusIn) ? focusIn : []).slice(0, 2)
      .filter((p) => p && Number.isFinite(p.fx) && Number.isFinite(p.fy))
      .map((p) => ({ fx: Math.min(1, Math.max(0, p.fx)), fy: Math.min(1, Math.max(0, p.fy)) }));
    return { ok: true, ...(await sampleGray(activeDisplay(), focus)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Pointer self-test: runs known grid points through the real capture size + mapper + overlay, no API call. */
ipcMain.handle('glance:calibrate', async () => {
  try {
    const display = activeDisplay();
    const cap = await withOverlayHidden(() => captureDisplay(display));
    const ob = overlay.getBounds();
    const marks = [[100, 100], [100, 900], [500, 500], [900, 100], [900, 900]].map(([y, x]) => ({
      y, x, pointer: alignToOverlay(mapModelPoint([y, x], cap.imagePx, cap.displayBounds), ob),
    }));
    const info = { displayId: display.id, displayBounds: cap.displayBounds, scaleFactor: cap.scaleFactor, imagePx: cap.imagePx, overlayBounds: ob };
    console.log('[calibrate]', JSON.stringify(info));
    return { ok: true, marks, info };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.on('glance:set-interactive', (_e, on) => setInteractive(!!on));

const HISTORY_ACTIONS = {
  profile: async () => ({ ...dbStatus }),
  list: async (a) => safeDb(() => db.listSessions({ limit: Math.min(100, Number(a.limit) || 30), search: String(a.search || '').slice(0, 200) }), []),
  get: async (a) => safeDb(() => db.getSession(String(a.id))),
  delete: async (a) => safeDb(async () => { await db.deleteSession(String(a.id)); return true; }, false),
  end: async (a) => safeDb(async () => {
    const st = ['stopped', 'abandoned', 'error'].includes(a.status) ? a.status : 'stopped';
    await db.endSession(String(a.id), st);
    return true;
  }, false),
};
ipcMain.handle('glance:history', async (_e, action, args) => {
  const fn = HISTORY_ACTIONS[action];
  if (!fn) return { ok: false, error: `unknown action ${action}` };
  try { return { ok: true, data: await fn(args || {}) }; } catch (err) { return { ok: false, error: err.message }; }
});

// ───────────────────────── App lifecycle ─────────────────────────
async function initDb() {
  db = new Database({
    uri: process.env.MONGODB_URI === undefined ? 'mongodb://127.0.0.1:27017' : process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB || 'glance',
    localFile: path.join(app.getPath('userData'), 'glance-db.json'),
  });
  const username = (process.env.GLANCE_USER || os.userInfo().username || 'user').trim();
  try {
    const user = await db.init(username, process.env.GLANCE_DISPLAY_NAME || username);
    dbStatus = { kind: db.kind, error: db.error, user };
  } catch (e) {
    dbStatus = { kind: 'none', error: e.message, user: null };
    db = null;
  }
  console.log(`[db] ${dbStatus.kind}${dbStatus.user ? ` · user ${dbStatus.user.username}` : ''}${dbStatus.error ? ` · ${dbStatus.error}` : ''}`);
}

app.whenReady().then(async () => {
  // Microphone + clipboard writes for the overlay only; deny everything else.
  const allowed = new Set(['media', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* ignore */ }
  }

  const dbReady = initDb();
  createOverlay(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));

  const ok = globalShortcut.register(HOTKEY, () => {
    moveOverlayTo(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    setInteractive(true);
    overlay.show();
    overlay.focus();
    overlay.webContents.send('glance:event', { type: 'hotkey' });
  });
  if (!ok) console.error(`Could not register hotkey ${HOTKEY}`);

  overlay.webContents.once('did-finish-load', async () => {
    await dbReady;
    overlay.webContents.send('glance:event', {
      type: 'status',
      hotkey: HOTKEY.replace('CommandOrControl', process.platform === 'darwin' ? '⌘' : 'Ctrl'),
      error: visionError,
      mock: process.env.GLANCE_MOCK === '1',
      db: dbStatus,
      ownUiCaptured: process.platform !== 'win32',   // only Windows reliably keeps the overlay out of screen samples
      debug: DEBUG,
      focusWatch: process.env.GLANCE_FOCUS !== '0',   // set GLANCE_FOCUS=0 to turn the close-up change check off
    });
  });

  screen.on('display-removed', () => moveOverlayTo(screen.getPrimaryDisplay()));
  screen.on('display-metrics-changed', () => moveOverlayTo(activeDisplay()));   // resolution / scale / dock changes
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting || !db) return;
  e.preventDefault();
  quitting = true;
  await safeDb(() => db.store.endAllActive(db.user.id, 'abandoned'));
  await safeDb(() => db.close());
  app.quit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
