import type { AgentsTxt, AgentsTxtAuth, AgentsTxtService, WellKnownSaid } from './types';
import { SAIDError } from './error';

/**
 * Parse agents.txt content string into structured data.
 *
 * Parsing rules:
 * - Lines starting with # are comments
 * - Empty lines are skipped
 * - Directive format: Key: value (case-insensitive key)
 * - Identity/Profile/Said-Json: last occurrence wins
 * - Allow-Agent/Service: append all occurrences
 * - Service format: "Service: name url"
 * - Auth format: "Auth: method url"
 * - Unknown directives: skip
 */
export function parseAgentsTxt(content: string): AgentsTxt {
  const result: AgentsTxt = {
    identity: null,
    profile_url: null,
    said_json: null,
    allow_agents: [],
    services: [],
    auth: null,
  };

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    // Parse directive: "Key: value"
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      continue;
    }

    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    switch (key) {
      case 'identity':
        result.identity = value;
        break;
      case 'profile':
        result.profile_url = value;
        break;
      case 'said-json':
        result.said_json = value;
        break;
      case 'allow-agent':
        if (value) {
          result.allow_agents.push(value);
        }
        break;
      case 'service': {
        const service = parseServiceDirective(value);
        if (service) {
          result.services.push(service);
        }
        break;
      }
      case 'auth': {
        const auth = parseAuthDirective(value);
        if (auth) {
          result.auth = auth;
        }
        break;
      }
      default:
        // Unknown directive, skip
        break;
    }
  }

  return result;
}

function parseServiceDirective(value: string): AgentsTxtService | null {
  // Format: "name url"
  const parts = value.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  return {
    name: parts[0],
    url: parts.slice(1).join(' '),
  };
}

function parseAuthDirective(value: string): AgentsTxtAuth | null {
  // Format: "method url"
  const parts = value.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  return {
    method: parts[0],
    url: parts.slice(1).join(' '),
  };
}

/**
 * Parse .well-known/said.json content string into structured data.
 * Throws SAIDError if the JSON is invalid.
 */
export function parseWellKnownSaid(json: string): WellKnownSaid {
  try {
    const parsed = JSON.parse(json) as WellKnownSaid;
    return parsed;
  } catch {
    throw new SAIDError('Invalid said.json: failed to parse JSON', undefined, 'PARSE_ERROR');
  }
}
