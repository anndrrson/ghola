import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  ownerMandateMessage,
  prepareTurnkeyHyperliquidExecution,
  submitTurnkeyHyperliquidExecution,
  turnkeyHyperliquidCredentialFromVault,
  verifyTurnkeyHyperliquidNoSubmit,
} from "../src/venues/hyperliquid-turnkey.js";
import {
  hyperliquidCredentialFromVault,
  submitHyperliquidExecution,
  verifyHyperliquidNoSubmit,
} from "../src/venues/hyperliquid.js";

const NOW = Date.now();
const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const SIGNING_OWNER = privateKeyToAccount(`0x${"55".repeat(32)}`);

function mandate(overrides = {}) {
  return {
    version: 1,
    mandate_id: "mandate:test:turnkey",
    network: "testnet",
    owner_address: OWNER,
    agent_address: AGENT,
    execution_address: OWNER,
    allowed_markets: ["BTC"],
    margin_mode: "isolated",
    configured_leverage: 3,
    max_leverage: 3,
    max_order_notional_micro_usdc: 50_000_000,
    max_gross_exposure_micro_usdc: 100_000_000,
    max_daily_notional_micro_usdc: 200_000_000,
    daily_loss_limit_micro_usdc: 25_000_000,
    max_drawdown_micro_usdc: 30_000_000,
    max_drawdown_bps: 2_000,
    max_slippage_bps: 50,
    stop_loss_bps: 500,
    max_open_orders: 5,
    max_orders_per_day: 20,
    data_max_age_ms: 30_000,
    expires_at_ms: NOW + 3_600_000,
    kill_switch: false,
    jurisdiction: {
      eligible: true,
      accepted_risk: true,
      attested_at_ms: NOW,
      terms_version: "test-2026-08",
    },
    ...overrides,
  };
}

function vault(overrides = {}) {
  return {
    kind: "ghola_hyperliquid_execution_vault",
    signing_mode: "turnkey_delegated",
    turnkey_organization_id: "org-user-123",
    turnkey_agent_key_ref: "local-test",
    owner_wallet_address: OWNER,
    agent_wallet_address: AGENT,
    hyperliquid_account_address: OWNER,
    owner_mandate_signature: "local-mock-owner-signature",
    perps_mandate: mandate(),
    ...overrides,
  };
}

function instruction(overrides = {}) {
  return {
    operation_class: "limit_order",
    order: {
      market: "BTC",
      side: "buy",
      quote_size: "25",
      limit_price: "100000",
      max_slippage_bps: "25",
      leverage: 3,
      margin_mode: "isolated",
      reduce_only: false,
      tif: "Gtc",
      protective_orders: { stop_loss: "96000", take_profit: "108000" },
      ...overrides,
    },
  };
}

function context(overrides = {}) {
  return {
    context_source: "test_fixture",
    asset_index: 0,
    sz_decimals: 5,
    venue_max_leverage: 50,
    mark_price: 100000,
    position_sides: {},
    state: {
      as_of_ms: Date.now(),
      equity_micro_usdc: 200_000_000,
      day_start_equity_micro_usdc: 205_000_000,
      peak_equity_micro_usdc: 210_000_000,
      gross_exposure_micro_usdc: 0,
      daily_notional_micro_usdc: 0,
      orders_today: 0,
      open_order_count: 0,
      managed_open_order_ids: [],
      position_notional_micro_usdc: {},
      ...overrides,
    },
  };
}

async function liveCredential() {
  const perpsMandate = mandate({
    owner_address: SIGNING_OWNER.address,
    execution_address: SIGNING_OWNER.address,
  });
  const signature = await SIGNING_OWNER.signMessage({ message: ownerMandateMessage(perpsMandate) });
  return turnkeyHyperliquidCredentialFromVault(vault({
    owner_wallet_address: SIGNING_OWNER.address,
    hyperliquid_account_address: SIGNING_OWNER.address,
    owner_mandate_signature: signature,
    perps_mandate: perpsMandate,
  }));
}

test("vault contains references and a signed mandate, never a wallet private key", () => {
  const credential = turnkeyHyperliquidCredentialFromVault(vault());
  assert.equal(credential.signing_mode, "turnkey_delegated");
  assert.equal(credential.agent_wallet_address, AGENT);
  assert.equal("api_wallet_private_key" in credential, false);
  assert.match(ownerMandateMessage(credential.perps_mandate), /Ghola Hyperliquid mandate v1/);
});

test("existing venue adapter routes delegated credentials without exposing a key", async () => {
  const credential = hyperliquidCredentialFromVault(vault());
  let legacyRunnerCalled = false;
  const result = await submitHyperliquidExecution({
    credential,
    instruction: instruction(),
    cloid: "0x11111111111111111111111111111111",
    runner: async () => {
      legacyRunnerCalled = true;
      return {};
    },
    turnkeySubmitter: async () => ({
      status: "submitted",
      oid: 123,
      bracket_count: 2,
      fills: [],
      risk_decision: { allowed: true, reasons: [] },
    }),
  });
  assert.equal(legacyRunnerCalled, false);
  assert.equal(result.provider_ref_seed.signing_mode, "turnkey_delegated");
  assert.equal(result.result_seed.risk_decision.allowed, true);
});

test("adapter proves a complete IOC fill from returned venue quantities", async () => {
  const credential = hyperliquidCredentialFromVault(vault());
  const target = "0x11111111111111111111111111111111";
  const result = await submitHyperliquidExecution({
    credential,
    instruction: instruction({ tif: "Ioc", protective_orders: null }),
    cloid: target,
    turnkeySubmitter: async () => ({
      status: "filled",
      oid: 124,
      bracket_count: 0,
      fills: [{ coin: "BTC", cloid: target, oid: 124, tid: 1240, px: "100000", sz: "0.00025", time: NOW }],
      fill_set_complete: true,
      fill_set_provenance: "hyperliquid_user_fills_time_v1",
      target_account_address: credential.account_address,
      target_client_order_id: target,
      target_order_id: 124,
      target_market: "BTC",
      risk_decision: { allowed: true, reasons: [] },
    }),
  });
  assert.equal(result.final_proof.final_fill_proven, true);
  assert.equal(result.final_proof.target_fill_set_complete, true);
  assert.equal(result.final_proof.fill_times_authoritative, true);
  assert.equal(result.final_proof.cumulative_filled_micro_usdc, 25_000_000);
  assert.equal(result.final_proof.filled_base_size, "0.00025");
});

test("filled acknowledgement without a complete fill set is reconciled before it becomes terminal", async () => {
  const credential = hyperliquidCredentialFromVault(vault());
  const target = "0x11111111111111111111111111111111";
  const requests = [];
  let submissions = 0;
  const responses = [
    { status: "order", order: { status: "filled", order: {
      oid: 125,
      cloid: target,
      coin: "BTC",
      origSz: "0.00025",
      timestamp: NOW - 1,
    } } },
    [{ coin: "BTC", cloid: target, oid: 125, tid: 1250, px: "100000", sz: "0.00025", fee: "0.01", time: NOW }],
  ];
  const result = await submitHyperliquidExecution({
    credential,
    instruction: instruction({ tif: "Ioc", protective_orders: null }),
    cloid: target,
    turnkeySubmitter: async () => {
      submissions += 1;
      return {
        status: "filled",
        oid: 125,
        bracket_count: 0,
        fills: [{ coin: "BTC", px: "100000", sz: "0.00025", time: NOW }],
        fill_set_complete: true,
        risk_decision: { allowed: true, reasons: [] },
      };
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
  });

  assert.equal(submissions, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].type, "orderStatus");
  assert.equal(requests[1].type, "userFillsByTime");
  assert.equal(result.status, "reconciled");
  assert.equal(result.final_proof.final_venue_execution_proven, true);
  assert.equal(result.final_proof.final_fill_proven, true);
  assert.equal(result.final_proof.target_fill_set_complete, true);
  assert.equal(result.final_proof.fill_times_authoritative, true);
  assert.equal(result.final_proof.fill_time_provenance, "hyperliquid_user_fills_time_v1");
});

test("filled acknowledgement remains ambiguous when its exact fill set cannot be reconciled", async () => {
  const credential = hyperliquidCredentialFromVault(vault());
  const target = "0x22222222222222222222222222222222";
  let submissions = 0;
  const result = await submitHyperliquidExecution({
    credential,
    instruction: instruction({ tif: "Ioc", protective_orders: null }),
    cloid: target,
    turnkeySubmitter: async () => {
      submissions += 1;
      return {
        status: "filled",
        oid: 126,
        bracket_count: 0,
        fills: [{ coin: "BTC", px: "100000", sz: "0.00025", time: NOW }],
      };
    },
    fetchImpl: async () => new Response(JSON.stringify({ status: "unknownOid" }), { status: 200 }),
  });

  assert.equal(submissions, 1);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.final_proof.broadcast_performed, true);
  assert.equal(result.final_proof.final_venue_execution_proven, false);
  assert.equal(result.final_proof.final_fill_proven, false);
  assert.equal(result.final_proof.target_fill_set_complete, false);
});

test("post-submit reconciliation failure is submission ambiguous and never resubmits", async () => {
  const credential = hyperliquidCredentialFromVault(vault());
  let submissions = 0;
  await assert.rejects(submitHyperliquidExecution({
    credential,
    instruction: instruction({ tif: "Ioc", protective_orders: null }),
    cloid: "0x33333333333333333333333333333333",
    turnkeySubmitter: async () => {
      submissions += 1;
      return {
        status: "filled",
        oid: 127,
        bracket_count: 0,
        fills: [{ coin: "BTC", px: "100000", sz: "0.00025", time: NOW }],
      };
    },
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  }), (error) => error?.code === "submission_ambiguous");
  assert.equal(submissions, 1);
});

test("targeted reconciliation filters fills to the original client order", async () => {
  const oldDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const credential = hyperliquidCredentialFromVault(vault());
    const target = "0x11111111111111111111111111111111";
    const responses = [
      { status: "order", order: { status: "filled", order: { oid: 1, cloid: target, coin: "BTC", origSz: "0.00025", timestamp: NOW - 1 } } },
      [
        { coin: "BTC", cloid: target, oid: 1, tid: 1, px: "100000", sz: "0.00025", time: NOW },
        { coin: "BTC", cloid: "0x33333333333333333333333333333333", oid: 2, tid: 2, px: "100000", sz: "1", time: NOW },
      ],
    ];
    const result = await submitHyperliquidExecution({
      credential,
      instruction: {
        operation_class: "reconcile",
        reconcile: { target_client_order_id: target },
      },
      cloid: "0x22222222222222222222222222222222",
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });
    assert.equal(result.status, "reconciled");
    assert.equal(result.fills.length, 1);
    assert.equal(result.final_proof.final_venue_execution_proven, true);
    assert.equal(result.final_proof.target_client_order_matched, true);
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.final_proof.cumulative_filled_micro_usdc, 25_000_000);
    assert.equal(result.final_proof.filled_base_size, "0.00025");
  } finally {
    if (oldDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = oldDryRun;
  }
});

test("existing no-submit adapter maps delegated verification and never broadcasts", async () => {
  const credential = hyperliquidCredentialFromVault(vault());
  const result = await verifyHyperliquidNoSubmit({
    credential,
    instruction: instruction(),
    cloid: "0x11111111111111111111111111111111",
    turnkeyVerifier: async () => ({
      sdk_checked: true,
      api_wallet_loaded: true,
      market_data_checked: true,
      account_state_checked: true,
      order_request_checked: true,
      live_venue_checked: false,
      transaction_broadcast: false,
    }),
  });
  assert.equal(result.status, "verified_no_funds");
  assert.equal(result.checks.transaction_broadcast, false);
  assert.equal(result.provider_ref_seed.no_submit, true);
});

test("BYO no-submit uses the in-process SDK and never starts a signing runner", async () => {
  const calls = [];
  const result = await verifyHyperliquidNoSubmit({
    credential: {
      network: "testnet",
      base_url: "https://api.hyperliquid-testnet.xyz",
      account_address: OWNER,
      api_wallet_private_key: `0x${"11".repeat(32)}`,
    },
    instruction: instruction({
      market: "BTC",
      order_type: "market",
      quote_size: "11",
      limit_price: undefined,
      protective_orders: {},
    }),
    cloid: "0x11111111111111111111111111111111",
    infoClient: {
      async meta() {
        calls.push("meta");
        return { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] };
      },
      async allMids() {
        calls.push("allMids");
        return { BTC: "100000" };
      },
      async clearinghouseState({ user }) {
        calls.push(`account:${user}`);
        return { marginSummary: { accountValue: "100" } };
      },
      async userRole({ user }) {
        calls.push(`role:${user}`);
        return { role: "agent", data: { user: OWNER } };
      },
    },
  });

  assert.equal(result.status, "verified_no_funds");
  assert.equal(result.checks.order_request_built, true);
  assert.equal(result.checks.transaction_broadcast, false);
  assert.equal(calls.length, 4);
  assert.ok(calls.includes("allMids"));
  assert.ok(calls.includes(`account:${OWNER}`));
  assert.ok(calls.includes("meta"));
  assert.ok(calls.some((call) => call.startsWith("role:0x")));
});

test("BYO no-submit rejects an API wallet authorized for a different owner", async () => {
  await assert.rejects(
    verifyHyperliquidNoSubmit({
      credential: {
        network: "testnet",
        account_address: OWNER,
        api_wallet_private_key: `0x${"11".repeat(32)}`,
      },
      instruction: instruction({
        market: "BTC",
        order_type: "market",
        quote_size: "11",
        protective_orders: {},
      }),
      cloid: "0x11111111111111111111111111111111",
      infoClient: {
        async meta() {
          return { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] };
        },
        async allMids() {
          return { BTC: "100000" };
        },
        async clearinghouseState() {
          return { marginSummary: { accountValue: "100" } };
        },
        async userRole() {
          return { role: "agent", data: { user: AGENT } };
        },
      },
    }),
    (error) => error?.code === "venue_access_required",
  );
});

test("prepares a bracket only after deterministic risk approval", async () => {
  const credential = turnkeyHyperliquidCredentialFromVault(vault());
  const prepared = await prepareTurnkeyHyperliquidExecution({
    credential,
    instruction: instruction(),
    cloid: "0x11111111111111111111111111111111",
    env: { GHOLA_PERPS_LOCAL_MOCK: "true" },
    marketContext: context(),
  });
  assert.equal(prepared.risk_decision.allowed, true);
  assert.equal(prepared.orders.length, 3);
  assert.equal(prepared.orders[1].r, true);
  assert.equal(prepared.orders[2].r, true);
});

test("rejects leverage escalation before any signer or exchange call", async () => {
  const credential = turnkeyHyperliquidCredentialFromVault(vault());
  let exchangeCalled = false;
  await assert.rejects(() => submitTurnkeyHyperliquidExecution({
    credential,
    instruction: instruction({ leverage: 5 }),
    cloid: "0x11111111111111111111111111111111",
    env: { GHOLA_PERPS_LOCAL_MOCK: "true" },
    marketContext: context(),
    exchangeFactory: () => {
      exchangeCalled = true;
      return {};
    },
  }), (error) => {
    assert.equal(error?.code, "pre_submit_failed");
    assert.match(error?.message || "", /leverage_changed/);
    return true;
  });
  assert.equal(exchangeCalled, false);
});

test("freezes a Turnkey transport failure after submission starts", async () => {
  const credential = await liveCredential();
  let orderCalls = 0;
  await assert.rejects(() => submitTurnkeyHyperliquidExecution({
    credential,
    instruction: instruction(),
    cloid: "0x11111111111111111111111111111111",
    env: {},
    marketContext: context(),
    exchangeFactory: () => ({
      order: async () => {
        orderCalls += 1;
        throw new Error("transport reset");
      },
    }),
  }), (error) => error?.code === "submission_ambiguous");
  assert.equal(orderCalls, 1);
});

test("freezes an incomplete Turnkey bracket acknowledgement without an untracked compensation submit", async () => {
  const credential = await liveCredential();
  let orderCalls = 0;
  await assert.rejects(() => submitTurnkeyHyperliquidExecution({
    credential,
    instruction: instruction(),
    cloid: "0x11111111111111111111111111111111",
    env: {},
    marketContext: context(),
    exchangeFactory: () => ({
      order: async () => {
        orderCalls += 1;
        return { response: { data: { statuses: [{ resting: { oid: 101 } }] } } };
      },
    }),
  }), (error) => error?.code === "submission_ambiguous");
  assert.equal(orderCalls, 1);
});

test("never claims a Turnkey order from malformed acknowledgements", async () => {
  const credential = await liveCredential();
  for (const statuses of [
    [{}, {}, {}],
    [null, null, null],
    ["waitingForFill", "waitingForTrigger", "waitingForTrigger"],
    [
      { resting: { oid: 101, cloid: "0x22222222222222222222222222222222" } },
      { resting: { oid: 102 } },
      { resting: { oid: 103 } },
    ],
    [
      { filled: { oid: 101, totalSz: "9".repeat(400), avgPx: "100" } },
      { resting: { oid: 102 } },
      { resting: { oid: 103 } },
    ],
  ]) {
    await assert.rejects(() => submitTurnkeyHyperliquidExecution({
      credential,
      instruction: instruction(),
      cloid: "0x11111111111111111111111111111111",
      env: {},
      marketContext: context(),
      exchangeFactory: () => ({
        order: async () => ({
          status: "ok",
          response: { type: "order", data: { statuses } },
        }),
      }),
    }), (error) => error?.code === "submission_ambiguous");
  }
});

test("accepts only explicit Turnkey order success shapes", async () => {
  const credential = await liveCredential();
  const result = await submitTurnkeyHyperliquidExecution({
    credential,
    instruction: instruction(),
    cloid: "0x11111111111111111111111111111111",
    env: {},
    marketContext: context(),
    exchangeFactory: () => ({
      order: async () => ({
        status: "ok",
        response: {
          type: "order",
          data: {
            statuses: [
              { resting: { oid: 101, cloid: "0x11111111111111111111111111111111" } },
              { resting: { oid: 102 } },
              { resting: { oid: 103 } },
            ],
          },
        },
      }),
    }),
  });
  assert.equal(result.status, "submitted");
  assert.equal(result.oid, 101);
});

test("never claims a Turnkey cancel when its post-broadcast acknowledgement is incomplete", async () => {
  const credential = await liveCredential();
  let cancelCalls = 0;
  await assert.rejects(() => submitTurnkeyHyperliquidExecution({
    credential,
    instruction: {
      operation_class: "cancel",
      cancel: {
        market: "BTC",
        client_order_id: "0x11111111111111111111111111111111",
      },
    },
    cloid: "0x22222222222222222222222222222222",
    env: {},
    marketContext: context({
      managed_open_order_ids: ["0x11111111111111111111111111111111"],
    }),
    exchangeFactory: () => ({
      cancelByCloid: async () => {
        cancelCalls += 1;
        return { response: { data: { statuses: [] } } };
      },
    }),
  }), (error) => error?.code === "submission_ambiguous");
  assert.equal(cancelCalls, 1);
});

test("never claims a Turnkey cancel from a malformed acknowledgement", async () => {
  const credential = await liveCredential();
  await assert.rejects(() => submitTurnkeyHyperliquidExecution({
    credential,
    instruction: {
      operation_class: "cancel",
      cancel: {
        market: "BTC",
        client_order_id: "0x11111111111111111111111111111111",
      },
    },
    cloid: "0x22222222222222222222222222222222",
    env: {},
    marketContext: context({
      managed_open_order_ids: ["0x11111111111111111111111111111111"],
    }),
    exchangeFactory: () => ({
      cancelByCloid: async () => ({
        status: "ok",
        response: { type: "cancel", data: { statuses: [{}] } },
      }),
    }),
  }), (error) => error?.code === "submission_ambiguous");
});

test("no-submit verification never asks the exchange to sign or broadcast", async () => {
  const credential = turnkeyHyperliquidCredentialFromVault(vault());
  const result = await verifyTurnkeyHyperliquidNoSubmit({
    credential,
    instruction: instruction(),
    cloid: "0x11111111111111111111111111111111",
    env: { GHOLA_PERPS_LOCAL_MOCK: "true" },
    marketContext: context(),
  });
  assert.equal(result.status, "verified_no_funds");
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.risk_decision.allowed, true);
});

test("kill switch still allows exact reduce-only exit", async () => {
  const credential = turnkeyHyperliquidCredentialFromVault(vault({ perps_mandate: mandate({ kill_switch: true }) }));
  const prepared = await prepareTurnkeyHyperliquidExecution({
    credential,
    instruction: instruction({
      side: "sell",
      quote_size: "20",
      reduce_only: true,
      protective_orders: {},
    }),
    cloid: "0x11111111111111111111111111111111",
    env: { GHOLA_PERPS_LOCAL_MOCK: "true" },
    marketContext: context({
      gross_exposure_micro_usdc: 20_000_000,
      position_notional_micro_usdc: { BTC: 20_000_000 },
    }),
  });
  assert.equal(prepared.operation, "reduce_only");
  assert.equal(prepared.risk_decision.allowed, true);
  assert.equal(prepared.orders[0].r, true);
});
