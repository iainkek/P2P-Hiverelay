// hand-deal-protocol.js — the mental-poker deal as a sequence of signed-log messages.
//
// Each seat posts these payloads to the relay table's signed log (via relay-table-
// client); every seat replays the log to reach the SAME deal state. Points/ciphertexts
// are hex so the payloads are JSON (what the log carries). Pure + browser-ready.
//
// Flow: mp-key (each seat's ElGamal pubkey) → mp-deck (canonical encrypted deck) →
// mp-shuffle ×N (each seat re-encrypt-shuffles + commits) → mp-share (decryption shares
// for opponents' hole/board cards). betting.js actions + showdown reveals interleave
// on the same log; the reducer settles from the revealed cards.

import * as DK from './elgamal-deck.js'
import * as SH from './reencrypt-shuffle.js'

const hex = (u) => { let s = ''; const a = new Uint8Array(u); for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0'); return s }
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)))
const ctHex = (ct) => ({ C1: hex(ct.C1), C2: hex(ct.C2) })
const ctBytes = (c) => ({ C1: unhex(c.C1), C2: unhex(c.C2) })

// ── message builders (payloads for the signed log) ──
export const msgKey = (pub) => ({ kind: 'mp-key', pub: hex(pub) })
export const msgDeck = (deck) => ({ kind: 'mp-deck', deck: deck.map(ctHex) })
export const msgShuffle = (deck, commit) => ({ kind: 'mp-shuffle', deck: deck.map(ctHex), commit })
export const msgShare = (pos, share) => ({ kind: 'mp-share', pos, D: hex(share.D), A: hex(share.proof.A), B: hex(share.proof.B), z: hex(share.proof.z) })

// Canonical starting deck: card i at position i, encrypted to H with a FIXED public
// randomness (the order is public until the shuffles hide it). Both seats compute the
// identical deck, so it needs no posting/trust — anyone can verify it.
export function canonicalDeck (H) {
  const one = new Uint8Array(32); one[0] = 1
  return Array.from({ length: DK.DECK_SIZE }, (_, i) => DK.encryptCard(i, H, one))
}

// Replay the log into deal state. `seatPubs` is writer→ElGamal-pubkey (from mp-key).
// Returns { H, deck } where deck is the final shuffled, encrypted deck both seats agree on.
export function dealStateFromLog (entries) {
  const keys = []
  let deck = null
  for (const e of entries) {
    const p = e.payload || e
    if (p.kind === 'mp-key') keys.push(unhex(p.pub))
    else if (p.kind === 'mp-deck') deck = p.deck.map(ctBytes)
    else if (p.kind === 'mp-shuffle') deck = p.deck.map(ctBytes)
  }
  const H = keys.length ? DK.jointKey(keys) : null
  return { H, deck, seatKeys: keys }
}

// Collect verified decryption shares for a position from the log (others' shares).
export function sharesForPosition (entries, pos, deck, seatPubByWriter) {
  const out = []
  for (const e of entries) {
    const p = e.payload || e
    if (p.kind !== 'mp-share' || p.pos !== pos) continue
    const ct = deck[pos]
    const share = { D: unhex(p.D), proof: { A: unhex(p.A), B: unhex(p.B), z: unhex(p.z) } }
    const pub = seatPubByWriter ? seatPubByWriter(e.writer) : null
    if (!pub || DK.verifyShare(pub, ct.C1, share)) out.push(share.D)
  }
  return out
}

export { ctHex, ctBytes, hex, unhex }
