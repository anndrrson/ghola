import {
  json,
  privateAccountAgentBillingGate,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";
import {
  discoverPhalaPrivateAgentProvider,
  wakePhalaPrivateAgentForUse,
} from "@/lib/private-agent-phala";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const WAKE_LEASE_MS = 10 * 60_000;
const WAKE_COOLDOWN_MS = 30_000;
const recentWakeAttempts = new Map<string, number>();

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return runtimeStatus();
}

export async function POST(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();

  const billing = await privateAccountAgentBillingGate(req);
  if (!billing.ok) {
    return billing.response ?? json(
      { error: billing.error ?? "private_agent_billing_required" },
      billing.status ?? 402,
    );
  }

  const body = await req.json().catch(() => null) as { product_id?: unknown } | null;
  const productId = normalizedProductId(body?.product_id);
  const now = Date.now();
  pruneWakeAttempts(now);
  const previous = recentWakeAttempts.get(owner.owner_commitment) ?? 0;
  const coolingDown = now - previous < WAKE_COOLDOWN_MS;

  let provisioning: Awaited<ReturnType<typeof wakePhalaPrivateAgentForUse>> | null = null;
  if (!coolingDown) {
    recentWakeAttempts.set(owner.owner_commitment, now);
    provisioning = await wakePhalaPrivateAgentForUse({
      reason: `seeker_native_prewarm:${productId}`,
      waitForReadyMs: 0,
      leaseMs: WAKE_LEASE_MS,
    });
  }

  const response = await runtimeStatus({
    provisioning,
    wakeAccepted: !coolingDown,
    retryAfterMs: coolingDown ? Math.max(1_000, WAKE_COOLDOWN_MS - (now - previous)) : 0,
  });
  return response;
}

async function runtimeStatus(input: {
  provisioning?: Awaited<ReturnType<typeof wakePhalaPrivateAgentForUse>> | null;
  wakeAccepted?: boolean;
  retryAfterMs?: number;
} = {}) {
  const provider = await discoverPhalaPrivateAgentProvider();
  const ready = provider?.available === true && provider.supports_trading_execution === true;
  const cvmStatus = provider?.evidence && typeof provider.evidence === "object"
    ? (provider.evidence as { cvm_status?: unknown }).cvm_status ?? null
    : null;
  const provisioningStatus = input.provisioning?.status ?? null;
  const failed = provisioningStatus === "failed" || provisioningStatus === "missing_config";
  return json({
    version: 1,
    status: ready ? "ready" : failed ? "blocked" : "waking",
    ready,
    wake_accepted: input.wakeAccepted ?? false,
    retry_after_ms: input.retryAfterMs ?? 0,
    lease_ms: WAKE_LEASE_MS,
    provider: {
      id: "phala",
      configured: provider?.configured === true,
      available: provider?.available === true,
      attested: provider?.attested === true,
      supports_trading_execution: provider?.supports_trading_execution === true,
      cvm_status: cvmStatus,
    },
    provisioning: input.provisioning
      ? {
          attempted: input.provisioning.attempted,
          status: input.provisioning.status,
          reason: input.provisioning.reason ?? null,
        }
      : null,
    checked_at: new Date().toISOString(),
  }, ready ? 200 : failed ? 503 : 202);
}

function normalizedProductId(value: unknown): string {
  const product = typeof value === "string" ? value.trim().toUpperCase() : "UNKNOWN";
  return /^[A-Z0-9][A-Z0-9/_.-]{0,31}$/.test(product) ? product : "UNKNOWN";
}

function pruneWakeAttempts(now: number) {
  if (recentWakeAttempts.size < 1_000) return;
  for (const [owner, timestamp] of recentWakeAttempts) {
    if (now - timestamp > WAKE_COOLDOWN_MS) recentWakeAttempts.delete(owner);
  }
}

export function resetNativeWakeRateLimitForTests() {
  recentWakeAttempts.clear();
}
