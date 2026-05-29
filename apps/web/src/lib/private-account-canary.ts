import {
  gholaCommitment,
  type GholaPrivateModeCanaryKind,
  type GholaPrivateModeCanaryStatus,
} from "./private-account";
import {
  getLatestPrivateModeCanary,
  putPrivateModeCanary,
  type PrivateModeCanaryRecordV1,
} from "./private-account-store";
import { shieldedPoolConfig } from "./private-account-shielded-pool";

const CANARY_KINDS: GholaPrivateModeCanaryKind[] = [
  "unfunded",
  "funded_program",
  "funded_relayer",
];

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

  for (const kind of CANARY_KINDS) {
    const envStatus = envCanary(kind, now);
    if (envStatus.evidence_commitment) {
      await putPrivateModeCanary(recordFromStatus(envStatus, now));
    }
  }
  return privateModeCanaryStatus(now);
}

async function canaryRecords(now: Date): Promise<GholaPrivateModeCanaryStatus[]> {
  return Promise.all(CANARY_KINDS.map(async (kind) => {
    const fromStore = await getLatestPrivateModeCanary(kind);
    const fromEnv = envCanary(kind, now);
    const chosen = fromStore && (!fromEnv.observed_at || fromStore.observed_at >= fromEnv.observed_at)
      ? statusFromRecord(fromStore, now)
      : fromEnv;
    return chosen;
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

function envCanary(
  kind: GholaPrivateModeCanaryKind,
  now: Date,
): GholaPrivateModeCanaryStatus {
  const prefix = `GHOLA_PRIVATE_MODE_CANARY_${kind.toUpperCase()}`;
  const evidence = process.env[`${prefix}_COMMITMENT`]?.trim() || "";
  const observedAt = process.env[`${prefix}_OBSERVED_AT`]?.trim() || "";
  const maxAgeMs = canaryMaxAgeMs(kind);
  if (!evidence || !observedAt) {
    return {
      version: 1,
      canary_kind: kind,
      status: "missing",
      evidence_commitment: null,
      observed_at: observedAt || null,
      expires_at: null,
      reason: `${kind} canary evidence is missing`,
    };
  }
  const observedTime = new Date(observedAt).getTime();
  const stale = !Number.isFinite(observedTime) || now.getTime() - observedTime > maxAgeMs;
  return {
    version: 1,
    canary_kind: kind,
    status: stale ? "stale" : "green",
    evidence_commitment: evidence,
    observed_at: new Date(observedAt).toISOString(),
    expires_at: Number.isFinite(observedTime)
      ? new Date(observedTime + maxAgeMs).toISOString()
      : null,
    reason: stale ? `${kind} canary evidence is stale` : null,
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
