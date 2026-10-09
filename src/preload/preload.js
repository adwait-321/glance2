'use strict';
/**
 * Preload bridge — the ONLY surface between the sandboxed renderer and the privileged main process.
 * Exactly four functions are exposed.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glance', {
  /** Capture → LLM → coordinate mapping. payload: { goal, history, goalAudio? } */
  nextStep: (payload) => ipcRenderer.invoke('glance:next-step', payload),

  /** 32×18 grayscale sample of the screen for the change watcher. */
  sampleScreen: () => ipcRenderer.invoke('glance:sample'),

  /** true = overlay receives the mouse; false = click-through to the app underneath. */
  setInteractive: (on) => ipcRenderer.send('glance:set-interactive', !!on),

  /** Subscribe to main-process events ({type:'hotkey'} | {type:'status', ...}). */
  onMainEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('glance:event', handler);
    return () => ipcRenderer.removeListener('glance:event', handler);
  },
});
