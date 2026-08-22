import { RetryableError } from "workflow";

export interface PrivateAgentIdleStopSummary {
  provider_id: "phala";
  status: string;
  attempted: boolean;
  stopped: boolean;
  lease_expires_at: string | null;
}

export async function stopExpiredPhalaPrivateAgent(
  providerId: "phala",
): Promise<PrivateAgentIdleStopSummary> {
  "use step";

  const { stopIdlePhalaPrivateAgent } = await import(
    "@/lib/private-agent-phala"
  );
  const result = await stopIdlePhalaPrivateAgent();
  if (result.status === "failed") {
    // stopCvm is idempotent, so a short retry is safer than leaving paid
    // capacity running after a transient Phala control-plane failure.
    throw new RetryableError("Phala idle stop failed; retrying safely.", {
      retryAfter: "30s",
    });
  }
  return {
    provider_id: providerId,
    status: result.status,
    attempted: result.attempted,
    stopped: result.stopped,
    lease_expires_at: result.lease_expires_at ?? null,
  };
}

stopExpiredPhalaPrivateAgent.maxRetries = 3;
