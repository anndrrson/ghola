import { createPrivateKey, createPublicKey } from "node:crypto";

const TRUE_VALUES = new Set(["1", "true", "yes"]);

export function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function loadConfig() {
  const signingPem =
    optionalEnv("RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_PEM") ||
    (optionalEnv("RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64")
      ? Buffer.from(requiredEnv("RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64"), "base64").toString("utf8")
      : undefined);

  // Amount-attestation verification key (see verify.js for the trust model).
  // Railgun shields the transferred amount on-chain, so the adapter CANNOT
  // derive the paid amount from transaction logs. To avoid trusting a bare
  // client-supplied `railgun.amount`, the amount must instead arrive inside a
  // signed `proof.amount_attestation` whose Ed25519/EC signature this public
  // key verifies. If neither this key nor the explicit unsafe opt-in below is
  // configured, the adapter refuses to settle (fail closed).
  const amountAttestorPem =
    optionalEnv("RAILGUN_AMOUNT_ATTESTOR_PUBLIC_KEY_PEM") ||
    (optionalEnv("RAILGUN_AMOUNT_ATTESTOR_PUBLIC_KEY_B64")
      ? Buffer.from(requiredEnv("RAILGUN_AMOUNT_ATTESTOR_PUBLIC_KEY_B64"), "base64").toString("utf8")
      : undefined);

  return {
    authToken: requiredEnv("RAILGUN_ADAPTER_AUTH_TOKEN"),
    signingKey: signingPem ? createPrivateKey(signingPem) : undefined,
    network: optionalEnv("RAILGUN_EVM_NETWORK") || "arbitrum",
    asset: optionalEnv("RAILGUN_EVM_ASSET") || "USDC",
    recipient: requiredEnv("RAILGUN_EVM_RECIPIENT"),
    rpcUrl: requiredEnv("RAILGUN_EVM_RPC_URL"),
    contractAddress: optionalEnv("RAILGUN_EVM_CONTRACT_ADDRESS")?.toLowerCase(),
    minConfirmations: Number.parseInt(optionalEnv("RAILGUN_EVM_MIN_CONFIRMATIONS") || "1", 10),
    broadcasterReady: envFlag("RAILGUN_EVM_BROADCASTER_READY"),
    proofOfInnocenceRequired: envFlag("RAILGUN_EVM_PROOF_OF_INNOCENCE_REQUIRED", true),
    proofOfInnocenceConfigured: envFlag("RAILGUN_EVM_PROOF_OF_INNOCENCE_CONFIGURED"),
    receiptTtlSeconds: Number.parseInt(optionalEnv("RAILGUN_EVM_RECEIPT_TTL_SECONDS") || "600", 10),
    amountAttestorKey: amountAttestorPem ? createPublicKey(amountAttestorPem) : undefined,
    // DANGEROUS escape hatch: trust the client-asserted amount with no
    // attestation. Defaults to false (fail closed). Only enable in dev/test or
    // where an upstream component is KNOWN to verify the amount out-of-band.
    trustClientAmountUnsafe: envFlag("RAILGUN_TRUST_CLIENT_AMOUNT_UNSAFE", false)
  };
}

export function readiness(config) {
  const missing = [];
  if (!config.signingKey) missing.push("signing_key");
  if (!config.authToken) missing.push("auth_token");
  if (!config.rpcUrl) missing.push("rpc_url");
  if (!config.recipient) missing.push("recipient");
  if (!config.broadcasterReady) missing.push("broadcaster");
  if (config.proofOfInnocenceRequired && !config.proofOfInnocenceConfigured) {
    missing.push("proof_of_innocence_policy");
  }
  // Fail closed on the amount-trust model: refuse readiness unless either a
  // signed amount-attestation verifier is configured OR the operator has
  // explicitly opted into the unsafe client-amount mode.
  if (!config.amountAttestorKey && !config.trustClientAmountUnsafe) {
    missing.push("amount_attestor_key");
  }
  return {
    ready: missing.length === 0,
    missing
  };
}
