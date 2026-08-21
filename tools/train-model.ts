'use strict';

/**
 * Fits the typing model from cached 136M Keystrokes participant logs.
 *
 * Run `npm run dataset:fetch` first. Output is src/model/typing-model.json,
 * which holds only aggregate statistics -- no raw keystrokes are redistributed.
 *
 *   npm run model:train -- [--min-observations 40] [--out src/model/typing-model.json]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CharClass, LogNormal, TypingModel, charClass } from '../src/model/types';

const PARTICIPANT_DIR = path.join(process.cwd(), 'data', 'cache', 'participants');
const DEFAULT_OUT = path.join(process.cwd(), 'src', 'model', 'typing-model.json');

/** Keystrokes that produce no character but whose cost belongs to the next one. */
const MODIFIER_KEYCODES = new Set([16, 17, 18, 20, 91, 92, 93, 224]);
const BACKSPACE = 8;
/** Cursor movement makes the text buffer untrackable, so those sections are dropped. */
const NAVIGATION_KEYCODES = new Set([33, 34, 35, 36, 37, 38, 39, 40, 45, 46]);

/** Intervals outside this range are dropped as pauses or clock glitches, in ms. */
const MIN_IKI = 10;
const MAX_IKI = 5000;
const MIN_HOLD = 5;
const MAX_HOLD = 1000;

interface Event {
  kind: 'char' | 'backspace';
  ch: string;
  press: number;
  release: number;
}

interface Section {
  sentence: string;
  events: Event[];
}

/** Streaming accumulator for the mean and variance of a log-transformed quantity. */
class LogAccumulator {
  n = 0;
  private sum = 0;
  private sumSquares = 0;

  add(value: number): void {
    if (!(value > 0)) return;
    const x = Math.log(value);
    this.n++;
    this.sum += x;
    this.sumSquares += x * x;
  }

  get mu(): number {
    return this.n ? this.sum / this.n : 0;
  }

  get sigma(): number {
    if (this.n < 2) return 0;
    const variance = this.sumSquares / this.n - this.mu * this.mu;
    return variance > 0 ? Math.sqrt(variance) : 0;
  }

  toLogNormal(): LogNormal {
    return { mu: round(this.mu), sigma: round(this.sigma), n: this.n };
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Parses one participant log into sections, dropping any section the model
 * cannot interpret cleanly (missing letters, cursor movement).
 */
function parseParticipant(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections = new Map<string, { sentence: string; events: Event[]; usable: boolean }>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 9) continue;

    const sectionId = parts[1];
    const sentence = parts[2];
    const press = Number(parts[5]);
    const release = Number(parts[6]);
    const letter = parts[7];
    const keycode = Number(parts[8]);

    let section = sections.get(sectionId);
    if (!section) {
      section = { sentence, events: [], usable: true };
      sections.set(sectionId, section);
    }
    if (!section.usable) continue;

    if (!Number.isFinite(press) || !Number.isFinite(release)) {
      section.usable = false;
      continue;
    }
    if (NAVIGATION_KEYCODES.has(keycode)) {
      section.usable = false;
      continue;
    }
    if (keycode === BACKSPACE) {
      section.events.push({ kind: 'backspace', ch: '', press, release });
      continue;
    }
    if (MODIFIER_KEYCODES.has(keycode)) continue;
    if (letter.length !== 1) {
      // A printable key whose letter the collector failed to record: without it
      // the buffer cannot be replayed, so the whole section goes.
      section.usable = false;
      continue;
    }
    section.events.push({ kind: 'char', ch: letter, press, release });
  }

  const usable: Section[] = [];
  for (const section of sections.values()) {
    if (!section.usable || section.events.length < 8) continue;
    section.events.sort((a, b) => a.press - b.press);
    usable.push({ sentence: section.sentence, events: section.events });
  }
  return usable;
}

interface ErrorObservation {
  kind: 'substitution' | 'insertion' | 'transposition';
  intended: string;
  typed: string;
  /** Characters typed after the mistake before the first backspace. */
  lag: number;
}

interface SectionAnalysis {
  /** Index into events of each character keystroke, with its interval from the previous one. */
  intervals: { prev: string; ch: string; iki: number; clean: boolean }[];
  holds: { ch: string; hold: number }[];
  errors: ErrorObservation[];
  noticePauses: number[];
  backspaceIkis: number[];
  resumeIkis: number[];
}

/**
 * Replays a section's keystrokes, recovering both its timing series and the
 * mistakes the typist made and corrected.
 *
 * Errors are read off the corrections themselves: a backspace is the typist
 * declaring that what they just typed was wrong, and the sentence they were
 * shown says what it should have been.
 */
function analyzeSection(section: Section): SectionAnalysis {
  const analysis: SectionAnalysis = {
    intervals: [],
    holds: [],
    errors: [],
    noticePauses: [],
    backspaceIkis: [],
    resumeIkis: [],
  };

  const { sentence, events } = section;
  let buffer = '';
  /** Position of the first character that diverged from the sentence, if any. */
  let errorAt = -1;
  let errorTyped = '';
  let charsSinceError = 0;
  /** Marks intervals touched by a mistake so they do not pollute the clean timings. */
  let dirty = false;
  let previousChar = '';
  let previousPress = 0;
  let correcting = false;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const iki = previousPress ? event.press - previousPress : 0;

    if (event.kind === 'backspace') {
      if (!correcting && errorAt >= 0 && iki >= MIN_IKI && iki <= MAX_IKI) {
        analysis.noticePauses.push(iki);
      } else if (correcting && iki >= MIN_IKI && iki <= MAX_IKI) {
        analysis.backspaceIkis.push(iki);
      }
      correcting = true;
      dirty = true;
      buffer = buffer.slice(0, -1);
      if (errorAt >= 0 && buffer.length <= errorAt) {
        // Backspaced past the mistake: it has been dealt with.
        errorAt = -1;
        charsSinceError = 0;
      }
      previousPress = event.press;
      continue;
    }

    const hold = event.release - event.press;
    if (hold >= MIN_HOLD && hold <= MAX_HOLD) analysis.holds.push({ ch: event.ch, hold });

    if (correcting && iki >= MIN_IKI && iki <= MAX_IKI) {
      analysis.resumeIkis.push(iki);
    } else if (previousChar && iki >= MIN_IKI && iki <= MAX_IKI) {
      analysis.intervals.push({ prev: previousChar, ch: event.ch, iki, clean: !dirty });
    }
    correcting = false;

    const position = buffer.length;
    buffer += event.ch;

    if (errorAt >= 0) {
      charsSinceError++;
    } else if (position < sentence.length && event.ch !== sentence[position]) {
      errorAt = position;
      errorTyped = event.ch;
      charsSinceError = 0;
      dirty = true;
      analysis.errors.push({
        kind: classifyError(sentence, position, errorTyped, events, i),
        intended: sentence[position],
        typed: errorTyped,
        lag: countLag(events, i),
      });
    } else if (position < sentence.length) {
      // Back in step with the sentence, so later intervals are clean again.
      dirty = false;
    }

    previousChar = event.ch;
    previousPress = event.press;
  }

  return analysis;
}

/**
 * Distinguishes a straight mis-hit from a swapped pair or an extra character,
 * by looking at what the typist went on to type before correcting.
 */
function classifyError(
  sentence: string,
  position: number,
  typed: string,
  events: Event[],
  index: number,
): ErrorObservation['kind'] {
  const next = nextChar(events, index);
  if (next === null) return 'substitution';
  // "teh" for "the": this key belongs one place later, and the next one fills the gap.
  if (typed === sentence[position + 1] && next === sentence[position]) return 'transposition';
  // The sentence simply resumes after the stray key, so it was an extra press.
  if (next === sentence[position]) return 'insertion';
  return 'substitution';
}

function nextChar(events: Event[], index: number): string | null {
  for (let i = index + 1; i < events.length; i++) {
    if (events[i].kind === 'backspace') return null;
    return events[i].ch;
  }
  return null;
}

function countLag(events: Event[], index: number): number {
  let lag = 0;
  for (let i = index + 1; i < events.length; i++) {
    if (events[i].kind === 'backspace') return lag;
    lag++;
  }
  return lag;
}

function classPairKey(prev: string, ch: string): string {
  return charClass(prev) + '>' + charClass(ch);
}

interface Args {
  minObservations: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { minObservations: 40, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-observations') args.minObservations = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(PARTICIPANT_DIR)) {
    throw new Error('No cached participants. Run: npm run dataset:fetch -- --n 2000');
  }
  const files = fs.readdirSync(PARTICIPANT_DIR).filter((name) => name.endsWith('.txt'));
  if (!files.length) throw new Error('data/cache/participants is empty');

  console.log('Fitting from ' + files.length + ' participants...');

  const digraphs = new Map<string, LogAccumulator>();
  const classPairs = new Map<string, LogAccumulator>();
  const global = new LogAccumulator();
  const holds = new Map<CharClass, LogAccumulator>();
  const noticePause = new LogAccumulator();
  const backspace = new LogAccumulator();
  const resume = new LogAccumulator();

  const confusion = new Map<string, Map<string, number>>();
  const kindCounts = { substitution: 0, insertion: 0, transposition: 0 };
  const lagCounts: number[] = [];

  /** Per-participant median intervals, needed to convert the fit back to absolute ms. */
  const participantMedians: number[] = [];
  let totalSections = 0;
  let totalKeystrokes = 0;
  let totalCharacters = 0;
  let totalErrors = 0;

  const bump = (map: Map<string, LogAccumulator>, key: string, value: number) => {
    let accumulator = map.get(key);
    if (!accumulator) map.set(key, (accumulator = new LogAccumulator()));
    accumulator.add(value);
  };

  for (let f = 0; f < files.length; f++) {
    const sections = parseParticipant(fs.readFileSync(path.join(PARTICIPANT_DIR, files[f]), 'utf8'));
    if (!sections.length) continue;

    const analyses = sections.map(analyzeSection);
    const allIkis: number[] = [];
    for (const analysis of analyses) for (const interval of analysis.intervals) allIkis.push(interval.iki);
    if (allIkis.length < 100) continue;

    // Everything is fitted as a ratio to this typist's own pace, so that the
    // model captures letter-pair difficulty rather than who happened to be fast.
    const participantMedian = median(allIkis);
    if (!(participantMedian > 0)) continue;
    participantMedians.push(participantMedian);
    totalSections += sections.length;

    for (const analysis of analyses) {
      for (const interval of analysis.intervals) {
        totalKeystrokes++;
        totalCharacters++;
        if (!interval.clean) continue;
        const ratio = interval.iki / participantMedian;
        bump(digraphs, interval.prev + interval.ch, ratio);
        bump(classPairs, classPairKey(interval.prev, interval.ch), ratio);
        global.add(ratio);
      }
      for (const hold of analysis.holds) {
        const cls = charClass(hold.ch);
        let accumulator = holds.get(cls);
        if (!accumulator) holds.set(cls, (accumulator = new LogAccumulator()));
        accumulator.add(hold.hold);
      }
      for (const pause of analysis.noticePauses) noticePause.add(pause / participantMedian);
      for (const gap of analysis.backspaceIkis) backspace.add(gap / participantMedian);
      for (const gap of analysis.resumeIkis) resume.add(gap / participantMedian);

      for (const error of analysis.errors) {
        totalErrors++;
        kindCounts[error.kind]++;
        lagCounts[error.lag] = (lagCounts[error.lag] || 0) + 1;
        if (error.kind === 'substitution') {
          let row = confusion.get(error.intended);
          if (!row) confusion.set(error.intended, (row = new Map()));
          row.set(error.typed, (row.get(error.typed) || 0) + 1);
        }
      }
    }

    if ((f + 1) % 250 === 0) console.log('  ' + (f + 1) + '/' + files.length + ' parsed');
  }

  const medianIkiMs = median(participantMedians);
  console.log('Sections: ' + totalSections + ', character keystrokes: ' + totalCharacters);
  console.log('Population median interval: ' + medianIkiMs.toFixed(1) + ' ms');
  console.log('Corrected errors: ' + totalErrors + ' (' + ((100 * totalErrors) / totalCharacters).toFixed(2) + '% of characters)');

  // Second pass: with the interval means known, characterise what is left over.
  console.log('Fitting variation structure...');
  const variation = fitVariation(files, digraphs, classPairs, global);

  const model: TypingModel = {
    version: 1,
    source: {
      name: '136M Keystrokes dataset',
      url: 'https://userinterfaces.aalto.fi/136Mkeystrokes/',
      citation:
        'Dhakal, V., Feit, A., Kristensson, P.O., Oulasvirta, A. ' +
        'Observations on Typing from 136 Million Keystrokes. CHI 2018.',
      license: 'Free for non-commercial use with attribution to the authors.',
    },
    fitted: {
      date: new Date().toISOString().slice(0, 10),
      participants: participantMedians.length,
      sentences: totalSections,
      keystrokes: totalCharacters,
      medianIkiMs: round(medianIkiMs),
      medianWpm: round(60000 / (medianIkiMs * 5)),
    },
    digraphs: exportDistributions(digraphs, args.minObservations),
    classPairs: exportDistributions(classPairs, 1),
    global: global.toLogNormal(),
    holds: exportDistributions(holds as unknown as Map<string, LogAccumulator>, 1),
    variation,
    errors: {
      rate: round(totalErrors / Math.max(1, totalCharacters)),
      kinds: {
        substitution: round(kindCounts.substitution / Math.max(1, totalErrors)),
        insertion: round(kindCounts.insertion / Math.max(1, totalErrors)),
        transposition: round(kindCounts.transposition / Math.max(1, totalErrors)),
      },
      confusion: exportConfusion(confusion),
      detectionLag: exportLag(lagCounts),
      noticePause: noticePause.toLogNormal(),
      backspace: backspace.toLogNormal(),
      resume: resume.toLogNormal(),
    },
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(model, null, 1));

  const sizeKb = (fs.statSync(args.out).size / 1024).toFixed(0);
  console.log('\nWrote ' + path.relative(process.cwd(), args.out) + ' (' + sizeKb + ' KB)');
  console.log('  digraphs: ' + Object.keys(model.digraphs).length);
  console.log('  class pairs: ' + Object.keys(model.classPairs).length);
  console.log('  variation: run sd=' + variation.runSigma + ' keystroke sd=' + variation.keystrokeSigma);
  console.log('  error rate: ' + (model.errors.rate * 100).toFixed(2) + '% of characters');
}

/**
 * Splits the leftover variation into the part that is fixed for a whole run and
 * the part that changes keystroke to keystroke.
 *
 * The lag profile is reported alongside because it is what rules out a drifting
 * model: an autocorrelation that stays flat as the lag grows is a constant
 * offset, not a trend.
 */
function fitVariation(
  files: string[],
  digraphs: Map<string, LogAccumulator>,
  classPairs: Map<string, LogAccumulator>,
  global: LogAccumulator,
): TypingModel['variation'] {
  const LAGS = [1, 2, 3, 5, 10];
  const lagSums = new Map<number, { sum: number; count: number }>(LAGS.map((lag) => [lag, { sum: 0, count: 0 }]));

  let squareSum = 0;
  let count = 0;
  /** Per-section mean residual, for the between/within variance split. */
  const sectionMeans: { mean: number; n: number }[] = [];
  let withinSquareSum = 0;
  let withinCount = 0;

  const expected = (prev: string, ch: string): number => {
    const exact = digraphs.get(prev + ch);
    if (exact && exact.n >= 25) return exact.mu;
    const pair = classPairs.get(classPairKey(prev, ch));
    if (pair && pair.n >= 25) return pair.mu;
    return global.mu;
  };

  for (const file of files) {
    const sections = parseParticipant(fs.readFileSync(path.join(PARTICIPANT_DIR, file), 'utf8'));
    if (!sections.length) continue;
    const analyses = sections.map(analyzeSection);
    const allIkis: number[] = [];
    for (const analysis of analyses) for (const interval of analysis.intervals) allIkis.push(interval.iki);
    if (allIkis.length < 100) continue;
    const participantMedian = median(allIkis);
    if (!(participantMedian > 0)) continue;

    for (const analysis of analyses) {
      const residuals: (number | null)[] = [];
      for (const interval of analysis.intervals) {
        if (!interval.clean) {
          residuals.push(null);
          continue;
        }
        const residual = Math.log(interval.iki / participantMedian) - expected(interval.prev, interval.ch);
        residuals.push(residual);
        squareSum += residual * residual;
        count++;
      }

      const present = residuals.filter((value): value is number => value !== null);
      if (present.length < 10) continue;
      const sectionMean = present.reduce((sum, value) => sum + value, 0) / present.length;
      sectionMeans.push({ mean: sectionMean, n: present.length });
      for (const value of present) {
        const deviation = value - sectionMean;
        withinSquareSum += deviation * deviation;
        withinCount++;
      }

      for (const lag of LAGS) {
        const bucket = lagSums.get(lag)!;
        for (let i = lag; i < residuals.length; i++) {
          const a = residuals[i];
          const b = residuals[i - lag];
          if (a === null || b === null) continue;
          bucket.sum += a * b;
          bucket.count++;
        }
      }
    }
  }

  const variance = count ? squareSum / count : 0;
  const withinVariance = withinCount ? withinSquareSum / withinCount : 0;

  const meanOfMeans = sectionMeans.reduce((sum, s) => sum + s.mean, 0) / Math.max(1, sectionMeans.length);
  const rawBetween =
    sectionMeans.reduce((sum, s) => sum + (s.mean - meanOfMeans) ** 2, 0) / Math.max(1, sectionMeans.length);
  // A section's mean carries its own sampling error, which inflates the spread
  // of those means; subtract it so the run-level term is not overstated.
  const samplingNoise =
    sectionMeans.reduce((sum, s) => sum + withinVariance / s.n, 0) / Math.max(1, sectionMeans.length);
  const betweenVariance = Math.max(0, rawBetween - samplingNoise);

  const lagProfile: Record<string, number> = {};
  for (const lag of LAGS) {
    const bucket = lagSums.get(lag)!;
    lagProfile[String(lag)] = variance > 0 && bucket.count ? round(bucket.sum / bucket.count / variance) : 0;
  }

  console.log('  residual sd=' + round(Math.sqrt(variance)));
  console.log('  autocorrelation by lag: ' + LAGS.map((lag) => lag + '=' + lagProfile[String(lag)]).join(' '));
  console.log('  run-level sd=' + round(Math.sqrt(betweenVariance)) + ' per-keystroke sd=' + round(Math.sqrt(withinVariance)));

  return {
    runSigma: round(Math.sqrt(betweenVariance)),
    keystrokeSigma: round(Math.sqrt(withinVariance)),
    lagProfile,
  };
}

function exportDistributions(map: Map<string, LogAccumulator>, minObservations: number): Record<string, LogNormal> {
  const out: Record<string, LogNormal> = {};
  for (const [key, accumulator] of map) {
    if (accumulator.n < minObservations) continue;
    out[key] = accumulator.toLogNormal();
  }
  return out;
}

function exportConfusion(confusion: Map<string, Map<string, number>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [intended, row] of confusion) {
    const total = [...row.values()].reduce((sum, n) => sum + n, 0);
    // Too few observations to be a distribution rather than noise; the adjacency
    // prior in the sampler covers these.
    if (total < 20) continue;
    const probabilities: Record<string, number> = {};
    for (const [typed, n] of row) {
      const p = n / total;
      if (p >= 0.01) probabilities[typed] = round(p);
    }
    if (Object.keys(probabilities).length) out[intended] = probabilities;
  }
  return out;
}

function exportLag(lagCounts: number[]): number[] {
  const capped = 8;
  const bins = new Array(capped + 1).fill(0);
  for (let lag = 0; lag < lagCounts.length; lag++) {
    if (!lagCounts[lag]) continue;
    bins[Math.min(lag, capped)] += lagCounts[lag];
  }
  const total = bins.reduce((sum, n) => sum + n, 0) || 1;
  return bins.map((n) => round(n / total));
}

main();
