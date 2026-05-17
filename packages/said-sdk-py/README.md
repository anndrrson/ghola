# said-sdk

SAID Identity SDK for Python -- Resolve identities and discover agent-friendly businesses.

## Install

```bash
pip install said-sdk
```

## Quick start

```python
from said_sdk import SAIDClient, parse_agents_txt

# Resolve identities via the SAID API
async with SAIDClient(api_key="sk_...") as said:
    profile = await said.resolve("did:key:z6Mk...")
    biz = await said.resolve_by_domain("restaurant.com")
    agents = await said.fetch_agents_txt("restaurant.com")

# Local parsing (no API needed)
parsed = parse_agents_txt("""
Identity: did:key:z6MkExample
Profile: https://api.said.id/v1/profile/did:key:z6MkExample
Said-Json: /.well-known/said.json
Allow-Agent: *
Service: booking https://example.com/reserve
Auth: ucan https://example.com/.well-known/said-ucan
""")

print(parsed.identity)      # did:key:z6MkExample
print(parsed.services[0])   # AgentsTxtService(name='booking', url='https://example.com/reserve')
```

## API

### `SAIDClient`

Async HTTP client for the SAID Identity API.

| Method | Description |
|---|---|
| `resolve(did_or_handle)` | Resolve an identity by DID or @handle |
| `resolve_by_domain(domain)` | Discover a business by domain |
| `fetch_agents_txt(domain)` | Fetch and parse `agents.txt` from a domain |
| `fetch_well_known_said(domain)` | Fetch and parse `.well-known/said.json` |
| `get_public_profile(did)` | Get a public consumer profile |

### Parsers

| Function | Description |
|---|---|
| `parse_agents_txt(content)` | Parse an `agents.txt` string into `AgentsTxt` |
| `parse_well_known_said(json_str)` | Parse a `.well-known/said.json` string into `WellKnownSaid` |

## License

MIT
