# Phase 01 — Escrow & settlement mechanism spike  `[X]` `decision`

> A **spike**, not a build. Output is a decision + frozen interfaces + the
> thinnest possible testnet proof. Everything in M1 assumes what this phase
> freezes, so keep it tight and decisive. See [../../ROADMAP.md](../../ROADMAP.md).

## Goal

Pick the escrow + settlement mechanism(s) per asset, and freeze the three
interfaces the rest of the milestone is written against:
`EscrowDescriptor`, `Verdict`, `Attestation`.

## Why this gates everything

Every later phase touches one of these:
- 02 reducer signs over a `handHash` that the escrow must consume.
- 03 attestation must be in a shape the escrow's release path verifies.
- 07/08 (WDK + funding) depend on whether the chosen asset even supports the
  escrow primitive (BTC multisig vs EVM/Solana contract vs Lightning/Spark).
- 10/11 (settlement) are literally "drive this escrow."

If the mechanism changes later, those phases churn. So decide now, cheaply.

## Key questions to answer (the actual research)

1. **What does WDK actually expose?** Send/receive only, or multisig / contract
   calls / HTLC / conditional payments? (Prior research suggests Lightning is a
   "stateless API," not raw HTLCs — confirm against `docs.wdk.tether.io` and the
   WDK source.) This bounds what's buildable *through* WDK vs *around* it.
2. **Per asset, what is the cheapest trustless escrow?**
   - **BTC**: taproot + **MuSig2** n-of-n, committee as tapscript fallback path.
   - **EVM / Solana**: an **escrow contract/program** holding USD₮, released by
     winner co-sign OR by an attestation-verifying path.
   - **Lightning / Spark**: per-hand **conditional/net settlement** — feasible
     for fast poker, or only for deposit/withdraw rails?
3. **How does the off-chain verdict reach the on-chain/-ledger release?** i.e.
   the **oracle problem**: the escrow must accept the Phase-03 attestation (a
   relay-quorum signature over `handHash`) as a release authorization. Define
   that verification (signature set, threshold, replay guard).
4. **Latency / cost / UX per hand** — is per-hand on-chain settlement viable, or
   must we settle **per session** (escrow once, many hands, settle net)? (Likely
   per-session for chains; per-hand only for Lightning-class rails.)
5. **Abort economics** — minimum bond so quitting is never +EV; where the bond
   sits (inside the escrow vs a separate slashable deposit).

## Tasks

1. **Research WDK's payment surface** (docs + source): exact capabilities for
   multisig / contract / conditional payments per supported chain. Write
   findings to `RESEARCH.md` in this phase dir.
2. **Map 3 candidate mechanisms** (BTC-MuSig2, EVM/Solana-contract,
   Lightning/Spark) against: trustlessness, latency, cost/hand, WDK support,
   grief-path support, implementation effort. Decision matrix.
3. **Choose** a primary mechanism (likely one chain-asset for v1) + a documented
   path to multi-asset. Record as an **ADR** (`DECISION.md`).
4. **Freeze interfaces** (`interfaces.md` + stub types):
   - `EscrowDescriptor { escrowId, asset, participants[], threshold, committee[],
     amount, releaseConditions, fundingRef }`
   - `Attestation { handHash, escrowId, outcome, signers[], sigs[] }`
   - `Verdict { handHash, escrowId, payTo[], slash[], evidenceRef }`
   - The `stake`-entry `escrowProof` shape (how a peer proves their seat is funded).
5. **Thin testnet proof**: 2 parties fund a pot in the chosen mechanism and
   co-sign a **happy-path** release (no grief path yet). Capture the txids /
   ledger refs as evidence.

## Success criteria

- [ ] `DECISION.md` (ADR): mechanism per asset for v1 + multi-asset path, with
      the decision matrix and explicit trade-offs.
- [ ] `interfaces.md`: frozen `EscrowDescriptor` / `Attestation` / `Verdict` /
      `escrowProof` shapes that 02–11 can code against.
- [ ] A working **testnet happy-path release** of a 2-party pot in the chosen
      mechanism (evidence: tx/ledger refs).
- [ ] `RESEARCH.md`: WDK payment-surface findings + the per-asset escrow notes.
- [ ] Confirmed answer to "per-hand vs per-session settlement" with rationale.

## Explicitly NOT in this phase

- The grief/dispute path (Phases 03/04/11) — only prove cooperative release.
- Production hardening, key management UX, multi-asset breadth (just the path).
- The reducer itself (Phase 02) — but this phase must define the `handHash` it
  will sign over.

## Risks / watch-items

- **WDK may not expose the needed primitive** for the preferred asset → the
  escrow may have to be built *around* WDK (direct chain libs) with WDK only as
  the wallet. Decide this explicitly; it changes Phase 07/08 scope.
- **Oracle trust** — the attestation threshold is the crux of grief-path
  trustlessness; under-spec here and Phase 11 inherits a hole.
- **Don't gold-plate** — resist designing the full multi-asset matrix; pick one
  and ship the path.

## Handoff to next phases

On completion, 02 (reducer) and 07 (WDK wallet) unblock and run in parallel;
03/08 consume the frozen interfaces. Record open questions in
`.planning/phases/01-escrow-settlement-spike/NOTES.md` for the planner of 02/03.
