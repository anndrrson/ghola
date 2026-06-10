import {
  gholaCommitment,
  isFundingAmountBucket,
  type GholaPrivateModeCanaryKind,
  type GholaPrivateModeCanaryStatus,
} from "./private-account";
import {
  getLatestPrivateModeCanary,
  putPrivateModeCanary,
  type PrivateFundingInstructionRecordV1,
  type PrivateModeCanaryRecordV1,
} from "./private-account-store";
import { shieldedPoolConfig } from "./private-account-shielded-pool";
import {
  verifyCustomShieldedDepositReceipt,
  type PrivateShieldedVerifierError,
  type PrivateShieldedVerifierResult,
} from "./private-account-verifier";

const CANARY_KINDS: GholaPrivateModeCanaryKind[] = [
  "unfunded",
  "funded_program",
  "funded_relayer",
];

export interface PrivateModeCanaryImportInput {
  canary_kind: GholaPrivateModeCanaryKind;
  evidence_commitment: string;
  observed_at?: string | null;
  expires_at?: string | null;
  status?: "green" | "red" | null;
  reason?: string | null;
}

export interface PrivateModeCanaryReceiptInput {
  canary_kind: GholaPrivateModeCanaryKind;
  expected_result: "verified" | "rejected";
  expected_error?: PrivateShieldedVerifierError | null;
  receipt_id: string;
  destination_commitment: string;
  amount_bucket: string;
  asset_bucket: string;
}

export type PrivateModeCanaryImportResult =
  | { ok: true; records: PrivateModeCanaryRecordV1[] }
  | { ok: false; error: "invalid_canary_payload"; details: string[] };

export interface PrivateModeCanarySummary {
  version: 1;
  status: "green" | "red";
  production_enabled: boolean;
  canaries: GholaPrivateModeCanaryStatus[];
  reason: string | null;
  checked_at: string;
}

export async function privateModeCanaryStatus(
  now: Date = new Date(),
): Promise<PrivateModeCanarySummary> {
  const config = shieldedPoolConfig();
  if (config.mode === "local_test") {
    const canaries = CANARY_KINDS.map((kind) => localCanary(kind, now));
    return {
      version: 1,
      status: process.env.NODE_ENV === "production" ? "red" : "green",
      production_enabled: false,
      canaries,
      reason: process.env.NODE_ENV === "production"
        ? "local_test canaries are disabled in production"
        : null,
      checked_at: now.toISOString(),
    };
  }

  const productionEnabled = process.env.GHOLA_PRIVATE_MODE_PRODUCTION_ENABLED === "true";
  if (!productionEnabled) {
    return {
      version: 1,
      status: "red",
      production_enabled: false,
      canaries: await canaryRecords(now),
      reason: "production Private Mode is disabled",
      checked_at: now.toISOString(),
    };
  }

  const canaries = await canaryRecords(now);
  const failing = canaries.find((item) => item.status !== "green");
  return {
    version: 1,
    status: failing ? "red" : "green",
    production_enabled: true,
    canaries,
    reason: failing
      ? failing.reason || `${failing.canary_kind} canary is ${failing.status}`
      : null,
    checked_at: now.toISOString(),
  };
}

export async function runPrivateModeCanaries(
  now: Date = new Date(),
): Promise<PrivateModeCanarySummary> {
  const config = shieldedPoolConfig();
  if (config.mode === "local_test") {
    for (const kind of CANARY_KINDS) {
      await putPrivateModeCanary(recordFromStatus(localCanary(kind, now), now));
    }
    return privateModeCanaryStatus(now);
  }

  return privateModeCanaryStatus(now);
}

export async function importPrivateModeCanaryEvidence(
  canaries: unknown,
  now: Date = new Date(),
  verifyReceipt: typeof verifyCustomShieldedDepositReceipt = verifyCustomShieldedDepositReceipt,
): Promise<PrivateModeCanaryImportResult> {
  const inputs = Array.isArray(canaries) ? canaries : [canaries];
  const parsed: Array<
    | { mode: "receipt"; input: NormalizedCanaryReceiptInput }
    | { mode: "raw"; status: GholaPrivateModeCanaryStatus }
  > = [];
  const details: string[] = [];
  const allowRawEvidence = shieldedPoolConfig().mode === "local_test";
  inputs.forEach((input, index) => {
    const record = objectRecord(input);
    if (!record) {
      details.push(`canaries[${index}] must be an object`);
      return;
    }
    if (looksLikeReceiptCanary(record)) {
      const normalized = normalizeReceiptCanary(record, index);
      if (normalized.ok) {
        parsed.push({ mode: "receipt", input: normalized.input });
      } else {
        details.push(...normalized.details);
      }
      return;
    }
    if (allowRawEvidence) {
      const normalized = normalizeImportedCanary(record, now);
      if (normalized) {
        parsed.push({ mode: "raw", status: normalized });
        return;
      }
    }
    details.push(
      `canaries[${index}] must provide receipt_id, destination_commitment, amount_bucket, asset_bucket, and expected_result; raw evidence_commitment is not accepted outside local_test mode`,
    );
  });
  if (details.length > 0) return { ok: false, error: "invalid_canary_payload", details };

  const records: PrivateModeCanaryRecordV1[] = [];
  for (const entry of parsed) {
    if (entry.mode === "raw") {
      records.push(await putPrivateModeCanary(recordFromStatus(entry.status, now)));
      continue;
    }
    const status = await verifyReceiptCanary(entry.input, now, verifyReceipt);
    records.push(await putPrivateModeCanary(recordFromStatus(status, now)));
  }
  return { ok: true, records };
}

async function canaryRecords(now: Date): Promise<GholaPrivateModeCanaryStatus[]> {
  return Promise.all(CANARY_KINDS.map(async (kind) => {
    const fromStore = await getLatestPrivateModeCanary(kind);
    return fromStore ? statusFromRecord(fromStore, now) : missingCanary(kind);
  }));
}

function localCanary(
  kind: GholaPrivateModeCanaryKind,
  now: Date,
): GholaPrivateModeCanaryStatus {
  return {
    version: 1,
    canary_kind: kind,
    status: "green",
    evidence_commitment: gholaCommitment("private_mode_canary", {
      kind,
      mode: "local_test",
    }),
    observed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    reason: null,
  };
}

function missingCanary(
  kind: GholaPrivateModeCanaryKind,
): GholaPrivateModeCanaryStatus {
  return {
    version: 1,
    canary_kind: kind,
    status: "missing",
    evidence_commitment: null,
    observed_at: null,
    expires_at: null,
    reason: `${kind} verified canary evidence is missing`,
  };
}

function statusFromRecord(
  record: PrivateModeCanaryRecordV1,
  now: Date,
): GholaPrivateModeCanaryStatus {
  const expired = new Date(record.expires_at).getTime() <= now.getTime();
  return {
    version: 1,
    canary_kind: record.canary_kind,
    status: expired ? "stale" : record.status,
    evidence_commitment: record.evidence_commitment,
    observed_at: record.observed_at,
    expires_at: record.expires_at,
    reason: expired ? `${record.canary_kind} canary evidence is stale` : record.reason,
  };
}

function recordFromStatus(
  status: GholaPrivateModeCanaryStatus,
  now: Date,
): PrivateModeCanaryRecordV1 {
  return {
    version: 1,
    canary_id: gholaCommitment("private_mode_canary_record", {
      canary_kind: status.canary_kind,
      evidence_commitment: status.evidence_commitment,
      observed_at: status.observed_at,
    }),
    canary_kind: status.canary_kind,
    status: status.status === "green" ? "green" : "red",
    evidence_commitment: status.evidence_commitment,
    observed_at: status.observed_at ?? now.toISOString(),
    expires_at: status.expires_at ?? new Date(now.getTime() + canaryMaxAgeMs(status.canary_kind)).toISOString(),
    reason: status.reason,
    created_at: now.toISOString(),
  };
}

function canaryMaxAgeMs(kind: GholaPrivateModeCanaryKind): number {
  const specific = process.env[`GHOLA_PRIVATE_MODE_CANARY_${kind.toUpperCase()}_MAX_STALE_MS`];
  const fallback = process.env.GHOLA_PRIVATE_MODE_CANARY_MAX_STALE_MS;
  const parsed = Number.parseInt(specific || fallback || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24 * 60 * 60 * 1_000;
}

function normalizeImportedCanary(
  value: unknown,
  now: Date,
): GholaPrivateModeCanaryStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = stringValue(record.canary_kind);
  if (!isCanaryKind(kind)) return null;
  const evidence = stringValue(record.evidence_commitment);
  if (!evidence) return null;
  const observedAt = parseIsoOrNull(stringValue(record.observed_at)) ?? now.toISOString();
  const maxAgeMs = canaryMaxAgeMs(kind);
  const expiresAt = parseIsoOrNull(stringValue(record.expires_at)) ??
    new Date(new Date(observedAt).getTime() + maxAgeMs).toISOString();
  const expired = new Date(expiresAt).getTime() <= now.getTime();
  const statusInput = stringValue(record.status);
  const status = expired
    ? "stale" as const
    : statusInput === "red" ? "red" as const : "green" as const;
  return {
    version: 1,
    canary_kind: kind,
    status,
    evidence_commitment: evidence,
    observed_at: observedAt,
    expires_at: expiresAt,
    reason: status === "stale"
      ? `${kind} canary evidence is stale`
      : stringValue(record.reason) || null,
  };
}

type NormalizedCanaryReceiptInput = PrivateModeCanaryReceiptInput & {
  expected_error: PrivateShieldedVerifierError | null;
};

type NormalizedReceiptResult =
  | { ok: true; input: NormalizedCanaryReceiptInput }
  | { ok: false; details: string[] };

type VerifyReceiptResult = Awaited<ReturnType<typeof verifyCustomShieldedDepositReceipt>>;

function looksLikeReceiptCanary(record: Record<string, unknown>): boolean {
  return Boolean(
    record.receipt_id ||
      record.expected_result ||
      record.destination_commitment ||
      record.amount_bucket ||
      record.asset_bucket,
  );
}

function normalizeReceiptCanary(
  record: Record<string, unknown>,
  index: number,
): NormalizedReceiptResult {
  const details: string[] = [];
  const kind = stringValue(record.canary_kind);
  if (!isCanaryKind(kind)) details.push(`canaries[${index}].canary_kind is invalid`);
  const expectedResult = stringValue(record.expected_result);
  if (!["verified", "rejected"].includes(expectedResult)) {
    details.push(`canaries[${index}].expected_result must be "verified" or "rejected"`);
  }
  if (kind === "unfunded" && expectedResult !== "rejected") {
    details.push("unfunded canary must expect a verifier rejection");
  }
  if ((kind === "funded_program" || kind === "funded_relayer") && expectedResult !== "verified") {
    details.push(`${kind} canary must expect verifier success`);
  }

  const expectedError = stringValue(record.expected_error);
  if (expectedResult === "rejected" && !isVerifierError(expectedError)) {
    details.push(`canaries[${index}].expected_error must be a known verifier error`);
  }
  if (expectedResult === "verified" && expectedError) {
    details.push(`canaries[${index}].expected_error is only valid for rejected canaries`);
  }

  const receiptId = stringValue(record.receipt_id);
  if (!receiptId) details.push(`canaries[${index}].receipt_id is required`);
  const destinationCommitment = stringValue(record.destination_commitment);
  if (!destinationCommitment) details.push(`canaries[${index}].destination_commitment is required`);
  const amountBucket = stringValue(record.amount_bucket);
  if (!isFundingAmountBucket(amountBucket)) {
    details.push(`canaries[${index}].amount_bucket is invalid`);
  }
  const assetBucket = stringValue(record.asset_bucket);
  if (!isFundingAssetBucket(assetBucket)) {
    details.push(`canaries[${index}].asset_bucket is invalid`);
  }

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    input: {
      canary_kind: kind as GholaPrivateModeCanaryKind,
      expected_result: expectedResult as "verified" | "rejected",
      expected_error: expectedResult === "rejected"
        ? expectedError as PrivateShieldedVerifierError
        : null,
      receipt_id: receiptId,
      destination_commitment: destinationCommitment,
      amount_bucket: amountBucket,
      asset_bucket: assetBucket,
    },
  };
}

async function verifyReceiptCanary(
  input: NormalizedCanaryReceiptInput,
  now: Date,
  verifyReceipt: typeof verifyCustomShieldedDepositReceipt,
): Promise<GholaPrivateModeCanaryStatus> {
  const instruction = canaryFundingInstruction(input, now);
  const verified = await verifyReceipt({ instruction, receipt_id: input.receipt_id, now });
  if (verified.ok) return statusFromAcceptedCanary(input, verified.result, now);
  return statusFromRejectedCanary(input, verified, now);
}

function statusFromAcceptedCanary(
  input: NormalizedCanaryReceiptInput,
  result: PrivateShieldedVerifierResult,
  now: Date,
): GholaPrivateModeCanaryStatus {
  const observedAt = result.observed_at;
  const expected = input.expected_result === "verified";
  return {
    version: 1,
    canary_kind: input.canary_kind,
    status: expected ? "green" : "red",
    evidence_commitment: gholaCommitment(
      expected ? "verified_private_mode_canary" : "private_mode_canary_unexpected_accept",
      {
        canary_kind: input.canary_kind,
        receipt_commitment: result.receipt_commitment,
        nullifier_commitment: result.nullifier_commitment,
        verifier_commitment: result.verifier_commitment,
        verifier_head_commitment: result.verifier_head_commitment,
        confirmation_depth: result.confirmation_depth,
        network: result.network,
        destination_commitment: result.destination_commitment,
        amount_bucket: result.amount_bucket,
        asset_bucket: result.asset_bucket,
      },
    ),
    observed_at: observedAt,
    expires_at: expiresAt(observedAt, input.canary_kind, now),
    reason: expected ? null : `${input.canary_kind} canary receipt unexpectedly verified`,
  };
}

function statusFromRejectedCanary(
  input: NormalizedCanaryReceiptInput,
  rejected: Extract<VerifyReceiptResult, { ok: false }>,
  now: Date,
): GholaPrivateModeCanaryStatus {
  const observedAt = rejected.health.observed_at ?? now.toISOString();
  const expected = input.expected_result === "rejected" && rejected.error === input.expected_error;
  return {
    version: 1,
    canary_kind: input.canary_kind,
    status: expected ? "green" : "red",
    evidence_commitment: gholaCommitment(
      expected ? "verified_private_mode_negative_canary" : "private_mode_canary_rejected",
      {
        canary_kind: input.canary_kind,
        expected_result: input.expected_result,
        expected_error: input.expected_error,
        error: rejected.error,
        verifier_commitment: rejected.health.verifier_commitment,
        verifier_head_commitment: rejected.health.verifier_head_commitment,
        network: rejected.health.network,
        destination_commitment: input.destination_commitment,
        amount_bucket: input.amount_bucket,
        asset_bucket: input.asset_bucket,
      },
    ),
    observed_at: observedAt,
    expires_at: expiresAt(observedAt, input.canary_kind, now),
    reason: expected
      ? null
      : input.expected_result === "verified"
        ? `${input.canary_kind} verifier rejected canary receipt with ${rejected.error}`
        : `${input.canary_kind} verifier rejected with ${rejected.error}; expected ${input.expected_error}`,
  };
}

function canaryFundingInstruction(
  input: NormalizedCanaryReceiptInput,
  now: Date,
): PrivateFundingInstructionRecordV1 {
  return {
    version: 1,
    funding_intent_id: `canary_${input.canary_kind}_${gholaCommitment("canary_receipt", input.receipt_id).slice(0, 16)}`,
    owner_commitment: gholaCommitment("private_mode_canary_owner", input.canary_kind),
    account_commitment: gholaCommitment("private_mode_canary_account", input.canary_kind),
    funding_intent_commitment: gholaCommitment("private_mode_canary_funding_intent", {
      canary_kind: input.canary_kind,
      receipt_id: input.receipt_id,
      destination_commitment: input.destination_commitment,
    }),
    asset_bucket: input.asset_bucket,
    amount_bucket: input.amount_bucket,
    shielded_rail: "custom_shielded_deposit",
    destination_commitment: input.destination_commitment,
    shielded_destination: gholaCommitment("private_mode_canary_destination", input.destination_commitment),
    status: "pending",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + canaryMaxAgeMs(input.canary_kind)).toISOString(),
    updated_at: now.toISOString(),
  };
}

function expiresAt(observedAt: string, kind: GholaPrivateModeCanaryKind, now: Date): string {
  const observedTime = new Date(observedAt).getTime();
  const base = Number.isFinite(observedTime) ? observedTime : now.getTime();
  return new Date(base + canaryMaxAgeMs(kind)).toISOString();
}

function isCanaryKind(value: string): value is GholaPrivateModeCanaryKind {
  return CANARY_KINDS.includes(value as GholaPrivateModeCanaryKind);
}

function isFundingAssetBucket(value: string): boolean {
  return ["stablecoin", "SOL", "ETH", "BTC", "major", "long_tail"].includes(value);
}

function isVerifierError(value: string): value is PrivateShieldedVerifierError {
  return [
    "custom_shielded_verifier_unconfigured",
    "custom_shielded_verifier_unhealthy",
    "custom_shielded_verifier_stale",
    "invalid_shielded_receipt",
    "wrong_shielded_destination",
    "wrong_amount_bucket",
    "wrong_asset_bucket",
    "insufficient_confirmations",
  ].includes(value);
}

function parseIsoOrNull(value: string): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(value).toISOString() : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
