import type { ConfidentialComputeProviderId } from "./private-agent-runtime";

export interface EncryptedStrategyBundleV1 {
  alg: "sealed-provider-v1" | "hpke-x25519-aes256gcm";
  ciphertext: string;
  recipient: string;
  aad: string;
  encapsulated_key?: string;
}

export interface PrivateAgentSessionRequestV1 {
  version: 1;
  strategy_id: string;
  policy_hash: string;
  owner_did: string;
  mode: "capped_session_key";
  requested_provider?: ConfidentialComputeProviderId;
  encrypted_strategy_bundle: EncryptedStrategyBundleV1;
}

export interface PrivateAgentSessionAcceptedV1 {
  version: 1;
  session_id: string;
  provider: ConfidentialComputeProviderId;
  strategy_id: string;
  policy_hash: string;
  accepted_at: string;
  sealed_execution_required: true;
}

export interface PrivateAgentSessionValidationResult {
  ok: boolean;
  request?: PrivateAgentSessionRequestV1;
  errors: string[];
}

const PLAINTEXT_LEAK_KEYS = new Set([
  "messages",
  "plaintext",
  "policy",
  "prompt",
  "source",
  "strategy",
  "strategy_text",
  "system_prompt",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function containsPlaintextLeakKey(value: unknown): boolean {
  if (!isObject(value)) return false;
  return Object.keys(value).some((key) => PLAINTEXT_LEAK_KEYS.has(key));
}

function validateEncryptedBundle(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ["encrypted_strategy_bundle is required"];
  if (
    value.alg !== "sealed-provider-v1" &&
    value.alg !== "hpke-x25519-aes256gcm"
  ) {
    errors.push("encrypted_strategy_bundle.alg is unsupported");
  }
  if (!isNonEmptyString(value.ciphertext)) {
    errors.push("encrypted_strategy_bundle.ciphertext is required");
  }
  if (!isNonEmptyString(value.recipient)) {
    errors.push("encrypted_strategy_bundle.recipient is required");
  }
  if (!isNonEmptyString(value.aad)) {
    errors.push("encrypted_strategy_bundle.aad is required");
  }
  if ("encapsulated_key" in value && !isNonEmptyString(value.encapsulated_key)) {
    errors.push("encrypted_strategy_bundle.encapsulated_key must be non-empty");
  }
  return errors;
}

export function validatePrivateAgentSessionRequest(
  value: unknown,
): PrivateAgentSessionValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: ["request body must be an object"] };
  }
  if (containsPlaintextLeakKey(value)) {
    errors.push("request must not contain plaintext strategy, prompt, policy, or messages");
  }
  if (value.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(value.strategy_id)) errors.push("strategy_id is required");
  if (!isNonEmptyString(value.policy_hash)) errors.push("policy_hash is required");
  if (!isNonEmptyString(value.owner_did)) errors.push("owner_did is required");
  if (value.mode !== "capped_session_key") {
    errors.push("mode must be capped_session_key");
  }
  errors.push(...validateEncryptedBundle(value.encrypted_strategy_bundle));

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    request: value as unknown as PrivateAgentSessionRequestV1,
    errors: [],
  };
}

export function buildAcceptedPrivateAgentSession(input: {
  provider: ConfidentialComputeProviderId;
  request: PrivateAgentSessionRequestV1;
  acceptedAt?: string;
  sessionId?: string;
}): PrivateAgentSessionAcceptedV1 {
  return {
    version: 1,
    session_id: input.sessionId ?? `pas_${crypto.randomUUID()}`,
    provider: input.provider,
    strategy_id: input.request.strategy_id,
    policy_hash: input.request.policy_hash,
    accepted_at: input.acceptedAt ?? new Date().toISOString(),
    sealed_execution_required: true,
  };
}
