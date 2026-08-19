import { createHash } from "node:crypto";

export const INVESTOR_CANARY_CONTRACT_VERSION = 2;
export const LIVE_TRADING_CONTRACT_VERSION = 2;
export const GRADUATION_RECORD_VERSION = 3;
export const REQUIRED_INVESTOR_RUNS = 2;
export const REQUIRED_TERMINAL_ROUND_TRIPS = 2;
export const REQUIRED_COMPUTE_SECONDS = 600;
export const REQUIRED_FILLED_NOTIONAL_MICRO_USD = 22_000_000;
export const REQUIRED_TERMINAL_NOTIONAL_USD = 11;
export const ACCESS_MIN_REMAINING_MS = 30 * 60 * 1_000;
export const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const CURRENT_PROOF_NAMESPACE = "hl_mainnet_investor_proof_v2";
export const CURRENT_TERMINAL_CLAIM_NAMESPACE = "worker_execution_claims";

const PASS_TIERS = new Set(["starter", "private_agent"]);
const REQUIRED_CONFIGURED_CAPABILITIES = [
  "limit_order",
  "cancel",
  "reduce_only",
  "stop_loss",
  "take_profit",
];
const REQUIRED_OPENING_CAPABILITIES = ["limit_order", "stop_loss", "take_profit"];
const CREDENTIAL_KEY = /(?:^|_)(?:api_?key|private_?key|secret|token|password|passphrase|mnemonic|seed|cookie|ciphertext|signature_?b64|raw_?signature|invite_?code|invite_?token)(?:$|_)/iu;
const RAW_ID_KEY = /(?:^|_)(?:email|wallet_address|account_address|api_wallet_address|order_id|oid|cloid|venue_order_oid|provider_order_id|transaction_hash|transaction_hashes)$/iu;
const RAW_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const RAW_HEX_IDENTIFIER = /\b0x[0-9a-f]{40}(?:[0-9a-f]{24})?\b/iu;
const RAW_INVITE_URL = /(?:[?#&]access=|authorization:\s*bearer\s+)/iu;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const PROOF_WORK_ORDER = /^hl_mainnet_investor_proof_v2_[0-9a-f]{32}$/u;
const TERMINAL_WORK_ORDER = /^live_trade_work_order_[0-9a-f]{48}$/u;
const CLOSE_WORK_ORDER = /^hl_close_[0-9a-f]{40}_close_hype_[1-3]$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{3,200}$/u;
const ACCESS_COMMITMENT = /^live_trading_terminal_access_[0-9a-f]{48}$/u;

const PROOF_RECEIPT_KEYS = new Set([
  "sanitized",
  "ok",
  "status",
  "network",
  "market",
  "notional_usd",
  "max_slippage_bps",
  "claim_store",
  "claim_namespace",
  "proof_work_order_commitment",
  "entry_work_order_commitment",
  "exit_work_order_commitment",
  "receipt_commitment",
  "result_commitment",
  "venue_evidence_commitment",
  "entry_order_commitment",
  "exit_order_commitment",
  "entry_transaction_commitment",
  "exit_transaction_commitment",
  "preflight_verified",
  "preflight_transaction_broadcast",
  "exit_preflight_verified",
  "exit_preflight_transaction_broadcast",
  "api_wallet_authorization_verified",
  "duplicate_entry_prevented",
  "duplicate_exit_prevented",
  "stored_receipt_replayed",
  "isolated_margin",
  "leverage",
  "entry_fill_proven",
  "exit_fill_proven",
  "reduce_only_exit_proven",
  "position_protection_proven",
  "protection_cleanup_confirmed",
  "protection_children_terminal",
  "independent_venue_evidence_proven",
  "transaction_hashes_distinct",
  "fees_paid",
  "flat_after_exit",
  "open_orders_after_exit",
  "account_graduated",
  "completed_at",
]);

export function acceptanceCommitment(value) {
  return "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sanitizeFundedMainnetProofReport(report) {
  if (!isRecord(report) || findCredentialFields(report).length > 0) {
    throw new Error("proof_report_invalid_or_secret_bearing");
  }
  const root = report.proof_work_order_commitment;
  const venue = isRecord(report.venue_evidence) ? report.venue_evidence : {};
  const entry = isRecord(report.entry_order_reference) ? report.entry_order_reference : venue.entry;
  const exit = isRecord(report.exit_order_reference) ? report.exit_order_reference : venue.exit;
  if (!PROOF_WORK_ORDER.test(root || "") || !isRecord(entry) || !isRecord(exit) ||
      !Array.isArray(entry.transaction_hashes) || !Array.isArray(exit.transaction_hashes) ||
      entry.transaction_hashes.length === 0 || exit.transaction_hashes.length === 0) {
    throw new Error("proof_report_evidence_incomplete");
  }
  const venueEvidenceCommitment = digest(report.venue_evidence_commitment)
    ? report.venue_evidence_commitment
    : acceptanceCommitment({ kind: "venue_evidence", value: venue });
  return {
    sanitized: true,
    ok: report.ok === true,
    status: report.status,
    network: report.network,
    market: report.market,
    notional_usd: report.notional_usd,
    max_slippage_bps: report.max_slippage_bps,
    claim_store: report.claim_store,
    claim_namespace: CURRENT_PROOF_NAMESPACE,
    proof_work_order_commitment: root,
    entry_work_order_commitment: report.entry_work_order_commitment,
    exit_work_order_commitment: report.exit_work_order_commitment,
    receipt_commitment: acceptanceCommitment({ kind: "proof_receipt", root, completed_at: report.completed_at }),
    result_commitment: acceptanceCommitment({ kind: "proof_result", report }),
    venue_evidence_commitment: venueEvidenceCommitment,
    entry_order_commitment: acceptanceCommitment({ kind: "entry_order", entry }),
    exit_order_commitment: acceptanceCommitment({ kind: "exit_order", exit }),
    entry_transaction_commitment: acceptanceCommitment({ kind: "entry_transactions", hashes: entry.transaction_hashes }),
    exit_transaction_commitment: acceptanceCommitment({ kind: "exit_transactions", hashes: exit.transaction_hashes }),
    preflight_verified: report.preflight_verified === true,
    preflight_transaction_broadcast: report.preflight_transaction_broadcast,
    exit_preflight_verified: report.exit_preflight_verified === true,
    exit_preflight_transaction_broadcast: report.exit_preflight_transaction_broadcast,
    api_wallet_authorization_verified: report.api_wallet_authorization_verified === true,
    duplicate_entry_prevented: report.duplicate_entry_prevented === true,
    duplicate_exit_prevented: report.duplicate_exit_prevented === true,
    stored_receipt_replayed: report.stored_receipt_replayed === true,
    isolated_margin: report.default_margin_mode === "isolated",
    leverage: report.default_leverage,
    entry_fill_proven: report.entry_fill_proven === true,
    exit_fill_proven: report.exit_fill_proven === true,
    reduce_only_exit_proven: venue.reduce_only_exit_proven === true,
    position_protection_proven: report.venue_position_protection_proven === true,
    protection_cleanup_confirmed: report.protection_cleanup_confirmed === true,
    protection_children_terminal: report.protection_children_terminal === true,
    independent_venue_evidence_proven: report.independent_venue_evidence_proven === true,
    transaction_hashes_distinct: venue.transaction_hashes_distinct === true,
    fees_paid: Number(entry.fee_usd) > 0 && Number(exit.fee_usd) > 0,
    flat_after_exit: report.flat_after_exit === true,
    open_orders_after_exit: report.open_orders_after_exit,
    account_graduated: report.account_graduated === true,
    completed_at: report.completed_at,
  };
}

export function sanitizeHyperliquidCloseReport(report) {
  if (!isRecord(report) || findCredentialFields(report).length > 0) {
    throw new Error("close_report_invalid_or_secret_bearing");
  }
  const cancellations = Array.isArray(report.cancellations) ? report.cancellations : [];
  const closes = Array.isArray(report.closes) ? report.closes : [];
  if (closes.length === 0 || closes.some((item) => !isRecord(item)) ||
      cancellations.some((item) => !isRecord(item))) {
    throw new Error("close_report_evidence_incomplete");
  }
  return {
    sanitized: true,
    version: report.version,
    proof_kind: report.proof_kind,
    status: report.status,
    network: report.network,
    markets: report.markets,
    initial_position_count: report.initial_position_count,
    initial_open_order_count: report.initial_open_order_count,
    cancellations: cancellations.map((item) => ({
      market: item.market,
      work_order_commitment: item.work_order_commitment,
      order_commitment: acceptanceCommitment({
        oid: item.venue_order_oid,
        work_order_commitment: item.work_order_commitment,
      }),
      terminal_status: item.terminal_status,
      venue_readback_proven: item.venue_readback_proven === true,
      replay_protected: item.replay_protected === true,
    })),
    closes: closes.map((item) => ({
      market: item.market,
      work_order_commitment: item.work_order_commitment,
      order_commitment: acceptanceCommitment({
        oid: item.venue_order_oid,
        cloid: item.venue_order_cloid,
        work_order_commitment: item.work_order_commitment,
      }),
      terminal_status: item.terminal_status,
      reduce_only: item.reduce_only === true,
      fill_count_bucket: item.fill_count_bucket,
      fill_evidence_commitment: acceptanceCommitment(item.fill_evidence_commitment),
      venue_readback_proven: item.venue_readback_proven === true,
      replay_protected: item.replay_protected === true,
    })),
    reduce_only_exit_proven: report.reduce_only_exit_proven === true,
    cancellations_terminal: report.cancellations_terminal === true,
    market_flat: report.market_flat === true,
    account_flat: report.account_flat === true,
    open_order_count: report.open_order_count,
    final_flat_proven: report.final_flat_proven === true,
    reconciled_at: report.reconciled_at,
    completed_at: report.completed_at,
    root_work_order_commitment: report.root_work_order_commitment,
    worker_evidence_commitment: acceptanceCommitment(report.evidence_commitment),
    report_commitment: acceptanceCommitment(report),
  };
}

export function validateInvestorCanaryDossier(dossier, { now = new Date() } = {}) {
  const checks = [];
  const check = (id, ok, failure) => {
    checks.push({ id, ok: Boolean(ok), ...(ok ? {} : { failure }) });
    return Boolean(ok);
  };
  if (!isRecord(dossier)) {
    check("dossier.shape", false, "dossier_not_object");
    return result(checks, dossier);
  }

  const forbidden = [
    ...findForbiddenFields(dossier),
    ...findForbiddenValues(dossier),
  ];
  check("dossier.sanitized", forbidden.length === 0, "forbidden_secret_or_raw_identifier");
  check(
    "dossier.contract",
    dossier.version === INVESTOR_CANARY_CONTRACT_VERSION &&
      dossier.mode === "invite_only_account_canary" &&
      dossier.acceptance_scope === "graduation_plus_two_normal_terminal_roundtrips",
    "acceptance_contract_mismatch",
  );

  const release = isRecord(dossier.release) ? dossier.release : {};
  const identity = releaseIdentity(release.identity);
  check("release.identity", identity.ok, "release_identity_invalid");
  check(
    "release.immutable",
    release.immutable === true && safeId(release.deployment_id) &&
      digest(release.release_manifest_commitment),
    "immutable_release_evidence_missing",
  );
  check(
    "release.canary_only",
    release.launch_state === "canary" &&
      release.public_live_enabled === false &&
      release.public_rollout_percent === 0,
    "launch_must_remain_non_public_canary",
  );
  check(
    "release.worker",
    workerMatchesRelease(release.worker, identity.value, now),
    "worker_release_or_attestation_mismatch",
  );
  check(
    "release.global_red",
    verifyGlobalRedStatus(release.global_status, identity.value, now),
    "global_public_gate_must_remain_red",
  );
  check(
    "release.fresh",
    freshTimestamp(release.checked_at, now, EVIDENCE_MAX_AGE_MS),
    "release_evidence_stale",
  );

  check(
    "invite.server_enforced",
    verifyInviteGate(dossier.invite_gate, now),
    "email_bound_single_use_invite_gate_unproven",
  );
  check(
    "rollback.ready",
    verifyRollback(dossier.rollback, identity.value, now),
    "rollback_or_restart_recovery_gate_incomplete",
  );

  const proofs = Array.isArray(dossier.graduation_proofs) ? dossier.graduation_proofs : [];
  const proofById = new Map();
  const proofResults = new Map();
  for (const proof of proofs) {
    const proofId = isRecord(proof) && safeId(proof.proof_id) ? proof.proof_id : null;
    if (proofId && !proofById.has(proofId)) proofById.set(proofId, proof);
    proofResults.set(proofId || "invalid-" + proofResults.size, verifyProof(proof, identity.value, now));
  }
  check(
    "graduations.two_release_bound",
    proofs.length === REQUIRED_INVESTOR_RUNS && proofById.size === proofs.length &&
      [...proofResults.values()].every((item) => item.ok),
    firstFailure(proofResults) || "two_release_bound_graduations_required",
  );

  const investorRuns = Array.isArray(dossier.investor_runs) ? dossier.investor_runs : [];
  const investorResults = investorRuns.map((run) => verifyInvestorRun(run, {
    proofById,
    releaseIdentity: identity.value,
    now,
  }));
  check(
    "investors.two_clean_runs",
    investorRuns.length === REQUIRED_INVESTOR_RUNS && investorResults.every((item) => item.ok),
    investorResults.find((item) => !item.ok)?.failure || "two_investor_runs_required",
  );
  check(
    "investors.independent",
    uniqueInvestorCommitments(investorRuns),
    "investor_identity_invite_vault_or_account_reused",
  );
  check(
    "terminal.distinct_submissions",
    terminalEvidenceDistinct(investorRuns),
    "terminal_plan_claim_order_or_transaction_reused",
  );
  check(
    "claims.current_postgres_namespace",
    allClaimsCurrent(investorRuns),
    "terminal_claim_missing_unresolved_or_legacy",
  );
  check(
    "rollback.recovery_linked",
    rollbackRecoveryLinked(dossier.rollback, investorRuns),
    "restart_recovery_work_order_not_in_acceptance_run",
  );
  check(
    "graduations.exactly_linked",
    proofsExactlyLinked(proofs, investorRuns),
    "graduation_proof_unlinked_or_reused",
  );
  check(
    "dossier.fresh",
    freshTimestamp(dossier.generated_at, now, EVIDENCE_MAX_AGE_MS),
    "dossier_stale",
  );
  return result(checks, dossier, identity.value);
}

export function verifyInvestorCanaryAcceptance(dossier, options = {}) {
  const report = validateInvestorCanaryDossier(dossier, options);
  const liveCheck = {
    id: "evidence.live_authenticated",
    ok: false,
    failure: "live_authenticated_evidence_required",
  };
  return {
    ...report,
    ok: false,
    checks: [liveCheck, ...report.checks],
    failures: [liveCheck.failure, ...report.failures],
  };
}

function verifyProof(proof, expectedRelease, now) {
  if (!isRecord(proof)) return invalid("proof_not_object");
  if (!safeId(proof.proof_id) || !digest(proof.owner_commitment) ||
      !digest(proof.venue_account_commitment) || !digest(proof.vault_commitment)) {
    return invalid("proof_identity_invalid");
  }
  const identity = releaseIdentity(proof.release_identity);
  if (!identity.ok || !sameRelease(identity.value, expectedRelease)) {
    return invalid("proof_release_mismatch");
  }
  const completedAt = time(proof.receipt?.completed_at);
  if (!verifyEntitlement(proof.entitlement, completedAt)) return invalid("proof_entitlement_invalid");
  if (!verifyProofAccess(proof.preflight_access, proof.vault_commitment, false, completedAt)) {
    return invalid("proof_preflight_access_invalid");
  }
  if (!verifyVault(proof.vault, proof.vault_commitment, completedAt)) return invalid("proof_vault_invalid");
  if (!verifyFlatVenueState(proof.pre_state, proof.venue_account_commitment, now)) {
    return invalid("proof_initial_state_not_flat");
  }
  if (!verifyProofHumanControl(proof.human_control)) return invalid("proof_human_confirmation_missing");
  if (!verifyProofReceipt(proof.receipt, now)) return invalid("sanitized_proof_receipt_invalid");
  if (!verifyProofAccess(proof.postflight_access, proof.vault_commitment, true, completedAt)) {
    return invalid("proof_graduation_access_invalid");
  }
  if (!verifyGraduation(proof.graduation, proof, expectedRelease)) {
    return invalid("graduation_not_bound_to_exact_release");
  }
  if (!verifyFlatVenueState(proof.final_state, proof.venue_account_commitment, now)) {
    return invalid("proof_final_state_not_flat");
  }
  const preAt = time(proof.pre_state?.checked_at);
  const finalAt = time(proof.final_state?.checked_at);
  if (!(preAt <= completedAt && completedAt <= finalAt)) return invalid("proof_timeline_invalid");
  return { ok: true };
}

function verifyInvestorRun(run, { proofById, releaseIdentity: expectedRelease, now }) {
  if (!isRecord(run) || !safeId(run.run_id) || !digest(run.owner_commitment) ||
      !digest(run.venue_account_commitment) || !digest(run.phantom_wallet_commitment) ||
      !digest(run.vault_commitment)) {
    return invalid("investor_identity_invalid");
  }
  const identity = releaseIdentity(run.release_identity);
  if (!identity.ok || !sameRelease(identity.value, expectedRelease)) {
    return invalid("investor_release_mismatch");
  }
  if (!verifyRedeemedInvite(run.invite, run.owner_commitment, now)) {
    return invalid("investor_invite_binding_invalid");
  }
  const proof = proofById.get(run.graduation_proof_id);
  if (!proof || proof.owner_commitment !== run.owner_commitment ||
      proof.venue_account_commitment !== run.venue_account_commitment ||
      proof.vault_commitment !== run.vault_commitment) {
    return invalid("investor_graduation_proof_mismatch");
  }
  if (!verifyNegativeControl(run.negative_control_access, run.owner_commitment, expectedRelease, now)) {
    return invalid("account_canary_negative_control_invalid");
  }
  const roundTrips = Array.isArray(run.terminal_round_trips) ? run.terminal_round_trips : [];
  if (roundTrips.length !== REQUIRED_TERMINAL_ROUND_TRIPS) {
    return invalid("two_normal_terminal_roundtrips_required");
  }
  for (const trade of roundTrips) {
    const verified = verifyTerminalRoundTrip(trade, run, expectedRelease, now);
    if (!verified.ok) return verified;
  }
  const first = roundTrips[0];
  const second = roundTrips[1];
  const reload = isRecord(run.reload) ? run.reload : {};
  const firstAt = time(first?.final_state?.checked_at);
  const reloadAt = time(reload.at);
  const secondAt = time(second?.entry?.submitted_at);
  if (reload.full_document_reload !== true || reload.human_initiated !== true ||
      reload.automation_used !== false || !digest(reload.pre_reload_document_commitment) ||
      !digest(reload.post_reload_document_commitment) ||
      reload.pre_reload_document_commitment === reload.post_reload_document_commitment ||
      !(firstAt < reloadAt && reloadAt < secondAt)) {
    return invalid("investor_reload_evidence_invalid");
  }
  return { ok: true };
}

function verifyTerminalRoundTrip(trade, run, expectedRelease, now) {
  if (!isRecord(trade) || !safeId(trade.trade_id) || trade.route !== "normal_terminal" ||
      trade.owner_commitment !== run.owner_commitment ||
      trade.venue_account_commitment !== run.venue_account_commitment ||
      trade.vault_commitment !== run.vault_commitment) {
    return invalid("terminal_trade_identity_or_route_invalid");
  }
  const identity = releaseIdentity(trade.release_identity);
  if (!identity.ok || !sameRelease(identity.value, expectedRelease)) {
    return invalid("terminal_trade_release_mismatch");
  }
  const entryAt = time(trade.entry?.submitted_at);
  if (!verifyEntitlement(trade.entitlement, entryAt)) return invalid("terminal_entitlement_invalid");
  if (!verifyTerminalAccess(trade.account_canary_access, run.owner_commitment, expectedRelease, entryAt)) {
    return invalid("owner_account_canary_access_invalid");
  }
  if (!verifyFlatVenueState(trade.pre_state, run.venue_account_commitment, now)) {
    return invalid("terminal_pre_state_not_flat");
  }
  if (!verifyOrderPlan(trade.order_plan, entryAt)) return invalid("terminal_order_plan_invalid");
  if (!verifyTerminalHumanControl(trade.human_control)) {
    return invalid("terminal_human_confirmation_missing");
  }
  if (!verifyTerminalEntry(trade.entry, trade.order_plan, now)) {
    return invalid("terminal_entry_fill_not_proven");
  }
  if (!verifyOpenVenueState(trade.post_entry_state, run.venue_account_commitment, now)) {
    return invalid("terminal_post_entry_exposure_or_protection_unproven");
  }
  if (!verifyTerminalClose(trade.close, now)) {
    return invalid("terminal_reduce_only_close_invalid");
  }
  if (!verifyFlatVenueState(trade.final_state, run.venue_account_commitment, now)) {
    return invalid("terminal_final_state_not_flat");
  }
  const preAt = time(trade.pre_state?.checked_at);
  const fillAt = time(trade.entry?.venue_fill?.completed_at);
  const openAt = time(trade.post_entry_state?.checked_at);
  const closeSubmittedAt = time(trade.close?.submitted_at);
  const closeCompletedAt = time(trade.close?.report?.completed_at);
  const finalAt = time(trade.final_state?.checked_at);
  if (!(preAt <= entryAt && entryAt <= fillAt && fillAt <= openAt &&
      openAt <= closeSubmittedAt && closeSubmittedAt <= closeCompletedAt &&
      closeCompletedAt <= finalAt)) {
    return invalid("terminal_roundtrip_timeline_invalid");
  }
  return { ok: true };
}

function verifyEntitlement(value, actionAt) {
  if (!isRecord(value) || !PASS_TIERS.has(value.tier) ||
      value.access_source !== "complimentary_pass" || !Number.isFinite(actionAt) ||
      !timestamp(value.checked_at) || !timestamp(value.expires_at)) return false;
  const checkedAt = time(value.checked_at);
  const actionTime = actionAt;
  const expiresAt = time(value.expires_at);
  if (checkedAt > actionTime + 5_000 || actionTime - checkedAt > 5 * 60_000 ||
      expiresAt - actionTime <= ACCESS_MIN_REMAINING_MS) return false;
  const compute = isRecord(value.private_agent_compute) ? value.private_agent_compute : {};
  const trading = isRecord(value.private_agent_trading) ? value.private_agent_trading : {};
  return Number.isFinite(compute.remaining_seconds) &&
    compute.remaining_seconds >= REQUIRED_COMPUTE_SECONDS &&
    Number.isInteger(compute.active_agent_limit) && compute.active_agent_limit > 0 &&
    Number.isInteger(compute.active_agent_count) && compute.active_agent_count < compute.active_agent_limit &&
    trading.live_trading_allowed === true && trading.cap_reached === false &&
    trading.overage_fee_bps === 0 &&
    Number.isFinite(trading.remaining_included_notional_micro_usd) &&
    trading.remaining_included_notional_micro_usd >= REQUIRED_FILLED_NOTIONAL_MICRO_USD &&
    time(trading.period_end) > actionTime;
}

function verifyInviteGate(value, now) {
  return isRecord(value) &&
    value.mode === "email_bound_single_use_complimentary_pass" &&
    value.issue_path === "/api/billing/access-passes" &&
    value.redeem_path === "/api/billing/access-passes/redeem" &&
    value.landing_path === "/account" &&
    value.transport === "url_fragment" && value.fragment_key === "access" &&
    value.operator_auth_required === true && value.dual_operator_auth_required === true &&
    value.issuer_stdout_redacted === true && value.protected_artifact_mode === "0600" &&
    value.server_redeem_enforced === true &&
    value.email_bound === true &&
    value.single_use === true &&
    value.postgres_backed === true &&
    value.public_discovery_disabled === true &&
    value.fragment_captured_and_scrubbed === true &&
    digest(value.pass_store_commitment) &&
    freshTimestamp(value.checked_at, now, EVIDENCE_MAX_AGE_MS);
}

function verifyRedeemedInvite(value, ownerCommitment, now) {
  return isRecord(value) && digest(value.pass_commitment) &&
    digest(value.email_commitment) &&
    value.owner_commitment === ownerCommitment &&
    value.access_source === "complimentary_pass" &&
    value.redeemed_once === true && value.revoked === false &&
    timestamp(value.redeemed_at) && futureTimestamp(value.expires_at, now);
}

function verifyProofAccess(value, vaultCommitment, graduated, actionAt) {
  return isRecord(value) && value.network === "mainnet" && value.vault_ready === true &&
    value.eligibility_ready === true && value.graduation_ready === graduated &&
    value.vault_commitment === vaultCommitment && time(value.eligibility_expires_at) > actionAt &&
    Math.abs(actionAt - time(value.checked_at)) <= 5 * 60_000 &&
    (graduated ? timestamp(value.proof_completed_at) : value.proof_completed_at == null);
}

function verifyVault(value, vaultCommitment, actionAt) {
  return isRecord(value) && value.status === "sealed" && value.network === "mainnet" &&
    value.vault_commitment === vaultCommitment && value.trade_only === true &&
    value.withdrawal_authority === false &&
    Math.abs(actionAt - time(value.checked_at)) <= 5 * 60_000;
}

function verifyGraduation(value, proof, expectedRelease) {
  if (!isRecord(value) || value.version !== GRADUATION_RECORD_VERSION ||
      value.contract_version !== LIVE_TRADING_CONTRACT_VERSION ||
      value.status !== "active" || !safeId(value.graduation_id) ||
      value.owner_commitment !== proof.owner_commitment ||
      value.account_commitment !== proof.venue_account_commitment ||
      value.vault_commitment !== proof.vault_commitment ||
      !safeId(value.proof_evidence_commitment) ||
      value.proof_notional_usd !== REQUIRED_TERMINAL_NOTIONAL_USD ||
      value.completed_at !== proof.receipt?.completed_at) return false;
  return sameReleaseFields(value, expectedRelease);
}

function verifyTerminalAccess(value, ownerCommitment, expectedRelease, actionAt) {
  if (!isRecord(value) || value.source_path !== "/v1/private-account/live-trading/terminal-access" ||
      value.authenticated_owner_commitment !== ownerCommitment || value.version !== 1 ||
      value.status !== "green" || value.venue_id !== "hyperliquid" || value.network !== "mainnet" ||
      value.opening_orders_enabled !== true || value.access_mode !== "account_canary" ||
      value.launch_state !== "canary" || !ACCESS_COMMITMENT.test(value.access_commitment || "") ||
      !sameReleaseFromValue(value.release_identity, expectedRelease) ||
      !sameCanonicalCaps(value.effective_caps) || !timestamp(value.graduation_completed_at) ||
      !Array.isArray(value.reason_codes) || value.reason_codes.length !== 0 ||
      !capabilitiesContain(value.configured_capabilities, REQUIRED_CONFIGURED_CAPABILITIES) ||
      !sameStringSet(value.required_capabilities, REQUIRED_OPENING_CAPABILITIES) ||
      !capabilitiesContain(value.authorized_capabilities, REQUIRED_OPENING_CAPABILITIES)) return false;
  const requirements = isRecord(value.account_requirements) ? value.account_requirements : {};
  if (!["account_ready", "vault_ready", "eligibility_ready", "entitlement_ready", "graduation_ready"]
    .every((key) => requirements[key] === true)) return false;
  const checkedAt = time(value.checked_at);
  return checkedAt <= actionAt + 1_000 && actionAt - checkedAt <= 30_000 &&
    workerAccessMatchesRelease(value.live_worker_readiness, expectedRelease, actionAt);
}

function verifyNegativeControl(value, ownerCommitment, expectedRelease, now) {
  if (!isRecord(value) || value.source_path !== "/v1/private-account/live-trading/terminal-access" ||
      !digest(value.authenticated_owner_commitment) ||
      value.authenticated_owner_commitment === ownerCommitment ||
      value.version !== 1 || value.status !== "red" || value.opening_orders_enabled !== false ||
      value.access_mode !== "blocked" || value.launch_state !== "canary" ||
      !sameReleaseFromValue(value.release_identity, expectedRelease) ||
      !ACCESS_COMMITMENT.test(value.access_commitment || "") ||
      !Array.isArray(value.authorized_capabilities) || value.authorized_capabilities.length !== 0 ||
      !Array.isArray(value.reason_codes) || value.reason_codes.length === 0 ||
      !freshTimestamp(value.checked_at, now, EVIDENCE_MAX_AGE_MS)) return false;
  const requirements = isRecord(value.account_requirements) ? value.account_requirements : {};
  return ["account_ready", "vault_ready", "eligibility_ready", "entitlement_ready", "graduation_ready"]
    .some((key) => requirements[key] === false);
}

function verifyOrderPlan(value, submittedAt) {
  if (!isRecord(value) || value.market !== "HYPE" || value.order_type !== "limit" ||
      value.time_in_force !== "ioc" || !["buy", "sell"].includes(value.side) ||
      value.quote_notional_usd !== REQUIRED_TERMINAL_NOTIONAL_USD ||
      value.reduce_only !== false || value.margin_mode !== "isolated" || value.leverage !== 1 ||
      !Number.isInteger(value.max_slippage_bps) || value.max_slippage_bps < 1 ||
      value.max_slippage_bps > 100 || !digest(value.plan_digest) ||
      !digest(value.preview_commitment) || !digest(value.idempotency_commitment) ||
      !timestamp(value.issued_at) || !timestamp(value.expires_at) ||
      !(time(value.issued_at) <= submittedAt && submittedAt < time(value.expires_at))) return false;
  const protection = isRecord(value.position_protection) ? value.position_protection : {};
  return protection.mode === "normal_tpsl" && protection.stop_loss_bound === true &&
    protection.take_profit_bound === true && protection.trigger_source === "mark" &&
    protection.trigger_order_type === "bounded_limit";
}

function verifyTerminalEntry(value, plan, now) {
  if (!isRecord(value) || !timestamp(value.submitted_at)) return false;
  const noFillAttempts = Array.isArray(value.prior_terminal_no_fills)
    ? value.prior_terminal_no_fills
    : [];
  if (!noFillAttempts.every((attempt) => verifyTerminalNoFillAttempt(
    attempt,
    time(value.submitted_at),
    now,
  ))) return false;
  const ack = isRecord(value.gateway_ack) ? value.gateway_ack : {};
  const claim = isRecord(value.claim) ? value.claim : {};
  const fill = isRecord(value.venue_fill) ? value.venue_fill : {};
  const workOrder = ack.work_order_commitment;
  const commitments = [
    ack.receipt_commitment,
    ack.result_commitment,
    fill.raw_worker_receipt_commitment,
    fill.order_commitment,
    fill.transaction_commitment,
    fill.fill_evidence_commitment,
  ];
  const ackValid = ack.sanitized === true && ack.outcome === "acknowledged" &&
    ["submitted", "reconciled"].includes(ack.status) && ack.dispatch === "dispatched" &&
    ack.fill_proof === false && ack.plan_digest === plan.plan_digest &&
    ack.response_plan_digest === plan.plan_digest &&
    TERMINAL_WORK_ORDER.test(workOrder || "") && commitments.every(digest) &&
    new Set(commitments).size === commitments.length;
  const fillValid = fill.sanitized === true &&
    fill.proof_kind === "hyperliquid_execution_proof_v1" &&
    fill.network === "mainnet" && fill.market === "HYPE" &&
    fill.work_order_commitment === workOrder &&
    fill.terminal_status === "filled" && fill.broadcast_performed === true &&
    fill.final_venue_execution_proven === true && fill.final_fill_proven === true &&
    fill.final_no_fill_proven === false && fill.venue_order_readback_proven === true &&
    fill.venue_order_status === "filled" && fill.execution_configuration_proven === true &&
    fill.margin_mode === "isolated" && fill.leverage === 1 &&
    fill.market_data_freshness_proven === true && fill.market_slippage_bound_proven === true &&
    Number.isInteger(fill.market_source_age_ms) && fill.market_source_age_ms >= 0 &&
    fill.market_source_age_ms <= 2_000 && fill.market_max_age_ms === 2_000 &&
    fill.action_expiry_proven === true && fill.position_protection_proven === true &&
    fill.protection_grouping === "normalTpsl" && fill.protection_trigger_source === "mark" &&
    fill.protection_trigger_order_type === "bounded_limit" &&
    fill.fill_status === "full" && Number.isInteger(fill.fill_count) && fill.fill_count >= 1 &&
    Number.isFinite(fill.filled_notional_usd) && fill.filled_notional_usd >= 10.5 &&
    fill.filled_notional_usd <= 11.5 && fill.fee_paid === true &&
    fill.ioc_remainder_terminal === true &&
    freshTimestamp(fill.completed_at, now, EVIDENCE_MAX_AGE_MS);
  const attemptWorkOrders = noFillAttempts.map((attempt) => attempt.gateway_ack?.work_order_commitment);
  const attemptPlanDigests = noFillAttempts.map((attempt) => attempt.plan_digest);
  return ackValid && fillValid && verifyClaim(claim, workOrder, now) &&
    claim.receipt_commitment === ack.receipt_commitment &&
    !attemptWorkOrders.includes(workOrder) && !attemptPlanDigests.includes(plan.plan_digest) &&
    new Set(attemptWorkOrders).size === attemptWorkOrders.length &&
    new Set(attemptPlanDigests).size === attemptPlanDigests.length;
}

function verifyTerminalNoFillAttempt(value, finalSubmitAt, now) {
  if (!isRecord(value) || !digest(value.plan_digest) ||
      !digest(value.preview_commitment) || !digest(value.idempotency_commitment) ||
      !timestamp(value.submitted_at) || value.retry_authorized_after_terminal_no_fill !== true) {
    return false;
  }
  const ack = isRecord(value.gateway_ack) ? value.gateway_ack : {};
  const receipt = isRecord(value.terminal_receipt) ? value.terminal_receipt : {};
  const workOrder = ack.work_order_commitment;
  const completedAt = time(receipt.completed_at);
  return ack.sanitized === true && ack.outcome === "acknowledged" &&
    ["submitted", "reconciled"].includes(ack.status) && ack.dispatch === "dispatched" &&
    ack.fill_proof === false && ack.plan_digest === value.plan_digest &&
    ack.response_plan_digest === value.plan_digest && TERMINAL_WORK_ORDER.test(workOrder || "") &&
    digest(ack.receipt_commitment) && digest(ack.result_commitment) &&
    verifyClaim(value.claim, workOrder, now) &&
    value.claim.receipt_commitment === ack.receipt_commitment &&
    receipt.sanitized === true &&
    receipt.proof_kind === "hyperliquid_execution_proof_v1" &&
    receipt.network === "mainnet" && receipt.market === "HYPE" &&
    receipt.work_order_commitment === workOrder &&
    ["canceled", "cancelled", "expired", "rejected"].includes(receipt.terminal_status) &&
    receipt.broadcast_performed === true && receipt.final_venue_execution_proven === true &&
    receipt.final_fill_proven === false && receipt.final_no_fill_proven === true &&
    receipt.venue_order_readback_proven === true && receipt.ioc_remainder_terminal === true &&
    digest(receipt.raw_worker_receipt_commitment) && digest(receipt.order_commitment) &&
    time(value.submitted_at) <= completedAt && completedAt < finalSubmitAt &&
    freshTimestamp(receipt.completed_at, now, EVIDENCE_MAX_AGE_MS);
}

function verifyClaim(value, workOrder, now, close = false) {
  const workOrderValid = close
    ? CLOSE_WORK_ORDER.test(workOrder || "")
    : TERMINAL_WORK_ORDER.test(workOrder || "");
  return isRecord(value) && workOrderValid &&
    value.work_order_commitment === workOrder &&
    value.store === "postgres" &&
    value.namespace === CURRENT_TERMINAL_CLAIM_NAMESPACE &&
    value.attempt_store === "worker_execution_attempts" &&
    value.receipt_store === "worker_idempotency" &&
    value.status === "completed" && value.exact_request_binding === true &&
    value.replay_protected === true && value.unresolved === false &&
    digest(value.request_digest_commitment) && digest(value.claim_commitment) &&
    digest(value.receipt_commitment) &&
    freshTimestamp(value.checked_at, now, EVIDENCE_MAX_AGE_MS);
}

function verifyTerminalClose(value, now) {
  if (!isRecord(value) ||
      value.route !== "/v1/private-account/hyperliquid/positions/close" ||
      !digest(value.idempotency_commitment) ||
      !digest(value.wallet_step_up_proof_commitment) ||
      !timestamp(value.submitted_at)) return false;
  const report = value.report;
  if (!isRecord(report) || report.sanitized !== true || report.version !== 1 ||
      report.proof_kind !== "hyperliquid_position_close_v1" ||
      report.status !== "reconciled" || report.network !== "mainnet" ||
      !sameStringSet(report.markets, ["HYPE"]) ||
      !Number.isInteger(report.initial_position_count) || report.initial_position_count < 1 ||
      !Number.isInteger(report.initial_open_order_count) || report.initial_open_order_count < 0 ||
      report.reduce_only_exit_proven !== true || report.cancellations_terminal !== true ||
      report.market_flat !== true || report.account_flat !== true ||
      report.open_order_count !== 0 || report.final_flat_proven !== true ||
      !safeId(report.root_work_order_commitment) ||
      !digest(report.worker_evidence_commitment) || !digest(report.report_commitment) ||
      !freshTimestamp(report.reconciled_at, now, EVIDENCE_MAX_AGE_MS) ||
      !freshTimestamp(report.completed_at, now, EVIDENCE_MAX_AGE_MS)) return false;
  const closes = Array.isArray(report.closes) ? report.closes : [];
  const cancellations = Array.isArray(report.cancellations) ? report.cancellations : [];
  if (closes.length < 1 || closes.some((item) =>
    !isRecord(item) || item.market !== "HYPE" ||
    !CLOSE_WORK_ORDER.test(item.work_order_commitment || "") ||
    !digest(item.order_commitment) || item.terminal_status !== "filled" ||
    item.reduce_only !== true || !["1", "2-4", "5+"].includes(item.fill_count_bucket) ||
    !digest(item.fill_evidence_commitment) || item.venue_readback_proven !== true ||
    item.replay_protected !== true)) return false;
  if (cancellations.some((item) =>
    !isRecord(item) || !digest(item.order_commitment) ||
    item.terminal_status !== "canceled" || item.venue_readback_proven !== true ||
    item.replay_protected !== true)) return false;
  const claims = Array.isArray(value.claims) ? value.claims : [];
  return claims.length === closes.length && closes.every((item) =>
    claims.some((claim) => verifyClaim(claim, item.work_order_commitment, now, true)));
}

function verifyProofHumanControl(value) {
  return isRecord(value) && value.automation_used === false &&
    value.wallet_unlocked_by_human === true &&
    value.phantom_account_selected_by_human === true &&
    value.eligibility_attested_by_human === true &&
    value.trade_confirmed_by_human === true &&
    value.vault_message_approvals_by_human === 2 &&
    value.proof_message_approvals_by_human === 2;
}

function verifyTerminalHumanControl(value) {
  return isRecord(value) && value.automation_used === false &&
    value.normal_terminal_controls_used === true &&
    value.exact_order_reviewed_by_human === true &&
    value.entry_confirmed_by_human === true &&
    value.close_ro_selected_by_human === true &&
    value.close_confirmed_by_human === true &&
    value.phantom_step_up_signed_by_human === true &&
    value.extension_operated_by_human === true;
}

function verifyProofReceipt(value, now) {
  if (!isRecord(value) || Object.keys(value).some((key) => !PROOF_RECEIPT_KEYS.has(key))) return false;
  const commitments = [
    value.receipt_commitment,
    value.result_commitment,
    value.venue_evidence_commitment,
    value.entry_order_commitment,
    value.exit_order_commitment,
    value.entry_transaction_commitment,
    value.exit_transaction_commitment,
  ];
  return value.sanitized === true && value.ok === true && value.status === "filled" &&
    value.network === "mainnet" && value.market === "HYPE" &&
    value.notional_usd === REQUIRED_TERMINAL_NOTIONAL_USD &&
    value.max_slippage_bps === 100 && value.claim_store === "postgres" &&
    value.claim_namespace === CURRENT_PROOF_NAMESPACE &&
    PROOF_WORK_ORDER.test(value.proof_work_order_commitment || "") &&
    value.entry_work_order_commitment === value.proof_work_order_commitment + "_entry" &&
    value.exit_work_order_commitment === value.proof_work_order_commitment + "_exit" &&
    commitments.every(digest) && new Set(commitments).size === commitments.length &&
    value.preflight_verified === true && value.preflight_transaction_broadcast === false &&
    value.exit_preflight_verified === true && value.exit_preflight_transaction_broadcast === false &&
    value.api_wallet_authorization_verified === true &&
    value.duplicate_entry_prevented === true && value.duplicate_exit_prevented === true &&
    value.stored_receipt_replayed === true && value.isolated_margin === true &&
    value.leverage === 1 && value.entry_fill_proven === true &&
    value.exit_fill_proven === true && value.reduce_only_exit_proven === true &&
    value.position_protection_proven === true &&
    value.protection_cleanup_confirmed === true &&
    value.protection_children_terminal === true &&
    value.independent_venue_evidence_proven === true &&
    value.transaction_hashes_distinct === true && value.fees_paid === true &&
    value.flat_after_exit === true && value.open_orders_after_exit === 0 &&
    value.account_graduated === true &&
    freshTimestamp(value.completed_at, now, EVIDENCE_MAX_AGE_MS);
}

function verifyFlatVenueState(value, accountCommitment, now) {
  return isRecord(value) && value.source === "hyperliquid_public_info" &&
    value.account_address_commitment === accountCommitment &&
    value.position_count === 0 && value.open_order_count === 0 &&
    value.hype_position_size === "0" && value.hype_open_order_count === 0 &&
    digest(value.snapshot_commitment) &&
    freshTimestamp(value.checked_at, now, EVIDENCE_MAX_AGE_MS);
}

function verifyOpenVenueState(value, accountCommitment, now) {
  return isRecord(value) && value.source === "hyperliquid_public_info" &&
    value.account_address_commitment === accountCommitment &&
    Number.isInteger(value.position_count) && value.position_count === 1 &&
    value.hype_position_nonzero === true &&
    Number.isInteger(value.open_order_count) && value.open_order_count >= 2 &&
    Number.isInteger(value.hype_open_order_count) && value.hype_open_order_count >= 2 &&
    Number.isInteger(value.protection_order_count) && value.protection_order_count >= 2 &&
    digest(value.snapshot_commitment) &&
    freshTimestamp(value.checked_at, now, EVIDENCE_MAX_AGE_MS);
}

function verifyGlobalRedStatus(value, expectedRelease, now) {
  return isRecord(value) &&
    value.source_path === "/v1/private-account/live-trading/status" &&
    value.contract_version === LIVE_TRADING_CONTRACT_VERSION &&
    value.status === "red" && value.launch_state === "canary" &&
    value.live_trading_enabled === false &&
    value.byo_live_trading_enabled === false &&
    value.pooled_live_trading_enabled === false &&
    value.public_live_copy_allowed === false &&
    sameReleaseFromValue(value.release_identity, expectedRelease) &&
    safeId(value.gate_commitment) &&
    Array.isArray(value.reason_codes) &&
    value.reason_codes.includes("live_trading_launch_state_invalid") &&
    freshTimestamp(value.checked_at, now, EVIDENCE_MAX_AGE_MS);
}

function verifyRollback(value, expectedRelease, now) {
  if (!isRecord(value) || value.kill_control_ready !== true ||
      value.reduce_only_close_ready !== true ||
      value.rollback_artifact_pinned !== true ||
      value.incident_owner_present !== true ||
      value.unresolved_claim_count !== 0 || value.open_exposure_count !== 0 ||
      value.open_order_count !== 0 || value.launch_state_after_run !== "canary" ||
      !digest(value.rollback_artifact_commitment) ||
      !freshTimestamp(value.checked_at, now, EVIDENCE_MAX_AGE_MS)) return false;
  const recovery = isRecord(value.worker_restart_recovery) ? value.worker_restart_recovery : {};
  return recovery.proven === true &&
    sameReleaseFromValue(recovery.release_identity, expectedRelease) &&
    recovery.claim_store === "postgres" &&
    recovery.claim_namespace === CURRENT_TERMINAL_CLAIM_NAMESPACE &&
    TERMINAL_WORK_ORDER.test(recovery.work_order_commitment || "") &&
    recovery.process_restart_observed === true &&
    recovery.receipt_replayed === true &&
    recovery.rebroadcast_performed === false &&
    recovery.broadcast_count_before === 1 &&
    recovery.broadcast_count_after === 1 &&
    digest(recovery.original_receipt_commitment) &&
    recovery.original_receipt_commitment === recovery.replayed_receipt_commitment &&
    freshTimestamp(recovery.checked_at, now, EVIDENCE_MAX_AGE_MS);
}

function workerMatchesRelease(value, expected, now) {
  if (!isRecord(value) || !expected ||
      value.ready !== true || value.attested_ready !== true ||
      value.report_data_bound !== true || value.state_store !== "postgres" ||
      value.mainnet !== true || value.dry_run !== false || value.full_ticket !== true ||
      !sameReleaseFromValue(value.release_identity, expected) ||
      !capabilitiesContain(value.capabilities, REQUIRED_CONFIGURED_CAPABILITIES) ||
      !freshTimestamp(value.checked_at, now, EVIDENCE_MAX_AGE_MS)) return false;
  return value.execution_claim_store === CURRENT_TERMINAL_CLAIM_NAMESPACE &&
    value.execution_attempt_store === "worker_execution_attempts" &&
    value.idempotency_store === "worker_idempotency";
}

function workerAccessMatchesRelease(value, expected, actionAt) {
  return isRecord(value) && value.ready === true &&
    value.endpoint_configured === true &&
    value.contract_version === LIVE_TRADING_CONTRACT_VERSION &&
    value.worker_git_sha === expected?.worker_git_sha &&
    value.worker_image_digest === expected?.worker_image_digest &&
    value.config_fingerprint === expected?.config_fingerprint &&
    capabilitiesContain(value.capabilities, REQUIRED_OPENING_CAPABILITIES) &&
    Array.isArray(value.reason_codes) && value.reason_codes.length === 0 &&
    time(value.checked_at) <= actionAt + 1_000 &&
    actionAt - time(value.checked_at) <= 30_000;
}

function releaseIdentity(value) {
  if (!isRecord(value)) return invalid("release_identity_not_object");
  const valid = value.contract_version === LIVE_TRADING_CONTRACT_VERSION &&
    GIT_SHA.test(value.web_git_sha || "") &&
    value.web_git_sha === value.worker_git_sha &&
    IMAGE_DIGEST.test(value.worker_image_digest || "") &&
    safeId(value.config_fingerprint) &&
    value.valid === true && Array.isArray(value.reason_codes) &&
    value.reason_codes.length === 0;
  return valid ? {
    ok: true,
    value: {
      contract_version: value.contract_version,
      web_git_sha: value.web_git_sha,
      worker_git_sha: value.worker_git_sha,
      worker_image_digest: value.worker_image_digest,
      config_fingerprint: value.config_fingerprint,
      valid: true,
      reason_codes: [],
    },
  } : invalid("release_identity_invalid");
}

function sameReleaseFromValue(value, expected) {
  const identity = releaseIdentity(value);
  return identity.ok && sameRelease(identity.value, expected);
}

function sameReleaseFields(value, expected) {
  return isRecord(value) && Boolean(expected) &&
    value.contract_version === expected.contract_version &&
    value.web_git_sha === expected.web_git_sha &&
    value.worker_git_sha === expected.worker_git_sha &&
    value.worker_image_digest === expected.worker_image_digest &&
    value.config_fingerprint === expected.config_fingerprint;
}

function sameCanonicalCaps(value) {
  return isRecord(value) &&
    value.first_proof_notional_usd === 11 &&
    value.max_order_notional_usd === 100 &&
    value.rolling_24h_notional_usd === 500 &&
    value.default_slippage_bps === 50 &&
    value.max_slippage_bps === 100 &&
    Object.keys(value).length === 5;
}

function uniqueInvestorCommitments(runs) {
  if (runs.length !== REQUIRED_INVESTOR_RUNS || runs.some((run) => !isRecord(run))) return false;
  const fields = [
    "owner_commitment",
    "venue_account_commitment",
    "phantom_wallet_commitment",
    "vault_commitment",
  ];
  if (fields.some((field) => new Set(runs.map((run) => run[field])).size !== runs.length)) return false;
  return new Set(runs.map((run) => run.invite?.pass_commitment)).size === runs.length &&
    new Set(runs.map((run) => run.invite?.email_commitment)).size === runs.length;
}

function terminalEvidenceDistinct(runs) {
  const trades = runs.flatMap((run) => Array.isArray(run?.terminal_round_trips)
    ? run.terminal_round_trips
    : []);
  if (trades.length !== REQUIRED_INVESTOR_RUNS * REQUIRED_TERMINAL_ROUND_TRIPS) return false;
  const entries = trades.flatMap((trade) => [
    {
      plan_digest: trade.order_plan?.plan_digest,
      preview_commitment: trade.order_plan?.preview_commitment,
      idempotency_commitment: trade.order_plan?.idempotency_commitment,
      work_order_commitment: trade.entry?.gateway_ack?.work_order_commitment,
      receipt_commitment: trade.entry?.gateway_ack?.receipt_commitment,
      order_commitment: trade.entry?.venue_fill?.order_commitment,
    },
    ...(trade.entry?.prior_terminal_no_fills || []).map((attempt) => ({
      plan_digest: attempt.plan_digest,
      preview_commitment: attempt.preview_commitment,
      idempotency_commitment: attempt.idempotency_commitment,
      work_order_commitment: attempt.gateway_ack?.work_order_commitment,
      receipt_commitment: attempt.gateway_ack?.receipt_commitment,
      order_commitment: attempt.terminal_receipt?.order_commitment,
    })),
  ]);
  const values = [
    [trades.map((trade) => trade.trade_id), trades.length],
    [entries.map((entry) => entry.plan_digest), entries.length],
    [entries.map((entry) => entry.preview_commitment), entries.length],
    [entries.map((entry) => entry.idempotency_commitment), entries.length],
    [entries.map((entry) => entry.work_order_commitment), entries.length],
    [entries.map((entry) => entry.receipt_commitment), entries.length],
    [entries.map((entry) => entry.order_commitment), entries.length],
    [trades.map((trade) => trade.entry?.venue_fill?.transaction_commitment), trades.length],
    [trades.map((trade) => trade.close?.report?.root_work_order_commitment), trades.length],
  ];
  return values.every(([items, expectedLength]) =>
    items.length === expectedLength && items.every(Boolean) &&
    new Set(items).size === items.length);
}

function allClaimsCurrent(runs) {
  const claims = runs.flatMap((run) => (run?.terminal_round_trips || []).flatMap((trade) => [
    trade?.entry?.claim,
    ...(trade?.entry?.prior_terminal_no_fills || []).map((attempt) => attempt.claim),
    ...(trade?.close?.claims || []),
  ]));
  return claims.length >= REQUIRED_INVESTOR_RUNS * REQUIRED_TERMINAL_ROUND_TRIPS * 2 &&
    claims.every((claim) => isRecord(claim) &&
      claim.store === "postgres" &&
      claim.namespace === CURRENT_TERMINAL_CLAIM_NAMESPACE &&
      claim.status === "completed" && claim.unresolved === false) &&
    new Set(claims.map((claim) => claim.work_order_commitment)).size === claims.length;
}

function rollbackRecoveryLinked(rollback, runs) {
  const workOrder = rollback?.worker_restart_recovery?.work_order_commitment;
  return runs.some((run) => (run?.terminal_round_trips || []).some((trade) =>
    trade?.entry?.gateway_ack?.work_order_commitment === workOrder ||
    (trade?.entry?.prior_terminal_no_fills || []).some((attempt) =>
      attempt?.gateway_ack?.work_order_commitment === workOrder)));
}

function proofsExactlyLinked(proofs, runs) {
  const ids = runs.map((run) => run?.graduation_proof_id);
  return ids.length === proofs.length && new Set(ids).size === ids.length &&
    proofs.every((proof) => ids.includes(proof.proof_id));
}

function sameRelease(left, right) {
  return Boolean(left && right) && canonicalJson(left) === canonicalJson(right);
}

function capabilitiesContain(value, required) {
  return Array.isArray(value) && new Set(value).size === value.length &&
    required.every((capability) => value.includes(capability));
}

function sameStringSet(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    canonicalJson([...value].sort()) === canonicalJson([...expected].sort());
}

function firstFailure(results) {
  for (const item of results.values()) if (!item.ok) return item.failure;
  return null;
}

function result(checks, dossier, identity = null) {
  const failures = checks.filter((item) => !item.ok).map((item) => item.failure);
  return {
    ok: failures.length === 0,
    version: INVESTOR_CANARY_CONTRACT_VERSION,
    mode: "invite_only_account_canary",
    release_commitment: identity ? acceptanceCommitment(identity) : null,
    dossier_commitment: isRecord(dossier) ? acceptanceCommitment(dossier) : null,
    checks,
    failures,
  };
}

function findCredentialFields(value, path = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findCredentialFields(item, path + "[" + index + "]", found));
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, item] of Object.entries(value)) {
    const next = path + "." + key;
    if (CREDENTIAL_KEY.test(key)) found.push(next);
    findCredentialFields(item, next, found);
  }
  return found;
}

function findForbiddenFields(value, path = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenFields(item, path + "[" + index + "]", found));
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, item] of Object.entries(value)) {
    const next = path + "." + key;
    if (CREDENTIAL_KEY.test(key) || RAW_ID_KEY.test(key)) found.push(next);
    findForbiddenFields(item, next, found);
  }
  return found;
}

function findForbiddenValues(value, path = "$", found = []) {
  if (typeof value === "string") {
    if (RAW_EMAIL.test(value) || RAW_HEX_IDENTIFIER.test(value) || RAW_INVITE_URL.test(value)) {
      found.push(path);
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenValues(item, path + "[" + index + "]", found));
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, item] of Object.entries(value)) {
    findForbiddenValues(item, path + "." + key, found);
  }
  return found;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function digest(value) {
  return typeof value === "string" && DIGEST.test(value);
}

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function time(value) {
  return timestamp(value) ? Date.parse(value) : Number.NaN;
}

function freshTimestamp(value, now, maxAgeMs) {
  const valueMs = time(value);
  const nowMs = now.getTime();
  return Number.isFinite(valueMs) && valueMs <= nowMs + 60_000 &&
    nowMs - valueMs <= maxAgeMs;
}

function futureTimestamp(value, now) {
  return timestamp(value) && Date.parse(value) > now.getTime();
}

function invalid(failure) {
  return { ok: false, failure };
}
