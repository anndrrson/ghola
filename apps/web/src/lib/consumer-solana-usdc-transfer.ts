import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  createTransferChecked,
} from "./solana-usdc-instructions";

const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export async function prepareConsumerUsdcDepositTransaction(input: {
  source_owner: string;
  treasury_owner: string;
  amount_micro_usdc: number;
}) {
  const rpcUrl = process.env.GHOLA_CONSUMER_SOLANA_RPC_URL?.trim() || "";
  if (!rpcUrl) throw new Error("consumer_solana_rpc_unconfigured");
  if (!Number.isSafeInteger(input.amount_micro_usdc) || input.amount_micro_usdc < 1) throw new Error("deposit_amount_invalid");
  const source = new PublicKey(input.source_owner);
  const treasury = new PublicKey(input.treasury_owner);
  const mint = new PublicKey(process.env.GHOLA_CONSUMER_SOLANA_USDC_MINT?.trim() || MAINNET_USDC_MINT);
  const sourceAta = associatedTokenAddress(mint, source);
  const treasuryAta = associatedTokenAddress(mint, treasury);
  const connection = new Connection(rpcUrl, "confirmed");
  const sourceBalance = await connection.getTokenAccountBalance(sourceAta, "confirmed").catch(() => null);
  if (!sourceBalance || BigInt(sourceBalance.value.amount) < BigInt(input.amount_micro_usdc)) {
    throw new Error("source_wallet_usdc_insufficient");
  }
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: source, recentBlockhash: latest.blockhash }).add(
    createAssociatedTokenAccountIdempotent({ payer: source, address: treasuryAta, owner: treasury, mint }),
    createTransferChecked({ source: sourceAta, mint, destination: treasuryAta, authority: source, amount: BigInt(input.amount_micro_usdc), decimals: 6 }),
  );
  return {
    version: 1 as const,
    transaction_base64: Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"),
    fee_payer: source.toBase58(),
    network: "solana-mainnet" as const,
    asset: "USDC" as const,
    expires_at: new Date(Date.now() + 90_000).toISOString(),
  };
}
