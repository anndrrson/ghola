import { createHash } from "node:crypto";
import {
  HYPERLIQUID_EXECUTION_VAULT_AAD_PREFIXES,
  openSealedBundle,
} from "../crypto/envelope.js";
import {
  executeClaimedPrivateSubmission,
  executeHyperliquidBoundInstruction,
  reconcileStoredExecution,
  verifyHyperliquidBoundInstruction,
} from "./private-execution.js";
import {
  hyperliquidCredentialFromVault,
  hyperliquidProtectionCloids,
  readHyperliquidAccountSnapshot,
  submitHyperliquidExecution,
} from "../venues/hyperliquid.js";
import { verifyHyperliquidMainnetVenueEvidence } from "./hyperliquid-mainnet-evidence.js";
import { buildHyperliquidMainnetProtection } from "./hyperliquid-mainnet-protection.js";

export const MAINNET_PROOF_CONFIRMATION =
  "I_UNDERSTAND_THIS_OPENS_AND_CLOSES_A_REAL_MAINNET_POSITION";

const MAINNET_PROOF_WORK_ORDER_PATTERN =
  /^hl_mainnet_investor_proof_(?:v2_)?[0-9a-f]{32}$/u;

export function isHyperliquidMainnetProofWorkOrder(value) {
  return MAINNET_PROOF_WORK_ORDER_PATTERN.test(String(value || ""));
}

export function validateHyperliquidMainnetRoundTripRequest(body, recipient, expectedRelease = null) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["request body must be an object"];
  if (body.version !== 1) errors.push("version must be 1");
  if (body.confirmation !== MAINNET_PROOF_CONFIRMATION) errors.push("mainnet round-trip confirmation is required");
  if (body.execution_mode !== "byo_api_key") errors.push("execution_mode must be byo_api_key");
  for (const field of ["account_commitment", "vault_commitment", "policy_commitment"]) {
    if (typeof body[field] !== "string" || !body[field].trim()) errors.push(`${field} is required`);
  }
  if (body.market !== "HYPE") errors.push("market must be HYPE");
  if (body.notional_usd !== 11) errors.push("notional_usd must be 11");
  if (body.slippage_bps !== 100) errors.push("slippage_bps must be 100");
  const release = body.release_binding;
  if (!release || typeof release !== "object" || Array.isArray(release) ||
      release.contract_version !== 2 ||
      !/^[a-f0-9]{40}$/u.test(String(release.web_git_sha || "")) ||
      !/^[a-f0-9]{40}$/u.test(String(release.worker_git_sha || "")) ||
      release.web_git_sha !== release.worker_git_sha ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(release.worker_image_digest || "")) ||
      !/^live_trading_config_[a-f0-9]{48}$/u.test(String(release.config_fingerprint || ""))) {
    errors.push("release_binding is invalid");
  } else if (expectedRelease && (
    expectedRelease.ready !== true ||
    release.contract_version !== expectedRelease.contract_version ||
    release.worker_git_sha !== expectedRelease.worker_git_sha ||
    release.web_git_sha !== expectedRelease.worker_git_sha ||
    release.worker_image_digest !== expectedRelease.worker_image_digest ||
    release.config_fingerprint !== expectedRelease.config_fingerprint
  )) {
    errors.push("release_binding does not match the running worker");
  }
  const bundle = body.encrypted_execution_vault;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    errors.push("encrypted_execution_vault is required");
  } else {
    if (bundle.alg !== "sealed-provider-v1") {
      errors.push("encrypted_execution_vault.alg is unsupported");
    }
    if (typeof bundle.recipient !== "string" || bundle.recipient !== recipient?.recipient_id) {
      errors.push("encrypted_execution_vault.recipient must match worker recipient");
    }
    for (const field of ["aad", "ciphertext"]) {
      if (typeof bundle[field] !== "string" || !bundle[field]) {
        errors.push(`encrypted_execution_vault.${field} is required`);
      }
    }
  }
  return errors;
}

export function hyperliquidMainnetRoundTripEnabled(env = process.env) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") return false;
  if (env.PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED !== "true") return false;
  if (env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET !== "true") return false;
  if (env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE !== "full_ticket") return false;
  const perOrder = Number(env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD);
  const daily = Number(env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD);
  const slippage = Number(env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS);
  return perOrder === 100 && daily === 500 &&
    Number.isInteger(slippage) && slippage === 100;
}

export async function recoverHyperliquidMainnetCanary({
  credential,
  state,
  proofWorkOrder,
  market = "HYPE",
  slippageBps = 100,
  fetchImpl = fetch,
  submitRecovery = submitHyperliquidExecution,
}) {
  if (credential?.network !== "mainnet" || market !== "HYPE" || slippageBps !== 100 ||
      !isHyperliquidMainnetProofWorkOrder(proofWorkOrder)) {
    throw proofError("mainnet canary recovery scope is invalid", 400);
  }
  const entryWorkOrder = `${proofWorkOrder}_entry`;
  const protectionCloids = hyperliquidProtectionCloids(
    await state.deriveHyperliquidCloid(entryWorkOrder),
  );
  const initial = await exactMarketState(fetchImpl, credential, market);
  if (Number(initial.positionSize) !== 0) {
    await emergencyFlatten({
      credential,
      market,
      slippageBps,
      state,
      fetchImpl,
      submitEmergency: submitRecovery,
      proofWorkOrder,
    });
  }
  const afterFlatten = await exactMarketState(fetchImpl, credential, market);
  let protectionCleanupExact = afterFlatten.openOrderCount === 0;
  if (afterFlatten.openOrderCount > 0) {
    try {
      await cancelProtectionOrders({
        credential,
        market,
        state,
        submitCancel: submitRecovery,
        proofWorkOrder,
        protectionCloids,
      });
      protectionCleanupExact = true;
    } catch {
      // A triggered child can already be filled; exact final state remains authoritative.
    }
  }
  const finalState = await waitForMarketState(
    fetchImpl,
    credential,
    market,
    (snapshot) => Number(snapshot.positionSize) === 0 && snapshot.openOrderCount === 0,
    "mainnet canary recovery did not return flat with zero open orders",
  );
  return {
    version: 1,
    status: "recovered_safe",
    network: "mainnet",
    market,
    flat: Number(finalState.positionSize) === 0,
    open_orders: finalState.openOrderCount,
    protection_cleanup_exact: protectionCleanupExact,
    recovered_at: new Date().toISOString(),
  };
}

export async function runSealedHyperliquidMainnetRoundTrip({
  body,
  recipient,
  state,
  fetchImpl = fetch,
  executeOrder = executeHyperliquidBoundInstruction,
  readSnapshot = readHyperliquidAccountSnapshot,
  reconcile = reconcileStoredExecution,
  submitEmergency = submitHyperliquidExecution,
  submitProtectionCancel = submitHyperliquidExecution,
  verifyOrder = verifyHyperliquidBoundInstruction,
  verifyVenueEvidence = verifyHyperliquidMainnetVenueEvidence,
  buildProtection = buildHyperliquidMainnetProtection,
}) {
  const opened = await openSealedBundle(body.encrypted_execution_vault, recipient, {
    aadPrefixes: HYPERLIQUID_EXECUTION_VAULT_AAD_PREFIXES,
    expectedKind: "ghola_hyperliquid_execution_vault",
  });
  const credential = hyperliquidCredentialFromVault(opened.json);
  if (credential.network !== "mainnet") throw proofError("sealed vault is not bound to Hyperliquid mainnet", 409);

  const proofWorkOrder = `hl_mainnet_investor_proof_v2_${sha256(body.vault_commitment).slice(0, 32)}`;
  const claimContext = {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "mainnet_roundtrip_proof",
    request_digest: sha256(stableJson({
      version: 1,
      vault_commitment: body.vault_commitment,
      policy_commitment: body.policy_commitment,
      market: body.market,
      notional_usd: body.notional_usd,
      slippage_bps: body.slippage_bps,
      release_binding: body.release_binding,
    })),
  };

  const prepared = await prepareRoundTrip({
    body,
    recipient,
    state,
    credential,
    fetchImpl,
    readSnapshot,
    verifyOrder,
    buildProtection,
    entryWorkOrder: `${proofWorkOrder}_entry`,
  });

  return executeClaimedPrivateSubmission({
    state,
    work_order_commitment: proofWorkOrder,
    claim_context: claimContext,
    submit: () => performRoundTrip({
      body,
      recipient,
      state,
      credential,
      proofWorkOrder,
      prepared,
      fetchImpl,
      executeOrder,
      reconcile,
      submitEmergency,
      submitProtectionCancel,
      verifyOrder,
      verifyVenueEvidence,
    }),
    evidence: async (report) => ({
      attempt: {
        status: "filled",
        entry_work_order_commitment: report.entry_work_order_commitment,
        exit_work_order_commitment: report.exit_work_order_commitment,
        final_proof: report.final_proof,
        created_at: report.completed_at,
      },
      receipt: report,
    }),
  });
}

async function prepareRoundTrip({
  body,
  recipient,
  state,
  credential,
  fetchImpl,
  readSnapshot,
  verifyOrder,
  buildProtection,
  entryWorkOrder,
}) {
  const account = await readSnapshot({ credential, accountSource: "sealed_byo", fetchImpl });
  if (account.status !== "ready_to_trade" || account.trading_enabled !== true) {
    throw proofError(`Hyperliquid account is not ready: ${account.status || "unknown"}`, 409);
  }
  const initial = await exactMarketState(fetchImpl, credential, body.market);
  if (Number(initial.positionSize) !== 0) {
    throw proofError("proof trade requires an initially flat HYPE position", 409);
  }
  if (initial.openOrderCount !== 0) {
    throw proofError("proof trade requires no open HYPE orders", 409);
  }
  const protectionPlan = await buildProtection({
    fetchImpl,
    baseUrl: credential.base_url,
    market: body.market,
  });
  const entryInstruction = marketInstruction({
    market: body.market,
    side: "buy",
    quoteSize: String(body.notional_usd),
    slippageBps: body.slippage_bps,
    reduceOnly: false,
    expiresAt: actionExpiry(),
    positionProtection: protectionPlan.position_protection,
  });
  const preflight = await verifyOrder({
    body: orderBody(body, entryWorkOrder),
    instruction: entryInstruction,
    recipient,
    state,
  });
  assertNoSubmitPreflight(preflight, entryInstruction);
  return { entryInstruction, preflight, protectionReference: protectionPlan.reference };
}

async function performRoundTrip({
  body,
  recipient,
  state,
  credential,
  proofWorkOrder,
  prepared,
  fetchImpl,
  executeOrder,
  reconcile,
  submitEmergency,
  submitProtectionCancel,
  verifyOrder,
  verifyVenueEvidence,
}) {
  const entryWorkOrder = `${proofWorkOrder}_entry`;
  const exitWorkOrder = `${proofWorkOrder}_exit`;
  let entrySubmissionStarted = false;
  let flatConfirmed = false;
  let entryProtectionConfirmed = false;
  let protectionCleanupConfirmed = false;
  let protectionCleanup = null;
  let phase = "entry_submit";
  let primaryError = null;
  let recoveryError = null;
  let report = null;
  let protectionCloids = hyperliquidProtectionCloids(
    await state.deriveHyperliquidCloid(entryWorkOrder),
  );
  try {
    const entryInstruction = prepared.entryInstruction;

    // Arm recovery before crossing the broadcast boundary. A timeout or malformed
    // receipt can still mean the venue accepted and filled the entry.
    entrySubmissionStarted = true;
    const entry = await executeOrder({
      body: orderBody(body, entryWorkOrder),
      instruction: entryInstruction,
      recipient,
      state,
    });
    assertFilled(entry, "entry", { protectionRequired: true });
    protectionCloids = assertExactProtectionCloids(entry);
    entryProtectionConfirmed = true;
    phase = "entry_replay";
    const entryReplay = await executeOrder({
      body: orderBody(body, entryWorkOrder),
      instruction: entryInstruction,
      recipient,
      state,
    });
    assertExactReplay(entry, entryReplay, "entry");

    phase = "position_observation";
    const openedPosition = await waitForMarketState(
      fetchImpl,
      credential,
      body.market,
      (snapshot) => Number(snapshot.positionSize) > 0,
      "filled HYPE position was not observed",
    );
    if (openedPosition.marginMode !== "isolated" || openedPosition.leverage !== 1) {
      throw proofError("proof position was not isolated at 1x leverage", 502);
    }
    const exitInstruction = marketInstruction({
      market: body.market,
      side: "sell",
      baseSize: openedPosition.positionSize,
      slippageBps: body.slippage_bps,
      reduceOnly: true,
      expiresAt: actionExpiry(),
    });
    phase = "exit_preflight";
    const exitPreflight = await verifyOrder({
      body: orderBody(body, exitWorkOrder),
      instruction: exitInstruction,
      recipient,
      state,
    });
    assertNoSubmitPreflight(exitPreflight, exitInstruction, { protectionRequired: false });
    phase = "exit_submit";
    const exit = await executeOrder({
      body: orderBody(body, exitWorkOrder),
      instruction: exitInstruction,
      recipient,
      state,
    });
    assertFilled(exit, "exit");
    phase = "exit_replay";
    const exitReplay = await executeOrder({
      body: orderBody(body, exitWorkOrder),
      instruction: exitInstruction,
      recipient,
      state,
    });
    assertExactReplay(exit, exitReplay, "exit");

    phase = "protection_cleanup";
    protectionCleanup = await cancelProtectionOrders({
      credential,
      market: body.market,
      state,
      submitCancel: submitProtectionCancel,
      proofWorkOrder,
      protectionCloids,
    });
    protectionCleanupConfirmed = true;

    phase = "final_flat_verification";
    const finalState = await waitForMarketState(
      fetchImpl,
      credential,
      body.market,
      (snapshot) => Number(snapshot.positionSize) === 0 && snapshot.openOrderCount === 0,
      "Hyperliquid account did not return flat",
    );
    flatConfirmed = true;
    phase = "stored_replay";
    const stored = await reconcile({
      body: { work_order_commitment: entryWorkOrder, execution_mode: "byo_api_key" },
      state,
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
    });
    assertExactReplay(entry, stored, "stored receipt");
    phase = "venue_evidence";
    const venueEvidence = await verifyVenueEvidence({
      baseUrl: credential.base_url,
      accountAddress: credential.vault_address || credential.account_address,
      market: body.market,
      entry: receiptVenueReference(entry, "entry"),
      exit: receiptVenueReference(exit, "exit"),
      protection: receiptProtectionReference(entry),
      expectedNotionalUsd: body.notional_usd,
      fetchImpl,
    });
    assertIndependentVenueEvidence(venueEvidence);
    phase = "report_assembly";
    const completedAt = new Date().toISOString();
    const walletValidUntilMs = prepared.preflight.checks.api_wallet_valid_until_ms;
    report = {
      version: 1,
      ok: true,
      status: "filled",
      network: "mainnet",
      market: body.market,
      notional_usd: body.notional_usd,
      max_slippage_bps: body.slippage_bps,
      release_binding: structuredClone(body.release_binding),
      claim_store: state.path === "postgres" ? "postgres" : "unverified",
      proof_work_order_commitment: proofWorkOrder,
      entry_work_order_commitment: entryWorkOrder,
      exit_work_order_commitment: exitWorkOrder,
      entry_status: "filled",
      preflight_verified: true,
      api_wallet_authorization_verified: true,
      api_wallet_address: prepared.preflight.checks.api_wallet_address,
      api_wallet_valid_until: new Date(walletValidUntilMs).toISOString(),
      preflight_transaction_broadcast: false,
      preflight_action_expiry_proven: true,
      entry_order_readback_proven: true,
      entry_fill_proven: true,
      entry_fill_summary: entry.fill_summary,
      entry_order_reference: venueEvidence.entry,
      duplicate_entry_prevented: true,
      opened_position_verified: true,
      venue_position_protection_proven: true,
      protection_reference: prepared.protectionReference,
      protection_acceptance: receiptProtectionAcceptance(entry),
      take_profit_oid: entry.final_proof.take_profit_oid,
      take_profit_cloid: entry.final_proof.take_profit_cloid,
      stop_loss_oid: entry.final_proof.stop_loss_oid,
      stop_loss_cloid: entry.final_proof.stop_loss_cloid,
      protection_cleanup_confirmed: true,
      protection_cleanup: protectionCleanup,
      protection_children_terminal: venueEvidence.protection_children_terminal,
      protection_children_no_fill_proven: venueEvidence.protection_children_no_fill_proven,
      default_margin_mode: openedPosition.marginMode,
      default_leverage: openedPosition.leverage,
      exit_preflight_verified: true,
      exit_preflight_transaction_broadcast: false,
      exit_preflight_action_expiry_proven: true,
      exit_status: "filled",
      exit_order_readback_proven: true,
      exit_fill_proven: true,
      exit_fill_summary: exit.fill_summary,
      exit_order_reference: venueEvidence.exit,
      duplicate_exit_prevented: true,
      stored_receipt_replayed: true,
      independent_venue_evidence_proven: true,
      venue_evidence: venueEvidence,
      venue_evidence_commitment: `sha256:${sha256(stableJson(venueEvidence))}`,
      flat_after_exit: Number(finalState.positionSize) === 0,
      open_orders_after_exit: finalState.openOrderCount,
      final_proof: {
        version: 1,
        proof_kind: "hyperliquid_mainnet_roundtrip_v1",
        broadcast_performed: true,
        final_venue_execution_proven: true,
        final_fill_proven: true,
        execution_configuration_proven: true,
        independent_venue_evidence_proven: true,
        venue_position_protection_proven: true,
        exit_preflight_proven: true,
        protection_cleanup_proven: true,
        protection_children_terminal: true,
        protection_children_no_fill_proven: true,
        margin_mode: openedPosition.marginMode,
        leverage: openedPosition.leverage,
        flat_after_exit: true,
        checked_at: completedAt,
      },
      completed_at: completedAt,
    };
  } catch (error) {
    primaryError = phaseError(phase, error);
  } finally {
    if (entrySubmissionStarted && (!flatConfirmed || !protectionCleanupConfirmed)) {
      let cancellationError = null;
      try {
        await emergencyFlatten({
          credential,
          market: body.market,
          slippageBps: body.slippage_bps,
          state,
          fetchImpl,
          submitEmergency,
          proofWorkOrder,
        });
      } catch (error) {
        // Continue: exact final state below, not the submit response, is authoritative.
        recoveryError ||= phaseError("emergency_flatten", error);
      }
      if (!protectionCleanupConfirmed) {
        try {
          protectionCleanup = await cancelProtectionOrders({
            credential,
            market: body.market,
            state,
            submitCancel: submitProtectionCancel,
            proofWorkOrder,
            protectionCloids,
          });
          protectionCleanupConfirmed = true;
        } catch (error) {
          cancellationError = error;
          recoveryError ||= phaseError("recovery_protection_cleanup", error);
        }
      }
      try {
        await waitForMarketState(
          fetchImpl,
          credential,
          body.market,
          (snapshot) => Number(snapshot.positionSize) === 0 && snapshot.openOrderCount === 0,
          "recovery did not return the Hyperliquid account flat with zero open orders",
        );
      } catch (error) {
        recoveryError ||= phaseError("recovery_final_flat_verification", error);
      }
      if (entryProtectionConfirmed && !protectionCleanupConfirmed) {
        recoveryError ||= phaseError(
          "recovery_protection_cleanup",
          cancellationError || proofError("protection cleanup is unconfirmed", 502),
        );
      }
    }
  }
  if (primaryError) {
    if (recoveryError) {
      primaryError.message = `${primaryError.message}; recovery also reported: ${recoveryError.message}`;
    }
    throw primaryError;
  }
  if (recoveryError) throw recoveryError;
  if (!report) throw proofError("Hyperliquid mainnet round trip produced no report", 502);
  return report;
}

function orderBody(body, workOrderCommitment) {
  const proofPolicyCommitment = `hl_mainnet_investor_proof_v2_policy_${sha256(stableJson({
    vault_policy_commitment: body.policy_commitment,
    vault_commitment: body.vault_commitment,
    proof_kind: "hl_mainnet_investor_proof_v2",
    notional_usd: 11,
    slippage_bps: 100,
  })).slice(0, 40)}`;
  return {
    version: 1,
    execution_mode: "byo_api_key",
    account_commitment: body.account_commitment,
    vault_commitment: body.vault_commitment,
    policy_commitment: body.policy_commitment,
    encrypted_execution_vault: body.encrypted_execution_vault,
    work_order_commitment: workOrderCommitment,
    operation_class: "limit_order",
    session_policy: {
      // Keep the external vault policy binding above unchanged, while isolating
      // this explicitly re-authorized v2 proof from a consumed v1 order quota.
      policy_commitment: proofPolicyCommitment,
      market_allowlist: [body.market],
      max_notional_bucket: "25",
      max_daily_notional_bucket: "25",
      max_order_count: 1,
      execution_network: "mainnet",
      kill_switch: false,
    },
  };
}

function marketInstruction({
  market,
  side,
  quoteSize,
  baseSize,
  slippageBps,
  reduceOnly,
  expiresAt,
  positionProtection = null,
}) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    expires_at: expiresAt,
    ...(positionProtection ? { position_protection: positionProtection } : {}),
    order: {
      market,
      side,
      ...(quoteSize ? { quote_size: quoteSize, size_mode: "quote" } : {}),
      ...(baseSize ? { base_size: baseSize, size_mode: "base" } : {}),
      order_type: "market",
      tif: "Ioc",
      post_only: false,
      reduce_only: reduceOnly,
      max_slippage_bps: String(slippageBps),
      live_order_mode: "tiny_fill",
      margin_mode: "isolated",
      leverage: 1,
    },
  };
}

async function exactMarketState(fetchImpl, credential, market) {
  const [state, orders] = await Promise.all([
    info(fetchImpl, credential, { type: "clearinghouseState", user: credential.account_address }),
    info(fetchImpl, credential, { type: "openOrders", user: credential.account_address }),
  ]);
  if (!Array.isArray(state?.assetPositions) || !Array.isArray(orders)) {
    throw proofError("Hyperliquid account state is invalid", 502);
  }
  const position = state.assetPositions.find((row) => row?.position?.coin === market)?.position;
  const positionSize = String(position?.szi ?? "0");
  const marginMode = typeof position?.leverage?.type === "string"
    ? position.leverage.type.toLowerCase()
    : null;
  const leverage = Number(position?.leverage?.value);
  if (!Number.isFinite(Number(positionSize))) throw proofError("Hyperliquid position size is invalid", 502);
  return {
    positionSize,
    marginMode,
    leverage: Number.isFinite(leverage) ? leverage : null,
    openOrderCount: orders.filter((order) => order?.coin === market).length,
  };
}

async function info(fetchImpl, credential, payload) {
  const response = await fetchImpl(`${credential.base_url}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw proofError("Hyperliquid account state request failed", 502);
  return response.json();
}

async function waitForMarketState(fetchImpl, credential, market, predicate, message, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : 30;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await exactMarketState(fetchImpl, credential, market);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw proofError(message, 502);
}

async function emergencyFlatten({
  credential,
  market,
  slippageBps,
  state,
  fetchImpl,
  submitEmergency,
  proofWorkOrder,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await exactMarketState(fetchImpl, credential, market);
    const size = Number(current.positionSize);
    if (!Number.isFinite(size) || size === 0) return;
    const absoluteSize = current.positionSize.startsWith("-")
      ? current.positionSize.slice(1)
      : current.positionSize;
    try {
      await submitEmergency({
        credential,
        instruction: marketInstruction({
          market,
          side: size > 0 ? "sell" : "buy",
          baseSize: absoluteSize,
          slippageBps,
          reduceOnly: true,
          expiresAt: actionExpiry(),
        }),
        cloid: await state.deriveHyperliquidCloid(
          `${proofWorkOrder}_emergency_flatten_${attempt}`,
        ),
      });
    } catch (error) {
      lastError = error;
    }
    try {
      await waitForMarketState(
        fetchImpl,
        credential,
        market,
        (snapshot) => Number(snapshot.positionSize) === 0,
        "emergency flatten did not return the Hyperliquid account flat",
        { attempts: 6 },
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw proofError(
    `emergency flatten failed after 3 reduce-only attempts${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
    502,
  );
}

async function cancelProtectionOrders({
  credential,
  market,
  state,
  submitCancel,
  proofWorkOrder,
  protectionCloids,
}) {
  const targets = [
    ["take_profit", protectionCloids.take_profit_cloid],
    ["stop_loss", protectionCloids.stop_loss_cloid],
  ];
  const evidence = {};
  const failures = [];
  for (const [kind, targetCloid] of targets) {
    try {
      const receipt = await submitCancel({
        credential,
        instruction: cancelInstruction(market, targetCloid),
        cloid: await state.deriveHyperliquidCloid(`${proofWorkOrder}_cleanup_${kind}`),
      });
      assertProtectionCancelled(receipt, targetCloid, kind);
      evidence[kind] = {
        oid: String(receipt.final_proof.venue_order_oid),
        cloid: targetCloid,
        terminal_status: "canceled",
        cancellation_readback_proven: true,
        final_cancellation_proven: true,
        broadcast_performed: receipt.final_proof.broadcast_performed === true,
        already_terminal: receipt.final_proof.final_no_broadcast_proven === true,
        action_expiry_proven: true,
      };
    } catch (error) {
      failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw proofError(`Hyperliquid protection cleanup failed (${failures.join("; ")})`, 502);
  }
  return evidence;
}

function cancelInstruction(market, clientOrderId) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "cancel",
    expires_at: actionExpiry(),
    cancel: { market, client_order_id: clientOrderId },
  };
}

function assertProtectionCancelled(receipt, expectedCloid, kind) {
  if (receipt?.status !== "cancelled" ||
      receipt?.final_proof?.final_venue_execution_proven !== true ||
      receipt?.final_proof?.cancellation_readback_proven !== true ||
      receipt?.final_proof?.cancellation_terminal_status !== "canceled" ||
      String(receipt?.final_proof?.venue_order_cloid || "").toLowerCase() !== expectedCloid ||
      !/^\d+$/u.test(String(receipt?.final_proof?.venue_order_oid || "")) ||
      receipt?.final_proof?.action_expiry_proven !== true ||
      (receipt?.final_proof?.broadcast_performed !== true &&
        receipt?.final_proof?.final_no_broadcast_proven !== true)) {
    throw proofError(`${kind} protection cancellation lacks terminal venue proof`, 502);
  }
}

function assertFilled(receipt, phase, { protectionRequired = false } = {}) {
  if (receipt?.status !== "filled" ||
      receipt?.final_proof?.broadcast_performed !== true ||
      receipt?.final_proof?.final_venue_execution_proven !== true ||
      receipt?.final_proof?.final_fill_proven !== true ||
      receipt?.final_proof?.venue_order_readback_proven !== true ||
      receipt?.final_proof?.venue_order_status !== "filled" ||
      !/^\d+$/u.test(String(receipt?.final_proof?.venue_order_oid || "")) ||
      !/^0x[0-9a-f]{32}$/u.test(String(receipt?.final_proof?.venue_order_cloid || "").toLowerCase()) ||
      receipt?.final_proof?.execution_configuration_proven !== true ||
      receipt?.final_proof?.margin_mode !== "isolated" ||
      receipt?.final_proof?.leverage !== 1 ||
      receipt?.final_proof?.market_data_freshness_proven !== true ||
      receipt?.final_proof?.market_slippage_bound_proven !== true ||
      receipt?.final_proof?.action_expiry_proven !== true ||
      (protectionRequired && (
        receipt?.final_proof?.position_protection_proven !== true ||
        !/^\d+$/u.test(String(receipt?.final_proof?.take_profit_oid || "")) ||
        !/^\d+$/u.test(String(receipt?.final_proof?.stop_loss_oid || "")) ||
        !/^0x[0-9a-f]{32}$/u.test(String(receipt?.final_proof?.take_profit_cloid || "").toLowerCase()) ||
        !/^0x[0-9a-f]{32}$/u.test(String(receipt?.final_proof?.stop_loss_cloid || "").toLowerCase())
      ))) {
    throw proofError(`${phase} lacks final Hyperliquid fill proof`, 502);
  }
}

function assertExactProtectionCloids(receipt) {
  const expected = hyperliquidProtectionCloids(receipt.final_proof.venue_order_cloid);
  if (receipt.final_proof.take_profit_cloid !== expected.take_profit_cloid ||
      receipt.final_proof.stop_loss_cloid !== expected.stop_loss_cloid) {
    throw proofError("entry protection order identities are not deterministic", 502);
  }
  return expected;
}

function assertNoSubmitPreflight(result, instruction, { protectionRequired = true } = {}) {
  const checks = result?.checks;
  const instructionExpiryMs = Date.parse(String(instruction?.expires_at || ""));
  if (result?.status !== "verified_no_funds" ||
      checks?.authority_derived !== true ||
      checks?.api_wallet_authorized !== true ||
      checks?.api_wallet_not_expired !== true ||
      !/^0x[0-9a-f]{40}$/u.test(String(checks?.api_wallet_address || "").toLowerCase()) ||
      !Number.isInteger(checks?.api_wallet_valid_until_ms) ||
      checks.api_wallet_valid_until_ms <= Date.now() + 5 * 60_000 ||
      checks?.hyperliquid_sdk_ready !== true ||
      checks?.hyperliquid_api_reachable !== true ||
      checks?.account_read_checked !== true ||
      checks?.order_request_built !== true ||
      checks?.position_protection_checked !== protectionRequired ||
      checks?.action_expiry_checked !== true ||
      !Number.isInteger(checks?.expires_after_ms) ||
      !Number.isInteger(instructionExpiryMs) ||
      checks.expires_after_ms !== instructionExpiryMs ||
      checks.expires_after_ms <= Date.now() ||
      checks.expires_after_ms > Date.now() + 5 * 60_000 ||
      checks?.transaction_broadcast !== false ||
      checks?.verification_simulated === true) {
    throw proofError("Hyperliquid mainnet no-submit preflight is incomplete", 409);
  }
}

function actionExpiry(now = Date.now()) {
  return new Date(now + 90_000).toISOString();
}

function receiptVenueReference(receipt, phase) {
  assertFilled(receipt, phase);
  const summary = receipt.fill_summary;
  if (summary?.fill_count < 1 || Number(summary?.filled_base_size) <= 0 ||
      !Number.isFinite(Number(summary?.average_fill_price)) || Number(summary.average_fill_price) <= 0) {
    throw proofError(`${phase} fill summary is incomplete`, 502);
  }
  return {
    oid: String(receipt.final_proof.venue_order_oid),
    cloid: String(receipt.final_proof.venue_order_cloid).toLowerCase(),
    filled_base_size: String(summary.filled_base_size),
    average_fill_price: Number(summary.average_fill_price),
  };
}

function receiptProtectionReference(receipt) {
  assertFilled(receipt, "entry", { protectionRequired: true });
  return {
    take_profit: {
      oid: String(receipt.final_proof.take_profit_oid),
      cloid: String(receipt.final_proof.take_profit_cloid).toLowerCase(),
    },
    stop_loss: {
      oid: String(receipt.final_proof.stop_loss_oid),
      cloid: String(receipt.final_proof.stop_loss_cloid).toLowerCase(),
    },
  };
}

function receiptProtectionAcceptance(receipt) {
  const reference = receiptProtectionReference(receipt);
  return Object.fromEntries(Object.entries(reference).map(([kind, leg]) => [kind, {
    ...leg,
    venue_accepted: true,
    venue_order_readback_proven: true,
  }]));
}

function independentProtectionLegProven(value) {
  return /^\d+$/u.test(String(value?.oid || "")) &&
    /^0x[0-9a-f]{32}$/u.test(String(value?.cloid || "").toLowerCase()) &&
    value?.order_status === "canceled" &&
    value?.venue_accepted === true &&
    value?.venue_order_readback_proven === true &&
    value?.final_cancellation_proven === true &&
    value?.final_no_fill_proven === true &&
    value?.fill_count === 0 &&
    String(value?.filled_base_size) === "0" &&
    value?.reduce_only === true &&
    value?.trigger_order === true;
}

function assertIndependentVenueEvidence(value) {
  if (value?.proof_kind !== "hyperliquid_mainnet_public_venue_evidence_v1" ||
      value?.independently_queried !== true ||
      value?.entry_exit_sizes_match !== true ||
      value?.entry_before_exit !== true ||
      value?.reduce_only_exit_proven !== true ||
      value?.position_protection_proven !== true ||
      value?.protection_children_terminal !== true ||
      value?.protection_children_no_fill_proven !== true ||
      !independentProtectionLegProven(value?.protection?.take_profit) ||
      !independentProtectionLegProven(value?.protection?.stop_loss) ||
      value?.transaction_hashes_distinct !== true ||
      value?.flat_after_exit !== true ||
      value?.open_orders_after_exit !== 0 ||
      !Array.isArray(value?.entry?.transaction_hashes) || value.entry.transaction_hashes.length < 1 ||
      !Array.isArray(value?.exit?.transaction_hashes) || value.exit.transaction_hashes.length < 1) {
    throw proofError("independent Hyperliquid venue evidence is incomplete", 502);
  }
}

function assertExactReplay(expected, actual, phase) {
  if (stableJson(expected) !== stableJson(actual)) {
    throw proofError(`${phase} did not replay the exact durable receipt`, 502);
  }
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function phaseError(phase, error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number.isInteger(error?.status) ? error.status : 502;
  return proofError(`Hyperliquid mainnet round trip failed during ${phase}: ${message}`, status);
}

function proofError(message, status) {
  return Object.assign(new Error(message), { status });
}
