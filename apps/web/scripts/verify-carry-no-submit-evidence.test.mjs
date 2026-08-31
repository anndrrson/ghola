import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";
import {
  cashflowValuationEvidenceMessage,
  executionVenueSpec,
} from "@ghola/execution-core";
import { authenticateCarryPrivatePrimeReadiness } from "../../private-agent-worker/src/execution/carry-private-prime-authentication.js";
import { buildCarryPrivatePrimeReadiness } from "../../private-agent-worker/src/execution/carry-private-prime-readiness.js";
import { preflightCarryExecutionMatrix } from "../../private-agent-worker/src/execution/carry-preflight.js";
import { verifyCarryNoSubmitEvidence } from "./verify-carry-no-submit-evidence.mjs";

const NOW = 1_800_000_000_000;
const SECRET = "test-private-prime-capability-secret";
const PREVIEW_URL = "https://web-proof-anndrrsons-projects.vercel.app";
const WEB_COMMIT_SHA = "a".repeat(40);
const WORKER_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const SIGNER = generateKeyPairSync("ed25519");
const SIGNER_PUBLIC_KEY_B64 = SIGNER.publicKey.export({ format: "der", type: "spki" }).toString("base64");

test("independently verifies exact signed three-venue no-submit evidence", async () => {
  const proof = await evidence();
  const verified = verifyCarryNoSubmitEvidence(proof, expectations());
  assert.equal(verified.ok, true);
  assert.equal(verified.three_venue_ready, true);
  assert.equal(verified.transaction_broadcast, false);
  assert.equal(verified.mac_verified, true);
});

test("rejects tampered pair evidence, request context, signer identity, and candidate identity", async () => {
  const pairTampered = structuredClone(await evidence());
  pairTampered.response.readiness_evidence.pairs[0].transaction_broadcast = true;
  assert.throws(
    () => verifyCarryNoSubmitEvidence(pairTampered, expectations()),
    /no_submit_readiness_evidence_invalid:carry_readiness_pair_unproven/,
  );

  const contextTampered = structuredClone(await evidence());
  contextTampered.response.private_prime_authentication.context.work_order_commitment = "carry_matrix_other";
  assert.throws(
    () => verifyCarryNoSubmitEvidence(contextTampered, expectations()),
    /no_submit_worker_context_mismatch/,
  );

  const signerTampered = structuredClone(await evidence());
  assert.throws(
    () => verifyCarryNoSubmitEvidence(signerTampered, {
      ...expectations(),
      expected_signer_public_keys_b64: [Buffer.from("wrong signer").toString("base64")],
    }),
    /no_submit_worker_signer_unpinned/,
  );

  const candidateTampered = structuredClone(await evidence());
  candidateTampered.source.web_commit_sha = "c".repeat(40);
  assert.throws(
    () => verifyCarryNoSubmitEvidence(candidateTampered, expectations()),
    /no_submit_web_revision_mismatch/,
  );
});

test("preserves historical proof after freshness expires without claiming current readiness", async () => {
  const verified = verifyCarryNoSubmitEvidence(await evidence(), {
    ...expectations(),
    shared_secret: "",
    now_ms: NOW + 86_400_000,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.fresh_now, false);
  assert.equal(verified.mac_verified, false);
});

async function evidence() {
  const ownerCommitment = "owner_commitment_matrix_proof_0001";
  const venueAccess = Object.fromEntries(["hyperliquid", "lighter", "aster"].map((venueId) => [
    venueId,
    access(ownerCommitment, venueId),
  ]));
  const request = {
    version: 1,
    owner_commitment: ownerCommitment,
    operation_class: "matrix_no_submit",
    work_order_commitment: "carry_matrix_offline_proof_0001",
    asset: "BTC",
    notional_usd: 100,
    horizon_days: 30,
    venue_access: venueAccess,
  };
  const rows = new Map();
  let verificationIndex = 0;
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 0,
    taker_fee_bps: 1,
    fee_source: "test_account_fee_schedule",
    fees_exact_for_account: true,
    fees_conservative_upper_bound: false,
    position_count: 0,
    open_order_count: 0,
    liquidation_distance_bps: null,
    liquidation_distance_verified: false,
    liquidation_distance_source: null,
  };
  const matrix = await preflightCarryExecutionMatrix({
    body: request,
    recipient: {},
    state: {
      putIdempotency: async (key, receipt) => { rows.set(key, { receipt }); return receipt; },
    },
    env: { PHALA_CVM_IMAGE_DIGEST: WORKER_IMAGE_DIGEST },
    now: () => NOW,
    fetchVenue: async ({ venue_id: venueId }) => [snapshot(venueId)],
    verifyOrder: async ({ venue_id: venueId, instruction, work_order_commitment: workOrderCommitment }) => {
      verificationIndex += 1;
      return {
        status: "verified_ready",
        work_order_commitment: workOrderCommitment,
        account_commitment: venueAccess[venueId].account_commitment,
        verification_commitment: `verification_matrix_${venueId}_${verificationIndex}`,
        checks: { order_request_checked: true, transaction_broadcast: false },
        order_shape: {
          notional_micro_usdc: 100_000_000,
          quantity_step_e8: 1_000,
          price_tick_e8: 1_000_000,
        },
        account,
        ...(venueId === "lighter" ? {
          authority_boundary: {
            venue_native_trade_only: false,
            withdrawal_request_permitted: false,
            secure_withdrawal_destination: "owner_l1_only",
            owner_wallet_key_present: false,
            non_owner_fund_movement_possible: false,
          },
        } : { authority_boundary: { venue_native_trade_only: true } }),
        instruction,
      };
    },
    readHyperliquidSnapshot: async () => ({
      status: "ready_to_trade",
      trading_enabled: true,
      position_count: 0,
      open_order_count: 0,
    }),
    readHyperliquidCarryMetrics: async () => account,
  });
  assert.equal(matrix.no_submit_ready, true, JSON.stringify(matrix.failures));
  const privatePrimeReadiness = buildCarryPrivatePrimeReadiness({
    readiness: matrix.readiness,
    diagnostic: matrix.diagnostic,
    shadow_qualification: null,
    carry_supervision: null,
    route_observation_configured: false,
    route_evidence: null,
    lifecycle_proof: null,
    now_ms: NOW + 1_000,
  });
  const privatePrimeAuthentication = authenticateCarryPrivatePrimeReadiness({
    route_path: "/carry/preflight-matrix",
    body: request,
    private_prime_readiness: privatePrimeReadiness,
    secret: SECRET,
    sign_attested_message: (message) => ({
      signature_b64: sign(null, message, SIGNER.privateKey).toString("base64"),
      signer_public_key_b64: SIGNER_PUBLIC_KEY_B64,
    }),
  });
  return {
    version: 1,
    kind: "ghola_three_venue_no_submit_proof",
    network: "mainnet",
    captured_at_ms: NOW + 1_000,
    source: {
      preview_url: PREVIEW_URL,
      web_commit_sha: WEB_COMMIT_SHA,
      worker_image_digest: WORKER_IMAGE_DIGEST,
    },
    request: {
      ...request,
      venue_access: Object.fromEntries(Object.entries(venueAccess).map(([venueId, value]) => [venueId, {
        account_commitment: value.account_commitment,
        vault_commitment: value.vault_commitment,
        policy_commitment: value.policy_commitment,
      }])),
    },
    response: {
      ...matrix,
      private_prime_readiness: privatePrimeReadiness,
      private_prime_authentication: privatePrimeAuthentication,
    },
  };
}

function expectations() {
  return {
    expected_preview_url: PREVIEW_URL,
    expected_web_commit_sha: WEB_COMMIT_SHA,
    expected_worker_image_digest: WORKER_IMAGE_DIGEST,
    expected_signer_public_keys_b64: [SIGNER_PUBLIC_KEY_B64],
    shared_secret: SECRET,
    now_ms: NOW + 1_000,
  };
}

function access(ownerCommitment, venueId) {
  return {
    status: "ready",
    owner_commitment: ownerCommitment,
    account_commitment: `account_commitment_${venueId}`,
    vault_commitment: `vault_commitment_${venueId}`,
    policy_commitment: `policy_commitment_${venueId}`,
    encrypted_execution_vault: { ciphertext: "sealed" },
  };
}

function snapshot(venueId) {
  const shadow = executionVenueSpec(venueId).adapter_capabilities.perp_shadow;
  const quoteAsset = venueId === "hyperliquid" || venueId === "aster" ? "USDT" : "USD";
  const settlementAsset = venueId === "aster" ? "USDT" : "USDC";
  return {
    version: 1,
    venue_id: venueId,
    adapter_mode: "shadow_read_only",
    source_schema: shadow.source_schema,
    trading_api_available: true,
    contract_id: `${venueId}:BTC`,
    economic_equivalence_id: "carry:BTC-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: quoteAsset,
    collateral_asset: venueId === "aster" ? "USDT" : "USDC",
    funding_settlement_asset: settlementAsset,
    fee_settlement_asset: settlementAsset,
    asset_valuations: [cashflowValuation(quoteAsset)],
    contract_type: "linear_perp",
    mark_price_e8: 10_000_000_000_000,
    index_price_e8: 10_000_000_000_000,
    best_bid_e8: 9_999_000_000_000,
    best_ask_e8: 10_001_000_000_000,
    depth_bids: [{ price_e8: 9_999_000_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 10_001_000_000_000, size_e8: 100_000_000 }],
    funding_rate_e12_per_interval: venueId === "aster" ? 400_000_000 : 100_000_000,
    funding_interval_ms: venueId === "aster" ? 28_800_000 : 3_600_000,
    maker_fee_bps: 0,
    taker_fee_bps: 1,
    minimum_notional_micro_usdc: 1_000_000,
    quantity_step_e8: 1_000,
    price_tick_e8: 1_000_000,
    initial_margin_bps: 1_000,
    maintenance_margin_bps: 500,
    liquidation_fee_bps: 0,
    margin_model: shadow.margin_model,
    liquidation_model: shadow.liquidation_model,
    as_of_ms: NOW,
    source_observed_at_ms: { market: NOW, funding: NOW, orderbook: NOW },
    source_max_age_ms: { market: 60_000, funding: 60_000, orderbook: 60_000 },
    stale_sources: [],
    status: "ready",
    stale: false,
    missing_fields: [],
    quality_flags: [],
    executable: false,
  };
}

function cashflowValuation(sourceAsset) {
  const valuation = {
    version: 1,
    source_asset: sourceAsset,
    valuation_asset: "USDC",
    verified: true,
    credit_rate_e8: 100_000_000,
    debit_rate_e8: 100_000_000,
    observed_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30_000,
    evidence_source: "test:cashflow-book:v1",
    evidence_commitment: `carry:cashflow-valuation:evidence:${(sourceAsset === "USDT" ? "a" : "b").repeat(64)}`,
  };
  return { ...valuation, evidence_message: cashflowValuationEvidenceMessage(valuation) };
}
