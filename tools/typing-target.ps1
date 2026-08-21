<#
  A text box to type into, for testing the engine with real keyboard input.

  Dry-run testing cannot catch faults that only exist once keystrokes go through
  the OS -- key repeat from a held key being the one that mattered. This opens a
  focused, always-on-top window, lets the engine type into it for real, and
  prints back what actually arrived.

  Prints:
    RESULT <single line, with \n and \r escaped>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Engine,
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$ScheduleFile,
  [int]$StartDelayMs = 1500,
  [int]$TimeoutMs = 120000
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AutoTyper live test - do not type'
$form.Size = New-Object System.Drawing.Size(900, 400)
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Consolas', 11)
$box.AcceptsTab = $true
$form.Controls.Add($box)

# The engine is started first and waits out its countdown while the window comes
# up and takes focus, so no separate handshake is needed.
$arguments = @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', $Engine,
  '-TextFile', $TextFile,
  '-ScheduleFile', $ScheduleFile,
  '-StartDelayMs', $StartDelayMs
)
$typer = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
    if ($typer.HasExited -or [DateTime]::UtcNow -gt $deadline) {
      $timer.Stop()
      $form.Close()
    }
    else {
      # Keep the target focused: anything that steals focus mid-run would take
      # the rest of the keystrokes with it.
      $form.Activate()
    }
  })

$form.Add_Shown({
    $form.Activate()
    $box.Focus()
    $timer.Start()
  })

[void]$form.ShowDialog()

if (-not $typer.HasExited) {
  try { $typer.Kill() } catch { }
}

$text = $box.Text -replace "`r`n", "`n"
$escaped = $text.Replace('\', '\\').Replace("`n", '\n').Replace("`r", '\r')
[Console]::Out.WriteLine("RESULT $escaped")
