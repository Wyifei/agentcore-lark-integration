#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Install the host files from the current release package (runs at bootstrap and on every upgrade). Runs as root.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin=/opt/agentcore-feishu-bot/bin

install_atomic() { # src dst mode
  install -o root -g root -m "$3" "$1" "$2.new"
  mv -f "$2.new" "$2"
}

install -d -o root -g root -m 0755 "$bin"
install_atomic "$here/afb" "$bin/afb" 0755
install_atomic "$here/afb-update" "$bin/afb-update" 0755
install_atomic "$here/fetch-release.sh" "$bin/afb-fetch-release" 0755
install_atomic "$here/agentcore-chat-bridge" /usr/local/bin/agentcore-chat-bridge 0755
# Also available under the service name
ln -sfn agentcore-chat-bridge /usr/local/bin/agentcore-feishu-bot.new && mv -Tf /usr/local/bin/agentcore-feishu-bot.new /usr/local/bin/agentcore-feishu-bot

# sudoers: validate first, then replace
tmp=$(mktemp)
cp "$here/sudoers" "$tmp"
visudo -cf "$tmp" >/dev/null
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/agentcore-feishu-bot
rm -f "$tmp"

install -o root -g root -m 0644 "$here/agentcore-feishu-bot.service" /etc/systemd/system/agentcore-feishu-bot.service
install -o root -g root -m 0644 "$here/logrotate.conf" /etc/logrotate.d/agentcore-feishu-bot
if [ -d /opt/aws/amazon-cloudwatch-agent/etc ]; then
  install -o root -g root -m 0644 "$here/cloudwatch-agent.json" /opt/aws/amazon-cloudwatch-agent/etc/agentcore-feishu-bot.json
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a append-config -m ec2 -s \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/agentcore-feishu-bot.json >/dev/null || echo "CloudWatch Agent 配置失败（不影响服务）" >&2
fi
# SSM login only: disable sshd (the security group has no inbound rules anyway; this is defense in depth)
if systemctl list-unit-files sshd.service >/dev/null 2>&1; then
  systemctl disable --now sshd.service sshd.socket >/dev/null 2>&1 || true
fi
systemctl daemon-reload
