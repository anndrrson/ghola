import {
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "@/lib/private-agent-runtime";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import { gholaCommitment } from "@/lib/private-account";
import {
  getPooledWorkerReadiness,
  type PooledWorkerReadiness,
} from "@/lib/private-account-pooled-readiness";
import {
  signPublicPrivateAgentDemoRun,
  type PublicPrivateAgentDemoVerificationResult,
} from "@/lib/private-account-demo-receipt";

type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

const WORKER_PUBLIC_RECIPIENT_PATH = "/.well-known/private-agent-recipient";
const WORKER_HEALTH_PATH = "/health";
const DEFAULT_SCENARIO_ID = "btc_momentum";
const DEFAULT_MARKET_ID = "BTC-USD";

const PUBLIC_DEMO_VENUES = ["phoenix", "hyperliquid", "jupiter", "coinbase"] as const;
const PUBLIC_DEMO_MARKETS = ["BTC-USD", "ETH-USD", "SOL-USD", "SOL/USDC"] as const;
const PUBLIC_DEMO_SCENARIOS = [
  "btc_momentum",
  "eth_risk_rebalance",
  "sol_perps_scout",
  "custom_private_intent",
] as const;

type PublicDemoVenueId = (typeof PUBLIC_DEMO_VENUES)[number];
type PublicDemoScenarioId = (typeof PUBLIC_DEMO_SCENARIOS)[number];
type PublicDemoMarketId = (typeof PUBLIC_DEMO_MARKETS)[number];

export type PublicPrivateAgentDemoStatus = "green" | "degraded" | "blocked";

export interface PublicPrivateAgentWorkerPublicStatus {
  endpoint_configured: boolean;
  endpoint_url_commitment: string | null;
  reachable: boolean;
  ready: boolean;
  attested_ready: boolean;
  provider: string | null;
  tee_kind: string | null;
  recipient_id: string | null;
  recipient_commitment: string | null;
  image_digest_commitment: string | null;
  report_data_commitment: string | null;
  quote_hash_commitment: string | null;
  reason_codes: string[];
}

export interface PublicPrivateAgentDemoCapabilities {
  version: 1;
  checked_at: string;
  status: PublicPrivateAgentDemoStatus;
  demo_mode: "public_no_wallet_no_deposit_no_submit";
  remote_execution_ready: boolean;
  selected_provider: string | null;
  provider: {
    id: string | null;
    attested: boolean;
    sealed_recipient_published: boolean;
    supports_background_agents: boolean;
    supports_trading_execution: boolean;
    evidence_commitment: string | null;
  };
  worker: PublicPrivateAgentWorkerPublicStatus;
  capabilities: Array<{
    id:
      | "attested_worker_live"
      | "sealed_recipient_published"
      | "policy_checked_execution_ticket"
      | "no_submit_demo_ready"
      | "jurisdiction_gated_live_submit";
    status: PublicPrivateAgentDemoStatus;
    reason_codes: string[];
    evidence_commitment: string | null;
  }>;
  venue_gates: PooledWorkerReadiness["venues"];
  live_submit: {
    status: "available" | "gated" | "blocked";
    public_no_wallet_submit: false;
    reason_codes: string[];
    ready_venues: PublicDemoVenueId[];
    blocked_venues: PublicDemoVenueId[];
  };
  disclosure: string;
}

export interface PublicPrivateAgentDemoRunRequest {
  scenario_id?: unknown;
  venue_id?: unknown;
  market_id?: unknown;
  intent?: unknown;
  notional_bucket?: unknown;
  max_slippage_bps?: unknown;
}

export interface PublicPrivateAgentDemoRun {
  version: 1;
  checked_at: string;
  status: "verified_no_submit_structural" | "degraded" | "blocked";
  demo_run_id: string;
  execution_mode: "public_no_submit";
  wallet_required: false;
  deposit_required: false;
  broadcast: false;
  scenario: {
    scenario_id: PublicDemoScenarioId;
    venue_id: PublicDemoVenueId;
    market_id: PublicDemoMarketId;
    notional_bucket: string;
    max_slippage_bps: number;
  };
  execution_ticket: {
    version: 1;
    ticket_id: string;
    policy_commitment: string;
    private_intent_commitment: string;
    strategy_commitment: string;
    sealed_envelope_commitment: string;
    work_order_commitment: string;
    attestation_commitment: string;
    result_commitment: string;
    expires_at: string;
  };
  proof_chain: Array<{
    step: string;
    commitment: string;
  }>;
  worker: PublicPrivateAgentWorkerPublicStatus;
  venue_gate: PooledWorkerReadiness["venues"][PublicDemoVenueId];
  live_submit: PublicPrivateAgentDemoCapabilities["live_submit"];
  visibility_summary: {
    public_view: string[];
    ghola_operator_view: "commitments_and_ciphertexts_only";
    worker_view: "sealed_instruction_after_recipient_unseal";
    venue_view: "none_no_order_submitted";
    chain_view: "none_no_transaction_broadcast";
  };
  verification?: PublicPrivateAgentDemoVerificationResult;
  disclosure: string;
}

export interface PublicPrivateAgentDemoInput {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: Date;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  pooledReadiness?: PooledWorkerReadiness;
  workerStatus?: PublicPrivateAgentWorkerPublicStatus;
}

export async function getPublicPrivateAgentDemoCapabilities(
  input: PublicPrivateAgentDemoInput = {},
): Promise<PublicPrivateAgentDemoCapabilities> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();

  const [runtime, pooledReadiness, workerStatus] = await Promise.all([
    input.runtimeStatus ?? getPrivateAgentRuntimeStatus(),
    input.pooledReadiness ?? getPooledWorkerReadiness(env, fetchImpl as typeof fetch),
    input.workerStatus ?? getWorkerPublicStatus(env, fetchImpl, now),
  ]);

  return buildPublicPrivateAgentDemoCapabilities({
    runtime,
    pooledReadiness,
    workerStatus,
    checkedAt: now.toISOString(),
  });
}

export function buildPublicPrivateAgentDemoCapabilities(input: {
  runtime: PrivateAgentRuntimeStatus;
  pooledReadiness: PooledWorkerReadiness;
  workerStatus: PublicPrivateAgentWorkerPublicStatus;
  checkedAt: string;
}): PublicPrivateAgentDemoCapabilities {
  const selectedProvider = selectedRuntimeProvider(input.runtime);
  const workerLive =
    input.runtime.remote_execution_ready === true &&
    input.workerStatus.reachable &&
    input.workerStatus.ready &&
    input.workerStatus.attested_ready;
  const sealedRecipientPublished = Boolean(
    input.workerStatus.recipient_id &&
      input.workerStatus.recipient_commitment &&
      selectedProvider?.sealed_recipient,
  );
  const readyVenues = PUBLIC_DEMO_VENUES.filter((venue) => input.pooledReadiness.venues[venue]?.ready);
  const blockedVenues = PUBLIC_DEMO_VENUES.filter((venue) => !input.pooledReadiness.venues[venue]?.ready);
  const liveSubmitReasonCodes = liveSubmitReasonCodesFromReadiness(input.pooledReadiness);
  const liveSubmitStatus =
    input.pooledReadiness.ready && liveSubmitReasonCodes.length === 0
      ? "available"
      : input.workerStatus.reachable
        ? "gated"
        : "blocked";
  const status: PublicPrivateAgentDemoStatus =
    workerLive && sealedRecipientPublished
      ? "green"
      : "degraded";
  const providerEvidenceCommitment = selectedProvider
    ? gholaCommitment("public_demo_provider_evidence", {
        provider_id: selectedProvider.id,
        evidence: selectedProvider.evidence ?? null,
        sealed_recipient: selectedProvider.sealed_recipient
          ? {
              recipient_id: selectedProvider.sealed_recipient.recipient_id,
              tee_kind: selectedProvider.sealed_recipient.tee_kind ?? null,
              measurement_hex: selectedProvider.sealed_recipient.measurement_hex ?? null,
              attestation_hash: selectedProvider.sealed_recipient.attestation_hash ?? null,
            }
          : null,
      })
    : null;

  return {
    version: 1,
    checked_at: input.checkedAt,
    status,
    demo_mode: "public_no_wallet_no_deposit_no_submit",
    remote_execution_ready: input.runtime.remote_execution_ready,
    selected_provider: input.runtime.selected_provider,
    provider: {
      id: selectedProvider?.id ?? null,
      attested: selectedProvider?.attested === true,
      sealed_recipient_published: sealedRecipientPublished,
      supports_background_agents: selectedProvider?.supports_background_agents === true,
      supports_trading_execution: selectedProvider?.supports_trading_execution === true,
      evidence_commitment: providerEvidenceCommitment,
    },
    worker: input.workerStatus,
    capabilities: [
      {
        id: "attested_worker_live",
        status: workerLive ? "green" : status,
        reason_codes: workerLive ? [] : workerLiveReasonCodes(input.runtime, input.workerStatus),
        evidence_commitment: input.workerStatus.quote_hash_commitment,
      },
      {
        id: "sealed_recipient_published",
        status: sealedRecipientPublished ? "green" : "blocked",
        reason_codes: sealedRecipientPublished ? [] : ["sealed_recipient_missing_or_unverified"],
        evidence_commitment: input.workerStatus.recipient_commitment,
      },
      {
        id: "policy_checked_execution_ticket",
        status: workerLive ? "green" : status,
        reason_codes: workerLive ? [] : ["attested_worker_required_for_policy_ticket"],
        evidence_commitment: gholaCommitment("public_demo_policy_ticket_capability", {
          worker: input.workerStatus.recipient_commitment,
          runtime: input.runtime.selected_provider,
          ready_venues: readyVenues,
        }),
      },
      {
        id: "no_submit_demo_ready",
        status: "green",
        reason_codes: [],
        evidence_commitment: gholaCommitment("public_demo_no_submit_capability", {
          mode: "public_no_submit",
          worker: input.workerStatus.recipient_commitment,
          endpoint: input.workerStatus.endpoint_url_commitment,
        }),
      },
      {
        id: "jurisdiction_gated_live_submit",
        status: liveSubmitStatus === "available" ? "green" : "degraded",
        reason_codes: liveSubmitReasonCodes,
        evidence_commitment: gholaCommitment("public_demo_live_submit_gate", {
          status: liveSubmitStatus,
          ready_venues: readyVenues,
          blocked_venues: blockedVenues,
          reason_codes: liveSubmitReasonCodes,
        }),
      },
    ],
    venue_gates: input.pooledReadiness.venues,
    live_submit: {
      status: liveSubmitStatus,
      public_no_wallet_submit: false,
      reason_codes: liveSubmitReasonCodes,
      ready_venues: readyVenues,
      blocked_venues: blockedVenues,
    },
    disclosure:
      "This public demo proves the Ghola private-agent backend path without requiring a visitor wallet, deposit, exchange account, or order broadcast. Live order submission remains gated by venue credentials, funding canaries, user eligibility, and jurisdiction checks.",
  };
}

export async function buildPublicPrivateAgentDemoRun(
  body: PublicPrivateAgentDemoRunRequest = {},
  input: PublicPrivateAgentDemoInput = {},
): Promise<PublicPrivateAgentDemoRun> {
  // Reviewer traffic is deliberately observation-only. Paid confidential
  // compute may be started only by the authenticated, allowance-gated runtime
  // wake route; a public no-submit proof must never provision or renew it.
  const capabilities = await getPublicPrivateAgentDemoCapabilities(input);
  const run = buildPublicPrivateAgentDemoRunFromCapabilities(
    body,
    capabilities,
    input.now ?? new Date(),
  );
  return {
    ...run,
    verification: signPublicPrivateAgentDemoRun(run, input.env ?? process.env),
  };
}

export function buildPublicPrivateAgentDemoRunFromCapabilities(
  body: PublicPrivateAgentDemoRunRequest = {},
  capabilities: PublicPrivateAgentDemoCapabilities,
  now: Date = new Date(),
): PublicPrivateAgentDemoRun {
  const scenario = normalizeDemoRunRequest(body, capabilities);
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const customIntentCommitment =
    typeof body.intent === "string" && body.intent.trim()
      ? gholaCommitment("public_demo_custom_intent", body.intent.trim())
      : null;
  const policySeed = {
    version: 1,
    demo_mode: capabilities.demo_mode,
    execution_mode: "public_no_submit",
    venue_id: scenario.venue_id,
    market_id: scenario.market_id,
    notional_bucket: scenario.notional_bucket,
    max_slippage_bps: scenario.max_slippage_bps,
    worker_recipient: capabilities.worker.recipient_commitment,
    no_wallet_submit: true,
    live_submit_status: capabilities.live_submit.status,
    live_submit_reason_codes: capabilities.live_submit.reason_codes,
  };
  const policyCommitment = gholaCommitment("public_demo_policy", policySeed);
  const privateIntentCommitment = gholaCommitment("public_demo_private_intent", {
    scenario_id: scenario.scenario_id,
    venue_id: scenario.venue_id,
    market_id: scenario.market_id,
    notional_bucket: scenario.notional_bucket,
    custom_intent_commitment: customIntentCommitment,
  });
  const strategyCommitment = gholaCommitment("public_demo_strategy", {
    scenario_id: scenario.scenario_id,
    market_id: scenario.market_id,
    private_intent_commitment: privateIntentCommitment,
    policy_commitment: policyCommitment,
  });
  const sealedEnvelopeCommitment = gholaCommitment("public_demo_sealed_envelope", {
    recipient: capabilities.worker.recipient_commitment,
    strategy_commitment: strategyCommitment,
    private_intent_commitment: privateIntentCommitment,
  });
  const workOrderCommitment = gholaCommitment("public_demo_work_order", {
    policy_commitment: policyCommitment,
    sealed_envelope_commitment: sealedEnvelopeCommitment,
    worker: capabilities.worker.recipient_commitment,
    venue_id: scenario.venue_id,
  });
  const attestationCommitment = gholaCommitment("public_demo_attestation", {
    provider: capabilities.provider.evidence_commitment,
    worker_quote: capabilities.worker.quote_hash_commitment,
    worker_report_data: capabilities.worker.report_data_commitment,
    worker_image: capabilities.worker.image_digest_commitment,
  });
  const workerReady = capabilities.status === "green";
  const status: PublicPrivateAgentDemoRun["status"] = workerReady
    ? "verified_no_submit_structural"
    : capabilities.status === "blocked"
      ? "blocked"
      : "degraded";
  const resultCommitment = gholaCommitment("public_demo_result", {
    status,
    broadcast: false,
    venue_id: scenario.venue_id,
    work_order_commitment: workOrderCommitment,
    checked_at: capabilities.checked_at,
  });
  const ticketId = `demo_${gholaCommitment("public_demo_ticket", {
    policy_commitment: policyCommitment,
    work_order_commitment: workOrderCommitment,
    attestation_commitment: attestationCommitment,
    result_commitment: resultCommitment,
    checked_at: capabilities.checked_at,
  }).slice(-24)}`;
  return {
    version: 1,
    checked_at: now.toISOString(),
    status,
    demo_run_id: ticketId,
    execution_mode: "public_no_submit",
    wallet_required: false,
    deposit_required: false,
    broadcast: false,
    scenario,
    execution_ticket: {
      version: 1,
      ticket_id: ticketId,
      policy_commitment: policyCommitment,
      private_intent_commitment: privateIntentCommitment,
      strategy_commitment: strategyCommitment,
      sealed_envelope_commitment: sealedEnvelopeCommitment,
      work_order_commitment: workOrderCommitment,
      attestation_commitment: attestationCommitment,
      result_commitment: resultCommitment,
      expires_at: expiresAt,
    },
    proof_chain: [
      { step: "private_intent_committed", commitment: privateIntentCommitment },
      { step: "policy_checked", commitment: policyCommitment },
      { step: "sealed_for_attested_recipient", commitment: sealedEnvelopeCommitment },
      { step: "work_order_prepared", commitment: workOrderCommitment },
      { step: "worker_attestation_bound", commitment: attestationCommitment },
      { step: "no_submit_result_committed", commitment: resultCommitment },
    ],
    worker: capabilities.worker,
    venue_gate: capabilities.venue_gates[scenario.venue_id],
    live_submit: capabilities.live_submit,
    visibility_summary: {
      public_view: [
        "backend_readiness",
        "venue_gate_state",
        "commitment_only_execution_ticket",
        "no_submit_result",
      ],
      ghola_operator_view: "commitments_and_ciphertexts_only",
      worker_view: "sealed_instruction_after_recipient_unseal",
      venue_view: "none_no_order_submitted",
      chain_view: "none_no_transaction_broadcast",
    },
    disclosure:
      "The demo ticket is a no-submit structural proof. It does not place an order, custody visitor funds, bypass venue eligibility, or create a live trading account.",
  };
}

async function getWorkerPublicStatus(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
  now: Date,
): Promise<PublicPrivateAgentWorkerPublicStatus> {
  const baseUrl = privateAgentWorkerBaseUrl(env);
  if (!baseUrl) return unavailableWorkerStatus(["private_agent_worker_endpoint_missing"]);

  const [health, recipient] = await Promise.all([
    fetchWorkerJson(baseUrl, WORKER_HEALTH_PATH, fetchImpl),
    fetchWorkerJson(baseUrl, WORKER_PUBLIC_RECIPIENT_PATH, fetchImpl),
  ]);
  const reasonCodes = new Set<string>();
  if (!health.ok) reasonCodes.add("private_agent_worker_health_unreachable");
  if (!recipient.ok) reasonCodes.add("private_agent_worker_recipient_unreachable");

  const healthBody = asRecord(health.body);
  const recipientBody = asRecord(recipient.body);
  const recipientId = stringField(recipientBody, "recipient_id") ?? stringField(healthBody, "recipient_id");
  const recipientX25519 = stringField(recipientBody, "x25519_pub_hex");
  const provider = stringField(healthBody, "provider") ?? stringField(recipientBody, "provider");
  const teeKind = stringField(healthBody, "tee_kind") ?? stringField(recipientBody, "tee_kind");
  const imageDigest = stringField(healthBody, "image_digest") ?? stringField(recipientBody, "image_digest");
  const reportData = stringField(healthBody, "report_data_hex") ?? stringField(recipientBody, "report_data_hex");
  const quoteHash = stringField(healthBody, "quote_hash") ?? stringField(recipientBody, "quote_hash");
  const ready = healthBody.ready === true || healthBody.status === "ready";
  const attestedReady = healthBody.attested_ready === true || recipientBody.attested_ready === true;
  if (!ready) reasonCodes.add("private_agent_worker_not_ready");
  if (!attestedReady) reasonCodes.add("private_agent_worker_not_attested_ready");
  if (!recipientId || !recipientX25519) reasonCodes.add("private_agent_worker_recipient_missing");

  return {
    endpoint_configured: true,
    endpoint_url_commitment: gholaCommitment("public_demo_worker_endpoint", baseUrl.toString()),
    reachable: health.ok || recipient.ok,
    ready,
    attested_ready: attestedReady,
    provider,
    tee_kind: teeKind,
    recipient_id: recipientId,
    recipient_commitment: recipientId && recipientX25519
      ? gholaCommitment("public_demo_worker_recipient", {
          recipient_id: recipientId,
          x25519_pub_hex: recipientX25519,
          checked_at: now.toISOString().slice(0, 10),
        })
      : null,
    image_digest_commitment: imageDigest
      ? gholaCommitment("public_demo_worker_image_digest", imageDigest)
      : null,
    report_data_commitment: reportData
      ? gholaCommitment("public_demo_worker_report_data", reportData)
      : null,
    quote_hash_commitment: quoteHash
      ? gholaCommitment("public_demo_worker_quote_hash", quoteHash)
      : null,
    reason_codes: Array.from(reasonCodes),
  };
}

async function fetchWorkerJson(baseUrl: URL, path: string, fetchImpl: FetchLike) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetchImpl(new URL(path, baseUrl), {
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok && body && typeof body === "object" && !Array.isArray(body),
      body,
    };
  } catch {
    return { ok: false, body: null };
  } finally {
    clearTimeout(timeout);
  }
}

function privateAgentWorkerBaseUrl(env: Record<string, string | undefined>): URL | null {
  const raw =
    env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim() ||
    env.PHALA_AGENT_ENDPOINT?.trim() ||
    "";
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function unavailableWorkerStatus(reasonCodes: string[]): PublicPrivateAgentWorkerPublicStatus {
  return {
    endpoint_configured: false,
    endpoint_url_commitment: null,
    reachable: false,
    ready: false,
    attested_ready: false,
    provider: null,
    tee_kind: null,
    recipient_id: null,
    recipient_commitment: null,
    image_digest_commitment: null,
    report_data_commitment: null,
    quote_hash_commitment: null,
    reason_codes: reasonCodes,
  };
}

function selectedRuntimeProvider(
  runtime: PrivateAgentRuntimeStatus,
): ConfidentialComputeProviderStatus | null {
  return runtime.providers.find((provider) => provider.id === runtime.selected_provider) ?? null;
}

function workerLiveReasonCodes(
  runtime: PrivateAgentRuntimeStatus,
  workerStatus: PublicPrivateAgentWorkerPublicStatus,
): string[] {
  return Array.from(new Set([
    ...runtime.blocking_reasons,
    ...workerStatus.reason_codes,
    ...(runtime.remote_execution_ready ? [] : ["private_agent_runtime_not_ready"]),
  ]));
}

function liveSubmitReasonCodesFromReadiness(readiness: PooledWorkerReadiness): string[] {
  const venueReasons = PUBLIC_DEMO_VENUES.flatMap((venue) =>
    readiness.venues[venue]?.reason_codes.map((reason) => `${venue}:${reason}`) ?? [],
  );
  return Array.from(new Set([...readiness.reason_codes, ...venueReasons]));
}

function normalizeDemoRunRequest(
  body: PublicPrivateAgentDemoRunRequest,
  capabilities: PublicPrivateAgentDemoCapabilities,
): PublicPrivateAgentDemoRun["scenario"] {
  const scenarioId = oneOf(body.scenario_id, PUBLIC_DEMO_SCENARIOS) ?? (
    typeof body.intent === "string" && body.intent.trim()
      ? "custom_private_intent"
      : DEFAULT_SCENARIO_ID
  );
  const preferredVenue = capabilities.live_submit.ready_venues[0] ?? "phoenix";
  const venueId = oneOf(body.venue_id, PUBLIC_DEMO_VENUES) ?? preferredVenue;
  const marketId = oneOf(body.market_id, PUBLIC_DEMO_MARKETS) ?? DEFAULT_MARKET_ID;
  const notionalBucket = normalizeNotionalBucket(body.notional_bucket);
  const maxSlippageBps = normalizeSlippage(body.max_slippage_bps);
  return {
    scenario_id: scenarioId,
    venue_id: venueId,
    market_id: marketId,
    notional_bucket: notionalBucket,
    max_slippage_bps: maxSlippageBps,
  };
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | null {
  if (typeof value !== "string") return null;
  return values.includes(value as Values[number]) ? value as Values[number] : null;
}

function normalizeNotionalBucket(value: unknown): string {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return "100";
  if (numeric <= 25) return "25";
  if (numeric <= 50) return "50";
  if (numeric <= 100) return "100";
  if (numeric <= 250) return "250";
  return "500";
}

function normalizeSlippage(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return 50;
  return Math.min(100, Math.max(1, Math.round(numeric)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
