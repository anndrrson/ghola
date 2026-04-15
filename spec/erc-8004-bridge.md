# ERC-8004 Bridge Spec

**Status:** Draft v0.1
**Author:** Ghola Protocol
**Last updated:** 2026-04-14

## Summary

[ERC-8004 (Trustless Agents)](https://eips.ethereum.org/EIPS/eip-8004) defines
three Ethereum-side registries — **identity**, **reputation**, and
**validation** — for autonomous agents. Ghola implements equivalent
primitives natively on Solana through the **SAID protocol**. This document
specifies the canonical mapping between the two so any agent that resolves
ERC-8004 records can also resolve a Ghola identity, and vice versa.

The goal is **cross-chain interoperability without forcing Ghola onto
Ethereum**. Ghola stays Solana-native; ERC-8004 clients gain Ghola
discoverability through a thin attestation/mirror layer.

## Why this exists

The agent economy is multi-chain. ERC-8004 is the emerging Ethereum standard;
SAID is Ghola's Solana-native equivalent. Without a bridge:

- Ethereum-side agents can't discover Ghola merchants.
- Solana-side agents can't verify Ethereum-side reputation.
- Both ecosystems re-implement the same primitives.

This spec lets a single agent have one canonical identity that both worlds
can resolve.

## Registry mapping

| ERC-8004 concept | SAID equivalent | Notes |
|---|---|---|
| `IdentityRegistry` | `said_registry` Solana program | Same data model: authority, master pubkey, did:key, profile URI, lifecycle flags |
| `ReputationRegistry` | `said-cloud` reputation scores + on-chain attestations | Composite score: transactions, reviews, uptime |
| `ValidationRegistry` | UCAN delegation chains | Capability proofs replace per-claim validators |
| Agent ID (DID) | `did:key:z…` (ed25519) | Identical format; SAID extends with `did:said:…` for multi-key roots |
| Profile URI | `profile_uri` field on IdentityRecord | Resolves to a JSON document; same shape on both chains |
| Service offering | `service_listings` table + agents.txt | Equivalent semantics |

## Identity field mapping

```text
ERC-8004 IdentityRegistry.Agent
├── agentId           ──→  SAID IdentityRecord.did_key
├── controller        ──→  SAID IdentityRecord.authority
├── profileURI        ──→  SAID IdentityRecord.profile_uri
└── status            ──→  SAID IdentityRecord.active
```

## Profile document schema

The JSON document at `profileURI` (ERC-8004) and `profile_uri` (SAID) MUST
share the following minimum fields, so a single document satisfies both
specs:

```json
{
  "@context": ["https://w3id.org/did/v1", "https://ghola.xyz/ns/agent/v1"],
  "id": "did:key:z6MkrJVnaZkeFzdQOGOu7TtVQiCvZ8eRrAY3jB5jPGmCkZjp",
  "name": "Helpful Agent",
  "description": "An agent that helps people.",
  "endpoints": {
    "agentsTxt": "https://agent.example.com/.well-known/agents.txt",
    "x402Gateway": "https://gateway.ghola.xyz/m/example/",
    "mcpServer": "https://mcp.example.com/sse"
  },
  "chains": [
    {
      "name": "solana:mainnet",
      "registry": "3EqrapHPPQqQKeB3aykZz9AbppMBzbY9PG1fT3PA7QyR",
      "wallet": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
    },
    {
      "name": "eip155:1",
      "registry": "0x...",
      "wallet": "0x..."
    }
  ],
  "capabilities": ["x402", "mcp", "ucan"],
  "reputation": {
    "ghola": "https://ghola.xyz/api/v1/reputation/<did>",
    "erc8004": "0x..."
  }
}
```

## Resolution flow

### Ethereum-side client resolving a Ghola identity

1. Client fetches `ERC-8004 IdentityRegistry` entry.
2. Reads `profileURI` → fetches JSON document.
3. Document includes `chains[].name == "solana:mainnet"` with a SAID registry
   address.
4. Client (optionally) confirms the SAID record is active by querying the
   Solana program directly.

### Solana-side client resolving an ERC-8004 identity

1. Client fetches `said_registry` `IdentityRecord` by DID.
2. Reads `profile_uri` → fetches JSON document.
3. Document includes `chains[].name == "eip155:1"` with an ERC-8004 registry
   address.
4. Client (optionally) confirms the ERC-8004 record matches via Ethereum
   RPC.

The profile document is the single source of cross-chain truth. Each chain's
on-chain record is authoritative for its own chain only.

## Reputation portability

Reputation scores DO NOT cross-chain automatically. Each chain's reputation
registry remains the authority for actions on that chain. A bridge contract
MAY mirror scores in either direction, but consumers SHOULD treat
mirrored scores as advisory.

The profile document's `reputation` field provides URL endpoints for both
chains' reputation services. Clients fetch the relevant one for their
chain of action.

## Validation / capabilities

ERC-8004 validation registries store per-claim validators. SAID uses UCAN
delegation chains for the same purpose. The bridge maps:

- ERC-8004 validation claim ↔ UCAN attestation token
- Validator address ↔ UCAN issuer DID
- Claim signature ↔ UCAN signature

A UCAN issued by a Ghola identity SHOULD be acceptable as an ERC-8004
validation claim if the validator has a corresponding ERC-8004 identity
registered.

## Open questions

1. **Mirroring frequency.** Do we run a mirror oracle that posts SAID
   reputation snapshots to ERC-8004 hourly? Or strictly on-demand?
2. **Identity collisions.** If the same DID is registered on both chains
   with different `authority` values, which is canonical?
3. **Slashing / revocation propagation.** A revocation on one chain
   should signal the other. How fast?

## Reference implementation

A reference bridge mirror oracle is planned at
`crates/said-erc8004-bridge/`. It will:

- Listen for `IdentityRegistry` events on Ethereum.
- Map them to SAID profile lookups.
- (Optional) Mirror SAID reputation deltas to ERC-8004 attestations.

## Status & next steps

This spec is **descriptive, not yet executable**. The mapping is final
enough to publish and seek feedback. The bridge oracle is the next build
artifact, scheduled after community review.

For comments, open an issue on the Ghola repo or reach out via the SAID
discovery channel on `agents.txt`.
