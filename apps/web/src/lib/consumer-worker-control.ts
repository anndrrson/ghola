export async function proxyConsumerWorker(input: {
  path: string;
  method?: "GET" | "POST";
  tokenEnv: "GHOLA_TRADING_CONTROL_TOKEN" | "GHOLA_RECONCILIATION_INGEST_TOKEN";
  body?: unknown;
}) {
  const base = process.env.PRIVATE_AGENT_WORKER_URL?.trim() || process.env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim();
  const token = process.env[input.tokenEnv]?.trim();
  if (!base || !token || token.length < 32) {
    return { status: 503, body: { error: "private_agent_consumer_control_unconfigured" } };
  }
  const response = await fetch(new URL(input.path, base), {
    method: input.method ?? "POST",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response) return { status: 503, body: { error: "private_agent_consumer_control_unavailable" } };
  return {
    status: response.status,
    body: await response.json().catch(() => ({ error: "private_agent_consumer_control_invalid_response" })),
  };
}
