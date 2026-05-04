# HiveRelay Plugin Handoff Artifacts

These artifacts preserve non-core product lines while keeping the default HiveRelay kernel focused.

Core kernel:

```text
always-on P2P availability
blind atomic custody
registry/discovery
gateway
proof/status APIs
operator health
```

Everything in this folder should be treated as plugin or profile work for future agents, not default relay scope.

## Packaging Rule

Each future plugin should ship with:

- package boundary,
- threat model,
- production readiness level,
- required config profile,
- tests,
- docs that clearly say whether it is experimental, beta, or production.

## Candidate Packages

| Package | Status | Why It Is Not Core |
|---|---|---|
| `hiverelay-plugin-ai` | experimental | Large SSRF, model isolation, GPU/operator trust surface |
| `hiverelay-plugin-zk-games` | experimental | Useful app primitive, but poker/card logic is app-specific |
| `hiverelay-plugin-sla-market` | experimental | Needs buyer/operator contracts, collateral, legal/economic model |
| `hiverelay-plugin-arbitration` | experimental | Governance/dispute process is a marketplace layer |
| `hiverelay-plugin-payments` | beta candidate | Billing matters, but core adoption should not require payments |
| `hiverelay-plugin-transports` | mixed | Tor/Holesail/WebSocket are adapters with separate support matrix |
| `hiverelay-dashboard-suite` | beta candidate | UI should consume live capabilities, not define product claims |
| `homehive-profile` | product profile | Valuable private profile, but not the public relay default |

## Agent Instruction

If you are picking up one of these artifacts:

1. Do not add it back to default relay startup.
2. Build it as an explicit plugin/profile.
3. Keep APIs behind declarative route authorization.
4. Add capability flags so the website/dashboard can label it truthfully.
5. Include a downgrade path if the plugin is absent.
