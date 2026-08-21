<#
  AutoTyper typing engine.

  Reads UTF-8 text from a file and replays it as real keyboard input via the
  Win32 SendInput API, so any focused application receives it exactly as if it
  had been typed by hand.

  Protocol on stdout (consumed by the Electron main process):
    #C <secondsRemaining>     countdown tick before typing starts
    #P <typedChars> <total>   progress
    #E <message>              fatal error
    #D                        done
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [string]$StopFile = '',
  # When given, timings come from this pre-sampled schedule instead of the flat
  # delay below. See src/model/sampler.ts for how it is produced.
  [string]$ScheduleFile = '',
  [int]$DelayUs = 40000,
  [int]$JitterPct = 0,
  [int]$StartDelayMs = 3000,
  [int]$Repeat = 1,
  [int]$LineDelayMs = 0,
  [int]$RepeatDelayMs = 500,
  # Reports what would be typed instead of sending it, for testing the engine
  # without taking over the keyboard. Waits are skipped so a run finishes fast.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Delay is passed in whole microseconds so it survives the argument round-trip on
# every locale; a fractional string like "41.666" would be misparsed as 41666
# under a comma-decimal culture.
$DelayMs = $DelayUs / 1000.0
$OutputEncoding = [System.Text.Encoding]::UTF8

function Emit([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AutoTyperNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    // Union of MOUSE/KEYBD/HARDWARE input. On x64 the union starts at offset 8
    // and the whole struct is 40 bytes.
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    public struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private static INPUT UnicodeInput(char c, bool keyUp)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.ki.wVk = 0;
        i.ki.wScan = (ushort)c;
        i.ki.dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0);
        return i;
    }

    private static INPUT VirtualKeyInput(ushort vk, bool keyUp)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.ki.wVk = vk;
        i.ki.wScan = 0;
        i.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
        return i;
    }

    private static void Send(INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length)
        {
            throw new InvalidOperationException(
                "SendInput was blocked (error " + Marshal.GetLastWin32Error() +
                "). The target window may be running with higher privileges than AutoTyper.");
        }
    }

    /// <summary>Types a single BMP character.</summary>
    public static void SendChar(char c)
    {
        Send(new INPUT[] { UnicodeInput(c, false), UnicodeInput(c, true) });
    }

    /// <summary>Types an astral character (emoji) as its surrogate pair, in one batch.</summary>
    public static void SendSurrogatePair(char high, char low)
    {
        Send(new INPUT[] {
            UnicodeInput(high, false), UnicodeInput(high, true),
            UnicodeInput(low, false), UnicodeInput(low, true)
        });
    }

    /// <summary>Presses and releases a virtual key (Enter, Tab, ...).</summary>
    public static void SendKey(ushort vk)
    {
        Send(new INPUT[] { VirtualKeyInput(vk, false), VirtualKeyInput(vk, true) });
    }
}
"@

$VK_RETURN = [uint16]0x0D
$VK_TAB = [uint16]0x09

function Test-Stopped {
  if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { return $true }
  return $false
}

# Start-Sleep only has ~15 ms resolution, which is useless for fast typing, so
# short waits are spun out against a high-resolution timer instead.
function Wait-Precise([double]$ms) {
  if ($ms -le 0.05) { return }
  if ($ms -ge 20) {
    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    while ($deadline.Elapsed.TotalMilliseconds -lt $ms) {
      if (Test-Stopped) { return }
      $remaining = $ms - $deadline.Elapsed.TotalMilliseconds
      Start-Sleep -Milliseconds ([Math]::Min(20, [Math]::Max(1, [int]$remaining)))
    }
  }
  else {
    $t = [System.Diagnostics.Stopwatch]::StartNew()
    while ($t.Elapsed.TotalMilliseconds -lt $ms) { [System.Threading.Thread]::SpinWait(150) }
  }
}

# Replays a schedule sampled from the typing model: one step per line, as
#   delayUs,kind,value
# where kind 0 is a Unicode character (value is its code point) and kind 1 is a
# virtual key such as Enter, Tab or Backspace. Repeats and line delays are
# already baked in, so this plays straight through.
#
# Every key is pressed and released in a single SendInput batch. Holding a key
# down for a modelled duration instead was tried and is unusable: once a hold
# passes the system's key-repeat delay Windows repeats the key, which duplicates
# characters and, far worse, makes a single backspace eat several characters.
function Invoke-Schedule([string]$path) {
  $lines = [System.IO.File]::ReadAllLines($path)

  # Parsed into parallel arrays rather than objects: at a few hundred thousand
  # steps the allocation cost of one object per keystroke is noticeable.
  $count = $lines.Length
  $delayMs = New-Object 'double[]' $count
  $kind = New-Object 'int[]' $count
  $value = New-Object 'int[]' $count

  $steps = 0
  $total = 0
  foreach ($line in $lines) {
    if ($line.Length -eq 0) { continue }
    $parts = $line.Split(',')
    if ($parts.Length -lt 3) { continue }
    $delayMs[$steps] = [int]::Parse($parts[0]) / 1000.0
    $kind[$steps] = [int]::Parse($parts[1])
    $value[$steps] = [int]::Parse($parts[2])
    if ($kind[$steps] -eq 1 -and $value[$steps] -eq 8) { $total-- } else { $total++ }
    $steps++
  }
  if ($total -lt 1) { $total = 1 }

  $typed = 0
  $lastReport = -1

  for ($i = 0; $i -lt $steps; $i++) {
    if (($i -band 7) -eq 0 -and (Test-Stopped)) { return }

    if ($DryRun) {
      Emit ("#T {0} {1} {2}" -f $kind[$i], $value[$i], [int]$delayMs[$i])
      if ($kind[$i] -eq 1 -and $value[$i] -eq 8) { $typed-- } else { $typed++ }
      continue
    }

    Wait-Precise $delayMs[$i]

    if ($kind[$i] -eq 1) {
      [AutoTyperNative]::SendKey([uint16]$value[$i])
      if ($value[$i] -eq 8) { $typed-- } else { $typed++ }
    }
    elseif ($value[$i] -gt 0xFFFF) {
      $offset = $value[$i] - 0x10000
      $high = [char](0xD800 + ($offset -shr 10))
      $low = [char](0xDC00 + ($offset -band 0x3FF))
      [AutoTyperNative]::SendSurrogatePair($high, $low)
      $typed++
    }
    else {
      [AutoTyperNative]::SendChar([char]$value[$i])
      $typed++
    }

    $pct = [int](100 * $typed / $total)
    if ($pct -ne $lastReport) {
      $lastReport = $pct
      Emit "#P $typed $total"
    }
  }

  Emit "#P $total $total"
}

try {
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  $text = $text -replace "`r`n", "`n" -replace "`r", "`n"
  if ($text.Length -eq 0) { Emit '#D'; exit 0 }

  if ($Repeat -lt 1) { $Repeat = 1 }
  $total = $text.Length * $Repeat
  $typed = 0

  # Countdown so the user can click into the window they want to type in.
  $remainingMs = $StartDelayMs
  while ($remainingMs -gt 0) {
    if (Test-Stopped) { exit 0 }
    Emit ("#C " + [Math]::Ceiling($remainingMs / 1000.0))
    $slice = [Math]::Min(200, $remainingMs)
    Start-Sleep -Milliseconds $slice
    $remainingMs -= $slice
  }
  Emit '#C 0'

  if ($ScheduleFile) {
    Invoke-Schedule $ScheduleFile
    Emit '#D'
    exit 0
  }

  $rand = New-Object System.Random
  $jitter = [Math]::Max(0, [Math]::Min(100, $JitterPct)) / 100.0
  $lastReport = -1

  for ($pass = 1; $pass -le $Repeat; $pass++) {
    $i = 0
    while ($i -lt $text.Length) {
      if (($typed -band 7) -eq 0 -and (Test-Stopped)) { Emit '#D'; exit 0 }

      $c = $text[$i]
      $step = 1

      if ($c -eq "`n") {
        [AutoTyperNative]::SendKey($VK_RETURN)
      }
      elseif ($c -eq "`t") {
        [AutoTyperNative]::SendKey($VK_TAB)
      }
      elseif ([char]::IsHighSurrogate($c) -and ($i + 1) -lt $text.Length -and [char]::IsLowSurrogate($text[$i + 1])) {
        [AutoTyperNative]::SendSurrogatePair($c, $text[$i + 1])
        $step = 2
      }
      else {
        [AutoTyperNative]::SendChar($c)
      }

      $i += $step
      $typed += $step

      $pct = [int](100 * $typed / $total)
      if ($pct -ne $lastReport) {
        $lastReport = $pct
        Emit "#P $typed $total"
      }

      # Per-keystroke pause, optionally humanised with random jitter.
      $wait = $DelayMs
      if ($jitter -gt 0) {
        $wait = $DelayMs * (1.0 + (($rand.NextDouble() * 2.0) - 1.0) * $jitter)
        if ($wait -lt 0) { $wait = 0 }
      }
      if ($c -eq "`n" -and $LineDelayMs -gt 0) { $wait += $LineDelayMs }
      Wait-Precise $wait
    }

    if ($pass -lt $Repeat -and $RepeatDelayMs -gt 0) {
      Wait-Precise $RepeatDelayMs
    }
  }

  Emit "#P $total $total"
  Emit '#D'
  exit 0
}
catch {
  Emit ("#E " + ($_.Exception.Message -replace "`r?`n", ' '))
  exit 1
}
