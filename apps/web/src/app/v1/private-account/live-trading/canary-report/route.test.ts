import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { POST } from "./route";

const TOKEN = "test-live-canary-token";

function request(body: Record<string, unknown>) {
  return new Request("https://ghola.test/v1/private-account/live-trading/canary-report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ghola-internal-token": TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function greenBody() {
  return {
    report_id: "canary_hyperliquid_round_trip_test",
    venue_id: "hyperliquid",
    network: "mainnet",
    status: "green",
    live_mode: "full_ticket",
    canary_kind: "full_ticket_broadcast",
    broadcast_performed: true,
    reconcile_status: "reconciled",
    order_notional_usd: 11,
    max_order_notional_usd: 1000,
    daily_cap_usd: 5000,
    max_slippage_bps: 50,
    receipt_commitment: "receipt_close_test",
    result_commitment: "result_close_test",
    entry_receipt_commitment: "receipt_entry_test",
    close_receipt_commitment: "receipt_close_test",
    final_venue_execution_proven: true,
    final_fill_proven: true,
    position_count: 0,
    open_order_count: 0,
    observed_at: new Date().toISOString(),
  };
}

describe("live-trading canary report", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = TOKEN;
  });

  afterEach(async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    await resetPrivateAccountStoreForTests();
  });

  it("rejects green without a proven close and flat venue state", async () => {
    const response = await POST(request({
      ...greenBody(),
      close_receipt_commitment: null,
      final_venue_execution_proven: false,
      position_count: 1,
      open_order_count: 1,
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.reason_codes).toEqual(expect.arrayContaining([
      "close_receipt_commitment_required",
      "final_venue_execution_proof_required",
      "flat_position_required",
      "zero_open_orders_required",
    ]));
  });

  it("accepts an entry plus close proof ending flat with zero open orders", async () => {
    const response = await POST(request(greenBody()));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.report.position_count).toBe(0);
    expect(body.report.open_order_count).toBe(0);
    expect(body.report.final_venue_execution_proven).toBe(true);
    expect(body.report.close_receipt_commitment).toBe("receipt_close_test");
  });
});
