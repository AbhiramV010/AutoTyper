'use strict';

/**
 * Downloads a random sample of participants from the 136M Keystrokes dataset.
 *
 *   Dhakal, Feit, Kristensson, Oulasvirta.
 *   "Observations on Typing from 136 Million Keystrokes." CHI 2018.
 *   https://userinterfaces.aalto.fi/136Mkeystrokes/
 *
 * The archive is 1.4 GB, so entries are pulled individually over range requests
 * rather than downloading the whole thing. Everything lands in data/cache/,
 * which is gitignored: only the fitted model is committed, never raw keystrokes.
 *
 * Usage:
 *   npm run dataset:list                 print archive layout and exit
 *   npm run dataset:fetch -- --n 2000    sample 2000 participants
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { RemoteZip, ZipEntry } from './zip-remote';

const ARCHIVE_URL = 'https://userinterfaces.aalto.fi/136Mkeystrokes/data/Keystrokes.zip';
// Resolved against the working directory, not __dirname: these tools run from
// the project root via npm scripts, but their compiled form lives in .tools-build.
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');
const DIRECTORY_CACHE = path.join(CACHE_DIR, 'entries.json');
const PARTICIPANT_DIR = path.join(CACHE_DIR, 'participants');

/** Participant keystroke logs are named like `Keystrokes/files/100023_keystrokes.txt`. */
const PARTICIPANT_FILE = /(?:^|\/)(\d+)_keystrokes\.txt$/;

interface Args {
  list: boolean;
  count: number;
  seed: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, count: 2000, seed: 20260820, concurrency: 6 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--list') args.list = true;
    else if (flag === '--n') args.count = Number(argv[++i]);
    else if (flag === '--seed') args.seed = Number(argv[++i]);
    else if (flag === '--concurrency') args.concurrency = Number(argv[++i]);
  }
  return args;
}

/** Deterministic PRNG so a given seed always samples the same participants. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
}

/** Reads the central directory, caching it so repeat runs skip the 20 MB fetch. */
async function loadDirectory(zip: () => Promise<RemoteZip>): Promise<ZipEntry[]> {
  if (fs.existsSync(DIRECTORY_CACHE)) {
    const cached = JSON.parse(fs.readFileSync(DIRECTORY_CACHE, 'utf8')) as ZipEntry[];
    console.log('Central directory: ' + cached.length + ' entries (cached)');
    return cached;
  }

  console.log('Reading central directory over range requests...');
  const archive = await zip();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(DIRECTORY_CACHE, JSON.stringify(archive.entries));
  console.log('Central directory: ' + archive.entries.length + ' entries');
  return archive.entries;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let downloaded = 0;
  let archive: RemoteZip | null = null;
  const openArchive = async (): Promise<RemoteZip> => {
    if (!archive) {
      archive = await RemoteZip.open(ARCHIVE_URL, { onBytes: (bytes) => { downloaded += bytes; } });
    }
    return archive;
  };

  const entries = await loadDirectory(openArchive);
  const participants = entries.filter((entry) => PARTICIPANT_FILE.test(entry.name));

  if (args.list) {
    const others = entries.filter((entry) => !PARTICIPANT_FILE.test(entry.name));
    console.log('\nParticipant logs: ' + participants.length);
    console.log('Other entries:');
    for (const entry of others.slice(0, 20)) {
      console.log('  ' + entry.name + '  (' + mib(entry.uncompressedSize) + ')');
    }
    console.log('\nSample participant entries:');
    for (const entry of participants.slice(0, 3)) {
      console.log('  ' + entry.name + '  ' + entry.compressedSize + ' -> ' + entry.uncompressedSize + ' bytes');
    }
    const totalCompressed = participants.reduce((sum, entry) => sum + entry.compressedSize, 0);
    console.log('\nMean compressed size: ' + Math.round(totalCompressed / participants.length) + ' bytes');
    return;
  }

  if (!participants.length) throw new Error('No participant logs matched in the archive');

  fs.mkdirSync(PARTICIPANT_DIR, { recursive: true });
  const sample = shuffled(participants, mulberry32(args.seed)).slice(0, args.count);
  const pending = sample.filter((entry) => {
    const id = entry.name.match(PARTICIPANT_FILE)![1];
    return !fs.existsSync(path.join(PARTICIPANT_DIR, id + '.txt'));
  });

  const estimate = pending.reduce((sum, entry) => sum + entry.compressedSize, 0);
  console.log('Sampling ' + sample.length + ' participants (' + pending.length + ' not yet cached, about ' + mib(estimate) + ' to fetch)');

  let done = 0;
  let failed = 0;
  const queue = pending.slice();

  const worker = async (): Promise<void> => {
    const zip = await openArchive();
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      const id = entry.name.match(PARTICIPANT_FILE)![1];
      try {
        const contents = await zip.read(entry);
        fs.writeFileSync(path.join(PARTICIPANT_DIR, id + '.txt'), contents);
      } catch (err) {
        failed++;
        console.warn('  skipped ' + id + ': ' + (err as Error).message);
      }
      done++;
      if (done % 100 === 0 || !queue.length) {
        process.stdout.write('  ' + done + '/' + pending.length + ' fetched (' + mib(downloaded) + ')\n');
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));

  const cached = fs.readdirSync(PARTICIPANT_DIR).filter((name) => name.endsWith('.txt'));
  console.log('\nDone. ' + cached.length + ' participant logs cached in data/cache/participants');
  console.log('Downloaded this run: ' + mib(downloaded) + (failed ? ' (' + failed + ' failed)' : ''));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
