import { gholaCommitment } from "./private-account";
import type { PrivateFundingInstructionRecordV1 } from "./private-account-store";

export type PrivateShieldedVerifierStatus = "green" | "red";

export type PrivateShieldedVerifierError =
  | "custom_shielded_verifier_unconfigured"
  | "custom_shielded_verifier_unhealthy"
  | "custom_shielded_verifier_stale"
  | "invalid_shielded_receipt"
  | "wrong_shielded_destination"
  | "wrong_amount_bucket"
  | "wrong_asset_bucket"
  | "insufficient_confirmations";

export interface PrivateShieldedVerifierHealth {
  version: 1;
  status: PrivateShieldedVerifierStatus;
  mode: "http" | "local_test" | "unconfigured";
  configured: boolean;
  network: string;
  verifier_commitment: string | null;
  verifier_head_commitment: string | null;
  min_confirmations: number;
  max_stale_ms: number;
  observed_at: string | null;
  checked_at: string;
  reason: string | null;
}

export interface PrivateShieldedVerifierResult {
  version: 1;
  receipt_commitment: string;
  nullifier_commitment: string;
  destination_commitment: string;
  amount_bucket: string;
  asset_bucket: string;
  network: string;
  confirmation_depth: number;
  verifier_commitment: string;
  verifier_head_commitment: string;
  observed_at: string;
}

export async function customShieldedVerifierHealth(
  now: Date = new Date(),
): Promise<PrivateShieldedVerifierHealth> {
  const config = verifierConfig();
  if (config.mode === "local_test") {
    if (process.env.NODE_ENV === "production") {
      return health({
        now,
        status: "red",
        mode: "local_test",
        configured: true,
        reason: "local_test verifier mode is disabled in production",
      });
    }
    return health({
      now,
      status: "green",
      mode: "local_test",
      configured: true,
      verifier_commitment: gholaCommitment("verifier", "local_test"),
      verifier_head_commitment: gholaCommitment("verifier_head", now.toISOString().slice(0, 13)),
      observed_at: now.toISOString(),
    });
  }
  if (!config.verify_url) {
    return health({
      now,
      status: "red",
      mode: "unconfigured",
      configured: false,
      reason: "custom shielded verifier URL is not configured",
    });
  }
  try {
    const healthUrl = config.health_url || healthUrlFromVerifyUrl(config.verify_url);
    const res = await fetch(healthUrl, {
      method: "GET",
      cache: "no-store",
      headers: config.token ? { authorization: `Bearer ${config.token}` } : undefined,
    });
    if (!res.ok) {
      return health({
        now,
        status: "red",
        mode: "http",
        configured: true,
        reason: `verifier health returned ${res.status}`,
      });
    }
    const body = asRecord(await res.json().catch(() => null));
    const observedAt = stringValue(body.observed_at) || stringValue(body.indexed_at);
    if (!observedAt || isStale(observedAt, now, config.max_stale_ms)) {
      return health({
        now,
        status: "red",
        mode: "http",
        configured: true,
        verifier_commitment: stringValue(body.verifier_commitment) || null,
        verifier_head_commitment: stringValue(body.verifier_head_commitment) || null,
        observed_at: observedAt || null,
        reason: "verifier/indexer state is stale",
      });
    }
    return health({
      now,
      status: body.status === "red" ? "red" : "green",
      mode: "http",
      configured: true,
      verifier_commitment: stringValue(body.verifier_commitment) || null,
      verifier_head_commitment: stringValue(body.verifier_head_commitment) || null,
      observed_at: observedAt,
      reason: body.status === "red" ? stringValue(body.reason) || "verifier health is red" : null,
    });
  } catch {
    return health({
      now,
      status: "red",
      mode: "http",
      configured: true,
      reason: "verifier health check failed",
    });
  }
}

export async function verifyCustomShieldedDepositReceipt(input: {
  instruction: PrivateFundingInstructionRecordV1;
  receipt_id: string;
  now?: Date;
}): Promise<
  | { ok: true; result: PrivateShieldedVerifierResult }
  | { ok: false; error: PrivateShieldedVerifierError; health: PrivateShieldedVerifierHealth }
> {
  const now = input.now ?? new Date();
  const config = verifierConfig();
  const healthStatus = await customShieldedVerifierHealth(now);
  if (healthStatus.status !== "green") {
    return {
      ok: false,
      error: healthStatus.configured ? "custom_shielded_verifier_unhealthy" : "custom_shielded_verifier_unconfigured",
      health: healthStatus,
    };
  }
  if (config.mode === "local_test") {
    return verifyLocalTestReceipt({ ...input, now, health: healthStatus });
  }
  if (!config.verify_url) {
    return { ok: false, error: "custom_shielded_verifier_unconfigured", health: healthStatus };
  }
  try {
    const res = await fetch(config.verify_url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({
        receipt_id: input.receipt_id,
        destination_commitment: input.instruction.destination_commitment,
        amount_bucket: input.instruction.amount_bucket,
        asset_bucket: input.instruction.asset_bucket,
        network: config.network,
        min_confirmations: config.min_confirmations,
      }),
    });
    const body = asRecord(await res.json().catch(() => null));
    if (!res.ok || body.ok === false) {
      return {
        ok: false,
        error: verifierError(stringValue(body.error)),
        health: healthStatus,
      };
    }
    const parsed = parseVerifierResult({
      body,
      instruction: input.instruction,
      network: config.network,
      min_confirmations: config.min_confirmations,
      max_stale_ms: config.max_stale_ms,
      now,
    });
    return parsed.ok
      ? { ok: true, result: parsed.result }
      : { ok: false, error: parsed.error, health: healthStatus };
  } catch {
    return { ok: false, error: "custom_shielded_verifier_unhealthy", health: healthStatus };
  }
}

function verifyLocalTestReceipt(input: {
  instruction: PrivateFundingInstructionRecordV1;
  receipt_id: string;
  now: Date;
  health: PrivateShieldedVerifierHealth;
}): Promise<
  | { ok: true; result: PrivateShieldedVerifierResult }
  | { ok: false; error: PrivateShieldedVerifierError; health: PrivateShieldedVerifierHealth }
> {
  const config = verifierConfig();
  if (!input.receipt_id.startsWith("custom_receipt_")) {
    return Promise.resolve({ ok: false, error: "invalid_shielded_receipt", health: input.health });
  }
  if (input.receipt_id.includes("wrongdest")) {
    return Promise.resolve({ ok: false, error: "wrong_shielded_destination", health: input.health });
  }
  if (input.receipt_id.includes("wrongamount")) {
    return Promise.resolve({ ok: false, error: "wrong_amount_bucket", health: input.health });
  }
  if (input.receipt_id.includes("wrongasset")) {
    return Promise.resolve({ ok: false, error: "wrong_asset_bucket", health: input.health });
  }
  if (input.receipt_id.includes("lowconf")) {
    return Promise.resolve({ ok: false, error: "insufficient_confirmations", health: input.health });
  }
  if (input.receipt_id.includes("stale")) {
    return Promise.resolve({ ok: false, error: "custom_shielded_verifier_stale", health: input.health });
  }
  return Promise.resolve({
    ok: true,
    result: {
      version: 1,
      receipt_commitment: gholaCommitment("funding_receipt", {
        receipt_id: input.receipt_id,
        destination_commitment: input.instruction.destination_commitment,
        amount_bucket: input.instruction.amount_bucket,
        asset_bucket: input.instruction.asset_bucket,
        network: config.network,
      }),
      nullifier_commitment: gholaCommitment("funding_nullifier", {
        receipt_id: input.receipt_id,
        destination_commitment: input.instruction.destination_commitment,
        network: config.network,
      }),
      destination_commitment: input.instruction.destination_commitment,
      amount_bucket: input.instruction.amount_bucket,
      asset_bucket: input.instruction.asset_bucket,
      network: config.network,
      confirmation_depth: Math.max(config.min_confirmations, 1),
      verifier_commitment: input.health.verifier_commitment || gholaCommitment("verifier", "local_test"),
      verifier_head_commitment: input.health.verifier_head_commitment || gholaCommitment("verifier_head", "local_test"),
      observed_at: input.now.toISOString(),
    },
  });
}

function parseVerifierResult(input: {
  body: Record<string, unknown>;
  instruction: PrivateFundingInstructionRecordV1;
  network: string;
  min_confirmations: number;
  max_stale_ms: number;
  now: Date;
}): { ok: true; result: PrivateShieldedVerifierResult } | { ok: false; error: PrivateShieldedVerifierError } {
  const receiptCommitment = stringValue(input.body.receipt_commitment);
  const nullifierCommitment = stringValue(input.body.nullifier_commitment);
  const destinationCommitment = stringValue(input.body.destination_commitment);
  const amountBucket = stringValue(input.body.amount_bucket);
  const assetBucket = stringValue(input.body.asset_bucket);
  const network = stringValue(input.body.network) || input.network;
  const confirmationDepth = numberValue(input.body.confirmation_depth);
  const verifierCommitment = stringValue(input.body.verifier_commitment);
  const verifierHeadCommitment = stringValue(input.body.verifier_head_commitment);
  const observedAt = stringValue(input.body.observed_at) || stringValue(input.body.indexed_at);
  if (!receiptCommitment || !nullifierCommitment || !verifierCommitment || !verifierHeadCommitment || !observedAt) {
    return { ok: false, error: "invalid_shielded_receipt" };
  }
  if (destinationCommitment !== input.instruction.destination_commitment) {
    return { ok: false, error: "wrong_shielded_destination" };
  }
  if (amountBucket !== input.instruction.amount_bucket) return { ok: false, error: "wrong_amount_bucket" };
  if (assetBucket !== input.instruction.asset_bucket) return { ok: false, error: "wrong_asset_bucket" };
  if (confirmationDepth < input.min_confirmations) return { ok: false, error: "insufficient_confirmations" };
  if (isStale(observedAt, input.now, input.max_stale_ms)) return { ok: false, error: "custom_shielded_verifier_stale" };
  return {
    ok: true,
    result: {
      version: 1,
      receipt_commitment: receiptCommitment,
      nullifier_commitment: nullifierCommitment,
      destination_commitment: destinationCommitment,
      amount_bucket: amountBucket,
      asset_bucket: assetBucket,
      network,
      confirmation_depth: confirmationDepth,
      verifier_commitment: verifierCommitment,
      verifier_head_commitment: verifierHeadCommitment,
      observed_at: new Date(observedAt).toISOString(),
    },
  };
}

export function verifierConfig() {
  const mode = process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE === "local_test"
    ? "local_test" as const
    : "http" as const;
  return {
    mode,
    verify_url: process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_URL?.trim() || "",
    health_url: process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_HEALTH_URL?.trim() || "",
    token: process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_TOKEN?.trim() || "",
    network: process.env.GHOLA_CUSTOM_SHIELDED_NETWORK?.trim() || "custom-shielded-v1",
    min_confirmations: Math.max(1, Number.parseInt(process.env.GHOLA_CUSTOM_SHIELDED_MIN_CONFIRMATIONS || "3", 10) || 3),
    max_stale_ms: Math.max(1_000, Number.parseInt(process.env.GHOLA_CUSTOM_SHIELDED_MAX_STALE_MS || "300000", 10) || 300_000),
  };
}

function health(input: Partial<PrivateShieldedVerifierHealth> & {
  now: Date;
  status: PrivateShieldedVerifierStatus;
  mode: PrivateShieldedVerifierHealth["mode"];
  configured: boolean;
}): PrivateShieldedVerifierHealth {
  const config = verifierConfig();
  return {
    version: 1,
    status: input.status,
    mode: input.mode,
    configured: input.configured,
    network: config.network,
    verifier_commitment: input.verifier_commitment ?? null,
    verifier_head_commitment: input.verifier_head_commitment ?? null,
    min_confirmations: config.min_confirmations,
    max_stale_ms: config.max_stale_ms,
    observed_at: input.observed_at ?? null,
    checked_at: input.now.toISOString(),
    reason: input.reason ?? null,
  };
}

function healthUrlFromVerifyUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = "/health";
    url.search = "";
    return url.toString();
  } catch {
    return value;
  }
}

function verifierError(value: string): PrivateShieldedVerifierError {
  if ([
    "custom_shielded_verifier_unconfigured",
    "custom_shielded_verifier_unhealthy",
    "custom_shielded_verifier_stale",
    "invalid_shielded_receipt",
    "wrong_shielded_destination",
    "wrong_amount_bucket",
    "wrong_asset_bucket",
    "insufficient_confirmations",
  ].includes(value)) {
    return value as PrivateShieldedVerifierError;
  }
  return "invalid_shielded_receipt";
}

function isStale(value: string, now: Date, maxStaleMs: number): boolean {
  const observed = new Date(value).getTime();
  return !Number.isFinite(observed) || now.getTime() - observed > maxStaleMs;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}
