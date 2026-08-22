import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const PROVIDER_KINDS = new Set(["gateway", "openai_compatible", "ollama", "lm_studio", "vllm"]);
const LOCAL_DEFAULTS = Object.freeze({
  ollama: "http://127.0.0.1:11434/v1",
  lm_studio: "http://127.0.0.1:1234/v1",
  vllm: "http://127.0.0.1:8000/v1",
});

export function resolveDecisionModel({ env = process.env, fetchImpl = fetch } = {}) {
  const kind = stringValue(env.PRIVATE_AGENT_AI_PROVIDER_KIND || "gateway").toLowerCase();
  if (!PROVIDER_KINDS.has(kind)) return failure("ai_provider_unsupported");
  const modelId = stringValue(env.PRIVATE_AGENT_AI_MODEL || env.GHOLA_PRIVATE_AGENT_AI_MODEL);
  if (!modelId) return failure("ai_model_unconfigured");
  const timeoutMs = boundedInteger(env.PRIVATE_AGENT_AI_TIMEOUT_MS, 1_000, 60_000, 20_000);
  if (kind === "gateway") {
    return {
      ok: true,
      model: modelId,
      timeout_ms: timeoutMs,
      metadata: Object.freeze({
        provider_kind: "gateway",
        model_id: modelId,
        endpoint_origin: null,
        local: false,
        structured_outputs: true,
      }),
    };
  }

  const rawBaseUrl = stringValue(env.PRIVATE_AGENT_AI_BASE_URL) || LOCAL_DEFAULTS[kind] || "";
  if (!rawBaseUrl) return failure("ai_provider_base_url_required");
  const endpoint = validateEndpoint(rawBaseUrl, { env });
  if (!endpoint.ok) return endpoint;
  const providerName = `ghola_${kind}`;
  const provider = createOpenAICompatible({
    name: providerName,
    baseURL: endpoint.url.toString().replace(/\/$/, ""),
    apiKey: stringValue(env.PRIVATE_AGENT_AI_API_KEY || env.GHOLA_PRIVATE_AGENT_AI_API_KEY) || undefined,
    supportsStructuredOutputs: env.PRIVATE_AGENT_AI_STRUCTURED_OUTPUTS === "true",
    fetch: originBoundFetch({ fetchImpl, origin: endpoint.url.origin }),
  });
  return {
    ok: true,
    model: provider(modelId),
    timeout_ms: timeoutMs,
    metadata: Object.freeze({
      provider_kind: kind,
      model_id: modelId,
      endpoint_origin: endpoint.url.origin,
      local: endpoint.local,
      structured_outputs: env.PRIVATE_AGENT_AI_STRUCTURED_OUTPUTS === "true",
    }),
  };
}

export function publicDecisionProviderStatus({ env = process.env } = {}) {
  const resolved = resolveDecisionModel({ env, fetchImpl: async () => {
    throw new Error("status_probe_does_not_fetch");
  } });
  return resolved.ok
    ? Object.freeze({ version: 1, configured: true, ...resolved.metadata, timeout_ms: resolved.timeout_ms })
    : Object.freeze({ version: 1, configured: false, error: resolved.error });
}

function validateEndpoint(value, { env }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return failure("ai_provider_base_url_invalid");
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return failure("ai_provider_protocol_unsupported");
  }
  if (url.username || url.password || url.search || url.hash) {
    return failure("ai_provider_base_url_unsafe");
  }
  const local = isLoopback(url.hostname);
  if (url.protocol === "http:" && !local) {
    if (env.PRIVATE_AGENT_AI_ALLOW_PRIVATE_HTTP !== "true" || !isPrivateHost(url.hostname)) {
      return failure("ai_provider_https_required");
    }
  }
  const approvedOrigins = stringValue(env.PRIVATE_AGENT_AI_ALLOWED_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!local && !approvedOrigins.includes(url.origin)) {
    return failure("ai_provider_origin_not_approved");
  }
  return { ok: true, url, local };
}

function originBoundFetch({ fetchImpl, origin }) {
  return async (input, init = {}) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (target.origin !== origin) throw new Error("ai_provider_origin_escape_blocked");
    return fetchImpl(input, { ...init, redirect: "manual" });
  };
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return host.startsWith("fc") || host.startsWith("fd");
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function failure(error) {
  return Object.freeze({ ok: false, error });
}
