// HiveWorm — local Ed25519 identity
//
// The browser holds a single ed25519 keypair in localStorage. There is no
// password; if localStorage is wiped, the worm is gone. v1 accepts that
// risk in exchange for one-click play.
//
// The user can export `{ seedHex, exportedAt }` as JSON and import it
// later to restore the same worm.

import * as ed from 'https://unpkg.com/@noble/ed25519@2.1.0/index.js'
import { canonicalPayload, bytesToHex, hexToBytes } from './schema.js'

const STORAGE_KEY = 'hiveworm/identity/v1'

export class Identity {
  constructor (seedHex, publicKeyHex) {
    // seed is the 32-byte ed25519 secret seed. The "secret key" passed
    // to ed25519 sign() is just this seed; the library expands it
    // internally.
    this.seedHex = seedHex
    this.publicKeyHex = publicKeyHex
  }

  get pubkey () { return this.publicKeyHex }

  /**
   * Sign an entry. Mutates the entry by adding `signature` and returns it.
   */
  async sign (entry) {
    const payload = canonicalPayload(entry)
    const sig = await ed.signAsync(payload, hexToBytes(this.seedHex))
    entry.signature = bytesToHex(sig)
    return entry
  }

  toExport () {
    return {
      schema: 'hiveworm/identity-export/v1',
      seedHex: this.seedHex,
      publicKeyHex: this.publicKeyHex,
      exportedAt: Date.now()
    }
  }
}

/**
 * Generate a fresh identity. Persists it to localStorage.
 */
export async function generateIdentity () {
  const seed = new Uint8Array(32)
  crypto.getRandomValues(seed)
  const seedHex = bytesToHex(seed)
  const pub = await ed.getPublicKeyAsync(seed)
  const pubHex = bytesToHex(pub)
  const id = new Identity(seedHex, pubHex)
  saveIdentity(id)
  return id
}

/**
 * Load identity from localStorage. Returns null if not present or
 * malformed. Re-derives publicKeyHex from seed if missing.
 */
export async function loadIdentity () {
  let raw
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch (_) {
    return null
  }
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_) {
    return null
  }
  if (!parsed || typeof parsed.seedHex !== 'string' || parsed.seedHex.length !== 64) {
    return null
  }
  let pubHex = parsed.publicKeyHex
  if (typeof pubHex !== 'string' || pubHex.length !== 64) {
    const pub = await ed.getPublicKeyAsync(hexToBytes(parsed.seedHex))
    pubHex = bytesToHex(pub)
  }
  return new Identity(parsed.seedHex, pubHex)
}

export function saveIdentity (id) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      seedHex: id.seedHex,
      publicKeyHex: id.publicKeyHex,
      savedAt: Date.now()
    }))
  } catch (_) { /* private mode — ignore */ }
}

/**
 * Export to a downloaded JSON file. Browser-only (uses Blob + a tag).
 */
export function downloadBackup (id) {
  const blob = new Blob([JSON.stringify(id.toExport(), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const stub = id.publicKeyHex.slice(0, 8)
  a.download = `hiveworm-backup-${stub}.json`
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}

/**
 * Restore identity from an uploaded backup file. Returns the new
 * Identity (also persists it to localStorage). Replaces any existing
 * identity — caller should confirm with the user first.
 */
export async function importBackup (fileOrText) {
  let text
  if (typeof fileOrText === 'string') {
    text = fileOrText
  } else if (fileOrText && typeof fileOrText.text === 'function') {
    text = await fileOrText.text()
  } else {
    throw new Error('importBackup: need string or File')
  }
  const data = JSON.parse(text)
  if (!data || typeof data.seedHex !== 'string' || data.seedHex.length !== 64) {
    throw new Error('importBackup: bad backup file (missing or invalid seedHex)')
  }
  const pub = await ed.getPublicKeyAsync(hexToBytes(data.seedHex))
  const id = new Identity(data.seedHex, bytesToHex(pub))
  saveIdentity(id)
  return id
}

/**
 * Convenience: load or create. Returns { identity, fresh: true|false }.
 */
export async function loadOrCreate () {
  const existing = await loadIdentity()
  if (existing) return { identity: existing, fresh: false }
  const created = await generateIdentity()
  return { identity: created, fresh: true }
}
