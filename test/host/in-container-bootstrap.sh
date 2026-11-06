#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Run bootstrap in a fresh Amazon Linux 2023 container, simulating user data. Called by test/host/run.sh.
set -euo pipefail
pass() { echo "PASS: $*"; }
failt() { echo "FAIL: $*"; exit 1; }
dnf install -y -q tar gzip findutils sudo diffutils shadow-utils util-linux >/dev/null
install -m 0755 /src/test/host/fake-aws /usr/local/bin/aws
# systemctl stub: records calls; is-active returns success (the service is running)
printf '#!/bin/sh\necho "$*" >> /tmp/systemctl.log\n' > /usr/bin/systemctl && chmod +x /usr/bin/systemctl
mkdir -p /etc/systemd/system /etc/logrotate.d
# Simulate the SSM Agent having created ssm-user
useradd --create-home ssm-user

# ---- The following matches the CDK user data ----
install -d -o root -g root -m 0755 /etc/agentcore-feishu-bot /opt/agentcore-feishu-bot/bin
printf 'AFB_RELEASE_BUCKET=b\nAFB_REGION=us-west-2\nAWS_REGION=us-west-2\nAFB_USER_POOL_ID=us-west-2_pool\nAFB_HMAC_SECRET_ARN=arn:aws:secretsmanager:us-west-2:1:secret:x\n' > /etc/agentcore-feishu-bot/host.env
install -m 0755 /src/host/fetch-release.sh /opt/agentcore-feishu-bot/bin/afb-fetch-release
bash /src/host/bootstrap.sh
# ---- Verification ----
cfg=/var/lib/agentcore-feishu-bot/bots.json
[ "$(stat -c '%U %a' /var/lib/agentcore-feishu-bot)" = "afbot 700" ] && pass "数据目录 afbot 0700" || failt "数据目录"
[ "$(stat -c '%U %a' $cfg)" = "afbot 600" ] && pass "bots.json afbot 0600" || failt "bots.json 权限"
grep -q us-west-2_pool $cfg && pass "bots.json 含用户池 ID" || failt "bots.json 内容"
[ "$(stat -c '%U %G %a' /var/log/agentcore-feishu-bot)" = "afbot afbot-admin 750" ] && pass "日志目录" || failt "日志目录"
id -nG ssm-user | grep -qw afbot-admin && pass "ssm-user 在 afbot-admin" || failt "ssm-user 组"
sudo -u afbot /opt/agentcore-feishu-bot/bin/afb list | grep -q "还没有机器人" && pass "afb list 读到初始配置" || failt "afb list"
echo '{"x":1}' > /tmp/marker && cp $cfg /tmp/before
bash /src/host/bootstrap.sh >/dev/null
cmp -s $cfg /tmp/before && pass "重跑 bootstrap 不覆盖 bots.json" || failt "bots.json 被覆盖"
# Wrapper script: run as ssm-user (ssm-user uses the afbot-admin rules in sudoers)
su - ssm-user -c "agentcore-chat-bridge list" | grep -q "还没有机器人" && pass "ssm-user 经包装脚本运行 agentcore-chat-bridge list" || failt "包装脚本"
su - ssm-user -c "agentcore-feishu-bot list" | grep -q "还没有机器人" && pass "旧命令名仍可用" || failt "旧命令名"
su - ssm-user -c "sudo -n -u afbot /opt/agentcore-feishu-bot/bin/afb version" >/dev/null && pass "sudoers 允许 afb" || failt "sudoers afb"
su - ssm-user -c "sudo -n /bin/cat /etc/shadow" >/dev/null 2>&1 && failt "ssm-user 有完整 sudo（测试环境不应有）" || pass "sudoers 不放行其他命令"
su - ssm-user -c "sudo -n /opt/agentcore-feishu-bot/bin/afb-update 1.2.3" >/dev/null 2>&1 && failt "afb-update 接受了参数" || pass "afb-update 带参数被 sudoers 拒绝"
# A command that changes the configuration exits with code 100 → the wrapper script runs sudo systemctl reload
python3 - <<'PY'
import json
p="/var/lib/agentcore-feishu-bot/bots.json"; f=json.load(open(p))
f["bots"].append({"appId":"cli_t","appSecret":"s","appName":"t","agents":[],"defaultAgent":"","admins":["on_a"],"allowedUsers":[],"allowAll":False,"turnTimeoutSec":600,"createdAt":""})
json.dump(f,open(p,"w"))
PY
: > /tmp/systemctl.log; chmod 666 /tmp/systemctl.log
out=$(su - ssm-user -c "agentcore-chat-bridge admin add cli_t on_b"); rc=$?
echo "$out"
[ $rc -eq 0 ] && grep -q "reload agentcore-feishu-bot" /tmp/systemctl.log && pass "改配置后包装脚本触发 reload" || failt "reload 未触发 (rc=$rc)"
grep -q on_b /var/lib/agentcore-feishu-bot/bots.json && pass "admin add 已写入" || failt "admin add 未写入"
[ "$(stat -c '%U %a' /var/lib/agentcore-feishu-bot/bots.json)" = "afbot 600" ] && pass "写入后仍是 afbot 0600" || failt "权限变了"
: > /tmp/systemctl.log; chmod 666 /tmp/systemctl.log
su - ssm-user -c "agentcore-chat-bridge admin add cli_t on_b" >/dev/null
! grep -q reload /tmp/systemctl.log && pass "没有变化时不 reload" || failt "无变化也 reload"
echo "ALL PASS (bootstrap)"
