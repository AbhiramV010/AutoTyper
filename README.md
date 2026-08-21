# AutoTyper

A desktop autotyper built with Electron. Paste text, pick a speed, and it replays that
text as real keystrokes into whatever window you focus — editors, chat boxes, games,
remote desktop sessions, forms that block pasting.

![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Running it

```sh
npm install
npm start
```

The first `npm start` downloads the Electron runtime (~235 MB) before the window
appears; later starts are instant.

## How to type something

1. Paste your text into the big box.
2. Set the speed — **words per minute** (5 characters = 1 word, the standard
   convention) or a raw **delay per keystroke** in milliseconds.
3. Press **Start typing**, then click into the target window during the countdown.
4. Press **F6** to stop early, or **F7** as an emergency stop. Both work while
   AutoTyper is in the background, and `Esc` stops it while the app is focused.

## Options

| Setting | What it does |
| --- | --- |
| Words per minute / Delay per keystroke | Typing speed, in whichever unit you prefer. |
| Rhythm | Draws each interval from a model fitted to real typists instead of a fixed delay. See [Human typing](#human-typing). |
| Typos | Mistakes per 100 characters. Every one is noticed and backspaced away, so the text still lands correct. |
| Countdown before typing | Seconds to click into your target window before keys start flowing. |
| Extra pause per line | Added after each Enter, for editors that autocomplete or reindent. |
| Repeat / Pause between repeats | Types the text several times over. |
| Start / stop and emergency stop hotkeys | Click the box, press your combination. Registered globally. |
| Minimize on start | Gets AutoTyper out of the way when a run begins. |
| Keep on top | Pins the window above other apps. |

Everything is saved automatically and restored next launch, including the text.

## How it works

The UI is Electron. The keystrokes come from `src/typer.ps1`, a PowerShell script the
main process spawns per run, which calls the Win32 `SendInput` API through a small
inline C# shim.

Two consequences worth knowing:

- **Keys are synthesised at the OS input layer**, not posted to a specific window, so
  the target application cannot tell them apart from a physical keyboard. Text is sent
  with `KEYEVENTF_UNICODE` scan codes, so any character types correctly regardless of
  your keyboard layout — accents, symbols, CJK, even emoji. Enter and Tab are sent as
  real virtual-key presses so editors treat them as such.
- **No native modules.** Nothing to compile, no `node-gyp`, no rebuild after an
  Electron upgrade — which is what `robotjs` or `nut.js` would have cost here.

Stopping writes a flag file the engine polls between keystrokes, so it stops mid-run
without killing the process (with a `kill` 250 ms later as a fallback).

## Human typing

With **Rhythm** on, timings are not invented — they come from a model fitted to the
[136M Keystrokes dataset](https://userinterfaces.aalto.fi/136Mkeystrokes/), 2,000 sampled
participants typing 26,399 sentences, about 1.1 million keystrokes.

What the model captures:

- **Letter pairs.** Every interval is conditioned on the pair of characters being typed,
  because that is what dominates typing speed. `th` runs at 0.67× the median interval and
  `he` at 0.73×, while reaching for shifted punctuation costs far more — `e!` is 3.9×.
  Pairs with too little data back off to a character-class table (`lower>upper` is 2.99×,
  which is the cost of the shift key falling out of the data on its own), then to a global
  distribution.
- **Hold durations.** Keys are held down about 104 ms, so each keystroke is a real press
  and release rather than an instant blip.
- **Spread, but no drift.** Autocorrelation of the log interval turned out to be flat from
  lag 1 to lag 10 (~0.29) rather than decaying, which means there is no gradual speeding up
  or slowing down within a run to model — just a fixed pace per run plus variation that is
  independent keystroke to keystroke. The model does that, instead of faking a trend that
  the data does not show.
- **Mistakes and corrections.** Which wrong key gets hit comes from a confusion matrix
  recovered from the dataset's own corrections: replaying each participant's keystrokes
  reconstructs their text buffer, and a backspace is the typist stating that what they just
  typed was wrong, with the prompt sentence saying what it should have been. Characters with
  no observed confusions fall back to a QWERTY-adjacency prior. How long the mistake goes
  unnoticed, the pause before the first backspace, the rate of the backspaces, and the
  hesitation on resuming are all fitted the same way.

One deliberate departure from the data: real typists leave plenty of errors uncorrected,
but an autotyper that emits wrong text is broken, so only the *timing* of corrections is
taken from the data. Every injected mistake is always fixed, and `npm run model:verify`
asserts that across seeds, speeds, and error rates up to 50% the replayed text still
matches the input exactly.

Your WPM setting stays in charge: the model supplies the shape of the distribution, and
the whole schedule is scaled once so the run delivers the speed you asked for, measured
against your original text — corrections included.

### Rebuilding the model

The committed model (`src/model/typing-model.json`, 63 KB) holds only fitted statistics;
no raw keystrokes are redistributed. To refit it:

```sh
npm run dataset:fetch -- --n 2000
npm run model:train
npm run model:verify
npm run engine:verify
```

`dataset:fetch` reads the 1.4 GB archive's central directory over HTTP range requests and
pulls only the participants it samples, so it transfers about 45 MB rather than the whole
thing. It caches to `data/cache/` (gitignored), and re-running is incremental.

`engine:verify` runs the real PowerShell engine in `-DryRun` mode, where keystrokes are
reported instead of sent, and checks the engine reconstructs each test string exactly.

## Things to know

- **Windows only.** The UI runs anywhere; the typing engine is Win32-specific. On other
  platforms the Start button is disabled and says so.
- **Whatever has focus gets the keystrokes.** If you alt-tab mid-run, the rest of the
  text lands in the new window. Stop first.
- **Elevated targets need an elevated AutoTyper.** Windows blocks synthetic input from a
  normal process into an app running as administrator; the engine reports this instead
  of silently typing nothing.
- On a normal finish, the window stays minimized if you minimized it on start — it only
  pops back if the run failed, so it never steals focus out from under you.
- Anti-cheat systems in online games generally detect and may penalise synthetic input.

## Packaging a standalone .exe

```sh
npm run dist
```

Downloads `electron-builder` on demand and writes an installer plus a portable exe to
`dist/`.

## Layout

```
main.js                     Electron main process: window, IPC, engine lifecycle, hotkeys
preload.js                  contextBridge API exposed to the renderer
src/typer.ps1               SendInput typing engine (progress reported on stdout)
src/model/types.ts          Shape of the fitted model
src/model/sampler.ts        Text -> keystroke schedule, including typos and corrections
src/model/typing-model.json The fitted model (committed)
tools/zip-remote.ts         Read-only ZIP client over HTTP range requests
tools/fetch-dataset.ts      Samples participants from the dataset archive
tools/train-model.ts        Fits the model from cached participant logs
tools/verify-model.ts       Checks the sampler: text always replays back exactly
tools/verify-engine.ts      Checks the PowerShell engine against a real schedule
renderer/                   UI: index.html, styles.css, renderer.js
```

## License

MIT.

The typing model is derived from the 136M Keystrokes dataset, which is free for
non-commercial use with attribution:

> Vivek Dhakal, Anna Maria Feit, Per Ola Kristensson, Antti Oulasvirta.
> **Observations on Typing from 136 Million Keystrokes.**
> In Proceedings of the 2018 CHI Conference on Human Factors in Computing Systems (CHI '18), ACM, 2018.
> [doi:10.1145/3173574.3174220](https://doi.org/10.1145/3173574.3174220)
