#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# First boot (called from user data, as root). Requires /etc/agentcore-feishu-bot/host.env and
# /opt/agentcore-feishu-bot/bin/afb-fetch-release to be in place (written by user data).
set -euo pipefail
# shellcheck disable=SC1091
. /etc/agentcore-feishu-bot/host.env

# Users and groups
getent group afbot-admin >/dev/null || groupadd --system afbot-admin
id afbot >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/agentcore-feishu-bot --shell /sbin/nologin afbot
# ssm-user is created by the SSM Agent on first login with passwordless sudo, so it works out of the box (not created here in advance,
# otherwise the SSM Agent would not write its sudoers entry). Other administrators only need to join the afbot-admin group.
if id ssm-user >/dev/null 2>&1; then usermod -aG afbot-admin ssm-user; fi

# Directories and permissions (design 4.7)
install -d -o root -g root -m 0755 /opt/agentcore-feishu-bot /opt/agentcore-feishu-bot/releases /opt/agentcore-feishu-bot/bin
install -d -o afbot -g afbot -m 0700 /var/lib/agentcore-feishu-bot
install -d -o afbot -g afbot-admin -m 0750 /var/log/agentcore-feishu-bot
touch /var/log/agentcore-feishu-bot/serve.log
chown afbot:afbot-admin /var/log/agentcore-feishu-bot/serve.log
chmod 0640 /var/log/agentcore-feishu-bot/serve.log

# CloudWatch Agent
dnf install -y -q amazon-cloudwatch-agent || echo "安装 CloudWatch Agent 失败（不影响服务）" >&2

# Fetch the package (LATEST) and install the host files
version=$(aws s3 cp "s3://${AFB_RELEASE_BUCKET}/releases/LATEST" - --region "$AFB_REGION" | tr -d '[:space:]')
/opt/agentcore-feishu-bot/bin/afb-fetch-release "$version" --no-restart

# Initial bots.json (an existing file is not overwritten, design 10)
cfg=/var/lib/agentcore-feishu-bot/bots.json
if [ ! -e "$cfg" ]; then
  tmp=$(mktemp /var/lib/agentcore-feishu-bot/.bots.XXXXXX)
  cat > "$tmp" <<JSON
{
  "schemaVersion": 1,
  "settings": {
    "userPoolId": "${AFB_USER_POOL_ID}",
    "hmacSecretArn": "${AFB_HMAC_SECRET_ARN}",
    "region": "${AFB_REGION}"
  },
  "bots": []
}
JSON
  chown afbot:afbot "$tmp"
  chmod 0600 "$tmp"
  mv -n "$tmp" "$cfg"
  rm -f "$tmp"
fi

systemctl daemon-reload
systemctl enable --now agentcore-feishu-bot
echo "agentcore-chat-bridge bootstrap 完成（版本 $version）"
