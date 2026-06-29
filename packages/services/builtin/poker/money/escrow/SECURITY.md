# PokerEscrow — threat model & audit-prep

**Status: UNAUDITED.** This document is pre-audit preparation for
`contracts/PokerEscrow.sol` — the on-chain USD₮ escrow for P2Poker. It states the
system model, trust assumptions, invariants, a threat analysis, and concrete
findings/recommendations an external auditor should confirm before this handles
real value. It is written to make an audit faster and cheaper, not to substitute
for one.

## 1. System model

An application-specific state channel. Per session/table:

1. **deposit** — each seat `approve()`s and `deposit()`s a USD₮ bankroll. Allowed
   until `settled`.
2. **play** — entirely off-chain on the HiveRelay signed log. The chain sees none
   of it.
3. **settle (once)** — the session's NET final balances are recorded exactly once:
   - `cooperativeClose` — every participant signs the agreed `(payees, balances)`.
   - `disputeClose` — an m-of-n committee attests the canonical outcome.
   Both enforce conservation (`Σ balances == pot`) and that every payee is a seat.
4. **withdraw** — each seat PULLS its settled net (`withdrawable[msg.sender]`).
   No deposit-refund path: you only ever take out your settled net.

## 2. Actors & trust assumptions

| Actor | Trusted for | NOT trusted for |
|---|---|---|
| **Players (seats)** | their own funds; signing exactly one agreed result | honesty toward each other (enforced by signatures + conservation) |
| **Committee (relays)** | **liveness + the canonical outcome on the dispute path** | — but a quorum CAN redistribute the pot among seats (see T-7) |
| **Submitter** (anyone) | nothing — settlement is fixed by the signatures | can only choose *which* fully-signed result to submit (see T-5) |
| **USD₮ token** | standard ERC-20 transfer semantics | non-standard return / fee-on-transfer behaviour (see T-6) |

**Core trust statement:** funds custody is trustless (no operator key can move
funds), but the **dispute outcome is only as honest as the committee quorum**, and
**liveness depends on the committee** — see T-1 and T-7.

## 3. Assets & invariants

**Asset:** the pot — `Σ deposited[seat]` USD₮ held by the contract.

Invariants the contract maintains (and tests assert):

- **I-1 Conservation.** A settle requires `Σ balances == pot()`, so total
  `withdrawable` never exceeds total deposited. The contract can never owe more
  than it holds.
- **I-2 Funds stay among seats.** `_record` requires `isParticipant[payee]` for
  every payee → settled funds can only ever return to the table's seats.
- **I-3 Single settlement.** `settled` flips true on the first close; no further
  deposit or close is possible. Exactly one outcome is ever recorded.
- **I-4 Pull-only payout, CEI.** `withdraw()` zeroes `withdrawable[msg.sender]`
  before the transfer and is `nonReentrant`.
- **I-5 No unilateral refund.** There is no path to reclaim a deposit; the only
  exit is a settled net via withdraw.

## 4. Threat analysis

| # | Threat | Mitigation in code | Residual / note |
|---|---|---|---|
| T-1 | **Funds locked forever** (no close ever happens) | Committee dispute path settles without player cooperation | **By design there is NO timeout refund.** If `committeeThreshold == 0` (no committee) and a player refuses to co-sign, funds lock permanently. → **A committee is REQUIRED for liveness in production.** |
| T-2 | Operator/contract steals funds | No owner, no admin, no upgrade; only seats withdraw their settled net | None — custody is trustless |
| T-3 | Reentrancy on payout | CEI (zero before transfer) + `nonReentrant`; closes make no external calls | Covered by `reentrancy.test.cjs` |
| T-4 | Forged/replayed settlement | EIP-191 sigs over `keccak256(abi.encode(escrowId, …))`; `escrowId` domain-separates per escrow; `settled` blocks replay | Cross-escrow replay test covers it |
| T-5 | Submitter substitutes a different result | All signatures are over the exact `(payees, balances)`; conservation + payee-is-seat enforced | **If players sign more than one settlement, whoever submits first wins.** Clients MUST sign exactly one final result. No on-chain nonce on the cooperative path (single-settle makes it moot once one lands). |
| T-6 | **Non-standard / fee-on-transfer token** | **FIXED:** `_safeTransfer`/`_safeTransferFrom` tolerate no-return tokens (mainnet USDT) and revert on explicit `false`; `deposit` credits the **measured** balance delta, so fee-on-transfer can't strand funds | Both covered by tests (no-return + 1%-fee token). |
| T-7 | **Malicious committee quorum** | Strictly-increasing signer check prevents double-counting; only `isCommittee` signers count | A dishonest quorum CAN settle to any *conserving* distribution → reassign the pot among seats. Mitigate with independent relays, a high threshold, stake/reputation. This is the oracle trust boundary. |
| T-8 | Signature malleability | `ecrecover`; recovered address is matched against an expected set | Not exploitable (a malleable variant recovers the *same* address; the increasing-signer check rejects dupes). `s`-low / `v∈{27,28}` not enforced — note for auditor. |
| T-9 | Late deposit griefs a pending close | `deposit` allowed until `settled` | A deposit landing before a close changes `pot()`, so the close fails `NOT_CONSERVED` and must be re-signed against the new pot. Minor griefing/UX. Consider a deposit-lock phase. |
| T-10 | Gas griefing on payout | Pull-based (each seat withdraws itself); no loop over external payees | None |

## 5. Findings & recommended pre-mainnet fixes

- **F-1 (High → FIXED): SafeERC20-style transfers.** Mainnet Tether USDT's
  `transfer`/`transferFrom` do **not** return a bool, so the old
  `require(token.transfer(...))` would misbehave against it. Now implemented as
  internal `_safeTransfer`/`_safeTransferFrom` (low-level `call` that accepts a
  no-return token and reverts on an explicit `false`), and covered by
  `test/no-return-token.test.cjs` against a `NoReturnToken` that mimics mainnet
  USDT. The bool-returning `MockUSDT` path still passes too.
- **F-2 (Medium → FIXED): fee-on-transfer accounting.** `deposit` now credits the
  **measured** `balanceOf` delta (before/after the transfer) and emits the received
  amount, so a fee-charging token can never make `pot()` exceed the real balance.
  Covered by `test/fee-token.test.cjs` (1%-fee token: `pot` == real balance, the
  escrow drains to exactly zero, nothing stranded).
- **F-3 (Low): liveness backstop is a deliberate omission.** Document loudly that a
  threshold-0 escrow has no liveness guarantee. If operators want one without a
  committee, that is a design change (a timeout that settles to deposits), which
  re-introduces the loss-escape this design intentionally removes — decide
  explicitly.
- **F-4 (Low): deposit-lock phase.** Optionally freeze deposits (a `funded` flag or
  a per-session deadline) before settlement to remove T-9.
- **F-5 (Info → FIXED): emit `(payees, balances)` on settle.** `Settled` now emits
  `(string kind, address[] payees, uint256[] balances)` for cheap indexing/audit
  trails; asserted in `test/fee-token.test.cjs`.
- **F-6 (Info): `lastEpoch`/`epoch` is vestigial** under single-settle — it only
  enforces `epoch > 0` and domain-separates the digest. Keep for a future
  checkpointing revision or drop for clarity.

## 6. What an auditor should focus on

1. The **token integration** (F-1/F-2) — the most likely real bug for go-live.
2. The **signature scheme**: digest construction, `_allParticipantsSigned`
   completeness, `_committeeQuorum` double-count resistance, `address(0)` handling.
3. The **conservation + payee-is-seat** invariants in `_record` (I-1/I-2).
4. The **committee trust boundary** (T-7) and **liveness** (T-1) — these are design
   choices, not bugs; confirm they match operator intent.
5. Reentrancy / CEI on `withdraw` (believed sound; confirm).

## 7. Test coverage (local, `npx hardhat test` → 28 passing)

Covers: deposit→cooperative settle→withdraw; conservation + missing-sig rejection;
dispute/committee close (quorum, non-committee, stale-epoch); the withdraw-net
model (loser pulls net-not-deposit, double-withdraw, no-payout-before-settle,
no-deposit/re-settle-after-settle); reentrancy on withdraw; cross-escrow signature
replay; payee-not-seat rejection; the multi-hand session settle; the
arbitration/cheat path on-chain; the `EscrowClient` orchestration; WDK signer
interop; a **no-return ERC-20 (mainnet-USDT-like)** end-to-end (F-1); and a
**fee-on-transfer token** with the Settled-event payload (F-2/F-5). Remaining
findings (F-3 liveness, F-4 deposit-lock, F-6 vestigial epoch) are design choices,
not bugs — confirm against operator intent during audit.
