# Using SAID with Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com/) by Nous Research is an autonomous AI agent with 40+ built-in tools, persistent memory, skill generation, and multi-platform messaging. Hermes natively supports MCP servers, making SAID a natural tool source.

By connecting Ghola's SAID MCP server, Hermes gains access to your portable identity, memories, preferences, secrets, payments, and business discovery tools.

## Quick Start

### 1. Install SAID

```bash
# Install from this repo. This installs both `said` and the `ghola` alias.
cargo install --path cli

# Initialize your wallet (first time only)
ghola init
```

### 2. Configure Hermes to use SAID

Hermes reads MCP servers from `~/.hermes/config.yaml` under `mcp_servers`.

**Stdio mode (local):**

```yaml
mcp_servers:
  ghola:
    command: "ghola"
    args: ["serve"]
    enabled: true
```

**HTTP mode (remote / multi-user):**

```yaml
mcp_servers:
  ghola:
    url: "http://localhost:3100/mcp"
    headers:
      Authorization: "Bearer <your-ucan-token>"
    enabled: true
```

To generate a UCAN token for Hermes:

```bash
# Grant Hermes read/write access to memories, preferences, and discovery
ghola provider grant --provider local --label hermes-agent \
  --capabilities read-memories,write-memories,read-preferences,read-prompts,read-knowledge \
  --expires 30d
```

For local Hermes installs, stdio mode is the simpler default because Hermes starts `ghola serve` directly and no bearer token is stored in `~/.hermes/config.yaml`.

### 3. Verify

Once connected, Hermes should list the following tools (among others):

```
said_search_memories     - Search your memories by keyword
said_add_memory          - Persist a new memory fact
said_get_preferences     - Get your preferences
said_get_system_prompt   - Get your portable system prompt
said_discover_business   - Discover a business by domain
said_fetch_agents_txt    - Parse a domain's agents.txt
said_request_service     - Call a business service endpoint
said_get_relevant_context - Smart context matching
said_observe             - Record an observation
```

## What Hermes Gets from SAID

### Memory Persistence Across Platforms

Hermes has its own memory system, but SAID provides **portable** memory that follows you across all AI tools. Facts persisted via `said_add_memory` or `said_observe` are available to Claude, Cursor, and any other SAID-connected client.

```
Hermes: "I'll remember that you prefer window seats."
→ said_add_memory(content: "User prefers window seats on flights", tags: ["travel"])
```

Next day in Claude Code:
```
Claude: said_get_relevant_context(snippet: "book a flight")
→ Returns: "User prefers window seats on flights"
```

### Secret Management

Hermes can access API keys and credentials stored in SAID's encrypted vault, scoped by UCAN capabilities:

```bash
# Store a secret that Hermes can access
ghola secret set stripe sk_live_... --description "Stripe API key" --providers local
```

Hermes can then use `said_get_secret(name: "stripe")` to retrieve it at runtime, without the key appearing in config files or environment variables.

### Business Discovery

Hermes can discover and interact with any business that publishes an `agents.txt` file:

```
User: "Book me a table at Luigi's Pizza"
Hermes:
  1. said_discover_business(domain: "luigis-pizza.com")
     → Returns services, skills, auth endpoints
  2. said_request_service(url: "https://api.luigis-pizza.com/reserve", method: "POST", ...)
     → Booking confirmed
  3. said_observe(content: "Booked Luigi's for 2 at 7pm, #LP-4821", role: "assistant")
     → Persisted for future reference
```

### Agent Payments (Solana)

If you grant `PayTransfer` capability, Hermes can make payments on your behalf via SAID's agent wallets with enforced spending limits:

```bash
# Create an agent wallet for Hermes with daily limits
ghola pay agents create hermes --daily-usdc-limit 50 --per-tx-usdc-limit 10

# Grant payment capabilities
ghola provider grant --provider local --label hermes-agent \
  --capabilities pay-read,pay-transfer \
  --expires 30d
```

## Skill Discovery via agents.txt

SAID's `agents.txt` spec supports a `Skill:` directive that points to [agentskills.io](https://agentskills.io)-compatible manifests. This means Hermes can auto-discover what businesses can do:

```
# Example agents.txt with skills
Identity: did:key:z6MkExample...
Service: reservations https://api.restaurant.com/reserve
Skill: book-table https://api.restaurant.com/skills/book-table.json
Skill: check-hours https://api.restaurant.com/skills/check-hours.json
```

When Hermes calls `said_fetch_agents_txt(domain: "restaurant.com")`, the response includes both service endpoints and skill manifest URLs. Hermes can fetch these manifests to understand input schemas, required auth, and expected behavior -- enabling autonomous multi-step task execution.

## Capability Scoping

SAID uses UCAN tokens to control what Hermes can access. Common configurations:

| Use Case | Capabilities |
|---|---|
| Read-only assistant | `read-memories, read-preferences, read-prompts` |
| Memory-enabled agent | `read-memories, write-memories, read-preferences, read-prompts, read-knowledge` |
| Business interaction | Above + no extra caps needed (discovery tools are always available) |
| Payment-enabled | Above + `pay-read, pay-transfer` |
| Full access | `all` |

Per-secret restrictions add another layer: even with `read-secrets`, Hermes can only access secrets whose `allowed_providers` list includes it.

## Running Hermes with a Custom Model Endpoint

Hermes supports any OpenAI-compatible model endpoint. If you're running your own inference (Ollama, vLLM, etc.), you can point both Hermes and SAID's chat relay at the same endpoint:

```bash
# Hermes uses the model directly
hermes --base-url http://localhost:11434/v1

# SAID's cloud relay can also route to the same endpoint
# (configured via said-cloud provider settings)
```

## Combining with Other MCP Servers

Hermes can use SAID alongside other MCP servers. SAID handles identity and context while other servers handle domain-specific tasks:

```yaml
mcp_servers:
  ghola:
    command: "ghola"
    args: ["serve"]
    enabled: true
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
  browser:
    command: "npx"
    args: ["-y", "@anthropic/mcp-server-puppeteer"]
```
