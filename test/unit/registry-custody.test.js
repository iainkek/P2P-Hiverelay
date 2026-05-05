import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { SeedingRegistry } from 'p2p-hiverelay/core/registry/index.js'
import { createCustodyNonServingProof, hashHex } from 'p2p-hiverelay/core/custody-signing.js'

function keyPair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function registryFixture () {
  const registry = new SeedingRegistry(null, null)
  const blocks = []
  registry.localLog = {
    async append (block) {
      blocks.push(JSON.parse(b4a.toString(block)))
    }
  }
  return { registry, blocks }
}

test('SeedingRegistry: custody quorum commit and source retirement', async (t) => {
  const { registry, blocks } = registryFixture()
  const publisher = keyPair()
  const relayA = keyPair()
  const relayB = keyPair()
  const observer = keyPair()
  const now = Date.now()
  const blindContentId = hashHex('blind-content')
  const ciphertextRoot = hashHex('ciphertext-root')
  const addressKey = hashHex('address-key')

  const intent = await registry.publishCustodyIntent({
    addressKey,
    blindContentId,
    ciphertextRoot,
    contentVersion: 3,
    requiredReplicas: 2,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher)

  t.is(blocks.length, 1, 'intent appended')

  await registry.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 3,
    retainUntil: now + 120_000,
    shardIds: [0]
  }, relayA)

  try {
    await registry.publishCustodyCommit({ intentId: intent.intentId }, publisher)
    t.fail('commit before quorum should fail')
  } catch (err) {
    t.ok(err.message.includes('quorum not reached'), 'commit before quorum is rejected')
  }

  await registry.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 3,
    retainUntil: now + 120_000,
    shardIds: [1]
  }, relayB)

  const status = registry.getCustodyStatus(intent.intentId)
  t.is(status.receiptCount, 2, 'two receipts indexed')
  t.is(status.quorumReached, true, 'quorum reached')

  const commit = await registry.publishCustodyCommit({ intentId: intent.intentId }, publisher)
  t.ok(commit.signature, 'commit signed')

  const retired = await registry.publishSourceRetired({ intentId: intent.intentId }, publisher)
  t.ok(retired.signature, 'source retirement signed')

  const proof = await registry.recordCustodyProof({
    intentId: intent.intentId,
    relayPubkey: b4a.toString(relayA.publicKey, 'hex'),
    challengeNonce: hashHex('challenge'),
    shardIds: [0],
    blockIndices: [0],
    passed: true,
    latencyMs: 25
  }, observer)
  t.ok(proof.signature, 'custody proof signed')

  const finalStatus = registry.getCustodyStatus(intent.intentId)
  t.is(finalStatus.committed, true, 'status reports committed')
  t.is(finalStatus.sourceRetired, true, 'status reports source retired')
  t.is(finalStatus.proofCount, 1, 'proof indexed')
  t.is(finalStatus.passingProofs, 1, 'passing proof counted')

  const nonServing = createCustodyNonServingProof({
    intentId: intent.intentId,
    addressKey,
    blindContentId,
    challengeNonce: hashHex('post-expiry-challenge'),
    retainUntil: now + 120_000,
    notServing: true,
    catalogPresent: false,
    activeSwarmServing: false
  }, relayA, { timestamp: now + 130_000 })
  await registry.recordCustodyNonServingProof(nonServing)

  const expiredStatus = registry.getCustodyStatus(intent.intentId)
  t.is(expiredStatus.nonServingProofCount, 1, 'non-serving proof indexed')
  t.alike(expiredStatus.nonServingRelays, [b4a.toString(relayA.publicKey, 'hex')], 'non-serving relay reported')
})

test('SeedingRegistry: custody commit becomes effective after out-of-order receipts arrive', async (t) => {
  const source = registryFixture().registry
  const target = registryFixture().registry
  const publisher = keyPair()
  const relayA = keyPair()
  const relayB = keyPair()
  const now = Date.now()
  const blindContentId = hashHex('out-of-order-blind')
  const ciphertextRoot = hashHex('out-of-order-ciphertext')

  const intent = await source.publishCustodyIntent({
    blindContentId,
    ciphertextRoot,
    contentVersion: 9,
    requiredReplicas: 2,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher)

  const receiptA = await source.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 9,
    retainUntil: now + 120_000
  }, relayA)

  const receiptB = await source.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 9,
    retainUntil: now + 120_000
  }, relayB)

  const commit = await source.publishCustodyCommit({ intentId: intent.intentId }, publisher)

  target._applyEntry(intent)
  target._applyEntry(commit)
  let status = target.getCustodyStatus(intent.intentId)
  t.is(status.committed, false, 'commit is indexed but not effective before receipts')
  t.ok(status.commitPendingReason, 'pending reason is exposed')

  target._applyEntry(receiptA)
  target._applyEntry(receiptB)
  status = target.getCustodyStatus(intent.intentId)
  t.is(status.quorumReached, true, 'quorum reached after receipts arrive')
  t.is(status.committed, true, 'previously indexed commit becomes effective')
})

test('SeedingRegistry: source retirement is immutable once recorded', async (t) => {
  const { registry } = registryFixture()
  const publisher = keyPair()
  const relay = keyPair()
  const nextAuthority = keyPair()
  const now = Date.now()
  const blindContentId = hashHex('immutable-retirement-blind')
  const ciphertextRoot = hashHex('immutable-retirement-ciphertext')

  const intent = await registry.publishCustodyIntent({
    blindContentId,
    ciphertextRoot,
    contentVersion: 1,
    requiredReplicas: 1,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher)
  await registry.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 1,
    retainUntil: intent.retainUntil
  }, relay)
  await registry.publishCustodyCommit({ intentId: intent.intentId }, publisher)

  const first = await registry.publishSourceRetired({ intentId: intent.intentId }, publisher)
  const second = await registry.publishSourceRetired({
    intentId: intent.intentId,
    nextAuthority: b4a.toString(nextAuthority.publicKey, 'hex')
  }, publisher)

  const status = registry.getCustodyStatus(intent.intentId)
  t.is(status.sourceRetirement.signature, first.signature, 'first retirement remains effective')
  t.not(status.sourceRetirement.signature, second.signature, 'later retirement cannot rewrite authority')
  t.is(status.sourceRetirement.nextAuthority, null, 'nextAuthority cannot be changed after retirement')
})

test('SeedingRegistry: witness tombstones require matching post-expiry non-serving proof', async (t) => {
  const { registry } = registryFixture()
  const publisher = keyPair()
  const relay = keyPair()
  const witness = keyPair()
  const now = Date.now()
  const addressKey = hashHex('witness-registry-address')
  const blindContentId = hashHex('witness-registry-blind')
  const ciphertextRoot = hashHex('witness-registry-ciphertext')

  const intent = await registry.publishCustodyIntent({
    addressKey,
    blindContentId,
    ciphertextRoot,
    contentVersion: 1,
    requiredReplicas: 1,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher)

  try {
    await registry.recordCustodyExpiryWitness({
      intentId: intent.intentId,
      timestamp: now + 130_000,
      relayPubkey: b4a.toString(relay.publicKey, 'hex'),
      nonServingProofHash: hashHex('missing-proof'),
      catalogPresent: false,
      gatewayServing: false,
      activeSwarmObserved: false
    }, witness)
    t.fail('witness without matching non-serving proof should fail')
  } catch (err) {
    t.ok(err.message.includes('matching non-serving proof'), 'witness without matching proof is rejected')
  }

  const nonServing = await registry.recordCustodyNonServingProof(createCustodyNonServingProof({
    intentId: intent.intentId,
    addressKey,
    blindContentId,
    retainUntil: intent.retainUntil,
    notServing: true,
    catalogPresent: false,
    activeSwarmServing: false
  }, relay, { timestamp: now + 130_000 }))

  try {
    await registry.recordCustodyExpiryWitness({
      intentId: intent.intentId,
      timestamp: now + 131_000,
      relayPubkey: b4a.toString(relay.publicKey, 'hex'),
      nonServingProofHash: hashHex(nonServing),
      catalogPresent: false,
      gatewayServing: true,
      activeSwarmObserved: false
    }, witness)
    t.fail('witness that observed gateway serving should fail')
  } catch (err) {
    t.ok(err.message.includes('active serving'), 'witness observing active serving is rejected')
  }

  const tombstone = await registry.recordCustodyExpiryWitness({
    intentId: intent.intentId,
    timestamp: now + 132_000,
    relayPubkey: b4a.toString(relay.publicKey, 'hex'),
    nonServingProofHash: hashHex(nonServing),
    catalogPresent: false,
    gatewayServing: false,
    activeSwarmObserved: false
  }, witness)

  const status = registry.getCustodyStatus(intent.intentId)
  t.ok(tombstone.signature, 'valid witness tombstone signed')
  t.is(status.expiryWitnessCount, 1, 'raw witness indexed')
  t.is(status.validExpiryWitnessCount, 1, 'valid witness counted')
})

test('SeedingRegistry: custodySnapshot rolls up aggregate state for dashboards', async (t) => {
  const { registry } = registryFixture()
  const publisher = keyPair()
  const relayA = keyPair()
  const relayB = keyPair()
  const observer = keyPair()
  const now = Date.now()

  // Empty registry → all zeros
  const empty = registry.custodySnapshot()
  t.is(empty.intents, 0, 'no intents')
  t.is(empty.committed, 0, 'no commits')
  t.is(empty.commitRate, null, 'commitRate null on empty registry')

  // Publish two intents — one will reach quorum + commit + proof, the other
  // stays at intent-only.
  const intentA = await registry.publishCustodyIntent({
    addressKey: hashHex('a'),
    blindContentId: hashHex('blind-a'),
    ciphertextRoot: hashHex('ct-a'),
    contentVersion: 1,
    requiredReplicas: 2,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher)

  await registry.publishCustodyIntent({
    addressKey: hashHex('b'),
    blindContentId: hashHex('blind-b'),
    ciphertextRoot: hashHex('ct-b'),
    contentVersion: 1,
    requiredReplicas: 2,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher)

  // Drive intentA to commit + proof
  await registry.recordCustodyReceipt({
    intentId: intentA.intentId,
    blindContentId: hashHex('blind-a'),
    ciphertextRoot: hashHex('ct-a'),
    contentVersion: 1,
    retainUntil: now + 120_000
  }, relayA)
  await registry.recordCustodyReceipt({
    intentId: intentA.intentId,
    blindContentId: hashHex('blind-a'),
    ciphertextRoot: hashHex('ct-a'),
    contentVersion: 1,
    retainUntil: now + 120_000
  }, relayB)
  await registry.publishCustodyCommit({ intentId: intentA.intentId }, publisher)
  await registry.recordCustodyProof({
    intentId: intentA.intentId,
    relayPubkey: b4a.toString(relayA.publicKey, 'hex'),
    challengeNonce: hashHex('nonce'),
    shardIds: [0],
    blockIndices: [0],
    passed: true,
    latencyMs: 5
  }, observer)

  const snap = registry.custodySnapshot()
  t.is(snap.intents, 2, 'two intents tracked')
  t.is(snap.withQuorum, 1, 'one with quorum reached')
  t.is(snap.committed, 1, 'one committed')
  t.is(snap.withProof, 1, 'one has at least one proof')
  t.is(snap.totalReceipts, 2, 'total receipts counted')
  t.is(snap.totalProofs, 1, 'total proofs counted')
  t.is(snap.commitRate, 0.5, 'commitRate = committed / intents')
})
