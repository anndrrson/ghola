import { ed25519 } from "@noble/curves/ed25519";

export const BACKPACK_API_URL = "https://api.backpack.exchange";
export const BACKPACK_WS_URL = "wss://ws.backpack.exchange";
export const BACKPACK_SOL_PERP_SYMBOL = "SOL_USDC_PERP";

export type BackpackInstruction =
  | "accountQuery"
  | "balanceQuery"
  | "orderCancel"
  | "orderCancelAll"
  | "orderExecute"
  | "orderQuery"
  | "orderQueryAll"
  | "positionQuery"
  | "subscribe";

export interface BackpackSignedRequestInput {
  instruction: BackpackInstruction;
  params?: Record<string, unknown> | Array<Record<string, unknown>>;
  timestamp?: number;
  windowMs?: number;
  env?: Record<string, string | undefined>;
}

export interface BackpackOrderRequest {
  symbol: typeof BACKPACK_SOL_PERP_SYMBOL;
  side: "Bid" | "Ask";
  orderType: "Market" | "Limit";
  quantity?: string;
  quoteQuantity?: string;
  price?: string;
  postOnly?: boolean;
  reduceOnly?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK";
  selfTradePrevention?: "RejectTaker" | "RejectMaker" | "RejectBoth";
  clientId?: number;
  slippageTolerance?: string;
  slippageToleranceType?: "TickSize" | "Percent";
}

export interface BackpackCancelOrderRequest {
  symbol: typeof BACKPACK_SOL_PERP_SYMBOL;
  orderId?: string;
  clientId?: number;
}

export interface BackpackPooledReadiness {
  venue_id: "backpack";
  status: "ready" | "blocked";
  ready: boolean;
  reason_codes: string[];
  allowed_symbols: string[];
  max_order_notional_usd: number | null;
  daily_notional_cap_usd: number | null;
  post_only_market_making: boolean;
}

export function backpackPooledReadiness(
  env: Record<string, string | undefined> = process.env,
): BackpackPooledReadiness {
  const allowedSymbols = envList(env.GHOLA_BACKPACK_ALLOWED_SYMBOLS || env.PRIVATE_AGENT_BACKPACK_ALLOWED_SYMBOLS)
    .map((symbol) => symbol.toUpperCase());
  const maxOrderNotional = positiveNumber(
    env.GHOLA_BACKPACK_MAX_ORDER_NOTIONAL_USD || env.PRIVATE_AGENT_BACKPACK_MAX_ORDER_NOTIONAL_USD,
  );
  const dailyCap = positiveNumber(
    env.GHOLA_BACKPACK_DAILY_NOTIONAL_CAP_USD || env.PRIVATE_AGENT_BACKPACK_DAILY_NOTIONAL_CAP_USD,
  );
  const reasonCodes = [
    ...(env.GHOLA_BACKPACK_POOLED_ENABLED === "true" ? [] : ["backpack_pooled_disabled"]),
    ...(backpackApiKey(env) ? [] : ["backpack_api_key_missing"]),
    ...(backpackPrivateSeed(env) ? [] : ["backpack_private_key_missing"]),
    ...(allowedSymbols.includes(BACKPACK_SOL_PERP_SYMBOL) ? [] : ["backpack_symbol_allowlist_missing"]),
    ...(maxOrderNotional !== null && maxOrderNotional > 0 && maxOrderNotional <= 5
      ? []
      : ["backpack_max_order_cap_missing"]),
    ...(dailyCap !== null && dailyCap > 0 && dailyCap <= 25
      ? []
      : ["backpack_daily_cap_missing"]),
    ...(env.GHOLA_BACKPACK_POST_ONLY_MM === "true" || env.PRIVATE_AGENT_BACKPACK_POST_ONLY_MM === "true"
      ? []
      : ["backpack_post_only_mm_required"]),
  ];
  return {
    venue_id: "backpack",
    status: reasonCodes.length === 0 ? "ready" : "blocked",
    ready: reasonCodes.length === 0,
    reason_codes: reasonCodes,
    allowed_symbols: allowedSymbols,
    max_order_notional_usd: maxOrderNotional,
    daily_notional_cap_usd: dailyCap,
    post_only_market_making:
      env.GHOLA_BACKPACK_POST_ONLY_MM === "true" || env.PRIVATE_AGENT_BACKPACK_POST_ONLY_MM === "true",
  };
}

export function buildBackpackSigningString(input: Required<Pick<BackpackSignedRequestInput, "instruction">> & {
  params?: Record<string, unknown> | Array<Record<string, unknown>>;
  timestamp: number;
  windowMs: number;
}): string {
  const prefix = `instruction=${input.instruction}`;
  const params = input.params;
  const body = Array.isArray(params)
    ? params.map((item) => `${prefix}&${orderedQuery(item)}`).join("&")
    : `${prefix}${orderedQuery(params ?? {}) ? `&${orderedQuery(params ?? {})}` : ""}`;
  return `${body}&timestamp=${input.timestamp}&window=${input.windowMs}`;
}

export function signedBackpackHeaders(input: BackpackSignedRequestInput): Record<string, string> {
  const env = input.env ?? process.env;
  const apiKey = backpackApiKey(env);
  const seed = backpackPrivateSeed(env);
  if (!apiKey || !seed) throw new Error("backpack_credentials_missing");
  const timestamp = input.timestamp ?? Date.now();
  const windowMs = normalizeWindow(input.windowMs);
  const signingString = buildBackpackSigningString({
    instruction: input.instruction,
    params: input.params,
    timestamp,
    windowMs,
  });
  const signature = ed25519.sign(new TextEncoder().encode(signingString), seed);
  return {
    "X-API-Key": apiKey,
    "X-Signature": Buffer.from(signature).toString("base64"),
    "X-Timestamp": String(timestamp),
    "X-Window": String(windowMs),
  };
}

export async function submitBackpackOrder(input: {
  order: BackpackOrderRequest;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const headers = signedBackpackHeaders({
    env: input.env,
    instruction: "orderExecute",
    params: input.order as unknown as Record<string, unknown>,
  });
  const res = await (input.fetchImpl ?? fetch)(`${BACKPACK_API_URL}/api/v1/order`, {
    method: "POST",
    cache: "no-store",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.order),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`backpack_order_${res.status}`);
  return body;
}

export async function cancelBackpackOrder(input: {
  order: BackpackCancelOrderRequest;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const headers = signedBackpackHeaders({
    env: input.env,
    instruction: "orderCancel",
    params: input.order as unknown as Record<string, unknown>,
  });
  const res = await (input.fetchImpl ?? fetch)(`${BACKPACK_API_URL}/api/v1/order`, {
    method: "DELETE",
    cache: "no-store",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.order),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`backpack_cancel_${res.status}`);
  return body;
}

export async function cancelAllBackpackOrders(input: {
  symbol?: typeof BACKPACK_SOL_PERP_SYMBOL;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const body = {
    symbol: input.symbol ?? BACKPACK_SOL_PERP_SYMBOL,
    orderType: "RestingLimitOrder",
  };
  const headers = signedBackpackHeaders({
    env: input.env,
    instruction: "orderCancelAll",
    params: body as Record<string, unknown>,
  });
  const res = await (input.fetchImpl ?? fetch)(`${BACKPACK_API_URL}/api/v1/orders`, {
    method: "DELETE",
    cache: "no-store",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`backpack_cancel_all_${res.status}`);
  return responseBody;
}

function orderedQuery(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${encodeURIComponent(key)}=${encodeURIComponent(queryValue(item))}`)
    .join("&");
}

function queryValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return String(value);
}

function backpackApiKey(env: Record<string, string | undefined>): string {
  return env.GHOLA_BACKPACK_API_KEY?.trim() ||
    env.PRIVATE_AGENT_BACKPACK_API_KEY?.trim() ||
    "";
}

function backpackPrivateSeed(env: Record<string, string | undefined>): Uint8Array | null {
  const value = env.GHOLA_BACKPACK_API_SECRET?.trim() ||
    env.GHOLA_BACKPACK_API_PRIVATE_KEY_B64?.trim() ||
    env.PRIVATE_AGENT_BACKPACK_API_SECRET?.trim() ||
    "";
  if (!value) return null;
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 32) return new Uint8Array(bytes);
    if (bytes.length === 64) return new Uint8Array(bytes.subarray(0, 32));
  } catch {
    return null;
  }
  return null;
}

function normalizeWindow(value: unknown) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return 5_000;
  return Math.min(60_000, Math.max(1_000, parsed));
}

function envList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
