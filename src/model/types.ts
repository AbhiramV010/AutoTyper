'use strict';

/**
 * Shape of the fitted typing model.
 *
 * Timings are stored as log-normal parameters over a *ratio* to the typist's own
 * median inter-key interval, not as absolute milliseconds. That separates how
 * hard a letter pair is to type from how fast the person typing it was, so the
 * app can rescale the whole distribution to whatever WPM the user asks for while
 * keeping the human shape.
 */

/** Log-normal parameters, in log space. */
export interface LogNormal {
  /** Mean of log(value). */
  mu: number;
  /** Standard deviation of log(value). */
  sigma: number;
  /** Observations the fit is based on. */
  n: number;
}

/** Coarse key categories used when an exact letter pair was never observed. */
export type CharClass = 'lower' | 'upper' | 'digit' | 'space' | 'punct' | 'newline' | 'other';

export interface ErrorModel {
  /** Corrected errors per character typed. */
  rate: number;
  /** Relative frequency of each error kind; sums to 1. */
  kinds: {
    substitution: number;
    insertion: number;
    transposition: number;
  };
  /**
   * P(typed | intended) for substitutions, as intended -> typed -> probability.
   * Pairs never seen fall back to a QWERTY-adjacency prior at sample time.
   */
  confusion: Record<string, Record<string, number>>;
  /**
   * How many further characters get typed before the mistake is noticed, as a
   * probability mass function indexed by that count (index 0 = caught at once).
   */
  detectionLag: number[];
  /** The pause before the first backspace, as a ratio to the typist's median interval. */
  noticePause: LogNormal;
  /** Interval between backspaces once correcting, as a ratio to the median interval. */
  backspace: LogNormal;
  /** Interval on the first keystroke after a correction, as a ratio to the median interval. */
  resume: LogNormal;
}

export interface TypingModel {
  version: number;
  source: {
    name: string;
    url: string;
    citation: string;
    license: string;
  };
  fitted: {
    /** ISO date the model was produced. */
    date: string;
    participants: number;
    sentences: number;
    keystrokes: number;
    /** Population median inter-key interval in ms, i.e. the speed the ratios are relative to. */
    medianIkiMs: number;
    /** The typing speed that median corresponds to, in WPM. */
    medianWpm: number;
  };

  /** Exact letter-pair intervals, keyed by the two characters. */
  digraphs: Record<string, LogNormal>;
  /** Backoff by character class, keyed "prevClass>nextClass". */
  classPairs: Record<string, LogNormal>;
  /** Last-resort backoff. */
  global: LogNormal;

  /** Key hold durations in absolute ms, keyed by character class. */
  holds: Record<string, LogNormal>;

  /**
   * How intervals vary around their letter-pair mean.
   *
   * Measured autocorrelation of the log interval is flat across lags 1 to 10
   * rather than decaying, so there is no slow drift within a run to model: what
   * looks like drift is a fixed speed level per typist and per run, on top of
   * variation that is independent keystroke to keystroke. Modelling it as such
   * keeps the sampler honest to the data instead of inventing a trend.
   */
  variation: {
    /** Log-space SD of the run-level speed offset, drawn once per run. */
    runSigma: number;
    /** Log-space SD of the independent per-keystroke variation. */
    keystrokeSigma: number;
    /** Residual autocorrelation by lag, kept as evidence for the above. */
    lagProfile: Record<string, number>;
  };

  errors: ErrorModel;
}

/** Buckets a character for model backoff. */
export function charClass(ch: string): CharClass {
  if (ch === '\n') return 'newline';
  if (ch === ' ' || ch === '\t') return 'space';
  if (ch >= 'a' && ch <= 'z') return 'lower';
  if (ch >= 'A' && ch <= 'Z') return 'upper';
  if (ch >= '0' && ch <= '9') return 'digit';
  if (/[!-/:-@[-`{-~]/.test(ch)) return 'punct';
  return 'other';
}
