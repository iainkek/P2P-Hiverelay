import test from 'brittle'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { mkdir, rm, writeFile } from 'fs/promises'
import { applyServicePluginsEnv } from '../../packages/core/config/loader.js'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-service-env-' + randomBytes(8).toString('hex'))
}

test('service plugins env: fleet selection is normalized and marked authoritative', (t) => {
  const overrides = {}
  applyServicePluginsEnv(overrides, ' Poker, outboxlog,POKER, storage-proof ')

  t.is(overrides.enableServices, true)
  t.alike(overrides.plugins, ['poker', 'outboxlog', 'storage-proof'])
  t.is(overrides._servicePluginsFromEnv, true)

  const empty = {}
  applyServicePluginsEnv(empty, undefined)
  applyServicePluginsEnv(empty, ' , ')
  t.alike(empty, {}, 'unset or empty env leaves persisted configuration authoritative')
})

test('service plugins env: fleet selection overrides stale persisted plugins', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  await writeFile(path.join(storage, 'services.json'), JSON.stringify({
    enabled: true,
    plugins: ['poker']
  }))

  const node = new RelayNode({
    storage,
    enableAPI: false,
    enableServices: true,
    plugins: ['poker', 'outboxlog', 'storage-proof'],
    _servicePluginsFromEnv: true
  })
  t.teardown(async () => {
    try { await node.store.close() } catch (_) {}
    await rm(storage, { recursive: true, force: true })
  })

  await node._loadServicesOverride()
  t.is(node.config.enableServices, true)
  t.alike(node.config.plugins, ['poker', 'outboxlog', 'storage-proof', 'vrf', 'arbitration', 'zk'])
  t.absent(node.config._servicePluginsFromEnv, 'private precedence marker is consumed before service startup')
})
