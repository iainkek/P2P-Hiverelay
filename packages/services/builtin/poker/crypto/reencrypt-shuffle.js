// reencrypt-shuffle.js — verifiable re-encryption shuffle for mental poker (browser).
//
// Each seat permutes the encrypted deck and re-encrypts every ciphertext to the joint
// key. Re-encryption (C1+sG, C2+sH) changes the randomness but PRESERVES the plaintext,
// so a shuffle can only reorder — never substitute a card. The fresh randomness makes
// outputs unlinkable to inputs, so after ≥1 honest seat shuffles, no one knows the
// position→card mapping until cards are threshold-decrypted (elgamal-deck.js).
//
// Cheat-evidence: a seat commits hash(perm‖rands) before play; at showdown it reveals
// them and anyone replays `applyShuffle` to confirm the posted output equals a genuine
// permutation+re-encryption of the input. A mismatch ⇒ that seat cheated ⇒ forfeit via
// the arbitration path. (A full ZK shuffle proof would make it cheat-proof *during*
// play; this reveal-and-replay model makes it cheat-evident at settlement.)

import * as ed from './ed25519-noble.js'
import { blake2b } from '@noble/hashes/blake2.js'

// Re-encrypt one ElGamal ciphertext to joint key H with fresh randomness s.
export function reEncrypt ({ C1, C2 }, H, s) {
  s = s || ed.scalarRandom()
  return { C1: ed.pointAdd(C1, ed.pointMulBase(s)), C2: ed.pointAdd(C2, ed.pointMul(s, H)) }
}

// Apply a shuffle: output[j] = reEncrypt(input[perm[j]], H, rands[j]). `perm` is a
// permutation of 0..n-1; `rands` are n per-card re-encryption scalars.
export function applyShuffle (deck, H, perm, rands) {
  if (perm.length !== deck.length || rands.length !== deck.length) throw new Error('reencrypt-shuffle: length mismatch')
  return perm.map((srcIdx, j) => reEncrypt(deck[srcIdx], H, rands[j]))
}

// Produce a random permutation + randomness for a deck of size n (a seat's secret).
export function randomShuffleParams (n) {
  const perm = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) { const r = ed.scalarRandom(); const jj = r[0] % (i + 1);[perm[i], perm[jj]] = [perm[jj], perm[i]] }
  const rands = Array.from({ length: n }, () => ed.scalarRandom())
  return { perm, rands }
}

// Commitment a seat posts before shuffling: hash(perm ‖ rands). Revealed at showdown.
export function commitShuffle (perm, rands) {
  const enc = new TextEncoder()
  const parts = [enc.encode(perm.join(','))]
  for (const r of rands) parts.push(r)
  const n = parts.reduce((s, a) => s + a.length, 0); const buf = new Uint8Array(n); let i = 0
  for (const p of parts) { buf.set(p, i); i += p.length }
  return Buffer.from(blake2b(buf, { dkLen: 32 })).toString('hex')
}

const eqPt = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const eqCt = (a, b) => eqPt(a.C1, b.C1) && eqPt(a.C2, b.C2)

// Replay-verify a revealed shuffle: recompute applyShuffle(input, H, perm, rands) and
// confirm it equals the posted output AND that the revelation matches its commitment.
// Returns { valid, reason }. A `false` here = the seat cheated (substituted a card).
export function verifyShuffle ({ input, output, H, perm, rands, commitment } = {}) {
  if (!Array.isArray(perm) || perm.length !== input.length) return { valid: false, reason: 'bad-perm' }
  const sorted = [...perm].sort((a, b) => a - b)
  if (sorted.some((v, i) => v !== i)) return { valid: false, reason: 'not-a-permutation' }
  if (commitment && commitShuffle(perm, rands) !== commitment) return { valid: false, reason: 'commitment-mismatch' }
  const recomputed = applyShuffle(input, H, perm, rands)
  for (let j = 0; j < output.length; j++) if (!eqCt(recomputed[j], output[j])) return { valid: false, reason: 'output-mismatch@' + j }
  return { valid: true, reason: null }
}
