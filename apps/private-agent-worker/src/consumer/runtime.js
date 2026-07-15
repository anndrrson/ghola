import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { Connection } from "@solana/web3.js";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_RECONCILIATION_DEADLINE_MS = 60_000;

export function consumerFeeMicroUsdc(filledNotionalMicroUsdc) {
  const filled = safeInteger(filledNotionalMicroUsdc);
  if (filled <= 0) return 0;
  return Math.max(50_000, Math.ceil(filled * 10 / 10_000));
}

export function verifyVercelSpendWebhookSignature({ body, signature, secret }) {
  if (!secret || secret.length < 32 || !signature) return false;
  const expected = createHmac("sha1", secret).update(String(body)).digest("hex");
  const left = Buffer.from(expected);
  const right = Buffer.from(String(signature).trim().toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createConsumerRuntime(options = {}) {
  const databaseUrl = options.databaseUrl || consumerDatabaseUrl();
  const sql = options.sql || (databaseUrl ? neon(databaseUrl) : null);
  const fetchImpl = options.fetchImpl || fetch;
  const connection = options.connection || (consumerSolanaRpcUrl() ? new Connection(consumerSolanaRpcUrl(), "finalized") : null);
  const now = options.now || (() => new Date());
  let schemaReady = false;
  let timer = null;
  let running = false;

  async function ensureSchema() {
    if (!sql) return false;
    if (schemaReady) return true;
    await sql`
      CREATE TABLE IF NOT EXISTS consumer_worker_reconciliation_jobs (
        venue_order_id TEXT PRIMARY KEY,
        work_order_commitment TEXT NOT NULL UNIQUE,
        reservation_id TEXT NOT NULL,
        transaction_signature TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        deadline_at TIMESTAMPTZ NOT NULL,
        next_attempt_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS consumer_circuit_state (
        circuit_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reasons JSONB NOT NULL,
        halted_at TIMESTAMPTZ,
        resumed_at TIMESTAMPTZ,
        acknowledged_by TEXT,
        consecutive_green_canaries INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_consumer_worker_reconciliation_due ON consumer_worker_reconciliation_jobs (status, next_attempt_at)`;
    schemaReady = true;
    return true;
  }

  async function ready() {
    if (!sql) return { ready: false, error: "consumer_database_unconfigured" };
    try {
      await ensureSchema();
      const required = await sql`
        SELECT
          to_regclass('public.consumer_venue_orders') IS NOT NULL AS orders,
          to_regclass('public.consumer_balance_reservations') IS NOT NULL AS reservations,
          to_regclass('public.consumer_balance_accounts') IS NOT NULL AS balances,
          to_regclass('public.consumer_withdrawals') IS NOT NULL AS withdrawals,
          to_regclass('public.consumer_wallet_bindings') IS NOT NULL AS wallets,
          to_regclass('public.consumer_circuit_state') IS NOT NULL AS circuit
      `;
      const row = required[0] || {};
      const missing = Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key);
      const withdrawalDispatchConfigured = Boolean(
        stringValue(process.env.PRIVATE_AGENT_CONSUMER_WITHDRAWAL_DISPATCH_URL) &&
        stringValue(process.env.PRIVATE_AGENT_CONSUMER_WITHDRAWAL_DISPATCH_TOKEN).length >= 32 &&
        connection && stringValue(process.env.PRIVATE_AGENT_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT || process.env.GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT)
      );
      return {
        ready: missing.length === 0 && withdrawalDispatchConfigured,
        missing: [...missing, ...(withdrawalDispatchConfigured ? [] : ["withdrawal_dispatch_or_verifier"])],
        reconciliation_loop: "durable",
        withdrawal_loop: withdrawalDispatchConfigured ? "durable" : "blocked",
      };
    } catch (error) {
      return { ready: false, error: safeError(error) };
    }
  }

  async function prepareReconciliation(input) {
    await requireReady();
    const context = input.context || {};
    const venueOrderId = stringValue(context.venue_order_id);
    const reservationId = stringValue(context.reservation_id);
    const workOrderCommitment = stringValue(input.work_order_commitment);
    if (!venueOrderId || !reservationId || !workOrderCommitment) {
      throw codeError("consumer_reconciliation_context_invalid");
    }
    const createdAt = now();
    const deadlineMs = Math.max(5_000, Math.min(300_000, safeInteger(context.deadline_ms) || DEFAULT_RECONCILIATION_DEADLINE_MS));
    await sql`
      INSERT INTO consumer_worker_reconciliation_jobs (
        venue_order_id, work_order_commitment, reservation_id, transaction_signature,
        status, deadline_at, next_attempt_at, created_at, updated_at
      ) VALUES (
        ${venueOrderId}, ${workOrderCommitment}, ${reservationId}, ${`pending:${workOrderCommitment}`},
        'prepared', ${new Date(createdAt.getTime() + deadlineMs).toISOString()}, ${createdAt.toISOString()},
        ${createdAt.toISOString()}, ${createdAt.toISOString()}
      ) ON CONFLICT (venue_order_id) DO NOTHING
    `;
    return { venue_order_id: venueOrderId, status: "prepared" };
  }

  async function enqueueReconciliation(input) {
    await prepareReconciliation(input);
    const workOrderCommitment = stringValue(input.work_order_commitment);
    const transactionSignature = stringValue(input.transaction_signature);
    if (!transactionSignature) throw codeError("consumer_reconciliation_signature_missing");
    const rows = await sql`
      UPDATE consumer_worker_reconciliation_jobs
      SET transaction_signature=${transactionSignature}, status='awaiting_evidence', updated_at=${now().toISOString()}
      WHERE work_order_commitment=${workOrderCommitment} AND status IN ('prepared','awaiting_evidence')
      RETURNING venue_order_id
    `;
    if (!rows[0]) throw codeError("consumer_reconciliation_job_missing");
    return { venue_order_id: rows[0].venue_order_id, status: "awaiting_evidence" };
  }

  async function reconcile(input) {
    await requireReady();
    const venueOrderId = stringValue(input.venue_order_id);
    const fillReference = stringValue(input.venue_fill_reference);
    const finalStatus = stringValue(input.final_status);
    const filled = nonnegativeInteger(input.filled_notional_micro_usdc);
    const venueCost = nonnegativeInteger(input.venue_cost_micro_usdc);
    if (!venueOrderId || !fillReference || filled === null || venueCost === null || !["filled", "partially_filled", "unfilled", "failed"].includes(finalStatus)) {
      throw codeError("consumer_reconciliation_evidence_invalid");
    }
    if ((finalStatus === "filled" || finalStatus === "partially_filled") !== (filled > 0)) {
      throw codeError("consumer_reconciliation_fill_status_invalid");
    }
    const gholaFee = consumerFeeMicroUsdc(filled);
    const total = filled + venueCost + gholaFee;
    const reconciledAt = now().toISOString();
    const fillCommitment = commitment("venue_fill_reference", fillReference);
    const fillId = commitment("venue_fill", { order: venueOrderId, reference: fillCommitment });
    const checkpointId = commitment("reconciliation", venueOrderId);
    const transactionId = commitment("ledger", { order: venueOrderId, action: "settle" });
    const rows = await sql`
      WITH lock_guard AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${venueOrderId}, 0))
      ), target AS (
        SELECT o.*, r.reserved_micro_usdc
        FROM consumer_venue_orders o
        JOIN consumer_balance_reservations r USING (reservation_id), lock_guard
        WHERE o.venue_order_id = ${venueOrderId}
          AND o.reconciled_at IS NULL AND r.status = 'submitted'
          AND r.reserved_micro_usdc >= ${total}
        FOR UPDATE OF o, r
      ), reservation AS (
        UPDATE consumer_balance_reservations r SET status = 'settled', updated_at = ${reconciledAt}
        FROM target t WHERE r.reservation_id = t.reservation_id RETURNING r.*
      ), balance AS (
        UPDATE consumer_balance_accounts b
        SET available_micro_usdc = b.available_micro_usdc + (r.reserved_micro_usdc - ${total}),
            reserved_micro_usdc = b.reserved_micro_usdc - r.reserved_micro_usdc,
            open_notional_micro_usdc = b.open_notional_micro_usdc + ${filled}, updated_at = ${reconciledAt}
        FROM reservation r
        WHERE b.account_commitment = r.account_commitment AND b.reserved_micro_usdc >= r.reserved_micro_usdc
        RETURNING b.account_commitment
      ), updated_order AS (
        UPDATE consumer_venue_orders o SET status = ${finalStatus}, reconciled_at = ${reconciledAt}
        FROM target t WHERE o.venue_order_id = t.venue_order_id RETURNING o.*
      ), fill AS (
        INSERT INTO consumer_venue_fills (
          venue_fill_id, venue_order_id, venue_fill_reference_commitment, filled_notional_micro_usdc,
          venue_cost_micro_usdc, ghola_fee_micro_usdc, filled_at
        ) SELECT ${fillId}, ${venueOrderId}, ${fillCommitment}, ${filled}, ${venueCost}, ${gholaFee}, ${reconciledAt}
        WHERE ${filled} > 0 RETURNING venue_fill_id
      ), checkpoint AS (
        INSERT INTO consumer_reconciliation_checkpoints (
          checkpoint_id, venue_order_id, reservation_id, status, drift_micro_usdc, reconciled_at
        ) SELECT ${checkpointId}, o.venue_order_id, o.reservation_id, 'reconciled', 0, ${reconciledAt}
        FROM updated_order o RETURNING checkpoint_id
      ), ledger AS (
        INSERT INTO consumer_ledger_transactions (
          transaction_id, owner_commitment, account_commitment, idempotency_key, kind,
          reference_commitment, postings, created_at
        ) SELECT ${transactionId}, r.owner_commitment, r.account_commitment, ${`settle:${venueOrderId}`},
          'fill_settlement', ${venueOrderId},
          jsonb_path_query_array(jsonb_build_array(
              jsonb_build_object('account','consumer_reserved','side','debit','amount_micro_usdc',r.reserved_micro_usdc),
              CASE WHEN r.reserved_micro_usdc - ${total} > 0 THEN jsonb_build_object('account','consumer_available','side','credit','amount_micro_usdc',r.reserved_micro_usdc - ${total}) END,
              CASE WHEN ${filled + venueCost} > 0 THEN jsonb_build_object('account','venue_clearing','side','credit','amount_micro_usdc',${filled + venueCost}) END,
              CASE WHEN ${gholaFee} > 0 THEN jsonb_build_object('account','fee_revenue','side','credit','amount_micro_usdc',${gholaFee}) END
            ), '$[*] ? (@ != null)'), ${reconciledAt}
        FROM reservation r RETURNING transaction_id
      ), completed_job AS (
        UPDATE consumer_worker_reconciliation_jobs SET status = 'reconciled', updated_at = ${reconciledAt}
        WHERE venue_order_id = ${venueOrderId} RETURNING venue_order_id
      ) SELECT o.venue_order_id FROM updated_order o JOIN balance b USING (account_commitment)
    `;
    if (rows.length === 1) return { venue_order_id: venueOrderId, status: finalStatus, reconciled_at: reconciledAt };
    const existing = await sql`
      SELECT o.reconciled_at, r.reserved_micro_usdc
      FROM consumer_venue_orders o JOIN consumer_balance_reservations r USING (reservation_id)
      WHERE o.venue_order_id = ${venueOrderId} LIMIT 1
    `;
    const reason = !existing[0] ? "venue_order_not_found" : existing[0].reconciled_at ? "duplicate_settlement" : "settlement_exceeds_reservation";
    const circuitReason = reason === "settlement_exceeds_reservation"
      ? "negative_balance"
      : reason === "duplicate_settlement" ? "duplicate_settlement" : "reconciliation_drift";
    await halt([circuitReason], `system:${reason}`);
    throw codeError(reason);
  }

  async function halt(reasons, actor = "system:consumer_worker") {
    await requireDatabase();
    const timestamp = now().toISOString();
    await sql`
      INSERT INTO consumer_circuit_state (
        circuit_id, status, reasons, halted_at, resumed_at, acknowledged_by, consecutive_green_canaries, updated_at
      ) VALUES ('pooled_trading', 'halted', ${JSON.stringify(reasons)}::jsonb, ${timestamp}, NULL, ${actor}, 0, ${timestamp})
      ON CONFLICT (circuit_id) DO UPDATE SET
        status = 'halted', reasons = (SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(consumer_circuit_state.reasons || EXCLUDED.reasons)),
        halted_at = COALESCE(consumer_circuit_state.halted_at, EXCLUDED.halted_at), resumed_at = NULL,
        acknowledged_by = EXCLUDED.acknowledged_by, consecutive_green_canaries = 0, updated_at = EXCLUDED.updated_at
    `;
    return circuit();
  }

  async function resume(input) {
    await requireDatabase();
    const actor = stringValue(input.acknowledged_by);
    if (!actor || Number(input.reconciliation_drift_micro_usdc) !== 0 || safeInteger(input.consecutive_green_canaries) < 2) {
      throw codeError("circuit_resume_requirements_not_met");
    }
    const timestamp = now().toISOString();
    await sql`
      INSERT INTO consumer_circuit_state (
        circuit_id, status, reasons, halted_at, resumed_at, acknowledged_by, consecutive_green_canaries, updated_at
      ) VALUES ('pooled_trading', 'open', '[]'::jsonb, NULL, ${timestamp}, ${actor}, ${safeInteger(input.consecutive_green_canaries)}, ${timestamp})
      ON CONFLICT (circuit_id) DO UPDATE SET status='open', reasons='[]'::jsonb, halted_at=NULL,
        resumed_at=EXCLUDED.resumed_at, acknowledged_by=EXCLUDED.acknowledged_by,
        consecutive_green_canaries=EXCLUDED.consecutive_green_canaries, updated_at=EXCLUDED.updated_at
    `;
    return circuit();
  }

  async function circuit() {
    await requireDatabase();
    const rows = await sql`SELECT * FROM consumer_circuit_state WHERE circuit_id = 'pooled_trading' LIMIT 1`;
    return rows[0] || { circuit_id: "pooled_trading", status: "open", reasons: [], consecutive_green_canaries: 0 };
  }

  async function processReconciliationDeadlines() {
    await requireReady();
    const timestamp = now().toISOString();
    const rows = await sql`
      UPDATE consumer_worker_reconciliation_jobs
      SET status = 'failed_review', attempts = attempts + 1, last_error_code = 'reconciliation_stale', updated_at = ${timestamp}
      WHERE status IN ('prepared','awaiting_evidence') AND deadline_at < ${timestamp}
      RETURNING venue_order_id
    `;
    if (rows.length) await halt(["reconciliation_stale"], "system:worker_reconciliation_deadline");
    return rows.length;
  }

  async function processWithdrawals() {
    await requireReady();
    const dispatchUrl = stringValue(process.env.PRIVATE_AGENT_CONSUMER_WITHDRAWAL_DISPATCH_URL);
    const dispatchToken = stringValue(process.env.PRIVATE_AGENT_CONSUMER_WITHDRAWAL_DISPATCH_TOKEN);
    await finalizeSubmittedWithdrawals();
    if (!dispatchUrl || dispatchToken.length < 32) return 0;
    const claimed = await sql`
      WITH candidate AS (
        SELECT w.withdrawal_id FROM consumer_withdrawals w
        WHERE w.status = 'queued' ORDER BY w.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE consumer_withdrawals w SET status = 'dispatching', updated_at = ${now().toISOString()}
      FROM candidate c WHERE w.withdrawal_id = c.withdrawal_id RETURNING w.*
    `;
    const withdrawal = claimed[0];
    if (!withdrawal) return 0;
    const wallets = await sql`SELECT wallet_pubkey, wallet_commitment FROM consumer_wallet_bindings WHERE owner_commitment = ${withdrawal.owner_commitment} LIMIT 1`;
    const wallet = wallets[0];
    if (!wallet || wallet.wallet_commitment !== withdrawal.destination_wallet_commitment) {
      await markWithdrawalReview(withdrawal.withdrawal_id, "recipient_binding_stale");
      return 1;
    }
    const response = await fetchImpl(dispatchUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${dispatchToken}`, "content-type": "application/json", "idempotency-key": withdrawal.withdrawal_id },
      body: JSON.stringify({
        version: 1, withdrawal_id: withdrawal.withdrawal_id, asset: "solana_usdc",
        destination_owner: wallet.wallet_pubkey, amount_micro_usdc: Number(withdrawal.amount_micro_usdc),
      }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    const body = await response?.json().catch(() => null);
    const signature = stringValue(body?.transaction_signature);
    if (!response?.ok || !signature) {
      // Dispatch may be ambiguous after a timeout. Keep funds held and require review; never refund automatically.
      await markWithdrawalReview(withdrawal.withdrawal_id, "withdrawal_dispatch_failed");
      return 1;
    }
    await sql`
      UPDATE consumer_withdrawals SET status='submitted', transaction_signature=${signature}, updated_at=${now().toISOString()}
      WHERE withdrawal_id=${withdrawal.withdrawal_id} AND status='dispatching'
    `;
    return 1;
  }

  async function finalizeSubmittedWithdrawals() {
    if (!connection) return 0;
    const treasury = stringValue(process.env.PRIVATE_AGENT_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT || process.env.GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT);
    if (!treasury) return 0;
    const rows = await sql`
      SELECT w.*, b.wallet_pubkey, b.wallet_commitment
      FROM consumer_withdrawals w JOIN consumer_wallet_bindings b USING (owner_commitment)
      WHERE w.status = 'submitted' AND w.transaction_signature IS NOT NULL
      ORDER BY w.updated_at ASC LIMIT 10
    `;
    let finalized = 0;
    for (const withdrawal of rows) {
      if (withdrawal.wallet_commitment !== withdrawal.destination_wallet_commitment) {
        await sql`UPDATE consumer_withdrawals SET status='failed_review', updated_at=${now().toISOString()} WHERE withdrawal_id=${withdrawal.withdrawal_id} AND status='submitted'`;
        await halt(["recipient_binding_stale"], "system:withdrawal_recipient_binding_changed");
        continue;
      }
      const evidence = await verifyFinalizedWithdrawal({
        connection,
        signature: withdrawal.transaction_signature,
        treasury,
        destination: withdrawal.wallet_pubkey,
        amount: Number(withdrawal.amount_micro_usdc),
      });
      if (evidence.status === "pending") continue;
      if (evidence.status !== "finalized") {
        await sql`UPDATE consumer_withdrawals SET status='failed_review', updated_at=${now().toISOString()} WHERE withdrawal_id=${withdrawal.withdrawal_id} AND status='submitted'`;
        await halt(["reconciliation_drift"], `system:${evidence.error}`);
        continue;
      }
      await sql`UPDATE consumer_withdrawals SET status='finalized', updated_at=${now().toISOString()} WHERE withdrawal_id=${withdrawal.withdrawal_id} AND status='submitted'`;
      finalized += 1;
    }
    return finalized;
  }

  async function markWithdrawalReview(withdrawalId, reason) {
    await sql`UPDATE consumer_withdrawals SET status='failed_review', updated_at=${now().toISOString()} WHERE withdrawal_id=${withdrawalId} AND status='dispatching'`;
    await halt([reason === "recipient_binding_stale" ? "recipient_binding_stale" : "execution_failure_rate"], `system:${reason}`);
  }

  async function tick() {
    if (running || !sql) return;
    running = true;
    try {
      await processReconciliationDeadlines();
      await processWithdrawals();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "consumer_runtime_tick_failed", error_code: safeError(error) }));
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, options.intervalMs || DEFAULT_INTERVAL_MS);
    timer.unref?.();
    queueMicrotask(tick);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function requireReady() {
    const status = await ready();
    if (!status.ready) throw codeError(status.error || `consumer_schema_missing:${(status.missing || []).join(",")}`);
  }

  async function requireDatabase() {
    if (!sql) throw codeError("consumer_database_unconfigured");
    await ensureSchema();
  }

  return { ready, prepareReconciliation, enqueueReconciliation, reconcile, halt, resume, circuit, processReconciliationDeadlines, processWithdrawals, finalizeSubmittedWithdrawals, tick, start, stop };
}

function consumerDatabaseUrl() {
  return process.env.PRIVATE_AGENT_CONSUMER_DATABASE_URL || process.env.GHOLA_CONSUMER_DATABASE_URL ||
    process.env.PRIVATE_AGENT_STATE_POSTGRES_URL || process.env.GHOLA_PRIVATE_AGENT_STATE_POSTGRES_URL ||
    process.env.PRIVATE_AGENT_DATABASE_URL || process.env.DATABASE_URL || "";
}

function consumerSolanaRpcUrl() {
  return process.env.PRIVATE_AGENT_CONSUMER_SOLANA_RPC_URL || process.env.GHOLA_CONSUMER_SOLANA_RPC_URL || process.env.PRIVATE_AGENT_SOLANA_RPC_URL || "";
}

async function verifyFinalizedWithdrawal({ connection, signature, treasury, destination, amount }) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(signature)) return { status: "invalid", error: "solana_signature_invalid" };
  const transaction = await connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!transaction) return { status: "pending" };
  if (!transaction.meta || transaction.meta.err) return { status: "invalid", error: "solana_transfer_failed" };
  const mint = process.env.PRIVATE_AGENT_CONSUMER_SOLANA_USDC_MINT || process.env.GHOLA_CONSUMER_SOLANA_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const pre = tokenAmounts(transaction.meta.preTokenBalances || [], mint);
  const post = tokenAmounts(transaction.meta.postTokenBalances || [], mint);
  const expected = BigInt(amount);
  const treasuryDelta = (post.get(treasury) || 0n) - (pre.get(treasury) || 0n);
  const destinationDelta = (post.get(destination) || 0n) - (pre.get(destination) || 0n);
  if (treasuryDelta > -expected || destinationDelta < expected) return { status: "invalid", error: "withdrawal_amount_or_recipient_mismatch" };
  return { status: "finalized", slot: transaction.slot };
}

function tokenAmounts(balances, mint) {
  const amounts = new Map();
  for (const balance of balances) {
    if (balance.mint !== mint || balance.uiTokenAmount?.decimals !== 6 || !balance.owner) continue;
    amounts.set(balance.owner, (amounts.get(balance.owner) || 0n) + BigInt(balance.uiTokenAmount.amount));
  }
  return amounts;
}

function commitment(namespace, value) {
  return `consumer_${namespace}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 48)}`;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function stringValue(value) { return typeof value === "string" ? value.trim() : ""; }
function safeInteger(value) { const number = Number(value); return Number.isSafeInteger(number) ? number : 0; }
function nonnegativeInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : null; }
function safeError(error) { return String(error?.code || error?.message || "consumer_runtime_error").slice(0, 160); }
function codeError(code) { return Object.assign(new Error(code), { code }); }
