'use strict';

/**
 * End-to-end check of the PowerShell engine against a sampled schedule.
 *
 * Dry-run mode reports keystrokes instead of sending them, covering what the
 * TypeScript tests cannot: the schedule file format and PowerShell's parsing.
 *
 *   npm run engine:verify
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keystroke, sampleSchedule } from '../src/model/sampler';
import { TypingModel } from '../src/model/types';

const MODEL_PATH = path.join(process.cwd(), 'src', 'model', 'typing-model.json');
const ENGINE_PATH = path.join(process.cwd(), 'src', 'typer.ps1');

const VK_BACK = 8;
const VK_TAB = 9;
const VK_RETURN = 13;

const CASES = [
  'The quick brown fox jumps over the lazy dog.',
  'Tabs\tand\nnewlines\tmixed in.',
  'Punctuation: "quoted", (parens), 50% & $9.99!',
  'unicode éèü ok, emoji \u{1F680} too',
];

/** Mirrors serializeSchedule in main.ts. */
function serialize(schedule: Keystroke[]): string {
  return schedule
    .map((key) => {
      let kind = 0;
      let value = 0;
      if (key.kind === 'backspace') {
        kind = 1;
        value = VK_BACK;
      } else if (key.ch === '\n') {
        kind = 1;
        value = VK_RETURN;
      } else if (key.ch === '\t') {
        kind = 1;
        value = VK_TAB;
      } else {
        value = key.ch.codePointAt(0) ?? 32;
      }
      return key.delayUs + ',' + kind + ',' + value;
    })
    .join('\n');
}

/** Rebuilds the text from the engine's dry-run report. */
function replayReport(stdout: string): string {
  const buffer: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('#T ')) continue;
    const [kind, value] = line.slice(3).split(' ').map(Number);
    if (kind === 1) {
      if (value === VK_BACK) buffer.pop();
      else if (value === VK_RETURN) buffer.push('\n');
      else if (value === VK_TAB) buffer.push('\t');
    } else {
      buffer.push(String.fromCodePoint(value));
    }
  }
  return buffer.join('');
}

function main(): void {
  if (process.platform !== 'win32') {
    console.log('Engine verification needs Windows; skipping.');
    return;
  }
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')) as TypingModel;

  let failures = 0;
  for (const text of CASES) {
    const expected = text.replace(/\r\n/g, '\n');
    const schedule = sampleSchedule(model, { text, wpm: 60, seed: 11, errorRate: 0.15 });

    const id = Math.random().toString(36).slice(2, 10);
    const textFile = path.join(os.tmpdir(), 'autotyper-test-text-' + id + '.txt');
    const scheduleFile = path.join(os.tmpdir(), 'autotyper-test-schedule-' + id + '.csv');
    fs.writeFileSync(textFile, text, 'utf8');
    fs.writeFileSync(scheduleFile, serialize(schedule), 'utf8');

    try {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', ENGINE_PATH,
          '-TextFile', textFile,
          '-ScheduleFile', scheduleFile,
          '-StartDelayMs', '0',
          '-DryRun',
        ],
        { encoding: 'utf8', timeout: 120000 },
      );

      const label = JSON.stringify(text.slice(0, 38)) + (text.length > 38 ? '...' : '');
      if (result.status !== 0) {
        failures++;
        console.log('  FAIL  ' + label + '  exit ' + result.status + ': ' + (result.stderr || '').trim().split('\n')[0]);
        continue;
      }

      const produced = replayReport(result.stdout);
      const backspaces = schedule.filter((key) => key.kind === 'backspace').length;
      if (produced === expected) {
        console.log('  ok    ' + label + '  (' + schedule.length + ' keystrokes, ' + backspaces + ' corrected)');
      } else {
        failures++;
        console.log('  FAIL  ' + label);
        console.log('        expected ' + JSON.stringify(expected));
        console.log('        produced ' + JSON.stringify(produced));
      }
    } finally {
      fs.rmSync(textFile, { force: true });
      fs.rmSync(scheduleFile, { force: true });
    }
  }

  console.log(failures ? '\n' + failures + ' engine check(s) failed' : '\nEngine reproduces every case exactly');
  if (failures) process.exit(1);
}

main();
