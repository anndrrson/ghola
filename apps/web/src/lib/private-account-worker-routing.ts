type PrivateAgentWorkerUrls = {
  selected_provider_execution_url?: string | null;
  connector_url?: string | null;
  execution_url?: string | null;
  worker_url?: string | null;
  phala_endpoint?: string | null;
};

export function resolvePrivateAgentWorkerUrl(input: PrivateAgentWorkerUrls) {
  return input.selected_provider_execution_url?.trim() ||
    input.connector_url?.trim() ||
    input.execution_url?.trim() ||
    input.worker_url?.trim() ||
    input.phala_endpoint?.trim() ||
    "";
}

export function resolveCarryShadowWorkerUrl(
  input: PrivateAgentWorkerUrls & { shadow_url?: string | null },
) {
  return input.shadow_url?.trim() || resolvePrivateAgentWorkerUrl(input);
}

export const resolveHyperliquidWorkerUrl = resolvePrivateAgentWorkerUrl;
