# syntax=docker/dockerfile:1.6
#
# p2p-hiverelay — P2P relay backbone for the Holepunch/Pear ecosystem.
#
# Multi-arch (linux/amd64, linux/arm64) — designed for Umbrel Home (ARM)
# AND x86 Umbrel/server hosts. Built via `docker buildx build --platform`.
#
# Multi-stage build:
#   Stage 1 (deps):    install production deps for all workspaces
#   Stage 2 (runtime): minimal Debian-slim runtime, non-root user, tini PID 1
#
# Build:
#   docker build -t p2p-hiverelay:latest .
#
# Multi-arch build (push to registry):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t hiverelay/hiverelay:0.6.0 -t hiverelay/hiverelay:latest --push .
#
# Quick run (data volume + API port published):
#   docker run -d --name hiverelay \
#     -v hiverelay-data:/data \
#     -p 9100:9100 \
#     p2p-hiverelay:latest
#
# Open the TUI (connects to the running container's API):
#   docker exec -it hiverelay hiverelay tui
#
# Environment overrides:
#   HIVERELAY_REGION=NA           (region code)
#   HIVERELAY_MAX_STORAGE=50GB    (accepts human-readable sizes)
#   HIVERELAY_API_KEY=...         (secures management endpoints)
#   HIVERELAY_API_PORT=9100       (API port inside container)
#   HIVERELAY_HOLESAIL=1          (enable Holesail for NAT traversal)
#   LNBITS_URL=http://...         (LNbits payment provider; auto-detected on Umbrel)
#   LNBITS_ADMIN_KEY=...          (LNbits admin key for invoice creation)

# ─── Stage 1: dependencies ────────────────────────────────────────────
# Debian-slim (glibc) base. Some prebuilt native deps (e.g. udx-native, pulled
# by dht-rpc/bare-dgram) ship a linux-x64 glibc prebuild but NO linux-x64-musl
# build and no compilable source — so an Alpine/musl image fails to boot. slim
# loads the glibc prebuild directly. node:20 LTS — Bare/Pear targets stay aligned.
FROM node:20-slim AS deps
WORKDIR /app

# Install build tools needed for native deps (sodium-universal, hypercore-crypto)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*

# Copy ALL workspace package.json files (npm needs them all to resolve workspaces)
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/services/package.json packages/services/
COPY packages/client/package.json packages/client/
COPY packages/verifier/package.json packages/verifier/

# Install production deps across all workspaces. --workspaces installs deps
# for every workspace; --include-workspace-root pulls in root devDeps if any
# are needed at runtime (none currently, but explicit is better).
RUN npm ci --omit=dev --workspaces --include-workspace-root --no-audit --no-fund

# ─── Stage 2: runtime ─────────────────────────────────────────────────
FROM node:20-slim AS runtime

LABEL org.opencontainers.image.title="p2p-hiverelay"
LABEL org.opencontainers.image.description="Always-on P2P relay infrastructure for the Holepunch/Pear ecosystem"
LABEL org.opencontainers.image.source="https://github.com/bigdestiny2/P2P-Hiverelay"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# tini for proper PID 1 signal handling (graceful shutdown).
# wget for HEALTHCHECK without bringing curl/openssl bloat.
RUN apt-get update && apt-get install -y --no-install-recommends tini wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in already-installed modules from the deps stage. npm 7+ hoists
# most workspace deps to the root `node_modules/`. Per-package
# `node_modules/` only exist when there's a version conflict — historically
# `packages/core/node_modules/` etc. weren't created by `npm ci --workspaces`
# at all, so the per-package COPY commands here used to fail the whole
# build. Copy the root tree once; that's enough for production startup.
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (respects .dockerignore)
COPY . .

# Runs as root, matching the already-deployed relay images whose /data volumes
# are root-owned (uid 0). The non-root `USER hiverelay` hardening was never
# shipped to those relays; switching users here would EACCES on the existing
# root-owned /data/.hiverelay/storage. Keep root to stay volume-compatible.
RUN mkdir -p /data /config

# Make the hiverelay binary globally callable inside the container, so
# `docker exec -it hiverelay hiverelay tui` just works.
RUN ln -s /app/packages/core/cli/index.js /usr/local/bin/p2p-hiverelay && \
    ln -s /app/packages/core/cli/index.js /usr/local/bin/hiverelay && \
    chmod +x /app/packages/core/cli/index.js

VOLUME ["/data", "/config"]

# API port. Gateway (9200) and other transport ports may need their own
# `-p` mappings when you enable them.
EXPOSE 9100

# HOME=/data so os.homedir()-based storage resolves to /data/.hiverelay/storage —
# the path the already-deployed relays persist their identity (primary-key) at on
# the /data volume. The config loader is homedir-based and ignores HIVERELAY_STORAGE,
# so HOME is the lever that makes a fresh image reuse the existing relay pubkey
# instead of minting a new identity on ephemeral /root storage every restart.
ENV NODE_ENV=production \
    HOME=/data \
    HIVERELAY_STORAGE=/data \
    HIVERELAY_CONFIG_DIR=/config \
    HIVERELAY_LOG_LEVEL=info \
    HIVERELAY_API_PORT=9100 \
    HIVERELAY_API_HOST=0.0.0.0

# Health check hits the local API. wget is the smallest http client we have
# in Alpine; using it instead of node -e fetch() keeps startup faster and
# avoids loading the entire app to check liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --timeout=4 --spider \
    http://127.0.0.1:${HIVERELAY_API_PORT:-9100}/health || exit 1

# tini as PID 1 → graceful SIGTERM handling so shutdown actually runs.
# Debian's tini package installs to /usr/bin/tini (Alpine used /sbin/tini).
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/packages/core/cli/index.js"]

# Default: start a relay node. Override to run other subcommands, e.g.:
#   docker run ... p2p-hiverelay:latest help
CMD ["start"]
