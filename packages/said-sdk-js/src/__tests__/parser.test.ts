import { describe, it, expect } from 'vitest';
import { parseAgentsTxt, parseWellKnownSaid } from '../parser';

describe('parseAgentsTxt', () => {
  it('should parse a complete agents.txt', () => {
    const content = `# SAID agents.txt
Identity: did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
Profile: https://api.said.id/v1/profile/did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
Said-Json: https://example.com/.well-known/said.json
Allow-Agent: *
Allow-Agent: claude
Service: reservations https://api.example.com/book
Service: menu https://api.example.com/menu
Auth: bearer https://api.example.com/auth/token
`;

    const result = parseAgentsTxt(content);

    expect(result.identity).toBe('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    expect(result.profile_url).toBe('https://api.said.id/v1/profile/did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    expect(result.said_json).toBe('https://example.com/.well-known/said.json');
    expect(result.allow_agents).toEqual(['*', 'claude']);
    expect(result.services).toHaveLength(2);
    expect(result.services[0]).toEqual({ name: 'reservations', url: 'https://api.example.com/book' });
    expect(result.services[1]).toEqual({ name: 'menu', url: 'https://api.example.com/menu' });
    expect(result.auth).toEqual({ method: 'bearer', url: 'https://api.example.com/auth/token' });
  });

  it('should parse a minimal agents.txt', () => {
    const content = `Identity: did:key:z6Mk123`;

    const result = parseAgentsTxt(content);

    expect(result.identity).toBe('did:key:z6Mk123');
    expect(result.profile_url).toBeNull();
    expect(result.said_json).toBeNull();
    expect(result.allow_agents).toEqual([]);
    expect(result.services).toEqual([]);
    expect(result.auth).toBeNull();
  });

  it('should handle comments and blank lines', () => {
    const content = `
# This is a comment
# Another comment

Identity: did:key:z6Mk123

# A comment between directives
Allow-Agent: *

`;

    const result = parseAgentsTxt(content);

    expect(result.identity).toBe('did:key:z6Mk123');
    expect(result.allow_agents).toEqual(['*']);
  });

  it('should use last occurrence for Identity (last wins)', () => {
    const content = `Identity: did:key:first
Identity: did:key:second
Identity: did:key:third`;

    const result = parseAgentsTxt(content);

    expect(result.identity).toBe('did:key:third');
  });

  it('should use last occurrence for Profile (last wins)', () => {
    const content = `Profile: https://first.com
Profile: https://second.com`;

    const result = parseAgentsTxt(content);

    expect(result.profile_url).toBe('https://second.com');
  });

  it('should use last occurrence for Said-Json (last wins)', () => {
    const content = `Said-Json: https://first.com/said.json
Said-Json: https://second.com/said.json`;

    const result = parseAgentsTxt(content);

    expect(result.said_json).toBe('https://second.com/said.json');
  });

  it('should accumulate multiple Allow-Agent directives', () => {
    const content = `Allow-Agent: *
Allow-Agent: claude
Allow-Agent: gpt
Allow-Agent: gemini`;

    const result = parseAgentsTxt(content);

    expect(result.allow_agents).toEqual(['*', 'claude', 'gpt', 'gemini']);
  });

  it('should accumulate multiple Service directives', () => {
    const content = `Service: booking https://api.example.com/book
Service: menu https://api.example.com/menu
Service: reviews https://api.example.com/reviews`;

    const result = parseAgentsTxt(content);

    expect(result.services).toHaveLength(3);
    expect(result.services[0]).toEqual({ name: 'booking', url: 'https://api.example.com/book' });
    expect(result.services[1]).toEqual({ name: 'menu', url: 'https://api.example.com/menu' });
    expect(result.services[2]).toEqual({ name: 'reviews', url: 'https://api.example.com/reviews' });
  });

  it('should skip unknown directives', () => {
    const content = `Identity: did:key:z6Mk123
FooBar: some value
Random: another value
Allow-Agent: *`;

    const result = parseAgentsTxt(content);

    expect(result.identity).toBe('did:key:z6Mk123');
    expect(result.allow_agents).toEqual(['*']);
  });

  it('should skip malformed service lines without url', () => {
    const content = `Service: name-only
Service: valid https://api.example.com/valid`;

    const result = parseAgentsTxt(content);

    expect(result.services).toHaveLength(1);
    expect(result.services[0]).toEqual({ name: 'valid', url: 'https://api.example.com/valid' });
  });

  it('should be case-insensitive for directive keys', () => {
    const content = `IDENTITY: did:key:z6Mk123
profile: https://example.com/profile
ALLOW-AGENT: claude
service: api https://example.com/api`;

    const result = parseAgentsTxt(content);

    expect(result.identity).toBe('did:key:z6Mk123');
    expect(result.profile_url).toBe('https://example.com/profile');
    expect(result.allow_agents).toEqual(['claude']);
    expect(result.services).toHaveLength(1);
  });

  it('should handle empty content', () => {
    const result = parseAgentsTxt('');

    expect(result.identity).toBeNull();
    expect(result.profile_url).toBeNull();
    expect(result.said_json).toBeNull();
    expect(result.allow_agents).toEqual([]);
    expect(result.services).toEqual([]);
    expect(result.auth).toBeNull();
  });

  it('should use last Auth occurrence (last wins)', () => {
    const content = `Auth: bearer https://first.com/token
Auth: oauth2 https://second.com/auth`;

    const result = parseAgentsTxt(content);

    expect(result.auth).toEqual({ method: 'oauth2', url: 'https://second.com/auth' });
  });
});

describe('parseWellKnownSaid', () => {
  it('should parse valid said.json', () => {
    const json = JSON.stringify({
      said_version: '0.1',
      did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      profile_url: 'https://api.said.id/v1/profile/did:key:z6Mk123',
      business: {
        name: 'Example Restaurant',
        category: 'restaurant',
        description: 'A fine dining experience',
      },
      services: [
        {
          name: 'reservations',
          description: 'Book a table',
          price: '$0',
          booking_url: 'https://api.example.com/book',
          parameters: { party_size: 'number', date: 'string' },
        },
      ],
      operating_hours: {
        monday: '11:00-22:00',
        tuesday: '11:00-22:00',
      },
      verification: {
        method: 'dns-txt',
        record: '_said.example.com',
      },
    });

    const result = parseWellKnownSaid(json);

    expect(result.said_version).toBe('0.1');
    expect(result.did).toBe('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    expect(result.business?.name).toBe('Example Restaurant');
    expect(result.services).toHaveLength(1);
    expect(result.services[0].name).toBe('reservations');
    expect(result.operating_hours?.monday).toBe('11:00-22:00');
    expect(result.verification?.method).toBe('dns-txt');
  });

  it('should parse minimal said.json', () => {
    const json = JSON.stringify({
      said_version: '0.1',
      did: 'did:key:z6Mk123',
      services: [],
    });

    const result = parseWellKnownSaid(json);

    expect(result.said_version).toBe('0.1');
    expect(result.did).toBe('did:key:z6Mk123');
    expect(result.services).toEqual([]);
    expect(result.business).toBeUndefined();
    expect(result.profile_url).toBeUndefined();
  });

  it('should throw SAIDError on invalid JSON', () => {
    expect(() => parseWellKnownSaid('not valid json')).toThrow('Invalid said.json: failed to parse JSON');
  });

  it('should throw SAIDError on empty string', () => {
    expect(() => parseWellKnownSaid('')).toThrow('Invalid said.json: failed to parse JSON');
  });
});
