import net from "node:net";

export const MODEL_ROUTER_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export type GholaModelRouteId =
  | "local_webgpu"
  | "local_ghola_home"
  | "local_openai_compatible"
  | "venice"
  | "frontier_openai"
  | "sealed_ghola";

export type GholaModelRouteKind =
  | "client_local"
  | "server_openai_compatible"
  | "remote_openai_compatible"
  | "private_execution";

export type GholaPromptSensitivity =
  | "public"
  | "private"
  | "execution_sensitive";

export interface GholaModelRoute {
  id: GholaModelRouteId;
  object: "model_route";
  label: string;
  kind: GholaModelRouteKind;
  enabled: boolean;
  server_callable: boolean;
  model_prefixes: string[];
  privacy: {
    prompt_confidentiality:
      | "local_device_only"
      | "user_endpoint_visible"
      | "venice_model_dependent"
      | "frontier_provider_visible"
      | "sealed_inference_required";
    provider_identity:
      | "none"
      | "user_controlled_endpoint"
      | "venice_account"
      | "frontier_account"
      | "ghola_attested_worker";
    execution_credentials_allowed: boolean;
    trading_execution_allowed: boolean;
    boundary: string;
  };
  reason_codes: string[];
  endpoint?: {
    configured: boolean;
    host: string | null;
  };
}

export interface GholaModelRoutesResponse {
  version: 1;
  object: "list";
  data: GholaModelRoute[];
}

export interface GholaModelRouteModelsResponse {
  version: 1;
  object: "list";
  route: GholaModelRouteId | "all";
  data: Array<{
    id: string;
    object: "model";
    owned_by: string;
    route: GholaModelRouteId;
    source: "static" | "remote";
    ghola: {
      prompt_confidentiality: GholaModelRoute["privacy"]["prompt_confidentiality"];
      trading_execution_allowed: false;
    };
  }>;
}

type Env = Record<string, string | undefined>;

interface ModelRouterChatBody {
  model?: unknown;
  route?: unknown;
  route_id?: unknown;
  messages?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  presence_penalty?: unknown;
  frequency_penalty?: unknown;
  stop?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  metadata?: unknown;
  venice_parameters?: unknown;
  ghola?: unknown;
  sensitivity?: unknown;
  base_url?: unknown;
}

interface ResolvedOpenAiRoute {
  route: GholaModelRoute;
  model: string;
  baseUrl: string;
  apiKey: string | null;
}

const DEFAULT_VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const UPSTREAM_TIMEOUT_MS = 90_000;

const SAFE_FORWARD_FIELDS = [
  "messages",
  "stream",
  "max_tokens",
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "tools",
  "tool_choice",
  "response_format",
  "metadata",
] as const;

const FORBIDDEN_KEY_PATTERNS = [
  /api[_-]?key/i,
  /api[_-]?secret/i,
  /private[_-]?key/i,
  /secret[_-]?key/i,
  /mnemonic/i,
  /seed[_-]?phrase/i,
  /wallet[_-]?(secret|private|seed)/i,
  /signing[_-]?(key|secret|credential)/i,
  /venue[_-]?(credential|secret|vault)/i,
  /execution[_-]?vault/i,
  /sealed[_-]?(vault|credential|secret)/i,
  /raw[_-]?transaction/i,
  /signed[_-]?transaction/i,
  /submit[_-]?order/i,
  /coinbase[_-]?(api|secret)/i,
  /hyperliquid[_-]?(api|secret|agent[_-]?private)/i,
  /jupiter[_-]?api[_-]?key/i,
  /phoenix[_-]?(authority|keypair|secret)/i,
];

export function listModelRoutes(env: Env = process.env): GholaModelRoutesResponse {
  const veniceKey = firstSet(env, "VENICE_API_KEY", "GHOLA_VENICE_API_KEY");
  const openAiKey = firstSet(env, "OPENAI_API_KEY", "GHOLA_OPENAI_API_KEY");
  const localBaseUrl = firstSet(env, "GHOLA_LOCAL_OPENAI_BASE_URL", "LOCAL_OPENAI_BASE_URL");
  const gholaHomeUrl = firstSet(env, "GHOLA_HOME_BASE_URL");
  const sealedConfigured = hasAny(
    env,
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "GHOLA_PRIVATE_RUNTIME_URL",
    "PHALA_AGENT_ENDPOINT",
  );
  const userEndpointsEnabled = env.GHOLA_MODEL_ROUTER_USER_ENDPOINTS_ENABLED === "true";

  return {
    version: 1,
    object: "list",
    data: [
      {
        id: "local_webgpu",
        object: "model_route",
        label: "Local browser model",
        kind: "client_local",
        enabled: true,
        server_callable: false,
        model_prefixes: ["local-webgpu/", "local-webgpu:"],
        privacy: {
          prompt_confidentiality: "local_device_only",
          provider_identity: "none",
          execution_credentials_allowed: false,
          trading_execution_allowed: false,
          boundary: "Runs in the user's browser/device. The backend only advertises this route; it cannot call the user's local GPU.",
        },
        reason_codes: ["client_runtime_required"],
      },
      {
        id: "local_ghola_home",
        object: "model_route",
        label: "ghola-home local model bridge",
        kind: "client_local",
        enabled: Boolean(gholaHomeUrl),
        server_callable: false,
        model_prefixes: ["ghola-home/", "ghola-home:"],
        privacy: {
          prompt_confidentiality: "local_device_only",
          provider_identity: "none",
          execution_credentials_allowed: false,
          trading_execution_allowed: false,
          boundary: "Browser or native ghola-home bridge calls a local model server on the user's machine; cloud Ghola does not dial user localhost.",
        },
        reason_codes: gholaHomeUrl ? [] : ["ghola_home_bridge_not_configured"],
        endpoint: endpointSummary(gholaHomeUrl),
      },
      {
        id: "local_openai_compatible",
        object: "model_route",
        label: "User OpenAI-compatible endpoint",
        kind: "server_openai_compatible",
        enabled: Boolean(localBaseUrl || userEndpointsEnabled),
        server_callable: Boolean(localBaseUrl || userEndpointsEnabled),
        model_prefixes: ["local/", "local:"],
        privacy: {
          prompt_confidentiality: "user_endpoint_visible",
          provider_identity: "user_controlled_endpoint",
          execution_credentials_allowed: false,
          trading_execution_allowed: false,
          boundary: "Routes only prompts to a user-controlled OpenAI-compatible endpoint. Venue credentials and trade submission are blocked.",
        },
        reason_codes: localBaseUrl || userEndpointsEnabled ? [] : ["local_openai_endpoint_not_configured"],
        endpoint: endpointSummary(localBaseUrl),
      },
      {
        id: "venice",
        object: "model_route",
        label: "Venice AI",
        kind: "remote_openai_compatible",
        enabled: Boolean(veniceKey),
        server_callable: Boolean(veniceKey),
        model_prefixes: ["venice/", "venice:"],
        privacy: {
          prompt_confidentiality: "venice_model_dependent",
          provider_identity: "venice_account",
          execution_credentials_allowed: false,
          trading_execution_allowed: false,
          boundary: "Venice handles inference. Model privacy can be private, anonymized, or stronger when the selected Venice model supports it.",
        },
        reason_codes: veniceKey ? [] : ["venice_api_key_missing"],
        endpoint: endpointSummary(firstSet(env, "VENICE_BASE_URL", "GHOLA_VENICE_BASE_URL") || DEFAULT_VENICE_BASE_URL),
      },
      {
        id: "frontier_openai",
        object: "model_route",
        label: "OpenAI-compatible frontier provider",
        kind: "remote_openai_compatible",
        enabled: Boolean(openAiKey),
        server_callable: Boolean(openAiKey),
        model_prefixes: ["openai/", "openai:"],
        privacy: {
          prompt_confidentiality: "frontier_provider_visible",
          provider_identity: "frontier_account",
          execution_credentials_allowed: false,
          trading_execution_allowed: false,
          boundary: "Plain remote inference through the configured frontier provider. Use only for non-execution-sensitive prompts.",
        },
        reason_codes: openAiKey ? [] : ["openai_api_key_missing"],
        endpoint: endpointSummary(firstSet(env, "OPENAI_BASE_URL", "GHOLA_OPENAI_BASE_URL") || DEFAULT_OPENAI_BASE_URL),
      },
      {
        id: "sealed_ghola",
        object: "model_route",
        label: "Ghola sealed private execution",
        kind: "private_execution",
        enabled: sealedConfigured,
        server_callable: false,
        model_prefixes: ["ghola-private", "agent:"],
        privacy: {
          prompt_confidentiality: "sealed_inference_required",
          provider_identity: "ghola_attested_worker",
          execution_credentials_allowed: true,
          trading_execution_allowed: true,
          boundary: "Execution-sensitive strategy and trade work must use Ghola's sealed private-agent execution APIs, not generic remote model routing.",
        },
        reason_codes: sealedConfigured ? [] : ["sealed_private_execution_not_configured"],
      },
    ],
  };
}

export function listStaticModelsForRoute(routeId: GholaModelRouteId | "all", env: Env = process.env): GholaModelRouteModelsResponse {
  const routes = listModelRoutes(env).data;
  const selected = routeId === "all" ? routes : routes.filter((route) => route.id === routeId);
  const data = selected.flatMap((route) => staticModels(route));
  return { version: 1, object: "list", route: routeId, data };
}

export async function fetchRemoteModelsForRoute(
  routeId: GholaModelRouteId,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<GholaModelRouteModelsResponse | { error: string; status: number }> {
  const route = listModelRoutes(env).data.find((item) => item.id === routeId);
  if (!route) return { error: "unknown_model_route", status: 404 };
  if (routeId !== "venice" && routeId !== "frontier_openai") {
    return listStaticModelsForRoute(routeId, env);
  }
  const resolved = resolveOpenAiBaseRoute({ routeId, model: "models-list", body: {}, env });
  if ("error" in resolved) return { error: resolved.error, status: resolved.status };
  const upstream = await fetchImpl(`${resolved.baseUrl}/models`, {
    method: "GET",
    headers: authorizationHeaders(resolved.apiKey),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!upstream.ok) {
    return { error: `upstream_models_${upstream.status}`, status: 502 };
  }
  const body = await upstream.json() as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
  const data = Array.isArray(body.data)
    ? body.data
        .filter((model) => typeof model.id === "string")
        .map((model) => ({
          id: model.id as string,
          object: "model" as const,
          owned_by: typeof model.owned_by === "string" ? model.owned_by : routeId,
          route: routeId,
          source: "remote" as const,
          ghola: {
            prompt_confidentiality: route.privacy.prompt_confidentiality,
            trading_execution_allowed: false as const,
          },
        }))
    : [];
  return { version: 1, object: "list", route: routeId, data };
}

export async function routeModelChatCompletions(
  req: Request,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let body: ModelRouterChatBody;
  try {
    body = await req.json() as ModelRouterChatBody;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const guard = guardModelRouterPayload(body);
  if (!guard.ok) {
    return json({ error: guard.error, path: guard.path }, 422);
  }

  const requested = requestedRouteId(body);
  const model = stringValue(body.model);
  if (!model) return json({ error: "model_required" }, 400);
  if (!Array.isArray(body.messages)) return json({ error: "messages_required" }, 400);

  const routeId = requested ?? inferRouteIdFromModel(model);
  if (routeId === "local_webgpu" || routeId === "local_ghola_home") {
    return json({
      error: "client_side_local_route_required",
      route: routeId,
      detail: "Cloud Ghola cannot dial the user's localhost/GPU. Use the browser local path, ghola-home, or a registered HTTPS OpenAI-compatible endpoint.",
    }, 409);
  }
  if (routeId === "sealed_ghola") {
    return json({
      error: "sealed_route_requires_private_execution_api",
      route: routeId,
      detail: "Execution-sensitive model work must use Ghola private-agent or private-account execution APIs so secrets stay sealed.",
    }, 409);
  }

  const sensitivity = promptSensitivity(body);
  if (sensitivity === "execution_sensitive") {
    return json({
      error: "execution_sensitive_prompt_requires_sealed_or_local_route",
      route: routeId,
    }, 422);
  }
  if (sensitivity === "private" && routeId === "frontier_openai" && env.GHOLA_MODEL_ROUTER_ALLOW_FRONTIER_PRIVATE_PROMPTS !== "true") {
    return json({
      error: "private_prompt_frontier_route_disabled",
      route: routeId,
    }, 422);
  }

  const resolved = resolveOpenAiBaseRoute({ routeId, model, body, env });
  if ("error" in resolved) return json({ error: resolved.error, route: routeId }, resolved.status);

  const payload = buildOpenAiPayload(body, resolved.model, routeId);
  const upstream = await fetchImpl(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeaders(resolved.apiKey),
    },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => null);

  if (!upstream) return json({ error: "model_upstream_unavailable", route: routeId }, 503);

  const headers = new Headers();
  headers.set("Cache-Control", MODEL_ROUTER_HEADERS["Cache-Control"]);
  headers.set("Pragma", MODEL_ROUTER_HEADERS.Pragma);
  headers.set("x-ghola-model-route", resolved.route.id);
  headers.set("x-ghola-prompt-confidentiality", resolved.route.privacy.prompt_confidentiality);
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function resolveOpenAiBaseRoute(input: {
  routeId: GholaModelRouteId;
  model: string;
  body: ModelRouterChatBody;
  env: Env;
}): ResolvedOpenAiRoute | { error: string; status: number } {
  const route = listModelRoutes(input.env).data.find((item) => item.id === input.routeId);
  if (!route) return { error: "unknown_model_route", status: 404 };
  if (!route.server_callable) return { error: "model_route_not_server_callable", status: 409 };

  if (input.routeId === "venice") {
    const apiKey = firstSet(input.env, "VENICE_API_KEY", "GHOLA_VENICE_API_KEY");
    if (!apiKey) return { error: "venice_api_key_missing", status: 503 };
    const normalized = normalizeBaseUrl(firstSet(input.env, "VENICE_BASE_URL", "GHOLA_VENICE_BASE_URL") || DEFAULT_VENICE_BASE_URL, {
      allowLocalhost: false,
      allowPrivateNetwork: false,
      allowedHosts: ["api.venice.ai", ...csv(input.env.GHOLA_MODEL_ROUTER_ALLOWED_VENICE_HOSTS)],
      requireAllowlist: true,
    });
    if (!normalized.ok) return { error: normalized.error, status: 400 };
    return { route, model: stripRouteModelPrefix(input.model, input.routeId), baseUrl: normalized.baseUrl, apiKey };
  }

  if (input.routeId === "frontier_openai") {
    const apiKey = firstSet(input.env, "OPENAI_API_KEY", "GHOLA_OPENAI_API_KEY");
    if (!apiKey) return { error: "openai_api_key_missing", status: 503 };
    const normalized = normalizeBaseUrl(firstSet(input.env, "OPENAI_BASE_URL", "GHOLA_OPENAI_BASE_URL") || DEFAULT_OPENAI_BASE_URL, {
      allowLocalhost: false,
      allowPrivateNetwork: false,
      allowedHosts: ["api.openai.com", ...csv(input.env.GHOLA_MODEL_ROUTER_ALLOWED_FRONTIER_HOSTS)],
      requireAllowlist: true,
    });
    if (!normalized.ok) return { error: normalized.error, status: 400 };
    return { route, model: stripRouteModelPrefix(input.model, input.routeId), baseUrl: normalized.baseUrl, apiKey };
  }

  if (input.routeId === "local_openai_compatible") {
    const configuredBase = firstSet(input.env, "GHOLA_LOCAL_OPENAI_BASE_URL", "LOCAL_OPENAI_BASE_URL");
    const requestBase = stringValue(input.body.base_url);
    const userEndpointAllowed = input.env.GHOLA_MODEL_ROUTER_USER_ENDPOINTS_ENABLED === "true";
    const rawBase = configuredBase || (userEndpointAllowed ? requestBase : "");
    if (!rawBase) return { error: "local_openai_endpoint_not_configured", status: 503 };
    const normalized = normalizeBaseUrl(rawBase, {
      allowLocalhost: input.env.NODE_ENV !== "production" || input.env.GHOLA_MODEL_ROUTER_ALLOW_LOCALHOST === "true",
      allowPrivateNetwork: input.env.GHOLA_MODEL_ROUTER_ALLOW_PRIVATE_NETWORK === "true",
      allowedHosts: csv(input.env.GHOLA_MODEL_ROUTER_ALLOWED_ENDPOINT_HOSTS),
      requireAllowlist: Boolean(requestBase && !configuredBase),
    });
    if (!normalized.ok) return { error: normalized.error, status: 400 };
    return {
      route,
      model: stripRouteModelPrefix(input.model, input.routeId),
      baseUrl: normalized.baseUrl,
      apiKey: firstSet(input.env, "GHOLA_LOCAL_OPENAI_API_KEY", "LOCAL_OPENAI_API_KEY") || null,
    };
  }

  return { error: "unsupported_model_route", status: 409 };
}

function buildOpenAiPayload(body: ModelRouterChatBody, model: string, routeId: GholaModelRouteId) {
  const payload: Record<string, unknown> = { model };
  for (const field of SAFE_FORWARD_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (routeId === "venice" && body.venice_parameters !== undefined) {
    payload.venice_parameters = body.venice_parameters;
  }
  return payload;
}

function requestedRouteId(body: ModelRouterChatBody): GholaModelRouteId | null {
  const raw = stringValue(body.route_id) || stringValue(body.route);
  if (!raw) return null;
  if (isRouteId(raw)) return raw;
  return null;
}

function inferRouteIdFromModel(model: string): GholaModelRouteId {
  if (model === "ghola-private" || model.startsWith("agent:")) return "sealed_ghola";
  if (model.startsWith("venice/") || model.startsWith("venice:")) return "venice";
  if (model.startsWith("openai/") || model.startsWith("openai:")) return "frontier_openai";
  if (model.startsWith("local-webgpu/") || model.startsWith("local-webgpu:")) return "local_webgpu";
  if (model.startsWith("ghola-home/") || model.startsWith("ghola-home:")) return "local_ghola_home";
  if (model.startsWith("local/") || model.startsWith("local:")) return "local_openai_compatible";
  return "sealed_ghola";
}

function stripRouteModelPrefix(model: string, routeId: GholaModelRouteId) {
  const prefixes =
    routeId === "venice"
      ? ["venice/", "venice:"]
      : routeId === "frontier_openai"
        ? ["openai/", "openai:"]
        : routeId === "local_openai_compatible"
          ? ["local/", "local:"]
          : [];
  for (const prefix of prefixes) {
    if (model.startsWith(prefix)) return model.slice(prefix.length);
  }
  return model;
}

function guardModelRouterPayload(value: unknown): { ok: true } | { ok: false; error: string; path: string } {
  const found = findForbiddenKey(value, "$");
  if (found) {
    return { ok: false, error: "model_route_rejects_execution_or_credential_payloads", path: found };
  }
  return { ok: true };
}

function findForbiddenKey(value: unknown, path: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findForbiddenKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (path !== "$.messages" && FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      return `${path}.${key}`;
    }
    const nextPath = `${path}.${key}`;
    const found = findForbiddenKey(child, nextPath);
    if (found) return found;
  }
  return null;
}

function promptSensitivity(body: ModelRouterChatBody): GholaPromptSensitivity {
  const ghola = body.ghola && typeof body.ghola === "object" ? body.ghola as Record<string, unknown> : {};
  const raw = stringValue(body.sensitivity) || stringValue(ghola.sensitivity) || "public";
  if (raw === "private" || raw === "execution_sensitive") return raw;
  return "public";
}

function normalizeBaseUrl(raw: string, options: {
  allowLocalhost: boolean;
  allowPrivateNetwork: boolean;
  allowedHosts: string[];
  requireAllowlist: boolean;
}): { ok: true; baseUrl: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_base_url" };
  }
  if (url.username || url.password) return { ok: false, error: "base_url_credentials_not_allowed" };
  if (url.search || url.hash) return { ok: false, error: "base_url_must_not_include_query_or_hash" };
  if (url.protocol !== "https:" && !(options.allowLocalhost && url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return { ok: false, error: "base_url_must_use_https" };
  }
  const hostname = normalizeHost(url.hostname);
  if (!hostname) return { ok: false, error: "invalid_base_url_host" };
  const loopback = isLoopbackHost(hostname);
  if (!options.allowLocalhost && loopback) {
    return { ok: false, error: "localhost_endpoint_not_allowed" };
  }
  if (!(options.allowLocalhost && loopback) && !options.allowPrivateNetwork && isPrivateNetworkHost(hostname)) {
    return { ok: false, error: "private_network_endpoint_not_allowed" };
  }
  if ((options.requireAllowlist || options.allowedHosts.length > 0) && !hostAllowed(hostname, options.allowedHosts)) {
    return { ok: false, error: "endpoint_host_not_allowlisted" };
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  const basePath = pathname.endsWith("/chat/completions")
    ? pathname.slice(0, -"/chat/completions".length) || ""
    : pathname;
  return { ok: true, baseUrl: `${url.protocol}//${url.host}${basePath}` };
}

function hostAllowed(hostname: string, allowedHosts: string[]) {
  if (allowedHosts.length === 0) return false;
  return allowedHosts.some((entry) => {
    const host = normalizeHost(entry);
    if (!host) return false;
    if (host.startsWith(".")) return hostname.endsWith(host);
    return hostname === host;
  });
}

function isPrivateNetworkHost(hostname: string) {
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const parts = hostname.split(".").map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (ipVersion === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
  }
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
}

function isLoopbackHost(hostname: string) {
  const normalized = normalizeHost(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function endpointSummary(raw: string | null): GholaModelRoute["endpoint"] {
  if (!raw) return { configured: false, host: null };
  try {
    const url = new URL(raw);
    return { configured: true, host: url.host };
  } catch {
    return { configured: true, host: null };
  }
}

function staticModels(route: GholaModelRoute): GholaModelRouteModelsResponse["data"] {
  const ids =
    route.id === "local_webgpu"
      ? ["local-webgpu/default"]
      : route.id === "local_ghola_home"
        ? ["ghola-home/default"]
        : route.id === "local_openai_compatible"
          ? ["local/<model-id>"]
          : route.id === "venice"
            ? ["venice/<venice-model-id>"]
            : route.id === "frontier_openai"
              ? ["openai/<openai-model-id>"]
              : ["ghola-private", "agent:<agent-slug>"];
  return ids.map((id) => ({
    id,
    object: "model" as const,
    owned_by: route.id,
    route: route.id,
    source: "static" as const,
    ghola: {
      prompt_confidentiality: route.privacy.prompt_confidentiality,
      trading_execution_allowed: false as const,
    },
  }));
}

function authorizationHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function firstSet(env: Env, ...keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function hasAny(env: Env, ...keys: string[]) {
  return keys.some((key) => Boolean(env[key]?.trim()));
}

function csv(value: string | undefined) {
  return (value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isRouteId(value: string): value is GholaModelRouteId {
  return (
    value === "local_webgpu" ||
    value === "local_ghola_home" ||
    value === "local_openai_compatible" ||
    value === "venice" ||
    value === "frontier_openai" ||
    value === "sealed_ghola"
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...MODEL_ROUTER_HEADERS,
    },
  });
}
