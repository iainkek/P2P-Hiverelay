// mp-reducer.js — canonical, cheat-aware reducer for one mp-table hand's relay log.
//
// This is the dispute / committee reference implementation. Given the signed append-only
// log for a hand, it reproduces the EXACT outcome the honest client settles to:
//   1. replay-verify every seat's shuffle against its pre-commitment — a substituted card,
//      a lie about the params, or a withheld reveal forfeits that seat;
//   2. replay the betting via the shared engine (createHand/applyAction) → contributions,
//      folded;
//   3. open the board + each live seat's hole cards from the public decryption shares;
//   4. settle via settleHand (the same primitive the client's showdown uses — proven to
//      agree, incl. uncalled-bet refunds and side pots).
//
// Because it uses the same primitives as the in-browser client, the cooperative settle
// and this dispute reducer agree by construction. A relay committee runs this over the
// canonical log, attests the resulting balances, and an honest player submits them to the
// escrow's disputeClose — so a player can CLAIM against a cheater, not just deny them.
import { dealStateFromLog, sharesForPosition, canonicalDeck, ctBytes, unhex } from './crypto/hand-deal-protocol.js'
import { verifyShuffle } from './crypto/reencrypt-shuffle.js'
import { dealLayout, openBoard } from './crypto/mental-deal.js'
import { decryptCard } from './crypto/elgamal-deck.js'
import { createHand, applyAction, view } from './money/betting.js'
import { settleHand } from './money/reducer.js'

const kindOf = (e) => (e.payload || e).kind
const payOf = (e) => e.payload || e

// Replay-verify every shuffle in seat order. Returns the first cheater (or a seat that
// withheld its reveal), else { cheater: null }.
export function verifyShufflesFromLog (log, writers, H) {
  const deck0 = canonicalDeck(H)
  const sEntries = log.filter(e => kindOf(e) === 'mp-shuffle')
  const reveals = {}
  for (const e of log) { if (kindOf(e) === 'shuffle-reveal') reveals[e.writer] = payOf(e) }
  const decks = [deck0]
  for (const se of sEntries) decks.push(payOf(se).deck.map(ctBytes))
  for (let i = 0; i < sEntries.length; i++) {
    const w = sEntries[i].writer
    const rev = reveals[w]
    if (!rev) return { cheater: w, reason: 'no-shuffle-reveal' }
    const r = verifyShuffle({
      input: decks[i], output: decks[i + 1], H,
      perm: rev.perm, rands: rev.rands.map(unhex), commitment: payOf(sEntries[i]).commit
    })
    if (!r.valid) return { cheater: w, reason: r.reason }
  }
  return { cheater: null, reason: null }
}

// Reduce one hand's log to canonical balances. `config` is the per-hand betting config the
// committee holds from table creation + prior hands: { seats, stacks, blinds:{sb,bb}, button }.
export function reduceMpHand (rawLog, writers, config) {
  const log = rawLog.map(e => ({ writer: e.writer, payload: e.payload || e, ts: e.ts }))
  const st = dealStateFromLog(log)
  const deck = st.deck, H = st.H
  const { hole, board } = dealLayout(writers.length)
  const pubBy = (w) => { const e = log.find(x => x.writer === w && kindOf(x) === 'mp-key'); return e ? unhex(payOf(e).pub) : null }

  // 1. shuffle integrity
  const { cheater, reason } = verifyShufflesFromLog(log, writers, H)

  // 2. replay betting → contributions + folded
  const S = createHand(config)
  for (const e of log) { const p = payOf(e); if (p.kind === 'bet-action' && !S.complete) applyAction(S, { seat: p.seat, type: p.type, amount: p.amount }) }
  const v = view(S)
  const contributions = v.contributions || {}
  const folded = new Set(v.folded || [])
  if (cheater) folded.add(cheater) // a cheat (or withheld reveal) forfeits the hand

  // 3. open the showdown from the public shares
  const live = writers.filter(w => !folded.has(w))
  const boardCards = board.map(pos => openBoard(deck[pos], sharesForPosition(log, pos, deck, pubBy)))
  const reveals = {}
  for (const w of live) {
    const i = writers.indexOf(w)
    reveals[w] = hole[i].map(pos => decryptCard(deck[pos], sharesForPosition(log, pos, deck, pubBy)))
  }

  // 4. settle — settleHand handles folded / uncontested / uncalled-bet refunds / side pots
  const r = settleHand({ board: boardCards, contributions, folded: [...folded], reveals }, new Set(writers))
  const net = r.net || {}
  const balances = {}
  for (const w of writers) balances[w] = (config.stacks && config.stacks[w] != null ? config.stacks[w] : 0) + (net[w] || 0)

  return { cheater, reason, net, balances, contributions, folded: [...folded], board: boardCards }
}
