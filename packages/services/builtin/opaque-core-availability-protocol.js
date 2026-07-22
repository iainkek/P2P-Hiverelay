let protocol
try {
  protocol = await import('p2p-hiverelay/core/protocol/opaque-core-availability.js')
} catch {
  protocol = await import('../../core/core/protocol/opaque-core-availability.js')
}

export const OPAQUE_CORE_PROOF_DOMAIN = protocol.OPAQUE_CORE_PROOF_DOMAIN
export const OPAQUE_CORE_PROTOCOL_VERSION = protocol.OPAQUE_CORE_PROTOCOL_VERSION
export const OPAQUE_CORE_REGISTER_DOMAIN = protocol.OPAQUE_CORE_REGISTER_DOMAIN
export const createOpaqueCoreRegistration = protocol.createOpaqueCoreRegistration
export const hashOpaqueCoreProof = protocol.hashOpaqueCoreProof
export const opaqueCoreProofBytes = protocol.opaqueCoreProofBytes
export const verifyOpaqueCoreAvailabilityProof = protocol.verifyOpaqueCoreAvailabilityProof
export const verifyOpaqueCoreRegistration = protocol.verifyOpaqueCoreRegistration
