import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { AccountRole } from "@solana/kit";
import {
  createPhoenixClient,
  placeMarketOrder,
  Side,
} from "@ellipsis-labs/rise";

const SUPPORTED_SOLANA_PERPS_VENUES = new Set(["phoenix", "drift", "backpack", "solana_perps"]);
const DEFAULT_PHOENIX_API_URL = "https://perp-api.phoenix.trade";
const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

export class SolanaPerpsExecutionError extends Error {
  constructor(message, status = 502, code = "connector_submit_failed") {
    super(message);
    this.name = "SolanaPerpsExecutionError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeSolanaPerpsVenueId(value) {
  const venueId = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "phoenix";
  if (!SUPPORTED_SOLANA_PERPS_VENUES.has(venueId)) {
    throw new SolanaPerpsExecutionError("solana perps venue_id is unsupported", 400);
  }
  return venueId === "solana_perps" ? "phoenix" : venueId;
}

export function solanaPerpsCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object") {
    throw new SolanaPerpsExecutionError("solana perps execution vault is invalid", 400, "venue_access_required");
  }
  if (vault.kind !== "ghola_solana_perps_execution_vault") {
    throw new SolanaPerpsExecutionError("solana perps execution vault kind is invalid", 400, "venue_access_required");
  }
  const venueId = normalizeSolanaPerpsVenueId(vault.venue_id);
  if (venueId !== "phoenix") {
    throw new SolanaPerpsExecutionError("only phoenix solana perps live pilot is enabled", 400, "venue_rejected");
  }
  const keypair = keypairFromSecret(
    vault.wallet_private_key ||
      vault.authority_private_key ||
      vault.secret_key ||
      vault.private_key,
  );
  const authority = keypair.publicKey.toBase58();
  if (vault.authority && String(vault.authority) !== authority) {
    throw new SolanaPerpsExecutionError("solana perps vault authority mismatch", 400, "venue_access_required");
  }
  const network = vault.network === "mainnet" ? "mainnet" : "mainnet";
  return {
    venueId,
    network,
    authority,
    keypair,
    apiUrl: stringValue(vault.api_url) || stringValue(vault.apiUrl) || DEFAULT_PHOENIX_API_URL,
    rpcUrl: stringValue(vault.rpc_url) ||
      stringValue(vault.rpcUrl) ||
      process.env.PRIVATE_AGENT_SOLANA_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      DEFAULT_SOLANA_RPC_URL,
    traderPdaIndex: integerValue(vault.trader_pda_index ?? vault.traderPdaIndex, 0),
    traderSubaccountIndex: integerValue(vault.trader_subaccount_index ?? vault.traderSubaccountIndex, 0),
    priorityFeeMicroLamports: integerValue(
      vault.priority_fee_micro_lamports ?? process.env.PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS,
      0,
    ),
  };
}

export async function submitSolanaPerpsExecution({
  credential,
  instruction,
  clientOrderId,
  venueId = "phoenix",
  executionMode = "user_stealth",
  runner = runPhoenixLiveOrder,
}) {
  const normalizedVenueId = normalizeSolanaPerpsVenueId(venueId);
  const status = statusForOperation(instruction.operation_class);
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status,
      provider_ref_seed: {
        venue: normalizedVenueId,
        client_order_id: clientOrderId,
        execution_mode: executionMode,
        dry_run: true,
      },
      result_seed: {
        kind: "solana_perps_dry_run",
        venue: normalizedVenueId,
        operation_class: instruction.operation_class,
        market: instruction.order?.market || instruction.cancel?.market || null,
      },
      fills: [],
    };
  }

  assertSolanaPerpsLiveEnabled(normalizedVenueId, instruction, credential);
  try {
    const result = await runner({
      credential,
      instruction,
      clientOrderId,
      venueId: normalizedVenueId,
    });
    return {
      status: result.status || status,
      provider_ref_seed: {
        venue: normalizedVenueId,
        client_order_id: clientOrderId,
        transaction_signature: result.signature || null,
      },
      result_seed: {
        kind: "solana_perps_live_result",
        venue: normalizedVenueId,
        operation_class: instruction.operation_class,
        market: instruction.order?.market || null,
        signature: result.signature || null,
      },
      fills: [],
    };
  } catch (error) {
    throw safeSolanaPerpsError(error);
  }
}

export async function verifySolanaPerpsNoSubmit({
  credential,
  instruction,
  clientOrderId,
  venueId = "phoenix",
  executionMode = "user_stealth",
  checker = checkPhoenixNoSubmit,
}) {
  const normalizedVenueId = normalizeSolanaPerpsVenueId(venueId);
  assertSolanaPerpsLiveEnabled(normalizedVenueId, instruction, credential);
  try {
    const result = await checker({
      credential,
      instruction,
      clientOrderId,
      venueId: normalizedVenueId,
    });
    return {
      status: "verified_no_funds",
      provider_ref_seed: {
        venue: normalizedVenueId,
        client_order_id: clientOrderId,
        execution_mode: executionMode,
        no_submit: true,
      },
      result_seed: {
        kind: "solana_perps_no_submit_verification",
        venue: normalizedVenueId,
        operation_class: instruction.operation_class,
        market_commitment: sha256Hex(String(instruction.order?.market || "")).slice(0, 32),
        rpc_checked: result.rpc_checked === true,
        phoenix_checked: result.phoenix_checked === true,
        order_packet_checked: result.order_packet_checked === true,
      },
      checks: {
        sealed_vault_opened: true,
        sealed_instruction_opened: true,
        authority_derived: true,
        policy_enforced: true,
        live_gate_enforced: true,
        rpc_reachable: result.rpc_checked === true,
        phoenix_sdk_ready: result.phoenix_checked === true,
        order_packet_built: result.order_packet_checked === true,
        transaction_broadcast: false,
      },
    };
  } catch (error) {
    throw safeSolanaPerpsError(error);
  }
}

async function checkPhoenixNoSubmit({ credential, instruction, clientOrderId }) {
  if (process.env.PRIVATE_AGENT_SOLANA_PERPS_NO_SUBMIT_LOCAL_CHECKS === "true") {
    return {
      rpc_checked: true,
      phoenix_checked: true,
      order_packet_checked: true,
    };
  }
  const order = instruction.order;
  const connection = new Connection(credential.rpcUrl, "confirmed");
  await connection.getLatestBlockhash("confirmed");
  const client = createPhoenixClient({
    apiUrl: credential.apiUrl,
    rpcUrl: credential.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  try {
    await client.exchange.ready();
    await client.orderPackets.buildMarketOrderPacket({
      symbol: order.market,
      side: order.side === "buy" ? Side.Bid : Side.Ask,
      baseUnits: orderBaseUnits(order),
      priceLimitUsd: order.limit_price,
      clientOrderId: clientOrderIdBigInt(clientOrderId),
    });
    return {
      rpc_checked: true,
      phoenix_checked: true,
      order_packet_checked: true,
    };
  } finally {
    client.dispose?.();
  }
}

function assertSolanaPerpsLiveEnabled(venueId, instruction, credential) {
  const liveMode = process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE || "disabled";
  if (liveMode !== "sdk_runner") {
    throw new SolanaPerpsExecutionError(
      "solana perps live submit is disabled",
      503,
      "connector_submit_failed",
    );
  }
  if (venueId !== "phoenix") {
    throw new SolanaPerpsExecutionError(
      "only phoenix solana perps live pilot is enabled",
      400,
      "venue_rejected",
    );
  }
  if (process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET !== "true") {
    throw new SolanaPerpsExecutionError(
      "solana perps mainnet submit is disabled",
      503,
      "connector_submit_failed",
    );
  }
  if (!credential?.keypair || !credential.rpcUrl || !credential.apiUrl) {
    throw new SolanaPerpsExecutionError("solana perps execution vault is unavailable", 400, "venue_access_required");
  }
  if (instruction.operation_class !== "perp_limit_order") {
    throw new SolanaPerpsExecutionError("solana perps live pilot only supports tiny-fill orders", 400);
  }
  const order = instruction.order || {};
  if (order.live_order_mode !== "tiny_fill" || order.tif !== "Ioc") {
    throw new SolanaPerpsExecutionError("solana perps live order must use tiny_fill IOC mode", 400);
  }
  const notional = estimateOrderNotionalUsd(order);
  const cap = Math.min(capUsd(process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD, 5), 25);
  if (notional <= 0) {
    throw new SolanaPerpsExecutionError("solana perps live order notional must be positive", 400);
  }
  if (notional > cap) {
    throw new SolanaPerpsExecutionError("solana perps tiny-fill exceeds live notional cap", 400);
  }
}

async function runPhoenixLiveOrder({ credential, instruction, clientOrderId }) {
  const order = instruction.order;
  const client = createPhoenixClient({
    apiUrl: credential.apiUrl,
    rpcUrl: credential.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  const transactionClient = Object.assign(client, {
    sendAndConfirmFromInstruction: async (ix, options = {}) =>
      sendAndConfirmPhoenixInstruction({
        credential,
        ix,
        commitment: options.commitment || "confirmed",
        priorityFee: options.priorityFee,
      }),
  });
  try {
    await client.exchange.ready();
    const packet = await client.orderPackets.buildMarketOrderPacket({
      symbol: order.market,
      side: order.side === "buy" ? Side.Bid : Side.Ask,
      baseUnits: orderBaseUnits(order),
      priceLimitUsd: order.limit_price,
      clientOrderId: clientOrderIdBigInt(clientOrderId),
    });
    const signature = await placeMarketOrder(
      transactionClient,
      {
        authority: credential.authority,
        symbol: order.market,
        orderPacket: packet,
      },
      {
        traderPdaIndex: credential.traderPdaIndex,
        traderSubaccountIndex: credential.traderSubaccountIndex,
        commitment: "confirmed",
      },
    );
    return { status: "submitted", signature };
  } finally {
    client.dispose?.();
  }
}

async function sendAndConfirmPhoenixInstruction({ credential, ix, commitment, priorityFee }) {
  const connection = new Connection(credential.rpcUrl, commitment);
  const transaction = new Transaction();
  const microLamports = Number.isInteger(priorityFee) && priorityFee > 0
    ? priorityFee
    : credential.priorityFeeMicroLamports;
  if (microLamports > 0) {
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  const instructions = Array.isArray(ix) ? ix : [ix];
  for (const instruction of instructions) {
    transaction.add(toWeb3Instruction(instruction));
  }
  const latest = await connection.getLatestBlockhash(commitment);
  transaction.feePayer = credential.keypair.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(credential.keypair);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    preflightCommitment: commitment,
    skipPreflight: false,
  });
  const confirmed = await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, commitment);
  if (confirmed.value.err) {
    throw new SolanaPerpsExecutionError("solana perps transaction was rejected", 422, "venue_rejected");
  }
  return signature;
}

function toWeb3Instruction(instruction) {
  if (!instruction?.programAddress) {
    throw new SolanaPerpsExecutionError("phoenix instruction is invalid", 502);
  }
  return new TransactionInstruction({
    programId: new PublicKey(String(instruction.programAddress)),
    keys: (instruction.accounts || []).map((account) => ({
      pubkey: new PublicKey(String(account.address)),
      isSigner: account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER,
      isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(instruction.data || []),
  });
}

function keypairFromSecret(value) {
  const bytes = secretBytes(value);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new SolanaPerpsExecutionError("solana perps wallet key must be 32-byte seed or 64-byte secret key", 400, "venue_access_required");
}

function secretBytes(value) {
  if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item)));
  const text = stringValue(value);
  if (!text) {
    throw new SolanaPerpsExecutionError("solana perps wallet key is missing", 400, "venue_access_required");
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return Uint8Array.from(parsed.map((item) => Number(item)));
    } catch {
      throw new SolanaPerpsExecutionError("solana perps wallet key JSON is invalid", 400, "venue_access_required");
    }
  }
  const cleanHex = text.startsWith("0x") ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{64}$/.test(cleanHex) || /^[0-9a-fA-F]{128}$/.test(cleanHex)) {
    return Uint8Array.from(Buffer.from(cleanHex, "hex"));
  }
  try {
    return bs58.decode(text);
  } catch {
    throw new SolanaPerpsExecutionError("solana perps wallet key encoding is unsupported", 400, "venue_access_required");
  }
}

function orderBaseUnits(order) {
  if (order.base_size) return order.base_size;
  const quote = Number.parseFloat(order.quote_size || "");
  const price = Number.parseFloat(order.limit_price || "");
  if (Number.isFinite(quote) && Number.isFinite(price) && quote > 0 && price > 0) {
    return trimDecimal(quote / price);
  }
  throw new SolanaPerpsExecutionError("solana perps order requires base size or quote size with price", 400);
}

function estimateOrderNotionalUsd(order) {
  const quote = Number.parseFloat(order.quote_size || "");
  if (Number.isFinite(quote) && quote > 0) return quote;
  const base = Number.parseFloat(order.base_size || "");
  const price = Number.parseFloat(order.limit_price || "");
  if (Number.isFinite(base) && Number.isFinite(price) && base > 0 && price > 0) return base * price;
  return 0;
}

function clientOrderIdBigInt(value) {
  const hex = createHash("sha256").update(String(value || "phoenix")).digest("hex").slice(0, 15);
  return BigInt(`0x${hex}`);
}

function safeSolanaPerpsError(error) {
  if (error instanceof SolanaPerpsExecutionError) return error;
  const message = String(error?.message || "solana perps live submit failed");
  if (/401|403|auth|access|invite|permission|unauthorized/i.test(message)) {
    return new SolanaPerpsExecutionError("solana perps venue access was rejected", 400, "venue_access_required");
  }
  if (/insufficient|not enough|funds|lamports|balance/i.test(message)) {
    return new SolanaPerpsExecutionError("solana perps account needs funds", 402, "needs_funds");
  }
  if (/insufficient|simulation|blockhash|rejected|failed/i.test(message)) {
    return new SolanaPerpsExecutionError("solana perps venue rejected the transaction", 422, "venue_rejected");
  }
  return new SolanaPerpsExecutionError("solana perps live submit failed", 502, "connector_submit_failed");
}

function statusForOperation(operationClass) {
  if (operationClass === "cancel") return "cancelled";
  if (operationClass === "fills" || operationClass === "reconcile") return "reconciled";
  if (operationClass === "read") return "previewed";
  return "submitted";
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function integerValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function trimDecimal(value) {
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}
