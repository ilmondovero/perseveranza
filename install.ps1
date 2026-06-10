# Installa "perseveranza" per l'utente corrente:
#   1. copia hook e comando in ~\.claude\
#   2. registra lo Stop hook in ~\.claude\settings.json (idempotente, con backup)
# Uso:  pwsh -File install.ps1     (oppure: powershell -File install.ps1)

param([string]$ClaudeDir = (Join-Path $HOME '.claude'))

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot

# --- 1. copia dei file ---
New-Item -ItemType Directory -Force (Join-Path $ClaudeDir 'hooks')    | Out-Null
New-Item -ItemType Directory -Force (Join-Path $ClaudeDir 'commands') | Out-Null
Copy-Item (Join-Path $src 'hooks\omc-loop.ps1')       (Join-Path $ClaudeDir 'hooks')    -Force
Copy-Item (Join-Path $src 'hooks\loop-drive.ps1')     (Join-Path $ClaudeDir 'hooks')    -Force
Copy-Item (Join-Path $src 'commands\perseveranza.md') (Join-Path $ClaudeDir 'commands') -Force
Write-Output "File copiati in $ClaudeDir (hooks\ e commands\)."

# --- 2. registrazione dello Stop hook ---
$settingsPath = Join-Path $ClaudeDir 'settings.json'
$hookCmd = "& '" + (Join-Path $ClaudeDir 'hooks\loop-drive.ps1') + "'"

$settings = $null
if (Test-Path $settingsPath) { $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json }
if (-not $settings) { $settings = [pscustomobject]@{} }

if (-not $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}
if (-not $settings.hooks.PSObject.Properties['Stop']) {
    $settings.hooks | Add-Member -NotePropertyName Stop -NotePropertyValue @()
}

$already = $false
foreach ($entry in @($settings.hooks.Stop)) {
    foreach ($h in @($entry.hooks)) {
        if ($h.command -like '*loop-drive.ps1*') { $already = $true }
    }
}

if ($already) {
    Write-Output 'Stop hook gia'' registrato in settings.json: nessuna modifica.'
} else {
    if (Test-Path $settingsPath) {
        Copy-Item $settingsPath "$settingsPath.bak-perseveranza" -Force
        Write-Output "Backup di settings.json: $settingsPath.bak-perseveranza"
    }
    $newEntry = [pscustomobject]@{
        matcher = ''
        hooks   = @([pscustomobject]@{ type = 'command'; command = $hookCmd; shell = 'powershell'; timeout = 20 })
    }
    $settings.hooks.Stop = @($settings.hooks.Stop) + $newEntry
    ($settings | ConvertTo-Json -Depth 32) | Set-Content -Path $settingsPath -Encoding UTF8
    Write-Output 'Stop hook registrato in settings.json.'
}

Write-Output ''
Write-Output 'Installazione completata. Riavvia Claude Code e usa: /perseveranza <descrizione del task>'
