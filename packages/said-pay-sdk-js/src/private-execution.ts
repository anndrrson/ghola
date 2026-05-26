export interface GholaPrivateExecutionClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
}

export interface PrivateExecutionEncryptedBundleV1 {
  alg: 'sealed-provider-v1' | 'hpke-x25519-aes256gcm';
  ciphertext: string;
  recipient: string;
  aad: string;
  encapsulated_key?: string;
}

export interface PrivateExecutionExecuteRequestV1 {
  version: 1;
  intent_id: string;
  owner_did: string;
  policy_hash: string;
  proposal_hash: string;
  amount_micro_usdc: number;
  rail: 'railgun_private_swap';
  encrypted_intent_bundle: PrivateExecutionEncryptedBundleV1;
  provider_result?: PrivateExecutionProviderResultV1;
}

export interface PrivateExecutionProviderResultV1 {
  version: 1;
  provider_id: string;
  rail: 'railgun_private_swap';
  tx_ref: string;
  policy_hash: string;
  proposal_hash: string;
  amount_micro_usdc: number;
  fee_micro_usdc: number;
  fee_recipient: string;
  executed_at: string;
  signature: string;
}

export interface PrivateExecutionFeeQuoteV1 {
  version: 1;
  fee_bps: number;
  min_fee_micro_usdc: number;
  amount_micro_usdc: number;
  fee_micro_usdc: number;
  fee_recipient: string;
}

export interface PrivateExecutionReceiptV1 {
  version: 1;
  receipt_id: string;
  intent_id: string;
  agent_id: string;
  policy_hash: string;
  proposal_hash: string;
  rail: 'railgun_private_swap';
  amount_micro_usdc: number;
  fee_quote: PrivateExecutionFeeQuoteV1;
  provider_id: string;
  executed_at: string;
  tx_ref: string;
  public_fallback_used: false;
  signature: string;
}

export interface PrivateExecutionStatusV1 {
  version: 1;
  ready: boolean;
  supported_rails: Array<'railgun_private_swap'>;
  fee_bps: number;
  min_fee_micro_usdc: number;
  fee_recipient_configured: boolean;
  shielded_rail_ready: boolean;
  sealed_provider_ready: boolean;
  provider_result_required: boolean;
  blocking_reasons: string[];
}

export interface PrivateExecutionSimulateRequestV1 {
  version: 1;
  policy: unknown;
  proposal: unknown;
}

export interface PrivateExecutionSimulateResponseV1 {
  version: 1;
  ok: boolean;
  policy_hash: string;
  proposal_hash: string;
  guard: unknown;
  fee_quote?: PrivateExecutionFeeQuoteV1;
  exposure_report: {
    public_fallback_allowed: false;
    expected_public_leakage:
      | 'none_expected_shielded_execution'
      | 'blocked_before_execution';
    blocked_reason?: string;
  };
}

export interface PrivateExecutionExecuteResponseV1 {
  version: 1;
  ok: true;
  receipt: PrivateExecutionReceiptV1;
}

export interface PrivateExecutionVerifyResponseV1 {
  version: 1;
  ok: boolean;
  error?: string;
}

export interface PrivateExecutionReceiptRecordV1 {
  version: 1;
  receipt_id: string;
  intent_id: string;
  agent_id: string;
  agent_label: string;
  policy_hash: string;
  proposal_hash: string;
  rail: 'railgun_private_swap';
  amount_micro_usdc: number;
  fee_micro_usdc: number;
  fee_recipient: string;
  provider_id: string;
  tx_ref: string;
  receipt: PrivateExecutionReceiptV1;
  created_at: string;
}

export interface PrivateExecutionUsageSummaryV1 {
  version: 1;
  agent_id: string;
  execution_count: number;
  total_volume_micro_usdc: number;
  total_fee_micro_usdc: number;
  latest_receipts: PrivateExecutionReceiptRecordV1[];
}

const DEFAULT_BASE_URL = 'https://ghola.xyz';
const DEFAULT_TIMEOUT = 30000;
const PLAINTEXT_LEAK_KEYS = new Set([
  'financial_context',
  'messages',
  'plaintext',
  'portfolio',
  'prompt',
  'source',
  'strategy',
  'strategy_text',
  'system_prompt',
]);

export class GholaPrivateExecutionClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;

  constructor(options: GholaPrivateExecutionClientOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  async getPrivateExecutionStatus(): Promise<PrivateExecutionStatusV1> {
    return this.request<PrivateExecutionStatusV1>('/v1/private-intents/status');
  }

  async simulatePrivateIntent(
    intent: PrivateExecutionSimulateRequestV1,
  ): Promise<PrivateExecutionSimulateResponseV1> {
    return this.request<PrivateExecutionSimulateResponseV1>(
      '/v1/private-intents/simulate',
      {
        method: 'POST',
        body: JSON.stringify(intent),
      },
    );
  }

  async executePrivateIntent(
    intent: PrivateExecutionExecuteRequestV1,
  ): Promise<PrivateExecutionReceiptV1> {
    if (containsPlaintextLeak(intent)) {
      throw new Error(
        'Private execution request must not contain plaintext strategy, prompt, messages, portfolio, or financial context.',
      );
    }
    const response = await this.request<PrivateExecutionExecuteResponseV1>(
      '/v1/private-intents/execute',
      {
        method: 'POST',
        body: JSON.stringify(intent),
      },
    );
    return response.receipt;
  }

  async verifyPrivateExecutionReceipt(
    receipt: PrivateExecutionReceiptV1,
  ): Promise<PrivateExecutionVerifyResponseV1> {
    return this.request<PrivateExecutionVerifyResponseV1>(
      '/v1/private-intents/verify',
      {
        method: 'POST',
        body: JSON.stringify({ receipt }),
      },
    );
  }

  async getPrivateExecutionUsage(): Promise<PrivateExecutionUsageSummaryV1> {
    return this.request<PrivateExecutionUsageSummaryV1>(
      '/v1/private-intents/usage',
    );
  }

  async listPrivateExecutionReceipts(
    limit = 25,
  ): Promise<PrivateExecutionReceiptRecordV1[]> {
    const response = await this.request<{
      version: 1;
      data: PrivateExecutionReceiptRecordV1[];
    }>(`/v1/private-intents/receipts?limit=${encodeURIComponent(limit)}`);
    return response.data;
  }

  async getPrivateExecutionReceipt(
    receiptId: string,
  ): Promise<PrivateExecutionReceiptRecordV1> {
    return this.request<PrivateExecutionReceiptRecordV1>(
      `/v1/private-intents/receipts/${encodeURIComponent(receiptId)}`,
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GHOLA private execution HTTP ${res.status}: ${body}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function containsPlaintextLeak(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsPlaintextLeak);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PLAINTEXT_LEAK_KEYS.has(key)) return true;
    if (containsPlaintextLeak(child)) return true;
  }
  return false;
}
