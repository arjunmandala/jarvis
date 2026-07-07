[CmdletBinding()]
param(
    [string]$Repository = "https://github.com/ganman2205/jarvis.git",
    [string]$Branch
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is not installed or is not available on PATH."
}

$repoRoot = $PSScriptRoot
while ($repoRoot -and -not (Test-Path -LiteralPath (Join-Path $repoRoot ".git"))) {
    $parent = Split-Path -Parent $repoRoot
    if (-not $parent -or $parent -eq $repoRoot) {
        $repoRoot = $null
        break
    }
    $repoRoot = $parent
}

if (-not $repoRoot) {
    throw "Could not find a Git repository at or above $PSScriptRoot."
}

Set-Location $repoRoot

if (-not $Branch) {
    $detectedBranch = git branch --show-current
    if ($LASTEXITCODE -ne 0 -or -not $detectedBranch) {
        throw "Could not determine the current Git branch."
    }
    $Branch = $detectedBranch.Trim()
}

$token = [Environment]::GetEnvironmentVariable("GH_TOKEN", "Process")

if (-not $token) {
    $envFile = Join-Path $repoRoot ".env"
    if (-not (Test-Path -LiteralPath $envFile)) {
        throw "GH_TOKEN is not exported and $envFile does not exist."
    }

    $line = Get-Content -LiteralPath $envFile |
        Where-Object { $_ -match '^\s*(?i:GH_TOKEN)\s*=' } |
        Select-Object -First 1

    if (-not $line) {
        throw "GH_TOKEN was not found in $envFile."
    }

    $token = ($line -replace '^\s*(?i:GH_TOKEN)\s*=\s*', '').Trim()
    if (($token.StartsWith('"') -and $token.EndsWith('"')) -or
        ($token.StartsWith("'") -and $token.EndsWith("'"))) {
        $token = $token.Substring(1, $token.Length - 2)
    }
}

if (-not $token) {
    throw "GH_TOKEN is empty."
}

$credentials = "x-access-token:$token"
$authorization = [Convert]::ToBase64String(
    [Text.Encoding]::ASCII.GetBytes($credentials)
)

# Pass authentication through the child process environment. Nothing is added
# to the remote URL or persisted in Git configuration.
$env:GIT_CONFIG_COUNT = "1"
$env:GIT_CONFIG_KEY_0 = "http.extraHeader"
$env:GIT_CONFIG_VALUE_0 = "Authorization: Basic $authorization"

try {
    Write-Host "Pushing $Branch to $Repository..."
    git push $Repository "${Branch}:${Branch}"
    if ($LASTEXITCODE -ne 0) {
        throw "Git push failed with exit code $LASTEXITCODE."
    }
}
finally {
    Remove-Item Env:GIT_CONFIG_COUNT -ErrorAction SilentlyContinue
    Remove-Item Env:GIT_CONFIG_KEY_0 -ErrorAction SilentlyContinue
    Remove-Item Env:GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue
    $token = $null
    $credentials = $null
    $authorization = $null
}

Write-Host "Push completed."
