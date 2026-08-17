import { containsForbiddenPublicPrivateAccountField } from "./private-account";
import { getHyperliquidExecutionVaultByAccount, getPrivateAccountByOwner } from "./private-account-store";
import { workerAuthorizationHeader, workerCapabilityExpectedFromBody } from "./private-agent-capability";
import { autopilotWorkerConfig } from "./private-agent-worker-readiness";
import { privateAgentEmergencyControlTransportAllowed } from "./private-agent-spend-policy";
import { authorizeLiveTradingRiskReduction } from "./live-trading-authorization.server";
import { canonicalLiveTradingCaps } from "./live-trading-contract";

export const HYPERLIQUID_CLOSE_CONFIRMATION =
  "I_UNDERSTAND_THIS_CLOSES_A_REAL_POSITION_REDUCE_ONLY";

const CLOSE_MARKETS = new Set(["BTC", "ETH", "SOL", "HYPE"]);

export interface HyperliquidCloseRequest {
  version: 1;
  market: "BTC" | "ETH" | "SOL" | "HYPE";
  idempotency_key: string;
  confirmation: typeof HYPERLIQUID_CLOSE_CONFIRMATION;
}

export interface HyperliquidRiskReductionEvidence {
  version: 1;
  proof_kind: "hyperliquid_position_close_v1" | "hyperliquid_kill_and_flat_v1";
  status: "reconciled";
  network: "mainnet" | "testnet";
  markets: string[];
  initial_position_count: number;
  initial_open_order_count: number;
  cancellations: Array<{
    market: string;
    work_order_commitment: string;
    venue_order_oid: string;
    terminal_status: "canceled";
    venue_readback_proven: true;
    replay_protected: true;
  }>;
  closes: Array<{
    market: string;
    work_order_commitment: string;
    venue_order_oid: string;
    venue_order_cloid: string;
    terminal_status: "filled";
    reduce_only: true;
    fill_count_bucket: "1" | "2-4" | "5+" | "unknown";
    fill_evidence_commitment: string;
    venue_readback_proven: true;
    replay_protected: true;
  }>;
  reduce_only_exit_proven: true;
  cancellations_terminal: true;
  market_flat: true;
  account_flat: boolean;
  open_order_count: number;
  final_flat_proven: true;
  reconciled_at: string;
  completed_at: string;
  root_work_order_commitment: string;
  evidence_commitment: string;
}

type RiskReductionResult =
  | { ok: true; report: HyperliquidRiskReductionEvidence }
  | { ok: false; error: string; status: number; reason_codes?: string[] };

export function parseHyperliquidCloseRequest(value: unknown): HyperliquidCloseRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const market = typeof body.market === "string" ? body.market.trim().toUpperCase() : "";
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (body.version !== 1 || !CLOSE_MARKETS.has(market) ||
      !/^[A-Za-z0-9._:-]{8,160}$/u.test(idempotencyKey) ||
      body.confirmation !== HYPERLIQUID_CLOSE_CONFIRMATION) return null;
  return {
    version: 1,
    market: market as HyperliquidCloseRequest["market"],
    idempotency_key: idempotencyKey,
    confirmation: HYPERLIQUID_CLOSE_CONFIRMATION,
  };
}

export async function closeHyperliquidPositionForOwner(input: {
  owner_commitment: string;
  web_session_token: string;
  request: HyperliquidCloseRequest;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<RiskReductionResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const authorization = await authorizeLiveTradingRiskReduction({
    owner_commitment: input.owner_commitment,
    web_session_token: input.web_session_token,
    emergency_action: "close",
    required_capabilities: ["reduce_only"],
    env,
    fetchImpl,
  });
  if (!authorization.ok) return authorization;
  if (!privateAgentEmergencyControlTransportAllowed("close", env, fetchImpl)) {
    return { ok: false, error: "private_agent_transport_blocked", status: 403 };
  }
  const [account, vault] = await Promise.all([
    getPrivateAccountByOwner(input.owner_commitment),
    getHyperliquidExecutionVaultByAccount(authorization.account_commitment),
  ]);
  if (!account || !vault || vault.owner_commitment !== input.owner_commitment || vault.status !== "sealed" ||
      vault.vault_commitment !== authorization.vault_commitment) {
    return { ok: false, error: "sealed_hyperliquid_vault_required", status: 409 };
  }
  const network = hyperliquidVaultNetwork(vault.vault.encrypted_execution_vault.aad);
  if (!network) return { ok: false, error: "hyperliquid_vault_network_invalid", status: 409 };
  const cfg = autopilotWorkerConfig(env);
  if (!cfg.url) return { ok: false, error: "private_worker_unavailable", status: 503 };
  const workerPath = "/hyperliquid/positions/close";
  const caps = canonicalLiveTradingCaps();
  const body = {
    version: 1,
    confirmation: HYPERLIQUID_CLOSE_CONFIRMATION,
    idempotency_key: input.request.idempotency_key,
    execution_mode: "byo_api_key",
    owner_commitment: input.owner_commitment,
    account_commitment: account.account_commitment,
    vault_commitment: vault.vault_commitment,
    policy_commitment: vault.policy_commitment,
    encrypted_execution_vault: vault.vault.encrypted_execution_vault,
    market: input.request.market,
    session_policy: {
      version: 1,
      policy_commitment: vault.policy_commitment,
      market_allowlist: [`${input.request.market}-USD`],
      max_notional_bucket: "100",
      max_order_count: 3,
      max_slippage_bps: caps.max_slippage_bps,
      execution_network: network,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      kill_switch: false,
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
    },
  };
  const workerAuth = workerAuthorizationHeader({
    env,
    fallbackToken: cfg.token,
    method: "POST",
    path: workerPath,
    scope: "order:submit",
    body,
    expected: workerCapabilityExpectedFromBody(body, {
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      operation_class: "reduce_only_close",
    }),
  });
  if (!workerAuth) return { ok: false, error: "private_worker_auth_unconfigured", status: 503 };
  const response = await fetchImpl(new URL(workerPath, cfg.url), {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: workerAuth,
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);
  if (!response) return { ok: false, error: "private_worker_unavailable", status: 503 };
  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const error = record(raw);
    return { ok: false, error: stringValue(error.error) || `private_worker_${response.status}`, status: response.status };
  }
  const report = normalizeCloseEvidence(raw, input.request.market, network);
  if (!report || containsForbiddenPublicPrivateAccountField(report)) {
    return { ok: false, error: "hyperliquid_close_evidence_invalid", status: 502 };
  }
  return { ok: true, report };
}

function normalizeCloseEvidence(
  value: unknown,
  expectedMarket: HyperliquidCloseRequest["market"],
  expectedNetwork: "mainnet" | "testnet",
): HyperliquidRiskReductionEvidence | null {
  const raw = record(value);
  const rawCloses = Array.isArray(raw.closes) ? raw.closes.map(record) : [];
  const rawCancellations = Array.isArray(raw.cancellations) ? raw.cancellations.map(record) : [];
  const closes = rawCloses.map((close) => normalizedPublicClose(close, expectedMarket));
  const cancellations = rawCancellations.map(normalizedPublicCancellation);
  const markets = stringArray(raw.markets);
  const initialPositionCount = countValue(raw.initial_position_count);
  const initialOpenOrderCount = countValue(raw.initial_open_order_count);
  const openOrderCount = countValue(raw.open_order_count);
  const reconciledAt = stringValue(raw.reconciled_at);
  const completedAt = stringValue(raw.completed_at);
  const rootWorkOrderCommitment = stringValue(raw.root_work_order_commitment);
  const evidenceCommitment = stringValue(raw.evidence_commitment);
  if (raw.version !== 1 || raw.proof_kind !== "hyperliquid_position_close_v1" || raw.status !== "reconciled" ||
      raw.network !== expectedNetwork || raw.market_flat !== true || raw.final_flat_proven !== true ||
      raw.reduce_only_exit_proven !== true || raw.cancellations_terminal !== true ||
      typeof raw.account_flat !== "boolean" || initialPositionCount < 1 || initialOpenOrderCount < 0 ||
      openOrderCount < 0 || markets.length !== 1 || markets[0] !== expectedMarket ||
      closes.length < 1 || closes.some((close) => !close) || cancellations.some((cancellation) => !cancellation) ||
      !validCommitment(evidenceCommitment) || !validCommitment(rootWorkOrderCommitment) ||
      !validIsoTime(reconciledAt) || !validIsoTime(completedAt)) return null;
  return {
    version: 1,
    proof_kind: "hyperliquid_position_close_v1",
    status: "reconciled",
    network: expectedNetwork,
    markets,
    initial_position_count: initialPositionCount,
    initial_open_order_count: initialOpenOrderCount,
    cancellations: cancellations as HyperliquidRiskReductionEvidence["cancellations"],
    closes: closes as HyperliquidRiskReductionEvidence["closes"],
    reduce_only_exit_proven: true,
    cancellations_terminal: true,
    market_flat: true,
    account_flat: raw.account_flat,
    open_order_count: openOrderCount,
    final_flat_proven: true,
    reconciled_at: reconciledAt,
    completed_at: completedAt,
    root_work_order_commitment: rootWorkOrderCommitment,
    evidence_commitment: evidenceCommitment,
  };
}

function normalizedPublicClose(
  close: Record<string, unknown>,
  expectedMarket: HyperliquidCloseRequest["market"],
): HyperliquidRiskReductionEvidence["closes"][number] | null {
  const workOrderCommitment = stringValue(close.work_order_commitment);
  const venueOrderOid = stringValue(close.venue_order_oid);
  const fillEvidenceCommitment = stringValue(close.fill_evidence_commitment);
  const fillCountBucket = stringValue(close.fill_count_bucket);
  if (close.market !== expectedMarket || close.terminal_status !== "filled" || close.reduce_only !== true ||
      close.venue_readback_proven !== true || close.replay_protected !== true ||
      !workOrderCommitment || !venueOrderOid || !validCommitment(fillEvidenceCommitment) ||
      !["1", "2-4", "5+", "unknown"].includes(fillCountBucket)) return null;
  return {
    market: expectedMarket,
    work_order_commitment: workOrderCommitment,
    venue_order_oid: venueOrderOid,
    venue_order_cloid: stringValue(close.venue_order_cloid),
    terminal_status: "filled",
    reduce_only: true,
    fill_count_bucket: fillCountBucket as HyperliquidRiskReductionEvidence["closes"][number]["fill_count_bucket"],
    fill_evidence_commitment: fillEvidenceCommitment,
    venue_readback_proven: true,
    replay_protected: true,
  };
}

function normalizedPublicCancellation(
  cancellation: Record<string, unknown>,
): HyperliquidRiskReductionEvidence["cancellations"][number] | null {
  const market = stringValue(cancellation.market);
  const workOrderCommitment = stringValue(cancellation.work_order_commitment);
  const venueOrderOid = stringValue(cancellation.venue_order_oid);
  if (!market || !workOrderCommitment || !venueOrderOid || cancellation.terminal_status !== "canceled" ||
      cancellation.venue_readback_proven !== true || cancellation.replay_protected !== true) return null;
  return {
    market,
    work_order_commitment: workOrderCommitment,
    venue_order_oid: venueOrderOid,
    terminal_status: "canceled",
    venue_readback_proven: true,
    replay_protected: true,
  };
}

function hyperliquidVaultNetwork(aad: string): "mainnet" | "testnet" | null {
  const part = aad.split("|").find((value) => value.startsWith("network:"));
  const value = part?.slice("network:".length);
  return value === "mainnet" || value === "testnet" ? value : null;
}

function validCommitment(value: unknown) {
  return /^[A-Za-z0-9_:-]{16,160}$/u.test(stringValue(value));
}

function validIsoTime(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function countValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : -1;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
