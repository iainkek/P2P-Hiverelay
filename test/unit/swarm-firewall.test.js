import test from 'brittle'
import b4a from 'b4a'
import { SwarmFirewall } from 'p2p-hiverelay/core/relay-node/swarm-firewall.js'

const PK_A = b4a.alloc(32, 0xaa)
const PK_B = b4a.alloc(32, 0xbb)
const PK_C = b4a.alloc(32, 0xcc)
const HEX_A = b4a.toString(PK_A, 'hex')
const HEX_B = b4a.toString(PK_B, 'hex')
const HEX_C = b4a.toString(PK_C, 'hex')

test('SwarmFirewall — accepts by default with no rules', (t) => {
  const fw = new SwarmFirewall()
  t.is(fw.check(PK_A, { remoteAddress: '1.2.3.4' }), false, 'accepts unknown peer')
  fw.destroy()
})

test('SwarmFirewall — blocklist rejects', (t) => {
  const fw = new SwarmFirewall({ blocklist: [HEX_A] })
  t.is(fw.check(PK_A, { remoteAddress: '1.2.3.4' }), true, 'rejects blocklisted')
  t.is(fw.check(PK_B, { remoteAddress: '1.2.3.4' }), false, 'accepts non-listed')
  const s = fw.stats()
  t.is(s.rejected, 1)
  t.is(s.byReason.blocklist, 1)
  fw.destroy()
})

test('SwarmFirewall — allowlist beats blocklist on same key', (t) => {
  const fw = new SwarmFirewall()
  fw.block(HEX_A)
  fw.allow(HEX_A) // should remove from blocklist
  t.is(fw.isBlocked(HEX_A), false, 'no longer blocked')
  t.is(fw.isAllowed(HEX_A), true)
  t.is(fw.check(PK_A, { remoteAddress: '1.2.3.4' }), false, 'allowed peer accepted')
  fw.destroy()
})

test('SwarmFirewall — allowlist short-circuits IP rate limit', (t) => {
  const fw = new SwarmFirewall({ allowlist: [HEX_A], ipMaxConnects: 1 })
  // First connect from IP — should accept and not consume the bucket for allowlisted
  fw.check(PK_A, { remoteAddress: '5.5.5.5' })
  fw.check(PK_A, { remoteAddress: '5.5.5.5' })
  fw.check(PK_A, { remoteAddress: '5.5.5.5' })
  // Now a non-allowlisted peer from same IP — should still get the IP's first slot
  t.is(fw.check(PK_B, { remoteAddress: '5.5.5.5' }), false, 'non-allowlisted gets first slot since allowlist did not consume')
  fw.destroy()
})

test('SwarmFirewall — IP rate limit rejects after threshold', (t) => {
  let now = 1_000_000
  const fw = new SwarmFirewall({ ipMaxConnects: 3, ipWindowMs: 10_000, now: () => now })
  t.is(fw.check(PK_A, { remoteAddress: '7.7.7.7' }), false)
  t.is(fw.check(PK_B, { remoteAddress: '7.7.7.7' }), false)
  t.is(fw.check(PK_C, { remoteAddress: '7.7.7.7' }), false)
  // 4th connect from same IP within window → reject
  t.is(fw.check(b4a.alloc(32, 0xdd), { remoteAddress: '7.7.7.7' }), true, 'rejects after 3')
  // Different IP: still allowed
  t.is(fw.check(PK_A, { remoteAddress: '8.8.8.8' }), false, 'different IP accepted')
  // After the window expires, rate clears
  now += 11_000
  t.is(fw.check(PK_A, { remoteAddress: '7.7.7.7' }), false, 'window expiry resets bucket')
  fw.destroy()
})

test('SwarmFirewall — reputation threshold rejects low scores', (t) => {
  const scores = { [HEX_A]: -2000, [HEX_B]: 50, [HEX_C]: null }
  const fw = new SwarmFirewall({
    minReputation: -1000,
    getReputationScore: (pk) => scores[pk]
  })
  t.is(fw.check(PK_A, { remoteAddress: '1.1.1.1' }), true, 'rejects -2000 (below -1000)')
  t.is(fw.check(PK_B, { remoteAddress: '1.1.1.1' }), false, 'accepts +50')
  t.is(fw.check(PK_C, { remoteAddress: '1.1.1.1' }), false, 'unknown reputation accepted')
  const s = fw.stats()
  t.is(s.byReason['low-reputation'], 1)
  fw.destroy()
})

test('SwarmFirewall — onReject fires with details', (t) => {
  const events = []
  const fw = new SwarmFirewall({
    blocklist: [HEX_A],
    onReject: (info) => events.push(info)
  })
  fw.check(PK_A, { remoteAddress: '9.9.9.9' })
  t.is(events.length, 1)
  t.is(events[0].reason, 'blocklist')
  t.is(events[0].pubkey, HEX_A)
  t.is(events[0].ip, '9.9.9.9')
  fw.destroy()
})

test('SwarmFirewall — stats track accept/reject totals', (t) => {
  const fw = new SwarmFirewall({ blocklist: [HEX_A] })
  fw.check(PK_A) // reject
  fw.check(PK_B) // accept
  fw.check(PK_C) // accept
  const s = fw.stats()
  t.is(s.accepted, 2)
  t.is(s.rejected, 1)
  fw.destroy()
})

test('SwarmFirewall — block/unblock/allow/unallow are mutually exclusive', (t) => {
  const fw = new SwarmFirewall()
  fw.block(HEX_A)
  t.is(fw.isBlocked(HEX_A), true)
  fw.unblock(HEX_A)
  t.is(fw.isBlocked(HEX_A), false)
  fw.allow(HEX_A)
  t.is(fw.isAllowed(HEX_A), true)
  fw.unallow(HEX_A)
  t.is(fw.isAllowed(HEX_A), false)
  fw.destroy()
})

test('SwarmFirewall — destroy clears interval', (t) => {
  const fw = new SwarmFirewall()
  t.ok(fw._cleanup, 'has cleanup interval')
  fw.destroy()
  t.is(fw._cleanup, null, 'interval cleared')
})

test('SwarmFirewall — null pubkey handled gracefully', (t) => {
  const fw = new SwarmFirewall({ blocklist: [HEX_A] })
  // No pubkey → cannot match block/allow lists, falls through to IP check
  t.is(fw.check(null, { remoteAddress: '3.3.3.3' }), false, 'accepts when no pubkey + no other rules trip')
  fw.destroy()
})
