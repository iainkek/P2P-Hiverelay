// mental-deal.js — orchestrates one mental-poker hand deal from the proven crypto
// primitives (elgamal-deck threshold encryption + reencrypt-shuffle). Browser-ready.
//
// Lifecycle (each step is posted to the relay's signed log by the seat that does it):
//   1. seats agree a joint ElGamal key H = ΣH_i (from per-seat keypairs)
//   2. buildEncryptedDeck(order, H) — encrypt the 52 cards (VRF order) to H
//   3. each seat applyShuffle()s in turn (reencrypt-shuffle) + commits — order hidden
//   4. positions are assigned: hole cards per seat, then the board
//   5. openCard() — to reveal a HOLE card to its owner, every OTHER seat publishes a
//      proven decryption share; the owner adds its own and recovers the card. Others
//      removed only their layer, so they never see it.
//   6. openBoard() — community cards: ALL seats publish shares → public reveal
//   7. showdown — owners publish their hole-card shares so everyone can reduce+settle
//
// This module is the deal engine; the relay-log coordination + betting (betting.js) +
// settlement (reducer.js → escrow) wrap around it.

import * as DK from './elgamal-deck.js'

// Encrypt the deck (an array of card indices, e.g. the VRF deck order) to joint key H.
export function buildEncryptedDeck (order, H) {
  if (!Array.isArray(order) || order.length !== DK.DECK_SIZE) throw new Error('mental-deal: order must be 52 card indices')
  return order.map((card) => DK.encryptCard(card, H))
}

// A seat's proven decryption share for one ciphertext (to publish to the log).
export function shareForCiphertext (seatSecret, ct) { return DK.decryptShare(seatSecret, ct.C1) }

// Verify a published share before trusting it (caller passes the seat's pubkey).
export function checkShare (seatPub, ct, share) { return DK.verifyShare(seatPub, ct.C1, share) }

// Reveal a HOLE card to its owner: owner combines its own share with the others'
// (already-verified) shares. Returns the card index (0..51), or null if a share is
// missing/wrong (privacy: an opponent holding only its own share gets null).
export function openCard (ct, ownerSecret, otherShareDs) {
  const own = DK.decryptShare(ownerSecret, ct.C1).D
  return DK.decryptCard(ct, [own, ...otherShareDs])
}

// Reveal a community/board card: combine every seat's share (no owner).
export function openBoard (ct, allShareDs) { return DK.decryptCard(ct, allShareDs) }

// Standard seat/board layout for an n-seat hand off the (post-shuffle) deck:
// 2 hole cards per seat dealt round-robin, then 5 board cards. Returns indices into
// the shuffled deck so seats agree which ciphertext is whose without revealing cards.
export function dealLayout (nSeats) {
  const hole = Array.from({ length: nSeats }, () => [])
  let p = 0
  for (let r = 0; r < 2; r++) for (let s = 0; s < nSeats; s++) hole[s].push(p++)
  const board = [p, p + 1, p + 2, p + 3, p + 4]
  return { hole, board }
}
