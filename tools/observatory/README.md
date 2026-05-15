# HiveRelay Observatory

Fleet-wide topology + state dashboard. Polls each relay's HTTP endpoints
every 10s and renders a per-relay card view at `/`.

## What it shows

For each relay:
- Up/down (from `/health`), running flag, uptime
- Connected peer count + 12-char pubkey list, with known peers labeled
  (`37cf4bfbdf33 utah-us`) and unknowns flagged
- App count + anchored count (from `/catalog.json`)
- Version (from `/.well-known/hiverelay.json`)
- Operator + region tag
- Any endpoint errors

## Endpoints

- `/` — dashboard HTML
- `/api/state` — current snapshot JSON
- `/api/history` — last N polls (compact derived metrics only)
- `/api/config` — fleet config (relays + poll interval)
- `/healthz` — observatory self-health

## Run locally

```sh
cd tools/observatory
npm start
# open http://localhost:9200
```

## Deploy to Bern (or any observatory host)

```sh
# From repo root, rsync the directory to the target
rsync -a --delete \
  tools/observatory/ \
  root@45.59.123.112:/root/hiverelay-observatory/

# On the target:
ssh root@45.59.123.112 '
  cp /root/hiverelay-observatory/systemd/hiverelay-observatory.service \
     /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable hiverelay-observatory
  systemctl restart hiverelay-observatory
  systemctl is-active hiverelay-observatory
  curl -s http://127.0.0.1:9200/healthz
'
```

Open `http://45.59.123.112:9200/` once UFW (or your firewall) allows
inbound 9200, or tunnel: `ssh -L 9200:127.0.0.1:9200 root@45.59.123.112`.

## Roadmap

- **v0.1** (current): pull poller, per-relay cards, in-memory history
- **v0.2**: live log tail (SSH `tail -F` aggregated → SSE)
- **v0.3**: topology graph (force-directed) showing peer connections
- **v0.4**: custody flow visualizer — driven by `scripts/custody-e2e.js`
- **v1.0**: persistent storage (SQLite), alert hooks, historical queries

## Env vars

| Var                       | Default | Notes                                     |
| ------------------------- | ------- | ----------------------------------------- |
| `OBSERVATORY_PORT`        | `9200`  | HTTP listen port                          |
| `OBSERVATORY_POLL_MS`     | `10000` | Poll interval per relay                   |
| `OBSERVATORY_HISTORY`     | `360`   | Ring buffer size (~1h at 10s)             |

## Adding/removing relays

Edit the `RELAYS` array in `server.js`. Each entry needs
`{ id, host, region, operator }`. Restart the service after edit.

## Security note

The observatory only hits **public** relay endpoints (`/health`,
`/peers`, `/status`, `/catalog.json`, `/.well-known/hiverelay.json`).
No API keys are needed and none should be configured here. If we later
want to hit `/api/manage/*` for federation state, keys should be threaded
via per-relay env vars, not committed to source.

The observatory's own HTTP surface is unauthenticated. Don't expose it
to the public internet; bind to localhost + SSH-tunnel, or put it behind
a private reverse proxy.
