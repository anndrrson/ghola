#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PROGRAM_ID = "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A";
const DEFAULT_LOCAL_RPC_URL = "http://127.0.0.1:8899";
const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_SIZE = 82;
const VALID_SMOKE_CLUSTERS = new Set(["local", "devnet"]);
const MIN_DEVNET_SIGNER_LAMPORTS = 50_000_000;

class SmokeError extends Error {
  constructor(input) {
    super(input.message || input.code);
    this.name = "SmokeError";
    this.stage = input.stage;
    this.operation = input.operation || null;
    this.code = input.code;
    this.recoveryHint = input.recoveryHint || null;
    this.details = input.details || {};
  }
}

async function main() {
  const cluster = smokeCluster();
  const isLocalSmoke = cluster === "local";
  const commitment = isLocalSmoke ? "confirmed" : "finalized";
  const rpcUrl = defaultRpcUrl(cluster);
  const programId = parseProgramId(cluster);
  const connection = new Connection(rpcUrl, commitment);
  const usingExistingWebServer = Boolean(process.env.GHOLA_WEB_URL?.trim());

  if (usingExistingWebServer && !process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN?.trim()) {
    throw new SmokeError({
      stage: "config",
      code: "internal_token_required",
      message: "GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN is required when GHOLA_WEB_URL points at an existing server",
      recoveryHint: "Set GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN to the token configured on the target web server.",
    });
  }
  if (usingExistingWebServer && !process.env.GHOLA_SHIELDED_POOL_MINT?.trim()) {
    throw new SmokeError({
      stage: "config",
      code: "shielded_pool_mint_required",
      message: "GHOLA_SHIELDED_POOL_MINT is required when GHOLA_WEB_URL points at an existing server",
      recoveryHint: "Set GHOLA_SHIELDED_POOL_MINT to the mint already configured by the target web server.",
    });
  }

  const signer = await loadKeypair(requiredSignerPath(cluster));
  await assertProgramReady(connection, programId, cluster, commitment);
  if (isLocalSmoke) {
    await ensureLocalBalance(connection, signer, rpcUrl);
  } else {
    await assertSignerFunded(connection, signer, commitment);
  }

  const skipMintCreate = boolEnv("GHOLA_AUCTION_SMOKE_SKIP_MINT_CREATE", !isLocalSmoke);
  const mint = await ensureMint(connection, signer, {
    allowCreate: isLocalSmoke && !skipMintCreate,
    cluster,
    commitment,
  });
  if (isLocalSmoke) {
    await ensurePoolInitialized(connection, signer, programId, commitment);
  } else {
    await verifyPoolInitialized(connection, signer, programId, commitment);
  }

  const internalToken = process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN ||
    `local_auction_${Date.now()}`;
  const userId = process.env.GHOLA_AUCTION_LOCAL_USER_ID || "local_auction_user";
  const userBearer = process.env.GHOLA_AUCTION_USER_BEARER ||
    `Bearer ${unsignedJwt(userId, `${userId}@example.com`)}`;
  const ownerCommitment = gholaCommitment("owner", userId);
  const server = await maybeStartServer({
    cluster,
    rpcUrl,
    programId: programId.toBase58(),
    mint: mint.toBase58(),
    internalToken,
  });
  const webUrl = server.url;

  try {
    const marketCommitmentHex = canonicalFieldHex(`market:${Date.now()}`);
    const epochId = Math.floor(Date.now() / 1000);
    const currentSlot = await connection.getSlot(commitment);
    const closeSlotDelta = Number.parseInt(process.env.GHOLA_AUCTION_LOCAL_CLOSE_SLOT_DELTA || "96", 10);
    const closesSlot = currentSlot + Math.max(32, closeSlotDelta);
    const auctionEpochCommitment = gholaCommitment("auction_epoch_on_chain", {
      owner_commitment: ownerCommitment,
      market_commitment_hex: marketCommitmentHex,
      epoch_id: epochId,
    });

    const market = await postInternal(webUrl, internalToken, "/v1/private-account/auctions/market", {
      signer_public_key: signer.publicKey.toBase58(),
      owner_commitment: ownerCommitment,
      account_commitment: ownerCommitment,
      market_commitment_hex: marketCommitmentHex,
      asset_id_hex: canonicalFieldHex(`asset:${cluster}-auction`),
      auction_verifier_key_hash_hex: canonicalFieldHex(`auction-vk:${cluster}-smoke`),
      batch_size: 64,
    }, "init_market");
    const marketTx = await submitPrepared({
      connection,
      prepared: market.prepared_transaction,
      signer,
      expectedProgramId: programId,
      commitment,
      operation: "init_market",
    });
    await postInternal(webUrl, internalToken, "/v1/private-account/auctions/confirm-internal", {
      client_reference: market.prepared_transaction.client_reference,
      signature: marketTx.signature,
    }, "confirm_init_market");

    const opened = await postInternal(webUrl, internalToken, "/v1/private-account/auctions/open", {
      signer_public_key: signer.publicKey.toBase58(),
      owner_commitment: ownerCommitment,
      account_commitment: ownerCommitment,
      market_commitment_hex: marketCommitmentHex,
      platform_class: "rfq_solver_network",
      asset_bucket: "ETH",
      amount_bucket: "25",
      epoch_id: epochId,
      closes_slot: closesSlot,
      auction_epoch_commitment: auctionEpochCommitment,
    }, "open_epoch");
    const openTx = await submitPrepared({
      connection,
      prepared: opened.prepared_transaction,
      signer,
      expectedProgramId: programId,
      commitment,
      operation: "open_epoch",
    });
    await postInternal(webUrl, internalToken, "/v1/private-account/auctions/confirm-internal", {
      client_reference: opened.prepared_transaction.client_reference,
      signature: openTx.signature,
    }, "confirm_open_epoch");

    const buyQueueId = await createQueuedAuctionIntent(webUrl, userBearer, "buy");
    const sellQueueId = await createQueuedAuctionIntent(webUrl, userBearer, "sell");
    const buy = await prepareSubmitAndConfirmOrder({
      webUrl,
      userBearer,
      connection,
      signer,
      programId,
      commitment,
      queueId: buyQueueId,
      side: "buy",
      marketCommitmentHex,
      epochId,
      auctionEpochCommitment,
      label: "buy",
    });
    const sell = await prepareSubmitAndConfirmOrder({
      webUrl,
      userBearer,
      connection,
      signer,
      programId,
      commitment,
      queueId: sellQueueId,
      side: "sell",
      marketCommitmentHex,
      epochId,
      auctionEpochCommitment,
      label: "sell",
    });

    await waitForSlot(connection, closesSlot, commitment);
    const epochAccount = await connection.getAccountInfo(
      new PublicKey(opened.prepared_transaction.accounts.auction_epoch),
      commitment,
    );
    if (!epochAccount) {
      throw new SmokeError({
        stage: "chain_read",
        operation: "close_epoch",
        code: "auction_epoch_missing",
        message: "auction epoch account missing after order commits",
        recoveryHint: "Confirm the open and commit transaction signatures on the configured Solana RPC.",
        details: { auction_epoch: opened.prepared_transaction.accounts.auction_epoch },
      });
    }
    const orderRootHex = Buffer.from(epochAccount.data.subarray(48, 80)).toString("hex");
    const orderCount = epochAccount.data.readUInt16LE(96);

    const clearingCommitment = `${cluster}_clearing_${Date.now()}`;
    const settlementCommitment = `${cluster}_settlement_${Date.now()}`;
    const close = await postInternal(webUrl, internalToken, "/v1/private-account/auctions/close", {
      signer_public_key: signer.publicKey.toBase58(),
      owner_commitment: ownerCommitment,
      account_commitment: ownerCommitment,
      auction_epoch_commitment: auctionEpochCommitment,
      clearing_commitment: clearingCommitment,
      market_commitment_hex: marketCommitmentHex,
      epoch_id: epochId,
      proof_a_hex: "00".repeat(64),
      proof_b_hex: "00".repeat(128),
      proof_c_hex: "00".repeat(64),
      auction_order_root_hex: orderRootHex,
      clearing_commitment_hex: canonicalFieldHex("clearing:on-chain"),
      clearing_price_commitment_hex: canonicalFieldHex("clearing:price"),
      matched_root_hex: canonicalFieldHex("matched:root"),
      rolled_root_hex: canonicalFieldHex("rolled:root"),
      matched_count: orderCount,
      rolled_count: 0,
      matched_order_commitments: [
        buy.confirmed.order.auction_order_commitment,
        sell.confirmed.order.auction_order_commitment,
      ],
      rolled_order_commitments: [],
      settlement_commitment: settlementCommitment,
      settlement_commitment_hex: canonicalFieldHex("settlement:on-chain"),
      proof_commitment_hex: canonicalFieldHex(`proof:${cluster}-smoke`),
    }, "close_epoch");
    const closeTx = await submitPrepared({
      connection,
      prepared: close.prepared_transaction,
      signer,
      expectedProgramId: programId,
      commitment,
      operation: "close_epoch",
    });
    const closeConfirmed = await postInternal(webUrl, internalToken, "/v1/private-account/auctions/confirm-internal", {
      client_reference: close.prepared_transaction.client_reference,
      signature: closeTx.signature,
    }, "confirm_close_epoch");

    const settle = await postUser(webUrl, userBearer, "/v1/private-account/auctions/settle", {
      signer_public_key: signer.publicKey.toBase58(),
      clearing_commitment: closeConfirmed.clearing.clearing_commitment,
      market_commitment_hex: marketCommitmentHex,
      epoch_id: epochId,
      settlement_commitment: settlementCommitment,
      settlement_commitment_hex: canonicalFieldHex("settlement:on-chain"),
      auction_epoch_commitment: auctionEpochCommitment,
    }, "settle_clearing");
    const settleTx = await submitPrepared({
      connection,
      prepared: settle.prepared_transaction,
      signer,
      expectedProgramId: programId,
      commitment,
      operation: "settle_clearing",
    });
    await postUser(webUrl, userBearer, "/v1/private-account/auctions/confirm", {
      client_reference: settle.prepared_transaction.client_reference,
      signature: settleTx.signature,
    }, "confirm_settle_clearing");

    const finalAuctions = await getUser(webUrl, userBearer, "/v1/private-account/auctions?limit=10", "final_state");
    const finalEpoch = finalAuctions.epochs.find(
      (epoch) => epoch.auction_epoch_commitment === auctionEpochCommitment,
    );
    const finalClearing = finalAuctions.clearings.find(
      (clearing) => clearing.clearing_commitment === closeConfirmed.clearing.clearing_commitment,
    );
    if (!finalEpoch || finalEpoch.status !== "settled" || !finalClearing || finalClearing.status !== "settled") {
      throw new SmokeError({
        stage: "final_state",
        operation: "settle_clearing",
        code: "auction_not_settled",
        message: "auction smoke did not settle final operational state",
        recoveryHint: "Inspect the web route state and the confirm route responses for the close and settle transactions.",
        details: { final_epoch: finalEpoch || null, final_clearing: finalClearing || null },
      });
    }

    const operationResults = {
      init_market: marketTx,
      open_epoch: openTx,
      commit_buy: buy.submission,
      commit_sell: sell.submission,
      close_epoch: closeTx,
      settle_clearing: settleTx,
    };
    console.log(JSON.stringify({
      version: 1,
      status: "settled",
      cluster,
      commitment,
      rpc_url: rpcUrl,
      web_url: webUrl,
      program_id: programId.toBase58(),
      mint: mint.toBase58(),
      owner_commitment: ownerCommitment,
      auction_epoch_commitment: auctionEpochCommitment,
      clearing_commitment: finalClearing.clearing_commitment,
      config: {
        using_existing_web_server: usingExistingWebServer,
        signer_public_key: signer.publicKey.toBase58(),
        skip_mint_create: skipMintCreate,
        closes_slot: closesSlot,
      },
      signatures: Object.fromEntries(
        Object.entries(operationResults).map(([operation, result]) => [operation, result.signature]),
      ),
      operation_results: operationResults,
      final_epoch: finalEpoch,
      final_clearing: finalClearing,
    }, null, 2));
  } finally {
    await server.stop();
  }
}

async function prepareSubmitAndConfirmOrder(input) {
  const operation = `commit_${input.label}`;
  const prepared = await postUser(input.webUrl, input.userBearer, "/v1/private-account/auctions/commit", {
    queue_id: input.queueId,
    side: input.side,
    amount_bucket: "25",
    asset_bucket: "ETH",
    signer_public_key: input.signer.publicKey.toBase58(),
    market_commitment_hex: input.marketCommitmentHex,
    epoch_id: input.epochId,
    auction_epoch_commitment: input.auctionEpochCommitment,
    order_commitment_hex: canonicalFieldHex(`order:${input.label}`),
    order_nullifier_hex: canonicalFieldHex(`order-nullifier:${input.label}`),
    price_bucket_commitment_hex: canonicalFieldHex(`price:${input.label}`),
    institution_policy_commitment_hex: canonicalFieldHex("institution-policy:local"),
  }, operation);
  const submission = await submitPrepared({
    connection: input.connection,
    prepared: prepared.prepared_transaction,
    signer: input.signer,
    expectedProgramId: input.programId,
    commitment: input.commitment,
    operation,
  });
  const confirmed = await postUser(input.webUrl, input.userBearer, "/v1/private-account/auctions/confirm", {
    client_reference: prepared.prepared_transaction.client_reference,
    signature: submission.signature,
  }, `confirm_${operation}`);
  return { prepared, submission, confirmed };
}

async function createQueuedAuctionIntent(webUrl, userBearer, side) {
  const intent = await postUser(webUrl, userBearer, "/v1/private-account/actions/intent", {
    action_class: "trade_on_platform",
    product_bucket: "perps",
  }, `queue_${side}_intent`);
  const preview = await postUser(webUrl, userBearer, "/v1/private-account/actions/privacy-preview", {
    intent_id: intent.intent_id,
    platform_class: "rfq_solver_network",
    requested_rail: "shielded_batch_auction",
    safe_input: {
      product_bucket: "perps",
      amount_bucket: "25",
      asset_bucket: "ETH",
      destination_class: "platform_subaccount",
      urgency: "maximum_privacy",
      solver_count_bucket: "5+",
      side,
    },
  }, `queue_${side}_preview`);
  const queued = await postUser(webUrl, userBearer, "/v1/private-account/actions/queue", {
    intent_id: intent.intent_id,
    preview_commitment: preview.preview.preview_commitment,
  }, `queue_${side}`);
  return queued.queued_action.queue_id;
}

async function submitPrepared(input) {
  const { connection, prepared, signer, expectedProgramId, commitment, operation } = input;
  if (!prepared?.transaction_base64) {
    throw new SmokeError({
      stage: "prepare_response",
      operation,
      code: "prepared_transaction_missing",
      message: "prepared transaction missing transaction_base64",
      recoveryHint: "Check the web prepare route response for this operation.",
      details: { prepared },
    });
  }
  const signerKey = signer.publicKey.toBase58();
  if (!prepared.required_signers?.includes(signerKey)) {
    throw new SmokeError({
      stage: "prepare_response",
      operation,
      code: "prepared_transaction_signer_mismatch",
      message: `prepared transaction does not require local signer ${signerKey}`,
      recoveryHint: "Run the smoke with the admin signer required by the prepared transaction.",
      details: { required_signers: prepared.required_signers || [] },
    });
  }
  const tx = Transaction.from(Buffer.from(prepared.transaction_base64, "base64"));
  const expected = expectedProgramId.toBase58();
  if (!tx.instructions.some((ix) => ix.programId.toBase58() === expected)) {
    throw new SmokeError({
      stage: "prepare_response",
      operation,
      code: "prepared_transaction_wrong_program",
      message: `prepared transaction does not target expected program ${expected}`,
      recoveryHint: "Check GHOLA_SHIELDED_POOL_PROGRAM_ID on the smoke runner and web server.",
      details: {
        expected_program_id: expected,
        transaction_program_ids: tx.instructions.map((ix) => ix.programId.toBase58()),
      },
    });
  }
  tx.partialSign(signer);

  let signature;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  } catch (error) {
    throw new SmokeError({
      stage: "submit_transaction",
      operation,
      code: "transaction_send_failed",
      message: errorMessage(error) || `failed to submit ${operation}`,
      recoveryHint: recoveryHintForOperation(operation),
      details: await transactionErrorDetails(error, connection),
    });
  }

  let confirmation;
  try {
    confirmation = await connection.confirmTransaction(signature, commitment);
  } catch (error) {
    throw new SmokeError({
      stage: "confirm_transaction",
      operation,
      code: "transaction_confirmation_failed",
      message: errorMessage(error) || `failed to confirm ${operation}`,
      recoveryHint: "Check RPC health, blockhash expiry, and whether the transaction landed on the target cluster.",
      details: {
        signature,
        ...(await transactionErrorDetails(error, connection)),
      },
    });
  }
  if (confirmation.value.err) {
    throw new SmokeError({
      stage: "confirm_transaction",
      operation,
      code: "transaction_rejected",
      message: `${operation} was rejected by the chain`,
      recoveryHint: recoveryHintForOperation(operation),
      details: {
        signature,
        err: confirmation.value.err,
        slot: confirmation.context.slot ?? null,
      },
    });
  }
  return {
    version: 1,
    signature,
    slot: confirmation.context.slot ?? null,
    confirmation_status: commitment,
  };
}

async function maybeStartServer(input) {
  const existingUrl = process.env.GHOLA_WEB_URL?.replace(/\/$/, "");
  if (existingUrl) {
    return {
      url: existingUrl,
      stop: async () => {},
    };
  }

  const port = process.env.GHOLA_AUCTION_LOCAL_PORT || "3107";
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NEXT_PUBLIC_SOLANA_RPC_URL: input.rpcUrl,
    GHOLA_SHIELDED_POOL_PROGRAM_ID: input.programId,
    GHOLA_SHIELDED_POOL_MINT: input.mint,
    GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED: "false",
    GHOLA_AUCTION_ON_CHAIN_PREPARE: "true",
    GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN: input.internalToken,
    GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS: "true",
    GHOLA_CONNECTOR_MODE: process.env.GHOLA_CONNECTOR_MODE || "local_test",
    GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE: process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE || "local_test",
    GHOLA_SHIELDED_POOL_MODE: process.env.GHOLA_SHIELDED_POOL_MODE || "local_test",
  };
  if (input.cluster === "local") {
    env.GHOLA_AUCTION_CONFIRMATION_MODE = "local_test";
  } else {
    delete env.GHOLA_AUCTION_CONFIRMATION_MODE;
  }

  const child = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", port], {
    cwd: APP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForHttp(`${url}/`, 90_000);
  return {
    url,
    stop: async () => {
      child.kill("SIGTERM");
      await sleep(500);
    },
  };
}

async function postInternal(webUrl, token, route, body, operation) {
  return postJson(webUrl, route, body, `Bearer ${token}`, operation);
}

async function postUser(webUrl, bearer, route, body, operation) {
  return postJson(webUrl, route, body, bearer, operation);
}

async function getUser(webUrl, bearer, route, operation) {
  let res;
  try {
    res = await fetch(`${webUrl}${route}`, {
      headers: { authorization: bearer },
    });
  } catch (error) {
    throw routeFetchError(route, operation, error);
  }
  return parseResponse(res, route, operation);
}

async function postJson(webUrl, route, body, authorization, operation) {
  let res;
  try {
    res = await fetch(`${webUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw routeFetchError(route, operation, error);
  }
  return parseResponse(res, route, operation);
}

async function parseResponse(res, route, operation) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new SmokeError({
      stage: "route_response",
      operation,
      code: "route_invalid_json",
      message: `${route} returned invalid JSON`,
      recoveryHint: "Check the web server logs for a framework error page or uncaught exception.",
      details: { route, status: res.status, text, parse_error: errorMessage(error) },
    });
  }
  if (!res.ok) {
    throw new SmokeError({
      stage: "route_response",
      operation,
      code: "route_request_failed",
      message: `${route} failed with ${res.status}`,
      recoveryHint: routeRecoveryHint(route),
      details: { route, status: res.status, body, text },
    });
  }
  return body;
}

function routeFetchError(route, operation, error) {
  return new SmokeError({
    stage: "route_request",
    operation,
    code: "route_fetch_failed",
    message: `${route} request failed`,
    recoveryHint: "Confirm the web server is running and reachable from the smoke runner.",
    details: { route, message: errorMessage(error) },
  });
}

async function assertProgramReady(connection, programId, cluster, commitment) {
  const info = await connection.getAccountInfo(programId, commitment);
  if (!info?.executable) {
    throw new SmokeError({
      stage: "config",
      code: "program_not_executable",
      message: `shielded-pool program ${programId.toBase58()} is not deployed/executable on ${cluster}`,
      recoveryHint: cluster === "local"
        ? "Start solana-test-validator with --bpf-program for said_shielded_pool."
        : "Deploy the Anchor program to devnet and set GHOLA_SHIELDED_POOL_PROGRAM_ID to that program id.",
      details: { cluster, program_id: programId.toBase58() },
    });
  }
}

async function ensurePoolInitialized(connection, signer, programId, commitment) {
  const [poolConfig] = PublicKey.findProgramAddressSync([Buffer.from("pool_config")], programId);
  const info = await connection.getAccountInfo(poolConfig, commitment);
  if (info) {
    assertPoolAdmin(info, signer, poolConfig);
    return poolConfig;
  }

  const [verifierKey] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_key"), poolConfig.toBuffer()],
    programId,
  );
  const verifierKeyBytes = Buffer.alloc(32);
  const data = Buffer.concat([
    anchorDiscriminator("init_pool"),
    u16(0),
    u32(verifierKeyBytes.length),
    verifierKeyBytes,
  ]);
  await sendInstructions(connection, signer, [
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolConfig, isSigner: false, isWritable: true },
        { pubkey: verifierKey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }),
  ], [], "init_pool_config");
  return poolConfig;
}

async function verifyPoolInitialized(connection, signer, programId, commitment) {
  const [poolConfig] = PublicKey.findProgramAddressSync([Buffer.from("pool_config")], programId);
  const info = await connection.getAccountInfo(poolConfig, commitment);
  if (!info) {
    throw new SmokeError({
      stage: "config",
      code: "pool_config_missing",
      message: `pool_config PDA ${poolConfig.toBase58()} is not initialized on the target cluster`,
      recoveryHint: "Initialize the shielded pool on devnet before running the devnet auction smoke.",
      details: { pool_config: poolConfig.toBase58(), program_id: programId.toBase58() },
    });
  }
  assertPoolAdmin(info, signer, poolConfig);
  return poolConfig;
}

function assertPoolAdmin(info, signer, poolConfig) {
  if (info.data.length < 40) {
    throw new SmokeError({
      stage: "config",
      code: "pool_config_invalid",
      message: `pool_config ${poolConfig.toBase58()} is too small to contain an admin key`,
      recoveryHint: "Verify the configured program id points to the expected said_shielded_pool deployment.",
      details: { pool_config: poolConfig.toBase58(), data_length: info.data.length },
    });
  }
  const admin = new PublicKey(info.data.subarray(8, 40));
  if (!admin.equals(signer.publicKey)) {
    throw new SmokeError({
      stage: "config",
      code: "pool_admin_signer_mismatch",
      message: `pool_config admin ${admin.toBase58()} does not match signer ${signer.publicKey.toBase58()}`,
      recoveryHint: "Run the smoke with the pool admin signer, or initialize a pool owned by this signer on the target cluster.",
      details: { pool_config: poolConfig.toBase58(), admin: admin.toBase58(), signer: signer.publicKey.toBase58() },
    });
  }
}

async function ensureMint(connection, signer, input) {
  const configured = process.env.GHOLA_SHIELDED_POOL_MINT?.trim();
  if (configured) {
    const mint = parsePublicKey(configured, "GHOLA_SHIELDED_POOL_MINT");
    const info = await connection.getAccountInfo(mint, input.commitment);
    if (!info) {
      throw new SmokeError({
        stage: "config",
        code: "configured_mint_missing",
        message: `configured mint ${configured} does not exist on ${input.cluster}`,
        recoveryHint: "Set GHOLA_SHIELDED_POOL_MINT to an existing SPL token mint on the configured cluster.",
        details: { mint: configured, cluster: input.cluster },
      });
    }
    if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new SmokeError({
        stage: "config",
        code: "configured_mint_wrong_owner",
        message: `configured mint ${configured} is not owned by the SPL token program`,
        recoveryHint: "Set GHOLA_SHIELDED_POOL_MINT to a real SPL token mint.",
        details: { mint: configured, owner: info.owner.toBase58() },
      });
    }
    return mint;
  }

  if (!input.allowCreate) {
    throw new SmokeError({
      stage: "config",
      code: "shielded_pool_mint_required",
      message: "GHOLA_SHIELDED_POOL_MINT is required when mint creation is disabled",
      recoveryHint: "Set GHOLA_SHIELDED_POOL_MINT to an existing mint, or run local mode without GHOLA_AUCTION_SMOKE_SKIP_MINT_CREATE=true.",
      details: { cluster: input.cluster },
    });
  }

  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const data = Buffer.alloc(67);
  data[0] = 0;
  data[1] = 6;
  signer.publicKey.toBuffer().copy(data, 2);
  data.writeUInt32LE(0, 34);
  PublicKey.default.toBuffer().copy(data, 38);
  await sendInstructions(connection, signer, [
    SystemProgram.createAccount({
      fromPubkey: signer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    }),
  ], [mint], "create_local_mint");
  return mint.publicKey;
}

async function sendInstructions(connection, payer, instructions, extraSigners = [], operation = "setup") {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(...instructions);
  tx.sign(payer, ...extraSigners);
  let signature;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "finalized");
  } catch (error) {
    throw new SmokeError({
      stage: "setup",
      operation,
      code: "setup_transaction_failed",
      message: errorMessage(error) || `${operation} transaction failed`,
      recoveryHint: "Check the local validator/program deployment and signer balance.",
      details: { signature: signature || null, ...(await transactionErrorDetails(error, connection)) },
    });
  }
  return signature;
}

async function ensureLocalBalance(connection, signer, rpcUrl) {
  const balance = await connection.getBalance(signer.publicKey, "confirmed");
  if (balance >= 2_000_000_000 || !/127\.0\.0\.1|localhost/.test(rpcUrl)) return;
  const signature = await connection.requestAirdrop(signer.publicKey, 5_000_000_000);
  await connection.confirmTransaction(signature, "confirmed");
}

async function assertSignerFunded(connection, signer, commitment) {
  const balance = await connection.getBalance(signer.publicKey, commitment);
  if (balance >= MIN_DEVNET_SIGNER_LAMPORTS) return;
  throw new SmokeError({
    stage: "config",
    code: "devnet_signer_underfunded",
    message: `devnet signer ${signer.publicKey.toBase58()} has insufficient SOL`,
    recoveryHint: "Fund the devnet signer before running the smoke; the script does not airdrop or create devnet setup accounts.",
    details: { signer: signer.publicKey.toBase58(), balance_lamports: balance, minimum_lamports: MIN_DEVNET_SIGNER_LAMPORTS },
  });
}

async function waitForSlot(connection, targetSlot, commitment) {
  for (;;) {
    const slot = await connection.getSlot(commitment);
    if (slot >= targetSlot) return;
    await sleep(500);
  }
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // wait
    }
    await sleep(750);
  }
  throw new SmokeError({
    stage: "server_start",
    code: "web_server_timeout",
    message: `timed out waiting for ${url}`,
    recoveryHint: "Check the Next dev server output above for build or port errors.",
    details: { url, timeout_ms: timeoutMs },
  });
}

async function loadKeypair(keypairPath) {
  const resolved = resolveKeypairPath(keypairPath);
  let raw;
  try {
    raw = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new SmokeError({
      stage: "config",
      code: "signer_keypair_unreadable",
      message: `failed to read keypair file ${resolved}`,
      recoveryHint: "Set GHOLA_AUCTION_SIGNER_KEYPAIR or ANCHOR_WALLET to a readable Solana keypair file.",
      details: { path: resolved, message: errorMessage(error) },
    });
  }
  if (!Array.isArray(raw)) {
    throw new SmokeError({
      stage: "config",
      code: "signer_keypair_invalid",
      message: `keypair file ${resolved} must contain a Solana secret-key array`,
      recoveryHint: "Use a Solana CLI keypair JSON file.",
      details: { path: resolved },
    });
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch (error) {
    throw new SmokeError({
      stage: "config",
      code: "signer_keypair_invalid",
      message: `keypair file ${resolved} is not a valid Solana keypair`,
      recoveryHint: "Use a Solana CLI keypair JSON file.",
      details: { path: resolved, message: errorMessage(error) },
    });
  }
}

function smokeCluster() {
  const raw = process.env.GHOLA_AUCTION_SMOKE_CLUSTER?.trim() || "local";
  if (VALID_SMOKE_CLUSTERS.has(raw)) return raw;
  throw new SmokeError({
    stage: "config",
    code: "invalid_smoke_cluster",
    message: `GHOLA_AUCTION_SMOKE_CLUSTER must be one of ${Array.from(VALID_SMOKE_CLUSTERS).join(", ")}`,
    recoveryHint: "Set GHOLA_AUCTION_SMOKE_CLUSTER=local or GHOLA_AUCTION_SMOKE_CLUSTER=devnet.",
    details: { value: raw },
  });
}

function defaultRpcUrl(cluster) {
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC?.trim() ||
    (cluster === "devnet" ? DEFAULT_DEVNET_RPC_URL : DEFAULT_LOCAL_RPC_URL);
}

function parseProgramId(cluster) {
  const configured = process.env.GHOLA_SHIELDED_POOL_PROGRAM_ID?.trim();
  if (cluster === "devnet" && !configured) {
    throw new SmokeError({
      stage: "config",
      code: "program_id_required",
      message: "GHOLA_SHIELDED_POOL_PROGRAM_ID is required for devnet smoke",
      recoveryHint: "Deploy the program to devnet and set GHOLA_SHIELDED_POOL_PROGRAM_ID.",
    });
  }
  return parsePublicKey(configured || DEFAULT_PROGRAM_ID, "GHOLA_SHIELDED_POOL_PROGRAM_ID");
}

function parsePublicKey(value, name) {
  try {
    return new PublicKey(value);
  } catch {
    throw new SmokeError({
      stage: "config",
      code: "invalid_public_key",
      message: `${name} must be a valid Solana public key`,
      recoveryHint: `Set ${name} to a base58 Solana public key.`,
      details: { name, value },
    });
  }
}

function requiredSignerPath(cluster) {
  const configured = process.env.GHOLA_AUCTION_SIGNER_KEYPAIR?.trim() || process.env.ANCHOR_WALLET?.trim();
  if (configured) return configured;
  if (cluster === "local") return "~/.config/solana/id.json";
  throw new SmokeError({
    stage: "config",
    code: "signer_keypair_required",
    message: "GHOLA_AUCTION_SIGNER_KEYPAIR or ANCHOR_WALLET is required for devnet smoke",
    recoveryHint: "Set GHOLA_AUCTION_SIGNER_KEYPAIR to the devnet pool admin signer keypair.",
  });
}

function resolveKeypairPath(keypairPath) {
  if (keypairPath === "~") return homedir();
  if (keypairPath.startsWith("~/")) return path.join(homedir(), keypairPath.slice(2));
  return path.resolve(keypairPath);
}

function boolEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new SmokeError({
    stage: "config",
    code: "invalid_boolean_env",
    message: `${name} must be true or false`,
    recoveryHint: `Set ${name}=true or ${name}=false.`,
    details: { name, value: raw },
  });
}

async function transactionErrorDetails(error, connection) {
  const details = { message: errorMessage(error) };
  if (error instanceof Error) details.name = error.name;
  const logs = await extractTransactionLogs(error, connection);
  if (logs.length > 0) details.logs = logs;
  return details;
}

async function extractTransactionLogs(error, connection) {
  if (!error || typeof error !== "object") return [];
  const logs = error.logs;
  if (Array.isArray(logs) && logs.every((item) => typeof item === "string")) return logs;
  if (typeof error.getLogs !== "function") return [];
  try {
    const fetched = await error.getLogs(connection);
    return Array.isArray(fetched) && fetched.every((item) => typeof item === "string") ? fetched : [];
  } catch {
    return [];
  }
}

function recoveryHintForOperation(operation) {
  if (operation === "init_market") return "Check pool admin authority, market PDA seeds, and mint/program configuration.";
  if (operation === "open_epoch") return "Check market initialization, closes_slot, and signer authority.";
  if (operation?.startsWith("commit_")) return "Check the auction epoch is still open, order roots are valid, and the queue item was prepared for this epoch.";
  if (operation === "close_epoch") return "Check the epoch close slot, order root, clearing public inputs, and auction verifier readiness.";
  if (operation === "settle_clearing") return "Check the clearing account exists, signer authority, and settlement commitment inputs.";
  return "Check transaction logs and the configured Solana RPC.";
}

function routeRecoveryHint(route) {
  if (route.includes("/confirm")) return "Check that the submitted transaction signature is finalized on the configured cluster and matches the prepared client reference.";
  if (route.includes("/auctions/market")) return "Check signer_public_key, owner/account commitments, and program/mint env on the web server.";
  if (route.includes("/auctions/open")) return "Check market_commitment_hex, epoch id, and closes_slot.";
  if (route.includes("/auctions/commit")) return "Check the queued intent, open epoch, and required order commitment inputs.";
  if (route.includes("/auctions/close")) return "Check clearing proof public inputs, order root, and matched/rolled counts.";
  if (route.includes("/auctions/settle")) return "Check clearing_commitment and settlement commitment inputs.";
  return "Check the web route logs for validation errors.";
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function anchorDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function canonicalFieldHex(label) {
  const out = createHash("sha256").update(label).digest();
  out[0] &= 0x1f;
  return out.toString("hex");
}

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unsignedJwt(userId, email) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  return `${header}.${payload}.local`;
}

function gholaCommitment(prefix, value) {
  return `${prefix}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 48)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function failurePayload(error) {
  if (error instanceof SmokeError) {
    return {
      version: 1,
      status: "failed",
      stage: error.stage,
      operation: error.operation,
      code: error.code,
      message: error.message,
      recovery_hint: error.recoveryHint,
      details: error.details,
    };
  }
  return {
    version: 1,
    status: "failed",
    stage: "unexpected",
    operation: null,
    code: "unexpected_error",
    message: errorMessage(error) || String(error),
    recovery_hint: "Inspect the stack trace or rerun with the same env after checking prior setup steps.",
    details: {},
  };
}

main().catch((error) => {
  console.error(JSON.stringify(failurePayload(error), null, 2));
  process.exit(1);
});
