import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  CARRY_EXECUTION_VENUES,
  carryExecutionQualification,
  venueAdapterCapability,
} from "@ghola/execution-core";
import {
  readCarryFundingSettlements,
  readLighterCarryWithdrawalRoute,
  readPrivateCarryAccountCapacity,
  registeredCarryAdapterId,
} from "../src/execution/private-execution.js";

test("worker Carry dispatch follows the execution-core capability registry", () => {
  for (const venueId of CARRY_EXECUTION_VENUES) {
    assert.equal(
      registeredCarryAdapterId(venueId, "carry_execution"),
      venueAdapterCapability(venueId, "carry_execution").adapter_id,
    );
    assert.equal(
      registeredCarryAdapterId(venueId, "no_submit_reconciliation"),
      venueAdapterCapability(venueId, "no_submit_reconciliation").adapter_id,
    );
    assert.equal(
      registeredCarryAdapterId(venueId, "exact_quantity_recovery"),
      venueAdapterCapability(venueId, "exact_quantity_recovery").adapter_id,
    );
  }
});

test("Carry route capacity opens only the exact sealed venue account", async () => {
  const ownerCommitment = "owner:carry:0001";
  const accountCommitment = "account:hyperliquid:0001";
  const encryptedVault = { ciphertext: "sealed" };
  const capacity = await readPrivateCarryAccountCapacity({
    request: {
      venue_id: "hyperliquid",
      collateral_asset: "USDC",
      from_account_commitment: accountCommitment,
      source_account_state_commitment: "carry:account-state:hyperliquid:0001",
    },
    probe_context: {
      owner_commitment: ownerCommitment,
      venue_access_by_account: {
        [accountCommitment]: {
          status: "ready",
          owner_commitment: ownerCommitment,
          account_commitment: accountCommitment,
          encrypted_execution_vault: encryptedVault,
        },
      },
    },
    recipient: { recipient_id: "recipient:0001" },
    now: () => 1_800_000_000_000,
    openExecutionVault: async ({ body, venueId }) => {
      assert.equal(body.account_commitment, accountCommitment);
      assert.equal(body.encrypted_execution_vault, encryptedVault);
      assert.equal(venueId, "hyperliquid");
      return {
        json: {
          kind: "ghola_hyperliquid_execution_vault",
          network: "mainnet",
          hyperliquid_account_address: `0x${"22".repeat(20)}`,
          api_wallet_private_key: `0x${"11".repeat(32)}`,
        },
      };
    },
    readHyperliquidMetrics: async () => ({ available_balance: 12.3456789 }),
  });
  assert.equal(capacity.maximum_transfer_micro_usdc, 12_345_678);
  assert.equal(capacity.account_state_commitment, "carry:account-state:hyperliquid:0001");
  assert.equal(capacity.transaction_broadcast, false);
});

test("Carry route capacity supports sealed Aster state and rejects account drift", async () => {
  const ownerCommitment = "owner:carry:0001";
  const accountCommitment = "account:aster:0001";
  const key = `0x${"11".repeat(32)}`;
  const access = {
    status: "ready",
    owner_commitment: ownerCommitment,
    account_commitment: accountCommitment,
    encrypted_execution_vault: { ciphertext: "sealed" },
  };
  const common = {
    request: {
      venue_id: "aster",
      collateral_asset: "USDT",
      from_account_commitment: accountCommitment,
      source_account_state_commitment: "carry:account-state:aster:0001",
    },
    probe_context: {
      owner_commitment: ownerCommitment,
      venue_access_by_account: { [accountCommitment]: access },
    },
    recipient: { recipient_id: "recipient:0001" },
    now: () => 1_800_000_000_000,
    openExecutionVault: async () => ({
      json: {
        kind: "ghola_aster_execution_vault",
        network: "mainnet",
        user_address: `0x${"22".repeat(20)}`,
        signer_address: privateKeyToAccount(key).address,
        api_wallet_private_key: key,
      },
    }),
    readAsterState: async () => ({ available_balance: 7.5 }),
  };
  const capacity = await readPrivateCarryAccountCapacity(common);
  assert.equal(capacity.maximum_transfer_micro_usdc, 7_500_000);
  assert.equal(capacity.collateral_asset, "USDT");

  await assert.rejects(() => readPrivateCarryAccountCapacity({
    ...common,
    request: { ...common.request, from_account_commitment: "account:aster:other" },
  }), /account capacity access is unavailable/);
});

test("shadow-only candidates cannot enter worker Carry dispatch", () => {
  for (const venueId of ["edgex", "dydx"]) {
    assert.equal(carryExecutionQualification(venueId).eligible, false);
    assert.ok(carryExecutionQualification(venueId).gaps.includes("adapter_missing:no_submit_reconciliation"));
    assert.equal(registeredCarryAdapterId(venueId, "carry_execution"), null);
    assert.equal(registeredCarryAdapterId(venueId, "no_submit_reconciliation"), null);
  }
});

test("Lighter route reads open only the exact sealed monitoring account", async () => {
  const access = {
    status: "ready",
    owner_commitment: "owner:carry:0001",
    account_commitment: "account:lighter:0001",
    encrypted_execution_vault: { ciphertext: "sealed" },
  };
  let opened = false;
  const quote = await readLighterCarryWithdrawalRoute({
    request: {
      from_account_commitment: access.account_commitment,
      source_account_state_commitment: "carry:account-state:lighter:0001",
    },
    probe_context: {
      owner_commitment: access.owner_commitment,
      venue_access_by_account: { [access.account_commitment]: access },
    },
    recipient: { recipient_id: "recipient:0001" },
    openCredential: async ({ bundle, accountCommitment }) => {
      assert.equal(bundle, access.encrypted_execution_vault);
      assert.equal(accountCommitment, access.account_commitment);
      opened = true;
      return { network: "mainnet" };
    },
    readWithdrawalQuote: async ({ credential, account_state_commitment: stateCommitment }) => ({
      credential,
      stateCommitment,
      transaction_broadcast: false,
    }),
  });
  assert.equal(opened, true);
  assert.equal(quote.stateCommitment, "carry:account-state:lighter:0001");
  assert.equal(quote.transaction_broadcast, false);

  await assert.rejects(() => readLighterCarryWithdrawalRoute({
    request: { from_account_commitment: "account:lighter:other" },
    probe_context: {
      owner_commitment: access.owner_commitment,
      venue_access_by_account: { [access.account_commitment]: access },
    },
    recipient: {},
  }), /lighter carry route access is unavailable/);
});

test("Carry funding history dispatches through the registered Aster adapter", async (t) => {
  const priorDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  const priorFetch = globalThis.fetch;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  let requestUrl = "";
  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return {
      ok: true,
      json: async () => [{ time: 1_800_000_000_100, income: "0.01", asset: "USDT", tranId: 42 }],
    };
  };
  t.after(() => {
    globalThis.fetch = priorFetch;
    if (priorDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = priorDryRun;
  });

  const rows = await readCarryFundingSettlements({
    body: {
      venue_id: "aster",
      asset: "BTC",
      start_time_ms: 1_800_000_000_000,
      end_time_ms: 1_800_000_001_000,
    },
    recipient: {},
    state: {},
  });
  assert.match(requestUrl, /\/fapi\/v1\/income/);
  assert.deepEqual(rows, [{
    venue_id: "aster",
    asset: "BTC",
    occurred_at_ms: 1_800_000_000_100,
    amount_quote: "0.01",
    quote_asset: "USDT",
    settlement_id: "42",
  }]);
});
