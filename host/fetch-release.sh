#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# afb-fetch-release <version> [--no-restart]: the fetch script shared by user data and afb-update (design 10)
#   1. Download the tarball and the sidecar, and verify the sha256 (protects against transfer corruption only; tamper protection comes from giving bucket write access only to the deployment role)
#   2. List the entries: only regular files and directories are allowed; reject absolute paths, .., symbolic links, hard links, and device files
#   3. Unpack as root (--no-same-owner), verify every file against the SHA256SUMS inside the package, and allow no extra files
#   4. Switch the current symlink, install the host files, and restart the service
# If any step fails, current stays on the old version.
set -euo pipefail
umask 022
readonly ROOT=/opt/agentcore-feishu-bot
version="${1:-}"
restart=1
[ "${2:-}" = "--no-restart" ] && restart=0
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "版本号格式不对：$version" >&2; exit 2; fi
# shellcheck disable=SC1091
. /etc/agentcore-feishu-bot/host.env

log() { echo "[afb-fetch-release] $*"; }
fail() { echo "[afb-fetch-release] 失败：$*" >&2; exit 1; }

dest="$ROOT/releases/$version"
if [ -d "$dest" ]; then
  log "版本 $version 已存在，重新校验后切换"
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  name="agentcore-feishu-bot-${version}.tar.gz"
  log "下载 $name"
  aws s3 cp "s3://${AFB_RELEASE_BUCKET}/releases/${version}/${name}" "$work/$name" --region "$AFB_REGION" --only-show-errors
  aws s3 cp "s3://${AFB_RELEASE_BUCKET}/releases/${version}/${name}.sha256" "$work/$name.sha256" --region "$AFB_REGION" --only-show-errors

  expected=$(awk '{print $1}' "$work/$name.sha256")
  actual=$(sha256sum "$work/$name" | awk '{print $1}')
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "sidecar 格式不对"
  [ "$expected" = "$actual" ] || fail "tarball sha256 不一致"

  # Entry check: the type must be - or d; the path must not be absolute or contain ..
  while IFS= read -r line; do
    type="${line:0:1}"
    [ "$type" = "-" ] || [ "$type" = "d" ] || fail "包内含不允许的条目类型：$line"
  done < <(tar -tvzf "$work/$name")
  while IFS= read -r path; do
    case "$path" in
      /*) fail "包内含绝对路径：$path" ;;
    esac
    if [[ "/$path/" == *"/../"* ]]; then fail "包内路径含 ..：$path"; fi
  done < <(tar -tzf "$work/$name")

  staging="$ROOT/releases/.${version}.staging"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$work/$name" -C "$staging" --no-same-owner --no-overwrite-dir
  [ -f "$staging/SHA256SUMS" ] || fail "包内没有 SHA256SUMS"
  (cd "$staging" && sha256sum --quiet --strict -c SHA256SUMS) || fail "包内文件校验失败"
  # No files other than SHA256SUMS are allowed
  extra=$(cd "$staging" && comm -23 <(find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort) <(awk '{print $2}' SHA256SUMS | sed 's|^\*||' | sort))
  [ -z "$extra" ] || fail "包内有未登记的文件：$extra"
  chown -R root:root "$staging"
  chmod -R go-w "$staging"
  mv -T "$staging" "$dest"
  rm -rf "$work"
  trap - EXIT
fi

(cd "$dest" && sha256sum --quiet --strict -c SHA256SUMS) || fail "已安装版本校验失败"
previous=$(readlink "$ROOT/current" 2>/dev/null || true)
switch_to() {
  ln -sfn "$1" "$ROOT/current.new"
  mv -T "$ROOT/current.new" "$ROOT/current"
}
switch_to "releases/$version"
log "current → $version"

# Install the host files; on failure switch current back to the old version and reinstall the old version's host files
if ! "$ROOT/current/host/install-host.sh"; then
  if [ -n "$previous" ]; then
    switch_to "$previous"
    "$ROOT/current/host/install-host.sh" || true
    fail "安装主机文件失败，已回退到 $(basename "$previous")"
  fi
  fail "安装主机文件失败"
fi

if [ "$restart" = 1 ]; then
  systemctl daemon-reload
  systemctl restart agentcore-feishu-bot
  log "服务已重启"
fi
# Keep only the 3 most recent versions
ls -1dt "$ROOT"/releases/[0-9]* 2>/dev/null | tail -n +4 | while read -r old; do
  [ "$(readlink -f "$ROOT/current")" = "$(readlink -f "$old")" ] || rm -rf "$old"
done
