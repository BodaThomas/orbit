#!/bin/sh
# Validates the runtime on Linux in local, disposable containers (no VPS, nothing exposed:
# the SSH port is bound to 127.0.0.1 only). Requires a running Docker daemon.
#
#   sh deploy/validate-linux.sh          build, start, run tests/linux-container.live.test.ts, stop
#
# Containers:
#   orbit-rt-hardened  production-like: uid 10001, read-only rootfs, all capabilities dropped,
#                      no-new-privileges, memory/CPU/PID limits, no Docker socket, test engine.
#   orbit-rt-ssh       same image with sshd, to exercise the real SSH transport (pinned host
#                      key, key restricted by a forced command). sshd needs a few capabilities.
#   (one-off)          bubblewrap self-test, with and without Docker's default seccomp profile.
set -eu
cd "$(dirname "$0")/.."
WORK=$(mktemp -d "${TMPDIR:-/tmp}/orbit-linux-XXXXXX")
trap 'docker rm -f orbit-rt-hardened orbit-rt-ssh >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

npm run build:runtime
docker build -f deploy/Dockerfile -t orbit-runtime:test .

echo "── bubblewrap (isolation par mission)"
echo "· profil seccomp par défaut de Docker :"
docker run --rm --read-only --tmpfs /tmp --tmpfs /var/tmp --cap-drop ALL --security-opt no-new-privileges orbit-runtime:test doctor --home /tmp/rt 2>&1 | grep -i "isolation\|bubblewrap" || true
echo "· seccomp non confiné (espaces de noms utilisateur autorisés, comme sur un VPS) :"
docker run --rm --read-only --tmpfs /tmp --tmpfs /var/tmp --cap-drop ALL --security-opt no-new-privileges --security-opt seccomp=unconfined orbit-runtime:test doctor --home /tmp/rt 2>&1 | grep -i "isolation\|bubblewrap" || true

echo "── conteneur durci"
docker volume rm orbit-rt-data >/dev/null 2>&1 || true
docker run -d --name orbit-rt-hardened \
  --read-only --tmpfs /tmp --tmpfs /var/tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 256 --memory 1g --cpus 1 \
  -e ORBIT_RUNTIME_TEST_ENGINE=1 -e TZ=Europe/Paris \
  -v orbit-rt-data:/var/lib/orbit \
  orbit-runtime:test daemon >/dev/null
sleep 3
docker exec orbit-rt-hardened orbit-runtime health

echo "── conteneur SSH"
ssh-keygen -q -t ed25519 -N '' -C orbit-desktop-test -f "$WORK/orbit_test_key"
docker run -d --name orbit-rt-ssh --user root \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add SYS_CHROOT --cap-add AUDIT_WRITE --cap-add KILL \
  --security-opt no-new-privileges \
  -e ORBIT_RUNTIME_TEST_ENGINE=1 \
  -p 127.0.0.1:2222:22 --entrypoint /bin/sh orbit-runtime:test -c '
    ssh-keygen -A >/dev/null
    printf "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers orbit\nAllowTcpForwarding no\nX11Forwarding no\n" > /etc/ssh/sshd_config.d/orbit.conf
    su -s /bin/sh orbit -c "ORBIT_RUNTIME_TEST_ENGINE=1 orbit-runtime daemon --home /var/lib/orbit/runtime >/var/lib/orbit/daemon.log 2>&1 &"
    exec /usr/sbin/sshd -D -e' >/dev/null
sleep 3
KEY=$(cat "$WORK/orbit_test_key.pub")
docker exec -u root orbit-rt-ssh sh -c "install -d -m 700 -o orbit -g orbit /var/lib/orbit/.ssh && echo 'command=\"/opt/orbit/bin/orbit-runtime attach --home /var/lib/orbit/runtime\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc $KEY' > /var/lib/orbit/.ssh/authorized_keys && chown orbit:orbit /var/lib/orbit/.ssh/authorized_keys && chmod 600 /var/lib/orbit/.ssh/authorized_keys"

echo "── tests"
ORBIT_LINUX_DOCKER=orbit-rt-hardened ORBIT_LINUX_SSH_PORT=2222 ORBIT_LINUX_SSH_KEY="$WORK/orbit_test_key" \
  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run tests/linux-container.live.test.ts
