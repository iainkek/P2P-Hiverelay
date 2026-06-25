import test from 'brittle'
import { applyVerdict } from '../../packages/services/builtin/poker/money/arbitration-bridge.js'
import { reduce } from '../../packages/services/builtin/poker/money/reducer.js'

const card = (r, s = 0) => r * 4 + s

// alice & bob each commit 100; bob holds the better hand (kings vs queens).
function session () {
  return {
    seats: ['alice', 'bob'],
    hands: [{
      handId: 'h1',
      board: [card(7, 0), card(3, 1), card(2, 2), card(0, 3), card(6, 0)],
      contributions: { alice: 100, bob: 100 },
      folded: [],
      reveals: { alice: [card(10, 0), card(10, 1)], bob: [card(11, 0), card(11, 1)] } // bob (kings) > alice (queens)
    }]
  }
}

test('without a dispute, the better hand (bob) wins', (t) => {
  const r = reduce(session())
  t.is(r.illegal, null)
  t.is(r.balances.bob, 100)
  t.is(r.balances.alice, -100)
})

test('guilty verdict: the cheater forfeits, honest player wins the pot', (t) => {
  // alice accuses bob; relay committee resolves verdict='claimant' → bob cheated.
  const corrected = applyVerdict(session(), { respondent: 'bob', verdict: 'claimant', handId: 'h1' })
  t.alike(corrected.hands[0].folded, ['bob'])
  const r = reduce(corrected)
  t.is(r.illegal, null)
  t.is(r.balances.alice, 100, 'alice wins despite the worse hand — bob forfeited')
  t.is(r.balances.bob, -100)
  t.is(r.balances.alice + r.balances.bob, 0)
})

test('exonerating verdict leaves the session unchanged (bob still wins)', (t) => {
  const same = applyVerdict(session(), { respondent: 'bob', verdict: 'respondent' })
  const r = reduce(same)
  t.is(r.balances.bob, 100)
  t.is(r.balances.alice, -100)
})

test('verdict scoped to a different hand does not forfeit', (t) => {
  const corrected = applyVerdict(session(), { respondent: 'bob', verdict: 'claimant', handId: 'OTHER' })
  t.alike(corrected.hands[0].folded, []) // h1 untouched
})
