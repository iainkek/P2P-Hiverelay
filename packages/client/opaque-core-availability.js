let protocol
try {
  protocol = await import('p2p-hiverelay/core/protocol/opaque-core-availability.js')
} catch {
  protocol = await import('../core/core/protocol/opaque-core-availability.js')
}

const { createOpaqueCoreRegistration, verifyOpaqueCoreAvailabilityProof } = protocol

export { createOpaqueCoreRegistration, verifyOpaqueCoreAvailabilityProof }

const SERVICE_NAME = 'opaque-core-availability'

export function createOpaqueCoreAvailabilityClient (relay, opts = {}) {
  if (!relay || typeof relay.callService !== 'function') {
    throw new Error('opaque-core availability requires relay.callService')
  }

  const call = (method, params) => relay.callService(SERVICE_NAME, method, params, opts.callOptions || {})

  return Object.freeze({
    register: (request) => call('register', request),
    status: (request) => call('status', request),
    async prove (challenge) {
      const response = await call('prove', challenge)
      if (!response || response.ok !== true) return response
      const valid = await verifyOpaqueCoreAvailabilityProof({
        response,
        challenge,
        relayPubkey: opts.relayPubkey,
        callerPubkey: opts.callerPubkey,
        verifierCore: opts.verifierCore
      })
      return valid ? response : { ok: false, code: 'BAD_PROOF' }
    }
  })
}
