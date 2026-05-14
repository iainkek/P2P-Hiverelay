# Request: bounce the 4 relays currently pinning pear://tco5...

> Companion to [`FEEDBACK-PEARBROWSER-PIN-CAP-FAILURE.md`](./FEEDBACK-PEARBROWSER-PIN-CAP-FAILURE.md) — Follow-up section, ask (6).

PearBrowser desktop maintainers · 2026-05-14

## TL;DR

Your v0.8.11 fix landed correctly and works on fresh seeds. But our
production drive was already partial-pinned at 256 MB before v0.8.11
rolled out, and the relay's `seedApp()` early-return on `alreadySeeded`
means our 1 GB re-pin never reaches `_seedAppInner` to re-validate or
re-trigger `drive.download('/')`. The relays are sitting on incomplete
blob state.

The cleanest unblock: **restart the 4 relays our drive is on**. Fresh
start clears `seededApps`, the next pin request from us hits the full
v0.8.11 code path, and the drive completes its full download under the
1 GB cap.

## Specifically

- App key: `8b21b577993ce0fc45036ca9011861e25f0a49fd4d68bcc655fb2690a03cb062`
- pear link: `pear://tco5k7h38uoxatedp1wongdbhjxow1x7jiwm3t1i9cujbebhsbty`
- discoveryKey: `00f61fc1473b9d01a199833fc96e76d5e99000c603ec697bc842f8d978538f4d`
- Drive size: 365 MB (1.2 MB metadata + 364 MB blobs)
- Relays that accepted our most recent pin (per `pin-self-on-hiverelay.js` output):
  - `0da2f0626d24…`
  - `17ba6ae38d69…`
  - `1e7d8b1ffe69…`
  - `37cf4bfbdf33…`

Per your deploy notes, the production fleet is Utah / Utah-US /
Singapore — so 3 of those 4 are probably yours.

## After the bounce

We'll re-run `node scripts/pin-self-on-hiverelay.js` and
`node scripts/verify-pin.js --expect 4914` from the
pearbrowser-desktop repo. Verify should pass within ~5-10 minutes
once the relays do a fresh `drive.download('/')` under the 1 GB cap.

I'll update the Resolution section of the feedback doc with the
final pass result, and we can close the v0.8.11 episode.

## If a bounce isn't convenient

We can wait for v0.8.12 with ask (6) addressed — no rush. The
production drive is technically "live" in that `pear info` works;
it's just that fresh-machine `pear run` first launch hangs on the
missing blob blocks. We've told one affected user to wait, and
they're patient.

If you'd rather batch the bounce with the v0.8.12 deploy, that's
fine too — just let us know which path you prefer.

## Contact

Reply here (this file in the repo) or wherever convenient.
