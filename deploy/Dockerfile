# Orbit Runtime in a container — for validation, or as an alternative to a systemd install.
#
# Build (after `npm run build:runtime`):
#   docker build -f deploy/Dockerfile -t orbit-runtime:test .
#
# Run hardened (see deploy/run-container.sh for the full, commented command):
#   non-root user, read-only root filesystem, every capability dropped,
#   no-new-privileges, resource limits, no Docker socket, state on one volume.
#
# Engines are not baked in: install them in a derived image with their official
# instructions, and log in inside the container as the `orbit` user.
FROM node:24-bookworm-slim

# bubblewrap: per-mission isolation · git: constellation worktrees · openssh-server: to
# validate the real SSH transport (forced command) — remove it for production use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap git ca-certificates openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /var/lib/orbit --create-home --shell /bin/sh orbit \
 && passwd -l orbit >/dev/null \
 && install -d -m 0755 /opt/orbit/bin \
 && mkdir -p /run/sshd

COPY out/runtime/orbit-runtime.mjs /opt/orbit/orbit-runtime.mjs
RUN printf '#!/bin/sh\nexec node /opt/orbit/orbit-runtime.mjs "$@"\n' > /opt/orbit/bin/orbit-runtime \
 && chmod 0755 /opt/orbit/bin/orbit-runtime \
 && chmod 0644 /opt/orbit/orbit-runtime.mjs \
 && install -d -m 0700 -o orbit -g orbit /var/lib/orbit/runtime

ENV PATH=/opt/orbit/bin:$PATH HOME=/var/lib/orbit ORBIT_RUNTIME_HOME=/var/lib/orbit/runtime
USER orbit
WORKDIR /var/lib/orbit
VOLUME ["/var/lib/orbit"]
HEALTHCHECK --interval=30s --timeout=10s CMD ["orbit-runtime", "health"]
ENTRYPOINT ["orbit-runtime"]
CMD ["daemon"]
