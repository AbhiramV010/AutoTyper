'use strict';

interface LoadedSettings {
  text: string;
  speedMode: string;
  wpm: number;
  delayMs: number;
  jitterPct: number;
  startDelaySec: number;
  lineDelayMs: number;
  repeat: number;
  repeatDelayMs: number;
  minimizeOnStart: boolean;
  alwaysOnTop: boolean;
  startHotkey: string;
  stopHotkey: string;
}

interface CollectedSettings {
  text: string;
  speedMode: 'wpm';
  wpm: number;
  delayMs: number;
  jitterPct: number;
  startDelaySec: number;
  lineDelayMs: number;
  repeat: number;
  repeatDelayMs: number;
  minimizeOnStart: boolean;
  alwaysOnTop: boolean;
  startHotkey: string;
  stopHotkey: string;
}

interface StartResult {
  ok: boolean;
  error?: string;
}

interface HotkeyResult {
  start: string | null;
  stop: string | null;
}

interface PlatformInfo {
  platform: string;
  supported: boolean;
  hotkeys: HotkeyResult;
}

interface AutotyperAPI {
  loadSettings(): Promise<LoadedSettings>;
  saveSettings(settings: CollectedSettings): Promise<boolean>;
  start(options: CollectedSettings): Promise<StartResult>;
  stop(): Promise<{ ok: boolean }>;
  isRunning(): Promise<boolean>;
  registerHotkeys(hotkeys: { start: string; stop: string }): Promise<HotkeyResult>;
  setAlwaysOnTop(value: boolean): Promise<boolean>;
  restoreWindow(): Promise<boolean>;
  platform(): Promise<PlatformInfo>;
  onStarted(handler: () => void): () => void;
  onStopped(handler: (payload: { error: string | null }) => void): () => void;
  onProgress(handler: (payload: { typed: number; total: number }) => void): () => void;
  onCountdown(handler: (seconds: number) => void): () => void;
  onHotkeyToggle(handler: () => void): () => void;
}

interface Window {
  autotyper: AutotyperAPI;
}

const api = window.autotyper;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  text: $<HTMLTextAreaElement>('text'),
  charCount: $('charCount'),
  wpm: $<HTMLInputElement>('wpm'),
  wpmRange: $<HTMLInputElement>('wpmRange'),
  avgSpeedBtn: $<HTMLButtonElement>('avgSpeedBtn'),
  estimate: $('estimate'),
  startBtn: $<HTMLButtonElement>('startBtn'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  status: $('status'),
  statusText: $('statusText'),
  overlay: $('overlay'),
  countdown: $('countdown'),
  cancelBtn: $<HTMLButtonElement>('cancelBtn'),
  toast: $('toast'),
};

const AVG_HUMAN_WPM = 40;
const FIXED_JITTER_PCT = 15;
const FIXED_START_DELAY_SEC = 3;
const FIXED_LINE_DELAY_MS = 0;
const FIXED_REPEAT = 1;
const FIXED_REPEAT_DELAY_MS = 500;
const FIXED_MINIMIZE_ON_START = true;
const FIXED_ALWAYS_ON_TOP = false;
const FIXED_START_HOTKEY = 'F6';
const FIXED_STOP_HOTKEY = 'F7';

let running = false;
let saveTimer: number | undefined;
let toastTimer: number | undefined;

/* ------------------------------------------------------------------ *
 * Settings plumbing
 * ------------------------------------------------------------------ */

function collect(): CollectedSettings {
  return {
    text: el.text.value,
    speedMode: 'wpm',
    wpm: Number(el.wpm.value) || 240,
    delayMs: 0,
    jitterPct: FIXED_JITTER_PCT,
    startDelaySec: FIXED_START_DELAY_SEC,
    lineDelayMs: FIXED_LINE_DELAY_MS,
    repeat: FIXED_REPEAT,
    repeatDelayMs: FIXED_REPEAT_DELAY_MS,
    minimizeOnStart: FIXED_MINIMIZE_ON_START,
    alwaysOnTop: FIXED_ALWAYS_ON_TOP,
    startHotkey: FIXED_START_HOTKEY,
    stopHotkey: FIXED_STOP_HOTKEY,
  };
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSettings(collect()), 300);
}

function apply(loaded: LoadedSettings): void {
  el.text.value = loaded.text;
  el.wpm.value = String(loaded.wpm);
  syncSliders();
  refreshDerived();
}

/* ------------------------------------------------------------------ *
 * Speed controls
 * ------------------------------------------------------------------ */

/** Paints the filled portion of a range input and mirrors it to its number box. */
function paintRange(range: HTMLInputElement): void {
  const min = Number(range.min);
  const max = Number(range.max);
  const pct = ((Number(range.value) - min) / (max - min)) * 100;
  range.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
}

function syncSliders(): void {
  el.wpmRange.value = String(clamp(el.wpm.value, el.wpmRange.min, el.wpmRange.max));
  paintRange(el.wpmRange);
}

function clamp(value: string | number, min: string | number, max: string | number): number {
  return Math.max(Number(min), Math.min(Number(max), Number(value) || 0));
}

function perKeyDelayMs(): number {
  const wpm = Math.max(1, Number(el.wpm.value) || 1);
  return 60000 / (wpm * 5);
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function refreshDerived(): void {
  const chars = el.text.value.length;

  el.charCount.textContent = `${chars.toLocaleString()} character${chars === 1 ? '' : 's'}`;

  const perKey = perKeyDelayMs();
  const total = chars * perKey + FIXED_START_DELAY_SEC * 1000;

  if (!chars) {
    el.estimate.innerHTML = '&nbsp;';
    return;
  }
  const cps = perKey > 0 ? 1000 / perKey : Infinity;
  const rate = Number.isFinite(cps) ? `${Math.round(cps)} chars/sec` : 'as fast as possible';
  el.estimate.textContent = `About ${formatDuration(total)} at ${rate}.`;
}

/* ------------------------------------------------------------------ *
 * Run control
 * ------------------------------------------------------------------ */

function toast(message: string, isError = false): void {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 4000);
}

function setRunning(value: boolean): void {
  running = value;
  el.startBtn.textContent = value ? 'Stop' : 'Start typing';
  el.startBtn.classList.toggle('stop', value);
  el.status.dataset.state = value ? 'typing' : 'idle';
  el.statusText.textContent = value ? 'Typing' : 'Idle';
  el.text.readOnly = value;
  if (!value) el.overlay.classList.add('hidden');
}

async function start(): Promise<void> {
  if (!el.text.value.length) {
    toast('Add some text to type first.', true);
    el.text.focus();
    return;
  }
  el.progressFill.style.width = '0%';
  el.progressText.textContent = 'Starting...';
  el.countdown.textContent = String(FIXED_START_DELAY_SEC);
  el.overlay.classList.remove('hidden');

  const result = await api.start(collect());
  if (!result.ok) {
    el.overlay.classList.add('hidden');
    el.status.dataset.state = 'error';
    el.statusText.textContent = 'Error';
    toast(result.error!, true);
  }
}

function stop(): void {
  api.stop();
  el.progressText.textContent = 'Stopping...';
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

el.startBtn.addEventListener('click', () => (running ? stop() : start()));
el.cancelBtn.addEventListener('click', stop);

el.avgSpeedBtn.addEventListener('click', () => {
  el.wpm.value = String(AVG_HUMAN_WPM);
  syncSliders();
  refreshDerived();
  scheduleSave();
});

/** Keeps a slider and its number input in lockstep. */
function linkRange(range: HTMLInputElement, number: HTMLInputElement): void {
  range.addEventListener('input', () => {
    number.value = range.value;
    paintRange(range);
    refreshDerived();
    scheduleSave();
  });
  number.addEventListener('input', () => {
    range.value = String(clamp(number.value, range.min, range.max));
    paintRange(range);
    refreshDerived();
    scheduleSave();
  });
}

linkRange(el.wpmRange, el.wpm);

el.text.addEventListener('input', () => {
  refreshDerived();
  scheduleSave();
});

api.onCountdown((seconds) => {
  if (seconds > 0) {
    el.overlay.classList.remove('hidden');
    el.countdown.textContent = String(seconds);
    el.progressText.textContent = `Starting in ${seconds}s...`;
  } else {
    el.overlay.classList.add('hidden');
    el.progressText.textContent = 'Typing...';
  }
});

api.onProgress(({ typed, total }) => {
  const pct = total ? Math.round((typed / total) * 100) : 0;
  el.progressFill.style.width = `${pct}%`;
  el.progressText.textContent = `${typed.toLocaleString()} / ${total.toLocaleString()} characters (${pct}%)`;
});

api.onStarted(() => setRunning(true));

api.onStopped(async ({ error }) => {
  setRunning(false);
  if (error) {
    el.status.dataset.state = 'error';
    el.statusText.textContent = 'Error';
    el.progressText.textContent = 'Stopped';
    toast(error, true);
    // Surface the failure even if the window was minimized on start.
    await api.restoreWindow();
  } else {
    const done = el.progressFill.style.width === '100%';
    el.progressText.textContent = done ? 'Finished' : 'Stopped';
  }
});

api.onHotkeyToggle(() => (running ? stop() : start()));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && running) stop();
});

(async () => {
  apply(await api.loadSettings());
  await api.registerHotkeys({ start: FIXED_START_HOTKEY, stop: FIXED_STOP_HOTKEY });
  const info = await api.platform();
  if (!info.supported) {
    el.startBtn.disabled = true;
    toast(`The typing engine needs Windows (detected ${info.platform}).`, true);
  }
  setRunning(await api.isRunning());
})();
