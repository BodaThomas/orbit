#!/bin/sh
# Orbit Runtime — installation on a Linux server (Debian/Ubuntu tested in a container).
#
# Run as root, after reading it. It never downloads anything: you bring the bundle
# (out/runtime/orbit-runtime.mjs, built by `npm run build:runtime`) and its SHA-256.
#
#   sudo sh install.sh --bundle ./orbit-runtime.mjs --sha256 <hash> \
#        [--authorize-key "ssh-ed25519 AAAA… orbit-desktop"] [--user orbit] [--no-start]
#
# What it does, and nothing else:
#   1. checks prerequisites (Linux, systemd, Node.js ≥ 22.16, bundle hash);
#   2. creates a dedicated system user without password or sudo (default: orbit),
#      home /var/lib/<user>, runtime folder /var/lib/<user>/runtime (0700);
#   3. installs the bundle root-owned in /opt/orbit (the agents can't modify it);
#   4. optionally authorises Orbit Desktop's SSH key with a forced command: that key can
#      only run `orbit-runtime attach` — no shell, no forwarding, no PTY;
#   5. writes a hardened systemd unit and starts it (unless --no-start);
#   6. runs `orbit-runtime doctor`.
# Engines (Claude Code, Codex) are NOT installed: install them yourself with their
# official instructions, then log in as the dedicated user (see docs/REMOTE_SETUP.md).
set -eu

USER_NAME=orbit
BUNDLE=""
SHA=""
KEY=""
START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    --sha256) SHA="$2"; shift 2 ;;
    --authorize-key) KEY="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

fail() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }

[ "$(uname -s)" = "Linux" ] || fail "Linux requis."
[ "$(id -u)" = "0" ] || fail "À lancer avec sudo (création d'utilisateur et du service)."
echo "$USER_NAME" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || fail "Nom d'utilisateur invalide."
[ -n "$BUNDLE" ] && [ -f "$BUNDLE" ] || fail "--bundle FICHIER requis (out/runtime/orbit-runtime.mjs)."
[ -n "$SHA" ] || fail "--sha256 requis : vérifiez le fichier transféré (shasum -a 256 sur le Mac)."
ACTUAL=$(sha256sum "$BUNDLE" | cut -d' ' -f1)
[ "$ACTUAL" = "$SHA" ] || fail "Empreinte du bundle différente ($ACTUAL) : fichier altéré ou incomplet."
ok "Bundle vérifié ($SHA)"

NODE=$(command -v node || true)
[ -n "$NODE" ] || fail "Node.js introuvable. Installez une version LTS (≥ 22.16) depuis nodejs.org ou les paquets de votre distribution, puis relancez."
NODE_OK=$("$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=16)?1:0)')
[ "$NODE_OK" = "1" ] || fail "Node.js $("$NODE" -v) trop ancien : 22.16 minimum (LTS 24 recommandée)."
ok "Node.js $("$NODE" -v) ($NODE)"
HAS_SYSTEMD=0
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && HAS_SYSTEMD=1
[ "$HAS_SYSTEMD" = "1" ] && ok "systemd présent" || echo "· systemd absent : le service ne sera pas installé (conteneur ?)"
command -v bwrap >/dev/null 2>&1 && ok "bubblewrap présent (isolation par mission)" || echo "· bubblewrap absent : apt install bubblewrap pour isoler chaque mission"

HOME_DIR=/var/lib/$USER_NAME
if id "$USER_NAME" >/dev/null 2>&1; then
  # Existing user: use its real home (the SSH key and the service must live there).
  HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
  [ -n "$HOME_DIR" ] && [ "$HOME_DIR" != "/" ] || fail "Dossier personnel de $USER_NAME introuvable : utilisez --user avec un autre nom."
  ok "Utilisateur $USER_NAME existant (inchangé, dossier $HOME_DIR)"
else
  useradd --system --home-dir "$HOME_DIR" --create-home --shell /bin/sh "$USER_NAME"
  passwd -l "$USER_NAME" >/dev/null 2>&1 || true
  ok "Utilisateur $USER_NAME créé (sans mot de passe, sans sudo)"
fi
RT_HOME=$HOME_DIR/runtime
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR" "$RT_HOME"

install -d -m 0755 -o root -g root /opt/orbit /opt/orbit/bin
install -m 0644 -o root -g root "$BUNDLE" /opt/orbit/orbit-runtime.mjs
cat > /opt/orbit/bin/orbit-runtime <<EOF
#!/bin/sh
exec $NODE /opt/orbit/orbit-runtime.mjs "\$@"
EOF
chmod 0755 /opt/orbit/bin/orbit-runtime
ok "Runtime installé dans /opt/orbit (propriété root, lecture seule pour $USER_NAME)"

if [ -n "$KEY" ]; then
  echo "$KEY" | grep -Eq '^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( .*)?$' || fail "Clé SSH publique invalide."
  install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
  LINE="command=\"/opt/orbit/bin/orbit-runtime attach --home $RT_HOME\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc $KEY"
  touch "$HOME_DIR/.ssh/authorized_keys"
  grep -qF "$KEY" "$HOME_DIR/.ssh/authorized_keys" || echo "$LINE" >> "$HOME_DIR/.ssh/authorized_keys"
  chown "$USER_NAME:$USER_NAME" "$HOME_DIR/.ssh/authorized_keys"
  chmod 0600 "$HOME_DIR/.ssh/authorized_keys"
  ok "Clé d'Orbit Desktop autorisée — uniquement pour « orbit-runtime attach »"
fi

if [ "$HAS_SYSTEMD" = "1" ]; then
  su -s /bin/sh "$USER_NAME" -c "/opt/orbit/bin/orbit-runtime unit --system $USER_NAME --home $RT_HOME" > /etc/systemd/system/orbit-runtime.service
  chmod 0644 /etc/systemd/system/orbit-runtime.service
  systemctl daemon-reload
  ok "Service systemd écrit (/etc/systemd/system/orbit-runtime.service)"
  if [ "$START" = "1" ]; then
    systemctl enable --now orbit-runtime
    sleep 2
    su -s /bin/sh "$USER_NAME" -c "/opt/orbit/bin/orbit-runtime health --home $RT_HOME" || echo "· Le service démarre encore : systemctl status orbit-runtime"
  fi
fi

echo
su -s /bin/sh "$USER_NAME" -c "/opt/orbit/bin/orbit-runtime doctor --home $RT_HOME" || true
echo
echo "Ensuite, connectez les moteurs en tant que $USER_NAME (voir docs/REMOTE_SETUP.md), puis ajoutez la machine dans Orbit → Machines."
