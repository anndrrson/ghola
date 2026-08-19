import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceCommitment,
  gholaCommitment,
  verifyLiveInvestorCanary,
} from "./investor-canary-live-verifier-lib.mjs";
import {
  main as liveVerifierMain,
  sanitizedReport,
} from "./investor-canary-live-verifier.mjs";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const START = "2026-08-19T10:00:00.000Z";
const RELEASE = {
  contract_version: 2,
  web_git_sha: "a".repeat(40),
  worker_git_sha: "a".repeat(40),
  worker_image_digest: `sha256:${"b".repeat(64)}`,
  config_fingerprint: `live_trading_config_${"c".repeat(48)}`,
  valid: true,
  reason_codes: [],
};
const PROFILES = [
  { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test", email_verified: true },
  { id: "22222222-2222-4222-8222-222222222222", email: "b@example.test", email_verified: true },
];
const ADDRESSES = [
  `0x${"1".repeat(40)}`,
  `0x${"2".repeat(40)}`,
];
const OPERATOR_EMAIL = "operator@example.test";

test("derives GO from two authoritative complete round-trip histories and emits no raw identifiers", async () => {
  const fixture = buildFixture();
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "GO", JSON.stringify(report, null, 2));
  assert.equal(report.machine_evidence.investors.length, 2);
  assert.equal(report.machine_evidence.investors[0].terminal_filled_entries, 2);
  assert.equal(report.machine_evidence.investors[0].reduce_only_filled_closes, 2);
  assert.equal(report.machine_evidence.investors[0].protection_orders_canceled, 4);
  assert.equal(report.human_attestation.scope, "human_observations_only");
  assert.equal(report.operational_attestation.scope, "release_operations_attestation");
  const output = JSON.stringify(report);
  assert.equal(sanitizedReport(report), true);
  for (const forbidden of [
    ...PROFILES.flatMap((profile) => [profile.id, profile.email]),
    ...ADDRESSES,
    `0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`,
    "101", "201", `0x${"f".repeat(64)}`,
    fixture.config.investors[0].token,
  ]) assert.equal(output.includes(forbidden), false);
});

test("output guard rejects raw emails, addresses, tokens, and order identifiers", () => {
  assert.equal(sanitizedReport({ machine_evidence: { email: "a@example.test" } }), false);
  assert.equal(sanitizedReport({ machine_evidence: { account_address: ADDRESSES[0] } }), false);
  assert.equal(sanitizedReport({ machine_evidence: { order_id: "123" } }), false);
  assert.equal(sanitizedReport({ machine_evidence: { release_commitment: acceptanceCommitment("safe") } }), true);
});

test("ignores caller-asserted machine booleans and fails on missing database facts", async () => {
  const fixture = buildFixture();
  const original = fixture.source.getMainInvestorEvidence;
  fixture.source.getMainInvestorEvidence = async (input) => ({
    ...(await original(input)),
    vaults: [],
    machine_ready: true,
    accepted: true,
  });
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "automatic_worker_verified_vault_invalid");
});

test("fails closed on unresolved worker claims even when four fills exist", async () => {
  const fixture = buildFixture();
  fixture.data[0].worker.claims.push({
    ...structuredClone(fixture.data[0].worker.claims[0]),
    work_order_commitment: `live_trade_work_order_${"9".repeat(48)}`,
    status: "reconcile_required",
  });
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "worker_claims_unresolved");
});

test("requires exact distinct entry and reduce-only close identities", async () => {
  const fixture = buildFixture();
  fixture.data[0].main.reconciliations[1].plan_digest = fixture.data[0].main.reconciliations[0].plan_digest;
  fixture.data[0].main.reconciliations[1].worker_request.plan_digest =
    fixture.data[0].main.reconciliations[0].plan_digest;
  fixture.data[0].main.reconciliations[1].worker_request_digest = acceptanceCommitment(
    fixture.data[0].main.reconciliations[1].worker_request,
  );
  fixture.data[0].main.reservations[1].request_commitment =
    fixture.data[0].main.reconciliations[0].plan_digest;
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "terminal_entry_identity_reused");
});

test("rejects a venue close that is not reduce-only", async () => {
  const fixture = buildFixture();
  fixture.data[1].venue.orderStatuses[2].order.order.reduceOnly = false;
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "exact_venue_order_readback_invalid");
});

test("requires every entry protection child to have canceled venue readback and no fill", async () => {
  const fixture = buildFixture();
  fixture.data[0].venue.orderStatuses[4].order.status = "filled";
  fixture.data[0].venue.historicalOrders[4].status = "filled";
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "exact_venue_order_readback_invalid");
});

test("requires venue-wide flat state including frontend trigger orders", async () => {
  const fixture = buildFixture();
  fixture.data[0].venue.frontendOpenOrders.push({ oid: 999, orderType: "Stop Market" });
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "venue_wide_final_flat_required");
});

test("requires the exact current trade-only agent authorization at Hyperliquid", async () => {
  const fixture = buildFixture();
  fixture.data[0].venue.extraAgents = [];
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "current_trade_only_agent_authorization_required");
});

test("detects immutable release drift between the opening and closing reads", async () => {
  const fixture = buildFixture();
  let calls = 0;
  fixture.source.getPublicStatus = async () => {
    calls += 1;
    const status = publicStatus();
    if (calls > 1) status.release_identity.worker_image_digest = `sha256:${"d".repeat(64)}`;
    return status;
  };
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "release_drift_or_final_status_unavailable");
});

test("requires signed registry provenance that binds the deployed digest", async () => {
  const fixture = buildFixture();
  fixture.source.getWorkerBuildProvenance = async () => {
    const provenance = workerBuildProvenance();
    provenance[0].verificationResult.statement.subject[0].digest.sha256 = "d".repeat(64);
    return provenance;
  };
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "signed_registry_build_provenance_invalid");
});

test("requires the baked worker SHA and readiness identity to match the release", async () => {
  const fixture = buildFixture();
  fixture.source.getPublicStatus = async () => {
    const status = publicStatus();
    status.live_worker_readiness.worker_git_sha = "d".repeat(40);
    delete status.gate_commitment;
    status.gate_commitment = gholaCommitment("live_trading_launch_gate", status);
    return status;
  };
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "baked_worker_release_identity_invalid");
});

test("keeps human observations separate and requires both reload attestations", async () => {
  const fixture = buildFixture();
  fixture.human.investors[1].full_reload_between_round_trips = false;
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assert.equal(report.human_attestation, null);
  assertFailure(report, "protected_human_attestation_invalid");
  assert.equal(report.machine_evidence.investors.length, 2);
});

test("requires the complete non-operator email, wallet, and UI observation schema", async () => {
  const fixture = buildFixture();
  fixture.human.investors[0].graduation_exact_request_signature_confirmed = false;
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "protected_human_attestation_invalid");
});

test("requires configured production observability and reconciliation readiness", async () => {
  const fixture = buildFixture();
  fixture.source.getOperationalReadiness = async () => ({
    ...operationalReadiness(),
    checks: { ...operationalReadiness().checks, observability: "blocked" },
  });
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "production_observability_or_readiness_invalid");
});

test("requires rollback, kill, recovery, and prior-release commitments prepared before the run", async () => {
  const fixture = buildFixture();
  fixture.operations.rollback.prepared_at = "2026-08-19T10:01:00.000Z";
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "release_operations_attestation_invalid");
});

test("binds the restart replay attestation to an actual worker receipt without rebroadcast", async () => {
  const fixture = buildFixture();
  fixture.operations.restart_replay.receipt_commitment = acceptanceCommitment("wrong-receipt");
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "restart_replay_evidence_invalid");
});

test("rejects an investor listed in the complete operator-email commitment set", async () => {
  const fixture = buildFixture();
  fixture.operations.rollback.operator_email_commitments = [acceptanceCommitment({
    kind: "operator_email_v1",
    email: PROFILES[0].email,
  })];
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "investor_operator_identity_forbidden");
});

test("requires two distinct authenticated profiles and accounts", async () => {
  const fixture = buildFixture();
  fixture.data[1].profile = structuredClone(fixture.data[0].profile);
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "two_distinct_investors_required");
});

test("requires a distinct current complimentary grant for each investor", async () => {
  const fixture = buildFixture();
  fixture.data[1].billing.active_pass_id = fixture.data[0].billing.active_pass_id;
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "two_distinct_investors_required");
});

test("requires work orders and plans to be distinct across the investor cohort", async () => {
  const fixture = buildFixture();
  const firstCloses = fixture.data[0].worker.claims.filter((item) => item.work_order_commitment.startsWith("hl_close_"));
  const secondCloses = fixture.data[1].worker.claims.filter((item) => item.work_order_commitment.startsWith("hl_close_"));
  for (let index = 0; index < secondCloses.length; index += 1) {
    const previous = secondCloses[index].work_order_commitment;
    const replacement = firstCloses[index].work_order_commitment;
    secondCloses[index].work_order_commitment = replacement;
    secondCloses[index].receipt_json.work_order_commitment = replacement;
    const attempt = fixture.data[1].worker.attempts.find((item) => item.work_order_commitment === previous);
    const cached = fixture.data[1].worker.idempotency.find((item) => item.work_order_commitment === previous);
    attempt.work_order_commitment = replacement;
    cached.work_order_commitment = replacement;
    cached.receipt_json.work_order_commitment = replacement;
  }
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "two_distinct_investors_required");
});

test("cryptographically binds the sealed vault payload before accepting it", async () => {
  const fixture = buildFixture();
  fixture.data[0].main.vaults[0].vault.encrypted_execution_vault.ciphertext += "tampered";
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "automatic_worker_verified_vault_invalid");
});

test("requires human observations to follow the completed machine round trips", async () => {
  const fixture = buildFixture();
  fixture.human.investors[0].observed_at = "2026-08-19T10:35:00.000Z";
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "protected_human_attestation_invalid");
});

test("runtime CLI rejects every dossier or caller-supplied evidence argument", async () => {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const written = [];
  process.stdout.write = (value) => { written.push(String(value)); return true; };
  process.stderr.write = (value) => { written.push(String(value)); return true; };
  try {
    assert.equal(await liveVerifierMain(["operator-dossier.json"], {}), 2);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.match(written.join(""), /arguments_not_allowed/u);
});

test("reports the unavailable authoritative stage without leaking its error", async () => {
  const fixture = buildFixture();
  fixture.source.getBilling = async () => { throw new Error(`secret ${fixture.config.investors[0].token}`); };
  const report = await verifyLiveInvestorCanary(fixture);
  assert.equal(report.status, "NO-GO");
  assertFailure(report, "authenticated_api_source_unavailable");
  assert.equal(JSON.stringify(report).includes(fixture.config.investors[0].token), false);
});

function buildFixture() {
  const data = [0, 1].map(investorFixture);
  const human = {
    version: 1,
    scope: "human_observations_only",
    investors: [
      humanObservation("A", "2026-08-19T11:20:00.000Z"),
      humanObservation("B", "2026-08-19T11:25:00.000Z"),
    ],
  };
  const replayClaim = data[0].worker.claims.find((item) => item.work_order_commitment.startsWith("live_trade_work_order_"));
  const operations = {
    version: 1,
    scope: "release_operations_attestation",
    release_identity: {
      contract_version: RELEASE.contract_version,
      ...releaseFields(),
    },
    rollback: {
      rollback_artifact_commitment: acceptanceCommitment("rollback-artifact"),
      prior_release_artifact_commitment: acceptanceCommitment("prior-release-artifact"),
      incident_owner_commitment: acceptanceCommitment("incident-owner"),
      kill_control_commitment: acceptanceCommitment("kill-control-proof"),
      reduce_only_recovery_commitment: acceptanceCommitment("reduce-only-recovery-proof"),
      operator_email_commitments: [acceptanceCommitment({ kind: "operator_email_v1", email: OPERATOR_EMAIL })],
      operator_email_set_complete: true,
      prepared_at: "2026-08-19T09:55:00.000Z",
    },
    restart_replay: {
      work_order_commitment: replayClaim.work_order_commitment,
      receipt_commitment: acceptanceCommitment(replayClaim.receipt_json),
      process_restart_observed: true,
      receipt_replayed: true,
      rebroadcast_performed: false,
      broadcast_count_before: 1,
      broadcast_count_after: 1,
      observed_at: "2026-08-19T11:00:00.000Z",
    },
  };
  const config = {
    startedAt: START,
    investors: [0, 1].map((index) => ({
      token: `${index + 1}`.repeat(64),
      accountAddress: ADDRESSES[index],
    })),
  };
  const source = {
    getPublicStatus: async () => publicStatus(),
    getOperationalReadiness: async () => operationalReadiness(),
    getOperationsEvidence: async () => operations,
    getWorkerBuildProvenance: async () => workerBuildProvenance(),
    getMainReleaseEvidence: async () => ({ control: {
      version: 2,
      state: "canary",
      contract_version: 2,
      ...releaseFields(),
    }, database_clock: NOW.toISOString() }),
    getProfile: async (token) => data[token === config.investors[0].token ? 0 : 1].profile,
    getBilling: async (token) => data[token === config.investors[0].token ? 0 : 1].billing,
    getTerminalAccess: async (token) => data[token === config.investors[0].token ? 0 : 1].terminal,
    getMainInvestorEvidence: async ({ ownerCommitment }) => data.find((item) => item.owner === ownerCommitment).main,
    getWorkerInvestorEvidence: async ({ ownerCommitment }) => data.find((item) => item.owner === ownerCommitment).worker,
    getVenueEvidence: async ({ accountAddress }) => data.find((item) => item.address === accountAddress).venue,
    getHumanAttestation: async () => human,
  };
  return { source, config, now: NOW, data, human, operations };
}

function humanObservation(label, observedAt) {
  return {
    label,
    participant_is_non_operator: true,
    invitation_email_opened: true,
    verified_email_signup_or_signin_completed: true,
    invite_fragment_scrubbed_before_redeem: true,
    clean_chrome_profile_used: true,
    worker_started_from_product: true,
    phantom_evm_account_connected: true,
    phantom_approve_agent_confirmed: true,
    phantom_solana_account_connected: true,
    phantom_siws_completed_if_requested: true,
    graduation_wallet_binding_signature_confirmed: true,
    graduation_exact_request_signature_confirmed: true,
    first_terminal_entry_review_confirmed: true,
    first_close_wallet_binding_signature_confirmed: true,
    first_close_exact_request_signature_confirmed: true,
    full_reload_between_round_trips: true,
    second_terminal_entry_review_confirmed: true,
    second_close_wallet_binding_signature_confirmed: true,
    second_close_exact_request_signature_confirmed: true,
    normal_terminal_entries_required_no_phantom_signature: true,
    no_unexplained_repeated_prompt_or_stage_stall: true,
    no_cli_dashboard_devtools_or_secret_setup: true,
    confirmations_personally_completed: true,
    observed_at: observedAt,
  };
}

function investorFixture(index) {
  const profile = structuredClone(PROFILES[index]);
  const address = ADDRESSES[index];
  const owner = gholaCommitment("owner", profile.id);
  const account = `private_account_${index}_${"a".repeat(40)}`;
  const vaultPolicy = `hyperliquid_execution_policy_${String(index + 7).repeat(48)}`;
  const agentAddress = `0x${String(index + 3).repeat(40)}`;
  const agent = gholaCommitment("hyperliquid_agent_wallet", agentAddress);
  const venueAccount = gholaCommitment("hyperliquid_venue_account", address);
  const recipient = `phala:cvm:${index}`;
  const aad = [
    "ghola/hyperliquid-execution-vault-v2",
    `account:${account}`,
    `recipient:${recipient}`,
    "network:mainnet",
    `venue-account:${venueAccount}`,
    `agent-wallet:${agent}`,
  ].join("|");
  const ciphertext = `sealed-provider-ciphertext-${index}-${"x".repeat(32)}`;
  const encrypted = {
    version: 1,
    alg: "sealed-provider-v1",
    ciphertext,
    ciphertext_commitment: gholaCommitment("encrypted_bundle_ciphertext", ciphertext),
    recipient,
    recipient_commitment: gholaCommitment("sealed_recipient", recipient),
    aad,
    aad_commitment: gholaCommitment("encrypted_bundle_aad", aad),
    encapsulated_key_commitment: null,
  };
  const vaultSeed = {
    account_commitment: account,
    encrypted_vault_commitment: encrypted.ciphertext_commitment,
    recipient_commitment: encrypted.recipient_commitment,
    policy_commitment: vaultPolicy,
  };
  const vault = gholaCommitment("hyperliquid_execution_vault", vaultSeed);
  const encryptedVault = gholaCommitment("hyperliquid_encrypted_vault", vaultSeed);
  const times = ["10:10:00", "10:30:00"];
  const entries = times.map((time, entryIndex) => entryRecord({
    index, entryIndex, time, owner, account, vault, vaultPolicy, encrypted,
  }));
  const main = {
    accounts: [{
      owner_commitment: owner,
      account_commitment: account,
      vault_ready: true,
      account: {
        version: 1,
        account_commitment: account,
        vault_ready: true,
        privacy_mode: "private_mode",
        claim_boundary: "engine_gated_full_anonymity",
      },
    }],
    vaults: [{
      owner_commitment: owner,
      account_commitment: account,
      vault_commitment: vault,
      encrypted_vault_commitment: encryptedVault,
      recipient_commitment: encrypted.recipient_commitment,
      policy_commitment: vaultPolicy,
      status: "sealed",
      vault: {
        version: 1,
        platform_class: "hyperliquid_style_market",
        status: "sealed",
        account_commitment: account,
        vault_commitment: vault,
        encrypted_vault_commitment: encryptedVault,
        recipient_commitment: encrypted.recipient_commitment,
        policy_commitment: vaultPolicy,
        supported_operations: ["read", "limit_order", "cancel", "reconcile"],
        blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
        encrypted_execution_vault: encrypted,
        authorization: {
          source: "phantom_approve_agent_v1",
          network: "mainnet",
          agent_name: "ghola-mainnet",
          venue_account_commitment: venueAccount,
          agent_wallet_commitment: agent,
          valid_until: "2026-08-20T11:00:00.000Z",
          worker_verification_commitment: `hyperliquid_agent_onboarding_verification_${"d".repeat(48)}`,
          worker_verified_at: "2026-08-19T10:05:00.000Z",
          worker_contract_version: 2,
          worker_git_sha: RELEASE.worker_git_sha,
          worker_image_digest: RELEASE.worker_image_digest,
          worker_config_fingerprint: RELEASE.config_fingerprint,
        },
      },
    }],
    graduations: [{
      version: 3,
      contract_version: 2,
      status: "active",
      owner_commitment: owner,
      account_commitment: account,
      vault_commitment: vault,
      proof_notional_usd: 11,
      completed_at: "2026-08-19T10:07:00.000Z",
      ...releaseFields(),
    }],
    reconciliations: entries,
    reservations: entries.map((entry) => ({
      reservation_id: entry.reservation_id,
      owner_commitment: owner,
      account_commitment: account,
      notional_usd: 11,
      status: "filled",
      request_commitment: entry.plan_digest,
    })),
  };
  const closeTimes = ["10:20:00", "10:40:00"];
  const entryClaims = entries.map((entry, entryIndex) => {
    const oid = String(101 + index * 1000 + entryIndex);
    const protectionCloid = 7 + index * 4 + entryIndex * 2;
    const protection = {
      takeProfitOid: String(301 + index * 1000 + entryIndex * 2),
      takeProfitCloid: `0x${protectionCloid.toString(16).repeat(32)}`,
      stopLossOid: String(302 + index * 1000 + entryIndex * 2),
      stopLossCloid: `0x${(protectionCloid + 1).toString(16).repeat(32)}`,
    };
    entry.order_id = `hyperliquid:${oid}`;
    return claimRow({
    workOrder: entry.work_order_commitment,
    oid,
    cloid: `0x${String(entryIndex + 1).repeat(32)}`,
    at: iso(times[entryIndex]),
    owner,
    account,
    vault,
    vaultPolicy,
    entry,
    reduceOnly: false,
    protection,
  });
  });
  const closeClaims = closeTimes.map((time, closeIndex) => claimRow({
    workOrder: `hl_close_${String(index * 2 + closeIndex + 4).repeat(40)}_close_hype_1`,
    oid: String(201 + index * 1000 + closeIndex),
    cloid: `0x${String(closeIndex + 5).repeat(32)}`,
    at: iso(time),
    owner,
    account,
    vault,
    vaultPolicy,
    entry: null,
    reduceOnly: true,
  }));
  const claims = [...entryClaims, ...closeClaims];
  const worker = {
    database_clock: NOW.toISOString(),
    claims: claims.map((item) => item.claim),
    attempts: claims.map((item) => item.attempt),
    idempotency: claims.map((item) => item.idempotency),
  };
  const protectionOrders = entryClaims.flatMap((item) => ([
    {
      oid: item.protection.takeProfitOid,
      cloid: item.protection.takeProfitCloid,
      reduceOnly: true,
      status: "canceled",
    },
    {
      oid: item.protection.stopLossOid,
      cloid: item.protection.stopLossCloid,
      reduceOnly: true,
      status: "canceled",
    },
  ]));
  const ordered = [entryClaims[0], entryClaims[1], closeClaims[0], closeClaims[1], ...protectionOrders];
  const fillTimeByOid = new Map([
    [entryClaims[0].oid, Date.parse(iso(times[0])) + 1_000],
    [closeClaims[0].oid, Date.parse(iso(closeTimes[0])) + 1_000],
    [entryClaims[1].oid, Date.parse(iso(times[1])) + 1_000],
    [closeClaims[1].oid, Date.parse(iso(closeTimes[1])) + 1_000],
  ]);
  const orderStatuses = ordered.map((item) => venueOrder(item));
  const venue = {
    role: { role: "user" },
    clearinghouse: { assetPositions: [] },
    spot: { balances: [{ coin: "USDC", total: "100", hold: "0" }] },
    openOrders: [],
    frontendOpenOrders: [],
    extraAgents: [{
      name: "ghola-mainnet",
      address: agentAddress,
      validUntil: Date.parse("2026-08-20T11:00:00.000Z"),
    }],
    orderStatuses,
    historicalOrders: ordered.map((item) => ({
      status: item.status ?? "filled",
      order: {
        coin: "HYPE",
        oid: item.oid,
        cloid: item.cloid,
        reduceOnly: item.reduceOnly,
        ...((item.status ?? "filled") === "filled" ? { tif: "Ioc" } : {}),
      },
    })),
    fills: ordered.filter((item) => (item.status ?? "filled") === "filled").map((item, fillIndex) => ({
      coin: "HYPE",
      oid: item.oid,
      cloid: item.cloid,
      sz: "0.1",
      px: item.reduceOnly ? "110" : "110",
      time: fillTimeByOid.get(item.oid),
      hash: `0x${(fillIndex + index * 4 + 1).toString(16).padStart(64, "0")}`,
    })),
  };
  return { profile, address, owner, billing: billing(index), terminal: terminal(), main, worker, venue };
}

function entryRecord({ index, entryIndex, time, owner, account, vault, vaultPolicy, encrypted }) {
  const marker = String(index * 2 + entryIndex + 1);
  const workOrder = `live_trade_work_order_${marker.repeat(48)}`;
  const plan = `sha256:${marker.repeat(64)}`;
  const request = `live_trade_request_${marker.repeat(48)}`;
  const orderPolicy = `live_trade_order_policy_${marker.repeat(48)}`;
  const recipient = `phala:cvm:${index}`;
  const workerRequest = {
    version: 1,
    reconciliation_binding_version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    work_order_commitment: workOrder,
    owner_commitment: owner,
    account_commitment: account,
    vault_commitment: vault,
    market: "HYPE",
    operation_class: "limit_order",
    plan_digest: plan,
    request_commitment: request,
    policy_commitment: vaultPolicy,
    order_policy_commitment: orderPolicy,
    encrypted_execution_vault: structuredClone(encrypted),
    session_policy: { execution_network: "mainnet", policy_commitment: orderPolicy },
  };
  return {
    status: "reconciled",
    owner_commitment: owner,
    account_commitment: account,
    vault_commitment: vault,
    work_order_commitment: workOrder,
    plan_digest: plan,
    request_commitment: request,
    vault_policy_commitment: vaultPolicy,
    order_policy_commitment: orderPolicy,
    market: "HYPE",
    require_protection: true,
    protection_slippage_bps: 50,
    result_commitment: `hyperliquid_result_${marker.repeat(48)}`,
    worker_image_digest: RELEASE.worker_image_digest,
    worker_recipient: recipient,
    reservation_id: `reservation_${marker.repeat(24)}`,
    worker_request_digest: acceptanceCommitment(workerRequest),
    order_id: null,
    created_at: iso(time),
    updated_at: iso(time),
    worker_request: workerRequest,
  };
}

function claimRow({ workOrder, oid, cloid, at, owner, account, vault, vaultPolicy, entry, reduceOnly, protection = null }) {
  const digest = `${reduceOnly ? "9" : "8"}`.repeat(64);
  const result = entry?.result_commitment ?? `hyperliquid_result_${String(Number(oid) % 10).repeat(48)}`;
  const proof = {
    proof_kind: "hyperliquid_execution_proof_v1",
    network: "mainnet",
    broadcast_performed: true,
    final_venue_execution_proven: true,
    final_fill_proven: true,
    final_no_fill_proven: false,
    venue_order_readback_proven: true,
    terminal_status: "filled",
    venue_order_oid: oid,
    venue_order_cloid: cloid,
    ...(reduceOnly ? {} : {
      position_protection_proven: true,
      take_profit_oid: protection.takeProfitOid,
      take_profit_cloid: protection.takeProfitCloid,
      stop_loss_oid: protection.stopLossOid,
      stop_loss_cloid: protection.stopLossCloid,
    }),
  };
  const receipt = {
    status: "filled",
    work_order_commitment: workOrder,
    result_commitment: result,
    execution_request_digest: digest,
    vault_commitment: vault,
    final_proof: proof,
  };
  return {
    oid,
    cloid,
    reduceOnly,
    protection,
    claim: {
      work_order_commitment: workOrder,
      status: "completed",
      created_at: at,
      claim_json: { context: {
        owner_commitment: owner,
        account_commitment: account,
        vault_commitment: vault,
        venue_id: "hyperliquid",
        operation_class: "limit_order",
        market: "HYPE",
        request_digest: digest,
        policy_commitment: vaultPolicy,
        ...(entry ? {
          plan_digest: entry.plan_digest,
          request_commitment: entry.request_commitment,
          policy_commitment: entry.vault_policy_commitment,
          order_policy_commitment: entry.order_policy_commitment,
          reconciliation_binding_version: 1,
          original_request_digest: entry.worker_request_digest,
        } : {}),
      } },
      receipt_json: receipt,
    },
    attempt: {
      work_order_commitment: workOrder,
      attempt_json: { status: "filled", execution_request_digest: digest, final_proof: structuredClone(proof) },
    },
    idempotency: { work_order_commitment: workOrder, receipt_json: structuredClone(receipt) },
  };
}

function venueOrder(item) {
  const status = item.status ?? "filled";
  return {
    status: "order",
    order: {
      status,
      order: {
        coin: "HYPE",
        oid: item.oid,
        cloid: item.cloid,
        reduceOnly: item.reduceOnly,
        ...(status === "filled" ? { tif: "Ioc" } : {}),
      },
    },
  };
}

function operationalReadiness() {
  return {
    status: "blocked",
    ready: false,
    launch_profile: "byo_hyperliquid",
    checks: {
      database: "ready",
      trading_circuit: "ready",
      worker: "ready",
      sentry: "configured",
      observability: "configured",
      reconciliation: "ready",
      venue_connectivity: "configured",
      trading_control: "configured",
    },
    live_trading: {
      contract_version: 2,
      launch_state: "canary",
      release_valid: true,
      worker_ready: true,
    },
    checked_at: NOW.toISOString(),
  };
}

function workerBuildProvenance() {
  return [{
    verificationResult: {
      verifiedTimestamps: [{ type: "transparency_log" }],
      statement: {
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{
          name: "ghcr.io/anndrrson/ghola",
          digest: { sha256: RELEASE.worker_image_digest.slice("sha256:".length) },
        }],
        predicate: { buildDefinition: { buildType: "https://mobyproject.org/buildkit@v1" } },
      },
    },
  }];
}

function publicStatus() {
  const response = {
    version: 1,
    contract_version: 2,
    status: "red",
    launch_state: "canary",
    live_trading_enabled: false,
    live_submit_mode: "disabled",
    byo_live_trading_enabled: false,
    pooled_live_trading_enabled: false,
    public_live_copy_allowed: false,
    checked_at: NOW.toISOString(),
    release_identity: structuredClone(RELEASE),
    live_worker_readiness: {
      ready: true,
      contract_version: 2,
      worker_git_sha: RELEASE.worker_git_sha,
      worker_image_digest: RELEASE.worker_image_digest,
      config_fingerprint: RELEASE.config_fingerprint,
      capabilities: ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"],
      reason_codes: [],
      checked_at: NOW.toISOString(),
    },
  };
  return {
    ...response,
    gate_commitment: gholaCommitment("live_trading_launch_gate", response),
  };
}

function terminal() {
  const response = {
    version: 1,
    venue_id: "hyperliquid",
    network: "mainnet",
    status: "green",
    opening_orders_enabled: true,
    access_mode: "account_canary",
    launch_state: "canary",
    release_identity: structuredClone(RELEASE),
    live_worker_readiness: publicStatus().live_worker_readiness,
    configured_capabilities: ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"],
    required_capabilities: ["limit_order"],
    authorized_capabilities: ["limit_order"],
    account_requirements: {
      account_ready: true,
      vault_ready: true,
      eligibility_ready: true,
      entitlement_ready: true,
      graduation_ready: true,
    },
    reason_codes: [],
    checked_at: NOW.toISOString(),
  };
  return {
    ...response,
    access_commitment: gholaCommitment("live_trading_terminal_access", response),
  };
}

function billing(index) {
  return {
    tier: "starter",
    access_source: "complimentary_pass",
    access_state: "active",
    invite_state: "active",
    active_pass_id: index === 0
      ? "33333333-3333-4333-8333-333333333333"
      : "44444444-4444-4444-8444-444444444444",
    expires_at: "2026-08-20T12:00:00.000Z",
    private_agent_compute: {
      remaining_seconds: 700,
      active_agent_limit: 1,
      active_agent_count: 0,
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-09-01T00:00:00.000Z",
    },
    private_agent_trading: {
      remaining_included_notional_micro_usd: 50_000_000,
      overage_notional_micro_usd: 0,
      overage_fee_bps: 0,
      accrued_fee_micro_usd: 0,
      queued_fee_cents: 0,
      invoiced_fee_cents: 0,
      cap_reached: false,
      live_trading_allowed: true,
      billing_state: "current",
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-09-01T00:00:00.000Z",
    },
  };
}

function releaseFields() {
  return {
    web_git_sha: RELEASE.web_git_sha,
    worker_git_sha: RELEASE.worker_git_sha,
    worker_image_digest: RELEASE.worker_image_digest,
    config_fingerprint: RELEASE.config_fingerprint,
  };
}

function iso(time) {
  return `2026-08-19T${time}.000Z`;
}

function assertFailure(report, failure) {
  assert.equal(report.machine_evidence.checks.some((item) => item.failure === failure), true,
    `expected failure ${failure}; got ${JSON.stringify(report.machine_evidence.checks)}`);
}
