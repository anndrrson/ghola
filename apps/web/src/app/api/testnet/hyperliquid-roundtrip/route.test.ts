import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUNDED_TESTNET_CONFIRMATION,
  createFundedTestnetRoundTripPost,
} from "./_handler";

const ORIGINAL_ENV = { ...process.env };
const CONFIRMATION = "RUN_FUNDED_HYPERLIQUID_TESTNET_ROUND_TRIP";

function enable() {
  process.env.GHOLA_HYPERLIQUID_FUNDED_TESTNET_UI_ENABLED = "true";
  process.env.GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_CONFIRM = FUNDED_TESTNET_CONFIRMATION;
  process.env.PRIVATE_AGENT_TEST_POSTGRES_URL = "postgresql://localhost/ghola_test";
  process.env.GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS = `0x${"1".repeat(40)}`;
  process.env.GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY = `0x${"2".repeat(64)}`;
}

function request(options: { origin?: string; body?: unknown; contentType?: string } = {}) {
  return new NextRequest("http://localhost:3100/api/testnet/hyperliquid-roundtrip", {
    method: "POST",
    headers: {
      origin: options.origin ?? "http://localhost:3100",
      "content-type": options.contentType ?? "application/json",
    },
    body: JSON.stringify(options.body ?? { confirmation: CONFIRMATION }),
  });
}

function report() {
  return {
    ok: true,
    network: "testnet",
    market: "HYPE",
    notional_usd: 11,
    claim_store: "postgres",
    entry_status: "filled",
    entry_fill_proven: true,
    duplicate_entry_prevented: true,
    opened_position_verified: true,
    exit_status: "filled",
    exit_fill_proven: true,
    duplicate_exit_prevented: true,
    flat_after_exit: true,
    open_orders_after_exit: 0,
    stored_receipt_replayed: true,
    entry_work_order_commitment: "hl_testnet_roundtrip_entry_mtest_123456789abc",
    exit_work_order_commitment: "hl_testnet_roundtrip_exit_mtest_123456789abc",
    completed_at: "2026-08-14T12:00:00.000Z",
  };
}

describe("funded Hyperliquid testnet round-trip route", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GHOLA_HYPERLIQUID_FUNDED_TESTNET_UI_ENABLED;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("is absent unless every local funded-testnet guard is armed", async () => {
    const runRoundTrip = vi.fn();
    const handler = createFundedTestnetRoundTripPost({ runRoundTrip });

    const response = await handler(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "funded_testnet_round_trip_unavailable" });
    expect(runRoundTrip).not.toHaveBeenCalled();
  });

  it("rejects cross-site and non-exact confirmations before execution", async () => {
    enable();
    const runRoundTrip = vi.fn();
    const handler = createFundedTestnetRoundTripPost({ runRoundTrip });

    const crossSite = await handler(request({ origin: "https://attacker.example" }));
    const wrongConfirmation = await handler(request({ body: { confirmation: "yes" } }));

    expect(crossSite.status).toBe(403);
    expect(wrongConfirmation.status).toBe(400);
    expect(runRoundTrip).not.toHaveBeenCalled();
  });

  it("returns only a fully proven Postgres testnet round trip", async () => {
    enable();
    const runRoundTrip = vi.fn().mockResolvedValue(report());
    const handler = createFundedTestnetRoundTripPost({ runRoundTrip });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(report());
    expect(runRoundTrip).toHaveBeenCalledTimes(1);
  });

  it("rejects an incomplete or non-flat runner report", async () => {
    enable();
    const runRoundTrip = vi.fn().mockResolvedValue({ ...report(), flat_after_exit: false });
    const handler = createFundedTestnetRoundTripPost({ runRoundTrip });

    const response = await handler(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "funded_testnet_round_trip_failed" });
  });

  it("allows only one funded round trip at a time", async () => {
    enable();
    let finish!: (value: unknown) => void;
    const runRoundTrip = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const handler = createFundedTestnetRoundTripPost({ runRoundTrip });

    const first = handler(request());
    await vi.waitFor(() => expect(runRoundTrip).toHaveBeenCalledTimes(1));
    const second = await handler(request());
    finish(report());

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "funded_testnet_round_trip_already_running" });
    expect((await first).status).toBe(200);
  });
});
