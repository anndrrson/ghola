import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  HYPERLIQUID_EXECUTION_VAULT_AAD_PREFIXES,
  openSealedBundle,
} from "../crypto/envelope.js";
import {
  HyperliquidExecutionError,
  hyperliquidCredentialFromVault,
} from "../venues/hyperliquid.js";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/u;
const COMMITMENT_RE = /^hyperliquid_(?:venue_account|agent_wallet)_[0-9a-f]{48}$/u;
const BUNDLE_COMMITMENT_RE = /^hyperliquid_agent_onboarding_bundle_[0-9a-f]{48}$/u;
const LEGACY_BUNDLE_COMMITMENT_RE = /^hyperliquid_agent_legacy_removal_bundle_[0-9a-f]{48}$/u;
const NAME_RE = /^ghola-mainnet valid_until ([0-9]{13})$/u;
const MAX_INFO_BYTES = 64 * 1024;

export function hyperliquidAgentOnboardingBundleCommitment(bundle) {
  return gholaCommitment("hyperliquid_agent_onboarding_bundle", bundle);
}

export function hyperliquidAgentLegacyRemovalBundleCommitment(bundle) {
  return gholaCommitment("hyperliquid_agent_legacy_removal_bundle", bundle);
}

export function validateHyperliquidAgentLegacyRemovalRequest(body, recipient) {
  const errors = [];
  if (!exactObject(body, [
    "version",
    "venue_id",
    "platform_class",
    "execution_mode",
    "operation_class",
    "account_commitment",
    "vault_bundle_commitment",
    "encrypted_execution_vault",
  ])) return ["request shape is invalid"];
  if (body.version !== 1) errors.push("version must be 1");
  if (body.venue_id !== "hyperliquid") errors.push("venue_id must be hyperliquid");
  if (body.platform_class !== "hyperliquid_style_market") errors.push("platform_class is invalid");
  if (body.execution_mode !== "byo_api_key") errors.push("execution_mode must be byo_api_key");
  if (body.operation_class !== "agent_wallet_legacy_revocation_verify") errors.push("operation_class is invalid");
  if (!nonEmpty(body.account_commitment)) errors.push("account_commitment is required");

  const bundle = body.encrypted_execution_vault;
  if (!exactObject(bundle, ["alg", "ciphertext", "recipient", "aad"])) {
    errors.push("encrypted_execution_vault shape is invalid");
  } else {
    if (bundle.alg !== "sealed-provider-v1" || !nonEmpty(bundle.ciphertext) ||
        !nonEmpty(bundle.recipient) || !nonEmpty(bundle.aad)) {
      errors.push("encrypted_execution_vault is invalid");
    }
    if (bundle.recipient !== recipient?.recipient_id) errors.push("encrypted_execution_vault recipient mismatch");
    if (!bundle.aad.startsWith("ghola/hyperliquid-execution-vault-v1|")) {
      errors.push("legacy encrypted_execution_vault AAD is invalid");
    }
    if (hyperliquidAgentLegacyRemovalBundleCommitment(bundle) !== body.vault_bundle_commitment) {
      errors.push("vault_bundle_commitment mismatch");
    }
  }
  if (!LEGACY_BUNDLE_COMMITMENT_RE.test(String(body.vault_bundle_commitment || ""))) {
    errors.push("vault_bundle_commitment is invalid");
  }
  return errors;
}

export function validateHyperliquidAgentWalletVerificationRequest(body, recipient) {
  const errors = [];
  if (!exactObject(body, [
    "version",
    "venue_id",
    "platform_class",
    "execution_mode",
    "operation_class",
    "account_commitment",
    "vault_bundle_commitment",
    "encrypted_execution_vault",
    "expected_authorization",
  ])) return ["request shape is invalid"];
  if (body.version !== 1) errors.push("version must be 1");
  if (body.venue_id !== "hyperliquid") errors.push("venue_id must be hyperliquid");
  if (body.platform_class !== "hyperliquid_style_market") errors.push("platform_class is invalid");
  if (body.execution_mode !== "byo_api_key") errors.push("execution_mode must be byo_api_key");
  if (body.operation_class !== "agent_wallet_onboarding_verify") errors.push("operation_class is invalid");
  if (!nonEmpty(body.account_commitment)) errors.push("account_commitment is required");

  const bundle = body.encrypted_execution_vault;
  if (!exactObject(bundle, ["alg", "ciphertext", "recipient", "aad"], ["encapsulated_key"])) {
    errors.push("encrypted_execution_vault shape is invalid");
  } else {
    if (bundle.alg !== "sealed-provider-v1" || !nonEmpty(bundle.ciphertext) ||
        !nonEmpty(bundle.recipient) || !nonEmpty(bundle.aad)) {
      errors.push("encrypted_execution_vault is invalid");
    }
    if (bundle.recipient !== recipient?.recipient_id) errors.push("encrypted_execution_vault recipient mismatch");
    if (!HYPERLIQUID_EXECUTION_VAULT_AAD_PREFIXES.some((prefix) => bundle.aad.startsWith(prefix))) {
      errors.push("encrypted_execution_vault AAD version is invalid");
    }
    if (bundle.encapsulated_key !== undefined && !nonEmpty(bundle.encapsulated_key)) {
      errors.push("encrypted_execution_vault encapsulated_key is invalid");
    }
    if (hyperliquidAgentOnboardingBundleCommitment(bundle) !== body.vault_bundle_commitment) {
      errors.push("vault_bundle_commitment mismatch");
    }
  }
  if (!BUNDLE_COMMITMENT_RE.test(String(body.vault_bundle_commitment || ""))) {
    errors.push("vault_bundle_commitment is invalid");
  }

  const expected = body.expected_authorization;
  if (!exactObject(expected, [
    "venue_account_commitment",
    "agent_wallet_commitment",
    "agent_base_name",
    "agent_name",
    "valid_until_ms",
  ])) {
    errors.push("expected_authorization shape is invalid");
  } else {
    if (!COMMITMENT_RE.test(String(expected.venue_account_commitment || "")) ||
        !COMMITMENT_RE.test(String(expected.agent_wallet_commitment || "")) ||
        expected.venue_account_commitment === expected.agent_wallet_commitment) {
      errors.push("expected authorization commitments are invalid");
    }
    if (expected.agent_base_name !== "ghola-mainnet") errors.push("expected agent base name is invalid");
    const name = String(expected.agent_name || "").match(NAME_RE);
    if (!name || !Number.isSafeInteger(expected.valid_until_ms) || Number(name?.[1]) !== expected.valid_until_ms) {
      errors.push("expected agent expiry is invalid");
    }
  }
  return errors;
}

export async function verifyHyperliquidAgentWalletOnboarding({
  body,
  recipient,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const validation = validateHyperliquidAgentWalletVerificationRequest(body, recipient);
  if (validation.length) throw workerError("hyperliquid_agent_vault_verification_invalid", 400);

  let opened;
  try {
    opened = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefixes: HYPERLIQUID_EXECUTION_VAULT_AAD_PREFIXES,
      expectedKind: "ghola_hyperliquid_execution_vault",
    });
  } catch {
    throw workerError(
      body.encrypted_execution_vault.recipient === recipient?.recipient_id
        ? "hyperliquid_agent_vault_unreadable"
        : "hyperliquid_agent_vault_recipient_mismatch",
      409,
    );
  }

  const raw = opened.json;
  if (!exactObject(raw, [
    "version",
    "kind",
    "network",
    "hyperliquid_account_address",
    "api_wallet_private_key",
    "agent_name",
    "allowed_operations",
    "blocked_operations",
    "created_at",
  ]) || raw.version !== 1 || raw.kind !== "ghola_hyperliquid_execution_vault" ||
      raw.network !== "mainnet" || raw.agent_name !== "ghola-mainnet") {
    throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  }
  const masterAddress = String(raw.hyperliquid_account_address || "").trim().toLowerCase();
  const privateKey = String(raw.api_wallet_private_key || "").trim().toLowerCase();
  if (!ADDRESS_RE.test(masterAddress) || !PRIVATE_KEY_RE.test(privateKey)) {
    throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  }
  const agentAddress = deriveEvmAddress(privateKey);
  if (agentAddress === masterAddress) throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);

  const scope = parseV2Aad(opened.associatedDataText);
  const expected = body.expected_authorization;
  const venueAccountCommitment = gholaCommitment("hyperliquid_venue_account", masterAddress);
  const agentWalletCommitment = gholaCommitment("hyperliquid_agent_wallet", agentAddress);
  if (!scope || scope.account_commitment !== body.account_commitment ||
      scope.recipient !== recipient.recipient_id || scope.network !== "mainnet" ||
      scope.venue_account_commitment !== venueAccountCommitment ||
      scope.agent_wallet_commitment !== agentWalletCommitment ||
      expected.venue_account_commitment !== venueAccountCommitment ||
      expected.agent_wallet_commitment !== agentWalletCommitment) {
    throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  }

  const credential = hyperliquidCredentialFromVault(raw);
  const exactAgent = await pollExactAgentAuthorization({
    fetchImpl,
    sleep,
    baseUrl: credential.base_url,
    masterAddress,
    agentAddress,
    expectedName: expected.agent_name,
    expectedBaseName: expected.agent_base_name,
    validUntil: expected.valid_until_ms,
  });
  if (exactAgent === null) {
    throw workerError("hyperliquid_agent_authorization_state_unknown", 503);
  }
  if (exactAgent === false) {
    throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  }

  const proof = {
    version: 1,
    proof_kind: "hyperliquid_agent_wallet_onboarding_verification_v1",
    status: "verified",
    network: "mainnet",
    account_commitment: body.account_commitment,
    vault_bundle_commitment: body.vault_bundle_commitment,
    recipient_commitment: gholaCommitment("sealed_recipient", recipient.recipient_id),
    venue_account_commitment: venueAccountCommitment,
    agent_wallet_commitment: agentWalletCommitment,
    agent_base_name: expected.agent_base_name,
    valid_until_ms: expected.valid_until_ms,
    decrypted: true,
    derived_agent_address_verified: true,
    venue_authorization_verified: true,
    no_submit: true,
    checked_at: new Date().toISOString(),
  };
  return {
    ...proof,
    verification_commitment: gholaCommitment("hyperliquid_agent_onboarding_verification", proof),
  };
}

export async function verifyHyperliquidLegacyAgentRevoked({
  body,
  recipient,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const validation = validateHyperliquidAgentLegacyRemovalRequest(body, recipient);
  if (validation.length) throw workerError("hyperliquid_agent_legacy_removal_verification_invalid", 400);

  let opened;
  try {
    opened = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefixes: ["ghola/hyperliquid-execution-vault-v1|"],
      expectedKind: "ghola_hyperliquid_execution_vault",
    });
  } catch {
    throw workerError(
      body.encrypted_execution_vault.recipient === recipient?.recipient_id
        ? "hyperliquid_agent_vault_unreadable"
        : "hyperliquid_agent_vault_recipient_mismatch",
      409,
    );
  }

  const raw = opened.json;
  if (!exactObject(raw, [
    "version",
    "kind",
    "network",
    "hyperliquid_account_address",
    "api_wallet_private_key",
    "agent_name",
    "allowed_operations",
    "blocked_operations",
    "created_at",
  ]) || raw.version !== 1 || raw.kind !== "ghola_hyperliquid_execution_vault" || raw.network !== "mainnet") {
    throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  }
  const masterAddress = String(raw.hyperliquid_account_address || "").trim().toLowerCase();
  const privateKey = String(raw.api_wallet_private_key || "").trim().toLowerCase();
  if (!ADDRESS_RE.test(masterAddress) || !PRIVATE_KEY_RE.test(privateKey)) {
    throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  }
  const agentAddress = deriveEvmAddress(privateKey);
  if (agentAddress === masterAddress) throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  const scope = parseV1Aad(opened.associatedDataText);
  if (!scope || scope.account_commitment !== body.account_commitment ||
      scope.recipient !== recipient.recipient_id || scope.network !== "mainnet") {
    throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  }

  const credential = hyperliquidCredentialFromVault(raw);
  const absent = await pollAgentAddressAbsent({
    fetchImpl,
    sleep,
    baseUrl: credential.base_url,
    masterAddress,
    agentAddress,
  });
  if (absent === null) throw workerError("hyperliquid_agent_authorization_state_unknown", 503);
  if (absent === false) throw workerError("legacy_hyperliquid_agent_still_authorized", 409);

  const proof = {
    version: 1,
    proof_kind: "hyperliquid_legacy_agent_revocation_verification_v1",
    status: "revoked",
    network: "mainnet",
    account_commitment: body.account_commitment,
    vault_bundle_commitment: body.vault_bundle_commitment,
    recipient_commitment: gholaCommitment("sealed_recipient", recipient.recipient_id),
    venue_account_commitment: gholaCommitment("hyperliquid_venue_account", masterAddress),
    agent_wallet_commitment: gholaCommitment("hyperliquid_agent_wallet", agentAddress),
    decrypted: true,
    derived_agent_address_verified: true,
    venue_authorization_absent: true,
    no_submit: true,
    checked_at: new Date().toISOString(),
  };
  return {
    ...proof,
    verification_commitment: gholaCommitment("hyperliquid_agent_legacy_removal_verification", proof),
  };
}

async function pollExactAgentAuthorization(input) {
  let unknown = false;
  for (const delay of [0, 150, 300, 600, 1_000]) {
    if (delay) await input.sleep(delay);
    const result = await queryExactAgentAuthorization(input);
    if (result === true) return true;
    if (result === null) unknown = true;
  }
  return unknown ? null : false;
}

async function pollAgentAddressAbsent(input) {
  let authoritativeAbsences = 0;
  let unknown = false;
  for (const delay of [0, 150, 300, 600, 1_000]) {
    if (delay) await input.sleep(delay);
    const rows = await queryAgentRows(input);
    if (rows === null) {
      unknown = true;
      continue;
    }
    if (rows.some((row) => row.address === input.agentAddress)) return false;
    authoritativeAbsences += 1;
  }
  return !unknown && authoritativeAbsences === 5 ? true : null;
}

async function queryExactAgentAuthorization(input) {
  const parsed = await queryAgentRows(input);
  if (parsed === null) return null;
  const sameName = parsed.filter((row) => (
    row.name === input.expectedBaseName || row.name.startsWith(`${input.expectedBaseName} valid_until `)
  ));
  if (sameName.length > 1) return null;
  return sameName.length === 1 &&
    (sameName[0].name === input.expectedBaseName || sameName[0].name === input.expectedName) &&
    sameName[0].address === input.agentAddress &&
    sameName[0].validUntil === input.validUntil;
}

async function queryAgentRows(input) {
  try {
    const response = await input.fetchImpl(`${input.baseUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: "extraAgents", user: input.masterAddress }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_INFO_BYTES) return null;
    const rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 16) return null;
    const parsed = rows.map(parseAgentRow);
    if (parsed.some((row) => row === null)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseAgentRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const address = String(value.address || "").trim().toLowerCase();
  return typeof value.name === "string" && ADDRESS_RE.test(address) && Number.isSafeInteger(value.validUntil)
    ? { name: value.name, address, validUntil: value.validUntil }
    : null;
}

function deriveEvmAddress(privateKey) {
  try {
    const publicKey = secp256k1.getPublicKey(Buffer.from(privateKey.slice(2), "hex"), false);
    return `0x${Buffer.from(keccak_256(publicKey.slice(1))).subarray(12).toString("hex")}`;
  } catch {
    throw workerError("hyperliquid_agent_vault_identity_mismatch", 409);
  }
}

function parseV2Aad(value) {
  const [version, account, recipient, network, venue, agent, ...extra] = String(value || "").split("|");
  if (version !== "ghola/hyperliquid-execution-vault-v2" || extra.length) return null;
  const parsed = {
    account_commitment: part(account, "account:"),
    recipient: part(recipient, "recipient:"),
    network: part(network, "network:"),
    venue_account_commitment: part(venue, "venue-account:"),
    agent_wallet_commitment: part(agent, "agent-wallet:"),
  };
  return parsed.account_commitment && parsed.recipient && parsed.network === "mainnet" &&
    COMMITMENT_RE.test(parsed.venue_account_commitment) && COMMITMENT_RE.test(parsed.agent_wallet_commitment)
    ? parsed
    : null;
}

function parseV1Aad(value) {
  const [version, account, recipient, network, ...extra] = String(value || "").split("|");
  if (version !== "ghola/hyperliquid-execution-vault-v1" || extra.length) return null;
  const parsed = {
    account_commitment: part(account, "account:"),
    recipient: part(recipient, "recipient:"),
    network: part(network, "network:"),
  };
  return parsed.account_commitment && parsed.recipient && parsed.network === "mainnet"
    ? parsed
    : null;
}

function part(value, prefix) {
  return typeof value === "string" && value.startsWith(prefix) ? value.slice(prefix.length) : "";
}

function exactObject(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function gholaCommitment(prefix, value) {
  return `${prefix}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 48)}`;
}

function workerError(code, status) {
  return new HyperliquidExecutionError(code, status, code);
}
