import { describe, expect, it } from "vitest";
import {
  ingestTerminalLiveAccountOrderEvent,
  TERMINAL_LIVE_ACCOUNT_EVENT_LIMIT,
} from "./terminal-live-account-events";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("terminal live account events", () => {
  it("normalizes, newest-sorts, dedupes, and caps lifecycle updates", () => {
    let events = [] as ReturnType<typeof ingestTerminalLiveAccountOrderEvent>;
    for (let index = 0; index < TERMINAL_LIVE_ACCOUNT_EVENT_LIMIT + 3; index += 1) {
      events = ingestTerminalLiveAccountOrderEvent(events, batch(index), NOW + index);
    }
    expect(events).toHaveLength(TERMINAL_LIVE_ACCOUNT_EVENT_LIMIT);
    expect(events[0]).toMatchObject({ market: "COIN22", status: "canceled" });
    expect(events.at(-1)?.market).toBe("COIN3");
    expect(ingestTerminalLiveAccountOrderEvent(events, batch(22), NOW + 50)).toHaveLength(TERMINAL_LIVE_ACCOUNT_EVENT_LIMIT);
  });

  it("rejects malformed, oversized, and future batches without changing history", () => {
    const current = ingestTerminalLiveAccountOrderEvent([], batch(1), NOW);
    const invalid = [
      null,
      { ...batch(2), type: "funding_update" },
      { ...batch(2), updated_at: new Date(NOW + 30_001).toISOString() },
      { ...batch(2), updates: Array.from({ length: 9 }, () => batch(2).updates[0]) },
      { ...batch(2), updates: [{ ...batch(2).updates[0], order_handle_commitment: "raw id" }] },
      { ...batch(2), updates: [{ ...batch(2).updates[0], price_bucket: "$exact" }] },
      { ...batch(2), updates: [{ ...batch(2).updates[0], time_bucket: new Date(NOW + 30_001).toISOString() }] },
    ];
    for (const value of invalid) expect(ingestTerminalLiveAccountOrderEvent(current, value, NOW)).toBe(current);
  });

  it("never lets delayed lifecycle events regress a newer order state", () => {
    const submitted = eventBatch({ status: "open", timeMs: NOW - 20_000 });
    const canceled = eventBatch({ status: "canceled", timeMs: NOW - 10_000 });
    const current = ingestTerminalLiveAccountOrderEvent([], canceled, NOW);
    const delayed = ingestTerminalLiveAccountOrderEvent(current, submitted, NOW + 1_000);

    expect(delayed).toHaveLength(2);
    expect(delayed[0]?.status).toBe("canceled");
    expect(delayed[1]?.status).toBe("open");
  });

  it("preserves distinct same-time transitions and orders later receipts first", () => {
    const open = eventBatch({ status: "open", timeMs: NOW - 10_000 });
    const current = ingestTerminalLiveAccountOrderEvent([], open, NOW);
    const canceled = ingestTerminalLiveAccountOrderEvent(
      current,
      eventBatch({ status: "canceled", timeMs: NOW - 10_000 }),
      NOW + 1,
    );
    expect(canceled[0]?.status).toBe("canceled");

    const collision = ingestTerminalLiveAccountOrderEvent(
      canceled,
      eventBatch({ status: "open", timeMs: NOW - 10_000 }),
      NOW + 1,
    );
    expect(collision.map((event) => event.status)).toEqual(["canceled", "open"]);
  });

  it("selects the newest lifecycle update when one batch repeats an order", () => {
    const older = eventBatch({ status: "open", timeMs: NOW - 20_000 }).updates[0];
    const newer = eventBatch({ status: "filled", timeMs: NOW - 10_000 }).updates[0];
    const result = ingestTerminalLiveAccountOrderEvent([], {
      type: "order_update",
      updated_at: new Date(NOW).toISOString(),
      updates: [older, newer],
    }, NOW);
    expect(result).toHaveLength(2);
    expect(result[0]?.status).toBe("filled");
  });
});

function eventBatch({ status, timeMs }: { status: string; timeMs: number }) {
  return {
    type: "order_update",
    updated_at: new Date(NOW).toISOString(),
    updates: [{
      order_handle_commitment: "order_commitment_shared",
      market: "BTC",
      status,
      side: "sell",
      size_bucket: "0.1-1",
      price_bucket: "10k+",
      time_bucket: new Date(timeMs).toISOString(),
    }],
  };
}

function batch(index: number) {
  return {
    type: "order_update",
    updated_at: new Date(NOW).toISOString(),
    updates: [{
      order_handle_commitment: `order_commitment_${String(index).padStart(3, "0")}`,
      market: `COIN${index}`,
      status: "canceled",
      side: "sell",
      size_bucket: "0.1-1",
      price_bucket: "100-1k",
      time_bucket: new Date(NOW - 10_000 + index).toISOString(),
    }],
  };
}
