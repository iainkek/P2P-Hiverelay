// hiverelay-dkg state machine for M2.
//
// **STATUS: SCAFFOLD ONLY.** Defines the data shape relays will need to
// maintain for a long-lived threshold-DKG pool key, with stub methods
// where the cryptography goes. Real implementation is part of the
// 8-12-week M2 build.
//
// Per-relay state we need to persist:
//
//   - Our long-term DKG secret-key share (one scalar per active pool)
//   - The current joint pubkey (32 bytes; recipient encrypts against this)
//   - The participant set (relayPubkeys + their commitment shares from
//     the last successful keygen)
//   - The ceremony epoch (incremented on every re-keying)
//
// **Important durability constraint:** if a relay loses its share, it
// cannot participate in partial-decrypts. With t-of-n thresholds we
// tolerate up to n-t share losses, but operators must protect this state
// the same way they protect their relay pubkey secret. Suggested storage:
// the same Bare keystore the relay's own identity uses.
//
// **Lifecycle:**
//
//   - Pool join: relay participates in a new DKG ceremony with the
//     current pool members. On success, store its share + the new joint
//     pubkey. On failure, abort and retry on next ceremony tick.
//
//   - Pool leave (graceful): relay re-runs DKG with the remaining
//     members to derive a fresh joint key WITHOUT the leaver's share.
//     The leaver should destroy their share post-handoff.
//
//   - Pool leave (ungraceful, e.g. crash): periodic re-keying eventually
//     removes the absent relay from the participant set. Until then, the
//     absent share is unrecoverable but the pool still functions if
//     ≥ t remaining members are online.
//
//   - Rotation: every N days, members re-run DKG to produce a fresh
//     joint key. This is the forward-secrecy mechanism — a compromised
//     historical share can decrypt past intents bound to the OLD joint
//     key, but not future ones.

export const DKG_STATE_VERSION = 1

/**
 * Construct or load DKG state from durable storage.
 *
 * TODO M2: replace this stub with a real keystore-backed implementation.
 *
 * @param {Object} opts
 * @param {string} opts.storageDir - where to persist DKG shares
 * @param {Object} opts.relayKeyPair - relay's long-term Ed25519 identity
 * @returns {Promise<DkgState>}
 */
export async function openDkgState (opts) {
  // TODO M2: load from disk. For scaffolding we just return an empty in-memory state.
  return new DkgState(opts)
}

export class DkgState {
  constructor (opts) {
    this.storageDir = opts?.storageDir || null
    this.relayKeyPair = opts?.relayKeyPair || null
    this.activePool = null // { ceremonyEpoch, jointPubkey, secretKeyShare, participants, threshold }
    this.history = [] // prior pool states retained for as long as drops bound to them have intents alive
  }

  /**
   * Persist the active pool. TODO M2: durable write to keystore.
   */
  async save () {
    // no-op until M2 storage lands
  }

  /**
   * Get the joint pubkey clients should encrypt to. May be null if no
   * pool ceremony has succeeded yet (e.g. fresh relay before first
   * keygen).
   *
   * @returns {string|null} 64-char hex
   */
  jointPubkey () {
    return this.activePool?.jointPubkey ?? null
  }

  /**
   * Produce a partial decryption of a ciphertext under the current
   * pool's joint pubkey, given an authorization that proves the
   * requester is entitled to a partial.
   *
   * TODO M2: implement threshold-ElGamal partial decryption. Returns a
   * { partial, proof } pair the requester combines with t-1 other
   * partials via Lagrange interpolation.
   */
  async partialDecrypt (ciphertext, authorization) {
    throw new Error('DkgState.partialDecrypt: not implemented (M2 TODO)')
  }

  /**
   * Start a new keygen ceremony among the supplied participants. On
   * success, atomically swap activePool. On failure, leave activePool
   * untouched.
   *
   * TODO M2: implement Pedersen DKG.
   */
  async runKeygen ({ participants, threshold }) {
    throw new Error('DkgState.runKeygen: not implemented (M2 TODO)')
  }

  /**
   * Trigger a re-keying ceremony. Same as runKeygen but increments the
   * epoch and retires the previous pool's joint key. Old key remains
   * usable for partials on pre-rotation intents until those drops expire.
   *
   * TODO M2.
   */
  async rotate () {
    throw new Error('DkgState.rotate: not implemented (M2 TODO)')
  }
}
