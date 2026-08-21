'use strict';

/**
 * Types into a real text box with real keystrokes and checks what arrives.
 *
 * This is the only test that exercises the actual Win32 input path, where key
 * repeat and focus behaviour live. It takes over the keyboard for a few seconds
 * per case, so it is not part of the normal verification run.
 *
 *   npm run live:verify
 *
 * Do not touch the keyboard while it runs.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keystroke, sampleSchedule } from '../src/model/sampler';
import { TypingModel } from '../src/model/types';

const MODEL_PATH = path.join(process.cwd(), 'src', 'model', 'typing-model.json');
const ENGINE_PATH = path.join(process.cwd(), 'src', 'typer.ps1');
const TARGET_PATH = path.join(process.cwd(), 'tools', 'typing-target.ps1');

const VK_BACK = 8;
const VK_TAB = 9;
const VK_RETURN = 13;

interface Case {
  text: string;
  wpm: number;
  errorRate: number;
}

const CASES: Case[] = [
  // The speed the reported corruption showed up at, with corrections in play.
  { text: 'Fusce nec suscipit ipsum, quis ullamcorper lacus.', wpm: 60, errorRate: 0.05 },
  // Slow enough that any per-key hold would be long: the key-repeat case.
  { text: 'slow and steady wins', wpm: 20, errorRate: 0.05 },
  { text: 'Punctuation: "quoted", (parens), 50% & $9.99!', wpm: 90, errorRate: 0.03 },
  { text: 'no mistakes at all here', wpm: 120, errorRate: 0 },
  { text: 'heavy corrections stress test', wpm: 60, errorRate: 0.3 },
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

function unescape(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
}

function main(): void {
  if (process.platform !== 'win32') {
    console.log('Live verification needs Windows; skipping.');
    return;
  }
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')) as TypingModel;

  console.log('Typing into a test window with real keystrokes.');
  console.log('Do not touch the keyboard or click away until this finishes.\n');

  let failures = 0;
  for (const testCase of CASES) {
    const schedule = sampleSchedule(model, {
      text: testCase.text,
      wpm: testCase.wpm,
      errorRate: testCase.errorRate,
    });
    const corrections = schedule.filter((key) => key.kind === 'backspace').length;

    const id = Math.random().toString(36).slice(2, 10);
    const textFile = path.join(os.tmpdir(), 'autotyper-live-text-' + id + '.txt');
    const scheduleFile = path.join(os.tmpdir(), 'autotyper-live-schedule-' + id + '.csv');
    fs.writeFileSync(textFile, testCase.text, 'utf8');
    fs.writeFileSync(scheduleFile, serialize(schedule), 'utf8');

    const label = testCase.wpm + ' wpm, ' + corrections + ' corrections';
    try {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', TARGET_PATH,
          '-Engine', ENGINE_PATH,
          '-TextFile', textFile,
          '-ScheduleFile', scheduleFile,
        ],
        { encoding: 'utf8', timeout: 180000 },
      );

      const line = (result.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
      if (!line) {
        failures++;
        console.log('  FAIL  ' + label + '  no result: ' + (result.stderr || '').trim().split('\n')[0]);
        continue;
      }

      const produced = unescape(line.slice(7));
      if (produced === testCase.text) {
        console.log('  ok    ' + label + '  ' + JSON.stringify(testCase.text.slice(0, 40)));
      } else {
        failures++;
        console.log('  FAIL  ' + label);
        console.log('        wanted ' + JSON.stringify(testCase.text));
        console.log('        got    ' + JSON.stringify(produced));
      }
    } finally {
      fs.rmSync(textFile, { force: true });
      fs.rmSync(scheduleFile, { force: true });
    }
  }

  console.log(failures ? '\n' + failures + ' live check(s) failed' : '\nEvery case arrived exactly as written');
  if (failures) process.exit(1);
}

main();
