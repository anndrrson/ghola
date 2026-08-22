import { randomUUID } from "node:crypto";
import { openSealedBundle } from "../crypto/envelope.js";
import { KrakenSpotAdapter } from "./adapter.js";
import { deterministicClientOrderId, krakenCommitment } from "./commitment.js";
import { compileAllocationPlan } from "./compiler.js";
import {
  enforceJurisdiction,
  enforceMandateForCompilation,
} from "./policy.js";
import { createReceiptSigner } from "./receipt.js";
import { createKrakenV2State } from "./state.js";
import {
  credentialVaultSchema,
  parseAllocationIntent,
  parseConnection,
  parseMandate,
} from "./types.js";

export function createKrakenV2Service({
  env = process.env,
  state,
  recipient,
  adapterFactory,
  now = () => new Date(),
  receiptSigner,
} = {}) {
  const repository = createKrakenV2State(env, { state });
  const signer = receiptSigner || createReceiptSigner({
    privateKeyBase64: env.PRIVATE_AGENT_KRAKEN_RECEIPT_SIGNING_KEY,
    allowEphemeral: env.NODE_ENV === "test" || env.PRIVATE_AGENT_KRAKEN_V2_LIVE_SUBMIT !== "true",
  });
  const clientOrderSecret = env.PRIVATE_AGENT_KRAKEN_CLIENT_ORDER_SECRET ||
    (env.NODE_ENV === "test" ? "test-only-kraken-client-order-secret" : "");
  const liveSubmit = env.PRIVATE_AGENT_KRAKEN_V2_LIVE_SUBMIT === "true";
  const jurisdictionSecret = env.PRIVATE_AGENT_KRAKEN_JURISDICTION_SECRET ||
    env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET ||
    "";
  if (liveSubmit && clientOrderSecret.length < 32) {
    throw new Error("PRIVATE_AGENT_KRAKEN_CLIENT_ORDER_SECRET must be set for live execution");
  }
  if (liveSubmit && jurisdictionSecret.length < 32) {
    throw new Error("PRIVATE_AGENT_KRAKEN_JURISDICTION_SECRET must be set for live execution");
  }

  async function adapterFor(connection) {
    const opened = await openSealedBundle(
      connection.encrypted_execution_vault,
      recipient,
      {
        expectedKind: "ghola_kraken_spot_execution_vault",
        aadPrefix: "ghola/kraken-spot-execution-vault-v1|",
      },
    );
    const credential = credentialVaultSchema.parse(opened.json);
    return adapterFactory
      ? adapterFactory({ credential, connection })
      : new KrakenSpotAdapter({ credential, now });
  }

  async function link(raw) {
    const connection = parseConnection(raw);
    enforceJurisdiction(connection.jurisdiction, now(), jurisdictionSecret);
    const adapter = await adapterFor(connection);
    const [permissions, catalog] = await Promise.all([
      adapter.verifyPermissions(),
      adapter.listInstruments({ refresh: true }),
    ]);
    if (catalog.instruments.length === 0) {
      const error = new Error("Kraken returned no reliably identified API-tradable xStocks");
      error.code = "xstocks_catalog_empty";
      error.status = 409;
      throw error;
    }
    const stored = await repository.putConnection({
      ...connection,
      status: "active",
      status_reason: null,
      permission_evidence: permissions,
      catalog_commitment: catalog.catalog_commitment,
      instrument_count: catalog.instruments.length,
    });
    return publicConnection(stored);
  }

  async function authorizeMandate(raw) {
    const mandate = parseMandate(raw, now());
    const connection = await requireConnection(mandate.connection_id);
    assertOwner(connection, mandate);
    enforceJurisdiction(connection.jurisdiction, now(), jurisdictionSecret);
    await repository.putMandate(mandate);
    return mandate;
  }

  async function acceptIntent(raw, { execute = true } = {}) {
    const mandate = await requireMandate(raw.connection_id);
    const { execute: _execute, venue_id: _venue, ...intentBody } = raw;
    const intent = parseAllocationIntent(intentBody, mandate, now());
    const stored = await repository.putIntent(intent);
    const result = { accepted: true, duplicate: stored.duplicate, intent: stored.intent };
    if (execute && !stored.duplicate) result.rebalance = await rebalance(intent.connection_id, "intent");
    return result;
  }

  async function rebalance(connectionId, trigger = "manual", claims = null) {
    const lease = await repository.claimLease(connectionId);
    if (!lease) {
      const error = new Error("a rebalance is already running");
      error.code = "rebalance_in_progress";
      error.status = 409;
      throw error;
    }
    const runId = randomUUID();
    let run;
    try {
      const connection = await requireConnection(connectionId);
      if (claims) assertOwner(connection, claims);
      const mandate = await requireMandate(connectionId);
      assertExecutable(connection, mandate);
      enforceJurisdiction(connection.jurisdiction, now(), jurisdictionSecret);
      const adapter = await adapterFor(connection);
      const snapshot = await adapter.readAccount();
      await repository.putSnapshot(connectionId, snapshot);
      await pauseOnExternalActivity(connection, snapshot, repository);
      const intents = await repository.listIntents(connectionId);
      const compilation = compileAllocationPlan({ mandate, intents, snapshot, now: now() });
      const policy = enforceMandateForCompilation({
        mandate,
        compilation,
        dailyTurnoverUsd: await repository.dailyTurnoverUsd(connectionId, now()),
      });
      run = await repository.createRun({
        version: 1,
        run_id: runId,
        connection_id: connectionId,
        trigger,
        status: compilation.status,
        compilation,
        policy,
        child_orders: [],
        created_at: now().toISOString(),
      });
      if (compilation.status !== "executable" || policy.executable_deltas.length === 0) {
        return finishRun(run, compilation.status === "blocked" ? "blocked" : "no_op");
      }

      const children = [];
      for (const [index, delta] of policy.executable_deltas.entries()) {
        const clientOrderId = deterministicClientOrderId(
          clientOrderSecret,
          compilation.compilation_commitment,
          index,
        );
        const existing = (await repository.listChildOrders(connectionId))
          .find((item) => item.client_order_id === clientOrderId);
        if (existing) {
          children.push(existing);
          if (!isTerminal(existing.status)) break;
          continue;
        }
        const child = {
          version: 1,
          connection_id: connectionId,
          run_id: runId,
          client_order_id: clientOrderId,
          canonical_instrument_id: delta.canonical_instrument_id,
          side: delta.side,
          notional_usd: delta.child_order_notional_usd,
          status: "planned",
          created_at: now().toISOString(),
        };
        await repository.putChildOrder(child);
        const quote = await adapter.quote({
          canonical_instrument_id: child.canonical_instrument_id,
          side: child.side,
          notional_usd: child.notional_usd,
        });
        if (quote.price_impact_bps > mandate.limits.max_slippage_bps) {
          child.status = "policy_rejected";
          child.reason = "quote_price_impact_exceeded";
          await repository.putChildOrder(child);
          children.push(child);
          break;
        }
        const prepared = await adapter.prepare({
          child_order: { ...child, max_quote_age_ms: mandate.limits.max_quote_age_ms },
          quote,
          max_slippage_bps: mandate.limits.max_slippage_bps,
          client_order_id: clientOrderId,
        });
        child.quote_commitment = quote.quote_commitment;
        child.request_commitment = prepared.request_commitment;
        child.status = "prepared";
        await repository.putChildOrder(child);
        const acknowledgement = await adapter.submit(prepared, { validateOnly: !liveSubmit });
        Object.assign(child, {
          status: acknowledgement.status,
          transaction_ids: acknowledgement.transaction_ids,
          acknowledgement_commitment: acknowledgement.acknowledgement_commitment,
        });
        await repository.putChildOrder(child);
        if (liveSubmit && ["acknowledged", "unknown"].includes(child.status)) {
          const reconciliation = await adapter.reconcile({
            client_order_id: clientOrderId,
            transaction_ids: child.transaction_ids,
          });
          Object.assign(child, {
            status: reconciliation.status,
            reconciliation_commitment: reconciliation.reconciliation_commitment,
            fills: reconciliation.fills,
          });
          await repository.putChildOrder(child);
        }
        children.push(structuredClone(child));
        if (!isTerminal(child.status)) break;
      }
      run = await repository.updateRun(runId, { child_orders: children });
      const status = children.some((item) => !isTerminal(item.status))
        ? "reconciliation_required"
        : liveSubmit ? "completed" : "validated";
      return finishRun(run, status);
    } catch (error) {
      if (run) await repository.updateRun(runId, {
        status: "failed",
        error_code: error.code || "execution_failed",
      });
      throw error;
    } finally {
      await repository.releaseLease(connectionId, lease.token);
    }
  }

  async function finishRun(current, status) {
    const completed = await repository.updateRun(current.run_id, {
      status,
      completed_at: now().toISOString(),
    });
    const receipt = signer.issue({
      connection_id: completed.connection_id,
      run_id: completed.run_id,
      status,
      trigger: completed.trigger,
      compiler_version: completed.compilation.compiler_version,
      compilation_commitment: completed.compilation.compilation_commitment,
      snapshot_commitment: completed.compilation.snapshot_commitment,
      policy_commitment: krakenCommitment("policy_decision", completed.policy),
      child_orders: completed.child_orders.map((item) => ({
        client_order_id: item.client_order_id,
        canonical_instrument_id: item.canonical_instrument_id,
        side: item.side,
        notional_usd: item.notional_usd,
        status: item.status,
        transaction_ids: item.transaction_ids || [],
        request_commitment: item.request_commitment || null,
        acknowledgement_commitment: item.acknowledgement_commitment || null,
        reconciliation_commitment: item.reconciliation_commitment || null,
      })),
    }, now());
    await repository.putReceipt(receipt);
    return { run: completed, receipt };
  }

  async function control({
    connection_id: connectionId,
    owner_commitment,
    account_commitment,
    action,
    reason,
  }) {
    if (!["pause", "resume", "kill"].includes(action)) {
      throw Object.assign(new Error("invalid control action"), { status: 400, code: "invalid_action" });
    }
    const connection = await requireConnection(connectionId);
    assertOwner(connection, { owner_commitment, account_commitment });
    if (connection.status === "killed" && action !== "kill") {
      throw Object.assign(new Error("a killed connection cannot be resumed"), {
        status: 409,
        code: "connection_killed",
      });
    }
    const status = action === "resume" ? "active" : action === "kill" ? "killed" : "paused";
    return publicConnection(await repository.setConnectionStatus(connectionId, status, reason || action));
  }

  async function status(connectionId, claims = null) {
    const connection = await requireConnection(connectionId);
    if (claims) assertOwner(connection, claims);
    return {
      connection: publicConnection(connection),
      mandate: await repository.getMandate(connectionId),
      snapshot: await repository.getSnapshot(connectionId),
      child_orders: await repository.listChildOrders(connectionId),
      receipts: await repository.listReceipts(connectionId),
      receipt_signing_public_key: signer.publicKeyBase64,
      live_submit_enabled: liveSubmit,
    };
  }

  function startHeartbeat(intervalMs = 60_000) {
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) return;
      const connections = await repository.listActiveConnections().catch(() => []);
      for (const connection of connections) {
        await rebalance(connection.connection_id, "heartbeat").catch(() => {});
      }
    }, intervalMs);
    timer.unref?.();
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  async function requireConnection(id) {
    const connection = await repository.getConnection(id);
    if (!connection) throw notFound("connection");
    return connection;
  }

  async function requireMandate(id) {
    const mandate = await repository.getMandate(id);
    if (!mandate) throw notFound("mandate");
    return mandate;
  }

  return {
    link,
    authorizeMandate,
    acceptIntent,
    rebalance,
    control,
    status,
    startHeartbeat,
    repository,
  };
}

function assertOwner(connection, value) {
  if (
    connection.owner_commitment !== value.owner_commitment ||
    connection.account_commitment !== value.account_commitment
  ) {
    throw Object.assign(new Error("connection owner mismatch"), { status: 403, code: "owner_mismatch" });
  }
}

function assertExecutable(connection, mandate) {
  if (connection.status !== "active") {
    throw Object.assign(new Error("Kraken connection is not active"), {
      status: 403,
      code: `connection_${connection.status}`,
    });
  }
  if (mandate.status !== "active") {
    throw Object.assign(new Error("Kraken mandate is not active"), {
      status: 403,
      code: `mandate_${mandate.status}`,
    });
  }
}

async function pauseOnExternalActivity(connection, snapshot, repository) {
  const knownChildren = await repository.listChildOrders(connection.connection_id);
  const knownTransactionIds = new Set(knownChildren.flatMap((item) => item.transaction_ids || []));
  const linkedAt = Date.parse(connection.linked_at || 0);
  const externalOpenOrder = (snapshot.open_orders_list || []).some((order) =>
    !String(order.client_order_id || "").startsWith("ghk-")
  );
  const externalFill = (snapshot.recent_fills || []).some((fill) => {
    const executedAt = Date.parse(fill.executed_at || 0);
    if (!Number.isFinite(executedAt) || executedAt < linkedAt) return false;
    if (String(fill.client_order_id || "").startsWith("ghk-")) return false;
    return !knownTransactionIds.has(fill.order_transaction_id);
  });
  if (!externalOpenOrder && !externalFill) return;
  await repository.setConnectionStatus(
    connection.connection_id,
    "paused",
    "external_activity_detected",
  );
  const error = new Error("external Kraken activity detected; connection paused");
  error.status = 409;
  error.code = "external_activity_detected";
  throw error;
}

function publicConnection(connection) {
  const { encrypted_execution_vault: _vault, ...safe } = connection;
  return safe;
}

function isTerminal(status) {
  return [
    "validated", "filled", "cancelled", "expired", "rejected", "no_fill",
    "not_found", "policy_rejected",
  ].includes(status);
}

function notFound(name) {
  return Object.assign(new Error(`${name} not found`), { status: 404, code: `${name}_not_found` });
}
