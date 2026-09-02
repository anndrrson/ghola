import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadCarryTransferRouteEvidence,
  observeCarryTransferRoutes,
  observePreopenCarryTransferRoutes,
  storeCarryTransferRouteEvidence,
  verifyCarryTransferRouteEvidence,
} from "../src/execution/carry-transfer-routes.js";
import { buildCarryInventoryEvidence } from "../src/execution/carry-inventory.js";
import { createWorkerState } from "../src/state/private-state.js";

const NOW = 1_800_000_000_000;
const OWNER = "owner:commitment:0001";

test("observes owner-bound capital routes before any position is opened", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-preopen-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const contexts = [];
  const attestations = [];
  const result = await observePreopenCarryTransferRoutes({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    venue_access: preopenAccess(),
    readiness: preopenReadiness(),
    attest_account_state: async (account, context) => {
      attestations.push({ account, context });
      return observeAccount(account, context);
    },
    env: { PRIVATE_AGENT_IMAGE_DIGEST: `sha256:${"9".repeat(64)}` },
    probe_route: async (request, context) => {
      contexts.push(context);
      return observedQuote({
        source_collateral_asset: request.source_collateral_asset,
        destination_collateral_asset: request.destination_collateral_asset,
        conversion_required: request.conversion_required,
        conversion_quote_verified: true,
        conversion_rate_e8: request.conversion_required ? 99_950_000 : 100_000_000,
      });
    },
    now_ms: NOW,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.observed_route_count, 6);
  assert.equal(result.available_route_count, 6);
  assert.equal(attestations.length, 3);
  assert.equal(result.evidence.account_state_attestations.length, 3);
  assert.equal(result.evidence.routes.every((route) =>
    route.source_account_state_attestation_commitment
    && route.destination_account_state_attestation_commitment), true);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.fund_movement_authorized, false);
  assert.equal(result.automatic_transfer_permitted, false);
  assert.equal(contexts.every((context) => context.owner_commitment === OWNER), true);
  assert.equal(contexts.every((context) => Object.keys(context.venue_access_by_account).length === 2), true);
});

test("fails closed on fresh account position, order, or liquidation drift", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-transfer-route-drift-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mutations = [
    { position_count: 1, positions: [{ market: "BTC-PERP", size: "1" }] },
    { open_order_count: 1, open_orders: [{ market: "BTC-PERP", order_id: "1" }] },
    {
      liquidation_distance_bps: 1_000,
      liquidation_distance_verified: true,
      liquidation_distance_source: "venue_account_state",
    },
  ];
  for (const mutation of mutations) {
    await assert.rejects(() => observeCarryTransferRoutes({
      state: createWorkerState(dir),
      owner_commitment: OWNER,
      worker_image_digest: `sha256:${"7".repeat(64)}`,
      accounts: observerAccounts(),
      attest_account_state: (account, context) => observeAccount(account, context, mutation),
      probe_route: async () => observedQuote(),
      checked_at_ms: NOW,
      now_ms: NOW,
    }), /carry_transfer_route_account_(state_drift|observation_inventory_ambiguous)/);
  }
});

test("fails closed when pre-open venue access is ambiguous", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-preopen-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const venueAccess = preopenAccess();
  venueAccess.aster.account_commitment = venueAccess.lighter.account_commitment;
  const result = await observePreopenCarryTransferRoutes({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    venue_access: venueAccess,
    readiness: preopenReadiness(),
    attest_account_state: observeAccount,
    env: { PRIVATE_AGENT_IMAGE_DIGEST: `sha256:${"9".repeat(64)}` },
    probe_route: async () => observedQuote(),
    now_ms: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_preopen_route_access_ambiguous");
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.fund_movement_authorized, false);
});

test("observes all-in collateral routes internally without authorizing movement", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const result = await observeCarryTransferRoutes({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"d".repeat(64)}`,
    accounts: observerAccounts(),
    attest_account_state: observeAccount,
    probe_route: async (request) => {
      requests.push(request);
      return observedQuote();
    },
    checked_at_ms: NOW,
    now_ms: NOW,
  });
  assert.equal(result.observed_route_count, 2);
  assert.equal(result.available_route_count, 2);
  assert.deepEqual(result.failures, []);
  assert.equal(requests.every((request) => request.transaction_broadcast === false), true);
  assert.equal(requests.every((request) => request.fund_movement_authorized === false), true);
  assert.equal(result.evidence.routes.every((item) => item.quote_verified === true), true);
  assert.equal(result.evidence.routes.every((item) => item.all_in_fee_verified === true), true);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.fund_movement_authorized, false);
});

test("keeps incomplete or missing route probes unavailable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await observeCarryTransferRoutes({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"e".repeat(64)}`,
    accounts: observerAccounts(),
    attest_account_state: observeAccount,
    probe_route: async () => observedQuote({ all_in_fee_verified: false }),
    checked_at_ms: NOW,
    now_ms: NOW,
  });
  assert.equal(result.available_route_count, 0);
  assert.equal(result.failures.length, 2);
  assert.equal(result.evidence.routes.every((item) => item.status === "unavailable"), true);
  assert.equal(result.evidence.routes.every((item) => item.maximum_transfer_micro_usdc === 0), true);

  await assert.rejects(() => observeCarryTransferRoutes({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"e".repeat(64)}`,
    accounts: observerAccounts().map((account) => ({
      ...account,
      account_state_checked_at_ms: NOW - 30_001,
    })),
    attest_account_state: observeAccount,
    checked_at_ms: NOW,
    now_ms: NOW,
  }), /carry_transfer_route_account_state_stale/);
});

test("requires explicit USDC-USDT conversion economics for Aster routes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const accounts = [
    observerAccounts()[1],
    stateAccount("aster", "account:aster:0001", "carry:account-state:aster:0001"),
  ];
  const incomplete = await observeCarryTransferRoutes({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"f".repeat(64)}`,
    accounts,
    attest_account_state: observeAccount,
    probe_route: async (request) => observedQuote({
      source_collateral_asset: request.source_collateral_asset,
      destination_collateral_asset: request.destination_collateral_asset,
      conversion_required: true,
      conversion_quote_verified: false,
      conversion_rate_e8: 0,
    }),
    checked_at_ms: NOW,
    now_ms: NOW,
  });
  assert.equal(incomplete.available_route_count, 0);
  assert.equal(incomplete.evidence.routes.every((item) => item.status === "unavailable"), true);

  const zeroRate = await observeCarryTransferRoutes({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"f".repeat(64)}`,
    accounts,
    attest_account_state: observeAccount,
    probe_route: async (request) => observedQuote({
      source_collateral_asset: request.source_collateral_asset,
      destination_collateral_asset: request.destination_collateral_asset,
      conversion_required: true,
      conversion_quote_verified: true,
      conversion_rate_e8: 0,
    }),
    checked_at_ms: NOW,
    now_ms: NOW,
  });
  assert.equal(zeroRate.available_route_count, 0);
  assert.equal(zeroRate.evidence.routes.every((item) => item.status === "unavailable"), true);

  const verified = await observeCarryTransferRoutes({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"f".repeat(64)}`,
    accounts,
    attest_account_state: observeAccount,
    probe_route: async (request) => observedQuote({
      source_collateral_asset: request.source_collateral_asset,
      destination_collateral_asset: request.destination_collateral_asset,
      conversion_required: true,
      conversion_quote_verified: true,
      conversion_rate_e8: 99_950_000,
      withdrawal_fee_micro_usdc: 5_000,
      conversion_fee_micro_usdc: 3_000,
      conversion_slippage_micro_usdc: 2_000,
    }),
    checked_at_ms: NOW,
    now_ms: NOW,
  });
  assert.equal(verified.available_route_count, 2);
  assert.equal(verified.evidence.routes.every((item) => item.conversion_required === true), true);
  assert.equal(verified.evidence.routes.every((item) => item.source_collateral_asset !== item.destination_collateral_asset), true);
});

test("stores only commitment-backed worker transfer-route evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const evidence = (await observeCarryTransferRoutes({
    state,
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"a".repeat(64)}`,
    accounts: observerAccounts(),
    attest_account_state: observeAccount,
    probe_route: async () => observedQuote(),
    checked_at_ms: NOW,
    now_ms: NOW,
  })).evidence;
  assert.match(evidence.evidence_commitment, /^carry:transfer-routes:evidence:/);
  assert.equal(evidence.transaction_broadcast, false);
  assert.equal(evidence.fund_movement_authorized, false);

  const loaded = await loadCarryTransferRouteEvidence({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    now_ms: NOW + 1_000,
    max_data_age_ms: 30_000,
    expected_worker_image_digest: evidence.worker_image_digest,
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.routes.length, 2);
  assert.equal(loaded.routes[0].evidence_source, "attested_worker");
  assert.equal(loaded.routes[0].evidence_commitment, evidence.evidence_commitment);
  assert.equal(loaded.routes[0].worker_image_digest, evidence.worker_image_digest);
});

test("rejects tampered, stale, and registry-mismatched transfer routes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const evidence = (await observeCarryTransferRoutes({
    state,
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"b".repeat(64)}`,
    accounts: observerAccounts(),
    attest_account_state: observeAccount,
    probe_route: async () => observedQuote(),
    checked_at_ms: NOW,
    now_ms: NOW,
  })).evidence;
  assert.deepEqual(verifyCarryTransferRouteEvidence({
    ...evidence,
    routes: [{
      ...evidence.routes[0],
      withdrawal_fee_micro_usdc: 99,
      fee_micro_usdc: 99,
    }],
  }), {
    ok: false,
    error: "carry_transfer_route_commitment_invalid",
    routes: [],
    transaction_broadcast: false,
    fund_movement_authorized: false,
  });
  const imageMismatch = await loadCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    now_ms: NOW + 1_000,
    max_data_age_ms: 30_000,
    expected_worker_image_digest: `sha256:${"c".repeat(64)}`,
  });
  assert.equal(imageMismatch.error, "carry_transfer_route_worker_image_mismatch");
  const stale = await loadCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    now_ms: NOW + 31_000,
    max_data_age_ms: 30_000,
    expected_worker_image_digest: evidence.worker_image_digest,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "carry_transfer_route_evidence_stale");
  await assert.rejects(() => storeCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"c".repeat(64)}`,
    routes: evidence.routes.map((item, index) => index === 0
      ? { ...item, source_adapter_id: "spoofed_adapter" }
      : item),
    account_state_attestations: evidence.account_state_attestations,
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
    now_ms: NOW,
  }), /carry_transfer_route_adapter_binding_invalid/);
});

function route(overrides = {}) {
  return {
    version: 1,
    route_id: "carry:transfer-route:lighter-hyperliquid:0001",
    from_account_commitment: "account:lighter:0001",
    from_venue_id: "lighter",
    to_account_commitment: "account:hyperliquid:0001",
    to_venue_id: "hyperliquid",
    source_adapter_id: "lighter_arbitrum_usdc_v1",
    destination_adapter_id: "hyperliquid_arbitrum_usdc_v1",
    source_account_state_commitment: "carry:account-state:lighter:0001",
    destination_account_state_commitment: "carry:account-state:hyperliquid:0001",
    quote_commitment: "carry:transfer-quote:0001",
    valuation_asset: "USD",
    source_collateral_asset: "USDC",
    destination_collateral_asset: "USDC",
    conversion_required: false,
    status: "available",
    quote_verified: true,
    all_in_fee_verified: true,
    valuation_basis_verified: true,
    conversion_quote_verified: true,
    conversion_rate_e8: 100_000_000,
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: 100_000_000,
    withdrawal_fee_micro_usdc: 1_000,
    deposit_fee_micro_usdc: 0,
    conversion_fee_micro_usdc: 0,
    conversion_slippage_micro_usdc: 0,
    fee_micro_usdc: 1_000,
    estimated_latency_ms: 60_000,
    as_of_ms: NOW,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    ...overrides,
  };
}

function observerAccounts() {
  return ["lighter", "hyperliquid"].map((venueId) => stateAccount(
    venueId,
    `account:${venueId}:0001`,
    `carry:account-state:${venueId}:0001`,
  ));
}

function stateAccount(venueId, accountCommitment, stateCommitment) {
  return {
    venue_id: venueId,
    account_commitment: accountCommitment,
    account_state_commitment: stateCommitment,
    account_state_checked_at_ms: NOW,
    position_count: 0,
    open_order_count: 0,
    flat_zero_orders: true,
    liquidation_distance_bps: null,
    liquidation_distance_verified: false,
    liquidation_distance_source: null,
    inventory: buildCarryInventoryEvidence({
      venue_id: venueId,
      account_commitment: accountCommitment,
      target_market: "BTC-PERP",
      positions: [],
      open_orders: [],
      position_inventory_verified: true,
      open_order_inventory_verified: true,
    }),
  };
}

async function observeAccount(account, _context, overrides = {}) {
  return {
    version: 1,
    kind: "ghola_carry_route_account_observation",
    venue_id: account.venue_id,
    account_commitment: account.account_commitment,
    observed_at_ms: NOW,
    positions: account.inventory.target_positions,
    open_orders: account.inventory.target_open_orders,
    position_count: account.position_count,
    open_order_count: account.open_order_count,
    flat_zero_orders: account.flat_zero_orders,
    liquidation_distance_bps: account.liquidation_distance_bps,
    liquidation_distance_verified: account.liquidation_distance_verified,
    liquidation_distance_source: account.liquidation_distance_source,
    position_inventory_verified: true,
    position_inventory_pagination_complete: true,
    position_inventory_has_more: false,
    open_order_inventory_verified: true,
    open_order_inventory_pagination_complete: true,
    open_order_inventory_has_more: false,
    available_balance_micro_usdc: 100_000_000,
    margin_balance_micro_usdc: 100_000_000,
    initial_margin_micro_usdc: 0,
    maintenance_margin_micro_usdc: 0,
    withdrawal_quote: null,
    read_only: true,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    ...overrides,
  };
}

function observedQuote(overrides = {}) {
  return {
    valuation_asset: "USD",
    source_collateral_asset: "USDC",
    destination_collateral_asset: "USDC",
    conversion_required: false,
    status: "available",
    quote_verified: true,
    all_in_fee_verified: true,
    valuation_basis_verified: true,
    conversion_quote_verified: true,
    conversion_rate_e8: 100_000_000,
    minimum_transfer_micro_usdc: 5_000_000,
    maximum_transfer_micro_usdc: 100_000_000,
    withdrawal_fee_micro_usdc: 10_000,
    deposit_fee_micro_usdc: 0,
    conversion_fee_micro_usdc: 0,
    conversion_slippage_micro_usdc: 0,
    fee_micro_usdc: 10_000,
    estimated_latency_ms: 60_000,
    as_of_ms: NOW,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    ...overrides,
  };
}

function preopenAccess() {
  return Object.fromEntries(["hyperliquid", "lighter", "aster"].map((venueId) => [venueId, {
    owner_commitment: OWNER,
    account_commitment: `account:${venueId}:preopen`,
    vault_commitment: `vault:${venueId}:preopen`,
    policy_commitment: `policy:${venueId}:preopen`,
  }]));
}

function preopenReadiness() {
  return {
    ready: true,
    owner_commitment: OWNER,
    image_digest: `sha256:${"9".repeat(64)}`,
    registry_venue_ids: ["hyperliquid", "lighter", "aster"],
    checked_at_ms: NOW,
    capital_plan: ["hyperliquid", "lighter", "aster"].map((venueId) => stateAccount(
      venueId,
      `account:${venueId}:preopen`,
      `carry:account-state:${venueId}:preopen`,
    )),
  };
}
