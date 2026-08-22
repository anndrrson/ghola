import {
  workerAuthorizationHeader,
  type WorkerCapabilityScope,
} from "@/lib/private-agent-capability";

export const KRAKEN_V2_OPERATIONS = {
  connections: { path: "/v2/kraken/connections", scope: "kraken:connection" },
  mandates: { path: "/v2/kraken/mandates", scope: "kraken:mandate" },
  "allocation-intents": { path: "/v2/kraken/allocation-intents", scope: "kraken:intent" },
  rebalance: { path: "/v2/kraken/rebalance", scope: "kraken:execute" },
  control: { path: "/v2/kraken/control", scope: "kraken:control" },
  status: { path: "/v2/kraken/status", scope: "kraken:read" },
} as const satisfies Record<string, { path: string; scope: WorkerCapabilityScope }>;

export type KrakenV2Operation = keyof typeof KRAKEN_V2_OPERATIONS;

export async function callKrakenV2Worker(
  operation: KrakenV2Operation,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const route = KRAKEN_V2_OPERATIONS[operation];
  const base = (
    process.env.GHOLA_KRAKEN_V2_WORKER_URL ||
    process.env.GHOLA_PRIVATE_AGENT_WORKER_URL ||
    ""
  ).replace(/\/$/, "");
  if (!base) {
    return Response.json({ error: "kraken_worker_not_configured" }, { status: 503 });
  }
  const authorization = workerAuthorizationHeader({
    fallbackToken: process.env.GHOLA_PRIVATE_AGENT_WORKER_TOKEN,
    method: "POST",
    path: route.path,
    scope: route.scope,
    body,
    expected: {
      owner_commitment: body.owner_commitment,
      account_commitment: body.account_commitment,
      venue_id: "kraken",
      operation_class: route.scope,
    },
  });
  if (!authorization) {
    return Response.json({ error: "kraken_worker_auth_not_configured" }, { status: 503 });
  }
  try {
    const response = await fetchImpl(`${base}${route.path}`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch {
    return Response.json({ error: "kraken_worker_unavailable" }, { status: 503 });
  }
}

export function isKrakenV2Operation(value: string): value is KrakenV2Operation {
  return Object.prototype.hasOwnProperty.call(KRAKEN_V2_OPERATIONS, value);
}
