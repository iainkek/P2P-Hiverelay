// relay-table-client.js — browser client for the relay's poker table signed log.
//
// Lets the dashboard table act as a real seat: create/join a relay table, sign
// each action with the seat's ed25519 key, post it to the shared log, and read the
// log back so every seat renders the same game. Signing uses pure-JS ed25519 (noble,
// already served at /poker-engine for the mental-poker layer) — NOT WebCrypto — so the
// table runs over plain HTTP on a bare hiverelay, not just HTTPS/localhost. The signature
// is RFC 8032, byte-identical to what the relay's `sodium.crypto_sign_verify_detached`
// expects over the same `_canonicalEntry` bytes (proven against the live relay). Key
// randomness comes from crypto.getRandomValues which — unlike crypto.subtle — is available
// in an insecure context too, so no secure context is required anywhere in the flow.
//
// No bundler — same-origin ES module served via /poker-engine.

import { ed25519 } from '@noble/curves/ed25519.js'

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)))

// Deep key-sort for deterministic JSON — mirrors signed-log.js `_sortDeep`.
function sortDeep (v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(sortDeep)
  const out = {}
  for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k])
  return out
}

// The exact bytes the relay signs/verifies — mirrors signed-log.js `_canonicalEntry`.
export function canonicalBytes (entry) {
  return enc.encode([
    String(entry.tableKey).toLowerCase(),
    String(entry.writer).toLowerCase(),
    String(entry.seq),
    String(entry.ts),
    JSON.stringify(sortDeep(entry.payload === undefined ? null : entry.payload))
  ].join('\n'))
}

// A seat = an ed25519 keypair. `pub` (hex) is the writer id the relay knows.
export async function createSeat () {
  if (!globalThis.crypto || !crypto.getRandomValues) throw new Error('crypto.getRandomValues unavailable — no supported randomness source')
  // 32-byte ed25519 seed. randomSecretKey() draws from crypto.getRandomValues, which is
  // available in insecure (plain-HTTP) contexts too — no WebCrypto / secure context needed.
  const _key = ed25519.utils.randomSecretKey()
  const pub = hex(ed25519.getPublicKey(_key))
  const priv = hex(_key) // persist the raw seed (hex) across reloads
  return { pub, priv, _key }
}

// Restore a seat persisted via createSeat().priv (raw 32-byte seed, hex).
export async function restoreSeat (pub, privSeedHex) {
  const _key = unhex(privSeedHex)
  return { pub, priv: privSeedHex, _key }
}

// Sign a log entry body with the seat's key → returns body + hex signature.
// RFC 8032 detached signature (noble); the relay verifies it with sodium.
export async function signEntry (seat, body) {
  const sig = ed25519.sign(canonicalBytes(body), seat._key)
  return { ...body, signature: hex(sig) }
}

// Thin wrapper over the relay's /api/poker/* HTTP API. `base` is '' when the table
// is served by the relay (same-origin), or a full relay URL otherwise.
export class RelayTable {
  constructor (base = '') {
    this.base = base
    // Offset (ms) from this device's clock to the relay's, learned from the HTTP
    // `Date` header on every response. Entries carry a `ts` the relay rejects if it
    // is outside ±TS_SKEW_MS of *its* clock — so a player whose device clock is off
    // (no NTP, manual clock) would have every move rejected and could not play, and
    // their skewed clock would falsely fire the disconnect-forfeit deadline. Stamping
    // and comparing against relay time instead of Date.now() makes both skew-immune.
    this._clockOffset = 0
  }
  // Relay-synced wall clock. Use this for entry timestamps and for any deadline
  // compared against relay-issued timestamps, in place of Date.now().
  now () { return Date.now() + this._clockOffset }
  _syncClock (r) {
    try {
      const d = r && r.headers && r.headers.get && r.headers.get('date')
      if (!d) return
      const t = new Date(d).getTime()
      if (Number.isFinite(t)) this._clockOffset = t - Date.now()
    } catch { /* header unreadable — keep the last known offset */ }
  }
  async createTable (tableKey, writers) { return this._post('/api/poker/tables', { tableKey, writers }) }
  async postMove (tableKey, signedEntry) { return this._post(`/api/poker/${tableKey}/move`, signedEntry) }
  async readLog (tableKey, from = 0, limit = 500) { return this._get(`/api/poker/${tableKey}/log?from=${from}&limit=${limit}`) }
  async listTables () { return this._get('/api/poker/tables') }
  async _post (path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    this._syncClock(r)
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  async _get (path) {
    const r = await fetch(this.base + path)
    this._syncClock(r)
    return { status: r.status, json: await r.json().catch(() => null) }
  }
}
