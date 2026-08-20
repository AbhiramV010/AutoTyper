'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('autotyper', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  start: (options) => ipcRenderer.invoke('typing:start', options),
  stop: () => ipcRenderer.invoke('typing:stop'),
  isRunning: () => ipcRenderer.invoke('typing:isRunning'),
  registerHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:register', hotkeys),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:setAlwaysOnTop', value),
  restoreWindow: () => ipcRenderer.invoke('window:restore'),
  platform: () => ipcRenderer.invoke('app:platform'),

  onStarted: on('typing:started'),
  onStopped: on('typing:stopped'),
  onProgress: on('typing:progress'),
  onCountdown: on('typing:countdown'),
  onHotkeyToggle: on('hotkey:toggle'),
});
