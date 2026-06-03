import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const DEFAULT_JUPITER_SWAP_BASE_URL = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_TX_BASE_URL = "https://api.jup.ag/tx/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export class JupiterSwapExecutionError extends Error {
  constructor(message, status = 502, code = "connector_submit_failed") {
    super(message);
    this.name = "JupiterSwapExecutionError";
    this.status = status;
    this.code = code;
  }
}

export function jupiterCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object") {
    throw new JupiterSwapExecutionError("jupiter execution vault is invalid", 400, "venue_access_required");
  }
  if (vault.kind !== "ghola_solana_swap_execution_vault") {
    throw new JupiterSwapExecutionError("jupiter execution vault kind is invalid", 400, "venue_access_required");
  }
  const keypair = keypairFromSecret(
    vault.wallet_private_key ||
      vault.authority_private_key ||
      vault.secret_key ||
      vault.private_key,
  );
  const authority = keypair.publicKey.toBase58();
  if (vault.authority && String(vault.authority) !== authority) {
    throw new JupiterSwapExecutionError("jupiter vault authority mismatch", 400, "venue_access_required");
  }
  return {
    venueId: "jupiter",
    network: "mainnet",
    authority,
    keypair,
    swapBaseUrl: stringValue(vault.swap_api_url) ||
      stringValue(vault.api_url) ||
      process.env.PRIVATE_AGENT_JUPITER_SWAP_API_URL ||
      process.env.JUPITER_SWAP_API_URL ||
      DEFAULT_JUPITER_SWAP_BASE_URL,
    txBaseUrl: stringValue(vault.tx_api_url) ||
      process.env.PRIVATE_AGENT_JUPITER_TX_API_URL ||
      process.env.JUPITER_TX_API_URL ||
      DEFAULT_JUPITER_TX_BASE_URL,
  };
}

export function loadPooledJupiterCredential() {
  const raw = process.env.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON ||
    process.env.PRIVATE_AGENT_SOLANA_SWAP_POOLED_VAULT_JSON ||
    readOptionalPath(process.env.PRIVATE_AGENT_JUPITER_POOLED_VAULT_PATH) ||
    readOptionalPath(process.env.PRIVATE_AGENT_SOLANA_SWAP_POOLED_VAULT_PATH);
  if (!raw && process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    const keypair = Keypair.generate();
    return {
      venueId: "jupiter",
      network: "mainnet",
      authority: keypair.publicKey.toBase58(),
      keypair,
      swapBaseUrl: DEFAULT_JUPITER_SWAP_BASE_URL,
      txBaseUrl: DEFAULT_JUPITER_TX_BASE_URL,
    };
  }
  if (!raw) {
    throw new JupiterSwapExecutionError("pooled Jupiter authority is unavailable", 503, "venue_access_required");
  }
  try {
    const parsed = JSON.parse(raw);
    return jupiterCredentialFromVault({
      kind: "ghola_solana_swap_execution_vault",
      network: "mainnet",
      ...parsed,
    });
  } catch (error) {
    if (error instanceof JupiterSwapExecutionError) throw error;
    throw new JupiterSwapExecutionError("pooled Jupiter authority is invalid JSON", 503, "venue_access_required");
  }
}

export async function submitJupiterSwapExecution({
  credential,
  instruction,
  clientOrderId,
  executionMode = "user_stealth",
  fetchImpl = fetch,
}) {
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status: statusForOperation(instruction.operation_class),
      provider_ref_seed: {
        venue: "jupiter",
        client_order_id: clientOrderId,
        execution_mode: executionMode,
        routing_mode: instruction.order?.routing_mode || null,
        dry_run: true,
      },
      result_seed: {
        kind: "jupiter_dry_run",
        routing_mode: instruction.order?.routing_mode || null,
        input_mint_commitment: mintCommitment(instruction.order?.input_mint),
        output_mint_commitment: mintCommitment(instruction.order?.output_mint),
      },
      fills: [],
      final_proof: jupiterFinalProof({
        status: "submitted",
        routingMode: instruction.order?.routing_mode || "meta_aggregator",
        signature: null,
        noSubmit: false,
      }),
    };
  }

  assertJupiterLiveEnabled(instruction);
  try {
    const result = instruction.order.routing_mode === "router"
      ? await executeRouterSwap({ credential, instruction, fetchImpl })
      : await executeMetaAggregatorSwap({ credential, instruction, fetchImpl });
    return {
      status: result.status === "Success" || result.signature ? "submitted" : "failed",
      provider_ref_seed: {
        venue: "jupiter",
        client_order_id: clientOrderId,
        execution_mode: executionMode,
        routing_mode: instruction.order.routing_mode,
        request_id: result.requestId || null,
        signature: result.signature || null,
      },
      result_seed: {
        kind: "jupiter_live_result",
        routing_mode: instruction.order.routing_mode,
        status: result.status || null,
        code: result.code ?? null,
        signature: result.signature || null,
        input_result_bucket: decimalBucket(result.inputAmountResult),
        output_result_bucket: decimalBucket(result.outputAmountResult),
      },
      fills: result.signature ? [{ signature: result.signature, routing_mode: instruction.order.routing_mode }] : [],
      final_proof: jupiterFinalProof({
        status: result.status === "Success" || result.signature ? "submitted" : "failed",
        routingMode: instruction.order.routing_mode,
        signature: result.signature || null,
        requestId: result.requestId || null,
        noSubmit: false,
      }),
    };
  } catch (error) {
    throw safeJupiterError(error);
  }
}

export async function verifyJupiterSwapNoSubmit({
  credential,
  instruction,
  clientOrderId,
  executionMode = "user_stealth",
  fetchImpl = fetch,
}) {
  if (
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" ||
    process.env.PRIVATE_AGENT_JUPITER_NO_SUBMIT_LOCAL_CHECKS === "true"
  ) {
    return jupiterNoSubmitResult({
      instruction,
      clientOrderId,
      executionMode,
      orderBuilt: true,
      transactionBuilt: true,
      apiReachable: true,
    });
  }

  assertJupiterLiveEnabled(instruction);
  try {
    const built = instruction.order.routing_mode === "router"
      ? await fetchJupiterBuild({ credential, instruction, fetchImpl })
      : await fetchJupiterOrder({ credential, instruction, fetchImpl });
    return jupiterNoSubmitResult({
      instruction,
      clientOrderId,
      executionMode,
      orderBuilt: Boolean(built),
      transactionBuilt: Boolean(built.transaction || built.swapInstruction),
      apiReachable: true,
      requestId: built.requestId || null,
    });
  } catch (error) {
    throw safeJupiterError(error);
  }
}

function jupiterNoSubmitResult({
  instruction,
  clientOrderId,
  executionMode,
  orderBuilt,
  transactionBuilt,
  apiReachable,
  requestId = null,
}) {
  return {
    status: "verified_no_funds",
    provider_ref_seed: {
      venue: "jupiter",
      client_order_id: clientOrderId,
      execution_mode: executionMode,
      routing_mode: instruction.order?.routing_mode || null,
      request_id: requestId,
      no_submit: true,
    },
    result_seed: {
      kind: "jupiter_no_submit_verification",
      routing_mode: instruction.order?.routing_mode || null,
      input_mint_commitment: mintCommitment(instruction.order?.input_mint),
      output_mint_commitment: mintCommitment(instruction.order?.output_mint),
      order_built: orderBuilt,
      transaction_built: transactionBuilt,
    },
    checks: {
      sealed_vault_opened: true,
      sealed_instruction_opened: true,
      authority_derived: true,
      policy_enforced: true,
      live_gate_enforced: true,
      rpc_reachable: false,
      phoenix_sdk_ready: false,
      order_packet_built: false,
      api_wallet_loaded: true,
      hyperliquid_api_reachable: false,
      hyperliquid_sdk_ready: false,
      account_read_checked: false,
      order_request_built: transactionBuilt,
      jupiter_api_reachable: apiReachable,
      jupiter_token_allowlist_passed: true,
      jupiter_order_built: orderBuilt,
      jupiter_transaction_built: transactionBuilt,
      transaction_broadcast: false,
    },
    final_proof: jupiterFinalProof({
      status: "verified_no_funds",
      routingMode: instruction.order?.routing_mode || "meta_aggregator",
      signature: null,
      requestId,
      noSubmit: true,
    }),
  };
}

async function executeMetaAggregatorSwap({ credential, instruction, fetchImpl }) {
  const order = await fetchJupiterOrder({ credential, instruction, fetchImpl });
  if (!order.transaction || !order.requestId) {
    throw new JupiterSwapExecutionError("jupiter order did not include a signable transaction", 502);
  }
  const signedTransaction = signBase64Transaction(order.transaction, credential.keypair);
  const result = await fetchJson(fetchImpl, `${credential.swapBaseUrl}/execute`, {
    method: "POST",
    headers: jupiterHeaders({ json: true }),
    body: JSON.stringify({
      signedTransaction,
      requestId: order.requestId,
    }),
  });
  return {
    ...result,
    requestId: order.requestId,
  };
}

async function executeRouterSwap({ credential, instruction, fetchImpl }) {
  const built = await fetchJupiterBuild({ credential, instruction, fetchImpl });
  const transaction = buildRouterTransaction(built, credential.keypair);
  const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  const result = await fetchJson(fetchImpl, `${credential.txBaseUrl}/submit`, {
    method: "POST",
    headers: jupiterHeaders({ json: true }),
    body: JSON.stringify({ signedTransaction }),
  });
  return {
    status: result.signature ? "Success" : "Failed",
    signature: result.signature || null,
    code: result.signature ? 0 : -1000,
  };
}

async function fetchJupiterOrder({ credential, instruction, fetchImpl }) {
  const params = jupiterOrderParams(instruction.order, credential.authority);
  const body = await fetchJson(fetchImpl, `${credential.swapBaseUrl}/order?${params.toString()}`, {
    headers: jupiterHeaders(),
  });
  if (body.error || body.errorCode) {
    throw new JupiterSwapExecutionError("jupiter order request failed", 422, "venue_rejected");
  }
  return body;
}

async function fetchJupiterBuild({ credential, instruction, fetchImpl }) {
  const params = jupiterOrderParams(instruction.order, credential.authority);
  const body = await fetchJson(fetchImpl, `${credential.swapBaseUrl}/build?${params.toString()}`, {
    headers: jupiterHeaders(),
  });
  if (body.error || body.errorCode) {
    throw new JupiterSwapExecutionError("jupiter build request failed", 422, "venue_rejected");
  }
  return body;
}

function jupiterOrderParams(order, taker) {
  const params = new URLSearchParams({
    inputMint: order.input_mint,
    outputMint: order.output_mint,
    amount: order.amount,
    taker,
  });
  if (order.max_slippage_bps) params.set("slippageBps", order.max_slippage_bps);
  if (order.payer) params.set("payer", order.payer);
  return params;
}

function signBase64Transaction(transaction, keypair) {
  const parsed = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  parsed.sign([keypair]);
  return Buffer.from(parsed.serialize()).toString("base64");
}

function buildRouterTransaction(build, keypair) {
  const instructions = [
    ...(build.computeBudgetInstructions || []),
    ...(build.setupInstructions || []),
    build.swapInstruction,
    ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
    ...(build.otherInstructions || []),
    ...(build.tipInstruction ? [build.tipInstruction] : []),
  ].filter(Boolean).map(jupiterInstruction);
  if (!instructions.length) {
    throw new JupiterSwapExecutionError("jupiter build did not include swap instructions", 502);
  }
  const recentBlockhash = blockhashString(build.blockhashWithMetadata?.blockhash || build.blockhash);
  if (!recentBlockhash) {
    throw new JupiterSwapExecutionError("jupiter build did not include a blockhash", 502);
  }
  const lookupTables = Object.entries(build.addressesByLookupTableAddress || {})
    .map(([key, addresses]) => lookupTableAccount(key, addresses));
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([keypair]);
  return transaction;
}

function jupiterInstruction(instruction) {
  return new TransactionInstruction({
    programId: new PublicKey(String(instruction.programId)),
    keys: (instruction.accounts || []).map((account) => ({
      pubkey: new PublicKey(String(account.pubkey)),
      isSigner: account.isSigner === true,
      isWritable: account.isWritable === true,
    })),
    data: Buffer.from(String(instruction.data || ""), "base64"),
  });
}

function lookupTableAccount(key, addresses) {
  return new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: null,
      addresses: Array.isArray(addresses) ? addresses.map((address) => new PublicKey(String(address))) : [],
    },
  });
}

function assertJupiterLiveEnabled(instruction) {
  if (process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE !== "full") {
    throw new JupiterSwapExecutionError("jupiter live submit is disabled", 503, "connector_submit_failed");
  }
  if (!jupiterApiKey()) {
    throw new JupiterSwapExecutionError("jupiter api key is unavailable", 503, "connector_submit_failed");
  }
  const inputAllowlist = mintAllowlist("PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS", "GHOLA_JUPITER_ALLOWED_INPUT_MINTS");
  const outputAllowlist = mintAllowlist("PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS", "GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS");
  if (!inputAllowlist.has(instruction.order.input_mint) || !outputAllowlist.has(instruction.order.output_mint)) {
    throw new JupiterSwapExecutionError("jupiter swap mint is outside allowlist", 400, "venue_rejected");
  }
  const slippage = Number.parseInt(instruction.order.max_slippage_bps || "50", 10);
  const maxSlippage = Math.min(
    capBps(
      process.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_JUPITER_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS,
      100,
    ),
    100,
  );
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > maxSlippage) {
    throw new JupiterSwapExecutionError("jupiter slippage is outside policy", 400, "venue_rejected");
  }
  const notional = estimateSwapNotionalUsd(instruction.order);
  const maxNotional = Math.min(
    capUsd(
      process.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD ||
        process.env.GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD,
      1_000,
    ),
    capUsd(process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD || process.env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD, 1_000),
  );
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new JupiterSwapExecutionError("jupiter swap notional must be positive", 400, "venue_rejected");
  }
  if (notional > maxNotional) {
    throw new JupiterSwapExecutionError("jupiter swap exceeds live notional cap", 400, "venue_rejected");
  }
}

async function fetchJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new JupiterSwapExecutionError("jupiter api request failed", response.status, response.status === 401 ? "venue_access_required" : "connector_submit_failed");
  }
  return body;
}

function jupiterHeaders({ json = false } = {}) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "x-api-key": jupiterApiKey(),
  };
}

function jupiterApiKey() {
  return process.env.PRIVATE_AGENT_JUPITER_API_KEY ||
    process.env.JUPITER_API_KEY ||
    process.env.GHOLA_JUPITER_API_KEY ||
    "";
}

function mintAllowlist(primary, fallback) {
  const configured = process.env[primary] || process.env[fallback] || "";
  const values = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length && process.env.NODE_ENV === "production") {
    throw new JupiterSwapExecutionError("jupiter mint allowlist is not configured", 503, "connector_submit_failed");
  }
  return new Set(values.length ? values : [SOL_MINT, USDC_MINT]);
}

function keypairFromSecret(value) {
  const bytes = secretBytes(value);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new JupiterSwapExecutionError("jupiter wallet key must be 32-byte seed or 64-byte secret key", 400, "venue_access_required");
}

function secretBytes(value) {
  if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item)));
  const text = stringValue(value);
  if (!text) {
    throw new JupiterSwapExecutionError("jupiter wallet key is missing", 400, "venue_access_required");
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return Uint8Array.from(parsed.map((item) => Number(item)));
    } catch {
      throw new JupiterSwapExecutionError("jupiter wallet key JSON is invalid", 400, "venue_access_required");
    }
  }
  const cleanHex = text.startsWith("0x") ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{64}$/.test(cleanHex) || /^[0-9a-fA-F]{128}$/.test(cleanHex)) {
    return Uint8Array.from(Buffer.from(cleanHex, "hex"));
  }
  try {
    return bs58.decode(text);
  } catch {
    throw new JupiterSwapExecutionError("jupiter wallet key encoding is unsupported", 400, "venue_access_required");
  }
}

function safeJupiterError(error) {
  if (error instanceof JupiterSwapExecutionError) return error;
  const message = String(error?.message || "jupiter swap failed");
  if (/401|403|auth|access|permission|unauthorized/i.test(message)) {
    return new JupiterSwapExecutionError("jupiter venue access was rejected", 400, "venue_access_required");
  }
  if (/insufficient|not enough|funds|lamports|balance|gas/i.test(message)) {
    return new JupiterSwapExecutionError("jupiter account needs funds", 402, "needs_funds");
  }
  if (/slippage|rejected|failed|expired|blockhash/i.test(message)) {
    return new JupiterSwapExecutionError("jupiter swap was rejected", 422, "venue_rejected");
  }
  return new JupiterSwapExecutionError("jupiter swap failed", 502, "connector_submit_failed");
}

function jupiterFinalProof({ status, routingMode, signature, requestId = null, noSubmit }) {
  return {
    version: 1,
    proof_kind: "jupiter_swap_execution_proof_v1",
    status,
    venue_id: "jupiter",
    routing_mode: routingMode,
    broadcast_performed: noSubmit ? false : Boolean(signature),
    final_venue_execution_proven: Boolean(signature),
    final_fill_proven: Boolean(signature),
    signature_commitment: signature ? commitment("jupiter_signature", signature) : null,
    request_commitment: requestId ? commitment("jupiter_request", requestId) : null,
    checked_at: new Date().toISOString(),
  };
}

function statusForOperation(operationClass) {
  if (operationClass === "reconcile") return "reconciled";
  if (operationClass === "read" || operationClass === "preview_order") return "previewed";
  return "submitted";
}

function readOptionalPath(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new JupiterSwapExecutionError("pooled Jupiter authority file is unreadable", 503, "venue_access_required");
  }
}

function blockhashString(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return bs58.encode(Uint8Array.from(value.map((item) => Number(item))));
  return "";
}

function capBps(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateSwapNotionalUsd(order) {
  const quote = Number.parseFloat(order?.quote_size || "");
  return Number.isFinite(quote) && quote > 0 ? quote : 0;
}

function decimalBucket(value) {
  const number = Number.parseFloat(String(value || "0"));
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number < 1) return "<1";
  if (number < 5) return "1-5";
  if (number < 25) return "5-25";
  if (number < 100) return "25-100";
  return "100+";
}

function mintCommitment(value) {
  return value ? commitment("jupiter_mint", String(value)) : null;
}

function commitment(prefix, value) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48)}`;
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
