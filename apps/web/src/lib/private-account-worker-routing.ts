import { selectedReadyPrivateAgentProvider, type PrivateAgentRuntimeStatus } from "./private-agent-runtime";
import { getPrivateAgentRuntimeStatus } from "./private-agent-runtime-server";

export function resolveHyperliquidWorkerUrl(input: {
  selected_provider_execution_url?: string | null;
  connector_url?: string | null;
  execution_url?: string | null;
  worker_url?: string | null;
  phala_endpoint?: string | null;
}) {
  return input.selected_provider_execution_url?.trim() ||
    input.connector_url?.trim() ||
    input.execution_url?.trim() ||
    input.worker_url?.trim() ||
    input.phala_endpoint?.trim() ||
    "";
}

export async function resolvePrivateAccountWorkerConfig(input: {
  env?: Record<string, string | undefined>;
  runtime?: PrivateAgentRuntimeStatus | null;
} = {}) {
  const env = input.env ?? process.env;
  let runtime = input.runtime;
  if (runtime === undefined) {
    if (input.env && input.env !== process.env) {
      runtime = null;
    } else {
      try {
        runtime = await getPrivateAgentRuntimeStatus();
      } catch {
        runtime = null;
      }
    }
  }
  const selectedProvider = runtime ? selectedReadyPrivateAgentProvider(runtime) : null;
  const rawUrl = resolveHyperliquidWorkerUrl({
    selected_provider_execution_url: selectedProvider?.execution_url,
    connector_url: env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL,
    execution_url: env.GHOLA_PRIVATE_AGENT_EXECUTION_URL,
    worker_url: env.GHOLA_PRIVATE_AGENT_WORKER_URL,
    phala_endpoint: env.PHALA_AGENT_ENDPOINT,
  });
  let url: URL | null = null;
  if (rawUrl) {
    try {
      url = new URL(rawUrl);
    } catch {
      url = null;
    }
  }
  return {
    url,
    token:
      env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN?.trim() ||
      env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      env.PHALA_CLOUD_API_KEY?.trim() ||
      "",
    recipient_id:
      selectedProvider?.sealed_recipient?.recipient_id?.trim() ||
      env.PHALA_ENCLAVE_KEY_ID?.trim() ||
      env.GHOLA_PRIVATE_AGENT_ENCLAVE_KEY_ID?.trim() ||
      null,
    provider_id: selectedProvider?.id ?? null,
  };
}
