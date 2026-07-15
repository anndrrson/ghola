import type { Event } from "@sentry/nextjs";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "wallet_pubkey",
  "wallet_address",
  "balance",
  "available_micro_usdc",
  "reserved_micro_usdc",
  "ciphertext",
  "encrypted_execution_vault",
  "encrypted_execution_instruction_bundle",
  "api_wallet_private_key",
  "private_key",
  "signature_b64",
]);

export function scrubSentryEvent<T extends Event>(event: T): T | null {
  const scrubbed = scrub(event) as T;
  if (scrubbed.user) scrubbed.user = { id: commitment(String(scrubbed.user.id || "anonymous")) };
  if (scrubbed.request) {
    delete scrubbed.request.cookies;
    delete scrubbed.request.data;
    if (scrubbed.request.headers) scrubbed.request.headers = scrub(scrubbed.request.headers) as Record<string, string>;
  }
  return scrubbed;
}

function scrub(value: unknown, key = ""): unknown {
  const normalizedKey = key.toLowerCase();
  if (
    SENSITIVE_KEYS.has(normalizedKey) ||
    normalizedKey.endsWith("_micro_usdc") ||
    normalizedKey === "wallet" ||
    normalizedKey === "destination_owner" ||
    normalizedKey === "transaction_signature" ||
    (normalizedKey.includes("signature") && !normalizedKey.includes("commitment")) ||
    (normalizedKey.includes("sealed") && !normalizedKey.includes("commitment"))
  ) return "[Redacted]";
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, scrub(child, childKey)]));
}

function commitment(value: string) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `subject_${(hash >>> 0).toString(16)}`;
}
