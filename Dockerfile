# syntax=docker/dockerfile:1.6
#
# p2p-hiverelay — P2P relay backbone for the Holepunch/Pear ecosystem.
#
# Multi-arch (linux/amd64, linux/arm64) — designed for Umbrel Home (ARM)
# AND x86 Umbrel/server hosts. Built via `docker buildx build --platform`.
#
# Multi-stage build:
#   Stage 1 (deps):    install production deps for all workspaces
#   Stage 2 (runtime): minimal Alpine runtime, non-root user, tini PID 1
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
# LOCAL PATCH (milkyb-fly, not for upstream): switched from
# node:20-alpine to node:22-bookworm-slim to match the working milkyb
# image (verified 2026-05-23 via `cat /etc/os-release` on the running
# container: Debian 12 bookworm + Node 22). udx-native@1.19.2 ships no
# linux-x64-musl prebuild and has no install hook to compile from
# source on Alpine — fresh Alpine builds crash at startup with
# `Cannot find module '/prebuilds/linux-x64-musl/udx-native.node'`.
# Debian/glibc loads the existing linux-x64 prebuild cleanly.
# Do NOT push this Dockerfile change upstream; bigd's release pipeline
# may have a different build path that handles Alpine correctly.
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Install build tools needed for native deps (sodium-universal, hypercore-crypto)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates \
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
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="p2p-hiverelay"
LABEL org.opencontainers.image.description="Always-on P2P relay infrastructure for the Holepunch/Pear ecosystem"
LABEL org.opencontainers.image.source="https://github.com/bigdestiny2/P2P-Hiverelay"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# tini for proper PID 1 signal handling (graceful shutdown).
# wget for HEALTHCHECK without bringing curl/openssl bloat.
# ca-certificates for HTTPS outbound (GitHub API, etc.).
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini wget ca-certificates \
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

# Set up data/config directories. The original milkyb image (verified
# 2026-05-23 on a running milkyb-hiverelay-fra container) runs as root
# and the persisted /data/.hiverelay/storage files (primary-key,
# relay-identity.json, etc.) are owned by root:root. Adding a USER
# directive here would break access to those files on existing
# deployments. Long-term: a startup hook that chowns the volume before
# dropping privileges would be safer, but that's a refactor — for now
# match the original image's behavior.
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

ENV NODE_ENV=production \
    HIVERELAY_STORAGE=/data \
    HIVERELAY_CONFIG_DIR=/config \
    HIVERELAY_LOG_LEVEL=info \
    HIVERELAY_API_PORT=9100 \
    HIVERELAY_API_HOST=0.0.0.0

# Health check hits the local API. wget is the smallest http client we have
# without bringing curl/openssl bloat; using it instead of node -e fetch()
# keeps startup faster and avoids loading the entire app to check liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --timeout=4 --spider \
    http://127.0.0.1:${HIVERELAY_API_PORT:-9100}/health || exit 1

# tini as PID 1 → graceful SIGTERM handling so shutdown actually runs.
# Debian installs tini at /usr/bin/tini (not /sbin/tini like Alpine).
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/packages/core/cli/index.js"]

# Default: start a relay node with explicit --storage path so persistent
# state lives on the mounted /data volume. The CLI does NOT read the
# HIVERELAY_STORAGE env var (only the --storage flag), so without this
# flag the relay defaults to ~/.hiverelay/storage = /root/.hiverelay/
# storage which is the ephemeral container filesystem — every redeploy
# would silently lose all persisted state. Same for max-storage —
# matches the fly.toml HIVERELAY_MAX_STORAGE intent.
# Override at runtime: `docker run ... p2p-hiverelay:latest help`
CMD ["start", "--storage", "/data/.hiverelay/storage", "--max-storage", "5GB"]
