# Using SAID with Claude MCP

SAID is itself an MCP server. Claude Code and Claude Desktop can use it directly -- no SDK, no wrapper code, no glue. Add it to your MCP config and Claude gains access to your portable identity, memories, preferences, and business discovery tools.

## Setup

### Claude Code

```bash
# Install the SAID CLI (includes the MCP server binary)
cargo install said

# Initialize your wallet (first time only)
said init
```

Add to your Claude Code MCP config (`~/.claude.json` or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "said": {
      "command": "said",
      "args": ["serve"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "said": {
      "command": "said",
      "args": ["serve"]
    }
  }
}
```

Restart Claude Desktop. You should see SAID appear in the tool list.

## Available Tools

### Identity & Context (Personal)

| Tool | Description |
|---|---|
| `said_get_system_prompt` | Get your portable system prompt by name, or the default |
| `said_get_preferences` | Get your preferences, optionally filtered by dotted key path (e.g. `code.language`) |
| `said_search_memories` | Search your memories by keyword |
| `said_add_memory` | Persist a new memory fact to your wallet |
| `said_search_knowledge` | Search your knowledge base documents by keyword |
| `said_get_conversation_context` | Get recent conversation context entries |
| `said_list_mcp_configs` | List your other MCP server configurations |
| `said_get_relevant_context` | Get context relevant to the current conversation (takes a conversation snippet, returns matching memories, preferences, and knowledge) |
| `said_observe` | Record an observation from a conversation (AI clients call this to persist important facts) |

### On-Chain Identity

| Tool | Description |
|---|---|
| `said_lookup_identity` | Look up a SAID identity on the Solana blockchain by DID or public key |

### Business Discovery (Planned)

These tools have parameter types defined and are in active development:

| Tool | Description |
|---|---|
| `said_discover_business` | Discover a business's SAID profile by domain (fetches agents.txt + .well-known/said.json) |
| `said_fetch_agents_txt` | Fetch and parse a domain's agents.txt file |
| `said_get_public_profile` | Look up a public SAID profile by DID |
| `said_request_service` | Call a business service endpoint (GET/POST with optional auth) |

## Example Workflow: Book a Restaurant

Here is how Claude uses SAID tools in a real conversation.

**User**: "Find me a table for 2 at Luigi's Pizza tonight at 7pm"

**Claude's tool calls**:

1. **`said_get_preferences`** with `path: "dining"`
   - Returns: `{"dietary_restrictions": ["vegetarian"], "preferred_cuisine": ["italian"]}`
   - Claude now knows the user's dietary preferences

2. **`said_discover_business`** with `domain: "luigis-pizza.com"`
   - Returns the business profile: services, hours, policies, booking endpoint

3. **`said_get_relevant_context`** with `conversation_snippet: "restaurant booking luigi"`
   - Returns: memory from last month -- "Had a great meal at Luigi's, ask for the corner booth"
   - Claude can mention this in its response

4. **`said_request_service`** with:
   ```json
   {
     "url": "https://luigis-pizza.com/api/reserve",
     "method": "POST",
     "body": "{\"party_size\": 2, \"time\": \"19:00\", \"date\": \"2026-03-11\", \"notes\": \"corner booth if available, vegetarian options needed\"}"
   }
   ```
   - Returns: booking confirmation

5. **`said_observe`** with:
   ```json
   {
     "content": "Booked Luigi's Pizza for 2 at 7pm on March 11, confirmation #LP-4821",
     "role": "assistant"
   }
   ```
   - Persists the booking as a memory for future reference

**Claude's response**: "Done! I booked a table for 2 at Luigi's Pizza tonight at 7pm. I requested the corner booth since you liked it last time, and noted your vegetarian preference. Confirmation #LP-4821. Their cancellation policy requires 2 hours notice."

## HTTP Mode with UCAN Auth

For multi-user setups (shared servers, team environments), run SAID as an HTTP MCP server with UCAN-based auth.

### Start the HTTP server

```bash
# Start the daemon (runs in background)
said daemon start --port 3100

# Or run directly
said serve --http --port 3100
```

### Connect with UCAN token

```json
{
  "mcpServers": {
    "said": {
      "url": "http://localhost:3100/mcp",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJFZERTQSIs..."
      }
    }
  }
}
```

### UCAN capabilities

HTTP mode enforces per-tool capability checks. A UCAN token grants specific capabilities:

| Capability | Tools unlocked |
|---|---|
| `ReadPrompts` | `said_get_system_prompt` |
| `ReadPreferences` | `said_get_preferences` |
| `ReadMemories` | `said_search_memories`, `said_get_relevant_context` |
| `WriteMemories` | `said_add_memory`, `said_observe` |
| `ReadKnowledge` | `said_search_knowledge` |
| `ReadConversations` | `said_get_conversation_context` |
| `ReadMcpConfigs` | `said_list_mcp_configs` |

Generate a scoped UCAN token:

```bash
# Grant an AI provider read-only access to your memories and preferences
said provider grant --provider anthropic --label claude_code \
  --capabilities read-memories,read-preferences,read-prompts \
  --expires 24h

# Grant full access for your personal setup
said provider grant --provider local --label my-desktop \
  --capabilities read-prompts,read-preferences,read-memories,write-memories,read-knowledge,read-conversations,read-mcp-configs
```

UCAN tokens support delegation chains. A provider with `WriteMemories` capability can delegate a sub-token to a specific conversation context, and SAID will verify the full chain.

## Daemon Mode

The SAID daemon runs in the background and auto-discovers Claude Code and Cursor MCP configs, injecting itself so every AI session has access to your identity.

```bash
# Start the daemon
said daemon start

# Check status
said daemon status

# Stop
said daemon stop
```

The daemon:
- Manages its own PID file (`~/.said/daemon.pid`)
- Logs to `~/.said/daemon.log`
- Auto-discovers and patches MCP configs for Claude Code and Cursor
- Serves HTTP MCP on localhost for browser extensions and other clients

## Combining with Other MCP Servers

SAID works alongside other MCP servers. A typical power-user config:

```json
{
  "mcpServers": {
    "said": {
      "command": "said",
      "args": ["serve"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

Claude will use SAID for identity/context and the other servers for filesystem/GitHub access. Your SAID memories and preferences carry across all of them.
