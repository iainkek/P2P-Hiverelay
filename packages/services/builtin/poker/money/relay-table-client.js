// relay-table-client.js — browser client for the relay's poker table signed log.
//
// Lets the dashboard table act as a real seat: create/join a relay table, sign
// each action with the seat's ed25519 key, post it to the shared log, and read the
// log back so every seat renders the same game. Signing uses native WebCrypto
// Ed25519 (available in any secure context — localhost dev + https prod); the
// canonical bytes match the relay's `_canonicalEntry` so `sodium.crypto_sign_-
// verify_detached` accepts them (proven against the live relay).
//
// No bundler, no vendored crypto — same-origin ES module served via /poker-engine.

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('')

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
  if (!globalThis.crypto || !crypto.subtle) throw new Error('WebCrypto unavailable — open over https or localhost')
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pub = hex(await crypto.subtle.exportKey('raw', kp.publicKey))
  // Export the private key so a seat can be persisted across reloads (PKCS8 hex).
  const priv = hex(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
  return { pub, priv, _key: kp.privateKey }
}

// Restore a seat persisted via createSeat().priv (PKCS8 hex).
export async function restoreSeat (pub, privPkcs8Hex) {
  const bytes = Uint8Array.from(privPkcs8Hex.match(/../g).map((h) => parseInt(h, 16)))
  const _key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'Ed25519' }, true, ['sign'])
  return { pub, priv: privPkcs8Hex, _key }
}

// Sign a log entry body with the seat's key → returns body + hex signature.
export async function signEntry (seat, body) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, seat._key, canonicalBytes(body))
  return { ...body, signature: hex(sig) }
}

// Thin wrapper over the relay's /api/poker/* HTTP API. `base` is '' when the table
// is served by the relay (same-origin), or a full relay URL otherwise.
export class RelayTable {
  constructor (base = '') { this.base = base }
  async createTable (tableKey, writers) { return this._post('/api/poker/tables', { tableKey, writers }) }
  async postMove (tableKey, signedEntry) { return this._post(`/api/poker/${tableKey}/move`, signedEntry) }
  async readLog (tableKey, from = 0, limit = 500) { return this._get(`/api/poker/${tableKey}/log?from=${from}&limit=${limit}`) }
  async listTables () { return this._get('/api/poker/tables') }
  async _post (path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  async _get (path) {
    const r = await fetch(this.base + path)
    return { status: r.status, json: await r.json().catch(() => null) }
  }
}
