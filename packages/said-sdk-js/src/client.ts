import type {
  SAIDClientOptions,
  ResolvedProfile,
  DomainDiscovery,
  AgentsTxt,
  WellKnownSaid,
  PublicProfile,
  ServiceSearchResult,
  ServiceSearchOptions,
  ServiceListing,
  VerifyAgentResult,
  ReputationScore,
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

  // ── Headless Merchant Economy Methods ──

  /**
   * Search the service registry for headless merchants.
   *
   * GET {baseUrl}/services/resolve?task={query}&...
   */
  async searchServices(query: string, options?: ServiceSearchOptions): Promise<ServiceSearchResult[]> {
    const params = new URLSearchParams({ task: query });
    if (options?.category) params.set('category', options.category);
    if (options?.maxPriceMicroUsdc !== undefined) params.set('max_price_micro_usdc', String(options.maxPriceMicroUsdc));
    if (options?.minUptime !== undefined) params.set('min_uptime', String(options.minUptime));
    if (options?.minRating !== undefined) params.set('min_rating', String(options.minRating));
    if (options?.minTrustScore !== undefined) params.set('min_trust_score', String(options.minTrustScore));
    if (options?.authType) params.set('auth_type', options.authType);
    if (options?.region) params.set('region', options.region);
    if (options?.limit !== undefined) params.set('limit', String(options.limit));

    const result = await this.request<{ services: ServiceSearchResult[] }>(
      `${this.baseUrl}/services/resolve?${params.toString()}`
    );
    return result.services;
  }

  /**
   * Get detailed information about a service by slug or ID.
   *
   * GET {baseUrl}/services/{slugOrId}
   */
  async getService(slugOrId: string): Promise<ServiceListing> {
    const result = await this.request<{ service: ServiceListing }>(
      `${this.baseUrl}/services/${encodeURIComponent(slugOrId)}`
    );
    return result.service;
  }

  /**
   * Verify an agent's identity and capabilities.
   * Requires a service API key (set via X-Service-Key header).
   *
   * POST {baseUrl}/verify/agent
   */
  async verifyAgent(
    agentDid: string,
    ucanToken?: string,
    capabilities?: string[],
    serviceKey?: string,
  ): Promise<VerifyAgentResult> {
    const body: Record<string, unknown> = { agent_did: agentDid };
    if (ucanToken) body.ucan_token = ucanToken;
    if (capabilities) body.required_capabilities = capabilities;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    if (serviceKey) headers['X-Service-Key'] = serviceKey;
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    try {
      const response = await fetch(`${this.baseUrl}/verify/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return (await response.json()) as VerifyAgentResult;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get the reputation/trust score for a DID.
   *
   * GET {baseUrl}/reputation/{did}
   */
  async getTrustScore(did: string): Promise<ReputationScore> {
    return this.request<ReputationScore>(
      `${this.baseUrl}/reputation/${encodeURIComponent(did)}`
    );
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
