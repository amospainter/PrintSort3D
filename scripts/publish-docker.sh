#!/usr/bin/env bash
# Build the PrintSort3D image and push it to GitHub Container Registry (ghcr.io).
#
# Run this after publishing a new master version (e.g. right after `git push` /
# tagging a release) to ship the matching Docker package. It is deliberately
# standalone — no git hooks, nothing automatic.
#
#   ./scripts/publish-docker.sh              # tag :<version-from-package.json> and :latest
#   ./scripts/publish-docker.sh 0.2.0        # override the version tag
#   PLATFORM=linux/amd64 ./scripts/publish-docker.sh   # single-arch (faster)
#   IMAGE=ghcr.io/someone/other ./scripts/publish-docker.sh
#
# One-time setup: authenticate to ghcr.io with a PAT that has `write:packages`:
#   echo "$GITHUB_PAT" | docker login ghcr.io -u amospainter --password-stdin
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/amospainter/printsort3d}"
PLATFORM="${PLATFORM:-linux/amd64,linux/arm64}"

cd "$(dirname "$0")/.."

VERSION="${1:-$(node -p "require('./package.json').version")}"
if [ -z "$VERSION" ]; then
  echo "Could not determine version — pass it explicitly: $0 <version>" >&2
  exit 1
fi

echo "Publishing ${IMAGE}:${VERSION} and ${IMAGE}:latest  (${PLATFORM})"
echo

# A multi-platform build must go straight to the registry (buildx can't --load a
# multi-arch manifest into the local daemon). --provenance=false keeps the package
# page showing a plain image, not an OCI index with an attestation entry.
docker buildx build \
  --platform "${PLATFORM}" \
  --provenance=false \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:latest" \
  --push \
  .

echo
echo "Done. Deployers can now run:  docker pull ${IMAGE}:latest"
