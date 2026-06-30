// mp-deal-driver.js — the deal-phase state machine for the multiplayer table.
//
// Both seats independently call nextDealAction(log, …) whenever the shared log
// changes; it returns the single payload this seat should post next (or null if it's
// waiting on someone else, or the deal is complete). The table UI just: poll log →
// nextDealAction → if non-null, sign+postMove → repeat. Pure + deterministic given the
// log, so both seats converge to the same deal without extra coordination.

import * as DK from './elgamal-deck.js'
import * as SH from './reencrypt-shuffle.js'
import * as MD from './mental-deal.js'
import * as P from './hand-deal-protocol.js'

// seat = { writer, x (ElGamal secret bytes) }; seats = ordered writer ids;
// mem = mutable scratch this seat keeps PRIVATE across calls (its shuffle params,
// kept for the showdown reveal). Returns { payload } to post, or null.
export function nextDealAction (log, seat, seats, mem) {
  mem.shuffles = mem.shuffles || {} // remember our own posted shuffle params
  const has = (w, kind) => log.some((e) => e.writer === w && (e.payload || e).kind === kind)
  const myIdx = seats.indexOf(seat.writer)

  // 1. publish my ElGamal pubkey, then wait for everyone's.
  if (!has(seat.writer, 'mp-key')) return P.msgKey(DK.seatPub(seat.x))
  if (!seats.every((w) => has(w, 'mp-key'))) return null

  // 2. seat[0] posts the canonical encrypted deck; others wait for it.
  const st = P.dealStateFromLog(log)
  const deckPosted = log.some((e) => (e.payload || e).kind === 'mp-deck')
  if (!deckPosted) {
    if (myIdx === 0) return P.msgDeck(P.canonicalDeck(st.H))
    return null
  }

  // 3. shuffles happen in seat order: seat[i] shuffles once exactly i shuffles exist.
  const shuffleCount = log.filter((e) => (e.payload || e).kind === 'mp-shuffle').length
  if (shuffleCount < seats.length) {
    if (shuffleCount === myIdx && !mem.shuffles.posted) {
      const pp = SH.randomShuffleParams(DK.DECK_SIZE)
      const deck = SH.applyShuffle(st.deck, st.H, pp.perm, pp.rands)
      mem.shuffles = { posted: true, perm: pp.perm, rands: pp.rands }
      return P.msgShuffle(deck, SH.commitShuffle(pp.perm, pp.rands))
    }
    return null // not my turn to shuffle yet
  }

  // 4. all shuffled → publish my decryption shares for OTHER seats' hole cards + the
  // whole board (one share per position, once). My own hole cards stay hidden until
  // showdown. Posts one share per call so each is an individual log move.
  const deck = st.deck
  const { hole, board } = MD.dealLayout(seats.length)
  const myShareDone = (pos) => log.some((e) => e.writer === seat.writer && (e.payload || e).kind === 'mp-share' && (e.payload || e).pos === pos)
  const owed = []
  seats.forEach((w, i) => { if (w !== seat.writer) for (const pos of hole[i]) owed.push(pos) }) // others' holes
  for (const pos of board) owed.push(pos) // board (everyone shares)
  for (const pos of owed) if (!myShareDone(pos)) return P.msgShare(pos, DK.decryptShare(seat.x, deck[pos].C1))

  return null // deal complete from my side
}

// Once nextDealAction returns null and all owed shares are present, the seat can read
// its private hole cards + the public board from the log.
export function readMyHand (log, seat, seats) {
  const st = P.dealStateFromLog(log)
  const deck = st.deck
  const { hole, board } = MD.dealLayout(seats.length)
  const myIdx = seats.indexOf(seat.writer)
  const pubBy = (w) => { const e = log.find((x) => x.writer === w && (x.payload || x).kind === 'mp-key'); return e ? P.unhex((e.payload || e).pub) : null }
  const myHole = hole[myIdx].map((pos) => MD.openCard(deck[pos], seat.x, P.sharesForPosition(log, pos, deck, pubBy)))
  const boardCards = board.map((pos) => MD.openBoard(deck[pos], P.sharesForPosition(log, pos, deck, pubBy)))
  return { hole: myHole, board: boardCards, ready: myHole.every((c) => c !== null) && boardCards.every((c) => c !== null) }
}
