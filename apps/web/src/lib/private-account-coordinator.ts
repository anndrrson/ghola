import {
  DEFAULT_ANONYMITY_SET_POLICY,
  gholaCommitment,
  type GholaAnonymitySetSummary,
  type GholaPrivateModeEvidenceChain,
} from "./private-account";
import {
  getLatestPrivateFundingBatchRun,
  acquirePrivateCoordinatorLock,
  getPrivateAccountIntent,
  getPrivateCoordinatorLock,
  getQueuedAction,
  listAllPrivateFundingImports,
  listAllQueuedActions,
  listCompatibleFundingImports,
  listPrivateFundingImports,
  putAnonymityEvidence,
  putPrivateFundingBatch,
  putPrivateFundingBatchRun,
  releasePrivateCoordinatorLock,
  updateQueuedActionStatus,
  type PrivateFundingBatchRecordV1,
  type PrivateFundingBatchRunRecordV1,
  type PrivateFundingImportRecordV1,
  type PrivateQueuedActionRecordV1,
  type PrivateCoordinatorLockRecordV1,
} from "./private-account-store";
import { customShieldedVerifierHealth, verifierConfig } from "./private-account-verifier";
import { shieldedPoolHealth } from "./private-account-shielded-pool";

export interface PrivateModeCoordinatorHealth {
  version: 1;
  status: "green" | "red";
  last_run_commitment: string | null;
  last_run_at: string | null;
  max_stale_ms: number;
  reason: string | null;
  run: PrivateFundingBatchRunRecordV1 | null;
  lock: PrivateCoordinatorLockRecordV1 | null;
}

export interface PrivateFundingBatchCoordinatorResult {
  version: 1;
  run: PrivateFundingBatchRunRecordV1;
  batches: PrivateFundingBatchRecordV1[];
}

export async function runPrivateFundingBatchCoordinator(input: {
  owner_commitment?: string;
  queue_id?: string;
  now?: Date;
  limit?: number;
} = {}): Promise<PrivateFundingBatchCoordinatorResult> {
  const now = input.now ?? new Date();
  const runWindowCommitment = coordinatorRunWindowCommitment(now, input);
  const lock = await acquirePrivateCoordinatorLock({
    lock_id: "private_funding_batch_coordinator",
    run_window_commitment: runWindowCommitment,
    now,
    ttl_ms: coordinatorLockTtlMs(),
  });
  if (!lock.acquired) {
    const latest = await getLatestPrivateFundingBatchRun();
    if (latest) return { version: 1, run: latest, batches: [] };
  }
  const runSeed = {
    run_window_commitment: runWindowCommitment,
    owner_commitment: input.owner_commitment ?? null,
    queue_id: input.queue_id ?? null,
  };
  const [verifierHealth, poolHealth] = await Promise.all([
    customShieldedVerifierHealth(now),
    shieldedPoolHealth(now),
  ]);
  if (verifierHealth.status !== "green" || poolHealth.status !== "green") {
    const run = await putPrivateFundingBatchRun({
      version: 1,
      run_id: gholaCommitment("batch_run", runSeed),
      coordinator_commitment: gholaCommitment("batch_coordinator", "private-mode-v2"),
      status: "unhealthy",
      accounts_scanned: 0,
      queues_scanned: 0,
      imports_scanned: 0,
      batches_written: 0,
      evidence_written: 0,
      stale_imports: 0,
      rejected_imports: 0,
      error: verifierHealth.reason || poolHealth.reason || "verifier or shielded pool health is not green",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    await releasePrivateCoordinatorLock("private_funding_batch_coordinator", runWindowCommitment);
    return { version: 1, run, batches: [] };
  }

  const queues = await coordinatorQueues(input);
  const imports = input.owner_commitment
    ? await listPrivateFundingImports(input.owner_commitment, input.limit ?? 200)
    : await listAllPrivateFundingImports(input.limit ?? 1_000);
  const importTargets = targetImports(imports);
  const queueTargets = queues
    .filter((queue) => queue.status === "queued" || queue.status === "ready")
    .map((queue) => ({ queue, selected: latestVerifiedImport(imports, queue.owner_commitment) }))
    .filter((item): item is { queue: PrivateQueuedActionRecordV1; selected: PrivateFundingImportRecordV1 } =>
      Boolean(item.selected));
  const seen = new Set<string>();
  const batches: PrivateFundingBatchRecordV1[] = [];
  let evidenceWritten = 0;
  let staleImports = 0;
  let rejectedImports = 0;

  for (const target of [
    ...queueTargets.map((item) => ({ selected: item.selected, queue: item.queue })),
    ...importTargets.map((selected) => ({ selected, queue: null })),
  ]) {
    const key = [
      target.selected.account_commitment,
      target.selected.asset_bucket,
      target.selected.amount_bucket,
      target.selected.network,
      target.queue?.queue_id ?? "account",
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const coordinated = await coordinateOne({
      selected: target.selected,
      queue: target.queue,
      now,
    });
    staleImports += coordinated.stale_imports;
    rejectedImports += coordinated.rejected_imports;
    if (coordinated.batch) {
      batches.push(coordinated.batch);
      if (coordinated.batch.evidence_commitment) evidenceWritten += 1;
      if (target.queue && coordinated.batch.status === "evidence_ready") {
        await updateQueuedActionStatus(target.queue.queue_id, "ready");
      }
    }
  }

  const run = await putPrivateFundingBatchRun({
    version: 1,
    run_id: gholaCommitment("batch_run", {
      ...runSeed,
      batches: batches.map((batch) => batch.batch_id).sort(),
    }),
    coordinator_commitment: gholaCommitment("batch_coordinator", "private-mode-v2"),
    status: batches.some((batch) => batch.status === "evidence_ready") ? "healthy" : "waiting",
    accounts_scanned: new Set(imports.map((record) => record.account_commitment)).size,
    queues_scanned: queues.length,
    imports_scanned: imports.length,
    batches_written: batches.length,
    evidence_written: evidenceWritten,
    stale_imports: staleImports,
    rejected_imports: rejectedImports,
    error: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  await releasePrivateCoordinatorLock("private_funding_batch_coordinator", runWindowCommitment);
  return { version: 1, run, batches };
}

export async function privateModeCoordinatorHealth(now: Date = new Date()): Promise<PrivateModeCoordinatorHealth> {
  const [latest, lock] = await Promise.all([
    getLatestPrivateFundingBatchRun(),
    getPrivateCoordinatorLock("private_funding_batch_coordinator"),
  ]);
  const maxStaleMs = coordinatorMaxStaleMs();
  if (!latest) {
    return {
      version: 1,
      status: "red",
      last_run_commitment: null,
      last_run_at: null,
      max_stale_ms: maxStaleMs,
      reason: "batch coordinator has not run",
      run: null,
      lock,
    };
  }
  const stale = now.getTime() - new Date(latest.updated_at).getTime() > maxStaleMs;
  return {
    version: 1,
    status: latest.status === "unhealthy" || stale ? "red" : "green",
    last_run_commitment: latest.run_id,
    last_run_at: latest.updated_at,
    max_stale_ms: maxStaleMs,
    reason: latest.status === "unhealthy"
      ? latest.error || "last batch coordinator run was unhealthy"
      : stale
        ? "batch coordinator state is stale"
        : null,
    run: latest,
    lock,
  };
}

export function evidenceChainFromBatch(input: {
  batch: PrivateFundingBatchRecordV1 | null;
  preview_commitment: string;
  approval_commitment?: string | null;
  execution_commitment?: string | null;
}): GholaPrivateModeEvidenceChain | null {
  if (!input.batch?.evidence_commitment || !input.batch.selected_import_commitment) return null;
  return {
    version: 1,
    funding_import_commitment: input.batch.selected_import_commitment,
    batch_id: input.batch.batch_id,
    batch_evidence_commitment: input.batch.evidence_commitment,
    preview_commitment: input.preview_commitment,
    execution_plan_commitment: null,
    approval_commitment: input.approval_commitment ?? null,
    execution_commitment: input.execution_commitment ?? null,
    settlement_commitment: null,
    relay_commitment: null,
    finality_commitment: null,
  };
}

async function coordinatorQueues(input: {
  owner_commitment?: string;
  queue_id?: string;
  limit?: number;
}): Promise<PrivateQueuedActionRecordV1[]> {
  if (input.queue_id) {
    const queue = await getQueuedAction(input.queue_id);
    if (!queue) return [];
    if (input.owner_commitment && queue.owner_commitment !== input.owner_commitment) return [];
    return [queue];
  }
  const queues = await listAllQueuedActions(input.limit ?? 250);
  return input.owner_commitment
    ? queues.filter((queue) => queue.owner_commitment === input.owner_commitment)
    : queues;
}

function targetImports(imports: PrivateFundingImportRecordV1[]): PrivateFundingImportRecordV1[] {
  const byAccountBucket = new Map<string, PrivateFundingImportRecordV1>();
  for (const record of imports) {
    if (record.verifier_status !== "verified") continue;
    const key = [
      record.account_commitment,
      record.asset_bucket,
      record.amount_bucket,
      record.network,
      record.shielded_rail,
    ].join(":");
    const existing = byAccountBucket.get(key);
    if (!existing || existing.imported_at < record.imported_at) byAccountBucket.set(key, record);
  }
  return Array.from(byAccountBucket.values());
}

function latestVerifiedImport(
  imports: PrivateFundingImportRecordV1[],
  ownerCommitment: string,
): PrivateFundingImportRecordV1 | null {
  return imports
    .filter((record) => record.owner_commitment === ownerCommitment && record.verifier_status === "verified")
    .sort((a, b) => b.imported_at.localeCompare(a.imported_at))[0] ?? null;
}

async function coordinateOne(input: {
  selected: PrivateFundingImportRecordV1;
  queue: PrivateQueuedActionRecordV1 | null;
  now: Date;
}): Promise<{
  batch: PrivateFundingBatchRecordV1 | null;
  stale_imports: number;
  rejected_imports: number;
}> {
  const compatible = await listCompatibleFundingImports({
    asset_bucket: input.selected.asset_bucket,
    amount_bucket: input.selected.amount_bucket,
    shielded_rail: input.selected.shielded_rail,
    limit: 500,
  });
  const networkCompatible = compatible.filter((record) => record.network === input.selected.network);
  const rejectedImports = compatible.filter((record) => record.verifier_status !== "verified").length;
  const fresh = networkCompatible.filter((record) => !isVerifierStateStale(record, input.now));
  const staleImports = networkCompatible.length - fresh.length;
  const matured = fresh.filter(
    (record) => input.now.getTime() - new Date(record.imported_at).getTime() >= fundingBatchMinDelaySeconds() * 1_000,
  );
  const required = requiredAnonymitySet();
  const timingWindowMet = matured.some((record) => record.import_commitment === input.selected.import_commitment);
  const ready = matured.length >= required && timingWindowMet;
  const anonymitySet: GholaAnonymitySetSummary = {
    required,
    effective: matured.length,
    amount_bucketed: true,
    timing_window_met: timingWindowMet,
    uniqueness_score_bps: ready ? 500 : 10_000,
    repeated_pattern_score_bps: 0,
  };
  const intent = input.queue ? await getPrivateAccountIntent(input.queue.intent_id) : null;
  const importCommitments = matured.map((record) => record.import_commitment).sort();
  const batchId = gholaCommitment("funding_batch", {
    account_commitment: input.selected.account_commitment,
    queue_id: input.queue?.queue_id ?? null,
    action_commitment: input.queue?.action_commitment ?? null,
    selected_import_commitment: input.selected.import_commitment,
    imports: importCommitments,
    ready,
  });
  let evidenceCommitment: string | null = null;
  if (ready) {
    const evidence = await putAnonymityEvidence({
      version: 1,
      evidence_commitment: gholaCommitment("anon_evidence", {
        batch_id: batchId,
        account_commitment: input.selected.account_commitment,
        queue_id: input.queue?.queue_id ?? null,
        action_commitment: input.queue?.action_commitment ?? null,
        selected_import_commitment: input.selected.import_commitment,
        import_commitments: importCommitments,
        anonymity_set: anonymitySet,
      }),
      owner_commitment: input.selected.owner_commitment,
      account_commitment: input.selected.account_commitment,
      intent_id: intent?.intent_id ?? null,
      action_commitment: input.queue?.action_commitment ?? null,
      queue_id: input.queue?.queue_id ?? null,
      source: "batch_coordinator",
      anonymity_set: anonymitySet,
      created_at: input.now.toISOString(),
      updated_at: input.now.toISOString(),
    });
    evidenceCommitment = evidence.evidence_commitment;
  }
  const batch = await putPrivateFundingBatch({
    version: 1,
    batch_id: batchId,
    owner_commitment: input.selected.owner_commitment,
    account_commitment: input.selected.account_commitment,
    queue_id: input.queue?.queue_id ?? null,
    action_commitment: input.queue?.action_commitment ?? null,
    selected_import_commitment: input.selected.import_commitment,
    amount_bucket: input.selected.amount_bucket,
    asset_bucket: input.selected.asset_bucket,
    network: input.selected.network,
    shielded_rail: input.selected.shielded_rail,
    import_commitments: importCommitments,
    effective_anonymity_set: matured.length,
    required_anonymity_set: required,
    timing_window_met: timingWindowMet,
    evidence_commitment: evidenceCommitment,
    status: ready ? "evidence_ready" : "waiting",
    created_at: input.now.toISOString(),
    updated_at: input.now.toISOString(),
  });
  return { batch, stale_imports: staleImports, rejected_imports: rejectedImports };
}

function isVerifierStateStale(record: PrivateFundingImportRecordV1, now: Date): boolean {
  return now.getTime() - new Date(record.verifier_observed_at).getTime() > verifierConfig().max_stale_ms;
}

function fundingBatchMinDelaySeconds(): number {
  const configured = Number.parseInt(process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS || "", 10);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_ANONYMITY_SET_POLICY.min_delay_seconds;
}

function requiredAnonymitySet(): number {
  const configured = Number.parseInt(process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET || "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_ANONYMITY_SET_POLICY.consumer_min_effective_set;
}

function coordinatorMaxStaleMs(): number {
  const configured = Number.parseInt(process.env.GHOLA_PRIVATE_ACCOUNT_COORDINATOR_MAX_STALE_MS || "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 5 * 60 * 1000;
}

function coordinatorLockTtlMs(): number {
  const configured = Number.parseInt(process.env.GHOLA_PRIVATE_ACCOUNT_COORDINATOR_LOCK_TTL_MS || "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 2 * 60 * 1000;
}

function coordinatorRunWindowCommitment(
  now: Date,
  input: { owner_commitment?: string; queue_id?: string },
): string {
  const windowMs = Math.max(60_000, coordinatorMaxStaleMs());
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  return gholaCommitment("batch_run_window", {
    window_start: new Date(windowStart).toISOString(),
    owner_commitment: input.owner_commitment ?? null,
    queue_id: input.queue_id ?? null,
  });
}
