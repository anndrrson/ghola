# SAID — Sovereign AI Identity

A self-custodied AI data wallet. One seed phrase, portable across every provider.

Your AI context (system prompts, memories, preferences) is currently trapped inside provider silos. SAID creates a local encrypted wallet that any MCP-compatible client can connect to — Claude, GPT, Ollama, anything. Remote providers authenticate via capability-scoped UCAN tokens over HTTP.

```
┌──────────────────────────────────────────────┐
│              SAID Wallet (local)              │
│  BIP-39 Seed → HD Key Tree → Per-Provider    │
│  Encrypted data store (~/.said/)              │
└──────────────┬───────────────────────────────┘
               │ stdio (local) / HTTP+SSE (remote)
┌──────────────▼───────────────────────────────┐
│           MCP Server (said serve)             │
│  Tools: get_prompt, search_memories, ...      │
│  UCAN auth (HTTP) / local trust (stdio)       │
└──────┬──────────┬──────────┬─────────────────┘
       │          │          │
  ┌────▼───┐ ┌───▼────┐ ┌───▼────┐
  │ Claude │ │  GPT   │ │ Ollama │
  └────────┘ └────────┘ └────────┘
```

## Quick Start

```bash
# Build
cargo build --release

# Create a wallet (displays 24-word recovery phrase)
said init

# Import your data
said import prompts my-prompts.json
said import memories my-memories.json
said import preferences my-prefs.json

# Start the MCP server (stdio, for local clients)
said serve

# Or start over HTTP with auth (for remote providers)
said provider grant --provider anthropic --capabilities all --expires 30d
said serve --http --port 3000
```

## Add to Claude Code

**Local (stdio):**
```json
{
  "mcpServers": {
    "said": {
      "command": "/path/to/said",
      "args": ["serve"]
    }
  }
}
```

Claude will then have access to your system prompts, memories, and preferences via tool calls. Add the same config to any other MCP client for identical context.

## Provider Sessions

Grant scoped, time-limited access to remote providers via UCAN tokens:

```bash
# Grant Anthropic read-only access for 30 days
said provider grant --provider anthropic --capabilities read-prompts,read-memories --expires 30d

# Grant full access with a custom label
said provider grant --provider openai --capabilities all --expires 7d --label "OpenAI (work)"

# List all sessions
said provider list

# Revoke a session
said provider revoke --id <session-uuid>
```

Each grant creates a signed UCAN JWT (EdDSA) scoped to specific capabilities. The bearer token is printed for use in the `Authorization` header.

**Available capabilities:** `read-prompts`, `read-preferences`, `read-memories`, `write-memories`, `read-knowledge`, `read-conversations`, `read-mcp-configs`, `read-all`, `all`

**Available providers:** `anthropic`, `openai`, `google`, `local`, `master`

## HTTP Transport

Start an authenticated HTTP MCP server for remote providers:

```bash
# Start HTTP server (requires UCAN bearer token on every request)
said serve --http --port 3000
```

Providers connect with their bearer token:
```
Authorization: Bearer <ucan_token>
```

- Stdio mode: no auth required (local trust)
- HTTP mode: valid UCAN bearer token required on every request, per-tool capability checking enforced

## CLI Commands

| Command | Description |
|---|---|
| `said init` | Create a new wallet with a 24-word recovery phrase |
| `said recover` | Restore a wallet from a recovery phrase |
| `said status` | Show wallet info, collections, DID, and active sessions |
| `said import <type> <file>` | Import data (prompts, memories, preferences, knowledge, mcp-configs) |
| `said export <type>` | Export data as JSON to stdout |
| `said provider grant` | Grant a provider scoped access with a UCAN token |
| `said provider list` | List all provider sessions with status |
| `said provider revoke --id <uuid>` | Revoke a provider session |
| `said serve` | Start the MCP server on stdio (local trust) |
| `said serve --http --port 3000` | Start the MCP server over HTTP with UCAN auth |

## MCP Tools

| Tool | Required Capability |
|---|---|
| `said_get_system_prompt` | `ReadPrompts` |
| `said_get_preferences` | `ReadPreferences` |
| `said_search_memories` | `ReadMemories` |
| `said_add_memory` | `WriteMemories` |
| `said_search_knowledge` | `ReadKnowledge` |
| `said_get_conversation_context` | `ReadConversations` |
| `said_list_mcp_configs` | `ReadMcpConfigs` |

In stdio mode all tools are allowed. In HTTP mode, tools check the session's granted capabilities.

## Import Formats

All imports expect JSON arrays. Examples:

**Prompts:**
```json
[{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "default",
  "content": "You are a helpful assistant. Be concise.",
  "tags": ["default"],
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T00:00:00Z"
}]
```

**Memories:**
```json
[{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "content": "I prefer Rust over Go for systems programming",
  "tags": ["programming"],
  "source_provider": null,
  "created_at": "2026-01-01T00:00:00Z"
}]
```

**Preferences:**
```json
[{
  "key": "code.language",
  "value": "rust",
  "updated_at": "2026-01-01T00:00:00Z"
}]
```

## Architecture

```
said/
  crates/
    said-types/       # Data schemas, Capability enum, ProviderSession
    said-core/        # Wallet: HD keys, AES-256-GCM encryption, UCAN, sessions
  mcp-server/         # MCP server (rmcp 0.15, stdio + HTTP transport)
  cli/                # CLI binary
```

**Security model:**
- BIP-39 mnemonic generates a 64-byte seed
- HKDF-SHA256 derives a local data encryption key and HD master key
- ED25519-BIP32 derives per-provider keys at `m / SAI' / provider' / key_type' / instance`
- All data encrypted at rest with AES-256-GCM (nonce + ciphertext + tag)
- Seed file is chmod 600

**Auth model (UCAN):**
- Wallet master key signs UCAN JWTs (EdDSA, UCAN 0.10 spec)
- Each token scopes access to specific capabilities with an expiry
- Tokens are verified on every HTTP request (signature, expiry, revocation, capability)
- Issuer = `did:key` of master signing key, audience = `did:key` of provider signing key
- Sessions are stored encrypted alongside wallet data

## Roadmap

- [x] **Phase 1:** Local wallet + MCP server
- [x] **Phase 2:** UCAN auth + provider sessions + HTTP transport
- [ ] **Phase 3:** Solana on-chain identity registry
- [ ] **Phase 4:** Decentralized storage (IPFS, Shadow Drive)
- [ ] **Phase 5:** Conversation history import + provider adapters

## License

MIT OR Apache-2.0
