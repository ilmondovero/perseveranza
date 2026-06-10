# Stop hook: macchina a stati "OMC-loop" a ciclo CHIUSO (instrada in base agli esiti).
#
#   plan -> implement -> review --fail--> implement (fix, stesso step, max retry)
#                            \---pass--> implement (step successivo)
#   claim-done -> final-verify --pass--> disarm + toast "Progetto finito"
#                             \--fail--> implement (fix, poi nuovo claim-done)
#
# DORMIENTE di default: non fa nulla finche' nel progetto non esiste .omc-loop\state.json
# (lo armi con omc-loop.ps1 arm "<task>"). Globale ma non invade le chat normali.
#
# Contratto:
#   - L'hook possiede : phase, iterations, retries, finalFails, repeated.
#   - Claude possiede : lastReport (via `omc-loop.ps1 report pass|fail`),
#                       claimedDone (via `claim-done`), paused (via `pause`/`resume`).
# Reti di sicurezza: limite iterazioni globale, limite retry per step (-> pausa + toast),
# stato corrotto -> disarm + toast. Ogni transizione e' loggata in .omc-loop\history.log.

$ErrorActionPreference = 'SilentlyContinue'

$LOOP = Join-Path $HOME '.claude\hooks\omc-loop.ps1'

function Send-Toast([string]$title, [string]$msg) {
    try { Import-Module BurntToast -ErrorAction Stop
          New-BurntToastNotification -Text $title, $msg -AppLogo $null | Out-Null }
    catch { [System.Console]::Beep(880, 200) }
}

# --- input evento ---
$raw = [Console]::In.ReadToEnd()
$evt = $null
if ($raw) { $evt = $raw | ConvertFrom-Json }

$cwd = if ($evt -and $evt.cwd) { $evt.cwd } else { (Get-Location).Path }
$gateDir   = Join-Path $cwd '.omc-loop'
$statePath = Join-Path $gateDir 'state.json'
$planPath  = Join-Path $gateDir 'plan.md'
$histPath  = Join-Path $gateDir 'history.log'

# DORMIENTE: nessun gate -> non bloccare, lascia fermare Claude
if (-not (Test-Path $statePath)) { exit 0 }

$proj = Split-Path -Leaf $cwd
function Disarm() { Remove-Item -Recurse -Force $gateDir -ErrorAction SilentlyContinue }

# --- stato: parse robusto, default per i campi mancanti ---
$rawState = $null
try { $rawState = Get-Content $statePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch {}
if (-not $rawState -or -not $rawState.phase) {
    Disarm
    Send-Toast 'Claude Code - OMC-loop' "state.json corrotto: loop disarmato - $proj"
    exit 0
}
function Get-Field($obj, [string]$name, $default) {
    if ($obj.PSObject.Properties[$name] -and $null -ne $obj.$name) { return $obj.$name }
    return $default
}
$s = [ordered]@{
    task        = [string](Get-Field $rawState 'task' '')
    phase       = [string](Get-Field $rawState 'phase' 'plan')
    complexity  = [string](Get-Field $rawState 'complexity' 'medium')
    iterations  = [int](Get-Field $rawState 'iterations' 0)
    max         = [int](Get-Field $rawState 'max' 25)
    retries     = [int](Get-Field $rawState 'retries' 0)
    maxRetries  = [int](Get-Field $rawState 'maxRetries' 3)
    finalFails  = [int](Get-Field $rawState 'finalFails' 0)
    lastReport  = [string](Get-Field $rawState 'lastReport' 'none')
    claimedDone = [bool](Get-Field $rawState 'claimedDone' $false)
    paused      = [bool](Get-Field $rawState 'paused' $false)
    repeated    = [bool](Get-Field $rawState 'repeated' $false)
}
function Save-State() { ($s | ConvertTo-Json -Depth 5) | Set-Content -Path $statePath -Encoding UTF8 }
function Log-Step([string]$msg) {
    Add-Content -Path $histPath -Value ("{0:yyyy-MM-dd HH:mm:ss} | iter {1,2} | {2}" -f (Get-Date), $s.iterations, $msg)
}

# PAUSA: serve input dell'utente (o limite retry raggiunto) -> non bloccare
if ($s.paused) { exit 0 }

# limite globale di iterazioni
if ($s.iterations -ge $s.max) {
    Disarm
    Send-Toast 'Claude Code - OMC-loop' "Loop fermato: limite $($s.max) iterazioni - $proj"
    exit 0
}

# --- consuma i segnali scritti da Claude ---
$report  = $s.lastReport
$claimed = $s.claimedDone
$s.lastReport  = 'none'
$s.claimedDone = $false

$phase  = $s.phase
$header = "[OMC-loop | iter $($s.iterations + 1)/$($s.max)] Task: $($s.task)."
$reason = $null

# routing dei modelli per fase in base alla complessita' registrata da Claude
# (hint per i subagent: il modello della sessione principale non e' modificabile da un hook)
if ($s.complexity -notin @('low', 'medium', 'high')) { $s.complexity = 'medium' }
$reviewModel = @{ low = 'haiku';  medium = 'sonnet'; high = 'opus' }[$s.complexity]
$verifyModel = @{ low = 'sonnet'; medium = 'opus';   high = 'opus' }[$s.complexity]
$implHint = ''
if ($s.complexity -eq 'high') {
    $implHint = " Il task e' ad alta complessita': delega l'implementazione a un subagent executor con model=opus, tu coordina e controlla il risultato."
}

# sospende il loop quando i fallimenti consecutivi superano il limite: serve un umano
function Pause-ForHuman([string]$why) {
    $s.paused = $true
    Save-State
    Log-Step "$phase -> PAUSA ($why)"
    Send-Toast 'Claude Code - OMC-loop' "Loop in pausa, serve intervento umano: $why - $proj"
    exit 0
}

if ($claimed) {
    # da qualunque fase: la dichiarazione di completamento innesca il gate di uscita
    $s.phase = 'final-verify'; $s.repeated = $false; $s.retries = 0
    $reason = "$header FASE: verifica finale avversariale. Hai dichiarato il progetto completo: ora va falsificato. Delega a un subagent INDIPENDENTE con model=$verifyModel (contesto pulito) la verifica: parta da .omc-loop\plan.md e dalle modifiche reali, assuma che il lavoro sia SBAGLIATO, costruisca casi limite e input ostili, esegua DAVVERO test e build, verifichi ogni claim contro l'esecuzione reale. NON correggere nulla in questa fase. Alla fine esegui OBBLIGATORIAMENTE: pwsh -File $LOOP report pass (nessun difetto) oppure: pwsh -File $LOOP report fail"
}
else {
    switch ($phase) {
        'plan' {
            if ((Test-Path $planPath) -or $s.repeated) {
                $s.phase = 'implement'; $s.repeated = $false
                $reason = "$header FASE: implement. Apri .omc-loop\plan.md e implementa il PRIMO step non spuntato.$implHint NON spuntare la casella ora: si spunta solo dopo che la review e' passata. Se per procedere serve input dell'utente: esegui pwsh -File $LOOP pause e poi fai la domanda."
            } else {
                $s.repeated = $true
                $reason = "$header FASE: plan. Manca .omc-loop\plan.md: scrivilo ORA come checklist markdown ('- [ ] step'), step piccoli e verificabili. Poi valuta la complessita' del task e registrala con: pwsh -File $LOOP complexity low|medium|high (instrada i modelli delle fasi successive). Infine fermati."
            }
        }
        'implement' {
            $s.phase = 'review'; $s.repeated = $false
            $reason = "$header FASE: code-review. Delega a un subagent code-reviewer con model=$reviewModel (contesto pulito) la review delle modifiche appena fatte: correttezza, edge case, regressioni, sicurezza, adeguatezza dei test. Correggi subito i problemi bloccanti emersi. Alla fine esegui OBBLIGATORIAMENTE: pwsh -File $LOOP report pass (nessun bloccante residuo) oppure: pwsh -File $LOOP report fail (restano problemi). NON modificare .omc-loop\state.json a mano."
        }
        'review' {
            if ($report -eq 'fail') {
                $s.retries = $s.retries + 1
                if ($s.retries -ge $s.maxRetries) { Pause-ForHuman "$($s.retries) review fallite sullo stesso step" }
                $s.phase = 'implement'; $s.repeated = $false
                $reason = "$header FASE: fix (tentativo $($s.retries)/$($s.maxRetries)). La review ha lasciato problemi aperti: correggili TUTTI restando sullo stesso step del piano ed esegui i test pertinenti.$implHint NON spuntare lo step."
            }
            elseif ($report -eq 'pass') {
                $s.retries = 0; $s.phase = 'implement'; $s.repeated = $false
                $reason = "$header FASE: implement. Review superata: spunta lo step completato in .omc-loop\plan.md ('- [x]'). Se restano step non spuntati, implementa il PROSSIMO.$implHint Se invece TUTTI gli step sono spuntati e il progetto e' completo, esegui: pwsh -File $LOOP claim-done (innesca la verifica finale). Se serve input dell'utente: pwsh -File $LOOP pause e poi fai la domanda."
            }
            elseif (-not $s.repeated) {
                $s.repeated = $true   # resta in review, chiedi l'esito una volta sola
                $reason = "$header FASE: code-review (esito mancante). Non hai registrato l'esito della review. Completala se serve, poi esegui ORA: pwsh -File $LOOP report pass oppure: pwsh -File $LOOP report fail"
            }
            else {
                # esito mancante due volte: avanza comunque (ciclo interno tollerante)
                $s.retries = 0; $s.phase = 'implement'; $s.repeated = $false
                $reason = "$header FASE: implement (review senza esito registrato, considerata superata). Spunta lo step completato in .omc-loop\plan.md e implementa il PROSSIMO step non spuntato. Se tutti gli step sono spuntati: pwsh -File $LOOP claim-done. D'ora in poi registra SEMPRE l'esito con report pass|fail."
            }
        }
        'final-verify' {
            if ($report -eq 'pass') {
                Log-Step 'final-verify -> DONE'
                Disarm
                Send-Toast 'Claude Code - OMC-loop' "Progetto finito e verificato - $proj"
                exit 0
            }
            elseif ($report -eq 'fail') {
                $s.finalFails = $s.finalFails + 1
                if ($s.finalFails -ge $s.maxRetries) { Pause-ForHuman "$($s.finalFails) verifiche finali fallite" }
                $s.phase = 'implement'; $s.repeated = $false
                $reason = "$header FASE: fix post-verifica (bocciatura $($s.finalFails)/$($s.maxRetries)). La verifica finale ha trovato difetti: correggili tutti e riapri in .omc-loop\plan.md gli step interessati ('- [ ]').$implHint Quando tutto e' di nuovo completo e testato, riesegui: pwsh -File $LOOP claim-done"
            }
            elseif (-not $s.repeated) {
                $s.repeated = $true   # resta in final-verify, chiedi l'esito una volta sola
                $reason = "$header FASE: verifica finale (esito mancante). Non hai registrato l'esito della verifica. Completala se serve, poi esegui ORA: pwsh -File $LOOP report pass oppure: pwsh -File $LOOP report fail"
            }
            else {
                # gate di uscita severo: esito mancante due volte = bocciatura
                $s.finalFails = $s.finalFails + 1
                if ($s.finalFails -ge $s.maxRetries) { Pause-ForHuman "verifica finale senza esito per 2 volte" }
                $s.phase = 'implement'; $s.repeated = $false
                $reason = "$header FASE: implement (verifica finale senza esito registrato: considerata FALLITA). Rivedi il lavoro, poi riesegui: pwsh -File $LOOP claim-done e stavolta registra l'esito con report pass|fail."
            }
        }
        default {
            # fase sconosciuta (stato manomesso): riparti dal piano
            $s.phase = 'plan'; $s.repeated = $false
            $reason = "$header FASE: plan (stato incoerente, ripristinato). Verifica .omc-loop\plan.md: se manca scrivilo come checklist '- [ ] step', poi fermati."
        }
    }
}

# persisti fase + contatore PRIMA di bloccare, poi logga la transizione
$s.iterations = $s.iterations + 1
Save-State
Log-Step ("{0} -> {1} | report={2}{3}" -f $phase, $s.phase, $report, $(if ($claimed) { ' | claim-done' } else { '' }))

# blocca lo stop e inietta l'istruzione della fase
$out = @{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress
[Console]::Out.Write($out)
exit 0
