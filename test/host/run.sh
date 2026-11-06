#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Container test of the host fetch script. Needs docker / podman; run npm run release first.
#   bash test/host/run.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$root/dist/releases/LATEST" ] || { echo "先运行 npm run release"; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for t in in-container.sh in-container-bootstrap.sh; do
  rm -rf "$work/bucket" && mkdir -p "$work/bucket" && cp -r "$root/dist/releases" "$work/bucket/releases"
  echo "##### $t"
  docker run --rm --platform linux/arm64 -v "$work/bucket:/bucket" -v "$root:/src:ro" amazonlinux:2023 bash "/src/test/host/$t"
done
