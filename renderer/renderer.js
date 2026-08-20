'use strict';

const api = window.autotyper;
const $ = (id) => document.getElementById(id);

const el = {
  text: $('text'),
  charCount: $('charCount'),
  wpm: $('wpm'),
  wpmRange: $('wpmRange'),
  wpmRow: $('wpmRow'),
  delayMs: $('delayMs'),
  delayRange: $('delayRange'),
  delayRow: $('delayRow'),
  jitterPct: $('jitterPct'),
  jitterRange: $('jitterRange'),
  estimate: $('estimate'),
  startDelaySec: $('startDelaySec'),
  lineDelayMs: $('lineDelayMs'),
  repeat: $('repeat'),
  repeatDelayMs: $('repeatDelayMs'),
  startHotkey: $('startHotkey'),
  stopHotkey: $('stopHotkey'),
  startHotkeyHint: $('startHotkeyHint'),
  stopHotkeyHint: $('stopHotkeyHint'),
  minimizeOnStart: $('minimizeOnStart'),
  alwaysOnTop: $('alwaysOnTop'),
  startBtn: $('startBtn'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  status: $('status'),
  statusText: $('statusText'),
  overlay: $('overlay'),
  countdown: $('countdown'),
  cancelBtn: $('cancelBtn'),
  toast: $('toast'),
};

let speedMode = 'wpm';
let running = false;
let saveTimer = null;
let toastTimer = null;

/* ------------------------------------------------------------------ *
 * Settings plumbing
 * ------------------------------------------------------------------ */

function collect() {
  return {
    text: el.text.value,
    speedMode,
    wpm: Number(el.wpm.value) || 240,
    delayMs: Number(el.delayMs.value) || 0,
    jitterPct: Number(el.jitterPct.value) || 0,
    startDelaySec: Number(el.startDelaySec.value) || 0,
    lineDelayMs: Number(el.lineDelayMs.value) || 0,
    repeat: Math.max(1, Number(el.repeat.value) || 1),
    repeatDelayMs: Number(el.repeatDelayMs.value) || 0,
    minimizeOnStart: el.minimizeOnStart.checked,
    alwaysOnTop: el.alwaysOnTop.checked,
    startHotkey: el.startHotkey.value,
    stopHotkey: el.stopHotkey.value,
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSettings(collect()), 300);
}

function apply(loaded) {
  el.text.value = loaded.text;
  el.wpm.value = loaded.wpm;
  el.delayMs.value = loaded.delayMs;
  el.jitterPct.value = loaded.jitterPct;
  el.startDelaySec.value = loaded.startDelaySec;
  el.lineDelayMs.value = loaded.lineDelayMs;
  el.repeat.value = loaded.repeat;
  el.repeatDelayMs.value = loaded.repeatDelayMs;
  el.minimizeOnStart.checked = loaded.minimizeOnStart;
  el.alwaysOnTop.checked = loaded.alwaysOnTop;
  el.startHotkey.value = loaded.startHotkey;
  el.stopHotkey.value = loaded.stopHotkey;
  setSpeedMode(loaded.speedMode);
  syncSliders();
  refreshDerived();
}

/* ------------------------------------------------------------------ *
 * Speed controls
 * ------------------------------------------------------------------ */

function setSpeedMode(mode) {
  speedMode = mode === 'delay' ? 'delay' : 'wpm';
  for (const btn of document.querySelectorAll('.seg')) {
    const active = btn.dataset.mode === speedMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  }
  el.wpmRow.classList.toggle('hidden', speedMode !== 'wpm');
  el.delayRow.classList.toggle('hidden', speedMode !== 'delay');
}

/** Paints the filled portion of a range input and mirrors it to its number box. */
function paintRange(range) {
  const min = Number(range.min);
  const max = Number(range.max);
  const pct = ((Number(range.value) - min) / (max - min)) * 100;
  range.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
}

function syncSliders() {
  el.wpmRange.value = clamp(el.wpm.value, el.wpmRange.min, el.wpmRange.max);
  el.delayRange.value = clamp(el.delayMs.value, el.delayRange.min, el.delayRange.max);
  el.jitterRange.value = clamp(el.jitterPct.value, el.jitterRange.min, el.jitterRange.max);
  [el.wpmRange, el.delayRange, el.jitterRange].forEach(paintRange);
}

function clamp(value, min, max) {
  return Math.max(Number(min), Math.min(Number(max), Number(value) || 0));
}

function perKeyDelayMs() {
  if (speedMode === 'wpm') {
    const wpm = Math.max(1, Number(el.wpm.value) || 1);
    return 60000 / (wpm * 5);
  }
  return Math.max(0, Number(el.delayMs.value) || 0);
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function refreshDerived() {
  const chars = el.text.value.length;
  const lines = el.text.value ? el.text.value.split('\n').length - 1 : 0;
  const repeat = Math.max(1, Number(el.repeat.value) || 1);

  el.charCount.textContent = `${chars.toLocaleString()} character${chars === 1 ? '' : 's'}`;

  const perKey = perKeyDelayMs();
  const pass = chars * perKey + lines * (Number(el.lineDelayMs.value) || 0);
  const total =
    pass * repeat +
    (repeat - 1) * (Number(el.repeatDelayMs.value) || 0) +
    (Number(el.startDelaySec.value) || 0) * 1000;

  if (!chars) {
    el.estimate.innerHTML = '&nbsp;';
    return;
  }
  const cps = perKey > 0 ? 1000 / perKey : Infinity;
  const rate = Number.isFinite(cps) ? `${Math.round(cps)} chars/sec` : 'as fast as possible';
  el.estimate.textContent = `About ${formatDuration(total)} at ${rate}${repeat > 1 ? ` (${repeat} passes)` : ''}.`;
}

/* ------------------------------------------------------------------ *
 * Hotkey capture
 * ------------------------------------------------------------------ */

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph']);

/** Turns a keydown event into an Electron accelerator string, or null. */
function acceleratorFrom(event) {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');

  let key = event.key;
  if (key === ' ') key = 'Space';
  else if (key === 'Escape') key = 'Esc';
  else if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
    key = key.slice(5);
  } else if (key.length === 1) key = key.toUpperCase();
  else if (!/^(F\d{1,2}|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/.test(key)) {
    return null;
  }

  parts.push(key);
  return parts.join('+');
}

function captureHotkey(input) {
  input.classList.add('capturing');
  const previous = input.value;
  input.value = 'Press a key combination...';

  const finish = (value) => {
    input.value = value;
    input.classList.remove('capturing');
    input.removeEventListener('keydown', onKeyDown);
    input.removeEventListener('blur', onBlur);
    input.blur();
    if (value !== previous) {
      scheduleSave();
      applyHotkeys();
    }
  };

  const onKeyDown = (event) => {
    event.preventDefault();
    if (event.key === 'Escape') return finish(previous);
    const accelerator = acceleratorFrom(event);
    if (accelerator) finish(accelerator);
  };
  const onBlur = () => finish(previous);

  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('blur', onBlur);
}

async function applyHotkeys() {
  const result = await api.registerHotkeys({
    start: el.startHotkey.value,
    stop: el.stopHotkey.value,
  });

  const report = (input, hint, accelerator, registered, role) => {
    const failed = Boolean(accelerator) && !registered;
    input.classList.toggle('invalid', failed);
    hint.textContent = failed
      ? `${accelerator} is already taken by another app — pick a different key.`
      : role;
  };

  report(
    el.startHotkey,
    el.startHotkeyHint,
    el.startHotkey.value,
    result.start,
    'Works even when AutoTyper is not focused.',
  );
  report(
    el.stopHotkey,
    el.stopHotkeyHint,
    el.stopHotkey.value,
    result.stop,
    el.stopHotkey.value === el.startHotkey.value
      ? 'Same as the start hotkey — pick a different key.'
      : 'Stops typing immediately.',
  );
}

/* ------------------------------------------------------------------ *
 * Run control
 * ------------------------------------------------------------------ */

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 4000);
}

function setRunning(value) {
  running = value;
  el.startBtn.textContent = value ? 'Stop' : 'Start typing';
  el.startBtn.classList.toggle('stop', value);
  el.status.dataset.state = value ? 'typing' : 'idle';
  el.statusText.textContent = value ? 'Typing' : 'Idle';
  el.text.readOnly = value;
  if (!value) el.overlay.classList.add('hidden');
}

async function start() {
  if (!el.text.value.length) {
    toast('Add some text to type first.', true);
    el.text.focus();
    return;
  }
  el.progressFill.style.width = '0%';
  el.progressText.textContent = 'Starting...';
  el.countdown.textContent = String(Number(el.startDelaySec.value) || 0);
  el.overlay.classList.toggle('hidden', !(Number(el.startDelaySec.value) > 0));

  const result = await api.start(collect());
  if (!result.ok) {
    el.overlay.classList.add('hidden');
    el.status.dataset.state = 'error';
    el.statusText.textContent = 'Error';
    toast(result.error, true);
  }
}

function stop() {
  api.stop();
  el.progressText.textContent = 'Stopping...';
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

el.startBtn.addEventListener('click', () => (running ? stop() : start()));
el.cancelBtn.addEventListener('click', stop);

for (const btn of document.querySelectorAll('.seg')) {
  btn.addEventListener('click', () => {
    setSpeedMode(btn.dataset.mode);
    refreshDerived();
    scheduleSave();
  });
}

/** Keeps a slider and its number input in lockstep. */
function linkRange(range, number) {
  range.addEventListener('input', () => {
    number.value = range.value;
    paintRange(range);
    refreshDerived();
    scheduleSave();
  });
  number.addEventListener('input', () => {
    range.value = clamp(number.value, range.min, range.max);
    paintRange(range);
    refreshDerived();
    scheduleSave();
  });
}

linkRange(el.wpmRange, el.wpm);
linkRange(el.delayRange, el.delayMs);
linkRange(el.jitterRange, el.jitterPct);

for (const input of [el.text, el.startDelaySec, el.lineDelayMs, el.repeat, el.repeatDelayMs]) {
  input.addEventListener('input', () => {
    refreshDerived();
    scheduleSave();
  });
}

el.minimizeOnStart.addEventListener('change', scheduleSave);
el.alwaysOnTop.addEventListener('change', () => {
  api.setAlwaysOnTop(el.alwaysOnTop.checked);
  scheduleSave();
});

for (const input of [el.startHotkey, el.stopHotkey]) {
  input.addEventListener('focus', () => captureHotkey(input));
  input.addEventListener('mousedown', (event) => {
    if (document.activeElement === input) event.preventDefault();
  });
}

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
  await applyHotkeys();
  const info = await api.platform();
  if (!info.supported) {
    el.startBtn.disabled = true;
    toast(`The typing engine needs Windows (detected ${info.platform}).`, true);
  }
  setRunning(await api.isRunning());
})();
