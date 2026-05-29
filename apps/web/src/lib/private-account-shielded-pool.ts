import {
  gholaCommitment,
  type GholaShieldedPoolHealth,
  type GholaShieldedPoolServiceHealth,
} from "./private-account";

export interface ShieldedPoolConfig {
  mode: "http" | "local_test";
  indexer_url: string;
  prover_url: string;
  relayer_url: string;
  private_runtime_url: string;
  private_runtime_token: string;
  network: string;
  program_id: string;
  mint: string;
  tree_id: string;
  min_confirmations: number;
  max_stale_ms: number;
}

export function shieldedPoolConfig(): ShieldedPoolConfig {
  const mode = process.env.GHOLA_SHIELDED_POOL_MODE === "local_test"
    ? "local_test" as const
    : "http" as const;
  return {
    mode,
    indexer_url: process.env.GHOLA_SHIELDED_POOL_INDEXER_URL?.trim() || "",
    prover_url: process.env.GHOLA_SHIELDED_POOL_PROVER_URL?.trim() || "",
    relayer_url: process.env.GHOLA_SHIELDED_POOL_RELAYER_URL?.trim() || "",
    private_runtime_url: process.env.GHOLA_PRIVATE_RUNTIME_URL?.trim() || "",
    private_runtime_token: process.env.GHOLA_PRIVATE_RUNTIME_TOKEN?.trim() || "",
    network: process.env.GHOLA_CUSTOM_SHIELDED_NETWORK?.trim() ||
      process.env.GHOLA_SHIELDED_POOL_NETWORK?.trim() ||
      "solana-shielded-pool-v1",
    program_id: process.env.GHOLA_SHIELDED_POOL_PROGRAM_ID?.trim() || "",
    mint: process.env.GHOLA_SHIELDED_POOL_MINT?.trim() || "",
    tree_id: process.env.GHOLA_SHIELDED_POOL_TREE_ID?.trim() || "",
    min_confirmations: Math.max(
      1,
      Number.parseInt(process.env.GHOLA_SHIELDED_POOL_MIN_CONFIRMATIONS || "3", 10) || 3,
    ),
    max_stale_ms: Math.max(
      1_000,
      Number.parseInt(process.env.GHOLA_SHIELDED_POOL_MAX_STALE_MS || "300000", 10) || 300_000,
    ),
  };
}

export async function shieldedPoolHealth(now: Date = new Date()): Promise<GholaShieldedPoolHealth> {
  const config = shieldedPoolConfig();
  if (config.mode === "local_test") {
    if (process.env.NODE_ENV === "production") {
      return health({
        config,
        now,
        mode: "local_test",
        status: "red",
        reason: "local_test shielded pool mode is disabled in production",
      });
    }
    return health({
      config,
      now,
      mode: "local_test",
      status: "green",
      indexer: localService("indexer", now),
      tree_state: localService("tree_state", now),
      prover: localService("prover", now),
      relayer: localService("relayer", now),
      sealed_runtime: localService("sealed_runtime", now),
    });
  }

  if (!config.indexer_url || !config.prover_url || !config.relayer_url || !config.private_runtime_url) {
    return health({
      config,
      now,
      mode: "unconfigured",
      status: "red",
      reason: "shielded pool indexer, prover, relayer, and sealed runtime URLs are required",
    });
  }

  const [indexer, treeState, prover, relayer, sealedRuntime] = await Promise.all([
    checkHttpService("indexer", joinPath(config.indexer_url, "/healthz"), config, now),
    checkHttpService("tree_state", joinPath(config.indexer_url, "/tree-state"), config, now),
    checkHttpService("prover", joinPath(config.prover_url, "/healthz"), config, now),
    checkHttpService("relayer", joinPath(config.relayer_url, "/healthz"), config, now),
    checkHttpService("sealed_runtime", joinPath(config.private_runtime_url, "/health"), config, now, {
      authorization: `Bearer ${config.private_runtime_token}`,
    }),
  ]);
  const services = [indexer, treeState, prover, relayer, sealedRuntime];
  const failed = services.find((item) => item.status !== "green");
  return health({
    config,
    now,
    mode: "http",
    status: failed ? "red" : "green",
    reason: failed?.reason ?? null,
    indexer,
    tree_state: treeState,
    prover,
    relayer,
    sealed_runtime: sealedRuntime,
  });
}

async function checkHttpService(
  service: GholaShieldedPoolServiceHealth["service"],
  url: string,
  config: ShieldedPoolConfig,
  now: Date,
  headers: Record<string, string> = {},
): Promise<GholaShieldedPoolServiceHealth> {
  try {
    const safeHeaders = Object.fromEntries(
      Object.entries(headers).filter(([, value]) => value && value !== "Bearer "),
    );
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: Object.keys(safeHeaders).length ? safeHeaders : undefined,
    });
    const body = asRecord(await res.json().catch(() => null));
    if (!res.ok) {
      return serviceHealth({
        service,
        status: "red",
        configured: true,
        reason: `${service} health returned ${res.status}`,
      });
    }
    const observedAt = stringValue(body.observed_at) ||
      stringValue(body.indexed_at) ||
      stringValue(body.updated_at) ||
      now.toISOString();
    if (isStale(observedAt, now, config.max_stale_ms)) {
      return serviceHealth({
        service,
        status: "red",
        configured: true,
        observed_at: observedAt,
        commitment: commitmentForService(service, body),
        reason: `${service} state is stale`,
      });
    }
    return serviceHealth({
      service,
      status: body.status === "red" ? "red" : "green",
      configured: true,
      observed_at: observedAt,
      commitment: commitmentForService(service, body),
      reason: body.status === "red" ? stringValue(body.reason) || `${service} health is red` : null,
    });
  } catch {
    return serviceHealth({
      service,
      status: "red",
      configured: true,
      reason: `${service} health check failed`,
    });
  }
}

function health(input: {
  config: ShieldedPoolConfig;
  now: Date;
  mode: GholaShieldedPoolHealth["mode"];
  status: GholaShieldedPoolHealth["status"];
  reason?: string | null;
  indexer?: GholaShieldedPoolServiceHealth;
  tree_state?: GholaShieldedPoolServiceHealth;
  prover?: GholaShieldedPoolServiceHealth;
  relayer?: GholaShieldedPoolServiceHealth;
  sealed_runtime?: GholaShieldedPoolServiceHealth;
}): GholaShieldedPoolHealth {
  const configured = input.mode !== "unconfigured";
  return {
    version: 1,
    status: input.status,
    mode: input.mode,
    network: input.config.network,
    program_commitment: input.config.program_id
      ? gholaCommitment("shielded_pool_program", input.config.program_id)
      : null,
    mint_commitment: input.config.mint ? gholaCommitment("shielded_pool_mint", input.config.mint) : null,
    tree_commitment: input.config.tree_id ? gholaCommitment("shielded_pool_tree", input.config.tree_id) : null,
    min_confirmations: input.config.min_confirmations,
    max_stale_ms: input.config.max_stale_ms,
    indexer: input.indexer ?? serviceHealth({
      service: "indexer",
      status: "red",
      configured,
      reason: input.reason ?? "indexer is not configured",
    }),
    tree_state: input.tree_state ?? serviceHealth({
      service: "tree_state",
      status: "red",
      configured,
      reason: input.reason ?? "tree state is not configured",
    }),
    prover: input.prover ?? serviceHealth({
      service: "prover",
      status: "red",
      configured,
      reason: input.reason ?? "prover is not configured",
    }),
    relayer: input.relayer ?? serviceHealth({
      service: "relayer",
      status: "red",
      configured,
      reason: input.reason ?? "relayer is not configured",
    }),
    sealed_runtime: input.sealed_runtime ?? serviceHealth({
      service: "sealed_runtime",
      status: "red",
      configured,
      reason: input.reason ?? "sealed runtime is not configured",
    }),
    checked_at: input.now.toISOString(),
    reason: input.reason ?? null,
  };
}

function localService(
  service: GholaShieldedPoolServiceHealth["service"],
  now: Date,
): GholaShieldedPoolServiceHealth {
  return serviceHealth({
    service,
    status: "green",
    configured: true,
    commitment: gholaCommitment(`shielded_pool_${service}`, "local_test"),
    observed_at: now.toISOString(),
  });
}

function serviceHealth(input: {
  service: GholaShieldedPoolServiceHealth["service"];
  status: "green" | "red";
  configured: boolean;
  commitment?: string | null;
  observed_at?: string | null;
  reason?: string | null;
}): GholaShieldedPoolServiceHealth {
  return {
    version: 1,
    service: input.service,
    status: input.status,
    configured: input.configured,
    commitment: input.commitment ?? null,
    observed_at: input.observed_at ?? null,
    reason: input.reason ?? null,
  };
}

function commitmentForService(service: string, body: Record<string, unknown>): string {
  return stringValue(body.commitment) ||
    stringValue(body.verifier_commitment) ||
    stringValue(body.root_commitment) ||
    stringValue(body.tree_commitment) ||
    gholaCommitment(`shielded_pool_${service}`, body);
}

function joinPath(base: string, path: string): string {
  try {
    return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
  } catch {
    return `${base}${path}`;
  }
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
