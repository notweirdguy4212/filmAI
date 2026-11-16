param(
    [Parameter(Mandatory = $true)]
    [string]$RemoteUrl
)

$ErrorActionPreference = 'Stop'

git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    git init
    if ($LASTEXITCODE -ne 0) { throw 'git init failed.' }
}

git add -A
if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m 'Upload filmAI Studio'
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed.' }
} else {
    Write-Host 'No staged changes to commit.'
}

$mainExists = $false
git show-ref --verify --quiet refs/heads/main
if ($LASTEXITCODE -eq 0) { $mainExists = $true }
$currentBranch = (git branch --show-current).Trim()
if ($mainExists) {
    git branch -M main
    if ($LASTEXITCODE -ne 0) { throw 'Could not set branch to main.' }
} elseif ([string]::IsNullOrWhiteSpace($currentBranch)) {
    git checkout -b main
    if ($LASTEXITCODE -ne 0) { throw 'Could not create main branch.' }
}

$null = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
    git remote set-url origin $RemoteUrl
} else {
    git remote add origin $RemoteUrl
}
if ($LASTEXITCODE -ne 0) { throw 'Could not configure origin remote.' }

git push -u origin HEAD
if ($LASTEXITCODE -ne 0) { throw 'git push failed. Check GitHub authentication and repository permissions.' }
