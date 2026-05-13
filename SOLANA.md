# Solana surface area

Everything Ghola does on Solana, in one page.

## Programs

### `said-registry` — agent identity, services, reputation, delegation

- **Program ID:** `3EqrapHPPQqQKeB3aykZz9AbppMBzbY9PG1fT3PA7QyR`
- **Source:** [`programs/said-registry/`](./programs/said-registry/)
- **Anchor:** 0.30, Solana 1.18.26
- **Status:** built + tested locally; mainnet deploy queued (a funded deploy keypair is the only blocker)

Four on-chain account types:

| Account | PDA seeds | Purpose |
|---|---|---|
| `IdentityRecord` | `["identity", master_pubkey]` | The on-chain handle for a SAID wallet — Ed25519 master pubkey, `did:key`, `profile_uri`, authority, active flag |
| `ServiceRecord` | `["service", identity, slug]` | A headless-merchant service registered by an identity: base URL, registry URL, per-request price in micro-USDC |
| `ReputationAttestation` | `["reputation", entity]` | Platform-signed reputation score (0–10000) + confidence + transaction count |
| `DelegationRecord` | `["delegation", issuer, audience, token_hash]` | On-chain record of a UCAN delegation: hashed capabilities, expiry, revocation bit |

Ten instructions:

```
register                  – mint an IdentityRecord PDA for a SAID master pubkey
deactivate                – flip active = false (soft delete)
reactivate                – flip back on
update_authority          – rotate the manager Pubkey
update_profile_uri        – update the off-chain profile pointer
register_service          – register a headless-merchant service under an identity
deactivate_service        – soft-disable a service
attest_reputation         – platform-signed reputation attestation
record_delegation         – record a UCAN delegation on-chain
revoke_delegation         – flip revoked = true on a delegation record
```

The registry is the substrate that makes the rest of the stack composable: agents resolve each other via `IdentityRecord`, transact via `ServiceRecord` pricing, gate trust via `ReputationAttestation`, and audit capability flow via `DelegationRecord`.

## Auth — SIWS (Sign In With Solana)

v0.4.0 unified the entire stack on Sign In With Solana — there is no email/password or social login path anywhere. The wallet *is* the account.

Surfaces using SIWS:

- **Web** (`apps/web`) — SIWS via wallet adapter; JWT issued by `said-cloud`
- **Android** (`android/`, `xyz.ghola.app`) — MWA (Mobile Wallet Adapter) → SIWS → JWT
- **iOS** (`ios/`) — Solana wallet deep links → SIWS → JWT
- **CLI** (`crates/said-cli`) — local seed → SIWS → JWT
- **Browser extension** (`extension/`) — daemon or cloud proxy mode, both SIWS-authed
- **MCP server** (`mcp-server/`) — UCAN tokens scoped via wallet-signed grants

Implementation: `crates/said-cloud/src/auth.rs`, `crates/said-cloud/src/routes/auth.rs`.

## Payments — USDC

- **Marketplace** (`crates/orni-models-api`) — USDC deposits verified on-chain, creator payouts split 85/15 (creator/platform)
- **Assistant** (`crates/thumper-cloud`) — subscription tiers settle in USDC for crypto-native users
- **Gateway** (`crates/ghola-gateway`, `crates/said-x402`) — `x402` payment-required HTTP: a 402 response carries a USDC quote, the client pays on-chain, retries with proof
- **Per-call pricing** — `ServiceRecord.price_micro_usdc` (u64) advertises a service's price on-chain for headless-merchant resolution

## Mobile

- **Bundle ID:** `xyz.ghola.app`
- **Solana Mobile Stack:** Mobile Wallet Adapter integrated end-to-end
- **Seeker:** auto-detected via `solanamobile` packages, crypto features enabled by default
- **dApp Store:** signed release APK in [`android/dapp-store/`](./android/dapp-store/), ready for submission
- **Build:**
  ```bash
  export JAVA_HOME=$(/usr/libexec/java_home -v 17)
  EXPO_PUBLIC_BUILD_TYPE=mwa npx eas build -p android --profile dapp-store --local
  ```

## Wallet integration matrix

| Surface | Wallet path |
|---|---|
| Web | Solana wallet adapter (Phantom, Backpack, …) |
| Android | MWA (Phantom, Solflare, Seed Vault on Seeker) |
| iOS | Wallet deep-links |
| CLI / daemon | Local Ed25519 seed in `~/.said/` |
| Browser extension | Wallet adapter or cloud proxy |
| Turnkey | `crates/said-turnkey` for managed wallets (delegated agents, pre-gen wallets) |

## What's not on-chain (yet)

For honesty: the registry program is built and tested locally. Mainnet deploy is queued behind a funded deploy keypair. PDAs and instruction layouts are stable; the program ID is fixed in `Anchor.toml` and `declare_id!` so the address won't change at deploy time.

USDC settlement on marketplace deposits is live in the codebase; production indexer wiring lands with the registry deploy.
