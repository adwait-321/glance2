'use strict';
/**
 * Offline pointing check — no Electron needed.
 *   node scripts/point-test.js <screenshot.png|jpg> "<goal>" [displayWidthPts displayHeightPts]
 * Sends the image to Gemini, maps the [y,x] 0–1000 point through the same two-stage
 * mapper the app uses, and writes point-test.html with the point drawn on the image.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Vision } = require('../src/main/vision');
const { parseKeys } = require('../src/main/keypool');
const { mapModelPoint } = require('../src/main/coords');

function imageSize(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  let i = 2; // JPEG: walk segments to SOFn
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('Unsupported image (use PNG or JPEG)');
}

(async () => {
  const [file, goal, dw, dh] = process.argv.slice(2);
  if (!file || !goal) { console.log('usage: node scripts/point-test.js <image> "<goal>" [displayW displayH]'); process.exit(1); }
  const buf = fs.readFileSync(file);
  const imagePx = imageSize(buf);
  const bounds = { x: 0, y: 0, width: Number(dw) || imagePx.width, height: Number(dh) || imagePx.height };
  const mime = buf.readUInt32BE(0) === 0x89504e47 ? 'image/png' : 'image/jpeg';

  const v = new Vision({
    apiKeys: parseKeys(process.env),
    primaryModel: process.env.GLANCE_PRIMARY_MODEL || 'gemini-3-flash-preview',
    fallbackModel: process.env.GLANCE_FALLBACK_MODEL || 'gemini-3.8-flash',
  });
  const res = await v.nextStep({ goal, history: [], imageB64: buf.toString('base64'), imageMime: mime });
  const pointer = mapModelPoint(res.point, imagePx, bounds);
  console.log(JSON.stringify({ model: res.model, step: res.step, target: res.target, point: res.point, imagePx, displayBounds: bounds, pointer }, null, 2));

  const dot = pointer
    ? `<div style="position:absolute;left:${(pointer.screenshotPx.x / imagePx.width) * 100}%;top:${(pointer.screenshotPx.y / imagePx.height) * 100}%;width:22px;height:22px;margin:-11px 0 0 -11px;border:3px solid #ff2d55;border-radius:50%;box-shadow:0 0 0 2px #fff"></div>`
    : '';
  const html = `<!doctype html><meta charset="utf-8"><title>Glance point test</title>
<body style="font:14px system-ui;background:#111;color:#eee;margin:16px">
<p><b>Goal:</b> ${goal}<br><b>Step:</b> ${res.step}<br><b>Target:</b> ${res.target} — <b>point [y,x]:</b> ${JSON.stringify(res.point)} — <b>model:</b> ${res.model}</p>
<div style="position:relative;display:inline-block;max-width:100%"><img src="data:${mime};base64,${buf.toString('base64')}" style="max-width:100%;display:block">${dot}</div></body>`;
  fs.writeFileSync('point-test.html', html);
  console.log('Wrote point-test.html');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
