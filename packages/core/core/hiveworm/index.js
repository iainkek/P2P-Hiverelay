/**
 * HiveWorm game module — public exports.
 *
 * The relay imports this for the /api/hiveworm/<biome>/* endpoints.
 * The browser bundle imports the same module for client-side state
 * derivation and optimistic UI.
 *
 * Same module, two runtimes — core property of the architecture.
 */

export {
  SCHEMAS,
  DIRECTIONS,
  DEFAULT_BIOME_CONFIG,
  isValidPubkey,
  isValidSignature,
  isValidNonce,
  isValidDirection,
  isValidBiomeKey,
  canonicalPayload,
  checkEnvelope,
  checkShape,
  isPlayerEntry
} from './schema.js'

export { WorldState } from './state.js'

export {
  verifySignature,
  preflightEntry,
  validateAgainstState,
  validateForAppend
} from './validate.js'

export { deriveState } from './derive.js'
