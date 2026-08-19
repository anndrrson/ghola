import { createHash } from "node:crypto";

export const INVESTOR_CANARY_LIVE_VERIFIER_VERSION = 1;
export const PRODUCTION_WEB_ORIGIN = "https://ghola.xyz";
export const PRODUCTION_THUMPER_ORIGIN = "https://thumper-cloud.onrender.com";
export const HYPERLIQUID_MAINNET_INFO_URL = "https://api.hyperliquid.xyz/info";
export const WORKER_IMAGE_REPOSITORY = "ghcr.io/anndrrson/ghola";
export const WORKER_PROVENANCE_REPOSITORY = "anndrrson/ghola";
export const WORKER_PROVENANCE_WORKFLOW = "github.com/anndrrson/ghola/.github/workflows/build-private-agent-worker-image.yml";

const REQUIRED_CAPABILITIES = ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"];
const ENTRY_WORK_ORDER = /^live_trade_work_order_[0-9a-f]{48}$/u;
const CLOSE_WORK_ORDER = /^(hl_close_[0-9a-f]{40})_close_hype_[1-3]$/u;
const LIVE_REQUEST = /^live_trade_request_[0-9a-f]{48}$/u;
const LIVE_ORDER_POLICY = /^live_trade_order_policy_[0-9a-f]{48}$/u;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u;
const COMMITMENT = /^[A-Za-z0-9_:-]{8,200}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const MIN_ACCESS_REMAINING_MS = 30 * 60_000;
const MAX_RUN_AGE_MS = 24 * 60 * 60_000;
const MIN_COMPUTE_SECONDS = 600;
const MIN_NOTIONAL_ALLOWANCE = 22_000_000;
const MAX_OPERATIONS_PREPARATION_AGE_MS = 7 * 24 * 60 * 60_000;
const HUMAN_JOURNEY_FLAGS = [
  "participant_is_non_operator",
  "invitation_email_opened",
  "verified_email_signup_or_signin_completed",
  "invite_fragment_scrubbed_before_redeem",
  "clean_chrome_profile_used",
  "worker_started_from_product",
  "phantom_evm_account_connected",
  "phantom_approve_agent_confirmed",
  "phantom_solana_account_connected",
  "phantom_siws_completed_if_requested",
  "graduation_wallet_binding_signature_confirmed",
  "graduation_exact_request_signature_confirmed",
  "first_terminal_entry_review_confirmed",
  "first_close_wallet_binding_signature_confirmed",
  "first_close_exact_request_signature_confirmed",
  "full_reload_between_round_trips",
  "second_terminal_entry_review_confirmed",
  "second_close_wallet_binding_signature_confirmed",
  "second_close_exact_request_signature_confirmed",
  "normal_terminal_entries_required_no_phantom_signature",
  "no_unexplained_repeated_prompt_or_stage_stall",
  "no_cli_dashboard_devtools_or_secret_setup",
  "confirmations_personally_completed",
];

export function gholaCommitment(prefix, value) {
  return `${prefix}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 48)}`;
}

export function acceptanceCommitment(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

/**
 * Builds acceptance only from source calls. Callers cannot supply a dossier or
 * machine-result booleans. Protected human and release-operations attestations
 * stay separately labelled and never become machine evidence.
 */
export async function verifyLiveInvestorCanary({ source, config, now = new Date() }) {
  const checks = [];
  const add = (id, ok, failure) => {
    checks.push({ id, ok: ok === true, ...(ok === true ? {} : { failure }) });
    return ok === true;
  };
  const nowMs = now.getTime();
  const startedAtMs = Date.parse(config?.startedAt || "");
  const configReady = Number.isFinite(nowMs) && Number.isFinite(startedAtMs) &&
    startedAtMs <= nowMs && nowMs - startedAtMs <= MAX_RUN_AGE_MS &&
    Array.isArray(config?.investors) && config.investors.length === 2 &&
    config.investors.every((item) => typeof item?.token === "string" && item.token.length >= 32 &&
      ADDRESS.test(String(item.accountAddress || "").toLowerCase())) &&
    config.investors[0].token !== config.investors[1].token &&
    config.investors[0].accountAddress.toLowerCase() !== config.investors[1].accountAddress.toLowerCase();
  add("config.fixed_authenticated_sources", configReady, "authenticated_source_configuration_invalid");
  if (!configReady) return finish(checks, null, [], null, now);

  let firstStatus;
  let mainRelease;
  try {
    [firstStatus, mainRelease] = await Promise.all([
      source.getPublicStatus(),
      source.getMainReleaseEvidence(),
    ]);
  } catch {
    add("sources.release", false, "authoritative_release_source_unavailable");
    return finish(checks, null, [], null, now);
  }
  const release = validCanaryRelease(firstStatus, nowMs);
  add("release.production_canary", release.ok, release.failure);
  add(
    "release.main_database_binding",
    release.ok && validMainReleaseEvidence(mainRelease, release.value, nowMs),
    "main_release_binding_invalid",
  );
  add(
    "release.baked_worker_identity",
    release.ok && validBakedWorkerReadiness(firstStatus, release.value),
    "baked_worker_release_identity_invalid",
  );
  if (!release.ok) return finish(checks, null, [], null, now);

  let operationalReadiness = null;
  let operationsEvidence = null;
  let buildProvenance = null;
  const operationalSources = await Promise.allSettled([
    Promise.resolve().then(() => source.getOperationalReadiness()),
    Promise.resolve().then(() => source.getOperationsEvidence()),
    Promise.resolve().then(() => source.getWorkerBuildProvenance({ release: release.value })),
  ]);
  if (operationalSources[0].status === "fulfilled") operationalReadiness = operationalSources[0].value;
  if (operationalSources[1].status === "fulfilled") operationsEvidence = operationalSources[1].value;
  if (operationalSources[2].status === "fulfilled") buildProvenance = operationalSources[2].value;
  const readinessInspection = inspectOperationalReadiness(operationalReadiness, nowMs);
  add("operations.observability_and_readiness", readinessInspection.ok, readinessInspection.failure);
  const buildProvenanceInspection = inspectWorkerBuildProvenance(buildProvenance, release.value);
  add("release.signed_registry_build_provenance", buildProvenanceInspection.ok, buildProvenanceInspection.failure);
  const operationsInspection = inspectOperationsEvidence(
    operationsEvidence,
    release.value,
    startedAtMs,
    nowMs,
  );
  add("operations.rollback_kill_and_prior_artifacts", operationsInspection.ok, operationsInspection.failure);

  const rawRuns = await Promise.all(config.investors.map(async (investor, index) => {
    let sourceStage = "authenticated_api";
    try {
      const [profile, billing, terminal] = await Promise.all([
        source.getProfile(investor.token),
        source.getBilling(investor.token),
        source.getTerminalAccess(investor.token),
      ]);
      const ownerCommitment = validProfile(profile)
        ? gholaCommitment("owner", profile.id)
        : null;
      sourceStage = "main_database";
      const main = ownerCommitment
        ? await source.getMainInvestorEvidence({ ownerCommitment, startedAt: config.startedAt })
        : null;
      const machine = ownerCommitment && main
        ? inspectMainInvestor({
            main,
            ownerCommitment,
            accountAddress: investor.accountAddress.toLowerCase(),
            release: release.value,
            startedAtMs,
            nowMs,
          })
        : invalid("main_investor_evidence_invalid");
      sourceStage = "worker_database";
      const worker = machine.ok
        ? await source.getWorkerInvestorEvidence({
            ownerCommitment,
            accountCommitment: machine.value.accountCommitment,
            startedAt: config.startedAt,
          })
        : null;
      const execution = machine.ok && worker
        ? inspectWorkerExecution({
            worker,
            entries: machine.value.entries,
            ownerCommitment,
            accountCommitment: machine.value.accountCommitment,
            vaultCommitment: machine.value.vaultCommitment,
            startedAtMs,
            nowMs,
          })
        : invalid("worker_execution_evidence_invalid");
      sourceStage = "hyperliquid_mainnet";
      const venue = execution.ok
        ? await source.getVenueEvidence({
            accountAddress: investor.accountAddress.toLowerCase(),
            refs: execution.value.refs,
            authorization: machine.value.authorization,
          })
        : null;
      const venueInspection = execution.ok && venue
        ? inspectVenue({
            venue,
            refs: execution.value.refs,
            authorization: machine.value.authorization,
            startedAtMs,
            nowMs,
          })
        : invalid("venue_evidence_invalid");
      return { index, profile, billing, terminal, ownerCommitment, machine, execution, venueInspection };
    } catch {
      return { index, sourceFailure: sourceStage };
    }
  }));

  const summaries = [];
  for (const run of rawRuns) {
    const label = run.index === 0 ? "a" : "b";
    if (run.sourceFailure) {
      add(
        `investor_${label}.${run.sourceFailure}_source`,
        false,
        `${run.sourceFailure}_source_unavailable`,
      );
      continue;
    }
    add(`investor_${label}.profile`, validProfile(run.profile), "verified_profile_required");
    add(`investor_${label}.complimentary_access`, validBilling(run.billing, nowMs), "complimentary_access_invalid");
    add(
      `investor_${label}.terminal_access`,
      validTerminalAccess(run.terminal, release.value, nowMs),
      "account_canary_terminal_access_invalid",
    );
    add(`investor_${label}.account_vault_graduation`, run.machine.ok, run.machine.failure);
    add(`investor_${label}.terminal_entries`, run.machine.ok && run.machine.value.entries.length === 2,
      "exactly_two_terminal_entries_required");
    add(`investor_${label}.worker_round_trips`, run.execution.ok, run.execution.failure);
    add(`investor_${label}.venue_orders`, run.venueInspection.ok, run.venueInspection.failure);
    add(
      `investor_${label}.protection_orders_canceled`,
      run.venueInspection.ok && run.venueInspection.value.protectionCanceled === 4,
      "protection_order_cancellation_invalid",
    );
    add(`investor_${label}.venue_final_flat`, run.venueInspection.ok && run.venueInspection.value.finalFlat,
      "venue_wide_final_flat_required");
    if (run.machine.ok && run.execution.ok && run.venueInspection.ok && validProfile(run.profile)) {
      summaries.push({
        label: label.toUpperCase(),
        profileId: run.profile.id,
        profileEmail: run.profile.email.toLowerCase(),
        accessPassId: run.billing.active_pass_id,
        ownerCommitment: run.ownerCommitment,
        accountCommitment: run.machine.value.accountCommitment,
        vaultCommitment: run.machine.value.vaultCommitment,
        graduationAt: run.machine.value.graduationAt,
        terminalEntries: run.machine.value.entries.length,
        reduceOnlyCloses: run.execution.value.closeRoots.length,
        protectionOrdersCanceled: run.venueInspection.value.protectionCanceled,
        latestVenueFillAt: run.venueInspection.value.latestFillAt,
        entryWorkOrders: run.machine.value.entries.map((item) => item.workOrder),
        entryPlans: run.machine.value.entries.map((item) => item.planDigest),
        closeRoots: run.execution.value.closeRoots,
        replayReceipts: run.execution.value.replayReceipts,
        evidenceCommitment: acceptanceCommitment({
          owner: run.ownerCommitment,
          account: run.machine.value.accountCommitment,
          vault: run.machine.value.vaultCommitment,
          entryWorkOrders: run.machine.value.entries.map((item) => item.workOrder),
          closeRoots: run.execution.value.closeRoots,
          venue: run.venueInspection.value.commitment,
        }),
      });
    }
  }

  const distinct = summaries.length === 2 &&
    new Set(summaries.map((item) => item.profileId)).size === 2 &&
    new Set(summaries.map((item) => item.profileEmail)).size === 2 &&
    new Set(summaries.map((item) => item.accessPassId)).size === 2 &&
    new Set(summaries.map((item) => item.ownerCommitment)).size === 2 &&
    new Set(summaries.map((item) => item.accountCommitment)).size === 2 &&
    new Set(summaries.map((item) => item.vaultCommitment)).size === 2 &&
    new Set(summaries.flatMap((item) => item.entryWorkOrders)).size === 4 &&
    new Set(summaries.flatMap((item) => item.entryPlans)).size === 4 &&
    new Set(summaries.flatMap((item) => item.closeRoots)).size === 4;
  add("cohort.two_distinct_investors", distinct, "two_distinct_investors_required");
  const nonOperatorInspection = inspectNonOperatorCohort(operationsInspection, summaries);
  add("cohort.non_operator_investors", nonOperatorInspection.ok, nonOperatorInspection.failure);
  const restartInspection = inspectRestartReplay(operationsInspection, summaries, startedAtMs, nowMs);
  add("operations.restart_receipt_replay", restartInspection.ok, restartInspection.failure);

  let finalStatus = null;
  try {
    finalStatus = await source.getPublicStatus();
  } catch {
    // The check below fails closed.
  }
  add(
    "release.no_drift",
    validCanaryRelease(finalStatus, nowMs).ok && sameReleaseStatus(firstStatus, finalStatus),
    "release_drift_or_final_status_unavailable",
  );

  let human = null;
  try {
    human = await source.getHumanAttestation();
  } catch {
    // The check below fails closed.
  }
  const humanInspection = inspectHumanAttestation(human, startedAtMs, nowMs, summaries);
  add("human.full_email_wallet_ui_journey", humanInspection.ok, humanInspection.failure);

  return finish(
    checks,
    release.value,
    summaries,
    humanInspection.ok ? humanInspection.value : null,
    now,
    operationsInspection.ok && restartInspection.ok && nonOperatorInspection.ok
      ? operationsSummary(operationsInspection.value)
      : null,
    buildProvenanceInspection.ok ? buildProvenanceInspection.value : null,
  );
}

function inspectMainInvestor({ main, ownerCommitment, accountAddress, release, startedAtMs, nowMs }) {
  const account = one(main?.accounts);
  const accountJson = record(account?.account);
  if (!account || account.owner_commitment !== ownerCommitment || account.vault_ready !== true ||
      !COMMITMENT.test(String(account.account_commitment || "")) || accountJson?.version !== 1 ||
      accountJson?.account_commitment !== account.account_commitment || accountJson?.vault_ready !== true ||
      accountJson?.privacy_mode !== "private_mode" ||
      accountJson?.claim_boundary !== "engine_gated_full_anonymity") return invalid("private_account_invalid");
  const accountCommitment = account.account_commitment;
  const vault = one(main?.vaults);
  const vaultJson = record(vault?.vault);
  const authorization = record(vaultJson?.authorization);
  const encrypted = record(vaultJson?.encrypted_execution_vault);
  const scope = parseVaultAad(encrypted?.aad);
  const vaultSeed = {
    account_commitment: accountCommitment,
    encrypted_vault_commitment: encrypted?.ciphertext_commitment,
    recipient_commitment: encrypted?.recipient_commitment,
    policy_commitment: vaultJson?.policy_commitment,
  };
  const expectedVenue = gholaCommitment("hyperliquid_venue_account", accountAddress);
  const validUntilMs = Date.parse(String(authorization?.valid_until || ""));
  const workerVerifiedAtMs = Date.parse(String(authorization?.worker_verified_at || ""));
  if (!vault || vault.owner_commitment !== ownerCommitment || vault.account_commitment !== accountCommitment ||
      vault.status !== "sealed" || vaultJson?.version !== 1 ||
      vaultJson?.platform_class !== "hyperliquid_style_market" ||
      vaultJson?.status !== "sealed" || vaultJson?.account_commitment !== accountCommitment ||
      vaultJson?.vault_commitment !== vault.vault_commitment ||
      vault.vault_commitment !== gholaCommitment("hyperliquid_execution_vault", vaultSeed) ||
      vault.encrypted_vault_commitment !== vaultJson?.encrypted_vault_commitment ||
      vaultJson?.encrypted_vault_commitment !== gholaCommitment("hyperliquid_encrypted_vault", vaultSeed) ||
      vault.recipient_commitment !== vaultJson?.recipient_commitment ||
      vault.policy_commitment !== vaultJson?.policy_commitment ||
      !COMMITMENT.test(String(vaultJson?.policy_commitment || "")) ||
      encrypted?.version !== 1 || encrypted?.alg !== "sealed-provider-v1" ||
      typeof encrypted?.ciphertext !== "string" || encrypted.ciphertext.length < 16 ||
      typeof encrypted?.recipient !== "string" || encrypted.recipient.length < 3 ||
      typeof encrypted?.aad !== "string" || encrypted.aad.length < 16 ||
      encrypted?.ciphertext_commitment !== gholaCommitment("encrypted_bundle_ciphertext", encrypted.ciphertext) ||
      encrypted?.recipient_commitment !== gholaCommitment("sealed_recipient", encrypted?.recipient) ||
      encrypted?.aad_commitment !== gholaCommitment("encrypted_bundle_aad", encrypted?.aad) ||
      authorization?.source !== "phantom_approve_agent_v1" ||
      authorization?.network !== "mainnet" || authorization?.agent_name !== "ghola-mainnet" ||
      authorization?.venue_account_commitment !== expectedVenue ||
      !/^hyperliquid_agent_wallet_[0-9a-f]{48}$/u.test(String(authorization?.agent_wallet_commitment || "")) ||
      !/^hyperliquid_agent_onboarding_verification_[0-9a-f]{48}$/u.test(String(authorization?.worker_verification_commitment || "")) ||
      !Number.isFinite(validUntilMs) || validUntilMs <= nowMs + MIN_ACCESS_REMAINING_MS ||
      !Number.isFinite(workerVerifiedAtMs) || workerVerifiedAtMs < startedAtMs || workerVerifiedAtMs >= validUntilMs ||
      !sameWorkerRelease(authorization, release) || !scope || scope.version !== 2 || scope.network !== "mainnet" ||
      scope.accountCommitment !== accountCommitment || scope.venueAccountCommitment !== expectedVenue ||
      scope.agentWalletCommitment !== authorization.agent_wallet_commitment || scope.recipient !== encrypted?.recipient ||
      !Array.isArray(vaultJson?.blocked_operations) ||
      !sameStringSet(vaultJson?.supported_operations, ["read", "limit_order", "cancel", "reconcile"]) ||
      !sameStringSet(vaultJson.blocked_operations, ["withdraw", "vault_transfer", "leverage_escalation"])) {
    return invalid("automatic_worker_verified_vault_invalid");
  }

  const graduation = one(main?.graduations);
  if (!graduation || graduation.status !== "active" || graduation.owner_commitment !== ownerCommitment ||
      graduation.account_commitment !== accountCommitment || graduation.vault_commitment !== vault.vault_commitment ||
      graduation.version !== 3 || graduation.contract_version !== release.contract_version ||
      graduation.proof_notional_usd !== 11 || !sameReleaseFields(graduation, release) ||
      !freshAfter(graduation.completed_at, startedAtMs, nowMs)) return invalid("exact_release_v3_graduation_invalid");

  const reservations = new Map((Array.isArray(main?.reservations) ? main.reservations : [])
    .map((item) => [item.reservation_id, item]));
  const allRecords = Array.isArray(main?.reconciliations) ? main.reconciliations : [];
  if (allRecords.some((item) => ["pending", "submitted"].includes(item?.status))) {
    return invalid("terminal_reconciliation_unresolved");
  }
  const entries = allRecords.filter((item) => item?.status === "reconciled");
  if (entries.length !== 2) return invalid("exactly_two_terminal_entries_required");
  const normalized = [];
  for (const item of entries.sort(byCreatedAt)) {
    const request = record(item.worker_request);
    const policy = record(request?.session_policy);
    const requestVault = record(request?.encrypted_execution_vault);
    const reservation = reservations.get(item.reservation_id);
    if (!ENTRY_WORK_ORDER.test(String(item.work_order_commitment || "")) ||
        item.owner_commitment !== ownerCommitment || item.account_commitment !== accountCommitment ||
        item.vault_commitment !== vault.vault_commitment || item.market !== "HYPE" ||
        item.require_protection !== true || !Number.isInteger(item.protection_slippage_bps) ||
        item.protection_slippage_bps < 1 || item.protection_slippage_bps > 100 ||
        !COMMITMENT.test(String(item.result_commitment || "")) ||
        !DIGEST.test(String(item.plan_digest || "")) || !LIVE_REQUEST.test(String(item.request_commitment || "")) ||
        !LIVE_ORDER_POLICY.test(String(item.order_policy_commitment || "")) ||
        !freshAfter(item.created_at, startedAtMs, nowMs) ||
        item.worker_image_digest !== release.worker_image_digest || !reservation || reservation.status !== "filled" ||
        reservation.owner_commitment !== ownerCommitment || reservation.account_commitment !== accountCommitment ||
        reservation.notional_usd !== 11 || reservation.request_commitment !== item.plan_digest ||
        request?.version !== 1 || request?.reconciliation_binding_version !== 1 ||
        request?.venue_id !== "hyperliquid" || request?.platform_class !== "hyperliquid_style_market" ||
        request?.execution_mode !== "byo_api_key" ||
        request?.work_order_commitment !== item.work_order_commitment ||
        request?.owner_commitment !== ownerCommitment || request?.account_commitment !== accountCommitment ||
        request?.vault_commitment !== vault.vault_commitment || request?.market !== "HYPE" ||
        request?.operation_class !== "limit_order" || request?.plan_digest !== item.plan_digest ||
        request?.request_commitment !== item.request_commitment ||
        request?.policy_commitment !== item.vault_policy_commitment ||
        request?.order_policy_commitment !== item.order_policy_commitment ||
        item.vault_policy_commitment !== vaultJson.policy_commitment ||
        policy?.policy_commitment !== item.order_policy_commitment ||
        item.worker_recipient !== encrypted?.recipient || stableJson(requestVault) !== stableJson(encrypted) ||
        !DIGEST.test(String(item.worker_request_digest || "")) ||
        item.worker_request_digest !== acceptanceCommitment(request) ||
        !COMMITMENT.test(String(item.order_id || "")) ||
        policy?.execution_network !== "mainnet") return invalid("terminal_entry_binding_invalid");
    normalized.push({
      workOrder: item.work_order_commitment,
      planDigest: item.plan_digest,
      requestCommitment: item.request_commitment,
      vaultPolicyCommitment: item.vault_policy_commitment,
      orderPolicyCommitment: item.order_policy_commitment,
      workerRequestDigest: item.worker_request_digest,
      resultCommitment: item.result_commitment,
      orderId: item.order_id,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    });
  }
  if (new Set(normalized.flatMap((item) => [item.workOrder, item.planDigest, item.requestCommitment])).size !== 6) {
    return invalid("terminal_entry_identity_reused");
  }
  return valid({
    accountCommitment,
    vaultCommitment: vault.vault_commitment,
    vaultPolicyCommitment: vaultJson.policy_commitment,
    authorization: {
      agentWalletCommitment: authorization.agent_wallet_commitment,
      agentName: authorization.agent_name,
      validUntilMs,
    },
    graduationAt: graduation.completed_at,
    entries: normalized,
  });
}

function inspectWorkerExecution({ worker, entries, ownerCommitment, accountCommitment, vaultCommitment, startedAtMs, nowMs }) {
  const claims = Array.isArray(worker?.claims) ? worker.claims : [];
  const attempts = new Map((Array.isArray(worker?.attempts) ? worker.attempts : [])
    .map((item) => [item.work_order_commitment, item]));
  const idempotency = new Map((Array.isArray(worker?.idempotency) ? worker.idempotency : [])
    .map((item) => [item.work_order_commitment, item]));
  if (!freshDbClock(worker?.database_clock, nowMs) ||
      claims.some((item) => !["completed", "rejected"].includes(item?.status))) {
    return invalid("worker_claims_unresolved");
  }
  const refs = [];
  const protectionRefs = [];
  const entryClaims = [];
  for (const entry of entries) {
    const claim = claims.find((item) => item.work_order_commitment === entry.workOrder);
    const inspected = inspectClaim({
      claim, attempt: attempts.get(entry.workOrder), idempotency: idempotency.get(entry.workOrder),
      ownerCommitment, accountCommitment, vaultCommitment, expected: entry, reduceOnly: false,
      vaultPolicyCommitment: entry.vaultPolicyCommitment,
    });
    if (!inspected.ok) return inspected;
    refs.push(inspected.value.ref);
    protectionRefs.push(...inspected.value.protectionRefs);
    entryClaims.push({ ...inspected.value, createdAt: claim.created_at });
  }
  const closeClaims = claims.filter((item) => CLOSE_WORK_ORDER.test(String(item?.work_order_commitment || "")) &&
    freshAfter(item.created_at, startedAtMs, nowMs));
  const successful = [];
  for (const claim of closeClaims) {
    const match = String(claim.work_order_commitment).match(CLOSE_WORK_ORDER);
    const inspected = inspectClaim({
      claim, attempt: attempts.get(claim.work_order_commitment),
      idempotency: idempotency.get(claim.work_order_commitment), ownerCommitment,
      accountCommitment, vaultCommitment, expected: null, reduceOnly: true,
      vaultPolicyCommitment: entries[0].vaultPolicyCommitment,
    });
    if (claim.status === "completed" && !inspected.ok) return invalid("reduce_only_close_claim_invalid");
    if (inspected.ok) successful.push({ ...inspected.value, root: match[1], createdAt: claim.created_at });
  }
  const roots = [...new Set(successful.map((item) => item.root))];
  if (roots.length !== 2) return invalid("exactly_two_reduce_only_close_roots_required");
  const closes = roots.map((root) => successful.filter((item) => item.root === root).sort(byCreatedAt).at(-1));
  if (closes.some((item) => !item)) return invalid("reduce_only_close_claim_invalid");
  closes.sort(byCreatedAt);
  entryClaims.sort(byCreatedAt);
  if (!(Date.parse(entryClaims[0].createdAt) < Date.parse(closes[0].createdAt) &&
      Date.parse(closes[0].createdAt) < Date.parse(entryClaims[1].createdAt) &&
      Date.parse(entryClaims[1].createdAt) < Date.parse(closes[1].createdAt))) {
    return invalid("entry_close_round_trip_sequence_invalid");
  }
  refs.push(...closes.map((item) => item.ref));
  refs.push(...protectionRefs);
  if (refs.some((item) => !item.oid || !item.cloid) ||
      new Set(refs.map((item) => item.oid)).size !== 8 ||
      new Set(refs.map((item) => item.cloid)).size !== 8) {
    return invalid("venue_order_reference_reused");
  }
  return valid({
    refs,
    closeRoots: roots,
    replayReceipts: entryClaims.map((item) => ({
      workOrder: item.ref.workOrder,
      receiptCommitment: item.receiptCommitment,
      createdAt: item.createdAt,
    })),
  });
}

function inspectClaim({
  claim, attempt, idempotency, ownerCommitment, accountCommitment, vaultCommitment,
  vaultPolicyCommitment, expected, reduceOnly,
}) {
  const claimJson = record(claim?.claim_json);
  const context = record(claimJson?.context);
  const attemptJson = record(attempt?.attempt_json);
  const receipt = record(claim?.receipt_json);
  const cached = record(idempotency?.receipt_json);
  const proof = record(receipt?.final_proof);
  const cachedProof = record(cached?.final_proof);
  const attemptProof = record(attemptJson?.final_proof);
  const requestDigest = String(context?.request_digest || "");
  const oid = stringId(proof?.venue_order_oid);
  const cloid = stringId(proof?.venue_order_cloid);
  if (!claim || claim.status !== "completed" || context?.owner_commitment !== ownerCommitment ||
      context?.account_commitment !== accountCommitment || context?.vault_commitment !== vaultCommitment ||
      context?.venue_id !== "hyperliquid" || context?.operation_class !== "limit_order" || context?.market !== "HYPE" ||
      !DIGEST.test(requestDigest) || !attempt || !idempotency || attemptJson?.status !== "filled" ||
      attemptJson?.execution_request_digest !== requestDigest || receipt?.execution_request_digest !== requestDigest ||
      cached?.execution_request_digest !== requestDigest || receipt?.status !== "filled" || cached?.status !== "filled" ||
      receipt?.work_order_commitment !== claim.work_order_commitment ||
      cached?.work_order_commitment !== claim.work_order_commitment ||
      receipt?.vault_commitment !== vaultCommitment || cached?.vault_commitment !== vaultCommitment ||
      context?.policy_commitment !== vaultPolicyCommitment ||
      receipt?.result_commitment !== cached?.result_commitment || !terminalFillProof(proof) ||
      !terminalFillProof(cachedProof) || !terminalFillProof(attemptProof) ||
      (!oid && !cloid)) return invalid("completed_worker_claim_invalid");
  if (expected && (context?.plan_digest !== expected.planDigest ||
      context?.request_commitment !== expected.requestCommitment ||
      context?.policy_commitment !== expected.vaultPolicyCommitment ||
      context?.order_policy_commitment !== expected.orderPolicyCommitment ||
      context?.reconciliation_binding_version !== 1 ||
      context?.original_request_digest !== expected.workerRequestDigest ||
      receipt?.result_commitment !== expected.resultCommitment ||
      expected.orderId !== `hyperliquid:${oid}` ||
      proof?.position_protection_proven !== true ||
      !sameProtectionProof(proof, cachedProof) || !sameProtectionProof(proof, attemptProof))) {
    return invalid("entry_worker_claim_binding_invalid");
  }
  const protectionRefs = [];
  if (expected) {
    const takeProfitOid = stringId(proof?.take_profit_oid);
    const takeProfitCloid = stringId(proof?.take_profit_cloid);
    const stopLossOid = stringId(proof?.stop_loss_oid);
    const stopLossCloid = stringId(proof?.stop_loss_cloid);
    if (!takeProfitOid || !takeProfitCloid || !stopLossOid || !stopLossCloid) {
      return invalid("entry_worker_claim_binding_invalid");
    }
    protectionRefs.push(
      {
        identity: `oid:${takeProfitOid}`,
        oid: takeProfitOid,
        cloid: takeProfitCloid,
        workOrder: claim.work_order_commitment,
        reduceOnly: true,
        kind: "protection",
        expectedStatus: "canceled",
      },
      {
        identity: `oid:${stopLossOid}`,
        oid: stopLossOid,
        cloid: stopLossCloid,
        workOrder: claim.work_order_commitment,
        reduceOnly: true,
        kind: "protection",
        expectedStatus: "canceled",
      },
    );
  }
  const identity = oid ? `oid:${oid}` : `cloid:${cloid}`;
  return valid({
    ref: {
      identity,
      oid,
      cloid,
      workOrder: claim.work_order_commitment,
      reduceOnly,
      kind: reduceOnly ? "close" : "entry",
      expectedStatus: "filled",
    },
    protectionRefs,
    receiptCommitment: acceptanceCommitment(receipt),
  });
}

function inspectVenue({ venue, refs, authorization, startedAtMs, nowMs }) {
  if (record(venue?.role)?.role !== "user") return invalid("hyperliquid_master_account_role_invalid");
  if (!Array.isArray(venue?.extraAgents) || !validAgentAuthorization(venue.extraAgents, authorization)) {
    return invalid("current_trade_only_agent_authorization_required");
  }
  if (!Array.isArray(venue?.openOrders) || !Array.isArray(venue?.frontendOpenOrders) || venue.openOrders.length !== 0 ||
      venue.frontendOpenOrders.length !== 0 || !Array.isArray(record(venue?.clearinghouse)?.assetPositions) ||
      !record(venue?.clearinghouse).assetPositions.every(positionFlat) ||
      !Array.isArray(record(venue?.spot)?.balances) || !spotExposureFlat(record(venue?.spot).balances) ||
      !Array.isArray(venue?.fills) || !Array.isArray(venue?.historicalOrders) ||
      !Array.isArray(venue?.orderStatuses) || venue.orderStatuses.length !== refs.length) {
    return invalid("venue_wide_final_flat_required");
  }
  const fillTimes = [];
  const hashOwners = new Map();
  const safeOrders = [];
  let protectionCanceled = 0;
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index];
    const order = normalizedOrder(venue.orderStatuses[index]);
    if (!order || String(order.oid || "") !== String(ref.oid || order.oid || "") ||
        (ref.cloid && String(order.cloid || "").toLowerCase() !== ref.cloid.toLowerCase()) ||
        String(order.coin || "").toUpperCase() !== "HYPE" || order.status !== ref.expectedStatus ||
        order.reduceOnly !== ref.reduceOnly ||
        !historicalContains(venue.historicalOrders, ref)) return invalid("exact_venue_order_readback_invalid");
    const matches = venue.fills.filter((fill) => fillMatches(fill, ref));
    if (ref.kind === "protection") {
      if (matches.length !== 0) return invalid("protection_order_cancellation_invalid");
      protectionCanceled += 1;
      safeOrders.push({ workOrder: ref.workOrder, reduceOnly: true, status: "canceled", fillCount: 0 });
      continue;
    }
    if (order.tif && String(order.tif).toLowerCase() !== "ioc") {
      return invalid("exact_venue_order_readback_invalid");
    }
    if (matches.length === 0) return invalid("exact_venue_fill_missing");
    let notional = 0;
    let earliest = Infinity;
    let latest = 0;
    for (const fill of matches) {
      const size = Number(fill?.sz);
      const price = Number(fill?.px);
      const time = Number(fill?.time);
      const hash = String(fill?.hash || "").toLowerCase();
      const hashOwner = hashOwners.get(hash);
      if (!(size > 0) || !(price > 0) || !Number.isInteger(time) || time < startedAtMs || time > nowMs + 30_000 ||
          !/^0x[0-9a-f]{64}$/u.test(hash) || (hashOwner && hashOwner !== ref.identity)) {
        return invalid("venue_fill_economics_invalid");
      }
      notional += size * price;
      earliest = Math.min(earliest, time);
      latest = Math.max(latest, time);
      hashOwners.set(hash, ref.identity);
    }
    if ((!ref.reduceOnly && (notional < 10 || notional > 12.5)) || (ref.reduceOnly && notional <= 0)) {
      return invalid("venue_fill_notional_invalid");
    }
    fillTimes.push({ earliest, latest });
    safeOrders.push({ workOrder: ref.workOrder, reduceOnly: ref.reduceOnly, fillCount: matches.length });
  }
  if (protectionCanceled !== 4) return invalid("protection_order_cancellation_invalid");
  if (!(fillTimes[0].earliest <= fillTimes[2].earliest && fillTimes[2].latest < fillTimes[1].earliest &&
      fillTimes[1].earliest <= fillTimes[3].earliest)) {
    // refs are entries followed by closes; enforce entry1-close1-entry2-close2.
    return invalid("venue_round_trip_fill_sequence_invalid");
  }
  const firstTerminalFillAt = fillTimes[0].earliest;
  const extraneousFill = venue.fills.some((fill) =>
    String(fill?.coin || "").toUpperCase() === "HYPE" &&
    Number(fill?.time) >= firstTerminalFillAt && !refs.some((ref) => fillMatches(fill, ref)));
  if (extraneousFill) return invalid("extraneous_venue_fill_in_acceptance_window");
  return valid({
    finalFlat: true,
    protectionCanceled,
    latestFillAt: new Date(Math.max(...fillTimes.map((item) => item.latest))).toISOString(),
    commitment: acceptanceCommitment({ orders: safeOrders, fillTimes }),
  });
}

function validCanaryRelease(status, nowMs) {
  const release = record(status?.release_identity);
  const worker = record(status?.live_worker_readiness);
  const checkedAt = Date.parse(String(status?.checked_at || ""));
  const identityReady = status?.version === 1 && status?.contract_version === 2 &&
    validResponseCommitment(status, "gate_commitment", "live_trading_launch_gate") &&
    release?.contract_version === 2 && /^[0-9a-f]{40}$/u.test(String(release?.web_git_sha || "")) &&
    release.web_git_sha === release.worker_git_sha && DIGEST.test(String(release?.worker_image_digest || "")) &&
    /^live_trading_config_[0-9a-f]{48}$/u.test(String(release?.config_fingerprint || "")) &&
    release.valid === true && Array.isArray(release.reason_codes) && release.reason_codes.length === 0;
  const publicRed = status?.status === "red" && status?.launch_state === "canary" &&
    status?.live_trading_enabled === false && status?.byo_live_trading_enabled === false &&
    status?.pooled_live_trading_enabled === false && status?.public_live_copy_allowed === false &&
    status?.live_submit_mode === "disabled";
  const workerReady = worker?.ready === true && worker?.contract_version === 2 &&
    worker.worker_git_sha === release?.worker_git_sha && worker.worker_image_digest === release?.worker_image_digest &&
    worker.config_fingerprint === release?.config_fingerprint && Array.isArray(worker?.capabilities) &&
    REQUIRED_CAPABILITIES.every((item) => worker.capabilities.includes(item)) &&
    Array.isArray(worker.reason_codes) && worker.reason_codes.length === 0;
  return identityReady && publicRed && workerReady && Number.isFinite(checkedAt) && Math.abs(nowMs - checkedAt) <= 5 * 60_000
    ? valid(release)
    : invalid("production_canary_release_invalid");
}

function validBakedWorkerReadiness(status, release) {
  const worker = record(status?.live_worker_readiness);
  return worker?.ready === true && worker?.contract_version === release?.contract_version &&
    worker?.worker_git_sha === release?.worker_git_sha &&
    worker?.worker_image_digest === release?.worker_image_digest &&
    worker?.config_fingerprint === release?.config_fingerprint &&
    Array.isArray(worker?.reason_codes) && worker.reason_codes.length === 0;
}

function inspectWorkerBuildProvenance(value, release) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    return invalid("signed_registry_build_provenance_invalid");
  }
  const digest = String(release?.worker_image_digest || "").replace(/^sha256:/u, "");
  const verified = value.find((item) => {
    const result = record(item?.verificationResult);
    const statement = record(result?.statement);
    const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
    return statement?.predicateType === "https://slsa.dev/provenance/v1" &&
      Array.isArray(result?.verifiedTimestamps) && result.verifiedTimestamps.length > 0 &&
      subjects.some((subject) => {
        const subjectDigest = record(subject?.digest);
        return String(subject?.name || "").replace(/^oci:\/\//u, "") === WORKER_IMAGE_REPOSITORY &&
          String(subjectDigest?.sha256 || "").toLowerCase() === digest;
      });
  });
  if (!verified) return invalid("signed_registry_build_provenance_invalid");
  return valid({
    verified: true,
    commitment: acceptanceCommitment({
      repository: WORKER_IMAGE_REPOSITORY,
      workerGitSha: release.worker_git_sha,
      workerImageDigest: release.worker_image_digest,
      statement: verified.verificationResult.statement,
      verifiedTimestamps: verified.verificationResult.verifiedTimestamps,
    }),
  });
}

function validMainReleaseEvidence(value, release, nowMs) {
  const control = record(value?.control);
  return freshDbClock(value?.database_clock, nowMs) && control?.version === 2 && control?.state === "canary" &&
    control?.contract_version === release.contract_version && sameReleaseFields(control, release);
}

function validProfile(value) {
  return record(value) && UUID.test(String(value.id || "")) && typeof value.email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email) && value.email_verified === true;
}

function validBilling(value, nowMs) {
  const compute = record(value?.private_agent_compute);
  const trading = record(value?.private_agent_trading);
  const expiry = Date.parse(String(value?.expires_at || ""));
  return value?.access_source === "complimentary_pass" && value?.access_state === "active" &&
    value?.invite_state === "active" && UUID.test(String(value?.active_pass_id || "")) &&
    ["starter", "private_agent"].includes(value?.tier) && Number.isFinite(expiry) &&
    expiry > nowMs + MIN_ACCESS_REMAINING_MS && Number.isSafeInteger(compute?.remaining_seconds) &&
    compute.remaining_seconds >= MIN_COMPUTE_SECONDS &&
    Number.isInteger(compute?.active_agent_limit) && compute.active_agent_limit > 0 &&
    Number.isInteger(compute?.active_agent_count) && compute.active_agent_count < compute.active_agent_limit &&
    currentPeriod(compute?.period_start, compute?.period_end, nowMs) &&
    Number.isSafeInteger(trading?.remaining_included_notional_micro_usd) &&
    trading.remaining_included_notional_micro_usd >= MIN_NOTIONAL_ALLOWANCE &&
    trading?.overage_notional_micro_usd === 0 && trading?.overage_fee_bps === 0 &&
    trading?.accrued_fee_micro_usd === 0 && trading?.queued_fee_cents === 0 &&
    trading?.invoiced_fee_cents === 0 && trading?.cap_reached === false &&
    trading?.live_trading_allowed === true && trading?.billing_state === "current" &&
    currentPeriod(trading?.period_start, trading?.period_end, nowMs);
}

function validTerminalAccess(value, release, nowMs) {
  const requirements = record(value?.account_requirements);
  const worker = record(value?.live_worker_readiness);
  const configured = Array.isArray(value?.configured_capabilities) ? value.configured_capabilities : [];
  const required = Array.isArray(value?.required_capabilities) ? value.required_capabilities : [];
  const authorized = Array.isArray(value?.authorized_capabilities) ? value.authorized_capabilities : [];
  const checkedAt = Date.parse(String(value?.checked_at || ""));
  return value?.version === 1 && value?.venue_id === "hyperliquid" && value?.network === "mainnet" &&
    validResponseCommitment(value, "access_commitment", "live_trading_terminal_access") &&
    value?.status === "green" && value?.opening_orders_enabled === true &&
    value?.access_mode === "account_canary" && value?.launch_state === "canary" &&
    sameReleaseFields(record(value?.release_identity), release) && record(value?.release_identity)?.valid === true &&
    worker?.ready === true && sameWorkerRelease(worker, release) &&
    Array.isArray(worker?.capabilities) &&
    required.length > 0 && required.includes("limit_order") && new Set(required).size === required.length &&
    new Set(configured).size === configured.length && new Set(authorized).size === authorized.length &&
    required.every((item) => configured.includes(item) && authorized.includes(item) && worker?.capabilities?.includes(item)) &&
    ["account_ready", "vault_ready", "eligibility_ready", "entitlement_ready", "graduation_ready"]
      .every((key) => requirements?.[key] === true) && Array.isArray(value?.reason_codes) &&
    value.reason_codes.length === 0 && Number.isFinite(checkedAt) && Math.abs(nowMs - checkedAt) <= 5 * 60_000;
}

function inspectOperationalReadiness(value, nowMs) {
  const checks = record(value?.checks);
  const live = record(value?.live_trading);
  const checkedAt = Date.parse(String(value?.checked_at || ""));
  const ready = value?.launch_profile === "byo_hyperliquid" && checks &&
    checks.database === "ready" && checks.trading_circuit === "ready" && checks.worker === "ready" &&
    checks.observability === "configured" && checks.reconciliation === "ready" &&
    checks.venue_connectivity === "configured" && checks.trading_control === "configured" &&
    ["configured", "not_required"].includes(String(checks.sentry || "")) &&
    live?.contract_version === 2 && live?.launch_state === "canary" && live?.release_valid === true &&
    live?.worker_ready === true && Number.isFinite(checkedAt) && Math.abs(nowMs - checkedAt) <= 5 * 60_000;
  return ready ? valid({ checkedAt: value.checked_at }) : invalid("production_observability_or_readiness_invalid");
}

function inspectOperationsEvidence(value, release, startedAtMs, nowMs) {
  const keys = record(value) ? Object.keys(value).sort() : [];
  const releaseIdentity = record(value?.release_identity);
  const rollback = record(value?.rollback);
  const replay = record(value?.restart_replay);
  const rollbackKeys = rollback ? Object.keys(rollback).sort() : [];
  const replayKeys = replay ? Object.keys(replay).sort() : [];
  const preparedAtMs = Date.parse(String(rollback?.prepared_at || ""));
  const operatorEmails = Array.isArray(rollback?.operator_email_commitments)
    ? rollback.operator_email_commitments
    : [];
  const currentReleaseCommitment = acceptanceCommitment(release);
  const validShape = JSON.stringify(keys) === JSON.stringify([
    "release_identity", "restart_replay", "rollback", "scope", "version",
  ]) && value.version === 1 && value.scope === "release_operations_attestation" &&
    JSON.stringify(Object.keys(releaseIdentity || {}).sort()) === JSON.stringify([
      "config_fingerprint", "contract_version", "web_git_sha", "worker_git_sha", "worker_image_digest",
    ]) &&
    JSON.stringify(rollbackKeys) === JSON.stringify([
      "incident_owner_commitment", "kill_control_commitment", "operator_email_commitments",
      "operator_email_set_complete", "prepared_at", "prior_release_artifact_commitment",
      "reduce_only_recovery_commitment", "rollback_artifact_commitment",
    ]) &&
    JSON.stringify(replayKeys) === JSON.stringify([
      "broadcast_count_after", "broadcast_count_before", "observed_at", "process_restart_observed",
      "rebroadcast_performed", "receipt_commitment", "receipt_replayed", "work_order_commitment",
    ]);
  const validRelease = releaseIdentity?.contract_version === release.contract_version &&
    sameReleaseFields(releaseIdentity, release);
  const validRollback = [
    rollback?.rollback_artifact_commitment,
    rollback?.prior_release_artifact_commitment,
    rollback?.incident_owner_commitment,
    rollback?.kill_control_commitment,
    rollback?.reduce_only_recovery_commitment,
  ].every((item) => DIGEST.test(String(item || ""))) &&
    rollback?.prior_release_artifact_commitment !== currentReleaseCommitment &&
    rollback?.operator_email_set_complete === true && operatorEmails.length > 0 && operatorEmails.length <= 32 &&
    new Set(operatorEmails).size === operatorEmails.length && operatorEmails.every((item) => DIGEST.test(String(item))) &&
    Number.isFinite(preparedAtMs) && preparedAtMs <= startedAtMs &&
    startedAtMs - preparedAtMs <= MAX_OPERATIONS_PREPARATION_AGE_MS;
  const validReplayShape = ENTRY_WORK_ORDER.test(String(replay?.work_order_commitment || "")) &&
    DIGEST.test(String(replay?.receipt_commitment || "")) && replay?.process_restart_observed === true &&
    replay?.receipt_replayed === true && replay?.rebroadcast_performed === false &&
    replay?.broadcast_count_before === 1 && replay?.broadcast_count_after === 1 &&
    freshAfter(replay?.observed_at, startedAtMs, nowMs);
  return validShape && validRelease && validRollback && validReplayShape
    ? valid({ releaseIdentity, rollback, replay })
    : invalid("release_operations_attestation_invalid");
}

function inspectNonOperatorCohort(operations, summaries) {
  if (!operations.ok || summaries.length !== 2) return invalid("non_operator_investor_evidence_invalid");
  const operators = new Set(operations.value.rollback.operator_email_commitments);
  const investors = summaries.map((item) => acceptanceCommitment({
    kind: "operator_email_v1",
    email: item.profileEmail,
  }));
  return investors.every((item) => !operators.has(item))
    ? valid({ investorCount: investors.length })
    : invalid("investor_operator_identity_forbidden");
}

function inspectRestartReplay(operations, summaries, startedAtMs, nowMs) {
  if (!operations.ok) return invalid("restart_replay_evidence_invalid");
  const replay = operations.value.replay;
  const receipts = summaries.flatMap((item) => item.replayReceipts);
  const match = receipts.find((item) => item.workOrder === replay.work_order_commitment &&
    item.receiptCommitment === replay.receipt_commitment);
  const createdAtMs = Date.parse(String(match?.createdAt || ""));
  return match && Number.isFinite(createdAtMs) && createdAtMs >= startedAtMs &&
      freshAfter(replay.observed_at, createdAtMs, nowMs)
    ? valid({ observedAt: replay.observed_at })
    : invalid("restart_replay_evidence_invalid");
}

function operationsSummary(value) {
  return {
    scope: "release_operations_attestation",
    rollback_artifact_commitment: value.rollback.rollback_artifact_commitment,
    prior_release_artifact_commitment: value.rollback.prior_release_artifact_commitment,
    incident_owner_commitment: value.rollback.incident_owner_commitment,
    kill_control_commitment: value.rollback.kill_control_commitment,
    reduce_only_recovery_commitment: value.rollback.reduce_only_recovery_commitment,
    operator_email_commitment_count: value.rollback.operator_email_commitments.length,
    prepared_at: value.rollback.prepared_at,
    restart_receipt_commitment: value.replay.receipt_commitment,
    restart_replay_observed_at: value.replay.observed_at,
    statement: "Operator commitments and restart observation attested; not machine-derived.",
  };
}

function inspectHumanAttestation(value, startedAtMs, nowMs, summaries) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify(["investors", "scope", "version"]) || value.version !== 1 ||
      value.scope !== "human_observations_only" || !Array.isArray(value.investors) || value.investors.length !== 2) {
    return invalid("protected_human_attestation_invalid");
  }
  for (const [index, item] of value.investors.entries()) {
    const expectedKeys = [...HUMAN_JOURNEY_FLAGS, "label", "observed_at"].sort();
    const label = index === 0 ? "A" : "B";
    const latestFillMs = Date.parse(String(summaries.find((summary) => summary.label === label)?.latestVenueFillAt || ""));
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(expectedKeys) ||
        item.label !== label || !HUMAN_JOURNEY_FLAGS.every((key) => item[key] === true) ||
        !Number.isFinite(latestFillMs) ||
        !freshAfter(item.observed_at, Math.max(startedAtMs, latestFillMs), nowMs)) {
      return invalid("protected_human_attestation_invalid");
    }
  }
  return valid({
    scope: "human_observations_only",
    investor_count: 2,
    latest_observed_at: [...value.investors].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0].observed_at,
    statement: "Full non-operator email, wallet, and UI journey attested; not machine-derived.",
  });
}

function finish(checks, release, summaries, human, now, operations = null, buildProvenance = null) {
  const ok = checks.length > 0 && checks.every((item) => item.ok);
  return {
    version: INVESTOR_CANARY_LIVE_VERIFIER_VERSION,
    status: ok ? "GO" : "NO-GO",
    checked_at: now.toISOString(),
    machine_evidence: {
      authoritative_sources_only: true,
      release: release ? {
        contract_version: release.contract_version,
        web_git_sha: release.web_git_sha,
        worker_git_sha: release.worker_git_sha,
        worker_image_digest: release.worker_image_digest,
        config_fingerprint: release.config_fingerprint,
        release_commitment: acceptanceCommitment(release),
        registry_build_provenance_verified: buildProvenance?.verified === true,
        build_provenance_commitment: buildProvenance?.commitment ?? null,
      } : null,
      investors: summaries.map((item) => ({
        label: item.label,
        subject_commitment: acceptanceCommitment(item.ownerCommitment),
        account_commitment: acceptanceCommitment(item.accountCommitment),
        vault_commitment: acceptanceCommitment(item.vaultCommitment),
        graduation_completed_at: item.graduationAt,
        terminal_filled_entries: item.terminalEntries,
        reduce_only_filled_closes: item.reduceOnlyCloses,
        protection_orders_canceled: item.protectionOrdersCanceled,
        latest_venue_fill_at: item.latestVenueFillAt,
        evidence_commitment: item.evidenceCommitment,
      })),
      checks,
    },
    human_attestation: human,
    operational_attestation: operations,
  };
}

function terminalFillProof(proof) {
  return proof?.proof_kind === "hyperliquid_execution_proof_v1" && proof?.network === "mainnet" &&
    proof?.broadcast_performed === true && proof?.final_venue_execution_proven === true &&
    proof?.final_fill_proven === true && proof?.final_no_fill_proven === false &&
    proof?.venue_order_readback_proven === true && String(proof?.terminal_status || "").toLowerCase() === "filled";
}

function sameProtectionProof(left, right) {
  return right?.position_protection_proven === true && [
    "take_profit_oid", "take_profit_cloid", "stop_loss_oid", "stop_loss_cloid",
  ].every((key) => String(left?.[key] || "").toLowerCase() === String(right?.[key] || "").toLowerCase());
}

function normalizedOrder(value) {
  const outer = record(value);
  const envelope = record(outer?.order) || outer;
  const order = record(envelope?.order) || envelope;
  const rawStatus = String(envelope?.status || outer?.status || order?.status || "").toLowerCase();
  const status = rawStatus === "cancelled" ? "canceled" : rawStatus;
  if (!order || !["filled", "canceled"].includes(status)) return null;
  return { ...order, status, reduceOnly: order.reduceOnly === true };
}

function historicalContains(rows, ref) {
  return rows.some((row) => {
    const order = normalizedOrder(row);
    return order && order.status === ref.expectedStatus &&
      (!ref.oid || String(order.oid || "") === ref.oid) &&
      (!ref.cloid || String(order.cloid || "").toLowerCase() === ref.cloid.toLowerCase());
  });
}

function fillMatches(fill, ref) {
  return String(fill?.coin || "").toUpperCase() === "HYPE" &&
    (!ref.oid || String(fill?.oid || "") === ref.oid) &&
    (!ref.cloid || String(fill?.cloid || "").toLowerCase() === ref.cloid.toLowerCase());
}

function positionFlat(row) {
  const position = record(row?.position) || record(row);
  const size = Number(position?.szi ?? 0);
  return Number.isFinite(size) && size === 0;
}

function spotExposureFlat(balances) {
  return balances.every((item) => {
    const coin = String(item?.coin || "").toUpperCase();
    const total = Number(item?.total ?? 0);
    const hold = Number(item?.hold ?? 0);
    return Number.isFinite(total) && Number.isFinite(hold) && hold === 0 && (coin === "USDC" || total === 0);
  });
}

function validAgentAuthorization(rows, expected) {
  if (!expected || rows.length > 16) return false;
  const matches = rows.filter((row) => {
    const address = String(row?.address || "").trim().toLowerCase();
    const name = String(row?.name || "").trim();
    const validUntil = Number(row?.validUntil ?? row?.valid_until);
    return ADDRESS.test(address) &&
      gholaCommitment("hyperliquid_agent_wallet", address) === expected.agentWalletCommitment &&
      (name === expected.agentName || name === `${expected.agentName} valid_until ${expected.validUntilMs}`) &&
      validUntil === expected.validUntilMs;
  });
  return matches.length === 1;
}

function validResponseCommitment(value, key, prefix) {
  const object = record(value);
  const claimed = String(object?.[key] || "");
  if (!new RegExp(`^${prefix}_[0-9a-f]{48}$`, "u").test(claimed)) return false;
  const response = { ...object };
  delete response[key];
  return claimed === gholaCommitment(prefix, response);
}

function sameStringSet(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    new Set(value).size === value.length && expected.every((item) => value.includes(item));
}

function parseVaultAad(value) {
  if (typeof value !== "string") return null;
  const parts = value.split("|");
  if (parts.length !== 6 || parts[0] !== "ghola/hyperliquid-execution-vault-v2") return null;
  if (!parts[1].startsWith("account:") || !parts[2].startsWith("recipient:") ||
      parts[3] !== "network:mainnet" || !parts[4].startsWith("venue-account:") ||
      !parts[5].startsWith("agent-wallet:")) return null;
  return {
    version: 2,
    accountCommitment: parts[1].slice(8),
    network: "mainnet",
    venueAccountCommitment: parts[4].slice(14),
    agentWalletCommitment: parts[5].slice(13),
    recipient: parts[2].slice(10),
  };
}

function sameReleaseStatus(left, right) {
  return left?.launch_state === right?.launch_state && left?.status === right?.status &&
    stableJson(left?.release_identity) === stableJson(right?.release_identity) &&
    sameWorkerRelease(record(left?.live_worker_readiness), record(right?.release_identity)) &&
    sameWorkerRelease(record(right?.live_worker_readiness), record(left?.release_identity)) &&
    stableJson(left?.live_worker_readiness?.capabilities) === stableJson(right?.live_worker_readiness?.capabilities) &&
    left?.live_worker_readiness?.ready === right?.live_worker_readiness?.ready;
}

function sameReleaseFields(value, release) {
  return value?.web_git_sha === release?.web_git_sha && value?.worker_git_sha === release?.worker_git_sha &&
    value?.worker_image_digest === release?.worker_image_digest && value?.config_fingerprint === release?.config_fingerprint;
}

function sameWorkerRelease(value, release) {
  return (value?.contract_version ?? value?.worker_contract_version) === release?.contract_version &&
    value?.worker_git_sha === release?.worker_git_sha &&
    value?.worker_image_digest === release?.worker_image_digest &&
    (value?.config_fingerprint ?? value?.worker_config_fingerprint) === release?.config_fingerprint;
}

function currentPeriod(start, end, nowMs) {
  const startMs = Date.parse(String(start || ""));
  const endMs = Date.parse(String(end || ""));
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= nowMs && nowMs < endMs;
}

function freshAfter(value, startMs, nowMs) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= nowMs + 30_000;
}

function freshDbClock(value, nowMs) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && Math.abs(timestamp - nowMs) <= 5 * 60_000;
}

function stringId(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^(?:[1-9][0-9]*|0x[0-9a-f]{32})$/u.test(text) ? text : null;
}

function one(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function byCreatedAt(left, right) {
  return Date.parse(left.createdAt || left.created_at || "") - Date.parse(right.createdAt || right.created_at || "");
}

function valid(value) {
  return { ok: true, value };
}

function invalid(failure) {
  return { ok: false, failure };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
