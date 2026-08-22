<#
  Replays UTF-8 file text as real keystrokes via SendInput.

  stdout protocol, consumed by the Electron main process:
    #C <secondsRemaining>     countdown tick
    #P <typedChars> <total>   progress
    #E <message>              fatal error
    #D                        done
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [string]$StopFile = '',
  # Window the keystrokes belong to; it is brought to the front before typing
  # starts and watched afterwards, so nothing lands in the wrong place.
  [long]$TargetHwnd = 0,
  # Pre-sampled timings from src/model/sampler.ts; overrides the flat delay.
  [string]$ScheduleFile = '',
  [int]$DelayUs = 40000,
  [int]$JitterPct = 0,
  [int]$StartDelayMs = 3000,
  [int]$Repeat = 1,
  [int]$LineDelayMs = 0,
  [int]$RepeatDelayMs = 500,
  # Reports keystrokes instead of sending them; skips every wait.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Whole microseconds, so comma-decimal locales cannot misparse the argument.
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

    // MOUSE/KEYBD/HARDWARE union: offset 8 on x64, 40 bytes total.
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    public struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private const int SW_RESTORE = 9;
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

    /// <summary>Owning process of a window, or 0 if the handle is dead.</summary>
    private static uint ProcessOf(IntPtr hWnd)
    {
        uint pid;
        if (!IsWindow(hWnd)) return 0;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    public static bool Exists(IntPtr hWnd)
    {
        return IsWindow(hWnd);
    }

    /// <summary>
    /// True while the front window belongs to the target's process. Dialogs and
    /// popups of the target app count, anything else does not.
    /// </summary>
    public static bool HasFocus(IntPtr hWnd)
    {
        IntPtr front = GetForegroundWindow();
        if (front == hWnd) return true;
        uint target = ProcessOf(hWnd);
        if (target == 0) return false;
        uint pid;
        GetWindowThreadProcessId(front, out pid);
        return pid == target;
    }

    /// <summary>
    /// Brings the target to the front. Windows only grants a plain
    /// SetForegroundWindow to a few callers, so this also borrows the input
    /// queue of the current front window, which covers the rest.
    /// </summary>
    public static bool Focus(IntPtr hWnd)
    {
        if (!IsWindow(hWnd)) return false;
        if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);

        for (int attempt = 0; attempt < 20; attempt++)
        {
            if (HasFocus(hWnd)) return true;

            SetForegroundWindow(hWnd);
            if (HasFocus(hWnd)) return true;

            IntPtr front = GetForegroundWindow();
            uint frontThread = 0;
            uint pid;
            if (front != IntPtr.Zero) frontThread = GetWindowThreadProcessId(front, out pid);
            uint targetThread = GetWindowThreadProcessId(hWnd, out pid);
            uint self = GetCurrentThreadId();

            if (frontThread != 0 && frontThread != self) AttachThreadInput(self, frontThread, true);
            if (targetThread != 0 && targetThread != self) AttachThreadInput(self, targetThread, true);

            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);

            if (frontThread != 0 && frontThread != self) AttachThreadInput(self, frontThread, false);
            if (targetThread != 0 && targetThread != self) AttachThreadInput(self, targetThread, false);

            if (HasFocus(hWnd)) return true;
            System.Threading.Thread.Sleep(50);
        }

        return HasFocus(hWnd);
    }
}
"@

$VK_RETURN = [uint16]0x0D
$VK_TAB = [uint16]0x09

$Target = if ($TargetHwnd -ne 0) { [IntPtr]$TargetHwnd } else { [IntPtr]::Zero }

function Test-Stopped {
  if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { return $true }
  return $false
}

# Once a target is chosen the keystrokes belong to it alone, so losing the
# front window aborts the run instead of typing into whatever took over.
function Assert-TargetFocus {
  if ($Target -eq [IntPtr]::Zero) { return }
  if (-not [AutoTyperNative]::HasFocus($Target)) {
    throw 'Focus left the chosen window, so typing stopped.'
  }
}

# Start-Sleep resolves to ~15 ms, so short waits spin instead.
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

# Sampled schedule, one "delayUs,kind,value" step per line, played straight through.
# Kind 0 is a Unicode code point, kind 1 a virtual key.
# Repeats and line delays are already baked into the schedule.
# Press and release together: longer holds trigger Windows key-repeat.
function Invoke-Schedule([string]$path) {
  $lines = [System.IO.File]::ReadAllLines($path)

  # Parallel arrays, not objects: per-keystroke allocation costs too much.
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
    if (($i -band 7) -eq 0) {
      if (Test-Stopped) { return }
      if (-not $DryRun) { Assert-TargetFocus }
    }

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

  # Countdown so the user can focus the target window.
  $remainingMs = $StartDelayMs
  while ($remainingMs -gt 0) {
    if (Test-Stopped) { exit 0 }
    Emit ("#C " + [Math]::Ceiling($remainingMs / 1000.0))
    $slice = [Math]::Min(200, $remainingMs)
    Start-Sleep -Milliseconds $slice
    $remainingMs -= $slice
  }
  Emit '#C 0'

  if ($Target -ne [IntPtr]::Zero) {
    if (-not [AutoTyperNative]::Exists($Target)) {
      throw 'The window you picked has closed. Refresh the list and pick it again.'
    }
    if (-not [AutoTyperNative]::Focus($Target)) {
      throw 'Could not bring the chosen window to the front. It may be running with higher privileges than AutoTyper.'
    }
    # Let the window finish activating before the first keystroke arrives.
    Start-Sleep -Milliseconds 120
    if (Test-Stopped) { Emit '#D'; exit 0 }
  }

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
      if (($typed -band 7) -eq 0) {
        if (Test-Stopped) { Emit '#D'; exit 0 }
        Assert-TargetFocus
      }

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

      # Per-keystroke pause, optionally humanised with jitter.
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
