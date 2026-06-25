# Phase 01 — NOTES / handoff to 02, 03, 07

Open questions and constraints the next planners inherit.

## Hard constraints created by the DECISION (don't re-litigate silently)
- **Settlement is per-session (state channel).** Phase 02's reducer must emit a
  `sessionHash` + net `balances`, not only per-hand results.
- **The attestation signature must be EVM-cheap to verify.** Phase 03 chooses
  between (a) BLS aggregate (one pairing check) or (b) k×secp256k1 via
  `ecrecover` (committee keys are Ethereum addresses). This changes the relay
  committee's key type — decide before building 03.
- **USD₮ on an EVM L2 is the v1 asset.** Final L2 picked in 07/08.

## Must verify hands-on (before committing 07/08)
1. `@tetherto/wdk-wallet-evm` can deploy + call arbitrary contracts (calldata +
   value). If not → WDK = signer, ethers/viem = encoder. **Decisive for 07.**
2. Whether WDK mandates a hosted indexer/RPC (liveness/centralization risk).
3. Gasless (EIP-7702 / `wdk-wallet-evm-7702-gasless`) covers deposit + close so
   players need no native gas token.

## Design tensions to resolve in later phases
- **Bond sizing (05/11):** bond ≥ max single-hand swing so quitting is never
  +EV, without punishing honest disconnects (grace window via the objective
  clock). Where does the bond live — inside the escrow deposit or a separate
  slashable pool?
- **Committee selection / sybil (03/04):** which relays are in the attestor
  committee, how rotated, how sybil-resisted (reputation? stake?). The contract
  pins a committee set/root — rotation needs a contract update path or a
  committee-of-committees.
- **Checkpointing (08/10):** for long sessions, optional periodic on-chain
  checkpoints bound the dispute surface (you can only dispute since the last
  checkpoint). Decide if v1 needs it or settles once at session end.
- **Multi-table / cross-table bankroll:** v1 = one escrow per table-session.
  Cross-table shared bankroll is out of scope.

## Things explicitly deferred (not bugs, decisions)
- Solana PDA escrow (v1.1), BTC MuSig2 pots (later), Spark/HTLC per-hand fast
  settlement (post-v1). Spark stays the deposit/cashout rail.
- Cashu/Pear-Credit fast-chip layers (optional UX, not trustless critical path).

## Status of Phase 01 success criteria
See [PLAN.md](PLAN.md) — all design deliverables done; the on-chain testnet
broadcast is scaffolded in `proof/` and pending a funded testnet key (external
action, needs go-ahead).
