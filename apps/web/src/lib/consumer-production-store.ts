import {
  balancedPostings,
  consumerCommitment,
  type ConsumerBalanceSnapshot,
  type ConsumerCircuitReason,
  type ConsumerCircuitState,
  type ConsumerFundingRail,
  type ConsumerLedgerKind,
  type ConsumerLedgerPosting,
  type ConsumerLedgerTransaction,
  type ConsumerRiskPolicy,
} from "./consumer-production";

type NeonSql = Awaited<ReturnType<typeof import("@neondatabase/serverless")["neon"]>>;

export interface ConsumerWalletBinding {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  wallet_pubkey: string;
  wallet_commitment: string;
  bound_at: string;
  withdrawal_hold_until: string;
  updated_at: string;
}

export interface ConsumerEligibilityAcceptance {
  version: 1;
  owner_commitment: string;
  terms_version: string;
  risk_version: string;
  not_prohibited_person: true;
  accepted_at: string;
}

export interface ConsumerDepositIntent {
  version: 1;
  deposit_intent_id: string;
  owner_commitment: string;
  account_commitment: string;
  rail: ConsumerFundingRail;
  expected_wallet_pubkey: string | null;
  amount_micro_usdc: number;
  status: "pending" | "confirmed" | "expired" | "rejected";
  transaction_signature: string | null;
  nullifier_commitment: string | null;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
}

export interface ConsumerBalanceReservation {
  version: 1;
  reservation_id: string;
  owner_commitment: string;
  account_commitment: string;
  idempotency_key: string;
  venue_id: "phoenix" | "hyperliquid";
  notional_micro_usdc: number;
  venue_cost_reserve_micro_usdc: number;
  fee_micro_usdc: number;
  reserved_micro_usdc: number;
  status: "reserved" | "submitted" | "settled" | "released" | "expired";
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface ConsumerVenueOrder {
  version: 1;
  venue_order_id: string;
  reservation_id: string;
  owner_commitment: string;
  account_commitment: string;
  venue_id: "phoenix" | "hyperliquid";
  market: string;
  work_order_commitment: string;
  worker_receipt_commitment: string;
  status: "submitted" | "partially_filled" | "filled" | "unfilled" | "failed";
  submitted_at: string;
  reconciled_at: string | null;
}

export interface ConsumerVenueFill {
  version: 1;
  venue_fill_id: string;
  venue_order_id: string;
  venue_fill_reference_commitment: string;
  filled_notional_micro_usdc: number;
  venue_cost_micro_usdc: number;
  ghola_fee_micro_usdc: number;
  filled_at: string;
}

export interface ConsumerReconciliationCheckpoint {
  version: 1;
  checkpoint_id: string;
  venue_order_id: string;
  reservation_id: string;
  status: "reconciled";
  drift_micro_usdc: 0;
  reconciled_at: string;
}

export interface ConsumerWakeJob {
  version: 1;
  wake_job_id: string;
  owner_commitment: string;
  status: "queued" | "waking" | "ready" | "failed";
  provider: "phala";
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface ConsumerWithdrawal {
  version: 1;
  withdrawal_id: string;
  owner_commitment: string;
  account_commitment: string;
  idempotency_key: string;
  destination_wallet_commitment: string;
  amount_micro_usdc: number;
  status: "queued" | "prepared" | "dispatching" | "submitted" | "finalized" | "failed_review" | "cancelled";
  transaction_signature: string | null;
  prepared_message_commitment: string | null;
  prepared_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const memory = {
  nonces: new Map<string, number>(),
  rates: new Map<string, { count: number; resetAt: number }>(),
  wallets: new Map<string, ConsumerWalletBinding>(),
  acceptances: new Map<string, ConsumerEligibilityAcceptance>(),
  deposits: new Map<string, ConsumerDepositIntent>(),
  balances: new Map<string, ConsumerBalanceSnapshot>(),
  ledger: new Map<string, ConsumerLedgerTransaction>(),
  reservations: new Map<string, ConsumerBalanceReservation>(),
  venueOrders: new Map<string, ConsumerVenueOrder>(),
  venueFills: new Map<string, ConsumerVenueFill>(),
  reconciliation: new Map<string, ConsumerReconciliationCheckpoint>(),
  policies: new Map<string, ConsumerRiskPolicy>(),
  wakeJobs: new Map<string, ConsumerWakeJob>(),
  withdrawals: new Map<string, ConsumerWithdrawal>(),
  circuit: null as ConsumerCircuitState | null,
};

export async function createConsumerWithdrawal(input: {
  owner_commitment: string;
  account_commitment: string;
  idempotency_key: string;
  destination_wallet_commitment: string;
  amount_micro_usdc: number;
  now?: Date;
}): Promise<{ ok: true; withdrawal: ConsumerWithdrawal; balance: ConsumerBalanceSnapshot } | { ok: false; error: "insufficient_available_balance" | "duplicate_idempotency_key" }> {
  const amount = positiveAmount(input.amount_micro_usdc);
  const now = input.now ?? new Date();
  const withdrawal: ConsumerWithdrawal = {
    version: 1,
    withdrawal_id: consumerCommitment("withdrawal", { account: input.account_commitment, key: input.idempotency_key }),
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    idempotency_key: input.idempotency_key,
    destination_wallet_commitment: input.destination_wallet_commitment,
    amount_micro_usdc: amount,
    status: "queued",
    transaction_signature: null,
    prepared_message_commitment: null,
    prepared_expires_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const postings = balancedPostings([
    { account: "consumer_available", side: "debit", amount_micro_usdc: amount },
    { account: "treasury_usdc", side: "credit", amount_micro_usdc: amount },
  ]);
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      if (memory.withdrawals.has(withdrawal.withdrawal_id)) return { ok: false as const, error: "duplicate_idempotency_key" as const };
      const balance = memoryBalance(input);
      if (balance.available_micro_usdc < amount) return { ok: false as const, error: "insufficient_available_balance" as const };
      const updated = { ...balance, available_micro_usdc: balance.available_micro_usdc - amount, updated_at: now.toISOString() };
      memory.balances.set(input.account_commitment, updated);
      memory.withdrawals.set(withdrawal.withdrawal_id, withdrawal);
      putMemoryLedger(input, "withdrawal_debit", `withdrawal:${input.idempotency_key}`, withdrawal.withdrawal_id, postings, now);
      return { ok: true as const, withdrawal, balance: updated };
    });
  }
  await ensureSchema(sql);
  await ensureBalanceRow(sql, input);
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.account_commitment}, 0))
    ), duplicate AS (
      SELECT 1 FROM consumer_withdrawals WHERE idempotency_key = ${input.idempotency_key}
    ), updated AS (
      UPDATE consumer_balance_accounts
      SET available_micro_usdc = available_micro_usdc - ${amount}, updated_at = ${now.toISOString()}
      FROM lock_guard
      WHERE account_commitment = ${input.account_commitment}
        AND owner_commitment = ${input.owner_commitment}
        AND available_micro_usdc >= ${amount}
        AND NOT EXISTS (SELECT 1 FROM duplicate)
      RETURNING consumer_balance_accounts.*
    ), withdrawal AS (
      INSERT INTO consumer_withdrawals (
        withdrawal_id, owner_commitment, account_commitment, idempotency_key,
        destination_wallet_commitment, amount_micro_usdc, status, created_at, updated_at
      ) SELECT
        ${withdrawal.withdrawal_id}, ${withdrawal.owner_commitment}, ${withdrawal.account_commitment}, ${withdrawal.idempotency_key},
        ${withdrawal.destination_wallet_commitment}, ${withdrawal.amount_micro_usdc}, ${withdrawal.status}, ${withdrawal.created_at}, ${withdrawal.updated_at}
      FROM updated RETURNING withdrawal_id
    ), ledger AS (
      INSERT INTO consumer_ledger_transactions (
        transaction_id, owner_commitment, account_commitment, idempotency_key, kind,
        reference_commitment, postings, created_at
      ) SELECT
        ${consumerCommitment("ledger", withdrawal.withdrawal_id)}, ${input.owner_commitment}, ${input.account_commitment},
        ${`withdrawal:${input.idempotency_key}`}, 'withdrawal_debit', ${withdrawal.withdrawal_id}, ${JSON.stringify(postings)}::jsonb, ${now.toISOString()}
      FROM updated RETURNING transaction_id
    ) SELECT * FROM updated
  ` as Array<Record<string, unknown>>;
  if (!rows[0]) {
    const existing = await sql`SELECT 1 FROM consumer_withdrawals WHERE idempotency_key = ${input.idempotency_key} LIMIT 1` as unknown[];
    return { ok: false, error: existing.length ? "duplicate_idempotency_key" : "insufficient_available_balance" };
  }
  return { ok: true, withdrawal, balance: balanceRow(rows[0], input) };
}

export async function getConsumerWithdrawal(input: { withdrawal_id: string; owner_commitment?: string }): Promise<ConsumerWithdrawal | null> {
  const sql = await getSql();
  if (!sql) {
    const record = memory.withdrawals.get(input.withdrawal_id);
    return record && (!input.owner_commitment || record.owner_commitment === input.owner_commitment) ? record : null;
  }
  await ensureSchema(sql);
  const rows = (input.owner_commitment
    ? await sql`SELECT * FROM consumer_withdrawals WHERE withdrawal_id = ${input.withdrawal_id} AND owner_commitment = ${input.owner_commitment} LIMIT 1`
    : await sql`SELECT * FROM consumer_withdrawals WHERE withdrawal_id = ${input.withdrawal_id} LIMIT 1`) as Array<Record<string, unknown>>;
  return rows[0] ? withdrawalRow(rows[0]) : null;
}

export async function prepareConsumerWithdrawal(input: {
  withdrawal_id: string;
  owner_commitment: string;
  message_commitment: string;
  expires_at: Date;
  now?: Date;
}): Promise<ConsumerWithdrawal | null> {
  const now = (input.now ?? new Date()).toISOString();
  const expiresAt = input.expires_at.toISOString();
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const current = memory.withdrawals.get(input.withdrawal_id);
      if (!current || current.owner_commitment !== input.owner_commitment || !["queued", "prepared"].includes(current.status)) return null;
      const updated = { ...current, status: "prepared" as const, prepared_message_commitment: input.message_commitment, prepared_expires_at: expiresAt, updated_at: now };
      memory.withdrawals.set(input.withdrawal_id, updated);
      return updated;
    });
  }
  await ensureSchema(sql);
  const rows = await sql`
    UPDATE consumer_withdrawals
    SET status = 'prepared', prepared_message_commitment = ${input.message_commitment}, prepared_expires_at = ${expiresAt}, updated_at = ${now}
    WHERE withdrawal_id = ${input.withdrawal_id} AND owner_commitment = ${input.owner_commitment} AND status IN ('queued', 'prepared')
    RETURNING *
  ` as Array<Record<string, unknown>>;
  return rows[0] ? withdrawalRow(rows[0]) : null;
}

export async function submitPreparedConsumerWithdrawal(input: {
  withdrawal_id: string;
  owner_commitment: string;
  message_commitment: string;
  transaction_signature: string;
  now?: Date;
}): Promise<ConsumerWithdrawal | null> {
  const now = input.now ?? new Date();
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const current = memory.withdrawals.get(input.withdrawal_id);
      if (!current || current.owner_commitment !== input.owner_commitment || current.status !== "prepared" ||
        current.prepared_message_commitment !== input.message_commitment || !current.prepared_expires_at ||
        new Date(current.prepared_expires_at).getTime() <= now.getTime()) return null;
      const updated = { ...current, status: "submitted" as const, transaction_signature: input.transaction_signature, updated_at: now.toISOString() };
      memory.withdrawals.set(input.withdrawal_id, updated);
      return updated;
    });
  }
  await ensureSchema(sql);
  const rows = await sql`
    UPDATE consumer_withdrawals
    SET status = 'submitted', transaction_signature = ${input.transaction_signature}, updated_at = ${now.toISOString()}
    WHERE withdrawal_id = ${input.withdrawal_id}
      AND owner_commitment = ${input.owner_commitment}
      AND status = 'prepared'
      AND prepared_message_commitment = ${input.message_commitment}
      AND prepared_expires_at > ${now.toISOString()}
    RETURNING *
  ` as Array<Record<string, unknown>>;
  return rows[0] ? withdrawalRow(rows[0]) : null;
}

export async function cancelConsumerWithdrawal(input: {
  withdrawal_id: string;
  owner_commitment: string;
  now?: Date;
}): Promise<ConsumerWithdrawal | null> {
  const now = input.now ?? new Date();
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const current = memory.withdrawals.get(input.withdrawal_id);
      if (!current || current.owner_commitment !== input.owner_commitment || !["queued", "prepared"].includes(current.status)) return null;
      const balance = memoryBalance(current);
      memory.balances.set(current.account_commitment, { ...balance, available_micro_usdc: balance.available_micro_usdc + current.amount_micro_usdc, updated_at: now.toISOString() });
      const updated = { ...current, status: "cancelled" as const, updated_at: now.toISOString() };
      memory.withdrawals.set(input.withdrawal_id, updated);
      putMemoryLedger(current, "withdrawal_release", `withdrawal_release:${current.withdrawal_id}`, current.withdrawal_id, balancedPostings([
        { account: "treasury_usdc", side: "debit", amount_micro_usdc: current.amount_micro_usdc },
        { account: "consumer_available", side: "credit", amount_micro_usdc: current.amount_micro_usdc },
      ]), now);
      return updated;
    });
  }
  await ensureSchema(sql);
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.withdrawal_id}, 0))
    ), cancelled AS (
      UPDATE consumer_withdrawals w
      SET status = 'cancelled', updated_at = ${now.toISOString()}
      FROM lock_guard
      WHERE w.withdrawal_id = ${input.withdrawal_id}
        AND w.owner_commitment = ${input.owner_commitment}
        AND w.status IN ('queued', 'prepared')
      RETURNING w.*
    ), balance AS (
      UPDATE consumer_balance_accounts b
      SET available_micro_usdc = b.available_micro_usdc + c.amount_micro_usdc, updated_at = ${now.toISOString()}
      FROM cancelled c
      WHERE b.account_commitment = c.account_commitment AND b.owner_commitment = c.owner_commitment
      RETURNING b.account_commitment
    ), ledger AS (
      INSERT INTO consumer_ledger_transactions (
        transaction_id, owner_commitment, account_commitment, idempotency_key, kind,
        reference_commitment, postings, created_at
      ) SELECT ${consumerCommitment("ledger", { withdrawal: input.withdrawal_id, action: "release" })},
        c.owner_commitment, c.account_commitment, ${`withdrawal_release:${input.withdrawal_id}`}, 'withdrawal_release',
        c.withdrawal_id, jsonb_build_array(
          jsonb_build_object('account', 'treasury_usdc', 'side', 'debit', 'amount_micro_usdc', c.amount_micro_usdc),
          jsonb_build_object('account', 'consumer_available', 'side', 'credit', 'amount_micro_usdc', c.amount_micro_usdc)
        ), ${now.toISOString()}
      FROM cancelled c JOIN balance b USING (account_commitment)
      RETURNING transaction_id
    ) SELECT cancelled.* FROM cancelled JOIN balance USING (account_commitment) JOIN ledger ON true
  ` as Array<Record<string, unknown>>;
  return rows[0] ? withdrawalRow(rows[0]) : null;
}

export async function updateConsumerWithdrawalStatus(input: {
  withdrawal_id: string;
  status: "submitted" | "finalized" | "failed_review";
  transaction_signature?: string;
  now?: Date;
}): Promise<ConsumerWithdrawal | null> {
  const now = (input.now ?? new Date()).toISOString();
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const current = memory.withdrawals.get(input.withdrawal_id);
      if (!current || !validWithdrawalTransition(current.status, input.status)) return null;
      const updated = { ...current, status: input.status, transaction_signature: input.transaction_signature ?? current.transaction_signature, updated_at: now };
      memory.withdrawals.set(input.withdrawal_id, updated);
      return updated;
    });
  }
  await ensureSchema(sql);
  const allowedFrom = input.status === "submitted" ? ["queued"] : input.status === "finalized" ? ["submitted"] : ["queued", "submitted"];
  const rows = await sql`
    UPDATE consumer_withdrawals
    SET status = ${input.status},
        transaction_signature = COALESCE(${input.transaction_signature ?? null}::text, transaction_signature),
        updated_at = ${now}
    WHERE withdrawal_id = ${input.withdrawal_id}
      AND status = ANY(${allowedFrom}::text[])
    RETURNING *
  ` as Array<Record<string, unknown>>;
  return rows[0] ? withdrawalRow(rows[0]) : null;
}

export async function enqueueConsumerWake(input: {
  owner_commitment: string;
  now?: Date;
}): Promise<ConsumerWakeJob> {
  const now = input.now ?? new Date();
  const sql = await getSql();
  if (!sql) {
    const existing = Array.from(memory.wakeJobs.values()).find((job) =>
      job.owner_commitment === input.owner_commitment &&
      (job.status === "queued" || job.status === "waking") &&
      new Date(job.expires_at).getTime() > now.getTime()
    );
    if (existing) return existing;
    const record = newWakeJob(input.owner_commitment, now);
    memory.wakeJobs.set(record.wake_job_id, record);
    return record;
  }
  await ensureSchema(sql);
  const existing = await sql`
    SELECT * FROM consumer_wake_jobs
    WHERE owner_commitment = ${input.owner_commitment}
      AND status IN ('queued', 'waking')
      AND expires_at > ${now.toISOString()}
    ORDER BY created_at DESC LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (existing[0]) return wakeJobRow(existing[0]);
  const record = newWakeJob(input.owner_commitment, now);
  const rows = await sql`
    INSERT INTO consumer_wake_jobs (
      wake_job_id, owner_commitment, status, provider, error_code, created_at, updated_at, expires_at
    ) VALUES (
      ${record.wake_job_id}, ${record.owner_commitment}, ${record.status}, ${record.provider}, ${record.error_code},
      ${record.created_at}, ${record.updated_at}, ${record.expires_at}
    ) RETURNING *
  ` as Array<Record<string, unknown>>;
  return wakeJobRow(rows[0]);
}

export async function getConsumerWakeJob(input: {
  wake_job_id: string;
  owner_commitment: string;
}): Promise<ConsumerWakeJob | null> {
  const sql = await getSql();
  if (!sql) {
    const job = memory.wakeJobs.get(input.wake_job_id);
    return job?.owner_commitment === input.owner_commitment ? job : null;
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM consumer_wake_jobs
    WHERE wake_job_id = ${input.wake_job_id} AND owner_commitment = ${input.owner_commitment}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  return rows[0] ? wakeJobRow(rows[0]) : null;
}

export async function updateConsumerWakeJob(input: {
  wake_job_id: string;
  status: ConsumerWakeJob["status"];
  error_code?: string | null;
  now?: Date;
}): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  const sql = await getSql();
  if (!sql) {
    const existing = memory.wakeJobs.get(input.wake_job_id);
    if (existing) memory.wakeJobs.set(input.wake_job_id, {
      ...existing,
      status: input.status,
      error_code: input.error_code ?? null,
      updated_at: now,
    });
    return;
  }
  await ensureSchema(sql);
  await sql`
    UPDATE consumer_wake_jobs
    SET status = ${input.status}, error_code = ${input.error_code ?? null}, updated_at = ${now}
    WHERE wake_job_id = ${input.wake_job_id}
  `;
}

let sqlClient: NeonSql | null = null;
let schemaReady = false;
let memoryQueue = Promise.resolve();

export async function consumerProductionStoreReady(): Promise<boolean> {
  const sql = await getSql();
  if (!sql) return !productionLike();
  await ensureSchema(sql);
  await sql`SELECT 1 AS ok`;
  return true;
}

export async function hasActiveConsumerExposure(): Promise<boolean> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(memory.reservations.values()).some((item) => item.status === "reserved" || item.status === "submitted") ||
      Array.from(memory.withdrawals.values()).some((item) => ["queued", "prepared", "dispatching", "submitted", "failed_review"].includes(item.status));
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT (
      EXISTS (SELECT 1 FROM consumer_balance_reservations WHERE status IN ('reserved', 'submitted'))
      OR EXISTS (SELECT 1 FROM consumer_withdrawals WHERE status IN ('queued', 'prepared', 'dispatching', 'submitted', 'failed_review'))
    ) AS active
  ` as Array<{ active: boolean }>;
  return rows[0]?.active === true;
}

export async function getConsumerReconciliationHealth(now = new Date()): Promise<{
  ready: boolean;
  overdue_order_count: number;
  oldest_unreconciled_age_ms: number;
}> {
  const sql = await getSql();
  if (!sql) {
    const pending = Array.from(memory.venueOrders.values()).filter((item) => !item.reconciled_at);
    const oldest = pending.reduce((value, item) => Math.max(value, now.getTime() - new Date(item.submitted_at).getTime()), 0);
    return { ready: oldest <= 60_000, overdue_order_count: pending.filter((item) => now.getTime() - new Date(item.submitted_at).getTime() > 60_000).length, oldest_unreconciled_age_ms: oldest };
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE submitted_at < ${new Date(now.getTime() - 60_000).toISOString()})::integer AS overdue_order_count,
      COALESCE(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamptz - MIN(submitted_at))) * 1000, 0)::bigint AS oldest_unreconciled_age_ms
    FROM consumer_venue_orders WHERE reconciled_at IS NULL
  ` as Array<{ overdue_order_count: number; oldest_unreconciled_age_ms: number }>;
  const overdue = Number(rows[0]?.overdue_order_count ?? 0);
  return { ready: overdue === 0, overdue_order_count: overdue, oldest_unreconciled_age_ms: Number(rows[0]?.oldest_unreconciled_age_ms ?? 0) };
}

export async function consumeConsumerNonce(input: {
  namespace: string;
  owner_commitment: string;
  nonce: string;
  expires_at_ms: number;
}): Promise<boolean> {
  const key = `${input.namespace}:${input.owner_commitment}:${input.nonce}`;
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      pruneMemory();
      if (memory.nonces.has(key)) return false;
      memory.nonces.set(key, input.expires_at_ms);
      return true;
    });
  }
  await ensureSchema(sql);
  const rows = await sql`
    INSERT INTO consumer_request_nonces (nonce_key, expires_at)
    VALUES (${key}, ${new Date(input.expires_at_ms).toISOString()})
    ON CONFLICT DO NOTHING
    RETURNING nonce_key
  ` as Array<{ nonce_key: string }>;
  return rows.length === 1;
}

export async function consumeConsumerRateLimit(input: {
  key: string;
  limit: number;
  window_ms: number;
  now_ms?: number;
}): Promise<{ ok: boolean; retry_after_seconds: number; count: number }> {
  const now = input.now_ms ?? Date.now();
  const bucketStart = Math.floor(now / input.window_ms) * input.window_ms;
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      pruneMemory(now);
      const key = `${input.key}:${bucketStart}`;
      const current = memory.rates.get(key) ?? { count: 0, resetAt: bucketStart + input.window_ms };
      current.count += 1;
      memory.rates.set(key, current);
      return {
        ok: current.count <= input.limit,
        count: current.count,
        retry_after_seconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      };
    });
  }
  await ensureSchema(sql);
  const rows = await sql`
    INSERT INTO consumer_rate_limits (rate_key, bucket_start, expires_at, request_count)
    VALUES (${input.key}, ${new Date(bucketStart).toISOString()}, ${new Date(bucketStart + input.window_ms).toISOString()}, 1)
    ON CONFLICT (rate_key, bucket_start)
    DO UPDATE SET request_count = consumer_rate_limits.request_count + 1
    RETURNING request_count, expires_at
  ` as Array<{ request_count: number; expires_at: string | Date }>;
  const count = Number(rows[0]?.request_count ?? input.limit + 1);
  return {
    ok: count <= input.limit,
    count,
    retry_after_seconds: Math.max(1, Math.ceil((new Date(rows[0]?.expires_at ?? bucketStart + input.window_ms).getTime() - now) / 1_000)),
  };
}

export async function putConsumerWalletBinding(input: Omit<ConsumerWalletBinding, "version" | "bound_at" | "withdrawal_hold_until" | "updated_at"> & {
  now?: Date;
}): Promise<ConsumerWalletBinding> {
  const existing = await getConsumerWalletBinding(input.owner_commitment);
  const now = input.now ?? new Date();
  const changed = Boolean(existing && existing.wallet_pubkey !== input.wallet_pubkey);
  const record: ConsumerWalletBinding = {
    version: 1,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    wallet_pubkey: input.wallet_pubkey,
    wallet_commitment: input.wallet_commitment,
    bound_at: existing?.bound_at ?? now.toISOString(),
    withdrawal_hold_until: new Date(now.getTime() + (changed ? 24 * 60 * 60_000 : 0)).toISOString(),
    updated_at: now.toISOString(),
  };
  const sql = await getSql();
  if (!sql) {
    memory.wallets.set(record.owner_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO consumer_wallet_bindings (
      owner_commitment, account_commitment, wallet_pubkey, wallet_commitment,
      bound_at, withdrawal_hold_until, updated_at
    ) VALUES (
      ${record.owner_commitment}, ${record.account_commitment}, ${record.wallet_pubkey}, ${record.wallet_commitment},
      ${record.bound_at}, ${record.withdrawal_hold_until}, ${record.updated_at}
    )
    ON CONFLICT (owner_commitment) DO UPDATE SET
      account_commitment = EXCLUDED.account_commitment,
      wallet_pubkey = EXCLUDED.wallet_pubkey,
      wallet_commitment = EXCLUDED.wallet_commitment,
      withdrawal_hold_until = EXCLUDED.withdrawal_hold_until,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getConsumerWalletBinding(ownerCommitment: string): Promise<ConsumerWalletBinding | null> {
  const sql = await getSql();
  if (!sql) return memory.wallets.get(ownerCommitment) ?? null;
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM consumer_wallet_bindings WHERE owner_commitment = ${ownerCommitment} LIMIT 1
  ` as Array<Record<string, unknown>>;
  return rows[0] ? walletRow(rows[0]) : null;
}

export async function putConsumerEligibilityAcceptance(
  record: ConsumerEligibilityAcceptance,
): Promise<ConsumerEligibilityAcceptance> {
  const sql = await getSql();
  if (!sql) {
    memory.acceptances.set(record.owner_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO consumer_eligibility_acceptances (
      owner_commitment, terms_version, risk_version, not_prohibited_person, accepted_at
    ) VALUES (
      ${record.owner_commitment}, ${record.terms_version}, ${record.risk_version}, true, ${record.accepted_at}
    )
    ON CONFLICT (owner_commitment) DO UPDATE SET
      terms_version = EXCLUDED.terms_version,
      risk_version = EXCLUDED.risk_version,
      not_prohibited_person = EXCLUDED.not_prohibited_person,
      accepted_at = EXCLUDED.accepted_at
  `;
  return record;
}

export async function getConsumerEligibilityAcceptance(ownerCommitment: string): Promise<ConsumerEligibilityAcceptance | null> {
  const sql = await getSql();
  if (!sql) return memory.acceptances.get(ownerCommitment) ?? null;
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM consumer_eligibility_acceptances WHERE owner_commitment = ${ownerCommitment} LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (!rows[0]) return null;
  return {
    version: 1,
    owner_commitment: String(rows[0].owner_commitment),
    terms_version: String(rows[0].terms_version),
    risk_version: String(rows[0].risk_version),
    not_prohibited_person: true,
    accepted_at: dateString(rows[0].accepted_at),
  };
}

export async function createConsumerDepositIntent(input: {
  owner_commitment: string;
  account_commitment: string;
  rail: ConsumerFundingRail;
  expected_wallet_pubkey: string | null;
  amount_micro_usdc: number;
  idempotency_key: string;
  now?: Date;
}): Promise<ConsumerDepositIntent> {
  const now = input.now ?? new Date();
  const record: ConsumerDepositIntent = {
    version: 1,
    deposit_intent_id: consumerCommitment("deposit", {
      owner: input.owner_commitment,
      idempotency_key: input.idempotency_key,
    }),
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    rail: input.rail,
    expected_wallet_pubkey: input.expected_wallet_pubkey,
    amount_micro_usdc: positiveAmount(input.amount_micro_usdc),
    status: "pending",
    transaction_signature: null,
    nullifier_commitment: null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
    confirmed_at: null,
  };
  const sql = await getSql();
  if (!sql) {
    memory.deposits.set(record.deposit_intent_id, record);
    return record;
  }
  await ensureSchema(sql);
  const rows = await sql`
    INSERT INTO consumer_deposit_intents (
      deposit_intent_id, owner_commitment, account_commitment, idempotency_key, rail,
      expected_wallet_pubkey, amount_micro_usdc, status, created_at, expires_at
    ) VALUES (
      ${record.deposit_intent_id}, ${record.owner_commitment}, ${record.account_commitment}, ${input.idempotency_key}, ${record.rail},
      ${record.expected_wallet_pubkey}, ${record.amount_micro_usdc}, ${record.status}, ${record.created_at}, ${record.expires_at}
    )
    ON CONFLICT (owner_commitment, idempotency_key) DO UPDATE SET owner_commitment = EXCLUDED.owner_commitment
    RETURNING *
  ` as Array<Record<string, unknown>>;
  return depositRow(rows[0]);
}

export async function getConsumerDepositIntent(input: {
  deposit_intent_id: string;
  owner_commitment: string;
}): Promise<ConsumerDepositIntent | null> {
  const sql = await getSql();
  if (!sql) {
    const record = memory.deposits.get(input.deposit_intent_id);
    return record?.owner_commitment === input.owner_commitment ? record : null;
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM consumer_deposit_intents
    WHERE deposit_intent_id = ${input.deposit_intent_id} AND owner_commitment = ${input.owner_commitment}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  return rows[0] ? depositRow(rows[0]) : null;
}

export async function confirmConsumerDeposit(input: {
  deposit_intent_id: string;
  owner_commitment: string;
  transaction_signature?: string | null;
  nullifier_commitment?: string | null;
  now?: Date;
}): Promise<{ ok: true; intent: ConsumerDepositIntent; balance: ConsumerBalanceSnapshot } | { ok: false; error: "deposit_intent_not_pending" | "deposit_evidence_already_used" }> {
  const now = input.now ?? new Date();
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const intent = memory.deposits.get(input.deposit_intent_id);
      if (!intent || intent.owner_commitment !== input.owner_commitment || intent.status !== "pending") {
        return { ok: false as const, error: "deposit_intent_not_pending" as const };
      }
      const duplicate = Array.from(memory.deposits.values()).some((other) =>
        other.deposit_intent_id !== intent.deposit_intent_id &&
        ((input.transaction_signature && other.transaction_signature === input.transaction_signature) ||
          (input.nullifier_commitment && other.nullifier_commitment === input.nullifier_commitment))
      );
      if (duplicate) return { ok: false as const, error: "deposit_evidence_already_used" as const };
      const confirmed: ConsumerDepositIntent = {
        ...intent,
        status: "confirmed",
        transaction_signature: input.transaction_signature ?? null,
        nullifier_commitment: input.nullifier_commitment ?? null,
        confirmed_at: now.toISOString(),
      };
      memory.deposits.set(intent.deposit_intent_id, confirmed);
      const balance = memoryBalance(intent);
      const updated = { ...balance, available_micro_usdc: balance.available_micro_usdc + intent.amount_micro_usdc, updated_at: now.toISOString() };
      memory.balances.set(intent.account_commitment, updated);
      putMemoryLedger(intent, "deposit_credit", `deposit:${intent.deposit_intent_id}`, intent.deposit_intent_id, balancedPostings([
        { account: "treasury_usdc", side: "debit", amount_micro_usdc: intent.amount_micro_usdc },
        { account: "consumer_available", side: "credit", amount_micro_usdc: intent.amount_micro_usdc },
      ]), now);
      return { ok: true as const, intent: confirmed, balance: updated };
    });
  }
  await ensureSchema(sql);
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.deposit_intent_id}, 0))
    ), confirmed AS (
      UPDATE consumer_deposit_intents
      SET status = 'confirmed',
          transaction_signature = ${input.transaction_signature ?? null},
          nullifier_commitment = ${input.nullifier_commitment ?? null},
          confirmed_at = ${now.toISOString()}
      FROM lock_guard
      WHERE deposit_intent_id = ${input.deposit_intent_id}
        AND owner_commitment = ${input.owner_commitment}
        AND status = 'pending'
        AND expires_at > ${now.toISOString()}
        AND (${input.transaction_signature ?? null}::text IS NULL OR NOT EXISTS (
          SELECT 1 FROM consumer_deposit_intents used WHERE used.transaction_signature = ${input.transaction_signature ?? null}
        ))
        AND (${input.nullifier_commitment ?? null}::text IS NULL OR NOT EXISTS (
          SELECT 1 FROM consumer_deposit_intents used WHERE used.nullifier_commitment = ${input.nullifier_commitment ?? null}
        ))
      RETURNING consumer_deposit_intents.*
    ), balance AS (
      INSERT INTO consumer_balance_accounts (
        account_commitment, owner_commitment, available_micro_usdc, updated_at
      ) SELECT account_commitment, owner_commitment, amount_micro_usdc, ${now.toISOString()} FROM confirmed
      ON CONFLICT (account_commitment) DO UPDATE SET
        available_micro_usdc = consumer_balance_accounts.available_micro_usdc + EXCLUDED.available_micro_usdc,
        updated_at = EXCLUDED.updated_at
      RETURNING consumer_balance_accounts.*
    ), ledger AS (
      INSERT INTO consumer_ledger_transactions (
        transaction_id, owner_commitment, account_commitment, idempotency_key, kind,
        reference_commitment, postings, created_at
      ) SELECT
        ${consumerCommitment("ledger", { deposit: input.deposit_intent_id })}, confirmed.owner_commitment, confirmed.account_commitment,
        ${`deposit:${input.deposit_intent_id}`}, 'deposit_credit', confirmed.deposit_intent_id,
        jsonb_build_array(
          jsonb_build_object('account', 'treasury_usdc', 'side', 'debit', 'amount_micro_usdc', confirmed.amount_micro_usdc),
          jsonb_build_object('account', 'consumer_available', 'side', 'credit', 'amount_micro_usdc', confirmed.amount_micro_usdc)
        ), ${now.toISOString()}
      FROM confirmed RETURNING transaction_id
    )
    SELECT confirmed.*, balance.available_micro_usdc, balance.reserved_micro_usdc,
      balance.open_notional_micro_usdc, balance.realized_pnl_micro_usdc, balance.updated_at AS balance_updated_at
    FROM confirmed CROSS JOIN balance
  ` as Array<Record<string, unknown>>;
  if (!rows[0]) {
    const duplicate = await sql`
      SELECT 1 FROM consumer_deposit_intents
      WHERE (${input.transaction_signature ?? null}::text IS NOT NULL AND transaction_signature = ${input.transaction_signature ?? null})
         OR (${input.nullifier_commitment ?? null}::text IS NOT NULL AND nullifier_commitment = ${input.nullifier_commitment ?? null})
      LIMIT 1
    ` as unknown[];
    return { ok: false, error: duplicate.length ? "deposit_evidence_already_used" : "deposit_intent_not_pending" };
  }
  const intent = depositRow(rows[0]);
  return {
    ok: true,
    intent,
    balance: {
      version: 1,
      owner_commitment: intent.owner_commitment,
      account_commitment: intent.account_commitment,
      available_micro_usdc: Number(rows[0].available_micro_usdc),
      reserved_micro_usdc: Number(rows[0].reserved_micro_usdc),
      open_notional_micro_usdc: Number(rows[0].open_notional_micro_usdc),
      realized_pnl_micro_usdc: Number(rows[0].realized_pnl_micro_usdc),
      updated_at: dateString(rows[0].balance_updated_at),
    },
  };
}

export async function getConsumerBalance(input: {
  owner_commitment: string;
  account_commitment: string;
}): Promise<ConsumerBalanceSnapshot> {
  const sql = await getSql();
  if (!sql) return memoryBalance(input);
  await ensureSchema(sql);
  await ensureBalanceRow(sql, input);
  const rows = await sql`
    SELECT * FROM consumer_balance_accounts
    WHERE account_commitment = ${input.account_commitment} AND owner_commitment = ${input.owner_commitment}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  return balanceRow(rows[0], input);
}

export async function createConsumerBalanceAdjustment(input: {
  owner_commitment: string;
  account_commitment: string;
  delta_micro_usdc: number;
  incident_reference: string;
  reviewed_by: [string, string];
  now?: Date;
}): Promise<{ ok: true; balance: ConsumerBalanceSnapshot; transaction_id: string } | { ok: false; error: "insufficient_available_balance" | "duplicate_incident_adjustment" }> {
  if (!Number.isSafeInteger(input.delta_micro_usdc) || input.delta_micro_usdc === 0) throw new Error("adjustment_delta_invalid");
  const amount = Math.abs(input.delta_micro_usdc);
  const now = input.now ?? new Date();
  const transactionId = consumerCommitment("adjustment", { incident: input.incident_reference, account: input.account_commitment });
  const postings = balancedPostings(input.delta_micro_usdc > 0 ? [
    { account: "treasury_usdc", side: "debit", amount_micro_usdc: amount },
    { account: "consumer_available", side: "credit", amount_micro_usdc: amount },
  ] : [
    { account: "consumer_available", side: "debit", amount_micro_usdc: amount },
    { account: "treasury_usdc", side: "credit", amount_micro_usdc: amount },
  ]);
  const idempotencyKey = `adjustment:${consumerCommitment("incident", input.incident_reference)}`;
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      if (memory.ledger.has(idempotencyKey)) return { ok: false as const, error: "duplicate_incident_adjustment" as const };
      const current = memoryBalance(input);
      if (current.available_micro_usdc + input.delta_micro_usdc < 0) return { ok: false as const, error: "insufficient_available_balance" as const };
      const balance = { ...current, available_micro_usdc: current.available_micro_usdc + input.delta_micro_usdc, updated_at: now.toISOString() };
      memory.balances.set(input.account_commitment, balance);
      putMemoryLedger(input, "operator_adjustment", idempotencyKey, transactionId, postings, now);
      return { ok: true as const, balance, transaction_id: transactionId };
    });
  }
  await ensureSchema(sql);
  await ensureBalanceRow(sql, input);
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.account_commitment}, 0))
    ), duplicate AS (
      SELECT 1 FROM consumer_ledger_transactions WHERE idempotency_key = ${idempotencyKey}
    ), updated AS (
      UPDATE consumer_balance_accounts
      SET available_micro_usdc = available_micro_usdc + ${input.delta_micro_usdc}, updated_at = ${now.toISOString()}
      FROM lock_guard
      WHERE account_commitment = ${input.account_commitment}
        AND owner_commitment = ${input.owner_commitment}
        AND available_micro_usdc + ${input.delta_micro_usdc} >= 0
        AND NOT EXISTS (SELECT 1 FROM duplicate)
      RETURNING consumer_balance_accounts.*
    ), ledger AS (
      INSERT INTO consumer_ledger_transactions (
        transaction_id, owner_commitment, account_commitment, idempotency_key, kind,
        reference_commitment, postings, created_at
      ) SELECT ${transactionId}, ${input.owner_commitment}, ${input.account_commitment}, ${idempotencyKey},
        'operator_adjustment', ${consumerCommitment("incident_review", { incident: input.incident_reference, reviewers: [...input.reviewed_by].sort() })},
        ${JSON.stringify(postings)}::jsonb, ${now.toISOString()}
      FROM updated RETURNING transaction_id
    ) SELECT updated.*, (SELECT transaction_id FROM ledger) AS transaction_id FROM updated
  ` as Array<Record<string, unknown>>;
  if (!rows[0]) {
    const duplicate = await sql`SELECT 1 FROM consumer_ledger_transactions WHERE idempotency_key = ${idempotencyKey} LIMIT 1` as unknown[];
    return { ok: false, error: duplicate.length ? "duplicate_incident_adjustment" : "insufficient_available_balance" };
  }
  return { ok: true, balance: balanceRow(rows[0], input), transaction_id: String(rows[0].transaction_id) };
}

export async function reserveConsumerBalance(input: {
  owner_commitment: string;
  account_commitment: string;
  idempotency_key: string;
  venue_id: "phoenix" | "hyperliquid";
  notional_micro_usdc: number;
  fee_micro_usdc: number;
  venue_cost_reserve_micro_usdc?: number;
  max_daily_notional_micro_usdc?: number;
  max_position_micro_usdc?: number;
  ttl_ms?: number;
  now?: Date;
}): Promise<{ ok: true; reservation: ConsumerBalanceReservation; balance: ConsumerBalanceSnapshot } | { ok: false; error: "insufficient_available_balance" | "duplicate_idempotency_key" }> {
  const notional = positiveAmount(input.notional_micro_usdc);
  const fee = positiveAmount(input.fee_micro_usdc);
  const venueCostReserve = input.venue_cost_reserve_micro_usdc === undefined ? 0 : nonnegativeAmount(input.venue_cost_reserve_micro_usdc);
  const reserved = notional + fee + venueCostReserve;
  const now = input.now ?? new Date();
  const reservation: ConsumerBalanceReservation = {
    version: 1,
    reservation_id: consumerCommitment("reservation", { account: input.account_commitment, key: input.idempotency_key }),
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    idempotency_key: input.idempotency_key,
    venue_id: input.venue_id,
    notional_micro_usdc: notional,
    venue_cost_reserve_micro_usdc: venueCostReserve,
    fee_micro_usdc: fee,
    reserved_micro_usdc: reserved,
    status: "reserved",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (input.ttl_ms ?? 10 * 60_000)).toISOString(),
    updated_at: now.toISOString(),
  };
  const postings = balancedPostings([
    { account: "consumer_available", side: "debit", amount_micro_usdc: reserved },
    { account: "consumer_reserved", side: "credit", amount_micro_usdc: reserved },
  ]);
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      if (memory.reservations.has(reservation.reservation_id)) return { ok: false as const, error: "duplicate_idempotency_key" as const };
      const balance = memoryBalance(input);
      if (balance.available_micro_usdc < reserved) return { ok: false as const, error: "insufficient_available_balance" as const };
      const dailyNotional = Array.from(memory.reservations.values())
        .filter((item) => item.owner_commitment === input.owner_commitment && item.status !== "released" && item.status !== "expired" && new Date(item.created_at).getTime() > now.getTime() - 86_400_000)
        .reduce((sum, item) => sum + item.notional_micro_usdc, 0);
      if (input.max_daily_notional_micro_usdc && dailyNotional + notional > input.max_daily_notional_micro_usdc) {
        return { ok: false as const, error: "insufficient_available_balance" as const };
      }
      if (input.max_position_micro_usdc && balance.open_notional_micro_usdc + notional > input.max_position_micro_usdc) {
        return { ok: false as const, error: "insufficient_available_balance" as const };
      }
      const updated = { ...balance, available_micro_usdc: balance.available_micro_usdc - reserved, reserved_micro_usdc: balance.reserved_micro_usdc + reserved, updated_at: now.toISOString() };
      memory.balances.set(input.account_commitment, updated);
      memory.reservations.set(reservation.reservation_id, reservation);
      putMemoryLedger(input, "order_reservation", input.idempotency_key, reservation.reservation_id, postings, now);
      return { ok: true as const, reservation, balance: updated };
    });
  }
  await ensureSchema(sql);
  await ensureBalanceRow(sql, input);
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.account_commitment}, 0))
    ), duplicate AS (
      SELECT 1 FROM consumer_balance_reservations WHERE idempotency_key = ${input.idempotency_key}
    ), daily AS (
      SELECT COALESCE(SUM(notional_micro_usdc), 0)::bigint AS notional_micro_usdc
      FROM consumer_balance_reservations, lock_guard
      WHERE owner_commitment = ${input.owner_commitment}
        AND status NOT IN ('released', 'expired')
        AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}
    ), updated AS (
      UPDATE consumer_balance_accounts
      SET available_micro_usdc = available_micro_usdc - ${reserved},
          reserved_micro_usdc = reserved_micro_usdc + ${reserved},
          updated_at = ${now.toISOString()}
      FROM lock_guard
      WHERE account_commitment = ${input.account_commitment}
        AND owner_commitment = ${input.owner_commitment}
        AND available_micro_usdc >= ${reserved}
        AND (${input.max_daily_notional_micro_usdc ?? null}::bigint IS NULL OR (SELECT notional_micro_usdc FROM daily) + ${notional} <= ${input.max_daily_notional_micro_usdc ?? null}::bigint)
        AND (${input.max_position_micro_usdc ?? null}::bigint IS NULL OR open_notional_micro_usdc + ${notional} <= ${input.max_position_micro_usdc ?? null}::bigint)
        AND NOT EXISTS (SELECT 1 FROM duplicate)
      RETURNING consumer_balance_accounts.*
    ), reservation AS (
      INSERT INTO consumer_balance_reservations (
        reservation_id, owner_commitment, account_commitment, idempotency_key, venue_id,
        notional_micro_usdc, venue_cost_reserve_micro_usdc, fee_micro_usdc, reserved_micro_usdc, status, created_at, expires_at, updated_at
      ) SELECT
        ${reservation.reservation_id}, ${reservation.owner_commitment}, ${reservation.account_commitment}, ${reservation.idempotency_key}, ${reservation.venue_id},
        ${reservation.notional_micro_usdc}, ${reservation.venue_cost_reserve_micro_usdc}, ${reservation.fee_micro_usdc}, ${reservation.reserved_micro_usdc}, ${reservation.status},
        ${reservation.created_at}, ${reservation.expires_at}, ${reservation.updated_at}
      FROM updated RETURNING *
    ), ledger AS (
      INSERT INTO consumer_ledger_transactions (
        transaction_id, owner_commitment, account_commitment, idempotency_key, kind,
        reference_commitment, postings, created_at
      ) SELECT
        ${consumerCommitment("ledger", reservation.reservation_id)}, ${input.owner_commitment}, ${input.account_commitment},
        ${`reserve:${input.idempotency_key}`}, 'order_reservation', ${reservation.reservation_id}, ${JSON.stringify(postings)}::jsonb, ${now.toISOString()}
      FROM updated RETURNING transaction_id
    )
    SELECT updated.*, (SELECT COUNT(*) FROM duplicate) AS duplicate_count FROM updated
  ` as Array<Record<string, unknown>>;
  if (!rows[0]) {
    const existing = await sql`SELECT 1 FROM consumer_balance_reservations WHERE idempotency_key = ${input.idempotency_key} LIMIT 1` as unknown[];
    return { ok: false, error: existing.length ? "duplicate_idempotency_key" : "insufficient_available_balance" };
  }
  return { ok: true, reservation, balance: balanceRow(rows[0], input) };
}

export async function releaseConsumerReservation(input: {
  reservation_id: string;
  owner_commitment: string;
  reason: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const reservation = memory.reservations.get(input.reservation_id);
      if (!reservation || reservation.owner_commitment !== input.owner_commitment || reservation.status !== "reserved") return false;
      const balance = memoryBalance(reservation);
      const updated = {
        ...balance,
        available_micro_usdc: balance.available_micro_usdc + reservation.reserved_micro_usdc,
        reserved_micro_usdc: Math.max(0, balance.reserved_micro_usdc - reservation.reserved_micro_usdc),
        updated_at: now.toISOString(),
      };
      memory.balances.set(reservation.account_commitment, updated);
      memory.reservations.set(reservation.reservation_id, { ...reservation, status: "released", updated_at: now.toISOString() });
      putMemoryLedger(reservation, "reservation_release", `release:${reservation.idempotency_key}`, reservation.reservation_id, balancedPostings([
        { account: "consumer_reserved", side: "debit", amount_micro_usdc: reservation.reserved_micro_usdc },
        { account: "consumer_available", side: "credit", amount_micro_usdc: reservation.reserved_micro_usdc },
      ]), now);
      return true;
    });
  }
  await ensureSchema(sql);
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.reservation_id}, 0))
    ), released AS (
      UPDATE consumer_balance_reservations
      SET status = 'released', updated_at = ${now.toISOString()}
      FROM lock_guard
      WHERE reservation_id = ${input.reservation_id}
        AND owner_commitment = ${input.owner_commitment}
        AND status = 'reserved'
      RETURNING consumer_balance_reservations.*
    ), balance AS (
      UPDATE consumer_balance_accounts
      SET available_micro_usdc = available_micro_usdc + released.reserved_micro_usdc,
          reserved_micro_usdc = reserved_micro_usdc - released.reserved_micro_usdc,
          updated_at = ${now.toISOString()}
      FROM released
      WHERE consumer_balance_accounts.account_commitment = released.account_commitment
        AND consumer_balance_accounts.reserved_micro_usdc >= released.reserved_micro_usdc
      RETURNING consumer_balance_accounts.account_commitment
    ), ledger AS (
      INSERT INTO consumer_ledger_transactions (
        transaction_id, owner_commitment, account_commitment, idempotency_key, kind,
        reference_commitment, postings, created_at
      ) SELECT
        ${consumerCommitment("ledger", { reservation: input.reservation_id, action: "release" })},
        released.owner_commitment, released.account_commitment, ${`release:${input.reservation_id}`},
        'reservation_release', released.reservation_id,
        jsonb_build_array(
          jsonb_build_object('account', 'consumer_reserved', 'side', 'debit', 'amount_micro_usdc', released.reserved_micro_usdc),
          jsonb_build_object('account', 'consumer_available', 'side', 'credit', 'amount_micro_usdc', released.reserved_micro_usdc)
        ), ${now.toISOString()}
      FROM released RETURNING transaction_id
    )
    SELECT reservation_id FROM released
  ` as Array<{ reservation_id: string }>;
  if (rows.length) {
    console.log(JSON.stringify({
      level: "info",
      message: "consumer_reservation_released",
      reservation_id: input.reservation_id,
      reason: input.reason,
    }));
  }
  return rows.length === 1;
}

export async function markConsumerReservationSubmitted(input: {
  reservation_id: string;
  owner_commitment: string;
  now?: Date;
}): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const sql = await getSql();
  if (!sql) {
    const existing = memory.reservations.get(input.reservation_id);
    if (!existing || existing.owner_commitment !== input.owner_commitment || existing.status !== "reserved") return false;
    memory.reservations.set(input.reservation_id, { ...existing, status: "submitted", updated_at: now });
    return true;
  }
  await ensureSchema(sql);
  const rows = await sql`
    UPDATE consumer_balance_reservations
    SET status = 'submitted', updated_at = ${now}
    WHERE reservation_id = ${input.reservation_id}
      AND owner_commitment = ${input.owner_commitment}
      AND status = 'reserved'
    RETURNING reservation_id
  ` as Array<{ reservation_id: string }>;
  return rows.length === 1;
}

export async function recordConsumerVenueOrder(input: {
  reservation_id: string;
  owner_commitment: string;
  market: string;
  work_order_commitment: string;
  worker_receipt: unknown;
  now?: Date;
}): Promise<ConsumerVenueOrder | null> {
  const now = input.now ?? new Date();
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const reservation = memory.reservations.get(input.reservation_id);
      if (!reservation || reservation.owner_commitment !== input.owner_commitment || reservation.status !== "submitted") return null;
      const venueOrderId = consumerCommitment("venue_order", input.reservation_id);
      const existing = memory.venueOrders.get(venueOrderId);
      if (existing) return existing;
      const order = venueOrderFromReservation(reservation, input, now);
      memory.venueOrders.set(order.venue_order_id, order);
      return order;
    });
  }
  await ensureSchema(sql);
  const rows = await sql`
    INSERT INTO consumer_venue_orders (
      venue_order_id, reservation_id, owner_commitment, account_commitment, venue_id, market,
      work_order_commitment, worker_receipt_commitment, status, submitted_at
    )
    SELECT
      ${consumerCommitment("venue_order", input.reservation_id)}, reservation_id, owner_commitment, account_commitment,
      venue_id, ${input.market}, ${input.work_order_commitment}, ${consumerCommitment("worker_receipt", input.worker_receipt)},
      'submitted', ${now.toISOString()}
    FROM consumer_balance_reservations
    WHERE reservation_id = ${input.reservation_id}
      AND owner_commitment = ${input.owner_commitment}
      AND status = 'submitted'
    ON CONFLICT (venue_order_id) DO UPDATE SET venue_order_id = EXCLUDED.venue_order_id
    RETURNING *
  ` as Array<Record<string, unknown>>;
  return rows[0] ? venueOrderRow(rows[0]) : null;
}

export async function getConsumerVenueOrder(input: {
  venue_order_id: string;
  owner_commitment?: string;
}): Promise<ConsumerVenueOrder | null> {
  const sql = await getSql();
  if (!sql) {
    const order = memory.venueOrders.get(input.venue_order_id);
    return order && (!input.owner_commitment || order.owner_commitment === input.owner_commitment) ? order : null;
  }
  await ensureSchema(sql);
  const rows = (input.owner_commitment
    ? await sql`SELECT * FROM consumer_venue_orders WHERE venue_order_id = ${input.venue_order_id} AND owner_commitment = ${input.owner_commitment} LIMIT 1`
    : await sql`SELECT * FROM consumer_venue_orders WHERE venue_order_id = ${input.venue_order_id} LIMIT 1`) as Array<Record<string, unknown>>;
  return rows[0] ? venueOrderRow(rows[0] as Record<string, unknown>) : null;
}

export async function getConsumerReconciliationCheckpoint(input: {
  venue_order_id: string;
  owner_commitment: string;
}): Promise<ConsumerReconciliationCheckpoint | null> {
  const order = await getConsumerVenueOrder(input);
  if (!order) return null;
  const sql = await getSql();
  if (!sql) return memory.reconciliation.get(input.venue_order_id) ?? null;
  await ensureSchema(sql);
  const rows = await sql`
    SELECT c.* FROM consumer_reconciliation_checkpoints c
    JOIN consumer_venue_orders o USING (venue_order_id)
    WHERE c.venue_order_id = ${input.venue_order_id} AND o.owner_commitment = ${input.owner_commitment}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  return rows[0] ? reconciliationRow(rows[0]) : null;
}

export async function reconcileConsumerVenueOrder(input: {
  venue_order_id: string;
  venue_fill_reference: string;
  filled_notional_micro_usdc: number;
  venue_cost_micro_usdc: number;
  ghola_fee_micro_usdc: number;
  final_status: "filled" | "partially_filled" | "unfilled" | "failed";
  filled_at: Date;
  now?: Date;
}): Promise<
  | { ok: true; order: ConsumerVenueOrder; fill: ConsumerVenueFill | null; checkpoint: ConsumerReconciliationCheckpoint; balance: ConsumerBalanceSnapshot }
  | { ok: false; error: "venue_order_not_found" | "already_reconciled" | "settlement_exceeds_reservation" | "unfilled_fee_forbidden" }
> {
  const filled = nonnegativeAmount(input.filled_notional_micro_usdc);
  const venueCost = nonnegativeAmount(input.venue_cost_micro_usdc);
  const gholaFee = nonnegativeAmount(input.ghola_fee_micro_usdc);
  if (filled === 0 && gholaFee !== 0) return { ok: false, error: "unfilled_fee_forbidden" };
  const now = input.now ?? new Date();
  const fillReferenceCommitment = consumerCommitment("venue_fill_reference", input.venue_fill_reference);
  const sql = await getSql();
  if (!sql) {
    return memoryCritical(async () => {
      const order = memory.venueOrders.get(input.venue_order_id);
      if (!order) return { ok: false as const, error: "venue_order_not_found" as const };
      if (order.reconciled_at || memory.reconciliation.has(order.venue_order_id)) return { ok: false as const, error: "already_reconciled" as const };
      const reservation = memory.reservations.get(order.reservation_id);
      if (!reservation || reservation.status !== "submitted") return { ok: false as const, error: "already_reconciled" as const };
      const settled = filled + venueCost + gholaFee;
      if (settled > reservation.reserved_micro_usdc) return { ok: false as const, error: "settlement_exceeds_reservation" as const };
      const unused = reservation.reserved_micro_usdc - settled;
      const prior = memoryBalance(reservation);
      const balance = {
        ...prior,
        available_micro_usdc: prior.available_micro_usdc + unused,
        reserved_micro_usdc: prior.reserved_micro_usdc - reservation.reserved_micro_usdc,
        open_notional_micro_usdc: prior.open_notional_micro_usdc + filled,
        updated_at: now.toISOString(),
      };
      memory.balances.set(order.account_commitment, balance);
      memory.reservations.set(reservation.reservation_id, { ...reservation, status: "settled", updated_at: now.toISOString() });
      const reconciledOrder = { ...order, status: input.final_status, reconciled_at: now.toISOString() };
      memory.venueOrders.set(order.venue_order_id, reconciledOrder);
      const fill = filled > 0 ? newVenueFill(order, input, fillReferenceCommitment, gholaFee) : null;
      if (fill) memory.venueFills.set(fill.venue_fill_id, fill);
      const checkpoint = newReconciliationCheckpoint(order, now);
      memory.reconciliation.set(order.venue_order_id, checkpoint);
      putMemoryLedger(reservation, "fill_settlement", `settle:${order.venue_order_id}`, order.venue_order_id, settlementPostings(reservation.reserved_micro_usdc, filled, venueCost, gholaFee), now);
      return { ok: true as const, order: reconciledOrder, fill, checkpoint, balance };
    });
  }
  await ensureSchema(sql);
  const total = filled + venueCost + gholaFee;
  const rows = await sql`
    WITH lock_guard AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${input.venue_order_id}, 0))
    ), target AS (
      SELECT o.*, r.reserved_micro_usdc
      FROM consumer_venue_orders o
      JOIN consumer_balance_reservations r USING (reservation_id), lock_guard
      WHERE o.venue_order_id = ${input.venue_order_id}
        AND o.reconciled_at IS NULL
        AND r.status = 'submitted'
        AND r.reserved_micro_usdc >= ${total}
      FOR UPDATE OF o, r
    ), reservation AS (
      UPDATE consumer_balance_reservations r
      SET status = 'settled', updated_at = ${now.toISOString()}
      FROM target t
      WHERE r.reservation_id = t.reservation_id
      RETURNING r.*
    ), balance AS (
      UPDATE consumer_balance_accounts b
      SET available_micro_usdc = b.available_micro_usdc + (r.reserved_micro_usdc - ${total}),
          reserved_micro_usdc = b.reserved_micro_usdc - r.reserved_micro_usdc,
          open_notional_micro_usdc = b.open_notional_micro_usdc + ${filled},
          updated_at = ${now.toISOString()}
      FROM reservation r
      WHERE b.account_commitment = r.account_commitment
        AND b.reserved_micro_usdc >= r.reserved_micro_usdc
      RETURNING b.*
    ), updated_order AS (
      UPDATE consumer_venue_orders o
      SET status = ${input.final_status}, reconciled_at = ${now.toISOString()}
      FROM target t
      WHERE o.venue_order_id = t.venue_order_id
      RETURNING o.*
    ), fill AS (
      INSERT INTO consumer_venue_fills (
        venue_fill_id, venue_order_id, venue_fill_reference_commitment, filled_notional_micro_usdc,
        venue_cost_micro_usdc, ghola_fee_micro_usdc, filled_at
      )
      SELECT ${consumerCommitment("venue_fill", { order: input.venue_order_id, reference: fillReferenceCommitment })},
        ${input.venue_order_id}, ${fillReferenceCommitment}, ${filled}, ${venueCost}, ${gholaFee}, ${input.filled_at.toISOString()}
      WHERE ${filled} > 0
      RETURNING *
    ), checkpoint AS (
      INSERT INTO consumer_reconciliation_checkpoints (
        checkpoint_id, venue_order_id, reservation_id, status, drift_micro_usdc, reconciled_at
      ) SELECT ${consumerCommitment("reconciliation", input.venue_order_id)}, o.venue_order_id, o.reservation_id,
        'reconciled', 0, ${now.toISOString()}
      FROM updated_order o RETURNING *
    ), ledger AS (
      INSERT INTO consumer_ledger_transactions (
        transaction_id, owner_commitment, account_commitment, idempotency_key, kind,
        reference_commitment, postings, created_at
      ) SELECT ${consumerCommitment("ledger", { order: input.venue_order_id, action: "settle" })},
        r.owner_commitment, r.account_commitment, ${`settle:${input.venue_order_id}`}, 'fill_settlement',
        ${input.venue_order_id}, jsonb_path_query_array(jsonb_build_array(
          jsonb_build_object('account', 'consumer_reserved', 'side', 'debit', 'amount_micro_usdc', r.reserved_micro_usdc),
          CASE WHEN (r.reserved_micro_usdc - ${total}) > 0 THEN jsonb_build_object('account', 'consumer_available', 'side', 'credit', 'amount_micro_usdc', r.reserved_micro_usdc - ${total}) END,
          CASE WHEN ${filled + venueCost} > 0 THEN jsonb_build_object('account', 'venue_clearing', 'side', 'credit', 'amount_micro_usdc', ${filled + venueCost}) END,
          CASE WHEN ${gholaFee} > 0 THEN jsonb_build_object('account', 'fee_revenue', 'side', 'credit', 'amount_micro_usdc', ${gholaFee}) END
        ), '$[*] ? (@ != null)'), ${now.toISOString()}
      FROM reservation r RETURNING transaction_id
    )
    SELECT row_to_json(o) AS order_record, row_to_json(b) AS balance_record,
      (SELECT row_to_json(f) FROM fill f LIMIT 1) AS fill_record,
      (SELECT row_to_json(c) FROM checkpoint c LIMIT 1) AS checkpoint_record,
      r.reserved_micro_usdc
    FROM updated_order o JOIN reservation r USING (reservation_id) JOIN balance b USING (account_commitment)
  ` as Array<Record<string, unknown>>;
  if (!rows[0]) {
    const existing = await sql`SELECT o.reconciled_at, r.reserved_micro_usdc FROM consumer_venue_orders o JOIN consumer_balance_reservations r USING (reservation_id) WHERE o.venue_order_id = ${input.venue_order_id} LIMIT 1` as Array<Record<string, unknown>>;
    if (!existing[0]) return { ok: false, error: "venue_order_not_found" };
    if (existing[0].reconciled_at) return { ok: false, error: "already_reconciled" };
    return { ok: false, error: "settlement_exceeds_reservation" };
  }
  const row = rows[0];
  const orderRecord = row.order_record as Record<string, unknown>;
  const balanceRecord = row.balance_record as Record<string, unknown>;
  return {
    ok: true,
    order: venueOrderRow(orderRecord),
    fill: row.fill_record ? venueFillRow(row.fill_record as Record<string, unknown>) : null,
    checkpoint: reconciliationRow(row.checkpoint_record as Record<string, unknown>),
    balance: balanceRow(balanceRecord, { owner_commitment: String(orderRecord.owner_commitment), account_commitment: String(orderRecord.account_commitment) }),
  };
}

export async function listConsumerLedger(input: {
  owner_commitment: string;
  account_commitment: string;
  limit?: number;
}): Promise<ConsumerLedgerTransaction[]> {
  const limit = Math.max(1, Math.min(250, input.limit ?? 100));
  const sql = await getSql();
  if (!sql) {
    return Array.from(memory.ledger.values())
      .filter((item) => item.owner_commitment === input.owner_commitment && item.account_commitment === input.account_commitment)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, limit);
  }
  await ensureSchema(sql);
  const rows = await sql`
    SELECT * FROM consumer_ledger_transactions
    WHERE owner_commitment = ${input.owner_commitment} AND account_commitment = ${input.account_commitment}
    ORDER BY created_at DESC LIMIT ${limit}
  ` as Array<Record<string, unknown>>;
  return rows.map(ledgerRow);
}

export async function putConsumerRiskPolicy(record: ConsumerRiskPolicy): Promise<ConsumerRiskPolicy> {
  const sql = await getSql();
  if (!sql) {
    memory.policies.set(record.owner_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO consumer_risk_policies (
      owner_commitment, account_commitment, max_order_micro_usdc, max_daily_notional_micro_usdc,
      max_position_micro_usdc, max_slippage_bps, market_allowlist, updated_at
    ) VALUES (
      ${record.owner_commitment}, ${record.account_commitment}, ${record.max_order_micro_usdc}, ${record.max_daily_notional_micro_usdc},
      ${record.max_position_micro_usdc}, ${record.max_slippage_bps}, ${JSON.stringify(record.market_allowlist)}::jsonb, ${record.updated_at}
    ) ON CONFLICT (owner_commitment) DO UPDATE SET
      account_commitment = EXCLUDED.account_commitment,
      max_order_micro_usdc = EXCLUDED.max_order_micro_usdc,
      max_daily_notional_micro_usdc = EXCLUDED.max_daily_notional_micro_usdc,
      max_position_micro_usdc = EXCLUDED.max_position_micro_usdc,
      max_slippage_bps = EXCLUDED.max_slippage_bps,
      market_allowlist = EXCLUDED.market_allowlist,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getConsumerRiskPolicy(ownerCommitment: string): Promise<ConsumerRiskPolicy | null> {
  const sql = await getSql();
  if (!sql) return memory.policies.get(ownerCommitment) ?? null;
  await ensureSchema(sql);
  const rows = await sql`SELECT * FROM consumer_risk_policies WHERE owner_commitment = ${ownerCommitment} LIMIT 1` as Array<Record<string, unknown>>;
  if (!rows[0]) return null;
  return {
    version: 1,
    owner_commitment: String(rows[0].owner_commitment),
    account_commitment: String(rows[0].account_commitment),
    max_order_micro_usdc: Number(rows[0].max_order_micro_usdc),
    max_daily_notional_micro_usdc: Number(rows[0].max_daily_notional_micro_usdc),
    max_position_micro_usdc: Number(rows[0].max_position_micro_usdc),
    max_slippage_bps: Number(rows[0].max_slippage_bps),
    market_allowlist: jsonStrings(rows[0].market_allowlist),
    updated_at: dateString(rows[0].updated_at),
  };
}

export async function getConsumerCircuitState(): Promise<ConsumerCircuitState> {
  const fallback: ConsumerCircuitState = {
    version: 1,
    status: "open",
    reasons: [],
    halted_at: null,
    resumed_at: null,
    acknowledged_by: null,
    consecutive_green_canaries: 0,
    updated_at: new Date().toISOString(),
  };
  const sql = await getSql();
  if (!sql) return memory.circuit ?? fallback;
  await ensureSchema(sql);
  const rows = await sql`SELECT * FROM consumer_circuit_state WHERE circuit_id = 'pooled_trading' LIMIT 1` as Array<Record<string, unknown>>;
  if (!rows[0]) return fallback;
  return circuitRow(rows[0]);
}

export async function haltConsumerCircuit(input: {
  reasons: ConsumerCircuitReason[];
  acknowledged_by?: string | null;
  now?: Date;
}): Promise<ConsumerCircuitState> {
  const now = (input.now ?? new Date()).toISOString();
  const current = await getConsumerCircuitState();
  const state: ConsumerCircuitState = {
    ...current,
    status: "halted",
    reasons: Array.from(new Set([...current.reasons, ...input.reasons])),
    halted_at: current.halted_at ?? now,
    acknowledged_by: input.acknowledged_by ?? current.acknowledged_by,
    consecutive_green_canaries: 0,
    updated_at: now,
  };
  await putCircuit(state);
  return state;
}

export async function resumeConsumerCircuit(input: {
  acknowledged_by: string;
  reconciliation_drift_micro_usdc: number;
  consecutive_green_canaries: number;
  now?: Date;
}): Promise<ConsumerCircuitState | { error: "circuit_resume_requirements_not_met" }> {
  if (input.reconciliation_drift_micro_usdc !== 0 || input.consecutive_green_canaries < 2 || !input.acknowledged_by.trim()) {
    return { error: "circuit_resume_requirements_not_met" };
  }
  const now = (input.now ?? new Date()).toISOString();
  const state: ConsumerCircuitState = {
    version: 1,
    status: "open",
    reasons: [],
    halted_at: null,
    resumed_at: now,
    acknowledged_by: input.acknowledged_by,
    consecutive_green_canaries: input.consecutive_green_canaries,
    updated_at: now,
  };
  await putCircuit(state);
  return state;
}

async function putCircuit(state: ConsumerCircuitState) {
  const sql = await getSql();
  if (!sql) {
    memory.circuit = state;
    return;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO consumer_circuit_state (
      circuit_id, status, reasons, halted_at, resumed_at, acknowledged_by,
      consecutive_green_canaries, updated_at
    ) VALUES (
      'pooled_trading', ${state.status}, ${JSON.stringify(state.reasons)}::jsonb, ${state.halted_at}, ${state.resumed_at},
      ${state.acknowledged_by}, ${state.consecutive_green_canaries}, ${state.updated_at}
    ) ON CONFLICT (circuit_id) DO UPDATE SET
      status = EXCLUDED.status, reasons = EXCLUDED.reasons, halted_at = EXCLUDED.halted_at,
      resumed_at = EXCLUDED.resumed_at, acknowledged_by = EXCLUDED.acknowledged_by,
      consecutive_green_canaries = EXCLUDED.consecutive_green_canaries, updated_at = EXCLUDED.updated_at
  `;
}

export function resetConsumerProductionStoreForTests() {
  memory.nonces.clear();
  memory.rates.clear();
  memory.wallets.clear();
  memory.acceptances.clear();
  memory.deposits.clear();
  memory.balances.clear();
  memory.ledger.clear();
  memory.reservations.clear();
  memory.policies.clear();
  memory.wakeJobs.clear();
  memory.withdrawals.clear();
  memory.circuit = null;
  if (!shouldUsePostgres()) {
    sqlClient = null;
    schemaReady = false;
  }
}

async function getSql(): Promise<NeonSql | null> {
  if (!shouldUsePostgres()) return null;
  if (sqlClient) return sqlClient;
  const url = process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  const { neon } = await import("@neondatabase/serverless");
  sqlClient = neon(url);
  return sqlClient;
}

function shouldUsePostgres() {
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE === "memory") return false;
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE === "postgres") return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function productionLike() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production" || process.env.SECURITY_PROFILE === "prod";
}

async function ensureSchema(sql: NeonSql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_request_nonces (
      nonce_key TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_rate_limits (
      rate_key TEXT NOT NULL,
      bucket_start TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL,
      PRIMARY KEY (rate_key, bucket_start)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_wallet_bindings (
      owner_commitment TEXT PRIMARY KEY,
      account_commitment TEXT NOT NULL,
      wallet_pubkey TEXT NOT NULL,
      wallet_commitment TEXT NOT NULL UNIQUE,
      bound_at TIMESTAMPTZ NOT NULL,
      withdrawal_hold_until TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_eligibility_acceptances (
      owner_commitment TEXT PRIMARY KEY,
      terms_version TEXT NOT NULL,
      risk_version TEXT NOT NULL,
      not_prohibited_person BOOLEAN NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_deposit_intents (
      deposit_intent_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      rail TEXT NOT NULL,
      expected_wallet_pubkey TEXT,
      amount_micro_usdc BIGINT NOT NULL CHECK (amount_micro_usdc > 0),
      status TEXT NOT NULL,
      transaction_signature TEXT UNIQUE,
      nullifier_commitment TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      UNIQUE (owner_commitment, idempotency_key)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_balance_accounts (
      account_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL UNIQUE,
      available_micro_usdc BIGINT NOT NULL DEFAULT 0 CHECK (available_micro_usdc >= 0),
      reserved_micro_usdc BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micro_usdc >= 0),
      open_notional_micro_usdc BIGINT NOT NULL DEFAULT 0 CHECK (open_notional_micro_usdc >= 0),
      realized_pnl_micro_usdc BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_ledger_transactions (
      transaction_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      reference_commitment TEXT,
      postings JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_balance_reservations (
      reservation_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      venue_id TEXT NOT NULL,
      notional_micro_usdc BIGINT NOT NULL CHECK (notional_micro_usdc > 0),
      venue_cost_reserve_micro_usdc BIGINT NOT NULL DEFAULT 0 CHECK (venue_cost_reserve_micro_usdc >= 0),
      fee_micro_usdc BIGINT NOT NULL CHECK (fee_micro_usdc > 0),
      reserved_micro_usdc BIGINT NOT NULL CHECK (reserved_micro_usdc > 0),
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`ALTER TABLE consumer_balance_reservations ADD COLUMN IF NOT EXISTS venue_cost_reserve_micro_usdc BIGINT NOT NULL DEFAULT 0 CHECK (venue_cost_reserve_micro_usdc >= 0)`;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_venue_orders (
      venue_order_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE REFERENCES consumer_balance_reservations(reservation_id),
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      venue_id TEXT NOT NULL,
      market TEXT NOT NULL,
      work_order_commitment TEXT NOT NULL UNIQUE,
      worker_receipt_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL,
      reconciled_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_venue_fills (
      venue_fill_id TEXT PRIMARY KEY,
      venue_order_id TEXT NOT NULL REFERENCES consumer_venue_orders(venue_order_id),
      venue_fill_reference_commitment TEXT NOT NULL UNIQUE,
      filled_notional_micro_usdc BIGINT NOT NULL CHECK (filled_notional_micro_usdc > 0),
      venue_cost_micro_usdc BIGINT NOT NULL CHECK (venue_cost_micro_usdc >= 0),
      ghola_fee_micro_usdc BIGINT NOT NULL CHECK (ghola_fee_micro_usdc >= 0),
      filled_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_reconciliation_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      venue_order_id TEXT NOT NULL UNIQUE REFERENCES consumer_venue_orders(venue_order_id),
      reservation_id TEXT NOT NULL UNIQUE REFERENCES consumer_balance_reservations(reservation_id),
      status TEXT NOT NULL,
      drift_micro_usdc BIGINT NOT NULL,
      reconciled_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_risk_policies (
      owner_commitment TEXT PRIMARY KEY,
      account_commitment TEXT NOT NULL,
      max_order_micro_usdc BIGINT NOT NULL,
      max_daily_notional_micro_usdc BIGINT NOT NULL,
      max_position_micro_usdc BIGINT NOT NULL,
      max_slippage_bps INTEGER NOT NULL,
      market_allowlist JSONB NOT NULL,
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
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_wake_jobs (
      wake_job_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS consumer_withdrawals (
      withdrawal_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      destination_wallet_commitment TEXT NOT NULL,
      amount_micro_usdc BIGINT NOT NULL CHECK (amount_micro_usdc > 0),
      status TEXT NOT NULL,
      transaction_signature TEXT UNIQUE,
      prepared_message_commitment TEXT,
      prepared_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`ALTER TABLE consumer_withdrawals ADD COLUMN IF NOT EXISTS prepared_message_commitment TEXT`;
  await sql`ALTER TABLE consumer_withdrawals ADD COLUMN IF NOT EXISTS prepared_expires_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS idx_consumer_ledger_account_created ON consumer_ledger_transactions (account_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_consumer_deposits_owner_created ON consumer_deposit_intents (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_consumer_nonces_expiry ON consumer_request_nonces (expires_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_consumer_wake_owner_status ON consumer_wake_jobs (owner_commitment, status, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_consumer_orders_owner_submitted ON consumer_venue_orders (owner_commitment, submitted_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_consumer_orders_unreconciled ON consumer_venue_orders (submitted_at) WHERE reconciled_at IS NULL`;
  schemaReady = true;
}

async function ensureBalanceRow(sql: NeonSql, input: { owner_commitment: string; account_commitment: string }) {
  await sql`
    INSERT INTO consumer_balance_accounts (account_commitment, owner_commitment)
    VALUES (${input.account_commitment}, ${input.owner_commitment})
    ON CONFLICT DO NOTHING
  `;
}

function memoryBalance(input: { owner_commitment: string; account_commitment: string }): ConsumerBalanceSnapshot {
  return memory.balances.get(input.account_commitment) ?? {
    version: 1,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    available_micro_usdc: 0,
    reserved_micro_usdc: 0,
    open_notional_micro_usdc: 0,
    realized_pnl_micro_usdc: 0,
    updated_at: null,
  };
}

function putMemoryLedger(
  input: { owner_commitment: string; account_commitment: string },
  kind: ConsumerLedgerKind,
  idempotencyKey: string,
  reference: string,
  postings: ConsumerLedgerPosting[],
  now: Date,
) {
  const record: ConsumerLedgerTransaction = {
    version: 1,
    transaction_id: consumerCommitment("ledger", { account: input.account_commitment, key: idempotencyKey }),
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    idempotency_key: idempotencyKey,
    kind,
    reference_commitment: reference,
    postings,
    created_at: now.toISOString(),
  };
  memory.ledger.set(record.idempotency_key, record);
}

function walletRow(row: Record<string, unknown>): ConsumerWalletBinding {
  return {
    version: 1,
    owner_commitment: String(row.owner_commitment),
    account_commitment: String(row.account_commitment),
    wallet_pubkey: String(row.wallet_pubkey),
    wallet_commitment: String(row.wallet_commitment),
    bound_at: dateString(row.bound_at),
    withdrawal_hold_until: dateString(row.withdrawal_hold_until),
    updated_at: dateString(row.updated_at),
  };
}

function depositRow(row: Record<string, unknown>): ConsumerDepositIntent {
  return {
    version: 1,
    deposit_intent_id: String(row.deposit_intent_id),
    owner_commitment: String(row.owner_commitment),
    account_commitment: String(row.account_commitment),
    rail: row.rail === "solana_shielded_usdcx" ? "solana_shielded_usdcx" : "solana_usdc",
    expected_wallet_pubkey: typeof row.expected_wallet_pubkey === "string" ? row.expected_wallet_pubkey : null,
    amount_micro_usdc: Number(row.amount_micro_usdc),
    status: String(row.status) as ConsumerDepositIntent["status"],
    transaction_signature: typeof row.transaction_signature === "string" ? row.transaction_signature : null,
    nullifier_commitment: typeof row.nullifier_commitment === "string" ? row.nullifier_commitment : null,
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
    confirmed_at: row.confirmed_at ? dateString(row.confirmed_at) : null,
  };
}

function balanceRow(row: Record<string, unknown> | undefined, fallback: { owner_commitment: string; account_commitment: string }): ConsumerBalanceSnapshot {
  return {
    version: 1,
    owner_commitment: String(row?.owner_commitment ?? fallback.owner_commitment),
    account_commitment: String(row?.account_commitment ?? fallback.account_commitment),
    available_micro_usdc: Number(row?.available_micro_usdc ?? 0),
    reserved_micro_usdc: Number(row?.reserved_micro_usdc ?? 0),
    open_notional_micro_usdc: Number(row?.open_notional_micro_usdc ?? 0),
    realized_pnl_micro_usdc: Number(row?.realized_pnl_micro_usdc ?? 0),
    updated_at: row?.updated_at ? dateString(row.updated_at) : null,
  };
}

function ledgerRow(row: Record<string, unknown>): ConsumerLedgerTransaction {
  return {
    version: 1,
    transaction_id: String(row.transaction_id),
    owner_commitment: String(row.owner_commitment),
    account_commitment: String(row.account_commitment),
    idempotency_key: String(row.idempotency_key),
    kind: String(row.kind) as ConsumerLedgerKind,
    reference_commitment: typeof row.reference_commitment === "string" ? row.reference_commitment : null,
    postings: Array.isArray(row.postings) ? row.postings as ConsumerLedgerPosting[] : [],
    created_at: dateString(row.created_at),
  };
}

function circuitRow(row: Record<string, unknown>): ConsumerCircuitState {
  return {
    version: 1,
    status: row.status === "halted" ? "halted" : "open",
    reasons: jsonStrings(row.reasons) as ConsumerCircuitReason[],
    halted_at: row.halted_at ? dateString(row.halted_at) : null,
    resumed_at: row.resumed_at ? dateString(row.resumed_at) : null,
    acknowledged_by: typeof row.acknowledged_by === "string" ? row.acknowledged_by : null,
    consecutive_green_canaries: Number(row.consecutive_green_canaries ?? 0),
    updated_at: dateString(row.updated_at),
  };
}

function newWakeJob(ownerCommitment: string, now: Date): ConsumerWakeJob {
  return {
    version: 1,
    wake_job_id: consumerCommitment("wake", { owner: ownerCommitment, at: now.toISOString() }),
    owner_commitment: ownerCommitment,
    status: "queued",
    provider: "phala",
    error_code: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
  };
}

function wakeJobRow(row: Record<string, unknown>): ConsumerWakeJob {
  return {
    version: 1,
    wake_job_id: String(row.wake_job_id),
    owner_commitment: String(row.owner_commitment),
    status: String(row.status) as ConsumerWakeJob["status"],
    provider: "phala",
    error_code: typeof row.error_code === "string" ? row.error_code : null,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
    expires_at: dateString(row.expires_at),
  };
}

function withdrawalRow(row: Record<string, unknown>): ConsumerWithdrawal {
  return {
    version: 1,
    withdrawal_id: String(row.withdrawal_id),
    owner_commitment: String(row.owner_commitment),
    account_commitment: String(row.account_commitment),
    idempotency_key: String(row.idempotency_key),
    destination_wallet_commitment: String(row.destination_wallet_commitment),
    amount_micro_usdc: Number(row.amount_micro_usdc),
    status: String(row.status) as ConsumerWithdrawal["status"],
    transaction_signature: typeof row.transaction_signature === "string" ? row.transaction_signature : null,
    prepared_message_commitment: typeof row.prepared_message_commitment === "string" ? row.prepared_message_commitment : null,
    prepared_expires_at: row.prepared_expires_at ? dateString(row.prepared_expires_at) : null,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function validWithdrawalTransition(from: ConsumerWithdrawal["status"], to: ConsumerWithdrawal["status"]) {
  if (to === "submitted") return from === "queued";
  if (to === "finalized") return from === "submitted";
  if (to === "failed_review") return from === "queued" || from === "submitted";
  return false;
}

function venueOrderFromReservation(
  reservation: ConsumerBalanceReservation,
  input: { market: string; work_order_commitment: string; worker_receipt: unknown },
  now: Date,
): ConsumerVenueOrder {
  return {
    version: 1,
    venue_order_id: consumerCommitment("venue_order", reservation.reservation_id),
    reservation_id: reservation.reservation_id,
    owner_commitment: reservation.owner_commitment,
    account_commitment: reservation.account_commitment,
    venue_id: reservation.venue_id,
    market: input.market,
    work_order_commitment: input.work_order_commitment,
    worker_receipt_commitment: consumerCommitment("worker_receipt", input.worker_receipt),
    status: "submitted",
    submitted_at: now.toISOString(),
    reconciled_at: null,
  };
}

function venueOrderRow(row: Record<string, unknown>): ConsumerVenueOrder {
  return {
    version: 1,
    venue_order_id: String(row.venue_order_id),
    reservation_id: String(row.reservation_id),
    owner_commitment: String(row.owner_commitment),
    account_commitment: String(row.account_commitment),
    venue_id: row.venue_id === "hyperliquid" ? "hyperliquid" : "phoenix",
    market: String(row.market),
    work_order_commitment: String(row.work_order_commitment),
    worker_receipt_commitment: String(row.worker_receipt_commitment),
    status: String(row.status) as ConsumerVenueOrder["status"],
    submitted_at: dateString(row.submitted_at),
    reconciled_at: row.reconciled_at ? dateString(row.reconciled_at) : null,
  };
}

function newVenueFill(
  order: ConsumerVenueOrder,
  input: { venue_fill_reference: string; filled_notional_micro_usdc: number; venue_cost_micro_usdc: number; filled_at: Date },
  referenceCommitment: string,
  gholaFee: number,
): ConsumerVenueFill {
  return {
    version: 1,
    venue_fill_id: consumerCommitment("venue_fill", { order: order.venue_order_id, reference: referenceCommitment }),
    venue_order_id: order.venue_order_id,
    venue_fill_reference_commitment: referenceCommitment,
    filled_notional_micro_usdc: input.filled_notional_micro_usdc,
    venue_cost_micro_usdc: input.venue_cost_micro_usdc,
    ghola_fee_micro_usdc: gholaFee,
    filled_at: input.filled_at.toISOString(),
  };
}

function venueFillRow(row: Record<string, unknown>): ConsumerVenueFill {
  return {
    version: 1,
    venue_fill_id: String(row.venue_fill_id),
    venue_order_id: String(row.venue_order_id),
    venue_fill_reference_commitment: String(row.venue_fill_reference_commitment),
    filled_notional_micro_usdc: Number(row.filled_notional_micro_usdc),
    venue_cost_micro_usdc: Number(row.venue_cost_micro_usdc),
    ghola_fee_micro_usdc: Number(row.ghola_fee_micro_usdc),
    filled_at: dateString(row.filled_at),
  };
}

function newReconciliationCheckpoint(order: ConsumerVenueOrder, now: Date): ConsumerReconciliationCheckpoint {
  return {
    version: 1,
    checkpoint_id: consumerCommitment("reconciliation", order.venue_order_id),
    venue_order_id: order.venue_order_id,
    reservation_id: order.reservation_id,
    status: "reconciled",
    drift_micro_usdc: 0,
    reconciled_at: now.toISOString(),
  };
}

function reconciliationRow(row: Record<string, unknown>): ConsumerReconciliationCheckpoint {
  return {
    version: 1,
    checkpoint_id: String(row.checkpoint_id),
    venue_order_id: String(row.venue_order_id),
    reservation_id: String(row.reservation_id),
    status: "reconciled",
    drift_micro_usdc: 0,
    reconciled_at: dateString(row.reconciled_at),
  };
}

function settlementPostings(reserved: number, filled: number, venueCost: number, gholaFee: number): ConsumerLedgerPosting[] {
  const credits: ConsumerLedgerPosting[] = [];
  const unused = reserved - filled - venueCost - gholaFee;
  if (unused > 0) credits.push({ account: "consumer_available", side: "credit", amount_micro_usdc: unused });
  if (filled + venueCost > 0) credits.push({ account: "venue_clearing", side: "credit", amount_micro_usdc: filled + venueCost });
  if (gholaFee > 0) credits.push({ account: "fee_revenue", side: "credit", amount_micro_usdc: gholaFee });
  return balancedPostings([
    { account: "consumer_reserved", side: "debit", amount_micro_usdc: reserved },
    ...credits,
  ]);
}

function positiveAmount(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("amount_micro_usdc_invalid");
  return value;
}

function nonnegativeAmount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("amount_micro_usdc_invalid");
  return value;
}

function dateString(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function jsonStrings(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function pruneMemory(now = Date.now()) {
  for (const [key, expiresAt] of memory.nonces) if (expiresAt <= now) memory.nonces.delete(key);
  for (const [key, bucket] of memory.rates) if (bucket.resetAt <= now) memory.rates.delete(key);
}

async function memoryCritical<T>(work: () => Promise<T>): Promise<T> {
  const previous = memoryQueue;
  let release!: () => void;
  memoryQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
