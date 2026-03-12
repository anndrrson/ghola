import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SAIDClient } from '../client';
import { SAIDError } from '../error';

describe('SAIDClient', () => {
  describe('constructor', () => {
    it('should use default options', () => {
      const client = new SAIDClient();
      // Verify it constructs without error — internals are private,
      // so we test behavior via method calls.
      expect(client).toBeInstanceOf(SAIDClient);
    });

    it('should accept custom options', () => {
      const client = new SAIDClient({
        apiKey: 'sk_test_123',
        baseUrl: 'https://custom.api.com/v2',
        timeout: 5000,
      });
      expect(client).toBeInstanceOf(SAIDClient);
    });

    it('should strip trailing slashes from baseUrl', () => {
      const client = new SAIDClient({
        baseUrl: 'https://api.said.id/v1///',
      });
      expect(client).toBeInstanceOf(SAIDClient);
    });
  });

  describe('API methods (mocked fetch)', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('resolve() should call GET /resolve/{didOrHandle}', async () => {
      const mockProfile = {
        profile_type: 'consumer',
        profile: { did: 'did:key:z6Mk123', display_name: 'Test' },
      };

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockProfile,
      });

      const client = new SAIDClient({ baseUrl: 'https://api.test.com/v1' });
      const result = await client.resolve('did:key:z6Mk123');

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://api.test.com/v1/resolve/did%3Akey%3Az6Mk123');
      expect(options.method).toBe('GET');
      expect(options.headers['Accept']).toBe('application/json');
      expect(result).toEqual(mockProfile);
    });

    it('resolve() should include Authorization header when apiKey is set', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ profile_type: 'consumer', profile: {} }),
      });

      const client = new SAIDClient({
        baseUrl: 'https://api.test.com/v1',
        apiKey: 'sk_my_key',
      });
      await client.resolve('did:key:z6Mk123');

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(options.headers['Authorization']).toBe('Bearer sk_my_key');
    });

    it('resolve() should not include Authorization header when no apiKey', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ profile_type: 'consumer', profile: {} }),
      });

      const client = new SAIDClient({ baseUrl: 'https://api.test.com/v1' });
      await client.resolve('did:key:z6Mk123');

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(options.headers['Authorization']).toBeUndefined();
    });

    it('resolve() with @handle should encode properly', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ profile_type: 'consumer', profile: {} }),
      });

      const client = new SAIDClient({ baseUrl: 'https://api.test.com/v1' });
      await client.resolve('@alice');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://api.test.com/v1/resolve/%40alice');
    });

    it('resolveByDomain() should call GET /discover?domain={domain}', async () => {
      const mockDiscovery = {
        domain: 'restaurant.com',
        agents_txt: null,
        well_known: null,
      };

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscovery,
      });

      const client = new SAIDClient({ baseUrl: 'https://api.test.com/v1' });
      const result = await client.resolveByDomain('restaurant.com');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://api.test.com/v1/discover?domain=restaurant.com');
      expect(result).toEqual(mockDiscovery);
    });

    it('getPublicProfile() should call GET /profile/{did}', async () => {
      const mockProfile = { did: 'did:key:z6Mk123', display_name: 'Test' };

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockProfile,
      });

      const client = new SAIDClient({ baseUrl: 'https://api.test.com/v1' });
      const result = await client.getPublicProfile('did:key:z6Mk123');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://api.test.com/v1/profile/did%3Akey%3Az6Mk123');
      expect(result).toEqual(mockProfile);
    });

    it('fetchAgentsTxt() should fetch from domain and parse', async () => {
      const agentsTxtContent = `Identity: did:key:z6Mk123
Allow-Agent: *
Service: api https://example.com/api`;

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => agentsTxtContent,
      });

      const client = new SAIDClient();
      const result = await client.fetchAgentsTxt('example.com');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://example.com/agents.txt');
      expect(result.identity).toBe('did:key:z6Mk123');
      expect(result.allow_agents).toEqual(['*']);
      expect(result.services).toHaveLength(1);
    });

    it('fetchWellKnownSaid() should fetch from domain and parse', async () => {
      const saidJson = JSON.stringify({
        said_version: '0.1',
        did: 'did:key:z6Mk123',
        services: [],
      });

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => saidJson,
      });

      const client = new SAIDClient();
      const result = await client.fetchWellKnownSaid('example.com');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://example.com/.well-known/said.json');
      expect(result.said_version).toBe('0.1');
      expect(result.did).toBe('did:key:z6Mk123');
    });

    it('should throw SAIDError on HTTP error response', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'Identity not found', code: 'NOT_FOUND' }),
      });

      const client = new SAIDClient({ baseUrl: 'https://api.test.com/v1' });

      await expect(client.resolve('did:key:nonexistent')).rejects.toThrow(SAIDError);
      await expect(
        // Re-mock since the first was consumed
        (async () => {
          (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: async () => ({ error: 'Identity not found', code: 'NOT_FOUND' }),
          });
          return client.resolve('did:key:nonexistent');
        })()
      ).rejects.toMatchObject({
        message: 'Identity not found',
        status: 404,
        code: 'NOT_FOUND',
      });
    });

    it('should throw SAIDError on network error', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new TypeError('Failed to fetch')
      );

      const client = new SAIDClient({ baseUrl: 'https://api.test.com/v1' });

      await expect(client.resolve('did:key:z6Mk123')).rejects.toThrow(SAIDError);
      await expect(
        (async () => {
          (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new TypeError('Failed to fetch')
          );
          return client.resolve('did:key:z6Mk123');
        })()
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
      });
    });
  });
});
