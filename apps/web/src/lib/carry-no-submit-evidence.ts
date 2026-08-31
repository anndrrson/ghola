const EXECUTION_VENUES = ["hyperliquid", "lighter", "aster"] as const;

type ProofResult =
  | { ok: true; evidence: Record<string, unknown> }
  | { ok: false; error: string };

export function buildCarryNoSubmitEvidence(input: {
  request: unknown;
  response: unknown;
  env?: Record<string, string | undefined>;
}): ProofResult {
  const env = input.env ?? process.env;
  const request = record(input.request);
  const workerResponse = record(input.response);
  const privatePrime = record(workerResponse.private_prime_readiness);
  const capturedAtMs = positiveInteger(privatePrime.checked_at_ms);
  const previewUrl = deploymentUrl(env.VERCEL_URL || env.GHOLA_RELEASE_DEPLOYMENT_URL);
  const webCommitSha = first(env, ["VERCEL_GIT_COMMIT_SHA", "GHOLA_RELEASE_COMMIT_SHA", "GITHUB_SHA"]);
  const workerImageDigest = first(env, [
    "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
    "GHOLA_PRIVATE_AGENT_IMAGE_DIGEST",
    "PHALA_CVM_IMAGE_DIGEST",
    "PRIVATE_AGENT_IMAGE_DIGEST",
  ]);

  if (!previewUrl) return failure("carry_no_submit_preview_identity_missing");
  if (!/^[0-9a-f]{7,40}$/i.test(webCommitSha)) return failure("carry_no_submit_web_revision_missing");
  if (!/^sha256:[a-f0-9]{12,128}$/.test(workerImageDigest)) {
    return failure("carry_no_submit_worker_image_missing");
  }
  if (request.version !== 1 || request.operation_class !== "matrix_no_submit") {
    return failure("carry_no_submit_request_invalid");
  }
  if (workerResponse.mode !== "carry_execution_no_submit_matrix"
    || workerResponse.no_submit_ready !== true
    || workerResponse.transaction_broadcast !== false
    || !Array.isArray(workerResponse.failures)
    || workerResponse.failures.length > 0) {
    return failure("carry_no_submit_matrix_unready");
  }
  if (!capturedAtMs) return failure("carry_no_submit_capture_time_missing");
  if (containsCredentialMaterial(workerResponse)) {
    return failure("carry_no_submit_response_contains_credential_material");
  }

  const venueAccess = record(request.venue_access);
  const sanitizedAccess: Record<string, unknown> = {};
  for (const venueId of EXECUTION_VENUES) {
    const access = record(venueAccess[venueId]);
    const sanitized = {
      account_commitment: string(access.account_commitment),
      vault_commitment: string(access.vault_commitment),
      policy_commitment: string(access.policy_commitment),
    };
    if (Object.values(sanitized).some((value) => !value)) {
      return failure(`carry_no_submit_access_missing:${venueId}`);
    }
    sanitizedAccess[venueId] = sanitized;
  }

  return {
    ok: true,
    evidence: {
      version: 1,
      kind: "ghola_three_venue_no_submit_proof",
      network: "mainnet",
      captured_at_ms: capturedAtMs,
      source: {
        preview_url: previewUrl,
        web_commit_sha: webCommitSha,
        worker_image_digest: workerImageDigest,
      },
      request: {
        version: 1,
        owner_commitment: string(request.owner_commitment),
        operation_class: "matrix_no_submit",
        work_order_commitment: string(request.work_order_commitment),
        asset: string(request.asset),
        notional_usd: request.notional_usd,
        horizon_days: request.horizon_days,
        venue_access: sanitizedAccess,
      },
      response: structuredClone(workerResponse),
    },
  };
}

function containsCredentialMaterial(value: unknown): boolean {
  const forbidden = new Set([
    "authorization",
    "encrypted_execution_vault",
    "api_wallet_private_key",
    "api_private_key",
    "api_secret",
    "private_key",
    "secret_key",
    "session_token",
  ]);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => forbidden.has(key.toLowerCase()) || containsCredentialMaterial(child));
}

function deploymentUrl(value: string | undefined): string {
  const raw = string(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.protocol === "https:" && /\.vercel\.app$/i.test(url.hostname)
      ? url.origin
      : "";
  } catch {
    return "";
  }
}

function first(env: Record<string, string | undefined>, keys: string[]): string {
  for (const key of keys) {
    const value = string(env[key]);
    if (value) return value;
  }
  return "";
}

function failure(error: string): ProofResult {
  return { ok: false, error };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}
