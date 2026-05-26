export interface GholaTreasuryClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
}

export type TreasuryIntentObjective =
  | 'maintain_runway'
  | 'optimize_idle_cash'
  | 'fund_payment_schedule'
  | 'rebalance_treasury_risk';

export type TreasuryRailKind =
  | 'bank_cash'
  | 'treasury_bills'
  | 'bond_ladder'
  | 'broker_cash_sweep'
  | 'stablecoin_public'
  | 'stablecoin_shielded'
  | 'ach'
  | 'wire'
  | 'rtp';

export type TreasuryAsset =
  | 'USD'
  | 'USDC'
  | 'USDT'
  | 'T_BILL'
  | 'BOND_FUND'
  | 'BROKER_SWEEP';

export interface TreasuryEncryptedBundleV1 {
  alg: 'sealed-provider-v1' | 'hpke-x25519-aes256gcm';
  ciphertext: string;
  recipient: string;
  aad: string;
  encapsulated_key?: string;
}

export interface TreasuryIntentV1 {
  version: 1;
  intent_id: string;
  owner_did: string;
  objective: TreasuryIntentObjective;
  horizon_days: number;
  amount_micro_usd?: number;
  constraints: {
    min_operating_cash_micro_usd: number;
    min_instant_liquidity_micro_usd: number;
    min_runway_months: number;
    max_single_bank_exposure_bps: number;
    max_stablecoin_issuer_exposure_bps: number;
    max_duration_days: number;
    approved_rails: TreasuryRailKind[];
    approval_required_above_micro_usd: number;
    public_fallback_allowed: false;
  };
  encrypted_context_bundle: TreasuryEncryptedBundleV1;
}

export interface TreasuryPolicyV1 {
  version: 1;
  policy_id: string;
  owner_did: string;
  allowed_assets: TreasuryAsset[];
  allowed_payment_rails: TreasuryRailKind[];
  allowed_rails?: TreasuryRailKind[];
  allowed_partners: string[];
  max_action_micro_usd: number;
  daily_action_micro_usd: number;
  approval_required_above_micro_usd: number;
  public_fallback_allowed: false;
}

export interface TreasurySimulateRequestV1 {
  version: 1;
  policy: TreasuryPolicyV1;
  intent: TreasuryIntentV1;
}

export interface TreasuryRunRequestV1 extends TreasurySimulateRequestV1 {
  execute?: boolean;
}

export interface TreasuryApprovalV1 {
  version: 1;
  approval_hash: string;
  expires_at: string;
  scope: 'treasury_proposal';
}

export interface TreasuryRouteCandidateV1 {
  version: 1;
  route_id: string;
  rail: TreasuryRailKind;
  action:
    | 'reserve_operating_cash'
    | 'sweep_broker_cash'
    | 'ladder_t_bills'
    | 'ladder_bonds'
    | 'hold_stablecoin_buffer'
    | 'prepare_payment_buffer';
  asset: TreasuryAsset;
  amount_micro_usd: number;
  partner_id: string;
  settlement_eta: 'instant' | 'same_day' | 'next_day' | 'scheduled';
  liquidity_class: 'instant' | 'same_day' | 'scheduled' | 'term';
  max_duration_days?: number;
  expected_yield_bps?: number;
  leakage_score_bps: number;
  route_score_bps: number;
  score_components: {
    yield_bps: number;
    liquidity_bps: number;
    leakage_penalty_bps: number;
    risk_penalty_bps: number;
    duration_penalty_bps: number;
  };
  privacy:
    | 'private_context_partner_instruction'
    | 'shielded_settlement_subject_to_timing'
    | 'public_settlement_amount_timing_visible';
  risk_flags: string[];
}

export interface TreasuryProposalV1 {
  version: 1;
  proposal_id: string;
  intent_id: string;
  owner_did: string;
  objective: TreasuryIntentObjective;
  created_at: string;
  horizon_days: number;
  amount_micro_usd: number;
  routes: TreasuryRouteCandidateV1[];
  approval_required: boolean;
  public_fallback_allowed: false;
}

export interface TreasurySimulationResponseV1 {
  version: 1;
  ok: boolean;
  policy_hash: string;
  intent_hash: string;
  proposal_hash: string;
  proposal: TreasuryProposalV1;
  approval?: TreasuryApprovalV1;
  guard: unknown;
  exposure_report: {
    public_fallback_allowed: false;
    expected_public_leakage:
      | 'sealed_context_partner_instructions_only'
      | 'blocked_before_execution';
    leakage_score_bps: number;
    blocked_reason?: string;
  };
}

export interface TreasuryExecuteRequestV1 {
  version: 1;
  intent_id: string;
  owner_did: string;
  policy_hash: string;
  proposal_hash: string;
  approval_hash: string;
  approval_expires_at: string;
  amount_micro_usd: number;
  rails: TreasuryRailKind[];
  encrypted_context_bundle: TreasuryEncryptedBundleV1;
}

export interface TreasuryExecutionReceiptV1 {
  version: 1;
  receipt_id: string;
  intent_id: string;
  owner_did: string;
  agent_id: string;
  policy_hash: string;
  proposal_hash: string;
  approval_hash: string;
  approval_expires_at: string;
  amount_micro_usd: number;
  rails: TreasuryRailKind[];
  provider_id: string;
  partner_refs: string[];
  reconciliation_state: 'submitted';
  executed_at: string;
  public_fallback_used: false;
  signature: string;
}

export interface TreasuryExecuteResponseV1 {
  version: 1;
  ok: true;
  receipt: TreasuryExecutionReceiptV1;
  reconciliation_state: 'submitted';
  partner_refs: string[];
}

export interface TreasuryPartnerReconciliationV1 {
  version: 1;
  rail: TreasuryRailKind;
  partner_ref: string;
  reconciliation_state: 'submitted' | 'settled' | 'failed' | 'cancelled';
}

export interface TreasuryReconcileResponseV1 {
  version: 1;
  ok: true;
  intent_id: string;
  reconciliation_state: 'submitted' | 'settled' | 'failed' | 'cancelled';
  reconciliations: TreasuryPartnerReconciliationV1[];
  partner_refs: string[];
}

export interface TreasuryCancelResponseV1 {
  version: 1;
  ok: true;
  intent_id: string;
  reconciliation_state: 'submitted' | 'settled' | 'failed' | 'cancelled';
  reconciliations: TreasuryPartnerReconciliationV1[];
  partner_refs: string[];
}

export type TreasuryRunResponseV1 =
  | {
      version: 1;
      ok: true;
      action: 'executed';
      simulation: TreasurySimulationResponseV1;
      receipt: TreasuryExecutionReceiptV1;
      reconciliation_state: 'submitted';
      partner_refs: string[];
    }
  | {
      version: 1;
      ok: true;
      action: 'simulated';
      simulation: TreasurySimulationResponseV1;
    }
  | {
      version: 1;
      ok: false;
      action: 'blocked' | 'approval_required';
      approval?: TreasuryApprovalV1;
      simulation: TreasurySimulationResponseV1;
    };

export interface TreasuryExecutionStatusV1 {
  version: 1;
  ready: boolean;
  supported_rails: TreasuryRailKind[];
  partner_rail_ready: boolean;
  sealed_provider_ready: boolean;
  blocking_reasons: string[];
}

export interface TreasuryIntentStatusV1 {
  version: 1;
  intent_id: string;
  ready: boolean;
  reconciliation_state:
    | 'not_found'
    | 'simulated'
    | 'submitted'
    | 'settled'
    | 'cancelled'
    | 'failed';
  policy_hash?: string;
  proposal_hash?: string;
  approval_hash?: string | null;
  receipt_id?: string | null;
  partner_refs: string[];
  partner_reconciliations: TreasuryPartnerReconciliationV1[];
  blocking_reasons: string[];
  updated_at?: string;
}

export interface TreasuryVerifyResponseV1 {
  version: 1;
  ok: boolean;
  error?: string;
}

const DEFAULT_BASE_URL = 'https://ghola.xyz';
const DEFAULT_TIMEOUT = 30000;
const PLAINTEXT_LEAK_KEYS = new Set([
  'account_number',
  'balance',
  'balances',
  'bank_account',
  'cash_balance',
  'counterparties',
  'counterparty_list',
  'financial_context',
  'invoice',
  'invoices',
  'messages',
  'payroll',
  'payroll_details',
  'plaintext',
  'portfolio',
  'prompt',
  'strategy',
  'strategy_text',
  'system_prompt',
  'vendor',
  'vendors',
]);

export class GholaTreasuryClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;

  constructor(options: GholaTreasuryClientOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  async getTreasuryStatus(): Promise<TreasuryExecutionStatusV1> {
    return this.request<TreasuryExecutionStatusV1>('/v1/treasury-intents/status');
  }

  async simulateTreasuryIntent(
    req: TreasurySimulateRequestV1,
  ): Promise<TreasurySimulationResponseV1> {
    this.assertNoPlaintext(req);
    return this.request<TreasurySimulationResponseV1>(
      '/v1/treasury-intents/simulate',
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    );
  }

  async runTreasuryIntent(
    req: TreasuryRunRequestV1,
  ): Promise<TreasuryRunResponseV1> {
    this.assertNoPlaintext(req);
    return this.request<TreasuryRunResponseV1>('/v1/treasury-intents/run', {
      method: 'POST',
      body: JSON.stringify(req),
      allowStatus: [409],
    });
  }

  async executeTreasuryIntent(
    req: TreasuryExecuteRequestV1,
  ): Promise<TreasuryExecuteResponseV1> {
    this.assertNoPlaintext(req);
    return this.request<TreasuryExecuteResponseV1>(
      '/v1/treasury-intents/execute',
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    );
  }

  async reconcileTreasuryIntent(
    intentId: string,
  ): Promise<TreasuryReconcileResponseV1> {
    return this.request<TreasuryReconcileResponseV1>(
      '/v1/treasury-intents/reconcile',
      {
        method: 'POST',
        body: JSON.stringify({ version: 1, intent_id: intentId }),
      },
    );
  }

  async cancelTreasuryIntent(intentId: string): Promise<TreasuryCancelResponseV1> {
    return this.request<TreasuryCancelResponseV1>(
      '/v1/treasury-intents/cancel',
      {
        method: 'POST',
        body: JSON.stringify({ version: 1, intent_id: intentId }),
      },
    );
  }

  async getTreasuryIntentStatus(
    intentId: string,
  ): Promise<TreasuryIntentStatusV1> {
    return this.request<TreasuryIntentStatusV1>(
      `/v1/treasury-intents/status/${encodeURIComponent(intentId)}`,
    );
  }

  async verifyTreasuryReceipt(
    receipt: TreasuryExecutionReceiptV1,
  ): Promise<TreasuryVerifyResponseV1> {
    return this.request<TreasuryVerifyResponseV1>(
      '/v1/treasury-intents/verify',
      {
        method: 'POST',
        body: JSON.stringify({ receipt }),
      },
    );
  }

  private assertNoPlaintext(value: unknown) {
    if (containsPlaintextLeak(value)) {
      throw new Error(
        'Treasury execution requests must not contain plaintext balances, payroll details, counterparties, portfolio, strategy, or financial context.',
      );
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit & { allowStatus?: number[] } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const { allowStatus = [], ...fetchInit } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...fetchInit,
        headers: { ...headers, ...fetchInit.headers },
        signal: controller.signal,
      });
      if (!res.ok && !allowStatus.includes(res.status)) {
        const body = await res.text().catch(() => '');
        throw new Error(`GHOLA treasury execution HTTP ${res.status}: ${body}`);
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
