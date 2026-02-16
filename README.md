# SAID — Sovereign AI Identity

A self-custodied AI data wallet. One seed phrase, portable across every provider.

Your AI context (system prompts, memories, preferences) is currently trapped inside provider silos. SAID creates a local encrypted wallet that any MCP-compatible client can connect to — Claude, GPT, Ollama, anything.

```
┌──────────────────────────────────────────────┐
│              SAID Wallet (local)              │
│  BIP-39 Seed → HD Key Tree → Per-Provider    │
│  Encrypted data store (~/.said/)              │
└──────────────┬───────────────────────────────┘
               │ stdio
┌──────────────▼───────────────────────────────┐
│           MCP Server (said serve)             │
│  Tools: get_prompt, search_memories, ...      │
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

# Start the MCP server
said serve
```

## Add to Claude Code

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

## CLI Commands

| Command | Description |
|---|---|
| `said init` | Create a new wallet with a 24-word recovery phrase |
| `said recover` | Restore a wallet from a recovery phrase |
| `said status` | Show wallet info and collection stats |
| `said import <type> <file>` | Import data (prompts, memories, preferences, knowledge, mcp-configs) |
| `said export <type>` | Export data as JSON to stdout |
| `said serve` | Start the MCP server on stdio |

## MCP Tools

| Tool | Description |
|---|---|
| `said_get_system_prompt` | Get your portable system prompt by name |
| `said_get_preferences` | Get preferences, optionally filtered by key path |
| `said_search_memories` | Keyword search across your memories |
| `said_add_memory` | Persist a new memory fact |
| `said_search_knowledge` | Search knowledge base documents |
| `said_get_conversation_context` | Get recent conversation history |
| `said_list_mcp_configs` | List your other MCP server configurations |

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
    said-types/       # Data schemas (no crypto deps)
    said-core/        # Wallet: HD keys, AES-256-GCM encryption, local storage
  mcp-server/         # MCP server (rmcp 0.15, stdio transport)
  cli/                # CLI binary
```

**Security model:**
- BIP-39 mnemonic generates a 64-byte seed
- HKDF-SHA256 derives a local data encryption key and HD master key
- ED25519-BIP32 derives per-provider keys at `m / SAI' / provider' / key_type' / instance`
- All data encrypted at rest with AES-256-GCM (nonce + ciphertext + tag)
- Seed file is chmod 600

## Roadmap

- [x] **Phase 1:** Local wallet + MCP server (this repo)
- [ ] **Phase 2:** UCAN auth + provider sessions (HTTP/SSE transport)
- [ ] **Phase 3:** Solana on-chain identity registry
- [ ] **Phase 4:** Decentralized storage (IPFS, Shadow Drive)
- [ ] **Phase 5:** Conversation history import + provider adapters

## License

MIT OR Apache-2.0
