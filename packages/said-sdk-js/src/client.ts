import type {
  SAIDClientOptions,
  ResolvedProfile,
  DomainDiscovery,
  AgentsTxt,
  WellKnownSaid,
  PublicProfile,
} from './types';
import { SAIDError } from './error';
import { parseAgentsTxt, parseWellKnownSaid } from './parser';

export class SAIDClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeout: number;

  constructor(options: SAIDClientOptions = {}) {
    this.baseUrl = (options.baseUrl || 'https://api.said.id/v1').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || 10000;
  }

  /**
   * Resolve an identity by DID or @handle.
   *
   * GET {baseUrl}/resolve/{didOrHandle}
   */
  async resolve(didOrHandle: string): Promise<ResolvedProfile> {
    const encoded = encodeURIComponent(didOrHandle);
    return this.request<ResolvedProfile>(`${this.baseUrl}/resolve/${encoded}`);
  }

  /**
   * Resolve a business by its domain.
   * Fetches agents.txt and .well-known/said.json from the domain.
   *
   * GET {baseUrl}/discover?domain={domain}
   */
  async resolveByDomain(domain: string): Promise<DomainDiscovery> {
    const encoded = encodeURIComponent(domain);
    return this.request<DomainDiscovery>(`${this.baseUrl}/discover?domain=${encoded}`);
  }

  /**
   * Fetch and parse agents.txt from a domain.
   * Makes a direct HTTP request to https://{domain}/agents.txt
   * and parses the result client-side.
   */
  async fetchAgentsTxt(domain: string): Promise<AgentsTxt> {
    const url = `https://${domain}/agents.txt`;
    const content = await this.fetchText(url);
    return parseAgentsTxt(content);
  }

  /**
   * Fetch and parse .well-known/said.json from a domain.
   * Makes a direct HTTP request to https://{domain}/.well-known/said.json
   * and parses the result client-side.
   */
  async fetchWellKnownSaid(domain: string): Promise<WellKnownSaid> {
    const url = `https://${domain}/.well-known/said.json`;
    const content = await this.fetchText(url);
    return parseWellKnownSaid(content);
  }

  /**
   * Get a public profile by DID (agent-facing).
   *
   * GET {baseUrl}/profile/{did}
   */
  async getPublicProfile(did: string): Promise<PublicProfile> {
    const encoded = encodeURIComponent(did);
    return this.request<PublicProfile>(`${this.baseUrl}/profile/${encoded}`);
  }

  /**
   * Internal helper: make a JSON API request with timeout and auth headers.
   */
  private async request<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
        let errorCode: string | undefined;

        try {
          const body = await response.json() as { error?: string; code?: string };
          if (body.error) {
            errorMessage = body.error;
          }
          if (body.code) {
            errorCode = body.code;
          }
        } catch {
          // Ignore JSON parse errors on error responses
        }

        throw new SAIDError(errorMessage, response.status, errorCode);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof SAIDError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new SAIDError(`Request timed out after ${this.timeout}ms`, undefined, 'TIMEOUT');
      }
      throw new SAIDError(
        `Network error: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        'NETWORK_ERROR'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Internal helper: fetch a URL and return the body as text.
   */
  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new SAIDError(
          `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
          response.status,
          'FETCH_ERROR'
        );
      }

      return await response.text();
    } catch (error) {
      if (error instanceof SAIDError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new SAIDError(`Request timed out after ${this.timeout}ms`, undefined, 'TIMEOUT');
      }
      throw new SAIDError(
        `Network error: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        'NETWORK_ERROR'
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
