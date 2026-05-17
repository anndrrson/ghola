# @said-id/sdk

TypeScript SDK for the SAID identity protocol. Resolve identities, discover agent-friendly businesses, and parse agents.txt files.

## Installation

```bash
npm install @said-id/sdk
```

## Quick Start

```typescript
import { SAIDClient } from '@said-id/sdk';

const said = new SAIDClient({ apiKey: 'sk_...' });

// Resolve an identity by DID
const profile = await said.resolve('did:key:z6Mk...');

// Resolve by @handle
const handleProfile = await said.resolve('@alice');

// Discover a business by domain
const biz = await said.resolveByDomain('restaurant.com');

// Get a public profile
const pub = await said.getPublicProfile('did:key:z6Mk...');
```

## Direct Domain Discovery

Fetch and parse agents.txt or .well-known/said.json directly from a domain (no SAID API needed):

```typescript
import { SAIDClient } from '@said-id/sdk';

const said = new SAIDClient();

// Fetch agents.txt
const agentsTxt = await said.fetchAgentsTxt('restaurant.com');
console.log(agentsTxt.identity);   // did:key:z6Mk...
console.log(agentsTxt.services);   // [{ name: 'reservations', url: '...' }]

// Fetch .well-known/said.json
const wellKnown = await said.fetchWellKnownSaid('restaurant.com');
console.log(wellKnown.business);   // { name: 'Example Restaurant', ... }
```

## Local Parsing

Parse agents.txt content without making network requests:

```typescript
import { parseAgentsTxt, parseWellKnownSaid } from '@said-id/sdk';

const parsed = parseAgentsTxt(`
Identity: did:key:z6Mk...
Allow-Agent: *
Service: reservations https://api.restaurant.com/book
Auth: bearer https://api.restaurant.com/auth/token
`);

console.log(parsed.identity);      // did:key:z6Mk...
console.log(parsed.allow_agents);  // ['*']
console.log(parsed.services);      // [{ name: 'reservations', url: '...' }]

const saidJson = parseWellKnownSaid('{"said_version":"0.1","did":"did:key:z6Mk...","services":[]}');
```

## Configuration

```typescript
const said = new SAIDClient({
  apiKey: 'sk_...',                      // Optional API key for authenticated requests
  baseUrl: 'https://api.said.id/v1',    // Custom API base URL (default shown)
  timeout: 10000,                        // Request timeout in ms (default: 10000)
});
```

## Error Handling

```typescript
import { SAIDClient, SAIDError } from '@said-id/sdk';

const said = new SAIDClient();

try {
  const profile = await said.resolve('did:key:z6Mk...');
} catch (err) {
  if (err instanceof SAIDError) {
    console.error(err.message);  // Human-readable error message
    console.error(err.status);   // HTTP status code (if applicable)
    console.error(err.code);     // Machine-readable error code (e.g., 'NOT_FOUND', 'TIMEOUT')
  }
}
```

## License

MIT
