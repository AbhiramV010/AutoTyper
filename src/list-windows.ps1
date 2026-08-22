<#
  Lists the top-level windows a user could type into, as a JSON array of
  { hwnd, pid, process, title }, sorted by process then title.

  The filter mirrors what Alt+Tab shows: visible, titled, uncloaked windows
  that are not tool windows or owned popups.
#>
[CmdletBinding()]
param(
  # AutoTyper's own process, so the app cannot be picked as its own target.
  [int]$ExcludePid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AutoTyperWindowList
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

    private const uint GW_OWNER = 4;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_APPWINDOW = 0x00040000;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int DWMWA_CLOAKED = 14;

    /// <summary>True for the UWP placeholder windows that never come to the front.</summary>
    private static bool IsCloaked(IntPtr hWnd)
    {
        int cloaked;
        if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) != 0) return false;
        return cloaked != 0;
    }

    /// <summary>One "hwnd\tpid\ttitle" record per window worth offering.</summary>
    public static string[] List(int excludePid)
    {
        List<string> found = new List<string>();

        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;

            int length = GetWindowTextLength(hWnd);
            if (length == 0) return true;

            int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
            if ((exStyle & WS_EX_TOOLWINDOW) != 0) return true;
            if ((exStyle & WS_EX_NOACTIVATE) != 0) return true;
            // Owned popups belong to another window; only promoted ones stand alone.
            if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero && (exStyle & WS_EX_APPWINDOW) == 0) return true;
            if (IsCloaked(hWnd)) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (excludePid != 0 && pid == (uint)excludePid) return true;

            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(hWnd, title, title.Capacity);
            if (title.Length == 0) return true;

            found.Add(hWnd.ToInt64() + "\t" + pid + "\t" + title.ToString().Replace("\t", " "));
            return true;
        }, IntPtr.Zero);

        return found.ToArray();
    }
}
"@

$names = @{}
function Get-ProcessName([int]$processId) {
  if ($names.ContainsKey($processId)) { return $names[$processId] }
  $name = ''
  try {
    $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
  }
  catch {
    $name = 'unknown'
  }
  $names[$processId] = $name
  return $name
}

$windows = @()
foreach ($record in [AutoTyperWindowList]::List($ExcludePid)) {
  $parts = $record.Split("`t", 3)
  if ($parts.Length -lt 3) { continue }
  $processId = [int]$parts[1]
  $windows += [pscustomobject]@{
    hwnd    = [long]$parts[0]
    pid     = $processId
    process = Get-ProcessName $processId
    title   = $parts[2]
  }
}

$windows = @($windows | Sort-Object process, title)

# -Compress keeps the payload to one line. ConvertTo-Json drops the brackets for
# a single object and for none at all, so both of those are written by hand.
if ($windows.Count -eq 0) {
  [Console]::Out.Write('[]')
}
elseif ($windows.Count -eq 1) {
  [Console]::Out.Write('[' + ($windows[0] | ConvertTo-Json -Depth 3 -Compress) + ']')
}
else {
  [Console]::Out.Write(($windows | ConvertTo-Json -Depth 3 -Compress))
}
[Console]::Out.Flush()
