'use strict';

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const on =
  <T>(channel: string) =>
  (handler: (payload: T) => void) => {
    const listener = (_event: IpcRendererEvent, payload: T) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };

contextBridge.exposeInMainWorld('autotyper', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  start: (options: unknown) => ipcRenderer.invoke('typing:start', options),
  stop: () => ipcRenderer.invoke('typing:stop'),
  isRunning: () => ipcRenderer.invoke('typing:isRunning'),
  registerHotkeys: (hotkeys: unknown) => ipcRenderer.invoke('hotkeys:register', hotkeys),
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke('window:setAlwaysOnTop', value),
  restoreWindow: () => ipcRenderer.invoke('window:restore'),
  platform: () => ipcRenderer.invoke('app:platform'),
  modelInfo: () => ipcRenderer.invoke('model:info'),

  onStarted: on<void>('typing:started'),
  onStopped: on<{ error: string | null }>('typing:stopped'),
  onProgress: on<{ typed: number; total: number }>('typing:progress'),
  onCountdown: on<number>('typing:countdown'),
  onHotkeyToggle: on<void>('hotkey:toggle'),
});
