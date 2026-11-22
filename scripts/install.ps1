# Mars Coding Agent Installer for Windows
# Usage: irm https://getmars.eu.cc/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://getmars.eu.cc/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://getmars.eu.cc/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://getmars.eu.cc/install.ps1))) -Source -Ref v0.1.0
#   & ([scriptblock]::Create((irm https://getmars.eu.cc/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://getmars.eu.cc/install.ps1))) -Binary -Ref v0.1.0

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

# Fail fast on hosts older than Windows PowerShell 5.1: cmdlets used below
# (e.g. Invoke-WebRequest -TimeoutSec) are missing or unreliable there and
# fail with cryptic errors halfway through the install. Anything newer,
# including PowerShell 7+, passes this check.
if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    throw "Windows PowerShell 5.1 or newer is required (found $($PSVersionTable.PSVersion)). Install PowerShell 7 from https://aka.ms/powershell and re-run the installer."
}

$Repo = "MarsAI-org/mars-agent"
$Package = "@marsai-org/coding-agent"
$InstallDir = if ($env:MARS_INSTALL_DIR) {
    $env:MARS_INSTALL_DIR
} elseif ($env:PI_INSTALL_DIR) {
    $env:PI_INSTALL_DIR
} else {
    "$env:LOCALAPPDATA\mars"
}
# Windows PowerShell 5.1 (.NET Framework) does not reliably resolve
# [System.Runtime.InteropServices.RuntimeInformation] without an
# assembly-qualified name, while PowerShell 7+ (Core) loads that type from a
# different assembly — so read the OS architecture from the environment
# instead, which works on both. Prefer PROCESSOR_ARCHITEW6432 so a 32-bit
# host on 64-bit Windows still reports the OS architecture.
# Note: PROCESSOR_ARCHITEW6432 is only set for 32-bit (WOW64) processes, so
# x64 PowerShell under ARM64 emulation reports AMD64 and installs the x64
# binary (runs emulated, not natively). Native ARM64 and x86-on-ARM64 hosts
# still resolve to arm64.
$RawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if (-not $RawArchitecture) {
    throw "Unable to determine Windows architecture"
}
$NativeArchitecture = switch ($RawArchitecture.ToUpperInvariant()) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { throw "Unsupported Windows architecture: $RawArchitecture" }
}
$BinaryName = "mars-windows-$NativeArchitecture.exe"
$MinimumBunVersion = "1.3.14"

# PowerShell 5.1 raises a terminating NativeCommandError for any line a native
# executable writes to stderr while $ErrorActionPreference is "Stop", regardless
# of the process exit code. Tools like bun and git emit normal progress on
# stderr, so run them with the preference relaxed to "Continue" and let callers
# gate on $LASTEXITCODE. Global "Stop" stays in effect for the cmdlet-driven
# operations (Invoke-WebRequest/Invoke-RestMethod) that depend on it.
function Invoke-Native {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Git Bash first (most common on Windows), including per-user installs that sit
    # neither under C:\Program Files nor on PATH.
    $candidates = @(
        "C:\Program Files\Git\bin\bash.exe",
        "C:\Program Files (x86)\Git\bin\bash.exe",
        (Join-Path $env:LOCALAPPDATA "Programs\Git\bin\bash.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    # Ask git where it lives: <Git>\mingw64\libexec\git-core -> <Git>\bin\bash.exe.
    if (Test-GitInstalled) {
        $execPath = [string](Invoke-Native { git --exec-path } | Select-Object -First 1)
        if ($execPath) {
            $gitRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $execPath.Trim()))
            $gitBash = Join-Path $gitRoot "bin\bash.exe"
            if (Test-Path -LiteralPath $gitBash) {
                return $gitBash
            }
        }
    }

    # Then bash.exe on PATH, but never the WSL shim: `C:\Windows\System32\bash.exe`
    # launches a Linux distribution whose filesystem namespace is not the one the
    # agent will be editing, so handing it to settings.json made every shell call
    # see a different tree (and fail outright with no distro installed).
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop | Select-Object -First 1
        if ($bashCmd -and $bashCmd.Source -and $bashCmd.Source -notmatch '(?i)\\Windows\\System32\\') {
            return $bashCmd.Source
        }
    } catch {
        return $null
    }
    return $null
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".mars\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new. ConvertFrom-Json -AsHashtable
            # requires PowerShell 6+; build the hashtable manually so Windows
            # PowerShell 5.1 merges instead of clobbering existing settings.
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $parsed = Get-Content $settingsFile -Raw | ConvertFrom-Json
                    foreach ($prop in $parsed.PSObject.Properties) {
                        $settings[$prop.Name] = $prop.Value
                    }
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "[OK] Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "No bash shell found - Mars will use its built-in shell." -ForegroundColor Cyan
            Write-Host "  For shell snapshots and interactive terminals, install Git for Windows:" -ForegroundColor Cyan
            Write-Host "    https://git-scm.com/download/win" -ForegroundColor Cyan
            Write-Host "  Or set a custom path in:" -ForegroundColor Cyan
            Write-Host "    $settingsFile" -ForegroundColor Cyan
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Cyan
        }
    } catch {
        Write-Host "[WARN] Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    Invoke-Native { irm bun.sh/install.ps1 | iex }
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    Assert-BunVersion $MinimumBunVersion
}

function Install-ViaBun {
    Write-Host "Installing via bun..."
    if ($Ref) {
        if (-not (Test-GitInstalled)) {
            throw "git is required for -Ref when installing from source"
        }

        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mars-install-" + [System.Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

        try {
            $repoUrl = "https://github.com/$Repo.git"
            Invoke-Native { git clone --depth 1 --branch $Ref $repoUrl $tmpRoot 2>&1 | Out-Null }
            if ($LASTEXITCODE -ne 0) {
                Invoke-Native { git clone $repoUrl $tmpRoot 2>&1 | Out-Null }
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to clone $repoUrl"
                }
                Push-Location $tmpRoot
                try {
                    Invoke-Native { git checkout $Ref 2>&1 | Out-Null }
                    if ($LASTEXITCODE -ne 0) {
                        throw "Failed to checkout $Ref"
                    }
                } finally {
                    Pop-Location
                }
            }

            # Pull LFS files
            if (Test-GitLfsInstalled) {
                Push-Location $tmpRoot
                try {
                    Invoke-Native { git lfs pull 2>&1 | Out-Null }
                } finally {
                    Pop-Location
                }
            }

            $packagePath = Join-Path $tmpRoot "packages\coding-agent"
            if (-not (Test-Path $packagePath)) {
                throw "Expected package at $packagePath"
            }

            Invoke-Native { bun install -g $packagePath }
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to install from $packagePath via bun"
            }
        } finally {
            Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
        }
    } else {
        Invoke-Native { bun install -g $Package }
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install $Package via bun"
        }
    }

    Write-Host ""
    Write-Host "[OK] Installed mars via bun" -ForegroundColor Green

    Configure-BashShell

    Write-Host "Run 'mars' to get started!"
}

function Assert-SafeRef {
    param([string]$Value)
    if ($Value -and ($Value -match '(^-|\.\.|[\s\?\*\#\;`\$\\])')) {
        throw "Invalid ref: $Value"
    }
}

function Get-GitHubHeaders {
    $headers = @{ "User-Agent" = "Mars-Installer" }
    if ($env:GITHUB_TOKEN) {
        $headers["Authorization"] = "token $($env:GITHUB_TOKEN)"
    }
    return $headers
}

function Install-Binary {
    $headers = Get-GitHubHeaders
    if ($Ref) {
        Assert-SafeRef $Ref
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref" -Headers $headers -TimeoutSec 60
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
    } else {
        Write-Host "Fetching latest release..."
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers -TimeoutSec 60
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Download binary
    $BinaryUrl = "https://github.com/$Repo/releases/download/$Latest/$BinaryName"
    $ChecksumUrl = "https://github.com/$Repo/releases/download/$Latest/SHA256SUMS.txt"
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "mars.exe"
    # Stage the download beside the destination using a `.exe` suffix so Windows
    # PowerShell can execute the smoke test directly via CreateProcess (non-PATHEXT
    # suffixes like `.download` fail or open via ShellExecuteEx). Swap into place
    # only after checksum verification and `--version` succeed.
    $StagedPath = Join-Path $InstallDir "mars.$PID.download.exe"
    $BackupPath = Join-Path $InstallDir "mars.$PID.old.exe"
    try {
        # Invoke-WebRequest renders a transfer progress bar by default; whether
        # that is useful is the host's call, since a non-interactive host sets
        # $ProgressPreference = 'SilentlyContinue' itself.
        Invoke-WebRequest -Uri $BinaryUrl -Headers $headers -OutFile $StagedPath -TimeoutSec 900
        $DownloadedInfo = Get-Item -LiteralPath $StagedPath
        Write-Host ("Downloaded {0} ({1:N0} bytes)" -f $BinaryName, $DownloadedInfo.Length)

        Write-Host "Verifying checksum..."
        # Fail closed. SHA256SUMS.txt ships in the same release as the binary, so it
        # proves the download was not corrupted or swapped in transit — skipping it
        # silently removes even that. This never sits inside a `catch`: the
        # checksum-mismatch `throw` below used to be caught by the same `catch`
        # that reports a fetch failure, so a corrupted binary only produced a
        # warning and stayed installed. The surrounding `try` has a `finally` for
        # staged-file cleanup only, so every failure here still propagates.
        $AllowUnverified = $env:MARS_ALLOW_UNVERIFIED -eq "1"
        $ExpectedSha = $null
        $VerifyProblem = $null
        try {
            $ChecksumsText = Invoke-RestMethod -Uri $ChecksumUrl -Headers $headers -TimeoutSec 30
            $Match = $ChecksumsText -split "`r?`n" | Where-Object { $_ -match "\s+\*?([\\/].*[\\/])?$([regex]::Escape($BinaryName))$" } | Select-Object -First 1
            if ($Match) {
                $ExpectedSha = ($Match -split "\s+")[0].Trim().ToLowerInvariant()
            } else {
                $VerifyProblem = "binary $BinaryName is not listed in SHA256SUMS.txt"
            }
        } catch {
            $VerifyProblem = "could not fetch SHA256SUMS.txt: $_"
        }

        if (-not $VerifyProblem) {
            $ActualSha = (Get-FileHash -Path $StagedPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($ExpectedSha -ne $ActualSha) {
                throw "Checksum verification failed for $BinaryName!`nExpected: $ExpectedSha`nActual:   $ActualSha`nThe staged download was discarded; $OutPath was left untouched."
            }
            Write-Host "[OK] Checksum verified ($ExpectedSha)" -ForegroundColor Green
        } elseif ($AllowUnverified) {
            Write-Host "[WARN] $VerifyProblem; continuing because MARS_ALLOW_UNVERIFIED=1." -ForegroundColor Yellow
        } else {
            throw "$VerifyProblem. Refusing to install an unverified binary. Set MARS_ALLOW_UNVERIFIED=1 to override.`nThe staged download was discarded; $OutPath was left untouched."
        }

        # Prove the binary starts before it replaces anything. The POSIX installer
        # has done this for a while; without it a Windows run reported success for
        # an .exe that immediately failed, and the previously working install was
        # already gone by then.
        $SmokeOutput = Invoke-Native { & $StagedPath --version 2>&1 }
        if ($LASTEXITCODE -ne 0) {
            throw "mars.exe downloaded and verified, but cannot start:`n$SmokeOutput`nThe staged download was discarded; $OutPath was left untouched."
        }

        # On Windows, overwriting a running .exe fails with sharing violation,
        # whereas renaming the running image aside and moving the new .exe into
        # place succeeds. Clean up any stale backup on best effort.
        if (Test-Path -LiteralPath $OutPath) {
            Move-Item -LiteralPath $OutPath -Destination $BackupPath -Force
        }
        try {
            Move-Item -LiteralPath $StagedPath -Destination $OutPath -Force
        } catch {
            if ((Test-Path -LiteralPath $BackupPath) -and -not (Test-Path -LiteralPath $OutPath)) {
                Move-Item -LiteralPath $BackupPath -Destination $OutPath -Force -ErrorAction SilentlyContinue
            }
            throw
        }
        Remove-Item -Force -LiteralPath $BackupPath -ErrorAction SilentlyContinue
    } finally {
        if (Test-Path -LiteralPath $StagedPath) {
            Remove-Item -Force -LiteralPath $StagedPath -ErrorAction SilentlyContinue
        }
    }

    Write-Host ""
    Write-Host "[OK] Installed mars to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there (exact segment match, avoiding empty segments)
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $NormalizedInstallDir = $InstallDir.TrimEnd('\', '/').ToLowerInvariant()
    $PathEntries = @()
    if ($UserPath) {
        $PathEntries = $UserPath -split ';' | Where-Object { $_ -and $_.Trim() -ne "" }
    }
    $AlreadyInPath = $false
    foreach ($entry in $PathEntries) {
        if ($entry.Trim().TrimEnd('\', '/').ToLowerInvariant() -eq $NormalizedInstallDir) {
            $AlreadyInPath = $true
            break
        }
    }
    $needsRestart = -not $AlreadyInPath
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        $NewPath = if ($PathEntries.Count -gt 0) { ($PathEntries + $InstallDir) -join ';' } else { $InstallDir }
        [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'mars' to get started!"
    } else {
        Write-Host "Run 'mars' to get started!"
    }
}

# Main logic
if ($Ref) {
    Assert-SafeRef $Ref
}
if ($Ref -and -not $Source -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: prefer prebuilt binary on supported Windows architectures (matching POSIX installer)
    Install-Binary
}
