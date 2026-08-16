import { privateAgentTransportAllowed } from "./private-agent-spend-policy";

export async function proxyConsumerWorker(input: {
  path: string;
  method?: "GET" | "POST";
  tokenEnv: "GHOLA_TRADING_CONTROL_TOKEN" | "GHOLA_RECONCILIATION_INGEST_TOKEN";
  body?: unknown;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  if (!privateAgentTransportAllowed("execute", env, input.fetchImpl)) {
    return { status: 503, body: { error: "private_agent_consumer_control_unconfigured" } };
  }
  const base = env.PRIVATE_AGENT_WORKER_URL?.trim() || env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim();
  const token = env[input.tokenEnv]?.trim();
  if (!base || !token || token.length < 32) {
    return { status: 503, body: { error: "private_agent_consumer_control_unconfigured" } };
  }
  const response = await fetchImpl(new URL(input.path, base), {
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
