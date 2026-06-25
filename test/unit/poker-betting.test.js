import test from 'brittle'
import { playHand } from '../../packages/services/builtin/poker/money/betting.js'
import { reduce } from '../../packages/services/builtin/poker/money/reducer.js'

const cfg = (over = {}) => ({ seats: ['a', 'b'], stacks: { a: 100, b: 100 }, blinds: { sb: 1, bb: 2 }, button: 'a', ...over })

test('blinds posted + fold preflop ends the hand', (t) => {
  const r = playHand(cfg(), [{ seat: 'a', type: 'fold' }])
  t.is(r.illegal, null)
  t.alike(r.contributions, { a: 1, b: 2 })
  t.alike(r.folded, ['a'])
  t.is(r.complete, true)
  t.is(r.showdown, false)
})

test('limp-check down to showdown', (t) => {
  const acts = [
    { seat: 'a', type: 'call' }, { seat: 'b', type: 'check' }, // preflop (BB option checked)
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' }, // flop
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' }, // turn
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' } // river
  ]
  const r = playHand(cfg(), acts)
  t.is(r.illegal, null)
  t.alike(r.contributions, { a: 2, b: 2 })
  t.is(r.complete, true)
  t.is(r.showdown, true)
})

test('preflop raise + call, then check down', (t) => {
  const acts = [
    { seat: 'a', type: 'raise', amount: 6 }, { seat: 'b', type: 'call' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' }
  ]
  const r = playHand(cfg(), acts)
  t.is(r.illegal, null)
  t.alike(r.contributions, { a: 6, b: 6 })
  t.is(r.showdown, true)
})

test('flop bet, raise, call', (t) => {
  const acts = [
    { seat: 'a', type: 'call' }, { seat: 'b', type: 'check' }, // preflop → 2/2
    { seat: 'b', type: 'bet', amount: 5 }, { seat: 'a', type: 'raise', amount: 15 }, { seat: 'b', type: 'call' }, // flop
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' }, // turn
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' } // river
  ]
  const r = playHand(cfg(), acts)
  t.is(r.illegal, null)
  t.alike(r.contributions, { a: 17, b: 17 })
})

test('all-in preflop, called → showdown', (t) => {
  const r = playHand(cfg(), [{ seat: 'a', type: 'allin' }, { seat: 'b', type: 'call' }])
  t.is(r.illegal, null)
  t.alike(r.contributions, { a: 100, b: 100 })
  t.is(r.complete, true)
  t.is(r.showdown, true)
})

test('illegal: BB cannot act first preflop (out of turn)', (t) => {
  const r = playHand(cfg(), [{ seat: 'b', type: 'check' }])
  t.not(r.illegal, null)
  t.is(r.illegal.reason, 'OUT_OF_TURN')
})

test('illegal: raise below the minimum', (t) => {
  const r = playHand(cfg(), [{ seat: 'a', type: 'raise', amount: 3 }]) // raiseBy 1 < bb 2
  t.not(r.illegal, null)
  t.is(r.illegal.reason, 'BELOW_MIN_RAISE')
})

test('illegal: check facing a bet', (t) => {
  const r = playHand(cfg(), [{ seat: 'a', type: 'check' }]) // a owes 1 to the bb
  t.not(r.illegal, null)
  t.is(r.illegal.reason, 'CANNOT_CHECK_FACING_BET')
})

test('betting → reducer: contributions feed the settlement', (t) => {
  const card = (r, s = 0) => r * 4 + s
  const bet = playHand(cfg(), [
    { seat: 'a', type: 'raise', amount: 10 }, { seat: 'b', type: 'call' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' }
  ])
  t.is(bet.illegal, null)
  t.alike(bet.contributions, { a: 10, b: 10 })
  const session = {
    seats: ['a', 'b'],
    hands: [{
      handId: 'h1',
      board: [card(7, 0), card(3, 1), card(2, 2), card(0, 3), card(6, 0)],
      contributions: bet.contributions,
      folded: bet.folded,
      reveals: { a: [card(12, 0), card(12, 1)], b: [card(11, 0), card(11, 1)] } // a wins
    }]
  }
  const red = reduce(session)
  t.is(red.illegal, null)
  t.is(red.balances.a, 10)
  t.is(red.balances.b, -10)
})
