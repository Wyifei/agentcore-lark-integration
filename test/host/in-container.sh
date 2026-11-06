#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Test the fetch script in an Amazon Linux 2023 container. Called by test/host/run.sh; do not run it directly.
#   /src     the repository (read-only)
#   /bucket  the simulated release bucket (a copy of dist/releases, located under releases/)
set -euo pipefail
pass() { echo "PASS: $*"; }
failt() { echo "FAIL: $*"; exit 1; }

dnf install -y -q tar gzip findutils sudo diffutils shadow-utils util-linux >/dev/null
install -m 0755 /src/test/host/fake-aws /usr/local/bin/aws
printf '#!/bin/sh\necho "[stub] systemctl $*"\n' > /usr/local/bin/systemctl && chmod +x /usr/local/bin/systemctl
# There is no systemd directory in the container
mkdir -p /etc/agentcore-feishu-bot /opt/agentcore-feishu-bot/bin /etc/systemd/system /etc/logrotate.d
printf 'AFB_RELEASE_BUCKET=b\nAFB_REGION=us-west-2\nAFB_USER_POOL_ID=us-west-2_x\nAFB_HMAC_SECRET_ARN=arn:aws:secretsmanager:us-west-2:1:secret:x\n' > /etc/agentcore-feishu-bot/host.env
install -m 0755 /src/host/fetch-release.sh /opt/agentcore-feishu-bot/bin/afb-fetch-release
groupadd --system afbot-admin
useradd --system --no-create-home --shell /sbin/nologin afbot
install -d -o afbot -g afbot -m 0700 /var/lib/agentcore-feishu-bot
install -d -o afbot -g afbot-admin -m 0750 /var/log/agentcore-feishu-bot

V=$(tr -d '[:space:]' < /bucket/releases/LATEST)
FETCH=/opt/agentcore-feishu-bot/bin/afb-fetch-release

echo "=== 1. 正常安装 $V"
$FETCH "$V" --no-restart
[ "$(readlink /opt/agentcore-feishu-bot/current)" = "releases/$V" ] && pass "current → $V" || failt "current"
for f in afb afb-update afb-fetch-release; do [ -x "/opt/agentcore-feishu-bot/bin/$f" ] || failt "bin/$f"; done
[ -x /usr/local/bin/agentcore-chat-bridge ] && pass "包装脚本已安装" || failt "包装脚本"
[ "$(readlink /usr/local/bin/agentcore-feishu-bot)" = agentcore-chat-bridge ] && pass "旧命令名是兼容链接" || failt "兼容链接"
[ "$(stat -c %a /etc/sudoers.d/agentcore-feishu-bot)" = 440 ] && pass "sudoers 0440" || failt "sudoers"
visudo -cf /etc/sudoers.d/agentcore-feishu-bot >/dev/null && pass "sudoers 语法" || failt "sudoers 语法"
[ -f /etc/systemd/system/agentcore-feishu-bot.service ] && pass "systemd 单元" || failt "systemd 单元"
[ "$(stat -c %U /opt/agentcore-feishu-bot/current/afb.mjs)" = root ] && pass "代码属主 root" || failt "属主"
sudo -u afbot test -w /opt/agentcore-feishu-bot/current/afb.mjs && failt "afbot 能写代码" || pass "afbot 不能写代码"
/opt/agentcore-feishu-bot/current/node --version

echo "=== 2. 以 afbot 运行 CLI"
cat > /var/lib/agentcore-feishu-bot/bots.json <<J
{"schemaVersion":1,"settings":{"userPoolId":"us-west-2_x","hmacSecretArn":"arn:aws:secretsmanager:us-west-2:1:secret:x","region":"us-west-2"},"bots":[]}
J
chown afbot:afbot /var/lib/agentcore-feishu-bot/bots.json && chmod 600 /var/lib/agentcore-feishu-bot/bots.json
out=$(sudo -u afbot /opt/agentcore-feishu-bot/bin/afb list 2>&1) && echo "$out" | grep -q "还没有机器人" && pass "afb list" || failt "afb list: $out"
sudo -u afbot /opt/agentcore-feishu-bot/bin/afb version

make_release() { # version source directory
  mkdir -p "/bucket/releases/$1"
  tar -czf "/bucket/releases/$1/agentcore-feishu-bot-$1.tar.gz" -C "$2" .
  (cd "/bucket/releases/$1" && sha256sum "agentcore-feishu-bot-$1.tar.gz" > "agentcore-feishu-bot-$1.tar.gz.sha256")
}
expect_reject() { # version description
  if $FETCH "$1" --no-restart >/tmp/out.txt 2>&1; then cat /tmp/out.txt; failt "$2 没有被拒绝"; fi
  grep "失败" /tmp/out.txt | head -1
  [ "$(readlink /opt/agentcore-feishu-bot/current)" = "releases/$V" ] && pass "$2 被拒绝，current 仍是 $V" || failt "$2 current 被改"
  [ ! -e "/opt/agentcore-feishu-bot/releases/$1" ] || failt "$2 留下了版本目录"
}
base=/opt/agentcore-feishu-bot/current/

echo "=== 3. 包内含符号链接"
rm -rf /tmp/e1 && cp -r "$base" /tmp/e1 && ln -s /etc/passwd /tmp/e1/link
make_release 9.0.1 /tmp/e1; expect_reject 9.0.1 "符号链接"

echo "=== 4. sidecar sha256 不一致"
mkdir -p /bucket/releases/9.0.2
cp "/bucket/releases/$V/agentcore-feishu-bot-$V.tar.gz" /bucket/releases/9.0.2/agentcore-feishu-bot-9.0.2.tar.gz
printf '%064d  x\n' 0 > /bucket/releases/9.0.2/agentcore-feishu-bot-9.0.2.tar.gz.sha256
expect_reject 9.0.2 "sha256 不一致"

echo "=== 5. 包内文件被篡改（SHA256SUMS 不匹配）"
rm -rf /tmp/e3 && cp -r "$base" /tmp/e3 && echo "// evil" >> /tmp/e3/afb.mjs
make_release 9.0.3 /tmp/e3; expect_reject 9.0.3 "文件被篡改"

echo "=== 6. 包内有未登记的文件"
rm -rf /tmp/e4 && cp -r "$base" /tmp/e4 && echo x > /tmp/e4/extra.sh
make_release 9.0.4 /tmp/e4; expect_reject 9.0.4 "未登记文件"

echo "=== 7. 路径含 ..（用 python 构造）"
python3 - <<'PY'
import tarfile, io
with tarfile.open("/tmp/e5.tar.gz", "w:gz") as t:
    data = b"x"
    ti = tarfile.TarInfo("../escape.txt"); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
PY
mkdir -p /bucket/releases/9.0.5 && mv /tmp/e5.tar.gz /bucket/releases/9.0.5/agentcore-feishu-bot-9.0.5.tar.gz
(cd /bucket/releases/9.0.5 && sha256sum agentcore-feishu-bot-9.0.5.tar.gz > agentcore-feishu-bot-9.0.5.tar.gz.sha256)
expect_reject 9.0.5 "路径含 .."
[ ! -e /opt/agentcore-feishu-bot/escape.txt ] && [ ! -e /opt/agentcore-feishu-bot/releases/escape.txt ] && pass "没有写到包外" || failt "写到了包外"

echo "=== 8. 版本号格式"
$FETCH "1.0" --no-restart >/dev/null 2>&1 && failt "接受了 1.0" || pass "拒绝 1.0"
$FETCH "1.0.0;rm" --no-restart >/dev/null 2>&1 && failt "接受了注入" || pass "拒绝 1.0.0;rm"

echo "=== 9. 升级到合法新版本并重启"
rm -rf /tmp/ok && cp -r "$base" /tmp/ok && echo "9.1.0" > /tmp/ok/VERSION
(cd /tmp/ok && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS)
make_release 9.1.0 /tmp/ok
$FETCH 9.1.0 | tail -3
[ "$(readlink /opt/agentcore-feishu-bot/current)" = "releases/9.1.0" ] && pass "升级到 9.1.0" || failt "升级"
$FETCH "$V" --no-restart >/dev/null && [ "$(readlink /opt/agentcore-feishu-bot/current)" = "releases/$V" ] && pass "回退到已有版本 $V" || failt "回退"

echo "=== 10. 主机文件安装失败时回退"
rm -rf /tmp/bad && cp -r "$base" /tmp/bad && printf '#!/bin/bash\nexit 1\n' > /tmp/bad/host/install-host.sh
(cd /tmp/bad && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS)
make_release 9.2.0 /tmp/bad
if $FETCH 9.2.0 --no-restart >/tmp/out.txt 2>&1; then failt "安装失败没有报错"; fi
grep "回退" /tmp/out.txt
[ "$(readlink /opt/agentcore-feishu-bot/current)" = "releases/$V" ] && pass "回退到 $V" || failt "没有回退"

echo "ALL PASS"
