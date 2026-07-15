import { getConsumerWakeJob } from "@/lib/consumer-production-store";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const job = await getConsumerWakeJob({ wake_job_id: id, owner_commitment: owner.owner_commitment });
  if (!job) return json({ error: "wake_job_not_found" }, 404);
  return json({
    version: 1,
    wake_job_id: job.wake_job_id,
    status: job.status,
    ready: job.status === "ready",
    error_code: job.error_code,
    created_at: job.created_at,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
  });
}
