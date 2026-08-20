'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const IS_WINDOWS = process.platform === 'win32';

/** @type {BrowserWindow | null} */
let win = null;
/** @type {import('node:child_process').ChildProcess | null} */
let typer = null;
/** Temp files backing the current run. */
let runFiles = null;
let registeredHotkeys = { start: null, stop: null };

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  text: '',
  speedMode: 'wpm',
  wpm: 240,
  delayMs: 40,
  jitterPct: 15,
  startDelaySec: 3,
  lineDelayMs: 0,
  repeat: 1,
  repeatDelayMs: 500,
  minimizeOnStart: true,
  alwaysOnTop: false,
  startHotkey: 'F6',
  stopHotkey: 'F7',
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * The engine script has to live on the real filesystem: once the app is packaged
 * its own files sit inside an asar archive that powershell.exe cannot read.
 */
function engineScriptPath() {
  const source = path.join(__dirname, 'src', 'typer.ps1');
  const target = path.join(os.tmpdir(), `autotyper-engine-${app.getVersion()}.ps1`);
  const script = fs.readFileSync(source);
  let needsWrite = true;
  try {
    needsWrite = !fs.readFileSync(target).equals(script);
  } catch {
    /* not written yet */
  }
  if (needsWrite) fs.writeFileSync(target, script);
  return target;
}

function cleanupRunFiles() {
  if (!runFiles) return;
  for (const file of [runFiles.text, runFiles.stop]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
  runFiles = null;
}

/** Delay between keystrokes, in milliseconds, derived from the UI settings. */
function delayForOptions(options) {
  if (options.speedMode === 'wpm') {
    const wpm = Math.max(1, Number(options.wpm) || DEFAULT_SETTINGS.wpm);
    // Standard convention: one "word" is five characters.
    return 60000 / (wpm * 5);
  }
  return Math.max(0, Number(options.delayMs) || 0);
}

function startTyping(options) {
  if (typer) return { ok: false, error: 'Already typing.' };
  if (!IS_WINDOWS) {
    return { ok: false, error: 'The typing engine currently supports Windows only.' };
  }

  const text = String(options.text ?? '');
  if (!text.length) return { ok: false, error: 'There is no text to type.' };

  const id = crypto.randomBytes(6).toString('hex');
  runFiles = {
    text: path.join(os.tmpdir(), `autotyper-text-${id}.txt`),
    stop: path.join(os.tmpdir(), `autotyper-stop-${id}.flag`),
  };

  try {
    fs.writeFileSync(runFiles.text, text, 'utf8');
  } catch (err) {
    cleanupRunFiles();
    return { ok: false, error: `Could not stage the text: ${err.message}` };
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', engineScriptPath(),
    '-TextFile', runFiles.text,
    '-StopFile', runFiles.stop,
    '-DelayUs', String(Math.round(delayForOptions(options) * 1000)),
    '-JitterPct', String(Math.round(Number(options.jitterPct) || 0)),
    '-StartDelayMs', String(Math.round((Number(options.startDelaySec) || 0) * 1000)),
    '-Repeat', String(Math.max(1, Math.round(Number(options.repeat) || 1))),
    '-LineDelayMs', String(Math.round(Number(options.lineDelayMs) || 0)),
    '-RepeatDelayMs', String(Math.round(Number(options.repeatDelayMs) || 0)),
  ];

  try {
    typer = spawn('powershell.exe', args, { windowsHide: true });
  } catch (err) {
    cleanupRunFiles();
    return { ok: false, error: `Could not start the typing engine: ${err.message}` };
  }

  if (options.minimizeOnStart && win && !win.isDestroyed()) win.minimize();

  let stderr = '';
  let engineError = null;
  let buffer = '';

  typer.stdout.setEncoding('utf8');
  typer.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('#C ')) {
        send('typing:countdown', Number(line.slice(3)));
      } else if (line.startsWith('#P ')) {
        const [typed, total] = line.slice(3).split(' ').map(Number);
        send('typing:progress', { typed, total });
      } else if (line.startsWith('#E ')) {
        engineError = line.slice(3);
      }
    }
  });

  typer.stderr.setEncoding('utf8');
  typer.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  typer.on('error', (err) => {
    engineError = err.message;
  });

  typer.on('close', () => {
    typer = null;
    cleanupRunFiles();
    const error = engineError || (stderr.trim() ? stderr.trim().split('\n')[0] : null);
    send('typing:stopped', { error });
  });

  send('typing:started');
  return { ok: true };
}

function stopTyping() {
  if (!typer) return { ok: false };
  // The flag lets the engine finish the keystroke it is on and exit cleanly;
  // killing the process is the fallback if it is wedged somewhere.
  try {
    if (runFiles) fs.writeFileSync(runFiles.stop, '');
  } catch {
    /* fall through to the kill below */
  }
  const doomed = typer;
  setTimeout(() => {
    if (doomed && !doomed.killed && doomed.exitCode === null) doomed.kill();
  }, 250);
  return { ok: true };
}

function registerHotkeys(startAccelerator, stopAccelerator) {
  globalShortcut.unregisterAll();
  registeredHotkeys = { start: null, stop: null };

  const tryRegister = (accelerator, handler) => {
    if (!accelerator) return null;
    try {
      return globalShortcut.register(accelerator, handler) ? accelerator : null;
    } catch {
      return null;
    }
  };

  const result = { start: null, stop: null };
  result.start = tryRegister(startAccelerator, () => send('hotkey:toggle'));
  if (stopAccelerator && stopAccelerator !== startAccelerator) {
    result.stop = tryRegister(stopAccelerator, () => {
      if (typer) stopTyping();
    });
  }

  registeredHotkeys = result;
  return result;
}

function createWindow() {
  const settings = loadSettings();

  win = new BrowserWindow({
    width: 820,
    height: 900,
    minWidth: 560,
    minHeight: 620,
    backgroundColor: '#14161c',
    title: 'AutoTyper',
    show: false,
    alwaysOnTop: Boolean(settings.alwaysOnTop),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  ipcMain.handle('settings:load', () => loadSettings());
  ipcMain.handle('settings:save', (_event, settings) => {
    saveSettings(settings);
    return true;
  });
  ipcMain.handle('typing:start', (_event, options) => startTyping(options));
  ipcMain.handle('typing:stop', () => stopTyping());
  ipcMain.handle('typing:isRunning', () => Boolean(typer));
  ipcMain.handle('hotkeys:register', (_event, { start, stop }) => registerHotkeys(start, stop));
  ipcMain.handle('window:setAlwaysOnTop', (_event, value) => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(Boolean(value));
    return Boolean(value);
  });
  ipcMain.handle('window:restore', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return true;
  });
  ipcMain.handle('app:platform', () => ({
    platform: process.platform,
    supported: IS_WINDOWS,
    hotkeys: registeredHotkeys,
  }));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (typer) {
    try {
      typer.kill();
    } catch {
      /* shutting down anyway */
    }
  }
  cleanupRunFiles();
});

app.on('window-all-closed', () => {
  app.quit();
});
