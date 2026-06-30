// ed25519-noble.js — pure-JS ed25519 point + scalar ops, byte-identical to sodium's
// crypto_core_ed25519_* / crypto_scalarmult_ed25519_*. This is the browser backend
// for the poker mental-poker crypto: WebCrypto can sign/verify but exposes no raw
// point arithmetic, and sodium-javascript doesn't implement the ed25519 group ops,
// so the dealing protocol (threshold ElGamal + Chaum-Pedersen shares) runs on noble.
//
// Verified equivalent to sodium across a fuzz of base/point scalar-mults, additions,
// and scalar field ops — so a hand dealt/encrypted in the browser is decryptable +
// verifiable by the Node/relay sodium code and vice-versa.
//
// Scalars are 32-byte little-endian mod ℓ (sodium convention). Points are 32-byte
// compressed (RFC 8032). Inputs/outputs are Uint8Array.

import { ed25519 } from '@noble/curves/ed25519.js'

const Point = ed25519.Point
const Fn = Point.Fn // scalar field mod ℓ
export const SCALAR_BYTES = 32
export const POINT_BYTES = 32

const leToBig = (bytes) => { let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n }
const bigToLe = (n, len = 32) => { const out = new Uint8Array(len); for (let i = 0; i < len; i++) { out[i] = Number(n & 0xffn); n >>= 8n } return out }
const scalar = (b) => Fn.create(leToBig(b)) // reduce mod ℓ → field element (bigint)

// ── points ──
export function pointMulBase (kBytes) { return Point.BASE.multiply(scalar(kBytes)).toBytes() }
export function pointMul (kBytes, pBytes) { return Point.fromBytes(pBytes).multiply(scalar(kBytes)).toBytes() }
export function pointAdd (aBytes, bBytes) { return Point.fromBytes(aBytes).add(Point.fromBytes(bBytes)).toBytes() }
export function pointSub (aBytes, bBytes) { return Point.fromBytes(aBytes).subtract(Point.fromBytes(bBytes)).toBytes() }
export function isValidPoint (pBytes) {
  // On-curve + canonical (fromBytes) AND in the prime-order subgroup (isTorsionFree)
  // — the exact contract of sodium's crypto_core_ed25519_is_valid_point.
  if (!pBytes || pBytes.length !== POINT_BYTES) return false
  try { const P = Point.fromBytes(pBytes); return !P.is0() && P.isTorsionFree() } catch { return false }
}

// ── scalars (32-byte LE mod ℓ) ──
export function scalarRandom () {
  const buf = new Uint8Array(64); globalThis.crypto.getRandomValues(buf)
  return bigToLe(Fn.create(leToBig(buf))) // wide reduce → unbiased mod ℓ
}
export function scalarAdd (aBytes, bBytes) { return bigToLe(Fn.add(scalar(aBytes), scalar(bBytes))) }
export function scalarMul (aBytes, bBytes) { return bigToLe(Fn.mul(scalar(aBytes), scalar(bBytes))) }
export function scalarReduce (bytes) { return bigToLe(scalar(bytes)) }
