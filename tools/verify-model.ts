'use strict';

/**
 * Checks the sampled schedules before they are ever sent to a real keyboard.
 *
 * The property that matters most is that corrections cancel out exactly: however
 * many mistakes the model injects, replaying the schedule must reproduce the
 * input text character for character.
 *
 *   npm run model:verify
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keystroke, sampleSchedule } from '../src/model/sampler';
import { TypingModel } from '../src/model/types';

const MODEL_PATH = path.join(process.cwd(), 'src', 'model', 'typing-model.json');

const SAMPLES = [
  'The quick brown fox jumps over the lazy dog.',
  'Was wondering if you and Natalie connected?',
  'Hello, World! This costs $42.50 (about 15% off).',
  'const total = items.reduce((sum, x) => sum + x.price, 0);\nconsole.log(total);',
  'a',
  'ship it \u{1F680} done éè',
  '',
];

/**
 * Applies a schedule the way a text field would, so the result can be compared.
 *
 * Backspace removes a whole code point rather than a UTF-16 unit, matching what
 * editors do with an emoji.
 */
function replay(schedule: Keystroke[]): string {
  const buffer: string[] = [];
  for (const key of schedule) {
    if (key.kind === 'backspace') buffer.pop();
    else buffer.push(key.ch);
  }
  return buffer.join('');
}

function durationMs(schedule: Keystroke[]): number {
  let total = 0;
  for (const key of schedule) total += key.delayUs / 1000;
  return total;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function main(): void {
  if (!fs.existsSync(MODEL_PATH)) throw new Error('No model. Run: npm run model:train');
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')) as TypingModel;

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (!ok) failures++;
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : ''));
  };

  console.log('Text is reproduced exactly, across seeds and speeds:');
  for (const text of SAMPLES) {
    let worst = '';
    let allMatch = true;
    for (let seed = 0; seed < 200; seed++) {
      for (const wpm of [20, 60, 240]) {
        const schedule = sampleSchedule(model, { text, wpm, seed });
        const result = replay(schedule);
        if (result !== text.replace(/\r\n/g, '\n')) {
          allMatch = false;
          worst = JSON.stringify(result.slice(0, 60));
        }
      }
    }
    const label = text ? JSON.stringify(text.slice(0, 34)) + (text.length > 34 ? '...' : '') : '(empty)';
    check(label, allMatch, allMatch ? '' : 'got ' + worst);
  }

  console.log('\nText is reproduced exactly at an exaggerated error rate:');
  for (const rate of [0.1, 0.25, 0.5]) {
    let allMatch = true;
    for (let seed = 0; seed < 300; seed++) {
      const text = SAMPLES[0];
      if (replay(sampleSchedule(model, { text, wpm: 60, seed, errorRate: rate })) !== text) allMatch = false;
    }
    check('errorRate=' + rate, allMatch);
  }

  console.log('\nAstral characters stay whole:');
  {
    let ok = true;
    for (let seed = 0; seed < 200; seed++) {
      for (const key of sampleSchedule(model, { text: SAMPLES[5], wpm: 60, seed, errorRate: 0.2 })) {
        if (key.kind !== 'char') continue;
        // A lone surrogate would reach the keyboard as a broken character.
        const code = key.ch.codePointAt(0) ?? 0;
        if (code >= 0xd800 && code <= 0xdfff) ok = false;
      }
    }
    check('no lone surrogates in the schedule', ok);
  }

  console.log('\nRequested speed is delivered:');
  for (const wpm of [20, 40, 60, 100, 240]) {
    const text = SAMPLES[0];
    let totalWpm = 0;
    const runs = 200;
    for (let seed = 0; seed < runs; seed++) {
      const schedule = sampleSchedule(model, { text, wpm, seed });
      totalWpm += text.length / 5 / (durationMs(schedule) / 60000);
    }
    const realized = totalWpm / runs;
    check(wpm + ' wpm', Math.abs(realized - wpm) < 0.5, '-> ' + realized.toFixed(2) + ' wpm');
  }

  console.log('\nErrors appear at roughly the fitted rate:');
  {
    const text = SAMPLES[0];
    let backspaces = 0;
    let characters = 0;
    const runs = 2000;
    for (let seed = 0; seed < runs; seed++) {
      const schedule = sampleSchedule(model, { text, wpm: 60, seed });
      backspaces += schedule.filter((key) => key.kind === 'backspace').length;
      characters += text.length;
    }
    // Each mistake produces at least one backspace, and more when it goes
    // unnoticed for a few characters, so this runs above the raw error rate.
    const perChar = backspaces / characters;
    check(
      'backspaces per character',
      perChar > model.errors.rate * 0.5 && perChar < model.errors.rate * 6,
      perChar.toFixed(4) + ' vs fitted error rate ' + model.errors.rate,
    );

    let clean = 0;
    for (let seed = 0; seed < runs; seed++) {
      if (!sampleSchedule(model, { text, wpm: 60, seed, errorRate: 0 }).some((k) => k.kind === 'backspace')) clean++;
    }
    check('errorRate=0 never backspaces', clean === runs, clean + '/' + runs + ' clean');
  }

  console.log('\nInterval shape:');
  {
    const schedule = sampleSchedule(model, { text: SAMPLES[0].repeat(40), wpm: 60, seed: 7, errorRate: 0 });
    const intervals = schedule.map((key) => key.delayUs / 1000).filter((ms) => ms > 0);
    console.log(
      '  p5=' + percentile(intervals, 5).toFixed(0) +
        'ms  p50=' + percentile(intervals, 50).toFixed(0) +
        'ms  p95=' + percentile(intervals, 95).toFixed(0) +
        'ms  max=' + Math.max(...intervals).toFixed(0) + 'ms',
    );
    const ratio = percentile(intervals, 95) / Math.max(1, percentile(intervals, 5));
    check('spread is human rather than flat', ratio > 3, 'p95/p5 = ' + ratio.toFixed(1));
  }

  console.log('\nSample run (60 wpm, fitted error rate):');
  {
    const schedule = sampleSchedule(model, { text: SAMPLES[1], wpm: 60, seed: 3 });
    console.log('  ' + describe(schedule));
  }

  console.log(failures ? '\n' + failures + ' check(s) failed' : '\nAll checks passed');
  if (failures) process.exit(1);
}

/** Renders a schedule as text, marking backspaces and long pauses. */
function describe(schedule: Keystroke[]): string {
  let out = '';
  for (const key of schedule) {
    const ms = key.delayUs / 1000;
    if (ms > 300) out += '[' + Math.round(ms) + 'ms]';
    if (key.kind === 'backspace') out += '<bs>';
    else if (key.ch === '\n') out += '\\n';
    else out += key.ch;
  }
  return out;
}

main();
