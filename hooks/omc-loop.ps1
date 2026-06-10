# Arma / disarma / pilota il ciclo "OMC-loop" nel progetto corrente.
# Uso (dal prompt di Claude Code con il prefisso !, o da Claude stesso):
#   pwsh -File $env:USERPROFILE\.claude\hooks\omc-loop.ps1 arm "implementa la feature X" [-Max 25] [-MaxRetries 3] [-Complexity low|medium|high]
#   pwsh -File ... report pass|fail        esito della fase corrente (review / verifica finale)
#   pwsh -File ... complexity low|medium|high  registra la complessita' del task (instrada i modelli)
#   pwsh -File ... claim-done              dichiara il progetto completo -> innesca la verifica finale
#   pwsh -File ... pause | resume          sospende / riprende il loop (es. serve input dell'utente)
#   pwsh -File ... status | disarm

param(
    [Parameter(Position = 0)][ValidateSet('arm', 'disarm', 'status', 'report', 'complexity', 'claim-done', 'pause', 'resume')] [string]$Action = 'status',
    [Parameter(Position = 1)][string]$Value = '',
    [int]$Max = 25,
    [int]$MaxRetries = 3,
    [ValidateSet('', 'low', 'medium', 'high')][string]$Complexity = ''
)

$gateDir   = Join-Path (Get-Location).Path '.omc-loop'
$statePath = Join-Path $gateDir 'state.json'

function Get-LoopState {
    if (-not (Test-Path $statePath)) {
        Write-Output 'OMC-loop NON armato in questo progetto.'
        exit 1
    }
    return (Get-Content $statePath -Raw | ConvertFrom-Json)
}
function Set-LoopField($state, [string]$name, $value) {
    $state | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
}
function Save-LoopState($state) {
    ($state | ConvertTo-Json -Depth 5) | Set-Content -Path $statePath -Encoding UTF8
}

switch ($Action) {
    'arm' {
        if (-not $Value) { Write-Output 'Manca la descrizione del task: arm "<task>"'; exit 1 }
        if (-not (Test-Path $gateDir)) { New-Item -ItemType Directory -Path $gateDir | Out-Null }
        $state = [ordered]@{
            task        = $Value
            phase       = 'plan'       # plan -> implement -> review -> ... -> final-verify
            complexity  = $(if ($Complexity) { $Complexity } else { 'medium' })  # low|medium|high - instrada i modelli delle fasi
            iterations  = 0
            max         = $Max
            retries     = 0            # review fallite consecutive sullo stesso step
            maxRetries  = $MaxRetries
            finalFails  = 0            # verifiche finali fallite
            lastReport  = 'none'       # pass|fail|none - scritto da `report`, consumato dall'hook
            claimedDone = $false       # scritto da `claim-done`, consumato dall'hook
            paused      = $false       # scritto da `pause`/`resume` (o dall'hook al limite retry)
            repeated    = $false       # la fase corrente e' gia' stata ripetuta una volta
        }
        Save-LoopState $state
        Write-Output "OMC-loop ARMATO (max $Max iterazioni, $MaxRetries retry per step). Task: $Value"
        Write-Output "Fase iniziale: plan. Scrivi il piano in .omc-loop\plan.md come checklist '- [ ] step', poi fermati: da li' guida lo Stop hook."
    }
    'report' {
        if ($Value -notin @('pass', 'fail')) { Write-Output 'Uso: report pass|fail'; exit 1 }
        $s = Get-LoopState
        Set-LoopField $s 'lastReport' $Value
        Save-LoopState $s
        Write-Output "Esito registrato: $Value (fase corrente: $($s.phase))."
    }
    'complexity' {
        if ($Value -notin @('low', 'medium', 'high')) { Write-Output 'Uso: complexity low|medium|high'; exit 1 }
        $s = Get-LoopState
        Set-LoopField $s 'complexity' $Value
        Save-LoopState $s
        Write-Output "Complessita' registrata: $Value (instrada i modelli di review, verifica finale e implement)."
    }
    'claim-done' {
        $s = Get-LoopState
        Set-LoopField $s 'claimedDone' $true
        Save-LoopState $s
        Write-Output 'Completamento dichiarato: al prossimo Stop parte la VERIFICA FINALE avversariale.'
    }
    'pause' {
        $s = Get-LoopState
        Set-LoopField $s 'paused' $true
        Save-LoopState $s
        Write-Output "OMC-loop in PAUSA: l'hook non interverra' finche' non esegui resume."
    }
    'resume' {
        $s = Get-LoopState
        Set-LoopField $s 'paused' $false
        Set-LoopField $s 'repeated' $false
        Set-LoopField $s 'retries' 0
        Set-LoopField $s 'finalFails' 0
        Save-LoopState $s
        Write-Output 'OMC-loop RIPRESO (contatori retry azzerati).'
    }
    'disarm' {
        if (Test-Path $gateDir) { Remove-Item -Recurse -Force $gateDir; Write-Output 'OMC-loop DISARMATO.' }
        else { Write-Output 'OMC-loop non era armato.' }
    }
    'status' {
        if (Test-Path $statePath) {
            Write-Output 'OMC-loop ARMATO:'
            Get-Content $statePath -Raw
        } else { Write-Output 'OMC-loop NON armato in questo progetto.' }
    }
}
