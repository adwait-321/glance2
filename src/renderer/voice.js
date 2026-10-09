/**
 * Voice I/O (Module 6)
 *  - TTS: Web Speech API speechSynthesis
 *  - STT: Web Speech API SpeechRecognition when the runtime supports it.
 *         In parallel the mic is recorded to 16 kHz mono WAV; if recognition is
 *         unavailable/fails (common in Electron), the WAV is sent with the first
 *         request and Gemini transcribes the goal itself.
 */
(function (root) {
  'use strict';

  // ───────────── TTS ─────────────
  let voice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    voice = vs.find((v) => /en[-_](IN|GB|US)/i.test(v.lang) && /natural|neural|google|online/i.test(v.name))
      || vs.find((v) => /^en/i.test(v.lang)) || vs[0] || null;
  }
  if ('speechSynthesis' in root) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  function speak(text) {
    if (!('speechSynthesis' in root) || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = 1.02;
    speechSynthesis.speak(u);
  }
  function stopSpeaking() { if ('speechSynthesis' in root) speechSynthesis.cancel(); }

  // ───────────── WAV recorder ─────────────
  const TARGET_RATE = 16000;

  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  function downsample(chunks, inRate) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const flat = new Float32Array(total);
    let o = 0; for (const c of chunks) { flat.set(c, o); o += c.length; }
    if (inRate === TARGET_RATE) return flat;
    const ratio = inRate / TARGET_RATE;
    const out = new Float32Array(Math.floor(total / ratio));
    for (let i = 0; i < out.length; i++) {
      const s = Math.floor(i * ratio), e = Math.min(total, Math.floor((i + 1) * ratio));
      let acc = 0; for (let j = s; j < e; j++) acc += flat[j];
      out[i] = acc / Math.max(1, e - s);
    }
    return out;
  }

  /**
   * listen({ onInterim, maxMs }) → controller { stop(): Promise<{text, audio}> , done: Promise }
   * text  : transcript from SpeechRecognition (may be '')
   * audio : { mimeType:'audio/wav', data:ArrayBuffer } fallback recording
   */
  async function listen({ onInterim, maxMs = 10000, silenceMs = 1800 } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext();
    const srcNode = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let heardVoice = false, lastLoud = performance.now();
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let rms = 0; for (let i = 0; i < d.length; i++) rms += d[i] * d[i];
      rms = Math.sqrt(rms / d.length);
      if (rms > 0.02) { heardVoice = true; lastLoud = performance.now(); }
    };
    srcNode.connect(proc); proc.connect(ctx.destination);

    // Web Speech recognition (best effort)
    let transcript = '';
    const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
    let rec = null;
    if (SR) {
      try {
        rec = new SR();
        rec.lang = 'en-IN';
        rec.interimResults = true;
        rec.continuous = true;
        rec.onresult = (ev) => {
          let fin = '', interim = '';
          for (let i = 0; i < ev.results.length; i++) {
            if (ev.results[i].isFinal) fin += ev.results[i][0].transcript;
            else interim += ev.results[i][0].transcript;
          }
          transcript = fin.trim();
          if (onInterim) onInterim((fin + ' ' + interim).trim());
          lastLoud = performance.now();
        };
        rec.onerror = () => { rec = null; };
        rec.start();
      } catch { rec = null; }
    }

    let stopped = false, resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const started = performance.now();

    async function stop() {
      if (stopped) return done;
      stopped = true;
      clearInterval(timer);
      try { rec && rec.stop(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, rec ? 350 : 0)); // let final result land
      proc.disconnect(); srcNode.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const rate = ctx.sampleRate;
      await ctx.close();
      const pcm = downsample(chunks, rate);
      resolveDone({
        text: transcript,
        heardVoice,
        audio: { mimeType: 'audio/wav', data: encodeWav(pcm, TARGET_RATE) },
      });
      return done;
    }

    const timer = setInterval(() => {
      const now = performance.now();
      if (now - started > maxMs) stop();
      else if (heardVoice && now - lastLoud > silenceMs) stop();
    }, 200);

    return { stop, done };
  }

  root.Voice = { speak, stopSpeaking, listen };
})(window);
