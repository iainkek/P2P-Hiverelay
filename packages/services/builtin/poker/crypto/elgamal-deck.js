// elgamal-deck.js — threshold-ElGamal card encryption for mental poker (browser).
//
// Cards are encoded as curve points and ElGamal-encrypted to the seats' JOINT public
// key H = ΣH_i. A ciphertext can only be decrypted by combining a decryption share
// from EVERY seat (each share proven correct via chaum-pedersen). To hand a hole card
// to one seat, the others publish their (proven) shares; that seat adds its own share
// and recovers the card — the others never see it (they each removed only their own
// layer). This is the privacy core; a verifiable re-encryption *shuffle* on top
// (hiding which card sits where) is the remaining protocol piece.
//
// Built on ed25519-noble (points) + chaum-pedersen-browser (proven shares); the curve,
// encodings, and proofs are wire-compatible with the Node/relay crypto.

import * as ed from './ed25519-noble.js'
import { shareFor, proveShareEquality, verifyShareEquality, publicFromSecret, baseG } from './chaum-pedersen-browser.js'

export const DECK_SIZE = 52
const scalarOfSmall = (n) => { const s = new Uint8Array(32); s[0] = n & 0xff; s[1] = (n >> 8) & 0xff; return s }

// Card i (0..51) ↦ the point (i+1)·G. Distinct, reversible via a tiny lookup table.
export function cardPoint (i) {
  if (!Number.isInteger(i) || i < 0 || i >= DECK_SIZE) throw new Error('elgamal-deck: bad card index ' + i)
  return ed.pointMulBase(scalarOfSmall(i + 1))
}
const _hex = (u) => { let s = ''; const a = new Uint8Array(u); for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0'); return s }
const _toIdx = (() => { const m = new Map(); for (let i = 0; i < DECK_SIZE; i++) m.set(_hex(cardPoint(i)), i); return m })()
export function pointToCard (P) { const i = _toIdx.get(_hex(P)); return i === undefined ? null : i }

// Joint public key from per-seat pubkeys (H = ΣH_i).
export function jointKey (pubkeys) {
  if (!pubkeys.length) throw new Error('elgamal-deck: no pubkeys')
  return pubkeys.reduce((acc, h) => (acc ? ed.pointAdd(acc, h) : h), null)
}
export function seatPub (x) { return publicFromSecret(x) }

// Encrypt card i to joint key H → ElGamal (C1 = r·G, C2 = M_i + r·H).
export function encryptCard (i, H, r) {
  r = r || ed.scalarRandom()
  return { C1: ed.pointMulBase(r), C2: ed.pointAdd(cardPoint(i), ed.pointMul(r, H)) }
}

// A seat's decryption share for a ciphertext (D = x·C1) + a proof it's honest.
export function decryptShare (x, C1) {
  const Y = publicFromSecret(x)
  const D = shareFor(x, C1)
  return { D, Y, proof: proveShareEquality({ x, Y, C1, D }) }
}

// Verify a published share is correct w.r.t. the seat's pubkey + this ciphertext.
export function verifyShare (Y, C1, share) {
  return verifyShareEquality({ Y, C1, D: share.D, A: share.proof.A, B: share.proof.B, z: share.proof.z }).valid
}

// Combine ALL seats' shares to recover the card: M = C2 − ΣD_i, then map → index.
// Returns null unless every seat's share is present (one missing → garbage point).
export function decryptCard ({ C1, C2 }, shares) {
  let acc = C2
  for (const D of shares) acc = ed.pointSub(acc, D)
  return pointToCard(acc)
}
