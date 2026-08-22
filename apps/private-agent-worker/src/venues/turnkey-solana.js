import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient } from "@turnkey/http";
import { TurnkeySigner } from "@turnkey/solana";
import { PublicKey } from "@solana/web3.js";

export function normalizeTurnkeySolanaSigningConfig(vault) {
  if (!vault || typeof vault !== "object" || Array.isArray(vault)) throw new Error("turnkey_solana_vault_invalid");
  if (vault.signing_mode !== "turnkey_delegated") throw new Error("turnkey_solana_signing_mode_required");
  const authority = publicKey(vault.authority || vault.agent_wallet_address);
  return Object.freeze({
    signing_mode: "turnkey_delegated",
    turnkey_organization_id: required(vault.turnkey_organization_id, "turnkey_organization_required"),
    turnkey_agent_key_ref: required(vault.turnkey_agent_key_ref, "turnkey_agent_key_ref_required"),
    authority,
    owner_mandate_commitment: commitment(vault.owner_mandate_commitment, "owner_mandate_commitment_required"),
    turnkey_policy_commitment: commitment(vault.turnkey_policy_commitment, "turnkey_policy_commitment_required"),
  });
}

export function resolveTurnkeySolanaAgentApiKey(config, env = process.env) {
  let selected = null;
  if (env.GHOLA_TURNKEY_AGENT_KEYRING_JSON) {
    try {
      selected = JSON.parse(env.GHOLA_TURNKEY_AGENT_KEYRING_JSON)?.[config.turnkey_agent_key_ref] || null;
    } catch {
      throw new Error("turnkey_agent_keyring_invalid");
    }
  }
  const apiPublicKey = selected?.api_public_key || env.GHOLA_TURNKEY_AGENT_API_PUBLIC_KEY;
  const apiPrivateKey = selected?.api_private_key || env.GHOLA_TURNKEY_AGENT_API_PRIVATE_KEY;
  if (!apiPublicKey || !apiPrivateKey) throw new Error("turnkey_agent_unavailable");
  return Object.freeze({ apiPublicKey: String(apiPublicKey), apiPrivateKey: String(apiPrivateKey) });
}

export function createTurnkeySolanaSigner(config, env = process.env) {
  const { apiPublicKey, apiPrivateKey } = resolveTurnkeySolanaAgentApiKey(config, env);
  const client = new TurnkeyClient(
    { baseUrl: env.TURNKEY_API_BASE_URL || "https://api.turnkey.com" },
    new ApiKeyStamper({ apiPublicKey, apiPrivateKey }),
  );
  return new TurnkeySigner({ organizationId: config.turnkey_organization_id, client });
}

export async function signTurnkeySolanaTransaction({
  transaction,
  config,
  env = process.env,
  signerFactory = createTurnkeySolanaSigner,
}) {
  const signer = signerFactory(config, env);
  return signer.signTransaction(transaction, config.authority, config.turnkey_organization_id);
}

export function publicTurnkeySolanaSigningStatus(config) {
  return Object.freeze({
    signing_mode: "turnkey_delegated",
    authority: config.authority,
    owner_mandate_commitment: config.owner_mandate_commitment,
    turnkey_policy_commitment: config.turnkey_policy_commitment,
    exportable_private_key_present: false,
  });
}

function required(value, code) {
  if (typeof value !== "string" || value.trim().length < 3 || value.trim().length > 180) throw new Error(code);
  return value.trim();
}

function commitment(value, code) {
  const result = required(value, code);
  if (!/^[A-Za-z0-9:_-]{8,180}$/.test(result)) throw new Error(code);
  return result;
}

function publicKey(value) {
  try {
    return new PublicKey(required(value, "turnkey_solana_authority_required")).toBase58();
  } catch {
    throw new Error("turnkey_solana_authority_invalid");
  }
}
