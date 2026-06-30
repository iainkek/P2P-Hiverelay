import test from 'brittle'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import * as DK from '../../packages/services/builtin/poker/crypto/elgamal-deck.js'
import * as SH from '../../packages/services/builtin/poker/crypto/reencrypt-shuffle.js'
import * as MD from '../../packages/services/builtin/poker/crypto/mental-deal.js'
import * as P from '../../packages/services/builtin/poker/crypto/hand-deal-protocol.js'
import { createHand, applyAction, legalActions, view } from '../../packages/services/builtin/poker/money/betting.js'
import { reduce } from '../../packages/services/builtin/poker/money/reducer.js'
import { evaluate7, compareRank } from '../../packages/services/builtin/poker/money/hand-eval.js'

const rs = () => { const k = b4a.alloc(32); sodium.crypto_core_ed25519_scalar_random(k); return new Uint8Array(k) }

// Runs a complete 2-seat trustless hand over a signed-log message flow and returns the
// pieces under test. Both seats only ever derive state by replaying the shared `log`.
function playHand () {
  const A = { w: 'alice', x: rs() }, B = { w: 'bob', x: rs() }
  A.pub = DK.seatPub(A.x); B.pub = DK.seatPub(B.x)
  const pubBy = (w) => (w === 'alice' ? A.pub : B.pub)
  const log = []; const post = (w, payload) => log.push({ writer: w, payload })

  // deal
  post('alice', P.msgKey(A.pub)); post('bob', P.msgKey(B.pub))
  const H = P.dealStateFromLog(log).H
  post('alice', P.msgDeck(P.canonicalDeck(H)))
  let deck = P.dealStateFromLog(log).deck
  for (const s of [A, B]) { const pp = SH.randomShuffleParams(52); deck = SH.applyShuffle(deck, H, pp.perm, pp.rands); post(s.w, P.msgShuffle(deck, SH.commitShuffle(pp.perm, pp.rands))) }
  deck = P.dealStateFromLog(log).deck
  const { hole, board } = MD.dealLayout(2)
  for (const pos of hole[0]) post('bob', P.msgShare(pos, DK.decryptShare(B.x, deck[pos].C1)))
  for (const pos of hole[1]) post('alice', P.msgShare(pos, DK.decryptShare(A.x, deck[pos].C1)))
  for (const pos of board) { post('alice', P.msgShare(pos, DK.decryptShare(A.x, deck[pos].C1))); post('bob', P.msgShare(pos, DK.decryptShare(B.x, deck[pos].C1))) }
  const aHole = hole[0].map((pos) => MD.openCard(deck[pos], A.x, P.sharesForPosition(log, pos, deck, pubBy)))
  const bHole = hole[1].map((pos) => MD.openCard(deck[pos], B.x, P.sharesForPosition(log, pos, deck, pubBy)))

  // betting (check/call to showdown), replayed via betting.js
  let S = createHand({ seats: ['alice', 'bob'], stacks: { alice: 1000, bob: 1000 }, blinds: { sb: 10, bb: 20 }, button: 'alice' })
  let g = 0
  while (!S.complete && g++ < 80) { const v = view(S); const la = legalActions(S); const act = la.owe === 0 ? { type: 'check' } : { type: 'call' }; post(v.toAct, { kind: 'bet-action', seat: v.toAct, ...act }); applyAction(S, { seat: v.toAct, ...act }) }
  const v = view(S)

  // showdown: each posts its OWN hole shares → everyone opens both hands + board
  for (const pos of hole[0]) post('alice', P.msgShare(pos, DK.decryptShare(A.x, deck[pos].C1)))
  for (const pos of hole[1]) post('bob', P.msgShare(pos, DK.decryptShare(B.x, deck[pos].C1)))
  const aShown = hole[0].map((pos) => DK.decryptCard(deck[pos], P.sharesForPosition(log, pos, deck, pubBy)))
  const bShown = hole[1].map((pos) => DK.decryptCard(deck[pos], P.sharesForPosition(log, pos, deck, pubBy)))
  const boardShown = board.map((pos) => MD.openBoard(deck[pos], P.sharesForPosition(log, pos, deck, pubBy)))

  const red = reduce({ seats: ['alice', 'bob'], hands: [{ handId: 'h1', board: boardShown, contributions: v.contributions, folded: [...(v.folded || [])], reveals: { alice: aShown, bob: bShown } }] })
  return { aHole, bHole, aShown, bShown, boardShown, complete: S.complete, contributions: v.contributions, red, A, B, deck, hole, log, pubBy }
}

test('mental-poker deal gives each seat private hole cards (opponent cannot see them)', (t) => {
  const h = playHand()
  t.is(h.aHole.filter((c) => c !== null).length, 2, 'alice holds 2 cards')
  t.is(h.bHole.filter((c) => c !== null).length, 2, 'bob holds 2 cards')
  // from the log, bob with only its own shares cannot open alice's hole cards
  const bSpies = h.hole[0].map((pos) => DK.decryptCard(h.deck[pos], P.sharesForPosition(h.log.filter((e) => e.writer === 'bob'), pos, h.deck, h.pubBy)))
  t.ok(bSpies.every((c) => c === null), "bob cannot reconstruct alice's hole cards")
})

test('full hand: deal → bet → showdown → settle is consistent + zero-sum + pays the winner', (t) => {
  const h = playHand()
  t.ok(h.complete, 'betting reaches showdown')
  t.alike(h.aShown, h.aHole, 'alice showdown matches what she privately held')
  t.alike(h.bShown, h.bHole, 'bob showdown matches what he privately held')
  const all = [...h.aShown, ...h.bShown, ...h.boardShown]
  t.is(new Set(all).size, 9, 'all 9 cards distinct (one verifiable deck)')
  t.absent(h.red.illegal, 'reducer accepts the revealed hand')
  const net = h.red.balances
  t.is(net.alice + net.bob, 0, 'settlement is zero-sum')
  const cmp = compareRank(evaluate7([...h.aShown, ...h.boardShown]), evaluate7([...h.bShown, ...h.boardShown]))
  if (cmp > 0) t.ok(net.alice > 0, 'better hand (alice) wins the pot')
  else if (cmp < 0) t.ok(net.bob > 0, 'better hand (bob) wins the pot')
  else t.ok(net.alice === 0 && net.bob === 0, 'tie splits the pot')
})
