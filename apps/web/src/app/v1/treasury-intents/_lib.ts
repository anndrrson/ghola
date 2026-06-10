import { NextResponse } from "next/server";
import {
  buildTreasuryExecutionReceipt,
  createHttpTreasuryAdapter,
  createMockTreasuryAdapters,
  submitTreasuryExecutionToAdapters,
  treasuryExecutionStatus,
  validateTreasuryExecuteRequest,
  type TreasuryAgentConfig,
  type TreasuryPartnerAdapter,
  type TreasuryExecutionStatusV1,
  type TreasuryRailKind,
} from "@/lib/treasury-execution";
import { getTreasuryIntentRecord } from "@/lib/treasury-execution-store";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

export function treasuryExecutionEnv() {
  const providerId =
    process.env.GHOLA_TREASURY_PROVIDER_ID || "mock_treasury_partner";
  const signingSecret =
    process.env.GHOLA_TREASURY_RECEIPT_SECRET ||
    process.env.GHOLA_PRIVATE_EXECUTION_RECEIPT_SECRET ||
    "ghola-dev-treasury-receipts";
  const supportedRails = parseSupportedRails(
    process.env.GHOLA_TREASURY_SUPPORTED_RAILS,
  );
  const adapterApiKey = process.env.GHOLA_TREASURY_PARTNER_ADAPTER_API_KEY;
  const adapterEndpoint = process.env.GHOLA_TREASURY_PARTNER_ADAPTER_URL;
  const adapterEndpoints = parseAdapterEndpoints(
    process.env.GHOLA_TREASURY_PARTNER_ADAPTER_URLS,
  );
  const adapterTimeoutMs = parsePositiveInt(
    process.env.GHOLA_TREASURY_PARTNER_ADAPTER_TIMEOUT_MS,
  ) ?? 15_000;
  const partnerRailReady =
    process.env.GHOLA_TREASURY_PARTNER_RAIL_READY !== "false";
  const sealedProviderReady =
    process.env.GHOLA_TREASURY_PROVIDER_READY !== "false" &&
    process.env.GHOLA_PRIVATE_EXECUTION_PROVIDER_READY !== "false";
  return {
    providerId,
    signingSecret,
    supportedRails,
    adapterApiKey,
    adapterEndpoint,
    adapterEndpoints,
    adapterTimeoutMs,
    partnerRailReady,
    sealedProviderReady,
  };
}

export function treasuryStatus(): TreasuryExecutionStatusV1 {
  const env = treasuryExecutionEnv();
  return treasuryExecutionStatus({
    supportedRails: env.supportedRails,
    partnerRailReady: env.partnerRailReady,
    sealedProviderReady: env.sealedProviderReady,
  });
}

export function agentForRequest(req: Request): TreasuryAgentConfig | null {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const key = auth.slice("Bearer ".length).trim();
  if (!key) return null;
  try {
    return parseTreasuryAgentKeys(
      process.env.GHOLA_TREASURY_AGENT_API_KEYS || process.env.GHOLA_AGENT_API_KEYS,
    ).get(key) ?? null;
  } catch {
    return null;
  }
}

export async function buildReceiptForRequest(input: {
  request: unknown;
  agent: TreasuryAgentConfig;
}) {
  const validation = validateTreasuryExecuteRequest(input.request);
  if (!validation.ok || !validation.request) return validation;
  const env = treasuryExecutionEnv();
  const existing = await getTreasuryIntentRecord(validation.request.intent_id);
  if (existing) {
    if (existing.policy_hash !== validation.request.policy_hash) {
      return { ok: false as const, error: "policy_hash does not match simulated intent" };
    }
    if (existing.proposal_hash !== validation.request.proposal_hash) {
      return { ok: false as const, error: "proposal_hash does not match simulated intent" };
    }
    if (
      existing.approval &&
      existing.approval.approval_hash !== validation.request.approval_hash
    ) {
      return { ok: false as const, error: "approval_hash does not match simulated intent" };
    }
  }
  const unsupportedRails = env.supportedRails
    ? validation.request.rails.filter((rail) => !env.supportedRails?.includes(rail))
    : [];
  if (unsupportedRails.length > 0) {
    return {
      ok: false as const,
      error: `unsupported treasury rail: ${unsupportedRails.join(",")}`,
    };
  }
  const partnerExecution = await submitTreasuryExecutionToAdapters({
    request: validation.request,
    providerId: env.providerId,
    adapters: treasuryAdaptersForEnv(env),
  });
  return {
    ok: true as const,
    submissions: partnerExecution.submissions,
    prepared: partnerExecution.prepared,
    receipt: buildTreasuryExecutionReceipt({
      request: validation.request,
      agentId: input.agent.agent_id,
      providerId: env.providerId,
      partnerRefs: partnerExecution.partner_refs,
      signingSecret: env.signingSecret,
    }),
  };
}

export function treasuryAdaptersForEnv(
  env = treasuryExecutionEnv(),
): Map<TreasuryRailKind, TreasuryPartnerAdapter> {
  const adapters = createMockTreasuryAdapters(env.providerId);
  const rails = env.supportedRails ?? [
    "bank_cash",
    "treasury_bills",
    "bond_ladder",
    "broker_cash_sweep",
    "stablecoin_public",
    "stablecoin_shielded",
    "ach",
    "wire",
    "rtp",
  ];
  for (const rail of rails) {
    const endpoint = env.adapterEndpoints?.[rail] ?? env.adapterEndpoint;
    if (!endpoint) continue;
    adapters.set(
      rail,
      createHttpTreasuryAdapter({
        rail,
        endpoint,
        apiKey: env.adapterApiKey,
        timeoutMs: env.adapterTimeoutMs,
      }),
    );
  }
  return adapters;
}

function parseTreasuryAgentKeys(raw: string | undefined): Map<string, TreasuryAgentConfig> {
  if (!raw) return new Map();
  const parsed = JSON.parse(raw) as Record<string, TreasuryAgentConfig>;
  return new Map(Object.entries(parsed));
}

function parseSupportedRails(raw: string | undefined): TreasuryRailKind[] | undefined {
  if (!raw?.trim()) return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(isTreasuryRailKind);
}

function parseAdapterEndpoints(raw: string | undefined): Partial<Record<TreasuryRailKind, string>> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw) as Partial<Record<TreasuryRailKind, string>>;
  } catch {
    return undefined;
  }
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isTreasuryRailKind(value: string): value is TreasuryRailKind {
  return (
    value === "bank_cash" ||
    value === "treasury_bills" ||
    value === "bond_ladder" ||
    value === "broker_cash_sweep" ||
    value === "stablecoin_public" ||
    value === "stablecoin_shielded" ||
    value === "ach" ||
    value === "wire" ||
    value === "rtp"
  );
}
