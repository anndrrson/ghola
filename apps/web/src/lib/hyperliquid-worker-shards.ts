import { createHash } from "node:crypto";

export interface HyperliquidWorkerShard {
  id: string;
  url: string;
  recipient_id: string;
  x25519_pub_hex: string;
  image_digest: string;
  token_env: string | null;
  measurement_hex: string | null;
  attestation_hash: string | null;
  attested_ready: boolean;
}

const HEX_32 = /^[0-9a-f]{64}$/i;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/i;
const HEALTH_CACHE_MS = 15_000;
const shardHealthCache = new Map<string, { expires_at: number; promise: Promise<boolean> }>();

export function configuredHyperliquidWorkerShards(
  env: Record<string, string | undefined> = process.env,
): HyperliquidWorkerShard[] {
  const raw = env.GHOLA_HYPERLIQUID_WORKER_SHARDS_JSON?.trim();
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const ids = new Set<string>();
  const recipients = new Set<string>();
  const shards: HyperliquidWorkerShard[] = [];
  for (const value of decoded) {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const id = stringField(item.id);
    const url = safeHttpsUrl(stringField(item.url), env.NODE_ENV === "test");
    const recipientId = stringField(item.recipient_id);
    const x25519 = stringField(item.x25519_pub_hex).toLowerCase();
    const tokenEnv = stringField(item.token_env) || null;
    const imageDigest = stringField(item.image_digest).toLowerCase();
    if (!id || !url || !recipientId || !HEX_32.test(x25519) || !SHA256_DIGEST.test(imageDigest)) return [];
    if (ids.has(id) || recipients.has(recipientId)) return [];
    if (tokenEnv && !/^[A-Z][A-Z0-9_]{2,127}$/.test(tokenEnv)) return [];
    ids.add(id);
    recipients.add(recipientId);
    shards.push({
      id,
      url,
      recipient_id: recipientId,
      x25519_pub_hex: x25519,
      image_digest: imageDigest,
      token_env: tokenEnv,
      measurement_hex: nullableString(item.measurement_hex),
      attestation_hash: nullableString(item.attestation_hash),
      attested_ready: item.attested_ready === true,
    });
  }
  return shards.sort((a, b) => a.id.localeCompare(b.id));
}

export function selectHyperliquidWorkerShard(
  shards: HyperliquidWorkerShard[],
  accountCommitment: string,
): HyperliquidWorkerShard | null {
  if (shards.length === 0 || !accountCommitment.trim()) return null;
  const digest = createHash("sha256").update(accountCommitment).digest();
  return shards[digest.readUInt32BE(0) % shards.length] ?? null;
}

export function resolveHyperliquidWorkerShard(
  shards: HyperliquidWorkerShard[],
  input: { recipientId?: string | null; accountCommitment?: string | null },
): HyperliquidWorkerShard | null {
  if (input.recipientId) {
    return shards.find((shard) => shard.recipient_id === input.recipientId) ?? null;
  }
  return selectHyperliquidWorkerShard(shards, input.accountCommitment || "");
}

export function hyperliquidWorkerShardToken(
  shard: HyperliquidWorkerShard,
  env: Record<string, string | undefined> = process.env,
): string {
  return (shard.token_env ? env[shard.token_env]?.trim() : "") ||
    env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
    env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
    "";
}

export async function healthyHyperliquidWorkerShards(
  shards: HyperliquidWorkerShard[],
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<HyperliquidWorkerShard[]> {
  const configured = shards.filter((shard) => shard.attested_ready);
  if (env.NODE_ENV === "test" || env.GHOLA_HYPERLIQUID_SHARD_HEALTH_MODE === "local_test") {
    return configured;
  }
  const checks = await Promise.all(configured.map(async (shard) => ({
    shard,
    healthy: await cachedShardHealth(shard, fetcher),
  })));
  return checks.filter((check) => check.healthy).map((check) => check.shard);
}

async function cachedShardHealth(shard: HyperliquidWorkerShard, fetcher: typeof fetch): Promise<boolean> {
  const cacheKey = `${shard.url}|${shard.recipient_id}|${shard.x25519_pub_hex}`;
  const cached = shardHealthCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) return cached.promise;
  const promise = verifyShardHealth(shard, fetcher).catch((error) => {
    logShardHealthFailure(shard, "health_request_failed", error instanceof Error ? error.name : "unknown_error");
    return false;
  });
  shardHealthCache.set(cacheKey, { expires_at: Date.now() + HEALTH_CACHE_MS, promise });
  return promise;
}

async function verifyShardHealth(shard: HyperliquidWorkerShard, fetcher: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const [healthResponse, recipientResponse] = await Promise.all([
      fetcher(new URL("/health", shard.url), { cache: "no-store", signal: controller.signal }),
      fetcher(new URL("/.well-known/private-agent-recipient", shard.url), {
        cache: "no-store",
        signal: controller.signal,
      }),
    ]);
    if (!healthResponse.ok || !recipientResponse.ok) {
      return logShardHealthFailure(
        shard,
        "health_http_error",
        `${healthResponse.status}/${recipientResponse.status}`,
      );
    }
    const health = await healthResponse.json() as Record<string, unknown>;
    const recipient = await recipientResponse.json() as Record<string, unknown>;
    if (health.status !== "green") return logShardHealthFailure(shard, "health_status_not_green");
    if (health.ready !== true) return logShardHealthFailure(shard, "worker_not_ready");
    if (health.attested_ready !== true || recipient.attested_ready !== true) {
      return logShardHealthFailure(shard, "attestation_not_ready");
    }
    if (recipient.recipient_id !== shard.recipient_id) {
      return logShardHealthFailure(shard, "recipient_id_mismatch");
    }
    if (String(recipient.x25519_pub_hex || "").toLowerCase() !== shard.x25519_pub_hex) {
      return logShardHealthFailure(shard, "recipient_key_mismatch");
    }
    if (
      String(health.image_digest || "").toLowerCase() !== shard.image_digest ||
      String(recipient.image_digest || "").toLowerCase() !== shard.image_digest
    ) {
      return logShardHealthFailure(shard, "image_digest_mismatch");
    }
    if (shard.measurement_hex) {
      const observed = String(recipient.measurement_hex || health.measurement_hex || "");
      if (observed !== shard.measurement_hex) {
        return logShardHealthFailure(shard, "measurement_mismatch");
      }
    }
    if (shard.attestation_hash) {
      const observed = String(recipient.attestation_hash || health.attestation_hash || "");
      if (observed !== shard.attestation_hash) {
        return logShardHealthFailure(shard, "attestation_hash_mismatch");
      }
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

function logShardHealthFailure(
  shard: HyperliquidWorkerShard,
  reason: string,
  detail: string | null = null,
): false {
  console.warn(JSON.stringify({
    event: "hyperliquid_shard_health",
    version: 1,
    shard_id: shard.id,
    outcome: "unhealthy",
    reason,
    detail,
    observed_at: new Date().toISOString(),
  }));
  return false;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null {
  return stringField(value) || null;
}

function safeHttpsUrl(value: string, allowHttp: boolean): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return "";
    return url.toString();
  } catch {
    return "";
  }
}
