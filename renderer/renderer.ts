'use strict';

interface LoadedSettings {
  text: string;
  speedMode: string;
  wpm: number;
  delayMs: number;
  jitterPct: number;
  humanize: boolean;
  errorPct: number;
  startDelaySec: number;
  lineDelayMs: number;
  repeat: number;
  repeatDelayMs: number;
  minimizeOnStart: boolean;
  alwaysOnTop: boolean;
  startHotkey: string;
  stopHotkey: string;
  targetTitle: string;
  targetProcess: string;
}

interface CollectedSettings {
  text: string;
  speedMode: 'wpm';
  wpm: number;
  delayMs: number;
  jitterPct: number;
  humanize: boolean;
  errorPct: number;
  startDelaySec: number;
  lineDelayMs: number;
  repeat: number;
  repeatDelayMs: number;
  minimizeOnStart: boolean;
  alwaysOnTop: boolean;
  startHotkey: string;
  stopHotkey: string;
  targetHwnd: number;
  targetTitle: string;
  targetProcess: string;
}

interface StartResult {
  ok: boolean;
  error?: string;
}

interface HotkeyResult {
  start: string | null;
  stop: string | null;
}

interface ModelInfo {
  available: boolean;
  fittedErrorPct?: number;
  medianWpm?: number;
  participants?: number;
  keystrokes?: number;
  source?: string;
  url?: string;
}

interface WindowInfo {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
}

interface PlatformInfo {
  platform: string;
  supported: boolean;
  hotkeys: HotkeyResult;
}

interface AutotyperAPI {
  loadSettings(): Promise<LoadedSettings>;
  listWindows(): Promise<WindowInfo[]>;
  saveSettings(settings: CollectedSettings): Promise<boolean>;
  start(options: CollectedSettings): Promise<StartResult>;
  stop(): Promise<{ ok: boolean }>;
  isRunning(): Promise<boolean>;
  registerHotkeys(hotkeys: { start: string; stop: string }): Promise<HotkeyResult>;
  setAlwaysOnTop(value: boolean): Promise<boolean>;
  restoreWindow(): Promise<boolean>;
  platform(): Promise<PlatformInfo>;
  modelInfo(): Promise<ModelInfo>;
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
  targetWindow: $<HTMLSelectElement>('targetWindow'),
  refreshWindowsBtn: $<HTMLButtonElement>('refreshWindowsBtn'),
  targetHint: $('targetHint'),
  text: $<HTMLTextAreaElement>('text'),
  charCount: $('charCount'),
  wpm: $<HTMLInputElement>('wpm'),
  wpmRange: $<HTMLInputElement>('wpmRange'),
  avgSpeedBtn: $<HTMLButtonElement>('avgSpeedBtn'),
  humanize: $<HTMLInputElement>('humanize'),
  errorRow: $('errorRow'),
  errorPct: $<HTMLInputElement>('errorPct'),
  errorPctRange: $<HTMLInputElement>('errorPctRange'),
  humanErrorBtn: $<HTMLButtonElement>('humanErrorBtn'),
  estimate: $('estimate'),
  startBtn: $<HTMLButtonElement>('startBtn'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  overlay: $('overlay'),
  countdown: $('countdown'),
  overlayHint: $('overlayHint'),
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

/** Filled in from the fitted model once it has been read. */
let model: ModelInfo = { available: false };

let windows: WindowInfo[] = [];
/** Remembered from the last session so the same window can be re-selected. */
let savedTarget = { title: '', process: '' };

let running = false;
let saveTimer: number | undefined;
let toastTimer: number | undefined;

/* --- Settings plumbing --- */

function collect(): CollectedSettings {
  const target = selectedWindow();
  return {
    text: el.text.value,
    speedMode: 'wpm',
    wpm: Number(el.wpm.value) || 240,
    delayMs: 0,
    jitterPct: FIXED_JITTER_PCT,
    humanize: el.humanize.checked,
    errorPct: Number(el.errorPct.value) || 0,
    startDelaySec: FIXED_START_DELAY_SEC,
    lineDelayMs: FIXED_LINE_DELAY_MS,
    repeat: FIXED_REPEAT,
    repeatDelayMs: FIXED_REPEAT_DELAY_MS,
    minimizeOnStart: FIXED_MINIMIZE_ON_START,
    alwaysOnTop: FIXED_ALWAYS_ON_TOP,
    startHotkey: FIXED_START_HOTKEY,
    stopHotkey: FIXED_STOP_HOTKEY,
    targetHwnd: target?.hwnd ?? 0,
    targetTitle: target?.title ?? savedTarget.title,
    targetProcess: target?.process ?? savedTarget.process,
  };
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSettings(collect()), 300);
}

function apply(loaded: LoadedSettings): void {
  savedTarget = { title: loaded.targetTitle ?? '', process: loaded.targetProcess ?? '' };
  el.text.value = loaded.text;
  el.wpm.value = String(loaded.wpm);
  el.humanize.checked = loaded.humanize !== false;
  el.errorPct.value = String(loaded.errorPct ?? 0);
  syncSliders();
  refreshDerived();
}

/* --- Target window --- */

function selectedWindow(): WindowInfo | undefined {
  const hwnd = Number(el.targetWindow.value);
  return windows.find((w) => w.hwnd === hwnd);
}

function windowLabel(info: WindowInfo): string {
  const title = info.title.length > 70 ? `${info.title.slice(0, 69)}\u2026` : info.title;
  return `${title}  \u2014  ${info.process}`;
}

/** Re-reads the open windows, keeping the current pick if it is still there. */
async function refreshWindows(): Promise<void> {
  const previous = selectedWindow();
  el.refreshWindowsBtn.disabled = true;
  try {
    windows = await api.listWindows();
  } finally {
    el.refreshWindowsBtn.disabled = running;
  }

  el.targetWindow.textContent = '';

  if (!windows.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'No open windows found';
    el.targetWindow.append(empty);
    el.targetWindow.disabled = true;
    el.targetHint.textContent = 'Open the window you want to type into, then hit Refresh.';
    return;
  }

  el.targetWindow.disabled = running;
  for (const info of windows) {
    const option = document.createElement('option');
    option.value = String(info.hwnd);
    option.textContent = windowLabel(info);
    el.targetWindow.append(option);
  }

  // Keep the live pick if it survived; otherwise fall back to the saved one.
  const match =
    (previous && windows.find((w) => w.hwnd === previous.hwnd)) ??
    windows.find((w) => w.title === savedTarget.title && w.process === savedTarget.process) ??
    windows.find((w) => w.process === savedTarget.process);
  el.targetWindow.value = String((match ?? windows[0]).hwnd);

  refreshTargetHint();
}

function refreshTargetHint(): void {
  const target = selectedWindow();
  el.targetHint.textContent = target
    ? `AutoTyper brings ${target.process} to the front when typing starts, and stops if focus moves away.`
    : 'Pick the window the keystrokes should go to.';
}

/* --- Speed controls --- */

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
  el.errorPctRange.value = String(clamp(el.errorPct.value, el.errorPctRange.min, el.errorPctRange.max));
  paintRange(el.errorPctRange);
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
  el.errorRow.classList.toggle('disabled', !el.humanize.checked);
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

/* --- Run control --- */

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
  el.text.readOnly = value;
  el.targetWindow.disabled = value || !windows.length;
  el.refreshWindowsBtn.disabled = value;
  if (!value) el.overlay.classList.add('hidden');
}

async function start(): Promise<void> {
  const target = selectedWindow();
  if (!target) {
    toast('Pick the window to type into first.', true);
    await refreshWindows();
    return;
  }
  if (!el.text.value.length) {
    toast('Add some text to type first.', true);
    el.text.focus();
    return;
  }
  el.overlayHint.textContent = `Switching to ${target.title}...`;
  el.progressFill.style.width = '0%';
  el.progressText.textContent = 'Starting...';
  el.countdown.textContent = String(FIXED_START_DELAY_SEC);
  el.overlay.classList.remove('hidden');

  const result = await api.start(collect());
  if (!result.ok) {
    el.overlay.classList.add('hidden');
    el.progressText.textContent = 'Ready';
    toast(result.error!, true);
  }
}

function stop(): void {
  api.stop();
  el.progressText.textContent = 'Stopping...';
}

/* --- Wiring --- */

el.startBtn.addEventListener('click', () => (running ? stop() : start()));
el.refreshWindowsBtn.addEventListener('click', () => refreshWindows());

el.targetWindow.addEventListener('change', () => {
  const target = selectedWindow();
  if (target) savedTarget = { title: target.title, process: target.process };
  refreshTargetHint();
  scheduleSave();
});

// The list goes stale as soon as the user leaves; re-read it when they return.
window.addEventListener('focus', () => {
  if (!running) refreshWindows();
});

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
linkRange(el.errorPctRange, el.errorPct);

el.humanize.addEventListener('change', () => {
  refreshDerived();
  scheduleSave();
});

el.humanErrorBtn.addEventListener('click', () => {
  el.errorPct.value = String(model.fittedErrorPct ?? 3);
  syncSliders();
  refreshDerived();
  scheduleSave();
});

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
  model = await api.modelInfo();
  apply(await api.loadSettings());
  await refreshWindows();
  await api.registerHotkeys({ start: FIXED_START_HOTKEY, stop: FIXED_STOP_HOTKEY });
  const info = await api.platform();
  if (!info.supported) {
    el.startBtn.disabled = true;
    toast(`The typing engine needs Windows (detected ${info.platform}).`, true);
  }
  setRunning(await api.isRunning());
})();
