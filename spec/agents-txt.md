# agents.txt Specification

## SAID Protocol - Agent Discovery Format v1.0

**Status:** Draft Specification
**Version:** 1.0
**Date:** 2026-03-11

---

## 1. Abstract

`agents.txt` is a simple, human-readable file placed at a domain's root that declares the site's SAID (Sovereign AI Identity) identity, available services, and agent access policies. It serves a role analogous to `robots.txt` for web crawlers: any AI agent visiting a domain can fetch `/agents.txt` to discover who owns the domain, what services are available for programmatic interaction, how to authenticate, and whether the agent is permitted to interact at all.

The format is deliberately minimal. It uses line-based directives that are easy to read, write, and parse without specialized libraries.

---

## 2. File Location

The file MUST be served at the path `/agents.txt` from the domain root.

- **URL:** `https://example.com/agents.txt`
- **Encoding:** UTF-8
- **Content-Type:** `text/plain; charset=utf-8`
- **Protocol:** The file MUST be served over HTTPS. Agents SHOULD NOT fetch `agents.txt` over plain HTTP except during local development.

Only one `agents.txt` file is recognized per domain. Subdirectory placement (e.g., `/foo/agents.txt`) has no special meaning.

---

## 3. Syntax

The file format is line-oriented.

- Each line contains at most one directive.
- Lines beginning with `#` (optionally preceded by whitespace) are comments and MUST be ignored by parsers.
- Blank lines (empty or containing only whitespace) MUST be ignored by parsers.
- Directives are case-insensitive in the key portion (e.g., `Identity` and `identity` are equivalent). Values are case-sensitive unless otherwise noted.
- Each directive takes the form: `Key: Value` (a key, followed by a colon, followed by one or more spaces, followed by the value).
- Lines MUST NOT exceed 8192 bytes.
- The file MUST NOT exceed 64 KiB in total size.

---

## 4. Directives

### 4.1. Identity

```
Identity: <did>
```

The DID (Decentralized Identifier) that owns this domain. This MUST be a valid `did:key` identifier.

- **Cardinality:** REQUIRED. Exactly one.
- **Purpose:** Establishes the cryptographic identity of the domain owner. Agents can verify that the entity controlling this DID also controls the domain by cross-referencing the SAID profile or on-chain registry.

**Example:**

```
Identity: did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

### 4.2. Profile

```
Profile: <url>
```

An HTTPS URL pointing to the full SAID profile endpoint for this identity. The profile contains extended metadata such as display name, description, supported capabilities, and delegation information.

- **Cardinality:** OPTIONAL. At most one.
- **Constraints:** The URL MUST use the `https` scheme.

**Example:**

```
Profile: https://example.com/.well-known/said-profile.json
```

### 4.3. Said-Json

```
Said-Json: <path>
```

The path (relative to the domain root) where the machine-readable SAID discovery document is served. This JSON document provides structured metadata for automated tooling.

- **Cardinality:** OPTIONAL. At most one.
- **Default:** `/.well-known/said.json`

If omitted, agents SHOULD attempt to fetch `/.well-known/said.json` as a fallback.

**Example:**

```
Said-Json: /.well-known/said.json
```

### 4.4. Allow-Agent

```
Allow-Agent: <agent-id | *>
```

Declares which AI agents are permitted to interact with this domain's services. The value is either a specific agent identifier (a DID or other unique agent ID) or the wildcard `*` meaning all agents are permitted.

- **Cardinality:** OPTIONAL. May appear zero or more times.
- **Default behavior:** If no `Allow-Agent` directive is present, all agents are permitted (equivalent to `Allow-Agent: *`).
- **Semantics:** Multiple `Allow-Agent` lines are additive. If at least one `Allow-Agent` line is present, only the listed agents (or all agents if `*` is included) are permitted.

**Example:**

```
Allow-Agent: *
```

```
Allow-Agent: did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH
Allow-Agent: did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP
```

### 4.5. Service

```
Service: <name> <url>
```

Declares a named service endpoint available at this domain. The name is a single token (no whitespace) that identifies the service. The URL is the endpoint where the service can be reached.

- **Cardinality:** OPTIONAL. May appear zero or more times.
- **Name conventions:** Service names SHOULD be descriptive lowercase tokens using hyphens as separators (e.g., `menu-api`, `reservations`, `customer-support`).
- **Constraints:** The URL MUST use the `https` scheme in production.

**Example:**

```
Service: menu-api https://api.restaurant.com/v1/menu
Service: reservations https://api.restaurant.com/v1/reservations
Service: chat https://api.restaurant.com/v1/agent-chat
```

### 4.6. Skill

```
Skill: <name> <manifest-url>
```

Declares a machine-readable skill manifest for this domain, compatible with the [agentskills.io](https://agentskills.io) open format. Each skill manifest describes an autonomous capability that an AI agent can discover and execute: input/output schemas, required auth, expected behavior, and usage examples.

- **Cardinality:** OPTIONAL. May appear zero or more times.
- **Name conventions:** Skill names SHOULD be descriptive lowercase tokens using hyphens as separators (e.g., `book-table`, `check-availability`, `process-refund`). Names SHOULD correspond to service names where applicable.
- **Constraints:** The manifest URL MUST use the `https` scheme in production. The manifest SHOULD be a valid agentskills.io JSON document.
- **Relationship to Service:** A `Skill` directive complements a `Service` directive. Where `Service` declares a raw API endpoint, `Skill` provides the higher-level capability description that allows agents to autonomously plan and execute multi-step interactions.

**Example:**

```
Skill: book-table https://api.restaurant.com/skills/book-table.json
Skill: check-hours https://api.restaurant.com/skills/check-hours.json
Skill: dietary-info https://api.restaurant.com/skills/dietary-info.json
```

### 4.7. Auth

```
Auth: <method> <url>
```

Declares an authentication method and the endpoint where agents can initiate authentication. This tells visiting agents how to obtain credentials for interacting with the domain's services.

- **Cardinality:** OPTIONAL. May appear zero or more times.
- **Supported methods:**
  - `ucan` -- UCAN (User Controlled Authorization Network) token issuance. The agent presents its DID and receives a delegated UCAN token.
  - `api_key` -- API key provisioning. The URL points to an endpoint where agents can request or register an API key.
  - `oauth2` -- OAuth 2.0 authorization. The URL points to the OAuth 2.0 authorization server metadata endpoint.
- **Extensibility:** Implementations SHOULD ignore unrecognized method names and MAY log a warning.

**Example:**

**Example:**

```
Auth: ucan https://example.com/.well-known/ucan-endpoint
Auth: oauth2 https://auth.example.com/.well-known/oauth-authorization-server
```

---

## 5. Versioning

The first line of the file MAY be a version comment in the following format:

```
# agents.txt - SAID Protocol v1.0
```

This comment is informational and does not affect parsing. Parsers MUST NOT require its presence. Future versions of this specification will increment the version number. Parsers that encounter an unrecognized version SHOULD proceed with best-effort parsing and MAY log a warning.

---

## 6. Examples

### 6.1. Restaurant

```
# agents.txt - SAID Protocol v1.0
# Bella's Italian Kitchen - Downtown Portland

Identity: did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
Profile: https://bellas.com/.well-known/said-profile.json
Said-Json: /.well-known/said.json

# Open to all AI agents
Allow-Agent: *

# Available services
Service: menu https://api.bellas.com/v1/menu
Service: reservations https://api.bellas.com/v1/reservations
Service: hours https://api.bellas.com/v1/hours
Service: reviews https://api.bellas.com/v1/reviews

# Skills (agentskills.io manifests)
Skill: book-table https://api.bellas.com/v1/skills/book-table.json
Skill: dietary-info https://api.bellas.com/v1/skills/dietary-info.json

# Authentication
Auth: ucan https://api.bellas.com/v1/auth/ucan
Auth: api_key https://api.bellas.com/v1/auth/register
```

### 6.2. SaaS Company

```
# agents.txt - SAID Protocol v1.0
# Acme Cloud Services

Identity: did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP
Profile: https://acmecloud.io/.well-known/said-profile.json

# Restrict to verified partner agents only
Allow-Agent: did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH
Allow-Agent: did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WkArsaVAqw1

# API surface
Service: compute https://api.acmecloud.io/v2/compute
Service: storage https://api.acmecloud.io/v2/storage
Service: billing https://api.acmecloud.io/v2/billing
Service: status https://status.acmecloud.io/api/v1

# OAuth2 for enterprise integrations
Auth: oauth2 https://auth.acmecloud.io/.well-known/oauth-authorization-server
Auth: ucan https://auth.acmecloud.io/ucan/issue
```

### 6.3. Minimal File

```
Identity: did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

This is the smallest valid `agents.txt`. It declares the domain's identity with no services, no access restrictions, and default paths for discovery documents.

---

## 7. Parsing Rules

Implementations parsing `agents.txt` MUST adhere to the following rules:

1. **Unknown directives:** Lines with an unrecognized key MUST be silently ignored. Parsers MAY log a warning at a debug level. This ensures forward compatibility as new directives are introduced in future versions.

2. **Malformed lines:** Lines that do not match the `Key: Value` format (excluding comments and blank lines) MUST be skipped. Parsers SHOULD emit a warning indicating the line number and content of the malformed line.

3. **Duplicate handling:**
   - **Singular directives** (`Identity`, `Profile`, `Said-Json`): If a singular directive appears more than once, the last occurrence wins. Parsers SHOULD emit a warning on duplicates.
   - **Repeatable directives** (`Allow-Agent`, `Service`, `Skill`, `Auth`): Multiple occurrences are appended to a list. Order is preserved.

4. **Whitespace:** Leading and trailing whitespace on each line MUST be stripped before parsing. Whitespace between the colon and the value MUST be stripped.

5. **Empty values:** A directive with an empty value (e.g., `Identity:` with nothing after the colon) MUST be treated as if the line were absent. Parsers SHOULD emit a warning.

6. **File not found:** If `/agents.txt` returns HTTP 404, the agent MUST treat the domain as having no SAID identity declared. The agent MUST NOT fall back to other paths.

7. **HTTP errors:** If fetching `/agents.txt` returns a server error (5xx), the agent SHOULD retry with exponential backoff (up to 3 attempts). On persistent failure, the agent MUST treat the domain as having no SAID identity declared.

8. **Caching:** Agents SHOULD respect standard HTTP caching headers (`Cache-Control`, `ETag`, `Last-Modified`). In the absence of caching headers, agents SHOULD cache the file for no longer than 24 hours.

---

## 8. Security Considerations

1. **No sensitive data:** The `agents.txt` file is publicly accessible. It MUST NOT contain secrets, private keys, API keys, passwords, or any other sensitive information. It declares discovery metadata only.

2. **HTTPS required:** All URLs in `Profile`, `Service`, and `Auth` directives MUST use the `https` scheme in production environments. Parsers SHOULD reject or warn on `http` URLs.

3. **Domain verification:** The `Identity` directive alone does not prove domain ownership. Verification requires cross-referencing:
   - The SAID profile at the `Profile` URL should reference the same domain.
   - On-chain registry lookups (e.g., the SAID Solana registry) can confirm the DID-to-domain binding.
   - TLS certificate validation of the serving domain provides transport-layer assurance.

4. **Agent impersonation:** The `Allow-Agent` directive restricts access by agent DID. Services behind `Service` endpoints MUST independently verify agent identity (e.g., via UCAN tokens) rather than relying solely on `Allow-Agent` declarations, which are advisory.

5. **Replay and tampering:** Because `agents.txt` is served over HTTPS, TLS provides integrity and confidentiality in transit. However, domain operators should monitor for unauthorized changes to the file, as a compromised `agents.txt` could redirect agents to malicious endpoints.

6. **Rate limiting:** Domains SHOULD rate-limit requests to `/agents.txt` to prevent abuse. Standard rate-limiting headers (`Retry-After`, `X-RateLimit-*`) SHOULD be used.

---

## 9. IANA Considerations

### 9.1. Well-Known URI Registration

This specification registers the following well-known URI:

- **URI suffix:** `agents.txt` (served at the domain root, not under `/.well-known/`)
- **Change controller:** SAID Protocol Working Group
- **Specification document:** This document
- **Related information:** The `agents.txt` file is analogous to `robots.txt` (RFC 9309) but targets AI agent discovery rather than web crawler directives.

### 9.2. Well-Known URI for said.json

This specification references but does not define:

- **URI suffix:** `said.json` (served at `/.well-known/said.json`)
- **Specification document:** See the SAID Discovery Document specification.

---

## Appendix A. ABNF Grammar

The following ABNF (RFC 5234) defines the syntax of `agents.txt`:

```
agents-txt     = *( line LF )
line           = comment / directive / blank
comment        = *WSP "#" *VCHAR
directive      = key ":" 1*WSP value
blank          = *WSP
key            = 1*ALPHA *( ALPHA / "-" )
value          = 1*( VCHAR / WSP )

; Specific directives
identity-dir   = "Identity" ":" 1*WSP did-key
profile-dir    = "Profile" ":" 1*WSP https-url
said-json-dir  = "Said-Json" ":" 1*WSP path
allow-dir      = "Allow-Agent" ":" 1*WSP ( agent-id / "*" )
service-dir    = "Service" ":" 1*WSP name 1*WSP https-url
skill-dir      = "Skill" ":" 1*WSP name 1*WSP https-url
auth-dir       = "Auth" ":" 1*WSP method 1*WSP https-url

did-key        = "did:key:" 1*BASE58
https-url      = "https://" *VCHAR
path           = "/" *VCHAR
agent-id       = did-key
name           = 1*( ALPHA / DIGIT / "-" / "_" )
method         = "ucan" / "api_key" / "oauth2"
```

---

## Appendix B. Comparison with robots.txt

| Aspect | robots.txt (RFC 9309) | agents.txt |
|---|---|---|
| **Purpose** | Crawler access control | AI agent discovery and access |
| **Identity** | User-Agent string | DID (cryptographic) |
| **Services** | N/A | Named endpoints |
| **Skills** | N/A | agentskills.io manifests |
| **Auth** | N/A | UCAN, OAuth2, API key |
| **Verification** | None | DID + on-chain registry |
| **Location** | `/robots.txt` | `/agents.txt` |
| **Format** | Line-based directives | Line-based directives |
