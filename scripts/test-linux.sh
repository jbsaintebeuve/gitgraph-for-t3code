#!/usr/bin/env bash
# Builds and tests gitgraph on Linux inside Docker (needs a running Docker daemon).
# Usage: scripts/test-linux.sh [ubuntu:22.04 ubuntu:24.04 ...]
set -euo pipefail
cd "$(dirname "$0")/.."
BASES=("$@")
[ ${#BASES[@]} -gt 0 ] || BASES=(ubuntu:22.04 ubuntu:24.04)
for base in "${BASES[@]}"; do
  tag="gitgraph-test:${base//[:.]/-}"
  echo "=============== $base ==============="
  docker build -f Dockerfile.test --build-arg "BASE=$base" -t "$tag" .
  docker run --rm "$tag"
done
echo "All Linux checks passed."
