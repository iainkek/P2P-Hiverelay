import test from 'brittle'
import { EventEmitter } from 'events'
import { SelfHeal } from 'p2p-hiverelay/core/relay-node/self-heal.js'

test('SelfHeal - never destroys an open connection from idle telemetry', (t) => {
  let destroyed = 0
  const connection = { destroy: () => { destroyed++ } }
  const node = {
    connections: new Map([[connection, { lastActivity: 0 }]])
  }
  const monitor = new EventEmitter()
  const selfHeal = new SelfHeal(node)
  const actions = []
  selfHeal.on('self-heal-action', action => actions.push(action))
  selfHeal.start(monitor)

  monitor.emit('health-warning', {
    check: 'stale-connections',
    staleCount: 1,
    totalConns: 1,
    stalePct: 100
  })

  t.is(destroyed, 0)
  t.is(actions.length, 1)
  t.is(actions[0].type, 'preserve-idle-connections')
  t.is(actions[0].destroyed, 0)
  selfHeal.stop()
})
