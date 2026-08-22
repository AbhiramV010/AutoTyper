<#
  A text box to type into, for testing the engine with real keystrokes.
  Dry runs miss OS-level faults such as key repeat from a held key.

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

# The engine starts first and waits out its countdown while focus settles.
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
      # Keep focus: anything stealing it takes the remaining keystrokes.
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
