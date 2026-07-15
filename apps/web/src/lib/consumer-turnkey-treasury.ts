import { createHash } from "node:crypto";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";
import {
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  createTransferChecked,
} from "./solana-usdc-instructions";

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type PreparedConsumerWithdrawal = {
  transaction_base64: string;
  message_commitment: string;
  blockhash: string;
  last_valid_block_height: number;
  expires_at: string;
  fee_payer: string;
};

export async function prepareTurnkeyUsdcWithdrawal(input: {
  destination_owner: string;
  amount_micro_usdc: number;
}): Promise<PreparedConsumerWithdrawal> {
  const config = treasuryConfig();
  if (!config.signingEnabled) throw new Error("consumer_treasury_signing_disabled");
  if (!Number.isSafeInteger(input.amount_micro_usdc) || input.amount_micro_usdc < 1) throw new Error("withdrawal_amount_invalid");

  const connection = new Connection(config.rpcUrl, "confirmed");
  const mint = new PublicKey(config.usdcMint);
  const treasury = new PublicKey(config.treasuryAddress);
  const destination = new PublicKey(input.destination_owner);
  const treasuryAta = associatedTokenAddress(mint, treasury);
  const destinationAta = associatedTokenAddress(mint, destination);
  const treasuryBalance = await connection.getTokenAccountBalance(treasuryAta, "confirmed").catch(() => null);
  if (!treasuryBalance || BigInt(treasuryBalance.value.amount) < BigInt(input.amount_micro_usdc)) {
    throw new Error("consumer_treasury_usdc_insufficient");
  }
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: destination,
    recentBlockhash: latest.blockhash,
  }).add(
    createAssociatedTokenAccountIdempotent({ payer: destination, address: destinationAta, owner: destination, mint }),
    createTransferChecked({ source: treasuryAta, mint, destination: destinationAta, authority: treasury, amount: BigInt(input.amount_micro_usdc), decimals: 6 }),
  );

  const sdk = new Turnkey({
    apiBaseUrl: TURNKEY_API_BASE_URL,
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
    defaultOrganizationId: config.organizationId,
  });
  // @turnkey/solana's published client union trails the server SDK's concrete
  // TurnkeyApiClient name, although both implement the signTransaction API.
  const client = sdk.apiClient() as unknown as ConstructorParameters<typeof TurnkeySigner>[0]["client"];
  const signer = new TurnkeySigner({ organizationId: config.organizationId, client });
  const signed = await signer.signTransaction(transaction, config.treasuryAddress, config.organizationId);
  if (!(signed instanceof Transaction)) throw new Error("consumer_treasury_transaction_type_invalid");
  const messageCommitment = transactionMessageCommitment(signed);
  const expiresAt = new Date(Date.now() + 90_000).toISOString();
  return {
    transaction_base64: Buffer.from(signed.serialize({ requireAllSignatures: false, verifySignatures: true })).toString("base64"),
    message_commitment: messageCommitment,
    blockhash: latest.blockhash,
    last_valid_block_height: latest.lastValidBlockHeight,
    expires_at: expiresAt,
    fee_payer: destination.toBase58(),
  };
}

export async function submitPreparedUsdcWithdrawal(input: {
  transaction_base64: string;
  expected_message_commitment: string;
  expected_fee_payer: string;
}): Promise<{ transaction_signature: string }> {
  const config = treasuryConfig();
  const bytes = Buffer.from(input.transaction_base64, "base64");
  if (bytes.length < 100 || bytes.length > 2_000) throw new Error("withdrawal_transaction_invalid");
  const transaction = Transaction.from(bytes);
  if (transaction.feePayer?.toBase58() !== input.expected_fee_payer) throw new Error("withdrawal_fee_payer_mismatch");
  if (transactionMessageCommitment(transaction) !== input.expected_message_commitment) throw new Error("withdrawal_transaction_mismatch");
  const requiredSigners = transaction.signatures.filter((item) => item.publicKey.equals(transaction.feePayer!) || item.publicKey.toBase58() === config.treasuryAddress);
  if (requiredSigners.length !== 2 || requiredSigners.some((item) => !item.signature)) throw new Error("withdrawal_signatures_incomplete");
  if (!transaction.verifySignatures()) throw new Error("withdrawal_signature_invalid");
  const connection = new Connection(config.rpcUrl, "confirmed");
  const signature = await connection.sendRawTransaction(bytes, {
    preflightCommitment: "confirmed",
    skipPreflight: false,
    maxRetries: 3,
  });
  return { transaction_signature: signature };
}

export function transactionMessageCommitment(transaction: Transaction) {
  return createHash("sha256").update(transaction.serializeMessage()).digest("hex");
}

export function consumerTreasuryConfigured() {
  try {
    const config = treasuryConfig();
    return config.signingEnabled;
  } catch {
    return false;
  }
}

function treasuryConfig() {
  const rpcUrl = process.env.GHOLA_CONSUMER_SOLANA_RPC_URL?.trim() || "";
  const treasuryAddress = process.env.GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT?.trim() || "";
  const organizationId = process.env.GHOLA_CONSUMER_TREASURY_TURNKEY_ORGANIZATION_ID?.trim() || process.env.TURNKEY_ORG_ID?.trim() || "";
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY?.trim() || "";
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY?.trim() || "";
  const usdcMint = process.env.GHOLA_CONSUMER_SOLANA_USDC_MINT?.trim() || MAINNET_USDC_MINT;
  if (!rpcUrl || !treasuryAddress || !organizationId || !apiPublicKey || !apiPrivateKey) {
    throw new Error("consumer_treasury_configuration_incomplete");
  }
  new PublicKey(treasuryAddress);
  new PublicKey(usdcMint);
  return {
    rpcUrl,
    treasuryAddress,
    organizationId,
    apiPublicKey,
    apiPrivateKey,
    usdcMint,
    signingEnabled: process.env.GHOLA_CONSUMER_TREASURY_SIGNING_ENABLED === "true",
  };
}
