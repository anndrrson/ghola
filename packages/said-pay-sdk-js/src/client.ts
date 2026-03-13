import type {
  SAIDPayClientOptions,
  AgentWallet,
  Balances,
  Addresses,
  TransferRequest,
  TransferResult,
  CreateAgentRequest,
  PaymentTransaction,
  SpendingLimits,
  McpConfig,
} from './types';
import { SAIDPayError } from './error';

const DEFAULT_BASE_URL = 'https://api.said.id';
const DEFAULT_TIMEOUT = 30000;

export class SAIDPayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;

  constructor(options: SAIDPayClientOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...headers, ...init?.headers },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new SAIDPayError(
          `HTTP ${response.status}: ${body}`,
          response.status
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof SAIDPayError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SAIDPayError('Request timed out');
      }
      throw new SAIDPayError(
        err instanceof Error ? err.message : 'Unknown error'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Get SOL + USDC balances for an agent or owner wallet. */
  async getBalances(agent?: string): Promise<Balances> {
    const params = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    return this.request<Balances>(`/v1/pay/balance${params}`);
  }

  /** Get Solana address (deposit address) for an agent. */
  async getAddresses(agent?: string): Promise<Addresses> {
    const params = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    return this.request<Addresses>(`/v1/pay/address${params}`);
  }

  /** Send SOL or USDC, enforcing spending limits. */
  async transfer(req: TransferRequest): Promise<TransferResult> {
    return this.request<TransferResult>('/v1/pay/transfer', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  /** List all agent wallets with labels + addresses. */
  async listAgents(): Promise<AgentWallet[]> {
    return this.request<AgentWallet[]>('/v1/pay/agents');
  }

  /** Create a new agent wallet with spending policy. */
  async createAgent(req: CreateAgentRequest): Promise<AgentWallet> {
    return this.request<AgentWallet>('/v1/pay/agents', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  /** View transaction history for an agent. */
  async getHistory(
    agent?: string,
    limit?: number
  ): Promise<PaymentTransaction[]> {
    const params = new URLSearchParams();
    if (agent) params.set('agent', agent);
    if (limit) params.set('limit', limit.toString());
    const qs = params.toString();
    return this.request<PaymentTransaction[]>(
      `/v1/pay/history${qs ? '?' + qs : ''}`
    );
  }

  /** View spending limits + 24h usage for an agent. */
  async getSpendingLimits(agent: string): Promise<SpendingLimits> {
    return this.request<SpendingLimits>(
      `/v1/pay/spending/${encodeURIComponent(agent)}`
    );
  }

  /** Get MCP server config for use with Claude or other AI tools. */
  mcp(): McpConfig {
    return {
      command: 'said-mcp',
      args: [],
      env: this.apiKey ? { SAID_API_KEY: this.apiKey } : undefined,
    };
  }
}
