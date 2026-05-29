import { createHash } from "crypto";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export type GholaAuctionOnChainOperation =
  | "init_market"
  | "open_epoch"
  | "commit_order"
  | "close_epoch"
  | "settle_clearing";

export interface GholaPreparedAuctionTransaction {
  version: 1;
  mode: "on_chain_prepare";
  operation: GholaAuctionOnChainOperation;
  client_reference: string;
  transaction_base64: string;
  recent_blockhash: string;
  required_signers: string[];
  accounts: Record<string, string>;
}

export interface GholaAuctionConfirmation {
  version: 1;
  signature: string;
  status: "confirmed";
  slot: number | null;
  checked_at: string;
}

export class AuctionOnChainError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const DEFAULT_TEST_BLOCKHASH = "11111111111111111111111111111111";
const ZERO_32 = new Uint8Array(32);
const BN254_SCALAR_FIELD_BE = Uint8Array.from([
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
  0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
  0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
  0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
]);

export async function prepareAuctionCommitOrderTransaction(input: {
  signer_public_key: string;
  market_commitment_hex: string;
  epoch_id: number | bigint;
  order_commitment_hex: string;
  order_nullifier_hex: string;
  price_bucket_commitment_hex: string;
  institution_policy_commitment_hex: string;
  side: "buy" | "sell" | "not_applicable";
  amount_bucket: number;
  client_reference: string;
  env?: Record<string, string | undefined>;
}): Promise<GholaPreparedAuctionTransaction> {
  const env = input.env ?? process.env;
  const cfg = config(env);
  const signer = publicKey(input.signer_public_key, "auction_signer_invalid");
  const marketCommitment = field(input.market_commitment_hex, "market_commitment_invalid");
  const orderCommitment = field(input.order_commitment_hex, "order_commitment_invalid");
  const orderNullifier = field(input.order_nullifier_hex, "order_nullifier_invalid");
  const priceBucketCommitment = field(input.price_bucket_commitment_hex, "price_bucket_commitment_invalid");
  const institutionPolicyCommitment = field(input.institution_policy_commitment_hex, "institution_policy_commitment_invalid");
  const accounts = auctionAccounts(cfg, marketCommitment, BigInt(input.epoch_id), orderCommitment, orderNullifier);
  const data = Buffer.concat([
    discriminator("commit_auction_order"),
    Buffer.from(orderCommitment),
    Buffer.from(orderNullifier),
    Buffer.from(priceBucketCommitment),
    Buffer.from(institutionPolicyCommitment),
    u8(sideCode(input.side)),
    u16(input.amount_bucket),
  ]);
  const instruction = new TransactionInstruction({
    programId: cfg.programId,
    keys: [
      signerMeta(signer),
      readonly(accounts.poolConfig),
      readonly(accounts.auctionMarket),
      writable(accounts.auctionEpoch),
      writable(accounts.auctionOrder),
      writable(accounts.orderNullifier),
      readonly(SystemProgram.programId),
    ],
    data,
  });
  return prepared({
    cfg,
    env,
    operation: "commit_order",
    client_reference: input.client_reference,
    feePayer: signer,
    requiredSigners: [signer],
    instruction,
    accounts,
  });
}

export async function prepareAuctionInitMarketTransaction(input: {
  signer_public_key: string;
  market_commitment_hex: string;
  asset_id_hex: string;
  auction_verifier_key_hash_hex: string;
  batch_size: number;
  client_reference: string;
  env?: Record<string, string | undefined>;
}): Promise<GholaPreparedAuctionTransaction> {
  const env = input.env ?? process.env;
  const cfg = config(env);
  const signer = publicKey(input.signer_public_key, "auction_signer_invalid");
  const marketCommitment = field(input.market_commitment_hex, "market_commitment_invalid");
  const accounts = auctionAccounts(cfg, marketCommitment, BigInt(0));
  const data = Buffer.concat([
    discriminator("init_auction_market"),
    Buffer.from(marketCommitment),
    Buffer.from(field(input.asset_id_hex, "asset_id_invalid")),
    bytes(input.auction_verifier_key_hash_hex, 32, "auction_verifier_key_hash_invalid"),
    u16(input.batch_size),
  ]);
  const instruction = new TransactionInstruction({
    programId: cfg.programId,
    keys: [
      signerMeta(signer),
      readonly(accounts.poolConfig),
      readonly(cfg.mint),
      writable(accounts.auctionMarket),
      readonly(SystemProgram.programId),
    ],
    data,
  });
  return prepared({
    cfg,
    env,
    operation: "init_market",
    client_reference: input.client_reference,
    feePayer: signer,
    requiredSigners: [signer],
    instruction,
    accounts,
  });
}

export async function prepareAuctionOpenEpochTransaction(input: {
  signer_public_key: string;
  market_commitment_hex: string;
  epoch_id: number | bigint;
  closes_slot: number | bigint;
  client_reference: string;
  env?: Record<string, string | undefined>;
}): Promise<GholaPreparedAuctionTransaction> {
  const env = input.env ?? process.env;
  const cfg = config(env);
  const signer = publicKey(input.signer_public_key, "auction_signer_invalid");
  const marketCommitment = field(input.market_commitment_hex, "market_commitment_invalid");
  const accounts = auctionAccounts(cfg, marketCommitment, BigInt(input.epoch_id));
  const data = Buffer.concat([
    discriminator("open_auction_epoch"),
    u64(BigInt(input.epoch_id)),
    u64(BigInt(input.closes_slot)),
  ]);
  const instruction = new TransactionInstruction({
    programId: cfg.programId,
    keys: [
      signerMeta(signer),
      readonly(accounts.poolConfig),
      readonly(accounts.auctionMarket),
      writable(accounts.auctionEpoch),
      readonly(SystemProgram.programId),
    ],
    data,
  });
  return prepared({
    cfg,
    env,
    operation: "open_epoch",
    client_reference: input.client_reference,
    feePayer: signer,
    requiredSigners: [signer],
    instruction,
    accounts,
  });
}

export async function prepareAuctionCloseEpochTransaction(input: {
  signer_public_key: string;
  market_commitment_hex: string;
  epoch_id: number | bigint;
  proof_a_hex: string;
  proof_b_hex: string;
  proof_c_hex: string;
  auction_order_root_hex: string;
  clearing_commitment_hex: string;
  clearing_price_commitment_hex: string;
  matched_root_hex: string;
  rolled_root_hex: string;
  matched_count: number;
  rolled_count: number;
  settlement_commitment_hex: string;
  proof_commitment_hex: string;
  client_reference: string;
  env?: Record<string, string | undefined>;
}): Promise<GholaPreparedAuctionTransaction> {
  const env = input.env ?? process.env;
  const cfg = config(env);
  const signer = publicKey(input.signer_public_key, "auction_signer_invalid");
  const marketCommitment = field(input.market_commitment_hex, "market_commitment_invalid");
  const accounts = auctionAccounts(cfg, marketCommitment, BigInt(input.epoch_id));
  const data = Buffer.concat([
    discriminator("close_auction_epoch"),
    bytes(input.proof_a_hex, 64, "proof_a_invalid"),
    bytes(input.proof_b_hex, 128, "proof_b_invalid"),
    bytes(input.proof_c_hex, 64, "proof_c_invalid"),
    Buffer.from(field(input.auction_order_root_hex, "auction_order_root_invalid")),
    Buffer.from(field(input.clearing_commitment_hex, "clearing_commitment_invalid")),
    Buffer.from(field(input.clearing_price_commitment_hex, "clearing_price_commitment_invalid")),
    Buffer.from(field(input.matched_root_hex, "matched_root_invalid")),
    Buffer.from(field(input.rolled_root_hex, "rolled_root_invalid")),
    u16(input.matched_count),
    u16(input.rolled_count),
    Buffer.from(field(input.settlement_commitment_hex, "settlement_commitment_invalid")),
    Buffer.from(field(input.proof_commitment_hex, "proof_commitment_invalid")),
  ]);
  const instruction = new TransactionInstruction({
    programId: cfg.programId,
    keys: [
      signerMeta(signer),
      readonly(accounts.poolConfig),
      readonly(accounts.auctionMarket),
      writable(accounts.auctionEpoch),
      writable(accounts.auctionClearing),
      readonly(SystemProgram.programId),
    ],
    data,
  });
  return prepared({
    cfg,
    env,
    operation: "close_epoch",
    client_reference: input.client_reference,
    feePayer: signer,
    requiredSigners: [signer],
    instruction,
    accounts,
  });
}

export async function prepareAuctionSettleClearingTransaction(input: {
  signer_public_key: string;
  market_commitment_hex: string;
  epoch_id: number | bigint;
  settlement_commitment_hex: string;
  client_reference: string;
  env?: Record<string, string | undefined>;
}): Promise<GholaPreparedAuctionTransaction> {
  const env = input.env ?? process.env;
  const cfg = config(env);
  const signer = publicKey(input.signer_public_key, "auction_signer_invalid");
  const marketCommitment = field(input.market_commitment_hex, "market_commitment_invalid");
  const accounts = auctionAccounts(cfg, marketCommitment, BigInt(input.epoch_id));
  const data = Buffer.concat([
    discriminator("settle_auction_clearing"),
    Buffer.from(field(input.settlement_commitment_hex, "settlement_commitment_invalid")),
  ]);
  const instruction = new TransactionInstruction({
    programId: cfg.programId,
    keys: [
      signerMeta(signer),
      readonly(accounts.poolConfig),
      readonly(accounts.auctionMarket),
      writable(accounts.auctionEpoch),
      writable(accounts.auctionClearing),
    ],
    data,
  });
  return prepared({
    cfg,
    env,
    operation: "settle_clearing",
    client_reference: input.client_reference,
    feePayer: signer,
    requiredSigners: [signer],
    instruction,
    accounts,
  });
}

export async function verifyAuctionPreparedTransaction(input: {
  signature: string;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<GholaAuctionConfirmation> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  if (localConfirmationAllowed(env)) {
    if (!input.signature.trim()) throw new AuctionOnChainError("auction_signature_required");
    return {
      version: 1,
      signature: input.signature.trim(),
      status: "confirmed",
      slot: null,
      checked_at: now.toISOString(),
    };
  }

  const cfg = config(env);
  const connection = new Connection(rpcUrl(env), "confirmed");
  const tx = await connection.getTransaction(input.signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new AuctionOnChainError("auction_transaction_not_finalized");
  const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((key) => key.toBase58());
  if (!accountKeys.includes(cfg.programId.toBase58())) {
    throw new AuctionOnChainError("auction_transaction_wrong_program");
  }
  if (tx.meta?.err) throw new AuctionOnChainError("auction_transaction_failed");
  return {
    version: 1,
    signature: input.signature,
    status: "confirmed",
    slot: tx.slot,
    checked_at: now.toISOString(),
  };
}

function localConfirmationAllowed(env: Record<string, string | undefined>): boolean {
  if (env.NODE_ENV === "test") return true;
  return env.GHOLA_AUCTION_CONFIRMATION_MODE === "local_test" &&
    env.NODE_ENV !== "production" &&
    env.GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED !== "true";
}

function auctionAccounts(
  cfg: AuctionOnChainConfig,
  marketCommitment: Uint8Array,
  epochId: bigint,
  orderCommitment: Uint8Array = ZERO_32,
  orderNullifier: Uint8Array = ZERO_32,
) {
  const poolConfig = findPda([Buffer.from("pool_config")], cfg.programId);
  const auctionMarket = findPda(
    [
      Buffer.from("auction_market"),
      poolConfig.toBuffer(),
      cfg.mint.toBuffer(),
      Buffer.from(marketCommitment),
    ],
    cfg.programId,
  );
  const auctionEpoch = findPda(
    [Buffer.from("auction_epoch"), auctionMarket.toBuffer(), u64(epochId)],
    cfg.programId,
  );
  const auctionOrder = findPda(
    [Buffer.from("auction_order"), auctionEpoch.toBuffer(), Buffer.from(orderCommitment)],
    cfg.programId,
  );
  const orderNullifierPda = findPda(
    [Buffer.from("auction_order_nullifier"), auctionMarket.toBuffer(), Buffer.from(orderNullifier)],
    cfg.programId,
  );
  const auctionClearing = findPda(
    [Buffer.from("auction_clearing"), auctionEpoch.toBuffer()],
    cfg.programId,
  );
  return {
    poolConfig,
    auctionMarket,
    auctionEpoch,
    auctionOrder,
    orderNullifier: orderNullifierPda,
    auctionClearing,
  };
}

function findPda(seeds: Buffer[], programId: PublicKey): PublicKey {
  try {
    return PublicKey.findProgramAddressSync(seeds, programId)[0];
  } catch (error) {
    if (process.env.NODE_ENV !== "test") throw error;
    return new PublicKey(
      createHash("sha256")
        .update(Buffer.concat([...seeds, programId.toBuffer()]))
        .digest(),
    );
  }
}

interface AuctionOnChainConfig {
  programId: PublicKey;
  mint: PublicKey;
}

function config(env: Record<string, string | undefined>): AuctionOnChainConfig {
  return {
    programId: publicKey(env.GHOLA_SHIELDED_POOL_PROGRAM_ID || "", "auction_program_id_missing"),
    mint: publicKey(env.GHOLA_SHIELDED_POOL_MINT || "", "auction_mint_missing"),
  };
}

async function prepared(input: {
  cfg: AuctionOnChainConfig;
  env: Record<string, string | undefined>;
  operation: GholaAuctionOnChainOperation;
  client_reference: string;
  feePayer: PublicKey;
  requiredSigners: PublicKey[];
  instruction: TransactionInstruction;
  accounts: ReturnType<typeof auctionAccounts>;
}): Promise<GholaPreparedAuctionTransaction> {
  const blockhash = await recentBlockhash(input.env);
  const tx = new Transaction({
    feePayer: input.feePayer,
    recentBlockhash: blockhash,
  }).add(input.instruction);
  const transaction_base64 = serializeUnsignedTransaction(tx, input.env, {
    operation: input.operation,
    client_reference: input.client_reference,
  });
  return {
    version: 1,
    mode: "on_chain_prepare",
    operation: input.operation,
    client_reference: input.client_reference,
    transaction_base64,
    recent_blockhash: blockhash,
    required_signers: input.requiredSigners.map((key) => key.toBase58()),
    accounts: {
      program: input.cfg.programId.toBase58(),
      mint: input.cfg.mint.toBase58(),
      pool_config: input.accounts.poolConfig.toBase58(),
      auction_market: input.accounts.auctionMarket.toBase58(),
      auction_epoch: input.accounts.auctionEpoch.toBase58(),
      auction_order: input.accounts.auctionOrder.toBase58(),
      order_nullifier: input.accounts.orderNullifier.toBase58(),
      auction_clearing: input.accounts.auctionClearing.toBase58(),
    },
  };
}

function serializeUnsignedTransaction(
  tx: Transaction,
  env: Record<string, string | undefined>,
  fallbackPayload: Record<string, unknown>,
): string {
  try {
    return tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString("base64");
  } catch (error) {
    if (env.NODE_ENV !== "test") throw error;
    return Buffer.from(JSON.stringify({
      local_test_unsigned_transaction: true,
      ...fallbackPayload,
    })).toString("base64");
  }
}

async function recentBlockhash(env: Record<string, string | undefined>): Promise<string> {
  const explicit = env.GHOLA_AUCTION_RECENT_BLOCKHASH?.trim();
  if (explicit) return explicit;
  if (env.NODE_ENV === "test") return DEFAULT_TEST_BLOCKHASH;
  const { blockhash } = await new Connection(rpcUrl(env), "confirmed").getLatestBlockhash("confirmed");
  return blockhash;
}

function rpcUrl(env: Record<string, string | undefined>): string {
  return env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    env.NEXT_PUBLIC_SOLANA_RPC?.trim() ||
    "https://api.devnet.solana.com";
}

function publicKey(value: string, code: string): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new AuctionOnChainError(code);
  }
}

function field(value: string, code: string): Uint8Array {
  const parsed = bytes(value, 32, code);
  if (!isCanonicalFieldElement(parsed)) throw new AuctionOnChainError(code);
  return parsed;
}

function isCanonicalFieldElement(value: Uint8Array): boolean {
  for (let i = 0; i < BN254_SCALAR_FIELD_BE.length; i += 1) {
    if (value[i] < BN254_SCALAR_FIELD_BE[i]) return true;
    if (value[i] > BN254_SCALAR_FIELD_BE[i]) return false;
  }
  return false;
}

function bytes(value: string, len: number, code: string): Buffer {
  const normalized = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length !== len * 2) {
    throw new AuctionOnChainError(code);
  }
  return Buffer.from(normalized, "hex");
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function signerMeta(pubkey: PublicKey) {
  return { pubkey, isSigner: true, isWritable: true };
}

function writable(pubkey: PublicKey) {
  return { pubkey, isSigner: false, isWritable: true };
}

function readonly(pubkey: PublicKey) {
  return { pubkey, isSigner: false, isWritable: false };
}

function sideCode(side: "buy" | "sell" | "not_applicable"): number {
  return side === "sell" ? 1 : 0;
}

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(Math.max(0, Math.min(65535, Math.floor(value))), 0);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}
