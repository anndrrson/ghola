import { Connection } from "@solana/web3.js";

const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export async function verifyConsumerSolanaUsdcDeposit(input: {
  signature: string;
  expected_source_wallet: string;
  expected_treasury_wallet: string;
  expected_amount_micro_usdc: number;
}): Promise<{ ok: true; slot: number } | { ok: false; error: string }> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(input.signature)) return { ok: false, error: "solana_signature_invalid" };
  const rpcUrl = process.env.GHOLA_CONSUMER_SOLANA_RPC_URL?.trim();
  if (!rpcUrl) return { ok: false, error: "consumer_solana_rpc_unconfigured" };
  const connection = new Connection(rpcUrl, "finalized");
  const transaction = await connection.getParsedTransaction(input.signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  }).catch(() => null);
  if (!transaction?.meta || transaction.meta.err) return { ok: false, error: "solana_deposit_not_finalized" };
  const mint = process.env.GHOLA_CONSUMER_SOLANA_USDC_MINT?.trim() || MAINNET_USDC_MINT;
  const pre = tokenAmounts(transaction.meta.preTokenBalances || [], mint);
  const post = tokenAmounts(transaction.meta.postTokenBalances || [], mint);
  const zero = BigInt(0);
  const sourceDelta = (post.get(input.expected_source_wallet) ?? zero) - (pre.get(input.expected_source_wallet) ?? zero);
  const treasuryDelta = (post.get(input.expected_treasury_wallet) ?? zero) - (pre.get(input.expected_treasury_wallet) ?? zero);
  const expected = BigInt(input.expected_amount_micro_usdc);
  if (sourceDelta > -expected) return { ok: false, error: "deposit_source_wallet_or_amount_mismatch" };
  if (treasuryDelta < expected) return { ok: false, error: "deposit_treasury_or_amount_mismatch" };
  return { ok: true, slot: transaction.slot };
}

export async function verifyConsumerSolanaUsdcWithdrawal(input: {
  signature: string;
  expected_treasury_wallet: string;
  expected_destination_wallet: string;
  expected_amount_micro_usdc: number;
}): Promise<{ ok: true; slot: number } | { ok: false; error: string }> {
  const evidence = await finalizedUsdcEvidence(input.signature);
  if (!evidence.ok) return evidence;
  const zero = BigInt(0);
  const treasuryDelta = (evidence.post.get(input.expected_treasury_wallet) ?? zero) - (evidence.pre.get(input.expected_treasury_wallet) ?? zero);
  const destinationDelta = (evidence.post.get(input.expected_destination_wallet) ?? zero) - (evidence.pre.get(input.expected_destination_wallet) ?? zero);
  const expected = BigInt(input.expected_amount_micro_usdc);
  if (treasuryDelta > -expected) return { ok: false, error: "withdrawal_treasury_or_amount_mismatch" };
  if (destinationDelta < expected) return { ok: false, error: "withdrawal_destination_or_amount_mismatch" };
  return { ok: true, slot: evidence.slot };
}

async function finalizedUsdcEvidence(signature: string): Promise<
  | { ok: true; slot: number; pre: Map<string, bigint>; post: Map<string, bigint> }
  | { ok: false; error: string }
> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(signature)) return { ok: false, error: "solana_signature_invalid" };
  const rpcUrl = process.env.GHOLA_CONSUMER_SOLANA_RPC_URL?.trim();
  if (!rpcUrl) return { ok: false, error: "consumer_solana_rpc_unconfigured" };
  const connection = new Connection(rpcUrl, "finalized");
  const transaction = await connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!transaction?.meta || transaction.meta.err) return { ok: false, error: "solana_transfer_not_finalized" };
  const mint = process.env.GHOLA_CONSUMER_SOLANA_USDC_MINT?.trim() || MAINNET_USDC_MINT;
  return {
    ok: true,
    slot: transaction.slot,
    pre: tokenAmounts(transaction.meta.preTokenBalances || [], mint),
    post: tokenAmounts(transaction.meta.postTokenBalances || [], mint),
  };
}

function tokenAmounts(
  balances: Array<{ owner?: string; mint: string; uiTokenAmount: { amount: string; decimals: number } }>,
  mint: string,
) {
  const amounts = new Map<string, bigint>();
  for (const balance of balances) {
    if (balance.mint !== mint || balance.uiTokenAmount.decimals !== 6 || !balance.owner) continue;
    amounts.set(balance.owner, (amounts.get(balance.owner) ?? BigInt(0)) + BigInt(balance.uiTokenAmount.amount));
  }
  return amounts;
}
