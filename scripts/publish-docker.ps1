<#
.SYNOPSIS
  Build the PrintSort3D image and push it to GitHub Container Registry (ghcr.io).

.DESCRIPTION
  Run this after publishing a new master version (e.g. right after `git push` or
  tagging a release) to ship the matching Docker package. Standalone — no git
  hooks, nothing automatic.

  One-time setup: authenticate to ghcr.io with a PAT that has `write:packages`:
    $env:GITHUB_PAT | docker login ghcr.io -u amospainter --password-stdin

.EXAMPLE
  ./scripts/publish-docker.ps1
  Tags :<version-from-package.json> and :latest.

.EXAMPLE
  ./scripts/publish-docker.ps1 -Version 0.2.0

.EXAMPLE
  ./scripts/publish-docker.ps1 -Platform linux/amd64
  Single-arch build (faster).
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Image = $(if ($env:IMAGE) { $env:IMAGE } else { 'ghcr.io/amospainter/printsort3d' }),
  [string]$Platform = $(if ($env:PLATFORM) { $env:PLATFORM } else { 'linux/amd64,linux/arm64' })
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $Version) {
  $Version = (node -p "require('./package.json').version").Trim()
}
if (-not $Version) {
  Write-Error "Could not determine version — pass it explicitly: -Version <version>"
}

Write-Host "Publishing ${Image}:${Version} and ${Image}:latest  ($Platform)`n"

# A multi-platform build must go straight to the registry (buildx can't --load a
# multi-arch manifest into the local daemon). --provenance=false keeps the package
# page showing a plain image, not an OCI index with an attestation entry.
docker buildx build `
  --platform $Platform `
  --provenance=false `
  -t "${Image}:${Version}" `
  -t "${Image}:latest" `
  --push `
  .
if ($LASTEXITCODE -ne 0) { Write-Error "docker buildx build failed" }

Write-Host "`nDone. Deployers can now run:  docker pull ${Image}:latest"
