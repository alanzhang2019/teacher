# VoxCPM watchdog — keep the FastAPI server alive on port 8000.
#
# Behavior:
#   - If port 8000 is NOT listening, start server.py.
#   - While the port IS listening, also verify the underlying python.exe is
#     still our server process (so a crashed-but-still-listening socket is
#     detected and replaced).
#   - On restart, pass VOXCPM_MODEL_DIR explicitly so the model loads from
#     the local cache instead of re-downloading from Hugging Face.
#   - The server PID we launched is written to $PidFile so we can tell apart
#     "our" server.py from the uvicorn worker it forks (the worker's
#     CommandLine also contains "server.py" but we don't want to confuse
#     it with a separate, broken launch).
#
# Usage (from any shell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\AItrade\openmaic\VoxCPM\watchdog.ps1
#
# Stop:
#   Stop the powershell process; it will gracefully terminate the child server.

$ErrorActionPreference = 'Continue'

$VenvPython       = 'D:\AItrade\openmaic\VoxCPM\.venv\Scripts\python.exe'
$ServerScript     = 'D:\AItrade\openmaic\VoxCPM\server.py'
$ServerLog        = 'D:\AItrade\openmaic\VoxCPM\server.log'
$WatchdogLog      = 'D:\AItrade\openmaic\VoxCPM\watchdog.log'
$VoxCPMModelDir   = 'D:\AItrade\openmaic\OpenMAIC\ms-cache\models\openbmb--VoxCPM2\snapshots\master'
$Port             = 8000
$HealthUrl        = "http://127.0.0.1:$Port/health"
$CheckIntervalSec = 15
$StartupGraceSec  = 90   # give the model loader time before declaring a start failed
$HealthTimeoutSec = 5
$HealthFailLimit  = 3    # consecutive /health failures before recycling
$PidFile          = 'D:\AItrade\openmaic\VoxCPM\server.pid'

function Write-Watchdog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [watchdog] $Message"
    Write-Host $line
    Add-Content -Path $WatchdogLog -Value $line
}

function Test-PortListening {
    param([int]$Port)
    try {
        return ($null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue))
    } catch {
        return $false
    }
}

function Test-ServerHealth {
    # Returns $true only if /health responds 2xx within the timeout.
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec $HealthTimeoutSec -UseBasicParsing -ErrorAction Stop
        return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
    } catch {
        return $false
    }
}

function Get-ServerPids {
    # All python.exe processes whose command line points at server.py. Includes
    # both the watchdog-launched parent and the uvicorn worker it forks; this
    # is only used for defensive cleanup, not for state decisions. Use
    # Get-TrackedServerPid for authoritative state.
    $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue
    $hits  = @()
    foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine.Contains('server.py')) {
            $hits += [int]$p.ProcessId
        }
    }
    return $hits
}

function Get-ServerPyBuckets {
    # Partition server.py processes by their executable path. The reason this
    # exists: the main loop used to treat every python.exe whose CommandLine
    # contained "server.py" as a uvicorn worker of the tracked parent and
    # quietly ignored it. That assumption breaks the moment the user (or a
    # stale shell) launches a server.py with a *different* Python interpreter
    # (typically the system Python311 at
    # `C:\Users\Administrator\AppData\Local\Programs\Python\Python311\python.exe`)
    # — those processes are real foreign server.py instances, not uvicorn
    # workers, and they can sit on port 8000 with /health still answering,
    # which is exactly the failure mode that left an unpatched server.py
    # running through a stop_all / start_all cycle. Splitting by executable
    # path lets the main loop kill the foreign ones while leaving the real
    # uvicorn workers alone.
    #
    # Returns a hashtable with two arrays of [int] PIDs:
    #   - VenvOwned : the python.exe is $VenvPython (i.e. something we / a
    #                 uvicorn worker spawned; safe to leave alone).
    #   - Foreign   : the python.exe is some other interpreter (system
    #                 Python, another venv, msys python, ...). These are
    #                 orphans and must be recycled, not adopted.
    $procs     = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue
    $venvOwned = @()
    $foreign   = @()
    foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine.Contains('server.py')) {
            $exe = $p.ExecutablePath
            if ($exe -and ($exe -eq $VenvPython)) {
                $venvOwned += [int]$p.ProcessId
            } else {
                # Record where it actually came from so the log line is actionable.
                $foreign += [int]$p.ProcessId
            }
        }
    }
    return @{ VenvOwned = $venvOwned; Foreign = $foreign; }
}

function Get-TrackedServerPid {
    # Read the PID we last wrote in Start-Server. Returns $null if the file
    # is missing, unparseable, or the process is no longer alive.
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = Get-Content $PidFile -Raw -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    $serverPid = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$serverPid)) {
        Write-Watchdog "PID file $PidFile contains garbage: '$($raw.Trim())'. Ignoring."
        return $null
    }
    $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Watchdog "Tracked server pid=$serverPid is no longer alive (file is stale). Clearing."
        try { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue } catch {}
        return $null
    }
    return $serverPid
}

function Clear-TrackedServerPid {
    try { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue } catch {}
}

function Stop-ServerGracefully {
    Write-Watchdog 'Stopping existing server process(es)...'
    $tracked = Get-TrackedServerPid
    if ($tracked) {
        Write-Watchdog "Killing tracked server pid=$tracked (and any descendants)..."
        try {
            Stop-Process -Id $tracked -Force -ErrorAction Stop
        } catch {
            Write-Watchdog "Failed to kill tracked pid=$tracked : $($_.Exception.Message)"
        }
        Clear-TrackedServerPid
    }
    # Also nuke any orphan server.py (no PID file, or stale PID file pointing
    # at something else). This catches the case where the user manually
    # started a server.py outside the watchdog.
    $all = @(Get-ServerPids)
    foreach ($serverPid in $all) {
        if ($serverPid -eq $tracked) { continue }
        try { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue } catch {}
    }
    # Wait for port to free up (max 10s)
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-PortListening -Port $Port)) { return }
        Start-Sleep -Milliseconds 500
    }
    Write-Watchdog "Port $Port still busy after 10s, continuing anyway."
}

function Start-Server {
    # Pre-clean: kill any pre-existing server.py BEFORE we spawn a new one.
    # Without this, an old server.py can still hold port 8000 while our fresh
    # child loads the entire 5GB VoxCPM model in the background, then fails
    # to bind — leaving two server.py processes alive (one listening, one
    # wedged with a loaded model burning RAM/CPU for nothing).
    $existing = @(Get-ServerPids)
    if ($existing.Count -gt 0) {
        Write-Watchdog "Pre-clean: killing $($existing.Count) existing server.py pid(s) before start..."
        Stop-ServerGracefully
    }

    Write-Watchdog "Starting $ServerScript (model dir: $VoxCPMModelDir)"

    $env:VOXCPM_MODEL_DIR = $VoxCPMModelDir
    # Inherit current env, including any PYTHONPATH / HF cache the user already set.

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName  = $VenvPython
    $psi.Arguments = "`"$ServerScript`""
    $psi.WorkingDirectory = Split-Path -Parent $ServerScript
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.EnableRaisingEvents = $true

    # Tee child output to server.log (append), line by line.
    Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
        if ($EventArgs.Data) { Add-Content -Path $using:ServerLog -Value $EventArgs.Data }
    } | Out-Null
    Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived  -Action {
        if ($EventArgs.Data) { Add-Content -Path $ServerLog  -Value $EventArgs.Data }
    } | Out-Null

    [void]$proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    $startedPid = $proc.Id
    try {
        Set-Content -Path $PidFile -Value $startedPid -Encoding ASCII -Force
    } catch {
        Write-Watchdog "Failed to write $PidFile : $($_.Exception.Message)"
    }
    Write-Watchdog "server.py launched (pid=$startedPid). Waiting for port $Port..."

    # Wait for port 8000 to be listening, up to StartupGraceSec. uvicorn forks
    # a worker process that actually binds the port; we don't care which PID
    # owns it, as long as our startedPid is still alive.
    for ($i = 0; $i -lt [int]($StartupGraceSec * 2); $i++) {
        Start-Sleep -Milliseconds 500
        if ($proc.HasExited) {
            Write-Watchdog "server.py (pid=$startedPid) exited prematurely with code $($proc.ExitCode)."
            return $false
        }
        if (Test-PortListening -Port $Port) {
            $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
            $ownerStr = if ($listeners.Count -gt 0) { ($listeners | ForEach-Object { $_.OwningProcess }) -join ',' } else { 'none' }
            Write-Watchdog "Port $Port is listening (owner=$ownerStr; took ~$([math]::Round(($i + 1) * 0.5, 1))s)."
            return $true
        }
    }
    Write-Watchdog "Port $Port did not become ready within $StartupGraceSec s. Process pid=$startedPid is still running; will re-check on next tick."
    return $true
}

# ---- main loop ---------------------------------------------------------------

Write-Watchdog "=== watchdog start === pid=$PID"
Write-Watchdog "config: port=$Port interval=${CheckIntervalSec}s startupGrace=${StartupGraceSec}s healthTimeout=${HealthTimeoutSec}s healthFailLimit=$HealthFailLimit"

# Initial start if nothing is running, OR if a stale process is sitting on the port
# but /health never responds (e.g. the user manually started a server.py without
# VOXCPM_MODEL_DIR and the loader is stuck).
$needsStart = $true
if (Test-PortListening -Port $Port) {
    Write-Watchdog "Port $Port already listening at startup; probing /health..."
    if (Test-ServerHealth) {
        Write-Watchdog "Existing server is healthy; leaving it alone."
        $needsStart = $false
    } else {
        Write-Watchdog "Existing server is NOT healthy (no /health response). Will recycle."
        Stop-ServerGracefully
    }
}
if ($needsStart) {
    Start-Server | Out-Null
}

$consecutiveHealthFails = 0
$consecutiveStartFails  = 0

while ($true) {
    Start-Sleep -Seconds $CheckIntervalSec

    $listening   = Test-PortListening -Port $Port
    $trackedPid  = Get-TrackedServerPid
    $buckets     = Get-ServerPyBuckets
    $venvOwned   = @($buckets.VenvOwned)
    $foreign     = @($buckets.Foreign)
    $serverPids  = @($venvOwned + $foreign)  # informational; uvicorn forks a worker so count >= 1 is normal

    # Foreign server.py (a python.exe that is NOT $VenvPython but is holding
    # the port) is a hard conflict: it answers /health, so the rest of the
    # loop's "tracked alive + port up" branch would happily mark service OK
    # forever, never noticing that the new server.py (with the funASR auto-
    # fill patch) is being starved out. This is the exact regression mode
    # that left an unpatched system-Python server.py running through a
    # stop_all / start_all cycle. Kill the foreign process first; if it was
    # actually the one holding 8000, the port will go down on the next tick
    # and the normal "port down" branch will spin up a fresh, venv-owned one.
    #
    # Important carve-out: if a "foreign" PID's parent is OUR tracked pid, it
    # is almost certainly a VoxCPM inference worker that the tracked server
    # spawned internally (WMI reports its ExecutablePath as the system
    # Python311 because of how the venv's pyvenv.cfg / sys._base_executable
    # resolves on Windows, but the process is actually loading the venv's
    # site-packages and is the one that bound port 8000). Killing it
    # cascade-kills the tracked parent and forces a 90s model reload. Skip
    # these — the "extra venv-owned" branch below would also have ignored
    # them, but the executable-path mismatch made them look foreign first.
    if ($foreign.Count -gt 0) {
        $foreignInfo = ($foreign | ForEach-Object {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue
            $exe = if ($p) { $p.ExecutablePath } else { '?' }
            $cmd = if ($p) { $p.CommandLine } else { '?' }
            $parent = if ($p) { $p.ParentProcessId } else { '?' }
            "$_ (exe=$exe, ppid=$parent, cmd=$(if ($cmd.Length -gt 80) { $cmd.Substring(0, 80) + '...' } else { $cmd }))"
        }) -join '; '
        Write-Watchdog "Foreign server.py detected (not from $VenvPython): $foreignInfo. Tracked=$trackedPid."
        $killList = @()
        $skipList = @()
        foreach ($fp in $foreign) {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$fp" -ErrorAction SilentlyContinue
            $ppid = if ($p) { [int]$p.ParentProcessId } else { 0 }
            if ($trackedPid -and $ppid -eq [int]$trackedPid) {
                $skipList += $fp
            } else {
                $killList += $fp
            }
        }
        if ($skipList.Count -gt 0) {
            Write-Watchdog "Skipping $($skipList.Count) foreign-but-child-of-tracked pid(s) (assumed VoxCPM inference worker): $($skipList -join ', '). Will treat as extra venv-owned."
            $venvOwned = @($venvOwned + $skipList)
            # Fall through to the normal venv-owned ignore branch below.
        }
        if ($killList.Count -gt 0) {
            Write-Watchdog "Killing $($killList.Count) foreign server.py pid(s) (not our tracked's children): $($killList -join ', '). Recycling."
            foreach ($fp in $killList) {
                try { Stop-Process -Id $fp -Force -ErrorAction SilentlyContinue } catch {}
            }
            # Give the OS a moment to reap the socket. If a venv-owned tracked
            # server is also up, it'll take over port 8000 on its own; if not,
            # the next tick will see port-down and start a fresh venv server.
            Start-Sleep -Seconds 2
            $consecutiveHealthFails = 0
            continue
        }
        # All foreign pids were actually children of our tracked server —
        # fall through to the normal port-up branches below (no kill, no restart).
    }

    if (-not $listening) {
        # Port down. If a tracked process is still alive, give it more time
        # (model loader takes ~90s on cold start). Otherwise, restart.
        if ($trackedPid) {
            Write-Watchdog "Port $Port is NOT listening but tracked server pid=$trackedPid is still running (model loading?). Skipping restart."
            continue
        }
        Write-Watchdog "Port $Port is NOT listening and no tracked server. Restarting."
        $consecutiveHealthFails = 0
        $ok = Start-Server
        if (-not $ok) {
            $consecutiveStartFails++
            # Back off exponentially (15s, 30s, 60s, 120s cap) when startup
            # crashes (typically OOM under sustained memory pressure) so we
            # don't spam Start-Process and worsen the pressure.
            $backoff = [Math]::Min(120, 15 * [Math]::Pow(2, [Math]::Max(0, $consecutiveStartFails - 1)))
            Write-Watchdog "Startup failed ($consecutiveStartFails in a row); backing off ${backoff}s before next attempt."
            Start-Sleep -Seconds $backoff
        } else {
            $consecutiveStartFails = 0
        }
        continue
    }

    # Port is listening. If we have a tracked server AND there are additional
    # *venv-owned* server.py processes, those are uvicorn workers — we log and
    # ignore them. Rationale: uvicorn forks a worker whose CommandLine also
    # contains "server.py" and which holds the loaded 5GB VoxCPM model.
    # Killing the worker would force a 90s model reload on the next start
    # — far worse than the extra memory cost of letting the worker live. The
    # worker will be reaped naturally when the tracked parent dies (port
    # goes down). Foreign (non-venv) server.py processes are handled in the
    # dedicated branch above; they should never reach this point, but if
    # one does we surface it instead of silently ignoring it (would re-
    # introduce the stop_all / start_all regression).
    if ($trackedPid -and $venvOwned.Count -gt 1) {
        $extras = @($venvOwned | Where-Object { $_ -ne $trackedPid })
        if ($extras.Count -gt 0) {
            $extraInfo = ($extras | ForEach-Object {
                $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue
                $parent = if ($p) { $p.ParentProcessId } else { '?' }
                "$_ (PPID=$parent)"
            }) -join '; '
            Write-Watchdog "Ignoring $($extras.Count) extra venv-owned server.py pid(s) (uvicorn workers): $extraInfo. Tracked=$trackedPid, service OK."
        }
        continue
    }

    if (-not $trackedPid) {
        # Port listening, but no tracked server.py — a stale socket from a
        # previous crash, OR a user-launched server.py. Try /health to decide.
        if (Test-ServerHealth) {
            Write-Watchdog "Port $Port listening with a healthy server.py that we don't track. Adopting as our tracked pid."
            # Try to find a python.exe that owns the listener and adopt it.
            $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
            foreach ($conn in $listeners) {
                $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
                if ($p -and $p.ProcessName -eq 'python') {
                    try {
                        Set-Content -Path $PidFile -Value $conn.OwningProcess -Encoding ASCII -Force
                        Write-Watchdog "Adopted pid=$($conn.OwningProcess) as tracked server."
                    } catch {
                        Write-Watchdog "Failed to write pid file while adopting: $($_.Exception.Message)"
                    }
                    break
                }
            }
            $consecutiveHealthFails = 0
            continue
        }
        Write-Watchdog "Port $Port is held by an untracked process and /health is unreachable. Recycling."
        $consecutiveHealthFails = 0
        Stop-ServerGracefully
        Start-Server | Out-Null
        continue
    }

    # Port listening AND tracked server is alive. Verify it actually serves /health.
    if (Test-ServerHealth) {
        $consecutiveHealthFails = 0
        continue
    }

    $consecutiveHealthFails++
    Write-Watchdog "/health probe failed (consecutive=$consecutiveHealthFails / $HealthFailLimit)."
    if ($consecutiveHealthFails -ge $HealthFailLimit) {
        Write-Watchdog "Server is wedged (port up but /health unreachable $HealthFailLimit times). Recycling."
        $consecutiveHealthFails = 0
        Stop-ServerGracefully
        Start-Server | Out-Null
    }
}

