# Phase 01 — FROZEN INTERFACES

The contract that 02–11 build against. Shapes are frozen; field *values* may be
refined but field *names/meaning* should not change without revisiting this ADR.
Hex = lowercase, no `0x` unless noted. Types are described language-neutrally
(JS objects on the wire / Solidity structs on-chain).

## EscrowDescriptor — the session channel definition
Created at table open, carried (hashed) into the first `stake` entry.
```
EscrowDescriptor {
  escrowId:      string   // = sessionHash-independent id, e.g. hex(sha256(asset||chainId||contractRef||sortedParticipants||nonce))
  asset:         { chainId, token }    // e.g. { chainId: 42161, token: "<USDT addr>" }  (USD₮ on an L2)
  contractRef:   string   // deployed escrow address (EVM) / program+PDA (Solana)
  participants:  Address[]            // on-chain settlement addresses, sorted
  pokerKeys:     { [Address]: hexEd25519 }  // binds each seat's poker pubkey ↔ settlement address
  threshold:     int                  // = participants.length (n-of-n cooperative close)
  committee:     hexPubkey[]          // HiveRelay attestor set for the dispute path
  committeeThreshold: int             // m-of-|committee| for a valid attestation
  bondPerSeat:   string   // min slashable bond ≥ max single-hand swing (uint, token base units)
  deposit:       { [Address]: string }// agreed session bankroll per seat
  openTxRef:     string   // funding/open tx reference
  expiry:        int      // ms epoch; after this, unilateral exit is always allowed
}
```

## escrowProof — proof a seat is funded (goes in the `stake` log entry)
```
escrowProof {
  escrowId:    string
  seat:        Address          // this player's settlement address
  pokerKey:    hexEd25519       // must match EscrowDescriptor.pokerKeys[seat]
  depositRef:  string           // tx/ledger ref or contract-balance proof
  bindingSig:  hex              // sig by the seat's settlement key over (escrowId||pokerKey||deposit) binding chain identity ↔ poker identity
}
```
Peers refuse to deal until every seat's `escrowProof` verifies (deposit present
on-chain + binding sig valid + amount ≥ descriptor).

## Attestation — HiveRelay's signed oracle of the canonical outcome (Phase 03)
The artifact the **dispute close** consumes. Must be cheap to verify on-chain.
```
Attestation {
  escrowId:     string
  sessionHash:  hex      // = Phase-02 reducer output over the whole session log
  outcome:      { [Address]: string }  // net final balances (settlement-address → token base units), sums to total escrow
  epoch:        int      // monotonic; replay/equivocation guard
  signers:      hexPubkey[]   // ⊆ committee, |signers| ≥ committeeThreshold
  sigs:         hex[]    // signatures over (escrowId||sessionHash||canonical(outcome)||epoch)
}
```
> **On-chain constraint (from DECISION):** the signature scheme is chosen in
> Phase 03 to be EVM-cheap — e.g. BLS aggregate (one pairing check) or a small
> committee of secp256k1 keys verified via `ecrecover`. The contract stores the
> committee root/set + `committeeThreshold`.

## Verdict — arbitration output (Phase 04), feeds an Attestation or a direct close
```
Verdict {
  escrowId:    string
  sessionHash: hex
  disputeType: 'missing-share' | 'invalid-share' | 'refused-reveal' | 'settle-divergence'
  payTo:       { [Address]: string }   // corrected balances
  slash:       { [Address]: string }   // bond to forfeit, by seat
  evidenceRef: string                  // signed-log index/proof of the offense
  committeeSig: Attestation            // a Verdict is enforceable iff wrapped in a valid Attestation
}
```

## Escrow contract interface (EVM reference; Solana program mirrors this)
```
open(EscrowDescriptor d)                                 // or constructor; records participants, committee, bonds, expiry
deposit(escrowId, amount)                                // each seat funds; USD₮ transferFrom
cooperativeClose(escrowId, balances[], sigs[])           // n-of-n sigs over balances → pay out, channel closed
disputeClose(escrowId, Attestation a)                    // verify committee m-of-n over (sessionHash,outcome) → pay outcome, slash bonds
unilateralExit(escrowId)                                 // after expiry or challenge window → return deposits/last-checkpointed balances
// events: Opened, Funded, Closed(kind), Slashed
```

### Invariants the contract MUST hold
- Conservation: every close pays out exactly the escrowed total (deposits + bonds).
- No freeze: `unilateralExit` is always eventually callable (liveness).
- One close: an escrowId can be closed once (cooperative XOR dispute XOR exit).
- Attestation anti-replay: reject `epoch` ≤ last seen for the escrowId.
- Slash bound: total slashed ≤ Σ bonds; slashed funds go to the wronged party
  (and/or burned per policy), never to the contract deployer.

## Reducer output contract (Phase 02 must produce)
```
reduce(sessionLog) → {
  sessionHash: hex,                    // deterministic over the whole session
  balances:    { [Address]: string },  // net, sums to escrow total
  perHand:     [{ handHash, winner, potDistribution }],  // audit detail
  illegal:     null | { reason, atIndex }    // non-null ⇒ log rejected
}
```
`Attestation.outcome` and `cooperativeClose.balances` are exactly
`reduce(sessionLog).balances`. This is the single source of truth both sides
recompute independently.
