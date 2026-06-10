import { createHash } from "node:crypto";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import bs58 from "bs58";

import { gholaCommitment } from "./private-account";

const DEPOSIT_DISCRIMINATOR = createHash("sha256")
  .update("global:deposit")
  .digest()
  .subarray(0, 8);

type VerifyError =
  | "custom_shielded_verifier_unconfigured"
  | "custom_shielded_verifier_unhealthy"
  | "invalid_shielded_receipt"
  | "wrong_shielded_destination"
  | "wrong_amount_bucket"
  | "wrong_asset_bucket"
  | "insufficient_confirmations";

interface Config {
  token: string;
  rpcUrl: string;
  network: string;
  programId: string;
  mint: string;
  treeId: string;
  amountBucket: string;
  assetBucket: string;
}

export function solanaShieldedVerifierConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    token: env.GHOLA_CUSTOM_SHIELDED_VERIFIER_TOKEN?.trim() || "",
    rpcUrl: env.GHOLA_SHIELDED_POOL_RPC_URL?.trim() ||
      env.GHOLA_SOLANA_RPC_URL?.trim() ||
      env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
      clusterApiUrl("devnet"),
    network: env.GHOLA_CUSTOM_SHIELDED_NETWORK?.trim() ||
      env.GHOLA_SHIELDED_POOL_NETWORK?.trim() ||
      "solana-devnet-shielded-pool-v1",
    programId: env.GHOLA_SHIELDED_POOL_PROGRAM_ID?.trim() || "",
    mint: env.GHOLA_SHIELDED_POOL_MINT?.trim() || "",
    treeId: env.GHOLA_SHIELDED_POOL_TREE_ID?.trim() || "",
    amountBucket: env.GHOLA_SHIELDED_POOL_CANARY_AMOUNT_BUCKET?.trim() || "stablecoin",
    assetBucket: env.GHOLA_SHIELDED_POOL_CANARY_ASSET_BUCKET?.trim() || "stablecoin",
  };
}

export function authorizedSolanaShieldedVerifierRequest(
  req: Request,
  config: Config = solanaShieldedVerifierConfig(),
): boolean {
  if (!config.token) return false;
  const header = req.headers.get("authorization")?.trim() || "";
  return header.toLowerCase().startsWith("bearer ") &&
    header.slice("bearer ".length).trim() === config.token;
}

export async function solanaShieldedVerifierHealth(now: Date = new Date()) {
  const config = solanaShieldedVerifierConfig();
  const missing = missingConfig(config);
  if (missing.length > 0) {
    return {
      status: 503,
      body: healthBody({
        config,
        now,
        status: "red",
        reason: `missing ${missing.join(", ")}`,
      }),
    };
  }

  try {
    const connection = new Connection(config.rpcUrl, "confirmed");
    const [slot, program, mint, tree] = await Promise.all([
      connection.getSlot("confirmed"),
      connection.getAccountInfo(new PublicKey(config.programId), "confirmed"),
      connection.getAccountInfo(new PublicKey(config.mint), "confirmed"),
      connection.getAccountInfo(new PublicKey(config.treeId), "confirmed"),
    ]);
    if (!program?.executable) {
      return {
        status: 503,
        body: healthBody({ config, now, status: "red", reason: "shielded pool program is not executable" }),
      };
    }
    if (!mint) {
      return {
        status: 503,
        body: healthBody({ config, now, status: "red", reason: "shielded pool mint account is missing" }),
      };
    }
    if (!tree) {
      return {
        status: 503,
        body: healthBody({ config, now, status: "red", reason: "shielded pool tree account is missing" }),
      };
    }
    return {
      status: 200,
      body: healthBody({ config, now, status: "green", slot }),
    };
  } catch {
    return {
      status: 503,
      body: healthBody({ config, now, status: "red", reason: "Solana verifier health check failed" }),
    };
  }
}

export async function verifySolanaShieldedDepositReceipt(body: unknown, now: Date = new Date()) {
  const config = solanaShieldedVerifierConfig();
  const missing = missingConfig(config);
  if (missing.length > 0) {
    return failure("custom_shielded_verifier_unconfigured", 503, config, now);
  }
  const input = asRecord(body);
  const receiptId = stringValue(input.receipt_id);
  const destinationCommitment = canonicalHex32(stringValue(input.destination_commitment));
  const amountBucket = stringValue(input.amount_bucket);
  const assetBucket = stringValue(input.asset_bucket);
  const minConfirmations = positiveInt(input.min_confirmations, 1);

  if (!receiptId || !destinationCommitment) {
    return failure("invalid_shielded_receipt", 400, config, now);
  }
  if (amountBucket !== config.amountBucket) return failure("wrong_amount_bucket", 400, config, now);
  if (assetBucket !== config.assetBucket) return failure("wrong_asset_bucket", 400, config, now);

  try {
    const connection = new Connection(config.rpcUrl, "confirmed");
    const [tx, latestSlot] = await Promise.all([
      connection.getTransaction(receiptId, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
      connection.getSlot("confirmed"),
    ]);
    if (!tx || tx.meta?.err) return failure("invalid_shielded_receipt", 400, config, now);
    const confirmationDepth = Math.max(0, latestSlot - tx.slot + 1);
    if (confirmationDepth < minConfirmations) {
      return failure("insufficient_confirmations", 400, config, now);
    }

    const matched = findDepositInstruction({
      tx: tx as unknown as SolanaTransactionLike,
      programId: config.programId,
      mint: config.mint,
      treeId: config.treeId,
      destinationCommitment,
    });
    if (matched === "wrong_destination") return failure("wrong_shielded_destination", 400, config, now);
    if (matched !== "ok") return failure("invalid_shielded_receipt", 400, config, now);

    const observedAt = now.toISOString();
    return {
      status: 200,
      body: {
        ok: true,
        version: 1,
        receipt_commitment: gholaCommitment("solana_shielded_pool_deposit_receipt", {
          receipt_id: receiptId,
          slot: tx.slot,
          destination_commitment: destinationCommitment,
          network: config.network,
        }),
        nullifier_commitment: gholaCommitment("solana_shielded_pool_deposit_nullifier", {
          receipt_id: receiptId,
          program_id: config.programId,
          mint: config.mint,
          tree_id: config.treeId,
        }),
        destination_commitment: destinationCommitment,
        amount_bucket: amountBucket,
        asset_bucket: assetBucket,
        network: config.network,
        confirmation_depth: confirmationDepth,
        verifier_commitment: verifierCommitment(config),
        verifier_head_commitment: verifierHeadCommitment(config, latestSlot),
        observed_at: observedAt,
      },
    };
  } catch {
    return failure("custom_shielded_verifier_unhealthy", 503, config, now);
  }
}

function missingConfig(config: Config): string[] {
  const missing: string[] = [];
  if (!config.token) missing.push("GHOLA_CUSTOM_SHIELDED_VERIFIER_TOKEN");
  if (!config.programId) missing.push("GHOLA_SHIELDED_POOL_PROGRAM_ID");
  if (!config.mint) missing.push("GHOLA_SHIELDED_POOL_MINT");
  if (!config.treeId) missing.push("GHOLA_SHIELDED_POOL_TREE_ID");
  return missing;
}

function healthBody(input: {
  config: Config;
  now: Date;
  status: "green" | "red";
  slot?: number;
  reason?: string | null;
}) {
  return {
    ok: input.status === "green",
    status: input.status,
    network: input.config.network,
    verifier: "ghola-solana-shielded-pool-verifier",
    verifier_commitment: input.status === "green" ? verifierCommitment(input.config) : null,
    verifier_head_commitment: input.status === "green"
      ? verifierHeadCommitment(input.config, input.slot ?? 0)
      : null,
    observed_at: input.status === "green" ? input.now.toISOString() : null,
    checked_at: input.now.toISOString(),
    reason: input.reason ?? null,
  };
}

function failure(error: VerifyError, status: number, config: Config, now: Date) {
  return {
    status,
    body: {
      ok: false,
      error,
      network: config.network,
      verifier_commitment: verifierCommitment(config),
      verifier_head_commitment: null,
      observed_at: now.toISOString(),
    },
  };
}

function verifierCommitment(config: Config): string {
  return gholaCommitment("solana_shielded_pool_verifier", {
    network: config.network,
    program_id: config.programId,
    mint: config.mint,
    tree_id: config.treeId,
  });
}

function verifierHeadCommitment(config: Config, slot: number): string {
  return gholaCommitment("solana_shielded_pool_verifier_head", {
    network: config.network,
    slot,
  });
}

interface SolanaTransactionLike {
  transaction?: {
    message?: {
      accountKeys?: unknown[];
      staticAccountKeys?: unknown[];
      instructions?: Array<{
        programIdIndex?: number;
        accounts?: number[];
        data?: string;
      }>;
      compiledInstructions?: Array<{
        programIdIndex?: number;
        accountKeyIndexes?: number[];
        accounts?: number[];
        data?: Uint8Array | string;
      }>;
    };
  };
}

function findDepositInstruction(input: {
  tx: SolanaTransactionLike;
  programId: string;
  mint: string;
  treeId: string;
  destinationCommitment: string;
}): "ok" | "missing" | "wrong_destination" {
  const message = input.tx.transaction?.message;
  const accountKeys = normalizeAccountKeys(message);
  const instructions = normalizeInstructions(message);
  let sawDepositForPool = false;
  for (const ix of instructions) {
    const programId = accountKeys[ix.programIdIndex ?? -1];
    if (programId !== input.programId) continue;
    const data = instructionData(ix.data);
    if (!data || !startsWith(data, DEPOSIT_DISCRIMINATOR)) continue;
    const ixAccounts = (ix.accounts ?? []).map((index) => accountKeys[index]).filter(Boolean);
    if (!ixAccounts.includes(input.mint) || !ixAccounts.includes(input.treeId)) continue;
    sawDepositForPool = true;
    if (dataIncludesCommitment(data, input.destinationCommitment)) return "ok";
  }
  return sawDepositForPool ? "wrong_destination" : "missing";
}

function normalizeAccountKeys(message: unknown): string[] {
  const record = asRecord(message);
  const keys = Array.isArray(record.accountKeys)
    ? record.accountKeys
    : Array.isArray(record.staticAccountKeys) ? record.staticAccountKeys : [];
  return keys.map((key) => {
    if (typeof key === "string") return key;
    if (key && typeof key === "object" && "pubkey" in key) {
      const pubkey = (key as { pubkey?: unknown }).pubkey;
      return typeof pubkey === "string" ? pubkey : String(pubkey);
    }
    return String(key);
  });
}

function normalizeInstructions(message: unknown): Array<{ programIdIndex?: number; accounts?: number[]; data?: Uint8Array | string }> {
  const record = asRecord(message);
  const instructions = Array.isArray(record.instructions)
    ? record.instructions
    : Array.isArray(record.compiledInstructions) ? record.compiledInstructions : [];
  return instructions.map((value) => {
    const item = asRecord(value);
    const accountIndexes = Array.isArray(item.accounts)
      ? item.accounts
      : Array.isArray(item.accountKeyIndexes) ? item.accountKeyIndexes : [];
    const programIdIndex = numberValue(item.programIdIndex);
    return {
      programIdIndex: programIdIndex ?? undefined,
      accounts: accountIndexes.map((index) => numberValue(index)).filter((index): index is number => index !== null),
      data: typeof item.data === "string" || item.data instanceof Uint8Array ? item.data : undefined,
    };
  });
}

function instructionData(value: Uint8Array | string | undefined): Buffer | null {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (!value) return null;
  try {
    return Buffer.from(bs58.decode(value));
  } catch {
    return null;
  }
}

function dataIncludesCommitment(data: Buffer, commitmentHex: string): boolean {
  return data.includes(Buffer.from(commitmentHex, "hex"));
}

function startsWith(data: Buffer, prefix: Buffer): boolean {
  return data.length >= prefix.length && data.subarray(0, prefix.length).equals(prefix);
}

function canonicalHex32(value: string): string {
  const withoutPrefix = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(withoutPrefix) ? withoutPrefix.toLowerCase() : "";
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
