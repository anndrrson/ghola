import {
  reconcileLiveTradingWorkOrder,
} from "@/lib/live-trading-worker-dispatch.server";
import {
  json,
  privateAccountOwnerFromRequest,
  type PrivateAccountRequestOwner,
  unauthorized,
} from "../../_lib";

const PLAN_DIGEST = /^sha256:[a-f0-9]{64}$/u;

export interface LiveTradingReconciliationDependencies {
  ownerFromRequest: (request: Request) => Promise<PrivateAccountRequestOwner | null>;
  reconcile: typeof reconcileLiveTradingWorkOrder;
}

export function createLiveTradingReconciliationPost(
  dependencies: LiveTradingReconciliationDependencies,
) {
  return (request: Request) => handlePost(request, dependencies);
}

async function handlePost(
  request: Request,
  dependencies: LiveTradingReconciliationDependencies,
) {
  if (!sameOriginJsonPost(request)) return json({ error: "same_origin_json_required" }, 403);
  const owner = await dependencies.ownerFromRequest(request);
  if (!owner) return unauthorized();
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) {
    return json({ error: "live_reconciliation_request_invalid" }, 400);
  }
  const planDigest = typeof (body as Record<string, unknown>).plan_digest === "string"
    ? String((body as Record<string, unknown>).plan_digest).trim()
    : "";
  if (!PLAN_DIGEST.test(planDigest)) return json({ error: "live_plan_digest_required" }, 400);
  return dependencies.reconcile({
    owner_commitment: owner.owner_commitment,
    plan_digest: planDigest,
    fetchImpl: globalThis.fetch,
    env: process.env,
  });
}

function sameOriginJsonPost(request: Request) {
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!origin || contentType !== "application/json") return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export const liveTradingReconciliationDependencies: LiveTradingReconciliationDependencies = {
  ownerFromRequest: privateAccountOwnerFromRequest,
  reconcile: reconcileLiveTradingWorkOrder,
};
