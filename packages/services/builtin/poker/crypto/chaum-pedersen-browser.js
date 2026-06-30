// chaum-pedersen-browser.js — browser port of poker/crypto/chaum-pedersen.js.
//
// Same scheme (Chaum-Pedersen proof of discrete-log equality: prove a decryption
// share D = C1^x is correct w.r.t. Y = G^x, without revealing x), but built on the
// noble backend (ed25519-noble.js + noble BLAKE2b) so it runs in the browser, where
// sodium's group ops aren't available. Wire-compatible with the Node/relay version:
// the Fiat-Shamir transcript, domain, hash (BLAKE2b-512 → reduce mod ℓ), and point
// encodings are identical, so a proof made here verifies there and vice-versa.

import { blake2b } from '@noble/hashes/blake2.js'
import * as ed from './ed25519-noble.js'

export const FS_DOMAIN = 'hiverelay/poker/chaum-pedersen/v1'
const enc = new TextEncoder()
const cat = (...arrs) => { const n = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length } return o }
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

// e = reduce_mod_ℓ( BLAKE2b-512( domain ‖ G ‖ Y ‖ C1 ‖ D ‖ A ‖ B ) ) — matches Node.
function fsChallenge (G, Y, C1, D, A, B) {
  const h = blake2b(cat(enc.encode(FS_DOMAIN), G, Y, C1, D, A, B), { dkLen: 64 })
  return ed.scalarReduce(h) // 64 bytes → scalar mod ℓ (LE)
}

export function baseG () { const one = new Uint8Array(32); one[0] = 1; return ed.pointMulBase(one) }
export function publicFromSecret (x) { return ed.pointMulBase(x) }
export function shareFor (x, C1) { return ed.pointMul(x, C1) } // decryption share D = C1^x

// Prove D = C1^x given Y = G^x. Returns { A, B, z } (commitments + response).
export function proveShareEquality ({ x, Y, C1, D, G } = {}) {
  G = G || baseG()
  const k = ed.scalarRandom()
  const A = ed.pointMulBase(k) // A = G^k
  const B = ed.pointMul(k, C1) // B = C1^k
  const e = fsChallenge(G, Y, C1, D, A, B)
  const z = ed.scalarAdd(k, ed.scalarMul(e, x)) // z = k + e·x  (mod ℓ)
  return { A, B, z }
}

// Verify: G^z == A·Y^e  AND  C1^z == B·D^e. Rejects degenerate/off-subgroup points.
export function verifyShareEquality ({ Y, C1, D, A, B, z, G } = {}) {
  G = G || baseG()
  for (const [name, p] of [['Y', Y], ['C1', C1], ['D', D], ['A', A], ['B', B]]) {
    if (!ed.isValidPoint(p)) return { valid: false, reason: 'invalid-point:' + name }
  }
  const e = fsChallenge(G, Y, C1, D, A, B)
  const ok1 = eqBytes(ed.pointMulBase(z), ed.pointAdd(A, ed.pointMul(e, Y)))
  const ok2 = eqBytes(ed.pointMul(z, C1), ed.pointAdd(B, ed.pointMul(e, D)))
  return { valid: ok1 && ok2, reason: ok1 && ok2 ? null : 'equation-mismatch' }
}
