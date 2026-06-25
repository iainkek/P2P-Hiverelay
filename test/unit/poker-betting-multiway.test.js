import test from 'brittle'
import { playHand } from '../../packages/services/builtin/poker/money/betting.js'
import { reduce } from '../../packages/services/builtin/poker/money/reducer.js'

const card = (r, s = 0) => r * 4 + s
const cfg = (over = {}) => ({ seats: ['a', 'b', 'c'], stacks: { a: 100, b: 100, c: 100 }, blinds: { sb: 1, bb: 2 }, button: 'a', ...over })

// 3-handed: button=a (UTG), SB=b, BB=c.
test('3-handed limp-check down to showdown', (t) => {
  const acts = [
    { seat: 'a', type: 'call' }, { seat: 'b', type: 'call' }, { seat: 'c', type: 'check' }, // preflop (BB option)
    { seat: 'b', type: 'check' }, { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' }, // flop
    { seat: 'b', type: 'check' }, { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' }, // turn
    { seat: 'b', type: 'check' }, { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' } // river
  ]
  const r = playHand(cfg(), acts)
  t.is(r.illegal, null)
  t.alike(r.contributions, { a: 2, b: 2, c: 2 })
  t.is(r.showdown, true)
})

test('3-handed: UTG raise, SB folds, BB calls, check down', (t) => {
  const acts = [
    { seat: 'a', type: 'raise', amount: 6 }, { seat: 'b', type: 'fold' }, { seat: 'c', type: 'call' }, // preflop
    { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' }, // flop (b folded; c then a)
    { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' }, // turn
    { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' } // river
  ]
  const r = playHand(cfg(), acts)
  t.is(r.illegal, null)
  t.alike(r.contributions, { a: 6, b: 1, c: 6 }) // b posted SB=1 then folded
  t.alike(r.folded, ['b'])
})

test('3-handed all-in side pot → betting feeds the reducer split', (t) => {
  // a short all-in (20); b & c continue and build a side pot.
  const acts = [
    { seat: 'a', type: 'allin' }, { seat: 'b', type: 'call' }, { seat: 'c', type: 'call' }, // preflop → all 20
    { seat: 'b', type: 'bet', amount: 30 }, { seat: 'c', type: 'call' }, // flop side pot
    { seat: 'b', type: 'check' }, { seat: 'c', type: 'check' }, // turn
    { seat: 'b', type: 'check' }, { seat: 'c', type: 'check' } // river
  ]
  const r = playHand(cfg({ stacks: { a: 20, b: 100, c: 100 } }), acts)
  t.is(r.illegal, null)
  t.alike(r.contributions, { a: 20, b: 50, c: 50 })
  t.is(r.showdown, true)

  // a (aces) wins the main pot; b (kings) beats c (queens) for the side pot.
  const session = {
    seats: ['a', 'b', 'c'],
    hands: [{
      handId: 'h1',
      board: [card(7, 0), card(3, 1), card(2, 2), card(0, 3), card(6, 0)],
      contributions: r.contributions,
      folded: r.folded,
      reveals: {
        a: [card(12, 0), card(12, 1)], // aces
        b: [card(11, 0), card(11, 1)], // kings
        c: [card(10, 0), card(10, 1)] // queens
      }
    }]
  }
  const red = reduce(session)
  t.is(red.illegal, null)
  // main pot 60 → a wins (net +40). side pot 60 → b wins (net +10). c net -50.
  t.is(red.balances.a, 40)
  t.is(red.balances.b, 10)
  t.is(red.balances.c, -50)
  t.is(red.balances.a + red.balances.b + red.balances.c, 0)
})

test('3-handed illegal: acting out of turn', (t) => {
  // UTG (a) acts first preflop; SB (b) jumping in is out of turn.
  const r = playHand(cfg(), [{ seat: 'b', type: 'call' }])
  t.not(r.illegal, null)
  t.is(r.illegal.reason, 'OUT_OF_TURN')
})
