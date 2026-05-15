// hiverelay-dkg-v1 — Protomux channel for the M2 DKG ceremony and
// threshold decryption protocol.
//
// **STATUS: SCAFFOLD ONLY.** No working DKG yet. This file defines the
// wire-level message types and the channel handler shell so that
// downstream callers can begin integrating against a stable surface.
// The actual Pedersen DKG / threshold-ElGamal protocols are TODO and
// will be filled in over the next 8-12 weeks (Provable Custody Roadmap
// M2).
//
// **Why a separate channel from hiverelay-publish/custody:**
//   - The DKG ceremony has its own conversation pattern (round 1 commit,
//     round 2 share-broadcast, round 3 verify, optional complaint round).
//     Multiplexing that on the publish-channel's request/response shape
//     would force ugly state machines per request id.
//   - Threshold-decrypt is a long-lived MPC, not a one-shot SUBMIT.
//   - DKG ceremonies happen at pool-join time and at re-keying intervals,
//     orthogonal to per-drop custody flow.
//
// **Message types (placeholder — will likely change during M2 design):**
//
//   1 KEYGEN_ROUND_1_COMMIT
//     Each participant publishes a polynomial-coefficient commitment.
//     Body: { ceremonyId, fromIndex, commitments: [...] }
//
//   2 KEYGEN_ROUND_2_SHARE
//     Each participant sends an encrypted secret-share to every other
//     participant. Body: { ceremonyId, fromIndex, toIndex,
//     encryptedShare }
//
//   3 KEYGEN_ROUND_3_VERIFY_OR_COMPLAIN
//     Recipients verify their share against the round-1 commitments
//     and either ACK or COMPLAIN. Body: { ceremonyId, fromIndex,
//     complaints: [...] }
//
//   4 KEYGEN_FINAL
//     The aggregated joint pubkey, signed by the final participant set.
//     Body: { ceremonyId, jointPubkey, participants: [pubkey...] }
//
//   5 PARTIAL_DECRYPT_REQUEST
//     A recipient requests partial decryption of a per-drop ciphertext.
//     Body: { intentId, encryptedShareIndex, recipientPubkey,
//     authorizationSignature }
//
//   6 PARTIAL_DECRYPT_RESPONSE
//     A relay's partial decryption + zero-knowledge proof of correctness.
//     Body: { intentId, fromIndex, partial, proof }
//
// **Open design questions (to resolve during M2 implementation):**
//
//   - Pool key scope: per-app (Drop has its own pool key, isolated from
//     other HiveRelay apps) vs per-network (one global key). Per-app
//     gives a tighter trust boundary; per-network is simpler. Tentative:
//     per-app, with a default fallback for apps that don't bootstrap.
//
//   - Re-keying trigger: on membership change (relay joins/leaves), on
//     fixed interval (every N days), or both. Likely both, with the
//     interval set high enough that ceremony cost is amortized.
//
//   - Authorization for PARTIAL_DECRYPT_REQUEST: who can request a
//     partial? The recipient pubkey from the intent? A separately-signed
//     "claim authorization" from the publisher? This is the question
//     that bridges M1's binding-witness to M2's threshold release —
//     getting it wrong means a sender retaining K can still authorize
//     a second claim. M2 design must resolve this BEFORE any code lands.
//
//   - Mid-ceremony abort: if a relay drops mid-keygen, the rest must
//     abort cleanly without leaking partial shares. Need to define the
//     "ceremony failed" message and the participants' obligations to
//     destroy partial state.

import { EventEmitter } from 'events'
import Protomux from 'protomux'
import b4a from 'b4a'

export const DKG_PROTOCOL = 'hiverelay-dkg'
export const DKG_CHANNEL_ID = b4a.from('dkg-v1')

// Message-type enum — placeholder; will be finalized during M2.
export const DKG_MSG = {
  KEYGEN_ROUND_1_COMMIT: 1,
  KEYGEN_ROUND_2_SHARE: 2,
  KEYGEN_ROUND_3_VERIFY_OR_COMPLAIN: 3,
  KEYGEN_FINAL: 4,
  PARTIAL_DECRYPT_REQUEST: 5,
  PARTIAL_DECRYPT_RESPONSE: 6,
  CEREMONY_ABORT: 99
}

const MAX_MESSAGE_BYTES = 256 * 1024 // generous — share material is small but proofs can be larger

const encoding = {
  preencode (state, msg) {
    const json = JSON.stringify(msg)
    state.end += 4 + b4a.byteLength(json)
  },
  encode (state, msg) {
    const json = JSON.stringify(msg)
    const buf = b4a.from(json)
    state.buffer.writeUInt32BE(buf.length, state.start)
    buf.copy(state.buffer, state.start + 4)
    state.start += 4 + buf.length
  },
  decode (state) {
    const len = state.buffer.readUInt32BE(state.start)
    if (len > MAX_MESSAGE_BYTES) {
      state.start += 4 + len
      return { type: -1, error: 'message too large' }
    }
    const json = state.buffer.subarray(state.start + 4, state.start + 4 + len).toString()
    state.start += 4 + len
    try { return JSON.parse(json) } catch { return { type: -1, error: 'bad json' } }
  }
}

/**
 * Skeleton protocol handler for the M2 DKG channel. Today it just routes
 * messages to event-emitter events so external code can wire handlers.
 * The actual cryptography is TODO — see Provable Custody Roadmap §4.
 */
export class DkgProtocol extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.channels = new Map()
    // TODO: accept handler functions for each DKG_MSG type, the same way
    // PublishProtocol accepts onSubmitIntent etc.
  }

  attach (mux, remotePubkey) {
    mux = Protomux.from(mux)
    const key = b4a.isBuffer(remotePubkey) ? b4a.toString(remotePubkey, 'hex') : remotePubkey
    if (this.channels.has(key)) return false

    const channel = mux.createChannel({
      protocol: DKG_PROTOCOL,
      id: DKG_CHANNEL_ID,
      onopen: () => this.emit('channel-open', { remotePubkey: key }),
      onclose: () => this.channels.delete(key)
    })
    if (!channel) return false

    const msgHandler = channel.addMessage({
      encoding,
      onmessage: (msg) => this._onMessage(key, msgHandler, msg)
    })
    this.channels.set(key, { channel, msgHandler })
    channel.open()
    return true
  }

  _onMessage (remotePubkey, msgHandler, msg) {
    if (!msg || msg.type === -1) return
    // TODO: route by msg.type to keygen / partial-decrypt handlers.
    // For now we just re-emit so M2 protocol experiments can subscribe.
    this.emit('message', { remotePubkey, msg })
  }

  /**
   * Initiate a DKG ceremony among a set of participants. Returns a
   * Promise that resolves to the joint pubkey when the ceremony
   * completes, or rejects on abort/timeout.
   *
   * TODO M2: implement Pedersen DKG (or VSS variant). Reference impl
   * candidate: github.com/coinbase/kryptology (Go) or a JS port. The
   * tricky parts are:
   *   - Polynomial commitments using Pedersen vector commitments over
   *     Curve25519 (or Ristretto255 for cleaner edge cases).
   *   - Secret share distribution: each participant evaluates their
   *     polynomial at every other's index, encrypts to that recipient's
   *     long-term pubkey, broadcasts.
   *   - Verification: recipients verify their share against the public
   *     commitments using the homomorphic property. Mismatch → complaint
   *     round; persistent complaint → ceremony abort.
   *   - Final aggregation: each participant's secret-key share is the
   *     sum of all evaluations they received. Joint pubkey = sum of
   *     all participants' g^a0 commitments.
   */
  async initiateKeygen ({ participants, threshold, ceremonyId }) {
    throw new Error('DkgProtocol.initiateKeygen: not implemented (M2 TODO — see Provable Custody Roadmap §4)')
  }

  /**
   * Request a partial decryption of a ciphertext encrypted to the pool's
   * joint pubkey. Caller must supply an authorization signature proving
   * they're entitled to claim the underlying drop.
   *
   * TODO M2:
   *   - Define the authorization-signature format. Probably the
   *     publisher's signature over (intentId, recipientPubkey) using the
   *     authority key — but that means the publisher can authorize a
   *     SECOND claim post-retirement. To prevent, the authority must be
   *     destroyed cryptographically at retirement (the M1
   *     source-retired-witness primitive could be extended for this).
   *   - Implement threshold ElGamal partial decryption: each participant
   *     contributes a partial that the recipient combines via Lagrange
   *     interpolation. Each partial includes a zero-knowledge proof of
   *     correctness (NIZK over discrete log equality).
   */
  async requestPartialDecryption ({ intentId, ciphertext, authorization }) {
    throw new Error('DkgProtocol.requestPartialDecryption: not implemented (M2 TODO)')
  }

  /** Tear down all attached channels. */
  destroy () {
    for (const { channel } of this.channels.values()) {
      try { channel.close() } catch {}
    }
    this.channels.clear()
  }
}
