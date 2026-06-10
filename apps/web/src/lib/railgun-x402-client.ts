import {
  decapsulateResponse,
  decodeBhttpResponse,
  encapsulateRequest,
  encodeBhttpRequest,
  parseKeyConfig,
  type OhttpKeyConfig,
} from "./ohttp";
import { thumperRelayBase } from "./sovereignty";

export interface X402PaymentRequirements {
  x402Version?: number;
  accepts?: X402PaymentOption[];
}

export interface X402PaymentOption {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  destination: string;
  extra?: {
    payment_rail?: string;
    canonical_rail?: string;
    privacy_disclosure?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RailgunX402PaymentProvider {
  createPayment(option: X402PaymentOption): Promise<{
    paymentHeader: string;
    txHash?: string;
  }>;
}

declare global {
  interface Window {
    gholaRailgunX402Provider?: RailgunX402PaymentProvider;
    railgunX402Provider?: RailgunX402PaymentProvider;
  }
}

export interface FetchWithRailgunX402Options extends RequestInit {
  provider: RailgunX402PaymentProvider;
  rail?: "railgun_evm_shielded" | "private_shielded_auto";
  ohttpRelay?: string;
}

let cachedOhttpKey: { ts: number; cfg: OhttpKeyConfig } | null = null;
const OHTTP_KEY_TTL_MS = 60 * 60 * 1000;

function configuredOhttpRelay(explicitRelay?: string): string | undefined {
  if (explicitRelay !== undefined) return explicitRelay || undefined;
  return typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_OHTTP_RELAY_URL || undefined
    : undefined;
}

function paymentRequiredHeader(res: Response): string | null {
  return res.headers.get("payment-required") || res.headers.get("x-payment-required");
}

function decodeBase64Json<T>(encoded: string): T {
  const json =
    typeof atob === "function"
      ? atob(encoded)
      : Buffer.from(encoded, "base64").toString("utf8");
  return JSON.parse(json) as T;
}

async function paymentRequirements(res: Response): Promise<X402PaymentRequirements> {
  const header = paymentRequiredHeader(res);
  if (header) return decodeBase64Json<X402PaymentRequirements>(header);
  const body = await res.json().catch(() => null);
  if (body?.payment_requirements) {
    return body.payment_requirements as X402PaymentRequirements;
  }
  throw new Error("Payment required, but no x402 payment requirements were returned.");
}

function selectRailgunOption(requirements: X402PaymentRequirements): X402PaymentOption {
  const option = requirements.accepts?.find(
    (candidate) =>
      candidate.scheme === "railgun_evm_shielded" ||
      candidate.extra?.payment_rail === "railgun_evm_shielded" ||
      candidate.extra?.canonical_rail === "railgun_evm_shielded",
  );
  if (!option) {
    throw new Error("Railgun/EVM settlement is not available for this request.");
  }
  return option;
}

export function browserRailgunX402Provider(): RailgunX402PaymentProvider | null {
  if (typeof window === "undefined") return null;
  const candidate =
    window.gholaRailgunX402Provider ?? window.railgunX402Provider ?? null;
  if (
    candidate &&
    typeof candidate.createPayment === "function"
  ) {
    return candidate;
  }
  return null;
}

async function gatewayKeyConfig(): Promise<OhttpKeyConfig> {
  const now = Date.now();
  if (cachedOhttpKey && now - cachedOhttpKey.ts < OHTTP_KEY_TTL_MS) {
    return cachedOhttpKey.cfg;
  }
  const res = await fetch(new URL("/ohttp-keys", thumperRelayBase()).toString(), {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`OHTTP keyconfig unavailable: ${res.status}`);
  const cfg = parseKeyConfig(new Uint8Array(await res.arrayBuffer()));
  cachedOhttpKey = { ts: now, cfg };
  return cfg;
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error("OHTTP x402 transport supports string, Blob, ArrayBuffer, or Uint8Array bodies.");
}

function innerPath(input: RequestInfo | URL): string {
  const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
  if (url.pathname !== "/v1/chat/completions") {
    throw new Error(`OHTTP x402 transport only supports /v1/chat/completions, got ${url.pathname}`);
  }
  return url.pathname;
}

function normalizedChatCompletionsMethod(method: string | undefined): "POST" {
  const normalized = (method ?? "POST").toUpperCase();
  if (normalized !== "POST") {
    throw new Error(`Railgun x402 chat completions only supports POST, got ${normalized}`);
  }
  return "POST";
}

function bhttpHeaders(headers: Headers): Array<[string, string]> {
  const allowed = [
    "accept",
    "authorization",
    "content-type",
    "payment-signature",
    "x-payment",
    "x402-payment",
    "x-ghola-payment-rail",
    "x-payment-rail",
  ];
  const out: Array<[string, string]> = [];
  for (const name of allowed) {
    const value = headers.get(name);
    if (value && !/[\r\n]/.test(value)) out.push([name, value]);
  }
  return out;
}

async function fetchViaOhttp(
  input: RequestInfo | URL,
  init: RequestInit,
  ohttpRelay: string,
): Promise<Response> {
  const path = innerPath(input);
  const keyConfig = await gatewayKeyConfig();
  const relayBase = new URL(thumperRelayBase());
  const headers = new Headers(init.headers);
  const bhttp = encodeBhttpRequest({
    method: normalizedChatCompletionsMethod(init.method),
    scheme: relayBase.protocol.replace(":", ""),
    authority: relayBase.host,
    path,
    headers: bhttpHeaders(headers),
    body: await bodyBytes(init.body),
  });
  const { capsule, context } = await encapsulateRequest(keyConfig, bhttp);
  const outer = await fetch(ohttpRelay, {
    method: "POST",
    headers: { "Content-Type": "message/ohttp-req" },
    body: new Blob([new Uint8Array(capsule)], { type: "message/ohttp-req" }),
  });
  if (!outer.ok) {
    throw new Error(`OHTTP x402 relay failed: ${outer.status}`);
  }
  const inner = decodeBhttpResponse(
    await decapsulateResponse(context, new Uint8Array(await outer.arrayBuffer())),
  );
  const bodyCopy = new Uint8Array(inner.body);
  const responseBody = bodyCopy.buffer.slice(
    bodyCopy.byteOffset,
    bodyCopy.byteOffset + bodyCopy.byteLength,
  );
  return new Response(responseBody, {
    status: inner.status,
    headers: inner.headers,
  });
}

export async function fetchWithRailgunX402(
  input: RequestInfo | URL,
  options: FetchWithRailgunX402Options,
): Promise<Response> {
  const { provider, rail = "railgun_evm_shielded", headers, body, ohttpRelay, ...init } = options;
  const relay = configuredOhttpRelay(ohttpRelay);
  const method = normalizedChatCompletionsMethod(init.method);
  const transportFetch = (requestHeaders: Headers) =>
    relay
      ? fetchViaOhttp(input, { ...init, method, headers: requestHeaders, body }, relay)
      : fetch(input, {
          ...init,
          method,
          headers: requestHeaders,
          body,
        });
  const firstHeaders = new Headers(headers);
  firstHeaders.set("x-ghola-payment-rail", rail);

  const first = await transportFetch(firstHeaders);
  if (first.status !== 402) return first;

  const requirements = await paymentRequirements(first);
  const selected = selectRailgunOption(requirements);
  if (!selected.extra?.request_hash || typeof selected.extra.request_hash !== "string") {
    throw new Error("Railgun/EVM settlement is missing a request_hash binding.");
  }
  const payment = await provider.createPayment(selected);

  const retryHeaders = new Headers(headers);
  retryHeaders.set("x-ghola-payment-rail", "railgun_evm_shielded");
  retryHeaders.set("x402-payment", payment.paymentHeader);
  retryHeaders.set("payment-signature", payment.paymentHeader);

  return transportFetch(retryHeaders);
}
