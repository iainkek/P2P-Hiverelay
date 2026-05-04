#!/usr/bin/env node

import createTestnet from '@hyperswarm/testnet'
import { RelayNode } from '../packages/core/core/relay-node/index.js'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import { randomBytes } from 'crypto'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor (label, fn, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(250)
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

async function settleWithin (promise, ms) {
  try {
    await Promise.race([
      promise,
      new Promise(resolve => setTimeout(resolve, ms))
    ])
  } catch {}
}

async function fetchText (url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  const body = await res.text()
  return { status: res.status, body }
}

async function main () {
  const id = randomBytes(4).toString('hex')
  const baseDir = join(tmpdir(), `hiverelay-observe-${id}`)
  const basePort = 19400 + Math.floor(Math.random() * 500)
  const testnet = await createTestnet(3)
  const relays = []
  let publisher = null

  await mkdir(baseDir, { recursive: true })

  try {
    publisher = new RelayNode({
      storage: join(baseDir, 'publisher'),
      bootstrapNodes: testnet.bootstrap,
      enableAPI: false,
      enableRelay: false,
      enableSeeding: false,
      enableServices: false,
      shutdownTimeoutMs: 5000
    })
    await publisher.start()

    for (let i = 0; i < 3; i++) {
      const relay = new RelayNode({
        storage: join(baseDir, `relay-${i}`),
        bootstrapNodes: testnet.bootstrap,
        enableAPI: true,
        apiHost: '127.0.0.1',
        apiPort: basePort + i,
        enableRelay: true,
        enableSeeding: true,
        enableServices: false,
        acceptMode: 'open',
        shutdownTimeoutMs: 5000
      })
      await relay.start()
      relays.push(relay)
    }

    const drive = new Hyperdrive(publisher.store)
    await drive.ready()
    await drive.put('/hello.txt', b4a.from('Hello from HiveRelay observer testnet!'))
    await drive.put('/test.json', b4a.from(JSON.stringify({ id, kind: 'observer-testnet' })))
    await drive.put('/docs/readme.md', b4a.from('# Observer Test\n\nThis file should survive publisher shutdown.\n'))

    publisher.swarm.join(drive.discoveryKey, { server: true, client: true })
    await publisher.swarm.flush()

    const appKey = b4a.toString(drive.key, 'hex')
    const discoveryKey = b4a.toString(drive.discoveryKey, 'hex')

    for (let i = 0; i < relays.length; i++) {
      await relays[i].seedApp(appKey, {
        type: 'drive',
        name: 'Observer Test Drive',
        categories: ['testnet', 'files'],
        privacyTier: 'public'
      })
    }

    await waitFor('relay anchoring', async () => {
      return relays.every(relay => relay.appRegistry.get(appKey)?.anchored === true)
    }, 45_000)

    const beforePublisherStop = await fetchText(
      `http://127.0.0.1:${basePort}/v1/hyper/${appKey}/hello.txt`
    )

    await publisher.stop()
    publisher = null

    const afterPublisherStop = await fetchText(
      `http://127.0.0.1:${basePort + 1}/v1/hyper/${appKey}/docs/readme.md`
    )

    const catalogRes = await fetch(`http://127.0.0.1:${basePort}/catalog.json?pageSize=20`, {
      signal: AbortSignal.timeout(10_000)
    })
    const catalog = await catalogRes.json()

    const statuses = relays.map((relay, i) => {
      const stats = relay.getStats()
      const entry = relay.appRegistry.get(appKey)
      return {
        relay: i,
        port: basePort + i,
        publicKey: stats.publicKey,
        seededApps: stats.seededApps,
        connections: stats.connections,
        custody: relay.config.custody,
        catalogEntry: entry
          ? {
              type: entry.type,
              name: entry.name,
              blind: entry.blind,
              privacyTier: entry.privacyTier,
              anchored: entry.anchored,
              anchoredLength: entry.anchoredLength
            }
          : null
      }
    })

    console.log(JSON.stringify({
      ok: true,
      id,
      baseDir,
      basePort,
      appKey,
      discoveryKey,
      beforePublisherStop,
      afterPublisherStop,
      catalogCounts: catalog.count,
      catalogFirstEntry: catalog.entries?.[0] || null,
      statuses
    }, null, 2))
  } finally {
    if (publisher) {
      await settleWithin(publisher.stop(), 5000)
    }
    for (const relay of relays.reverse()) {
      await settleWithin(relay.stop(), 5000)
    }
    await settleWithin(testnet.destroy(), 5000)
    await rm(baseDir, { recursive: true, force: true })
  }
}

main().then(() => {
  process.exit(0)
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
