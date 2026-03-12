# agents.txt Quickstart

## What is agents.txt?

`agents.txt` is a simple text file you place at the root of your domain (like `robots.txt`) that tells AI agents what your business is, what services you offer, and how to interact with you programmatically. It is the front door for the agentic web.

When an AI agent visits `https://yourdomain.com/agents.txt`, it gets a machine-readable summary of your business identity, available services, and authentication methods. Paired with `.well-known/said.json` for richer structured data, it gives agents everything they need to discover and transact with your business -- no custom API documentation, no app store listings, no human in the loop.

## Step 1: Create your agents.txt

Create a file called `agents.txt` at the root of your website.

### Minimal example

```
Identity: did:key:z6MkExampleDidKeyHere123
Profile: https://api.said.id/v1/profile/did:key:z6MkExampleDidKeyHere123
Allow-Agent: *
```

That's it. Three lines. Any AI agent can now discover your business identity.

### Full example

```
Identity: did:key:z6MkR3qVs7FLhNc5DKqXmqTGuGViAk42B8Lo2f5oWZ3x1
Profile: https://api.said.id/v1/profile/did:key:z6MkR3qVs7FLhNc5DKqXmqTGuGViAk42B8Lo2f5oWZ3x1
Said-Json: /.well-known/said.json
Allow-Agent: *
Service: reservations https://luigis-pizza.com/api/reserve
Service: menu https://luigis-pizza.com/api/menu
Service: hours https://luigis-pizza.com/api/hours
Auth: ucan https://luigis-pizza.com/.well-known/said-ucan
```

### Field reference

| Field | Required | Description |
|---|---|---|
| `Identity` | Yes | Your DID (did:key:...) |
| `Profile` | No | URL to your full SAID profile |
| `Said-Json` | No | Path to your `.well-known/said.json` file |
| `Allow-Agent` | Yes | Which agents can interact (`*` for all, or specific DIDs) |
| `Service` | No | Named service endpoint (`name url`) |
| `Auth` | No | Authentication method and endpoint |

## Step 2: Create .well-known/said.json

For richer structured data (business details, operating hours, policies, service schemas), create `.well-known/said.json`.

```json
{
  "said_version": "1.0",
  "did": "did:key:z6MkR3qVs7FLhNc5DKqXmqTGuGViAk42B8Lo2f5oWZ3x1",
  "profile_url": "https://api.said.id/v1/profile/did:key:z6MkR3qVs7FLhNc5DKqXmqTGuGViAk42B8Lo2f5oWZ3x1",
  "business": {
    "name": "Luigi's Pizza",
    "category": "restaurant",
    "description": "Family-owned Italian restaurant since 1985. Wood-fired pizza, fresh pasta, local wines.",
    "website": "https://luigis-pizza.com",
    "location": {
      "address": "123 Main St",
      "city": "Portland",
      "state": "OR",
      "country": "US",
      "postal_code": "97201"
    },
    "contact": {
      "phone": "+1-503-555-0123",
      "email": "hello@luigis-pizza.com"
    }
  },
  "services": [
    {
      "name": "reservations",
      "description": "Book a table",
      "api_endpoint": "https://luigis-pizza.com/api/reserve",
      "method": "POST",
      "parameters": {
        "party_size": {"type": "integer", "required": true},
        "date": {"type": "string", "format": "date", "required": true},
        "time": {"type": "string", "format": "time", "required": true},
        "notes": {"type": "string", "required": false}
      }
    },
    {
      "name": "menu",
      "description": "Get the current menu with prices",
      "api_endpoint": "https://luigis-pizza.com/api/menu",
      "method": "GET"
    }
  ],
  "operating_hours": {
    "monday": "11:00-21:00",
    "tuesday": "11:00-21:00",
    "wednesday": "11:00-21:00",
    "thursday": "11:00-22:00",
    "friday": "11:00-23:00",
    "saturday": "11:00-23:00",
    "sunday": "12:00-20:00"
  },
  "policies": [
    {
      "name": "cancellation",
      "content": "Reservations can be cancelled up to 2 hours before the booking time at no charge.",
      "machine_readable": {
        "cancellation_window_minutes": 120,
        "fee": 0
      }
    },
    {
      "name": "large_party",
      "content": "Parties of 8 or more require a $50 deposit.",
      "machine_readable": {
        "threshold": 8,
        "deposit_usd": 50
      }
    }
  ],
  "payment_methods": ["cash", "credit_card", "usdc"],
  "verification": {
    "domain_verified": true,
    "verified_at": "2026-01-15T00:00:00Z",
    "method": "dns-txt"
  }
}
```

## Step 3: Deploy to Your Domain

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name luigis-pizza.com;

    # agents.txt at root
    location = /agents.txt {
        alias /var/www/luigis-pizza/agents.txt;
        default_type text/plain;
        add_header Access-Control-Allow-Origin "*";
    }

    # .well-known/said.json
    location = /.well-known/said.json {
        alias /var/www/luigis-pizza/.well-known/said.json;
        default_type application/json;
        add_header Access-Control-Allow-Origin "*";
    }

    # ... rest of your site config
}
```

### Vercel

Add to `vercel.json`:

```json
{
  "rewrites": [
    { "source": "/agents.txt", "destination": "/agents.txt" },
    { "source": "/.well-known/said.json", "destination": "/.well-known/said.json" }
  ],
  "headers": [
    {
      "source": "/agents.txt",
      "headers": [
        { "key": "Content-Type", "value": "text/plain" },
        { "key": "Access-Control-Allow-Origin", "value": "*" }
      ]
    },
    {
      "source": "/.well-known/said.json",
      "headers": [
        { "key": "Content-Type", "value": "application/json" },
        { "key": "Access-Control-Allow-Origin", "value": "*" }
      ]
    }
  ]
}
```

Place `agents.txt` in your `public/` directory and `.well-known/said.json` in `public/.well-known/`.

### Cloudflare Pages

Create a `public/_redirects` file (or use `_headers`):

```
# _headers
/agents.txt
  Content-Type: text/plain
  Access-Control-Allow-Origin: *

/.well-known/said.json
  Content-Type: application/json
  Access-Control-Allow-Origin: *
```

Place both files in your `public/` directory. Cloudflare Pages serves static files from `public/` by default.

### Apache (.htaccess)

```apache
# Serve agents.txt with correct content type
<Files "agents.txt">
    Header set Content-Type "text/plain"
    Header set Access-Control-Allow-Origin "*"
</Files>

# Serve .well-known/said.json
<Directory ".well-known">
    <Files "said.json">
        Header set Content-Type "application/json"
        Header set Access-Control-Allow-Origin "*"
    </Files>
</Directory>
```

### Static site generators (Next.js, Gatsby, Hugo, etc.)

Place `agents.txt` in your static/public directory:
- **Next.js**: `public/agents.txt` and `public/.well-known/said.json`
- **Gatsby**: `static/agents.txt` and `static/.well-known/said.json`
- **Hugo**: `static/agents.txt` and `static/.well-known/said.json`

## Step 4: Verify Your Setup

### Using curl

```bash
# Check agents.txt
curl -s https://yourdomain.com/agents.txt

# Check said.json
curl -s https://yourdomain.com/.well-known/said.json | python3 -m json.tool

# Check CORS headers
curl -sI https://yourdomain.com/agents.txt | grep -i access-control
```

### Using the SAID SDK

```python
from said_sdk import SAIDClient

async with SAIDClient() as said:
    agents = await said.fetch_agents_txt("yourdomain.com")
    print(f"Identity: {agents.identity}")
    print(f"Services: {[s.name for s in agents.services]}")

    well_known = await said.fetch_well_known_said("yourdomain.com")
    print(f"Business: {well_known.business}")
```

### Using the SAID CLI

```bash
# Discover a domain
said discover yourdomain.com

# Fetch just the agents.txt
curl -s https://yourdomain.com/agents.txt
```

Expected output:
```
Identity: did:key:z6MkR3qVs7...
Profile: https://api.said.id/v1/profile/did:key:z6MkR3qVs7...
Services: reservations, menu
Domain verified: yes
```

## Step 5: Register Your DID (Optional)

Registering your DID on the Solana blockchain provides cryptographic proof that you control the identity. This is optional but increases trust.

### Using the SAID CLI

```bash
# Initialize a SAID wallet (if you haven't already)
said init

# Register your identity on-chain
said solana register

# Check registration status
said solana status
```

### Using the dashboard

Visit [said.id/dashboard](https://said.id/dashboard), connect your wallet, and follow the registration flow.

## FAQ

**Do I need SAID to use agents.txt?**

No. `agents.txt` is an open format. Any AI agent, framework, or tool can read it. SAID provides the best tooling -- SDKs, CLI, MCP server, on-chain verification -- but the file format itself is framework-agnostic. You can write a parser in 20 lines of code.

**Do I need a DID?**

Technically no. You can publish an `agents.txt` with just `Allow-Agent: *` and service URLs. But a DID ties your domain to a cryptographic identity, which lets agents verify they are talking to the real you and not a phishing site.

**How is this different from robots.txt?**

`robots.txt` tells crawlers what NOT to do. `agents.txt` tells agents what they CAN do. It is an invitation, not a restriction.

**Can I restrict which agents access my services?**

Yes. Use `Allow-Agent:` with specific DIDs instead of `*`:

```
Allow-Agent: did:key:z6MkTrustedAgent1...
Allow-Agent: did:key:z6MkTrustedAgent2...
```

Only agents presenting those DIDs (via UCAN auth) will be able to call your service endpoints.

**What if I update my services?**

Update `agents.txt` and `.well-known/said.json`. There is no registration step -- agents fetch these files on demand. SAID clients cache them briefly (typically 5-15 minutes), so changes propagate quickly.

**Do I need HTTPS?**

Yes. Agents will refuse to fetch `agents.txt` over plain HTTP. Use HTTPS with a valid certificate.

**What about rate limiting?**

Your service endpoints should implement their own rate limiting. `agents.txt` is a discovery mechanism, not an API gateway. Consider requiring UCAN auth for service calls to control access.
