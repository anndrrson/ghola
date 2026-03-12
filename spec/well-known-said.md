# .well-known/said.json Specification

**Version:** 1.0
**Status:** Draft
**Date:** 2026-03-11

## 1. Abstract

`.well-known/said.json` is a machine-readable JSON document that publishes a domain's full Sovereign AI Identity (SAID) profile, including its DID, business metadata, available services, operating hours, and domain verification proof.

This file serves as the authoritative identity record for a domain. It is referenced from `agents.txt` (a lightweight pointer file at `/.well-known/agents.txt`) and provides the detailed, structured data that AI agents need to understand, verify, and interact with a domain's services.

Where `agents.txt` answers "who is this domain and where is the full record?", `said.json` answers "what does this domain offer, when is it available, and how can I verify its identity?"

## 2. File Location and Serving Requirements

The file MUST be served at the following well-known URI:

```
https://<domain>/.well-known/said.json
```

Requirements:

- The file MUST be served over HTTPS.
- The `Content-Type` response header MUST be `application/json`.
- The file MUST be encoded as UTF-8.
- The file MUST be valid JSON (RFC 8259).
- The server SHOULD set appropriate `Cache-Control` headers (e.g., `max-age=3600`).
- The server MUST NOT require authentication to access this file.
- The file SHOULD NOT exceed 1 MB in size.

## 3. Top-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `said_version` | string | REQUIRED | Specification version. MUST be `"1.0"`. |
| `did` | string | REQUIRED | The `did:key` identifier for this domain's SAID wallet. |
| `profile_url` | string | OPTIONAL | URL to the domain's SAID cloud profile page. |
| `business` | object | OPTIONAL | Business identity information (see Section 4). |
| `services` | array | OPTIONAL | Array of service definitions (see Section 5). |
| `operating_hours` | object | OPTIONAL | Weekly operating schedule (see Section 6). |
| `verification` | object | OPTIONAL | Domain verification proof (see Section 7). |

The `said_version` field enables forward compatibility. Consumers MUST check this field and handle unknown versions gracefully (e.g., by ignoring unrecognized fields rather than rejecting the document).

The `did` field MUST be a valid `did:key` identifier as specified in the DID Key Method specification. For SAID, this is derived from the wallet's Ed25519 master public key using the Multicodec prefix `0xed01`.

Example top-level structure:

```json
{
  "said_version": "1.0",
  "did": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "profile_url": "https://said.id/p/example",
  "business": { ... },
  "services": [ ... ],
  "operating_hours": { ... },
  "verification": { ... }
}
```

## 4. Business Object

The `business` object describes the entity that controls this domain.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | REQUIRED | The human-readable business name. |
| `category` | string | OPTIONAL | A standardized category identifier (see Section 8). |
| `description` | string | OPTIONAL | A brief description of the business (max 500 characters). |

Example:

```json
{
  "name": "Coastal Bistro",
  "category": "restaurant",
  "description": "Farm-to-table dining with seasonal menus and ocean views."
}
```

If the `business` object is present, the `name` field MUST be provided. The `description` field SHOULD be concise and factual, suitable for display by AI agents when summarizing a domain's purpose.

## 5. Service Object

The `services` field is an array of objects, each describing an API endpoint or service the domain exposes for programmatic interaction.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | REQUIRED | A human-readable name for the service. |
| `endpoint` | string | REQUIRED | The full URL of the service endpoint. |
| `description` | string | OPTIONAL | A brief description of what the service does. |
| `schema` | string | OPTIONAL | URL to a JSON Schema document describing the API parameters. |
| `auth_required` | boolean | OPTIONAL | Whether the service requires authentication. Defaults to `false`. |

Example:

```json
{
  "name": "Table Reservation",
  "endpoint": "https://api.coastalbistro.com/v1/reservations",
  "description": "Book a table specifying party size, date, and time.",
  "schema": "https://api.coastalbistro.com/v1/reservations/schema.json",
  "auth_required": false
}
```

Requirements:

- The `endpoint` field MUST be an absolute HTTPS URL.
- The `schema` field, if present, MUST point to a valid JSON Schema (draft-07 or later) document served over HTTPS.
- Services SHOULD be ordered by relevance or frequency of use.
- Each service `name` SHOULD be unique within the array.
- Agents MUST respect the `auth_required` field. If `true`, the agent MUST obtain appropriate credentials before calling the endpoint.

## 6. Operating Hours Object

The `operating_hours` object describes the domain's weekly availability schedule. This is primarily useful for businesses with physical locations or time-limited services.

Keys are day specifiers: individual days (`"mon"`, `"tue"`, `"wed"`, `"thu"`, `"fri"`, `"sat"`, `"sun"`) or day ranges (`"mon-fri"`, `"sat-sun"`, etc.). Values are time ranges in 24-hour `HH:MM-HH:MM` format, or the string `"closed"`.

The special key `"timezone"` specifies the IANA timezone for all time values.

| Key | Type | Description |
|---|---|---|
| `timezone` | string | IANA timezone identifier (e.g., `"America/New_York"`). REQUIRED if `operating_hours` is present. |
| Day or range key | string | Time range in `HH:MM-HH:MM` format, or `"closed"`. |

Rules:

- If a day range key (e.g., `"mon-fri"`) is present, it applies to all days in that range unless overridden by a more specific key.
- Individual day keys override range keys for that day.
- Days not covered by any key are assumed to have no defined hours (agents SHOULD NOT assume open or closed).
- Time ranges where the end time is earlier than the start time (e.g., `"22:00-02:00"`) indicate a range crossing midnight.
- Multiple time ranges for one day may be specified as a comma-separated string (e.g., `"11:00-14:00,17:00-22:00"`).

Example:

```json
{
  "timezone": "America/Los_Angeles",
  "mon-fri": "11:00-14:00,17:00-22:00",
  "sat": "10:00-23:00",
  "sun": "10:00-21:00"
}
```

## 7. Verification Object

The `verification` object provides a cryptographic proof that the domain owner controls the SAID wallet identified by `did`.

| Field | Type | Required | Description |
|---|---|---|---|
| `method` | string | REQUIRED | The verification method. MUST be `"dns-txt"` or `"well-known"`. |
| `record` | string | OPTIONAL | The expected DNS TXT record value. Required when `method` is `"dns-txt"`. |

### 7.1. dns-txt Method

The domain owner adds a DNS TXT record to their domain's DNS zone:

```
_said.example.com. IN TXT "said-verify=did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
```

The `record` field in the verification object MUST match the TXT record value exactly:

```json
{
  "method": "dns-txt",
  "record": "said-verify=did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
}
```

Verifiers SHOULD query `_said.<domain>` for a TXT record and confirm the value matches both `verification.record` and the top-level `did` field.

### 7.2. well-known Method

The presence of the `said.json` file at the well-known URI itself constitutes proof of domain control (the domain operator controls the content served at that path).

```json
{
  "method": "well-known"
}
```

This method provides weaker assurance than `dns-txt` since web server compromise would be sufficient to alter the file. It is suitable for low-stakes use cases or as a starting point before adding DNS verification.

### 7.3. Verification Precedence

AI agents SHOULD prefer `dns-txt` verification when available. A document with `"method": "well-known"` SHOULD be treated as self-asserted. Agents MAY refuse to trust services from domains that lack `dns-txt` verification.

## 8. Categories

The following standardized category identifiers are RECOMMENDED. Domains SHOULD use one of these values for the `business.category` field to enable interoperability across agents and directories.

| Category | Description |
|---|---|
| `restaurant` | Restaurants, cafes, bars, and food service establishments. |
| `hotel` | Hotels, motels, resorts, and lodging. |
| `retail` | Retail stores, e-commerce, and merchandise. |
| `saas` | Software-as-a-Service and cloud platforms. |
| `healthcare` | Hospitals, clinics, telehealth, and medical services. |
| `finance` | Banks, fintech, insurance, and financial services. |
| `education` | Schools, universities, online learning, and training. |
| `entertainment` | Media, gaming, events, and recreational services. |
| `service` | Professional services, consulting, and general services. |
| `government` | Government agencies and public sector organizations. |
| `nonprofit` | Charities, foundations, and nonprofit organizations. |

Custom category values MAY be used but SHOULD follow the pattern of lowercase, single-word identifiers. Agents that do not recognize a category value SHOULD treat it as `"service"`.

## 9. Examples

### 9.1. Restaurant with Booking Service, Menu, and Hours

```json
{
  "said_version": "1.0",
  "did": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "profile_url": "https://said.id/p/coastal-bistro",
  "business": {
    "name": "Coastal Bistro",
    "category": "restaurant",
    "description": "Farm-to-table dining with seasonal menus and ocean views."
  },
  "services": [
    {
      "name": "Table Reservation",
      "endpoint": "https://api.coastalbistro.com/v1/reservations",
      "description": "Book a table. Accepts party size (1-12), date, time, and optional seating preference.",
      "schema": "https://api.coastalbistro.com/v1/reservations/schema.json",
      "auth_required": false
    },
    {
      "name": "Menu",
      "endpoint": "https://api.coastalbistro.com/v1/menu",
      "description": "Retrieve the current menu with prices, dietary labels, and seasonal availability.",
      "auth_required": false
    },
    {
      "name": "Waitlist",
      "endpoint": "https://api.coastalbistro.com/v1/waitlist",
      "description": "Join the walk-in waitlist. Returns estimated wait time.",
      "auth_required": false
    }
  ],
  "operating_hours": {
    "timezone": "America/Los_Angeles",
    "mon": "closed",
    "tue-fri": "11:00-14:00,17:00-22:00",
    "sat": "10:00-23:00",
    "sun": "10:00-21:00"
  },
  "verification": {
    "method": "dns-txt",
    "record": "said-verify=did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
  }
}
```

### 9.2. SaaS Company with API Endpoints

```json
{
  "said_version": "1.0",
  "did": "did:key:z6Mkr4nj9Gp1YDFAB3sPwLSMv8RUfz5jEGqW2YVoGiBTsHcE",
  "profile_url": "https://said.id/p/acme-analytics",
  "business": {
    "name": "Acme Analytics",
    "category": "saas",
    "description": "Real-time product analytics and user behavior tracking."
  },
  "services": [
    {
      "name": "Events API",
      "endpoint": "https://api.acmeanalytics.com/v2/events",
      "description": "Ingest custom events with properties. Batch and single-event modes supported.",
      "schema": "https://api.acmeanalytics.com/v2/events/schema.json",
      "auth_required": true
    },
    {
      "name": "Query API",
      "endpoint": "https://api.acmeanalytics.com/v2/query",
      "description": "Run analytics queries. Supports funnel, retention, and segmentation analysis.",
      "schema": "https://api.acmeanalytics.com/v2/query/schema.json",
      "auth_required": true
    },
    {
      "name": "Status",
      "endpoint": "https://status.acmeanalytics.com/api/v1/status",
      "description": "Service health and uptime status. Returns current operational state.",
      "auth_required": false
    }
  ],
  "verification": {
    "method": "dns-txt",
    "record": "said-verify=did:key:z6Mkr4nj9Gp1YDFAB3sPwLSMv8RUfz5jEGqW2YVoGiBTsHcE"
  }
}
```

### 9.3. Minimal Profile

The smallest valid `said.json` document requires only `said_version` and `did`:

```json
{
  "said_version": "1.0",
  "did": "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp7eTk4skjRmAm"
}
```

This is sufficient for identity verification purposes when no services or business metadata need to be advertised.

## 10. Validation — JSON Schema

The following JSON Schema (draft-07) defines the structure of a valid `said.json` file. Implementations SHOULD validate documents against this schema before processing.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://said.id/schemas/well-known-said-v1.json",
  "title": "SAID Well-Known Identity Document",
  "description": "Machine-readable identity, services, and metadata for a domain.",
  "type": "object",
  "required": ["said_version", "did"],
  "additionalProperties": false,
  "properties": {
    "said_version": {
      "type": "string",
      "const": "1.0",
      "description": "Specification version."
    },
    "did": {
      "type": "string",
      "pattern": "^did:key:z[1-9A-HJ-NP-Za-km-z]+$",
      "description": "The did:key identifier for this domain's SAID wallet."
    },
    "profile_url": {
      "type": "string",
      "format": "uri",
      "pattern": "^https://",
      "description": "URL to the SAID cloud profile."
    },
    "business": {
      "type": "object",
      "required": ["name"],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Human-readable business name."
        },
        "category": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]*$",
          "description": "Standardized category identifier."
        },
        "description": {
          "type": "string",
          "maxLength": 500,
          "description": "Brief description of the business."
        }
      }
    },
    "services": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "endpoint"],
        "additionalProperties": false,
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "description": "Human-readable service name."
          },
          "endpoint": {
            "type": "string",
            "format": "uri",
            "pattern": "^https://",
            "description": "Full HTTPS URL of the service endpoint."
          },
          "description": {
            "type": "string",
            "maxLength": 500,
            "description": "Brief description of the service."
          },
          "schema": {
            "type": "string",
            "format": "uri",
            "pattern": "^https://",
            "description": "URL to a JSON Schema document for API parameters."
          },
          "auth_required": {
            "type": "boolean",
            "default": false,
            "description": "Whether the service requires authentication."
          }
        }
      }
    },
    "operating_hours": {
      "type": "object",
      "required": ["timezone"],
      "properties": {
        "timezone": {
          "type": "string",
          "description": "IANA timezone identifier."
        }
      },
      "patternProperties": {
        "^(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?$": {
          "type": "string",
          "pattern": "^(closed|([0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9])(,[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9])*)$",
          "description": "Time range(s) in HH:MM-HH:MM format, or 'closed'."
        }
      },
      "additionalProperties": false
    },
    "verification": {
      "type": "object",
      "required": ["method"],
      "additionalProperties": false,
      "properties": {
        "method": {
          "type": "string",
          "enum": ["dns-txt", "well-known"],
          "description": "The verification method."
        },
        "record": {
          "type": "string",
          "pattern": "^said-verify=did:key:z[1-9A-HJ-NP-Za-km-z]+$",
          "description": "The expected DNS TXT record value."
        }
      },
      "if": {
        "properties": { "method": { "const": "dns-txt" } }
      },
      "then": {
        "required": ["method", "record"]
      }
    }
  }
}
```

## 11. Security Considerations

### 11.1. Transport Security

The `said.json` file MUST be served over HTTPS. Agents MUST reject documents served over plain HTTP. TLS 1.2 or later SHOULD be used.

### 11.2. No Personally Identifiable Information

The `said.json` file is publicly accessible and indexed by crawlers and AI agents. Publishers MUST NOT include personally identifiable information (PII) such as personal email addresses, phone numbers, physical home addresses, or government identifiers. The `business` object is intended for organizational identity, not personal identity.

### 11.3. Domain Verification

Publishers SHOULD use `dns-txt` verification to provide strong domain-identity binding. Without DNS verification, a compromised web server could serve a fraudulent `said.json` that claims a DID controlled by the attacker.

Agents SHOULD:

- Verify the `dns-txt` record when the method is `"dns-txt"`.
- Confirm the `record` value matches the top-level `did` field.
- Cache verification results for no longer than the DNS record's TTL.
- Re-verify periodically (at least once per 24 hours for cached results).

### 11.4. Service Endpoint Trust

The inclusion of a service endpoint in `said.json` does not imply that the endpoint is safe or trustworthy. Agents MUST:

- Validate that service endpoints use HTTPS.
- Respect `auth_required` flags and not attempt unauthenticated access to protected endpoints.
- Apply rate limiting and timeout policies when calling service endpoints.
- Not automatically send sensitive user data to service endpoints without explicit user consent.

### 11.5. File Integrity

Publishers SHOULD consider serving the file with `Content-Security-Policy` and `X-Content-Type-Options: nosniff` headers. The `dns-txt` verification method provides an out-of-band integrity check: even if the file is modified, the DID in the DNS record remains authoritative.

### 11.6. Size Limits

Agents SHOULD enforce a maximum file size (RECOMMENDED: 1 MB) to prevent denial-of-service via excessively large documents. Agents SHOULD also limit the number of services processed (RECOMMENDED: 100 entries).

## Appendix A. Relationship to agents.txt

The `agents.txt` file at `/.well-known/agents.txt` serves as a lightweight pointer:

```
# agents.txt
said did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
said-json /.well-known/said.json
```

The `said-json` directive tells agents where to find the full identity document. This two-file approach allows:

- **agents.txt** to remain simple and human-readable (similar to `robots.txt`).
- **said.json** to contain the complete machine-readable profile with validation via JSON Schema.
- Agents that only need the DID can stop at `agents.txt`.
- Agents that need services, hours, or verification can follow the link to `said.json`.

## Appendix B. IANA Considerations

This specification registers the well-known URI `said.json` per RFC 8615:

- **URI suffix:** said.json
- **Change controller:** SAID Project
- **Specification document:** This document
- **Status:** Provisional

## Appendix C. References

- **RFC 8259** — The JavaScript Object Notation (JSON) Data Interchange Format
- **RFC 8615** — Well-Known Uniform Resource Identifiers (URIs)
- **DID Core** — W3C Decentralized Identifiers (DIDs) v1.0
- **did:key Method** — W3C DID Key Method Specification
- **JSON Schema** — JSON Schema: A Media Type for Describing JSON Documents (draft-07)
- **UCAN 0.10** — User Controlled Authorization Networks Specification
- **IANA Time Zone Database** — https://www.iana.org/time-zones
