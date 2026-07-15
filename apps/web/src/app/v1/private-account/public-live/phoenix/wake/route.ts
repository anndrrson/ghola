import { after } from "next/server";
import {
  CONSUMER_WAKE_LIMIT,
  CONSUMER_WAKE_WINDOW_MS,
} from "@/lib/consumer-production";
import {
  consumeConsumerRateLimit,
  enqueueConsumerWake,
  updateConsumerWakeJob,
} from "@/lib/consumer-production-store";
import {
  markPhalaPrivateAgentActivity,
  phalaJitProvisioningConfigured,
  wakePhalaPrivateAgentForUse,
} from "@/lib/private-agent-phala";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!wakeEnabled()) return json({ error: "consumer_worker_wake_disabled" }, 403);
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();

  const ipCommitment = requestIpCommitment(request);
  const [ownerLimit, ipLimit] = await Promise.all([
    consumeConsumerRateLimit({
      key: `wake:owner:${owner.owner_commitment}`,
      limit: CONSUMER_WAKE_LIMIT,
      window_ms: CONSUMER_WAKE_WINDOW_MS,
    }),
    consumeConsumerRateLimit({
      key: `wake:ip:${ipCommitment}`,
      limit: CONSUMER_WAKE_LIMIT,
      window_ms: CONSUMER_WAKE_WINDOW_MS,
    }),
  ]);
  if (!ownerLimit.ok || !ipLimit.ok) {
    return json({
      error: "consumer_worker_wake_rate_limited",
      retry_after_seconds: Math.max(ownerLimit.retry_after_seconds, ipLimit.retry_after_seconds),
    }, 429);
  }

  const before = await getPrivateAgentRuntimeStatus();
  const leaseMs = 30 * 60_000;
  if (before.remote_execution_ready && before.selected_provider === "phala") {
    const lease = await markPhalaPrivateAgentActivity({ reason: "consumer_wake:already_running", leaseMs });
    return json({
      version: 1,
      status: "ready",
      ready: true,
      wake_job_id: null,
      lease_expires_at: lease.lease_expires_at,
    });
  }

  const job = await enqueueConsumerWake({ owner_commitment: owner.owner_commitment });
  after(async () => {
    await updateConsumerWakeJob({ wake_job_id: job.wake_job_id, status: "waking" });
    try {
      const result = await wakePhalaPrivateAgentForUse({
        reason: `consumer_wake:${job.wake_job_id}`,
        leaseMs,
        waitForReadyMs: 90_000,
      });
      const status = await getPrivateAgentRuntimeStatus();
      const ready = result.ready && status.remote_execution_ready && status.selected_provider === "phala";
      await updateConsumerWakeJob({
        wake_job_id: job.wake_job_id,
        status: ready ? "ready" : "failed",
        error_code: ready ? null : result.reason || "worker_not_attested",
      });
      log("consumer_worker_wake_finished", {
        wake_job_id: job.wake_job_id,
        owner_commitment: owner.owner_commitment,
        ready,
      });
    } catch (error) {
      await updateConsumerWakeJob({
        wake_job_id: job.wake_job_id,
        status: "failed",
        error_code: "wake_failed",
      });
      log("consumer_worker_wake_failed", {
        wake_job_id: job.wake_job_id,
        owner_commitment: owner.owner_commitment,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
    }
  });

  return json({
    version: 1,
    status: job.status,
    ready: false,
    wake_job_id: job.wake_job_id,
    poll_url: `/v1/private-account/public-live/phoenix/wake/${job.wake_job_id}`,
    expires_at: job.expires_at,
  }, 202);
}

function wakeEnabled() {
  return process.env.GHOLA_PUBLIC_LIVE_WORKER_WAKE_ENABLED === "true" || phalaJitProvisioningConfigured();
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    return parsed.host === host && (parsed.protocol === "https:" || (local && parsed.protocol === "http:"));
  } catch {
    return false;
  }
}

function requestIpCommitment(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  let hash = 2166136261;
  for (const char of forwarded) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `ip_${(hash >>> 0).toString(16)}`;
}

function log(message: string, fields: Record<string, unknown>, level: "info" | "error" = "info") {
  const output = JSON.stringify({ level, message, route: "/v1/private-account/public-live/phoenix/wake", ...fields });
  if (level === "error") console.error(output);
  else console.log(output);
}
