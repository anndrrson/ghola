import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";

export interface SignAndSendPreparedAuctionTransactionInput {
  transactionBase64: string;
  signerKeypairPath?: string;
  signerKeypair?: Keypair;
  rpcUrl?: string;
  expectedProgramId?: string;
  requiredSigners?: string[];
  commitment?: Commitment;
  skipPreflight?: boolean;
  maxRetries?: number;
}

export interface SignAndSendPreparedAuctionTransactionResult {
  version: 1;
  signature: string;
  signer_public_key: string;
  slot: number | null;
  confirmation_status: Commitment;
}

export class AuctionSubmissionError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export async function signAndSendPreparedAuctionTransaction(
  input: SignAndSendPreparedAuctionTransactionInput,
): Promise<SignAndSendPreparedAuctionTransactionResult> {
  const signer = input.signerKeypair ?? await loadAuctionSignerKeypair(input.signerKeypairPath);
  const tx = deserializePreparedAuctionTransaction(input.transactionBase64);
  const signerPublicKey = signer.publicKey.toBase58();
  const requiredSigners = input.requiredSigners ?? requiredSignerKeys(tx);

  if (requiredSigners.length > 0 && !requiredSigners.includes(signerPublicKey)) {
    throw new AuctionSubmissionError("auction_required_signer_missing");
  }

  if (input.expectedProgramId) {
    assertPreparedTransactionProgram(tx, input.expectedProgramId);
  }

  const raw = signPreparedTransaction(tx, signer);
  const commitment = input.commitment ?? "finalized";
  const connection = new Connection(input.rpcUrl ?? defaultRpcUrl(), commitment);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(raw, {
      skipPreflight: input.skipPreflight ?? false,
      maxRetries: input.maxRetries,
    });
  } catch (error) {
    throw new AuctionSubmissionError(
      "auction_transaction_send_failed",
      await submissionErrorDetails(error, connection),
    );
  }

  let confirmation: Awaited<ReturnType<Connection["confirmTransaction"]>>;
  try {
    confirmation = await connection.confirmTransaction(signature, commitment);
  } catch (error) {
    throw new AuctionSubmissionError("auction_transaction_confirmation_failed", {
      signature,
      ...(await submissionErrorDetails(error, connection)),
    });
  }
  if (confirmation.value.err) {
    throw new AuctionSubmissionError("auction_transaction_confirmation_failed", {
      signature,
      slot: confirmation.context.slot ?? null,
      err: confirmation.value.err,
    });
  }

  return {
    version: 1,
    signature,
    signer_public_key: signerPublicKey,
    slot: confirmation.context.slot ?? null,
    confirmation_status: commitment,
  };
}

export async function loadAuctionSignerKeypair(keypairPath?: string): Promise<Keypair> {
  const resolved = resolveKeypairPath(keypairPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch {
    throw new AuctionSubmissionError("auction_signer_keypair_unreadable");
  }

  const secret = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { secretKey?: unknown }).secretKey)
      ? (parsed as { secretKey: unknown[] }).secretKey
      : null;
  if (!secret || !secret.every((item) => Number.isInteger(item))) {
    throw new AuctionSubmissionError("auction_signer_keypair_invalid");
  }

  try {
    return Keypair.fromSecretKey(Uint8Array.from(secret as number[]));
  } catch {
    throw new AuctionSubmissionError("auction_signer_keypair_invalid");
  }
}

function deserializePreparedAuctionTransaction(transactionBase64: string): Transaction | VersionedTransaction {
  let raw: Buffer;
  try {
    raw = Buffer.from(transactionBase64, "base64");
  } catch {
    throw new AuctionSubmissionError("auction_transaction_invalid");
  }

  try {
    return Transaction.from(raw);
  } catch {
    try {
      return VersionedTransaction.deserialize(raw);
    } catch {
      throw new AuctionSubmissionError("auction_transaction_invalid");
    }
  }
}

function signPreparedTransaction(tx: Transaction | VersionedTransaction, signer: Keypair): Buffer | Uint8Array {
  try {
    if (tx instanceof VersionedTransaction) {
      tx.sign([signer]);
      return tx.serialize();
    }
    tx.partialSign(signer);
    return tx.serialize();
  } catch {
    throw new AuctionSubmissionError("auction_transaction_sign_failed");
  }
}

function requiredSignerKeys(tx: Transaction | VersionedTransaction): string[] {
  if (tx instanceof VersionedTransaction) {
    const keys = tx.message.staticAccountKeys;
    return keys.slice(0, tx.message.header.numRequiredSignatures).map((key) => key.toBase58());
  }
  return tx.signatures.map((item) => item.publicKey.toBase58());
}

function assertPreparedTransactionProgram(tx: Transaction | VersionedTransaction, expectedProgramId: string) {
  let expected: PublicKey;
  try {
    expected = new PublicKey(expectedProgramId);
  } catch {
    throw new AuctionSubmissionError("auction_expected_program_invalid");
  }
  const program = expected.toBase58();
  const programs = tx instanceof VersionedTransaction
    ? tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58())
    : tx.instructions.map((ix) => ix.programId.toBase58());
  if (!programs.includes(program)) {
    throw new AuctionSubmissionError("auction_transaction_wrong_program");
  }
}

function resolveKeypairPath(keypairPath?: string): string {
  const raw = keypairPath?.trim() || process.env.ANCHOR_WALLET?.trim() || "~/.config/solana/id.json";
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return path.join(homedir(), raw.slice(2));
  return path.resolve(raw);
}

function defaultRpcUrl(): string {
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC?.trim() ||
    "http://127.0.0.1:8899";
}

async function submissionErrorDetails(
  error: unknown,
  connection: Connection,
): Promise<Record<string, unknown>> {
  const details: Record<string, unknown> = {};
  if (error instanceof Error) {
    details.message = error.message;
    details.name = error.name;
  } else if (typeof error === "string") {
    details.message = error;
  }

  const logs = await extractTransactionLogs(error, connection);
  if (logs.length > 0) {
    details.logs = logs;
  }

  return details;
}

async function extractTransactionLogs(error: unknown, connection: Connection): Promise<string[]> {
  if (!error || typeof error !== "object") return [];
  const maybeLogs = (error as { logs?: unknown }).logs;
  if (Array.isArray(maybeLogs) && maybeLogs.every((item) => typeof item === "string")) {
    return maybeLogs;
  }
  const maybeGetLogs = (error as { getLogs?: unknown }).getLogs;
  if (typeof maybeGetLogs !== "function") return [];
  try {
    const logs = await maybeGetLogs.call(error, connection);
    return Array.isArray(logs) && logs.every((item) => typeof item === "string") ? logs : [];
  } catch {
    return [];
  }
}
