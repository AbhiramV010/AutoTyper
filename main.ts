'use strict';

import { app, BrowserWindow, ipcMain, globalShortcut, shell } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { Keystroke, sampleSchedule } from './src/model/sampler';
import { TypingModel } from './src/model/types';

const IS_WINDOWS = process.platform === 'win32';

/** Virtual key codes for the keys that are sent as keys rather than characters. */
const VK_BACK = 8;
const VK_TAB = 9;
const VK_RETURN = 13;

interface Settings {
  text: string;
  speedMode: 'wpm' | 'delay';
  wpm: number;
  delayMs: number;
  jitterPct: number;
  /** Draw timings from the fitted human typing model rather than a flat delay. */
  humanize: boolean;
  /** Typing mistakes per hundred characters; every one of them gets corrected. */
  errorPct: number;
  startDelaySec: number;
  lineDelayMs: number;
  repeat: number;
  repeatDelayMs: number;
  minimizeOnStart: boolean;
  alwaysOnTop: boolean;
  startHotkey: string;
  stopHotkey: string;
}

type StartOptions = Partial<Settings>;

interface RunFiles {
  text: string;
  stop: string;
  schedule: string;
}

interface HotkeyResult {
  start: string | null;
  stop: string | null;
}

let win: BrowserWindow | null = null;
let typer: ChildProcess | null = null;
let runFiles: RunFiles | null = null;
let registeredHotkeys: HotkeyResult = { start: null, stop: null };

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS: Settings = {
  text: '',
  speedMode: 'wpm',
  wpm: 240,
  delayMs: 40,
  jitterPct: 15,
  humanize: true,
  // Replaced on load with the rate fitted from the dataset.
  errorPct: 3,
  startDelaySec: 3,
  lineDelayMs: 0,
  repeat: 1,
  repeatDelayMs: 500,
  minimizeOnStart: true,
  alwaysOnTop: false,
  startHotkey: 'F6',
  stopHotkey: 'F7',
};

let cachedModel: TypingModel | null = null;

/**
 * The typing model fitted from the 136M Keystrokes dataset.
 *
 * Read from disk rather than imported so it stays a plain data file inside the
 * packaged asar, and cached because every run needs it.
 */
function typingModel(): TypingModel {
  if (!cachedModel) {
    const file = path.join(__dirname, 'src', 'model', 'typing-model.json');
    cachedModel = JSON.parse(fs.readFileSync(file, 'utf8')) as TypingModel;
  }
  return cachedModel;
}

function defaultSettings(): Settings {
  let errorPct = DEFAULT_SETTINGS.errorPct;
  try {
    errorPct = Math.round(typingModel().errors.rate * 1000) / 10;
  } catch {
    /* fall back to the literal default if the model is missing */
  }
  return { ...DEFAULT_SETTINGS, errorPct };
}

function loadSettings(): Settings {
  const defaults = defaultSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: Settings): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save settings:', (err as Error).message);
  }
}

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * The engine script has to live on the real filesystem: once the app is packaged
 * its own files sit inside an asar archive that powershell.exe cannot read.
 */
function engineScriptPath(): string {
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

function cleanupRunFiles(): void {
  if (!runFiles) return;
  for (const file of [runFiles.text, runFiles.stop, runFiles.schedule]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
  runFiles = null;
}

/** Delay between keystrokes, in milliseconds, derived from the UI settings. */
function delayForOptions(options: StartOptions): number {
  if (options.speedMode === 'wpm') {
    const wpm = Math.max(1, Number(options.wpm) || DEFAULT_SETTINGS.wpm);
    // Standard convention: one "word" is five characters.
    return 60000 / (wpm * 5);
  }
  return Math.max(0, Number(options.delayMs) || 0);
}

/** Target speed in words per minute, whichever way the user expressed it. */
function wpmForOptions(options: StartOptions): number {
  if (options.speedMode === 'delay') {
    const delayMs = Math.max(1, Number(options.delayMs) || 1);
    return 60000 / (delayMs * 5);
  }
  return Math.max(1, Number(options.wpm) || DEFAULT_SETTINGS.wpm);
}

/**
 * Samples the keystrokes for a whole run.
 *
 * Each repetition is sampled separately so its mistakes and pauses differ; a run
 * that repeated the same stumble in the same place would give itself away.
 */
function buildSchedule(options: StartOptions): Keystroke[] {
  const model = typingModel();
  const text = String(options.text ?? '');
  const repeat = Math.max(1, Math.round(Number(options.repeat) || 1));
  const repeatDelayUs = Math.round(Math.max(0, Number(options.repeatDelayMs) || 0) * 1000);
  const errorRate = Math.max(0, Math.min(0.5, (Number(options.errorPct) || 0) / 100));

  const keystrokes: Keystroke[] = [];
  for (let pass = 0; pass < repeat; pass++) {
    const schedule = sampleSchedule(model, {
      text,
      wpm: wpmForOptions(options),
      errorRate,
      lineDelayMs: Math.max(0, Number(options.lineDelayMs) || 0),
    });
    if (pass > 0 && schedule.length) schedule[0].delayUs += repeatDelayUs;
    for (const keystroke of schedule) keystrokes.push(keystroke);
  }
  return keystrokes;
}

/** One step per line: delayUs,holdUs,kind,value. See Invoke-Schedule in typer.ps1. */
function serializeSchedule(schedule: Keystroke[]): string {
  const lines: string[] = [];
  for (const keystroke of schedule) {
    let kind = 0;
    let value = 0;
    if (keystroke.kind === 'backspace') {
      kind = 1;
      value = VK_BACK;
    } else if (keystroke.ch === '\n') {
      kind = 1;
      value = VK_RETURN;
    } else if (keystroke.ch === '\t') {
      kind = 1;
      value = VK_TAB;
    } else {
      value = keystroke.ch.codePointAt(0) ?? 32;
    }
    lines.push(keystroke.delayUs + ',' + keystroke.holdUs + ',' + kind + ',' + value);
  }
  return lines.join('\n');
}

function startTyping(options: StartOptions): { ok: boolean; error?: string } {
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
    schedule: path.join(os.tmpdir(), `autotyper-schedule-${id}.csv`),
  };

  try {
    fs.writeFileSync(runFiles.text, text, 'utf8');
  } catch (err) {
    cleanupRunFiles();
    return { ok: false, error: `Could not stage the text: ${(err as Error).message}` };
  }

  let humanize = options.humanize !== false;
  if (humanize) {
    try {
      fs.writeFileSync(runFiles.schedule, serializeSchedule(buildSchedule(options)), 'utf8');
    } catch (err) {
      // A missing or unreadable model should cost the human rhythm, not the run.
      console.error('Typing model unavailable, falling back to an even pace:', (err as Error).message);
      humanize = false;
    }
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', engineScriptPath(),
    '-TextFile', runFiles.text,
    '-StopFile', runFiles.stop,
    // In humanised mode the schedule carries the timings, repeats and line
    // delays, and the flat-delay arguments below go unused.
    ...(humanize ? ['-ScheduleFile', runFiles.schedule] : []),
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
    return { ok: false, error: `Could not start the typing engine: ${(err as Error).message}` };
  }

  if (options.minimizeOnStart && win && !win.isDestroyed()) win.minimize();

  let stderr = '';
  let engineError: string | null = null;
  let buffer = '';

  typer.stdout!.setEncoding('utf8');
  typer.stdout!.on('data', (chunk: string) => {
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

  typer.stderr!.setEncoding('utf8');
  typer.stderr!.on('data', (chunk: string) => {
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

function stopTyping(): { ok: boolean } {
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

function registerHotkeys(startAccelerator: string | null, stopAccelerator: string | null): HotkeyResult {
  globalShortcut.unregisterAll();
  registeredHotkeys = { start: null, stop: null };

  const tryRegister = (accelerator: string | null, handler: () => void): string | null => {
    if (!accelerator) return null;
    try {
      return globalShortcut.register(accelerator, handler) ? accelerator : null;
    } catch {
      return null;
    }
  };

  const result: HotkeyResult = { start: null, stop: null };
  result.start = tryRegister(startAccelerator, () => send('hotkey:toggle'));
  if (stopAccelerator && stopAccelerator !== startAccelerator) {
    result.stop = tryRegister(stopAccelerator, () => {
      if (typer) stopTyping();
    });
  }

  registeredHotkeys = result;
  return result;
}

function createWindow(): void {
  const settings = loadSettings();

  win = new BrowserWindow({
    width: 820,
    height: 900,
    minWidth: 560,
    minHeight: 620,
    backgroundColor: '#14161c',
    title: 'AutoTyper',
    icon: path.join(__dirname, 'build', 'icon.ico'),
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
  win.once('ready-to-show', () => win!.show());

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
  ipcMain.handle('settings:save', (_event, settings: Settings) => {
    saveSettings(settings);
    return true;
  });
  ipcMain.handle('typing:start', (_event, options: StartOptions) => startTyping(options));
  ipcMain.handle('typing:stop', () => stopTyping());
  ipcMain.handle('typing:isRunning', () => Boolean(typer));
  ipcMain.handle('hotkeys:register', (_event, { start, stop }: { start: string | null; stop: string | null }) =>
    registerHotkeys(start, stop),
  );
  ipcMain.handle('window:setAlwaysOnTop', (_event, value: boolean) => {
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
  ipcMain.handle('model:info', () => {
    try {
      const model = typingModel();
      return {
        available: true,
        fittedErrorPct: Math.round(model.errors.rate * 1000) / 10,
        medianWpm: model.fitted.medianWpm,
        participants: model.fitted.participants,
        keystrokes: model.fitted.keystrokes,
        source: model.source.name,
        url: model.source.url,
      };
    } catch {
      return { available: false };
    }
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
