# Ghola

**The agent-native stack for Solana.** Identity, assistant, and creator marketplace — one wallet, one umbrella, four pillars.

Today's AI lives in walled gardens. Your context is trapped in one provider, your agents can't be discovered, and there's no shared substrate for them to transact on. Ghola is the open alternative, built natively on Solana.

> **Live:** [ghola.xyz](https://ghola.xyz) · **Android:** `xyz.ghola.app` (Solana dApp Store-ready, signed APK in `android/dapp-store/`) · **iOS:** SwiftUI app · **Registry program:** `3EqrapHPPQqQKeB3aykZz9AbppMBzbY9PG1fT3PA7QyR` (built + tested, mainnet deploy pending)

---

## The four pillars

| Pillar | Code path | What it does |
|---|---|---|
| **Identity (SAID)** | `crates/said-*`, `programs/said-registry` | Self-custodied AI data wallet + on-chain Solana identity registry. One seed phrase, portable across every provider. UCAN-scoped capabilities. |
| **Assistant** | `crates/thumper-*`, `android/`, `ios/` | Turnkey AI personal assistant — voice calls (Bland AI), email (Gmail), calendar, device control. Primary target: Solana Seeker. |
| **Marketplace** | `crates/orni-models-*`, `apps/orni-models-web` | Creator-friendly AI model marketplace. Creators fine-tune + monetize; users browse + chat. USDC payments with 85/15 creator split. |
| **Gateway** | `crates/ghola-gateway`, `crates/said-x402` | x402 payment-required HTTP, billing-as-a-service, and the on-ramps that let agents transact across the other three pillars. |

They share one wallet, one auth model (Sign In With Solana), one billing surface.

---

## Why Solana

Ghola is Solana-native, not Solana-tolerant. Concretely:

- **On-chain agent registry** — `programs/said-registry` (Anchor) ships four account types: `IdentityRecord`, `ServiceRecord` (headless-merchant services with USDC pricing), `ReputationAttestation`, and `DelegationRecord` (UCAN delegations recorded on-chain). Ten instructions covering identity lifecycle, service registration, reputation, and capability delegation.
- **SIWS everywhere** — Sign In With Solana is the only auth path in v0.4.0. No email/password, no Google. The wallet *is* the account, across web, Android, iOS, MCP, and CLI.
- **USDC payments** — Marketplace creator payouts, assistant subscriptions, and x402-gated APIs all settle in USDC.
- **Solana dApp Store** — Android build (`xyz.ghola.app`) is signed and ready for submission.
- **MWA + Seeker first-class** — Mobile Wallet Adapter wired through the assistant; Seeker auto-detected and treated as the canonical hardware.

See **[SOLANA.md](./SOLANA.md)** for program IDs, instruction layouts, PDA seeds, and the full on-chain surface.

---

## Architecture

```
                          ┌─────────────────────────┐
                          │     Solana mainnet      │
                          │  said-registry program  │
                          │  IdentityRecord PDAs    │
                          └────────────┬────────────┘
                                       │ register / resolve
                                       │
┌──────────────────────────────────────┴──────────────────────────────────────┐
│                              Ghola Gateway                                  │
│   x402 payment-required HTTP · UCAN auth · USDC billing · agent registry    │
└────────┬─────────────────────┬─────────────────────┬───────────────────────┘
         │                     │                     │
   ┌─────▼──────┐       ┌──────▼───────┐      ┌──────▼──────────┐
   │  Identity  │       │   Assistant  │      │   Marketplace   │
   │   (SAID)   │       │   (Thumper)  │      │  (Orni Models)  │
   │            │       │              │      │                 │
   │ Wallet     │       │ Voice (Bland)│      │ Fine-tunes      │
   │ MCP server │       │ Email (Gmail)│      │ Chat (SSE)      │
   │ Browser ext│       │ Calendar     │      │ USDC payouts    │
   │ Web dash   │       │ Device ctrl  │      │ Creator dash    │
   └─────┬──────┘       └──────┬───────┘      └────────┬────────┘
         │                     │                       │
         └─────────────────────┴───────────────────────┘
                               │
                  ┌────────────┴────────────┐
                  │  Clients (one wallet)   │
                  │  Web · Android · iOS    │
                  │     CLI · MCP · Ext     │
                  └─────────────────────────┘
```

---

## What's in the box

| Surface | Tech | Size |
|---|---|---|
| Backend (Rust) | axum 0.8, sqlx 0.8, rmcp 0.15, anchor-lang 0.30 | **~63k LOC** across **18 crates** |
| Solana program | Anchor 0.30, Ed25519 | `programs/said-registry` — 4 account types, 10 instructions |
| Web | Next.js 16, React 19, Tailwind 4 | **~33k LOC** TS/TSX |
| Android | Kotlin, Expo (MWA), Solana Mobile Stack | **~14k LOC**, `xyz.ghola.app` |
| iOS | SwiftUI, Siri Shortcuts, Dynamic Island | **~4k LOC** |
| SDKs | TypeScript, Python | `packages/said-sdk-js`, `said-sdk-py`, `said-pay-sdk-js` |
| Browser ext | MV3, WASM crypto | `extension/` |
| Tests | rust unit + integration | **288 tests** |
| Deploy | Render, Fly.io, Vercel | 4 Dockerfiles, `fly.thumper-cloud.toml`, `render.yaml` |

---

## Repository layout

```
ghola/
├── crates/                     # 18 Rust crates
│   ├── said-types/             # Shared data schemas, UCAN capabilities
│   ├── said-core/              # Wallet: HD keys, AES-256-GCM, UCAN, sessions
│   ├── said-cloud/             # Cloud API + dashboard backend (axum)
│   ├── said-solana/            # On-chain registry client
│   ├── said-wasm/              # Browser wallet (WASM)
│   ├── said-x402/              # x402 payment-required HTTP
│   ├── said-turnkey/           # Turnkey wallet integration
│   ├── thumper-types/          # Assistant shared types
│   ├── thumper-cloud/          # Assistant server (calls, email, tasks)
│   ├── thumper-relay/          # Device <-> cloud relay (axum + WS)
│   ├── thumper-mcp/            # MCP tools (23 tools, 8 YAML flows)
│   ├── thumper-cli/            # CLI binary
│   ├── orni-models-api/        # Marketplace backend (chat, payments, creators)
│   ├── orni-models-types/      # Marketplace shared types
│   ├── ghola-gateway/          # x402 + USDC billing + agent registry
│   └── ghola-home/             # Unified web BFF
├── programs/
│   └── said-registry/          # Anchor program (Solana mainnet)
├── apps/
│   ├── web/                    # ghola.xyz (Next.js 16)
│   └── orni-models-web/        # Marketplace UI
├── packages/
│   ├── said-sdk-js/            # TypeScript SDK
│   ├── said-sdk-py/            # Python SDK
│   └── said-pay-sdk-js/        # x402 client SDK
├── android/                    # xyz.ghola.app (Kotlin + Expo + MWA)
├── ios/                        # SwiftUI app + macOS menu bar
├── extension/                  # Browser extension (MV3)
├── mcp-server/                 # said serve binary
├── migrations/                 # Postgres migrations (cloud + marketplace)
├── docs/                       # Integration guides (LangChain, MCP, OpenAI)
├── spec/                       # agents.txt + .well-known/said spec
└── integration-tests/          # Cross-pillar e2e tests
```

---

## Quick start

```bash
# Backend (workspace builds clean)
cargo build --workspace --release

# Web (ghola.xyz)
cd apps/web && npm install && npm run dev

# Solana program (requires Anchor 0.30 + Solana 1.18.26)
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor build && anchor test

# Android (Solana dApp Store build)
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
EXPO_PUBLIC_BUILD_TYPE=mwa npx eas build -p android --profile dapp-store --local

# Run the cloud locally (assistant)
DATABASE_URL=postgres://... \
JWT_SECRET=... \
cargo run -p thumper-cloud
```

Detailed environment variables, deployment notes, and per-pillar guides live in each crate's README.

---

## Status

- **Identity (SAID):** v0.4.0 wallet-only SIWS auth shipping. 93+ tests across core + WASM. Anchor registry program built and tested, mainnet deploy queued.
- **Assistant (Thumper):** Cloud + Android + iOS shipping. 23 MCP tools + 8 task templates. Bland AI voice calls and Gmail OAuth wired.
- **Marketplace (Orni Models):** Backend and web shipping. Together.ai inference, USDC deposit verification, 85/15 split live.
- **Gateway:** x402 payment-required HTTP scaffolded; agent registry + billing-as-a-service in progress.

---

## License

MIT OR Apache-2.0
