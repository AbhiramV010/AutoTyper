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
| Humanize | Randomly varies each keystroke delay by ±*n*%, so the rhythm is not machine-perfect. |
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
main.js              Electron main process: window, IPC, engine lifecycle, hotkeys
preload.js           contextBridge API exposed to the renderer
src/typer.ps1        SendInput typing engine (progress reported on stdout)
renderer/            UI: index.html, styles.css, renderer.js
```

## License

MIT
