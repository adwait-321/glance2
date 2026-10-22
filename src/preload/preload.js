'use strict';
/**
 * Preload bridge — the ONLY surface between the sandboxed renderer and the privileged main process.
 * Five functions: the four core ones + a whitelisted history/database channel.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glance', {
  /** Capture → LLM → coordinate mapping → DB log. payload: { goal, history, sessionId?, goalAudio?, reuseFrom? } */
  nextStep: (payload) => ipcRenderer.invoke('glance:next-step', payload),

  /** 32×18 grayscale sample of the screen for the change watcher. */
  sampleScreen: (focus) => ipcRenderer.invoke('glance:sample', focus || []),

  /** Pointer self-test (no API call): known grid points through the real capture + mapper. */
  calibrate: () => ipcRenderer.invoke('glance:calibrate'),

  /** true = overlay receives the mouse; false = click-through to the app underneath. */
  setInteractive: (on) => ipcRenderer.send('glance:set-interactive', !!on),

  /** Subscribe to main-process events ({type:'hotkey'} | {type:'status', ...}). */
  onMainEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('glance:event', handler);
    return () => ipcRenderer.removeListener('glance:event', handler);
  },

  /** Database: action ∈ profile | list | get | delete | end (validated in main). */
  history: (action, args) => ipcRenderer.invoke('glance:history', String(action), args || {}),
});
