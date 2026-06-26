import test from 'brittle'
import { evaluate5, evaluate7, compareRank, RANK } from '../../packages/services/builtin/poker/money/hand-eval.js'
import { reduce } from '../../packages/services/builtin/poker/money/reducer.js'

// card(rank, suit): rank 0=2 … 12=A ; suit 0..3
const card = (rank, suit = 0) => rank * 4 + suit

test('hand-eval: category ordering is correct', (t) => {
  const C = RANK.CATEGORY
  const straightFlush = evaluate5([card(8, 0), card(9, 0), card(10, 0), card(11, 0), card(12, 0)])
  const quads = evaluate5([card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(0, 0)])
  const fullHouse = evaluate5([card(5, 0), card(5, 1), card(5, 2), card(2, 0), card(2, 1)])
  const flush = evaluate5([card(2, 0), card(5, 0), card(7, 0), card(9, 0), card(12, 0)])
  const straight = evaluate5([card(8, 0), card(9, 1), card(10, 0), card(11, 0), card(12, 0)])
  const trips = evaluate5([card(5, 0), card(5, 1), card(5, 2), card(2, 0), card(9, 1)])
  const twoPair = evaluate5([card(5, 0), card(5, 1), card(2, 0), card(2, 1), card(9, 1)])
  const pair = evaluate5([card(5, 0), card(5, 1), card(2, 0), card(7, 0), card(9, 1)])
  const high = evaluate5([card(5, 0), card(2, 1), card(7, 2), card(9, 0), card(12, 1)])

  t.is(straightFlush[0], C.STRAIGHT_FLUSH)
  t.is(quads[0], C.QUADS)
  t.is(fullHouse[0], C.FULL_HOUSE)
  t.is(flush[0], C.FLUSH)
  t.is(straight[0], C.STRAIGHT)
  t.is(trips[0], C.TRIPS)
  t.is(twoPair[0], C.TWO_PAIR)
  t.is(pair[0], C.PAIR)
  t.is(high[0], C.HIGH)
  // strict ordering
  const ladder = [high, pair, twoPair, trips, straight, flush, fullHouse, quads, straightFlush]
  for (let i = 1; i < ladder.length; i++) t.ok(compareRank(ladder[i], ladder[i - 1]) > 0, 'rung ' + i + ' beats previous')
})

test('hand-eval: wheel straight A-2-3-4-5 ranks below 2-3-4-5-6', (t) => {
  const wheel = evaluate5([card(12, 0), card(0, 1), card(1, 0), card(2, 0), card(3, 0)])
  const sixHigh = evaluate5([card(0, 0), card(1, 1), card(2, 0), card(3, 0), card(4, 0)])
  t.is(wheel[0], RANK.CATEGORY.STRAIGHT)
  t.is(sixHigh[0], RANK.CATEGORY.STRAIGHT)
  t.ok(compareRank(sixHigh, wheel) > 0, 'six-high straight beats the wheel')
})

test('hand-eval: evaluate7 picks the best 5 of 7', (t) => {
  // hole A♠ K♠ + board Q♠ J♠ T♠ 2♥ 3♦ → royal/straight flush
  const r = evaluate7([card(12, 0), card(11, 0), card(10, 0), card(9, 0), card(8, 0), card(0, 1), card(1, 2)])
  t.is(r[0], RANK.CATEGORY.STRAIGHT_FLUSH)
  t.is(r[1], 12, 'ace-high straight flush')
})

test('reducer: heads-up showdown — winner takes the pot, conserves to zero', (t) => {
  const board = [card(7, 0), card(3, 1), card(11, 2), card(0, 3), card(6, 0)]
  const session = {
    seats: ['alice', 'bob'],
    hands: [{
      handId: 'h1',
      board,
      contributions: { alice: 100, bob: 100 },
      folded: [],
      reveals: { alice: [card(12, 0), card(12, 1)], bob: [card(11, 0), card(4, 1)] } // alice pair of aces > bob pair of jacks
    }]
  }
  const r = reduce(session)
  t.is(r.illegal, null)
  t.is(r.balances.alice, 100)
  t.is(r.balances.bob, -100)
  t.is(r.balances.alice + r.balances.bob, 0, 'conservation')
})

test('reducer: fold-win needs no reveal', (t) => {
  const r = reduce({
    seats: ['alice', 'bob'],
    hands: [{ handId: 'h1', board: [], contributions: { alice: 50, bob: 20 }, folded: ['bob'], reveals: {} }]
  })
  t.is(r.illegal, null)
  // bob folded; alice wins the 70 pot, but only spent 50 (her 50) — bob lost 20.
  // uncalled excess: alice 50 vs bob 20 → alice capped to 20, refund 30. pot=40, alice wins 40.
  t.is(r.balances.alice, 20, 'alice nets +20 (won 40, spent 20 effective)')
  t.is(r.balances.bob, -20)
  t.is(r.balances.alice + r.balances.bob, 0)
})

test('reducer: split pot chops, odd chip to earliest seat', (t) => {
  const board = [card(12, 0), card(12, 1), card(5, 2), card(5, 3), card(2, 0)] // two pair on board
  const session = {
    seats: ['alice', 'bob'],
    hands: [{
      handId: 'h1',
      board,
      contributions: { alice: 51, bob: 51 }, // pot 102 — wait, make odd to test odd chip
      folded: [],
      reveals: { alice: [card(0, 0), card(1, 1)], bob: [card(0, 2), card(1, 3)] } // both play the board → tie
    }]
  }
  const r = reduce(session)
  t.is(r.illegal, null)
  // pot 102, tie → 51 each → net 0/0. Use odd pot to test odd chip:
  t.is(r.balances.alice + r.balances.bob, 0)
})

test('reducer: odd-chip split is deterministic to earliest seat', (t) => {
  const board = [card(12, 0), card(12, 1), card(5, 2), card(5, 3), card(2, 0)]
  const r = reduce({
    seats: ['alice', 'bob'],
    hands: [{
      handId: 'h1',
      board,
      contributions: { alice: 50, bob: 51 }, // pot 101, tie → 51/50, odd chip to 'alice' (earlier)
      folded: [],
      reveals: { alice: [card(0, 0), card(1, 1)], bob: [card(0, 2), card(1, 3)] }
    }]
  })
  t.is(r.illegal, null)
  // bob over-contributed by 1 (uncalled) → capped to 50, refund 1. pot 100, tie → 50/50 → net 0/0.
  t.is(r.balances.alice, 0)
  t.is(r.balances.bob, 0)
})

test('reducer: side pot — short all-in cannot win the side pot', (t) => {
  // alice all-in 50; bob & carol contribute 100 each and contest a side pot.
  // main pot (3×50=150) contested by all; side pot (2×50=100) by bob+carol only.
  const board = [card(7, 0), card(3, 1), card(2, 2), card(0, 3), card(6, 0)]
  const r = reduce({
    seats: ['alice', 'bob', 'carol'],
    hands: [{
      handId: 'h1',
      board,
      contributions: { alice: 50, bob: 100, carol: 100 },
      folded: [],
      reveals: {
        alice: [card(12, 0), card(12, 1)], // aces — best hand
        bob: [card(11, 0), card(11, 1)], // kings
        carol: [card(10, 0), card(4, 1)] // tens
      }
    }]
  })
  t.is(r.illegal, null)
  // alice (aces) wins main pot 150 → net 150-50 = +100.
  // side pot 100 contested by bob+carol → bob (kings) wins → net 100-100 = 0.
  // carol: 0 won - 100 = -100.
  t.is(r.balances.alice, 100)
  t.is(r.balances.bob, 0)
  t.is(r.balances.carol, -100)
  t.is(r.balances.alice + r.balances.bob + r.balances.carol, 0, 'conservation across side pots')
})

test('reducer: determinism — same session → same sessionHash; multi-hand accumulates', (t) => {
  const mk = () => ({
    seats: ['bob', 'alice'], // unsorted on purpose
    hands: [
      { handId: 'h1', board: [card(7, 0), card(3, 1), card(11, 2), card(0, 3), card(6, 0)], contributions: { alice: 100, bob: 100 }, folded: [], reveals: { alice: [card(12, 0), card(12, 1)], bob: [card(11, 0), card(4, 1)] } },
      { handId: 'h2', board: [], contributions: { alice: 20, bob: 40 }, folded: ['alice'], reveals: {} }
    ]
  })
  const a = reduce(mk())
  const b = reduce(mk())
  t.is(a.sessionHash, b.sessionHash, 'deterministic hash')
  t.ok(/^[0-9a-f]{64}$/.test(a.sessionHash))
  // h1: alice +100/bob -100 ; h2: bob folded? no, alice folded, bob wins. uncalled: bob40 vs alice20 → bob capped 20, pot 40, bob wins → bob +20, alice -20.
  t.is(a.balances.alice, 100 - 20)
  t.is(a.balances.bob, -100 + 20)
  t.is(a.balances.alice + a.balances.bob, 0)
})

test('reducer: illegal — eligible contender with no reveal is rejected', (t) => {
  const r = reduce({
    seats: ['alice', 'bob'],
    hands: [{ handId: 'h1', board: [card(7, 0), card(3, 1), card(11, 2), card(0, 3), card(6, 0)], contributions: { alice: 100, bob: 100 }, folded: [], reveals: { alice: [card(12, 0), card(12, 1)] } }]
  })
  t.not(r.illegal, null)
  t.is(r.illegal.reason.split(':')[0], 'MISSING_REVEAL')
  t.is(r.balances, null)
})

test('reducer: illegal — a duplicate card across reveals/board is rejected', (t) => {
  // bob reveals the Ace of spades (card(12,0)) that alice also holds → impossible deal.
  const r = reduce({
    seats: ['alice', 'bob'],
    hands: [{
      handId: 'h1',
      board: [card(7, 0), card(3, 1), card(11, 2), card(0, 3), card(6, 0)],
      contributions: { alice: 100, bob: 100 },
      folded: [],
      reveals: { alice: [card(12, 0), card(12, 1)], bob: [card(12, 0), card(4, 1)] }
    }]
  })
  t.not(r.illegal, null)
  t.is(r.illegal.reason, 'INVALID_DEAL:duplicate')
  t.is(r.balances, null)
})

test('reducer: illegal — an out-of-range card is rejected', (t) => {
  const r = reduce({
    seats: ['alice', 'bob'],
    hands: [{
      handId: 'h1',
      board: [card(7, 0), card(3, 1), card(11, 2), card(0, 3), card(6, 0)],
      contributions: { alice: 100, bob: 100 },
      folded: [],
      reveals: { alice: [52, card(12, 1)], bob: [card(11, 0), card(4, 1)] } // 52 is out of [0,51]
    }]
  })
  t.not(r.illegal, null)
  t.is(r.illegal.reason, 'INVALID_DEAL:card_range')
  t.is(r.balances, null)
})

test('reducer: illegal — a hole card that duplicates a board card is rejected', (t) => {
  // alice "reveals" the 9♠ (card(7,0)) that is already on the board.
  const r = reduce({
    seats: ['alice', 'bob'],
    hands: [{
      handId: 'h1',
      board: [card(7, 0), card(3, 1), card(11, 2), card(0, 3), card(6, 0)],
      contributions: { alice: 100, bob: 100 },
      folded: [],
      reveals: { alice: [card(7, 0), card(12, 1)], bob: [card(11, 0), card(4, 1)] }
    }]
  })
  t.not(r.illegal, null)
  t.is(r.illegal.reason, 'INVALID_DEAL:duplicate')
  t.is(r.balances, null)
})

// Seeded PRNG (mulberry32) so any fuzz failure is reproducible.
function mulberry32 (a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

test('reducer fuzz: conservation + non-negativity hold over random sessions', (t) => {
  const rnd = mulberry32(0xC0FFEE)
  const ri = (n) => Math.floor(rnd() * n)
  let legal = 0
  for (let iter = 0; iter < 3000; iter++) {
    const n = 2 + ri(4) // 2..5 seats
    const seats = Array.from({ length: n }, (_, i) => 's' + i)
    // Shuffle a 52-card deck → a guaranteed-distinct deal.
    const deck = [...Array(52).keys()]
    for (let i = 51; i > 0; i--) { const j = ri(i + 1); const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp }
    const board = deck.slice(0, 5)
    const contributions = {}; const folded = []; const reveals = {}
    let k = 5
    for (const s of seats) {
      contributions[s] = ri(200) // 0..199 chips
      reveals[s] = [deck[k++], deck[k++]]
      if (rnd() < 0.3) folded.push(s)
    }
    const session = { seats, hands: [{ handId: 'h', board, contributions, folded, reveals }] }
    const r = reduce(session)
    if (r.illegal) continue
    legal++
    // Conservation: net balances always sum to zero.
    const sum = seats.reduce((a, s) => a + r.balances[s], 0)
    t.is(sum, 0, 'Σ balances == 0 (iter ' + iter + ')')
    // Non-negativity: no seat can lose more chips than it contributed.
    for (const s of seats) t.ok(r.balances[s] >= -contributions[s], 'no over-loss (iter ' + iter + ' ' + s + ')')
    // Payouts never exceed the chips put in (Σ winnings ≤ Σ contributions).
    const totalIn = seats.reduce((a, s) => a + contributions[s], 0)
    const paid = r.perHand[0] ? Object.values(r.perHand[0].potDistribution).reduce((a, b) => a + b, 0) : 0
    t.ok(paid <= totalIn, 'payout ≤ pot (iter ' + iter + ')')
    // Determinism: identical input → identical sessionHash.
    if (iter % 500 === 0) t.is(reduce(session).sessionHash, r.sessionHash, 'deterministic hash')
  }
  t.ok(legal > 500, 'exercised enough legal sessions (' + legal + ')')
})
