import { z } from "zod";

export const KRAKEN_V2_VERSION = 1;
export const USD_ASSET_ID = "USD";

const commitment = z.string().min(8).max(200);
const identifier = z.string().regex(/^[A-Za-z0-9._:-]{3,160}$/);
const positiveDecimal = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const normalized = String(value).trim();
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) {
    ctx.addIssue({ code: "custom", message: "must be a positive decimal" });
    return z.NEVER;
  }
  return normalized;
});

export const canonicalXStockIdSchema = z
  .string()
  .regex(/^US_EQUITY:[A-Z0-9.]{1,16}$/);

export const jurisdictionAttestationSchema = z.object({
  version: z.literal(1),
  country_code: z.string().regex(/^[A-Z]{2}$/),
  assertion: z.literal("eligible_non_restricted_user"),
  terms_version: z.string().min(8).max(100),
  risk_disclosure_version: z.string().min(8).max(100),
  signed_at: z.string().datetime(),
  signature_commitment: commitment,
}).strict();

export const krakenConnectionSchema = z.object({
  version: z.literal(1),
  connection_id: identifier,
  owner_commitment: commitment,
  account_commitment: commitment,
  encrypted_execution_vault: z.object({
    alg: z.literal("sealed-provider-v1"),
    ciphertext: z.string().min(64),
    recipient: z.string().min(8),
    aad: z.string().min(8),
  }).strict(),
  jurisdiction: jurisdictionAttestationSchema,
}).strict();

export const sleeveSchema = z.object({
  sleeve_id: identifier,
  label: z.string().min(1).max(80),
  capital_weight_bps: z.number().int().min(1).max(10_000),
  agent_subject: identifier,
}).strict();

export const krakenMandateSchema = z.object({
  version: z.literal(1),
  mandate_id: identifier,
  connection_id: identifier,
  owner_commitment: commitment,
  account_commitment: commitment,
  sleeves: z.array(sleeveSchema).min(1).max(32),
  limits: z.object({
    max_single_order_usd: positiveDecimal,
    max_daily_turnover_usd: positiveDecimal,
    max_slippage_bps: z.number().int().min(1).max(10_000),
    max_asset_weight_bps: z.number().int().min(1).max(10_000),
    max_drawdown_bps: z.number().int().min(1).max(10_000),
    max_orders_per_rebalance: z.number().int().min(1).max(1_000),
    min_order_usd: positiveDecimal,
    drift_threshold_bps: z.number().int().min(1).max(10_000),
    max_quote_age_ms: z.number().int().min(250).max(300_000),
    max_intent_ttl_seconds: z.number().int().min(30).max(86_400),
  }).strict(),
  status: z.enum(["active", "paused", "killed"]).default("active"),
  approved_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  approval_commitment: commitment,
}).strict().superRefine((value, ctx) => {
  const total = value.sleeves.reduce((sum, sleeve) => sum + sleeve.capital_weight_bps, 0);
  if (total !== 10_000) {
    ctx.addIssue({
      code: "custom",
      path: ["sleeves"],
      message: "sleeve capital weights must total 10000 bps",
    });
  }
  const approved = Date.parse(value.approved_at);
  const expires = Date.parse(value.expires_at);
  if (expires <= approved || expires - approved > 24 * 60 * 60 * 1_000) {
    ctx.addIssue({
      code: "custom",
      path: ["expires_at"],
      message: "mandate must expire within 24 hours of approval",
    });
  }
});

export const allocationIntentSchema = z.object({
  version: z.literal(1),
  connection_id: identifier,
  owner_commitment: commitment,
  account_commitment: commitment,
  sleeve_id: identifier,
  agent_subject: identifier,
  sequence: z.number().int().nonnegative(),
  idempotency_key: identifier,
  effective_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  weights_bps: z.record(
    z.string().regex(/^(USD|US_EQUITY:[A-Z0-9.]{1,16})$/),
    z.number().int().min(0).max(10_000),
  ),
  request_signature_commitment: commitment,
}).strict().superRefine((value, ctx) => {
  const total = Object.values(value.weights_bps).reduce((sum, weight) => sum + weight, 0);
  if (total !== 10_000) {
    ctx.addIssue({
      code: "custom",
      path: ["weights_bps"],
      message: "allocation weights must total 10000 bps",
    });
  }
  if (!Object.prototype.hasOwnProperty.call(value.weights_bps, USD_ASSET_ID)) {
    ctx.addIssue({
      code: "custom",
      path: ["weights_bps", USD_ASSET_ID],
      message: "allocation must include an explicit USD weight",
    });
  }
  if (Date.parse(value.expires_at) <= Date.parse(value.effective_at)) {
    ctx.addIssue({
      code: "custom",
      path: ["expires_at"],
      message: "allocation expiry must follow its effective time",
    });
  }
});

export const credentialVaultSchema = z.object({
  version: z.literal(1),
  kind: z.literal("ghola_kraken_spot_execution_vault"),
  api_key: z.string().min(8),
  api_secret_base64: z.string().min(16),
  base_url: z.string().url().optional(),
  allowed_operations: z.array(z.string()).optional(),
  blocked_operations: z.array(z.string()).optional(),
  created_at: z.string().datetime().optional(),
}).strict();

export function parseConnection(value) {
  return krakenConnectionSchema.parse(value);
}

export function parseMandate(value, now = new Date()) {
  const mandate = krakenMandateSchema.parse(value);
  if (Date.parse(mandate.expires_at) <= now.getTime()) {
    throw new KrakenV2ValidationError("mandate is expired", "mandate_expired");
  }
  return mandate;
}

export function parseAllocationIntent(value, mandate, now = new Date()) {
  const intent = allocationIntentSchema.parse(value);
  if (
    intent.owner_commitment !== mandate.owner_commitment ||
    intent.account_commitment !== mandate.account_commitment
  ) {
    throw new KrakenV2ValidationError("allocation owner mismatch", "owner_mismatch", 403);
  }
  if (intent.connection_id !== mandate.connection_id) {
    throw new KrakenV2ValidationError("allocation connection mismatch", "connection_mismatch");
  }
  const sleeve = mandate.sleeves.find((item) => item.sleeve_id === intent.sleeve_id);
  if (!sleeve) {
    throw new KrakenV2ValidationError("allocation sleeve is not authorized", "sleeve_not_authorized");
  }
  if (sleeve.agent_subject !== intent.agent_subject) {
    throw new KrakenV2ValidationError("allocation agent is not authorized", "agent_not_authorized");
  }
  const ttlMs = Date.parse(intent.expires_at) - Date.parse(intent.effective_at);
  if (ttlMs > mandate.limits.max_intent_ttl_seconds * 1_000) {
    throw new KrakenV2ValidationError("allocation TTL exceeds mandate", "intent_ttl_exceeded");
  }
  if (Date.parse(intent.expires_at) <= now.getTime()) {
    throw new KrakenV2ValidationError("allocation is expired", "intent_expired");
  }
  for (const [asset, weight] of Object.entries(intent.weights_bps)) {
    if (asset !== USD_ASSET_ID && weight > mandate.limits.max_asset_weight_bps) {
      throw new KrakenV2ValidationError(
        `allocation weight for ${asset} exceeds mandate`,
        "asset_weight_exceeded",
      );
    }
  }
  return intent;
}

export function canonicalInstrumentId(ticker) {
  const normalized = String(ticker || "")
    .trim()
    .toUpperCase()
    .replace(/X$/, "");
  return `US_EQUITY:${normalized}`;
}

export class KrakenV2ValidationError extends Error {
  constructor(message, code = "invalid_request", status = 400) {
    super(message);
    this.name = "KrakenV2ValidationError";
    this.code = code;
    this.status = status;
  }
}
