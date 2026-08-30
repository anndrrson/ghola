import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCarryPositions } from "@/lib/private-account-client";
import { CarryPositionRail, selectCarryPositionRecord, type CarryPositionRailRecord } from "./CarryPositionRail";

vi.mock("@/lib/private-account-client", () => ({
  listCarryPositions: vi.fn(),
}));

vi.mock("@/lib/thumper-auth-context", () => ({
  useThumperAuth: () => ({
    authenticated: true,
    loading: false,
    user: { id: "user_test" },
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CarryPositionRail", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(listCarryPositions).mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps one authoritative Carry Position visible without a scanner candidate", async () => {
    vi.mocked(listCarryPositions).mockResolvedValue({ ok: true, records: [positionRecord()] });

    await act(async () => {
      root.render(<CarryPositionRail />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const rail = container.querySelector('[aria-label="Carry position"]');
    expect(rail?.getAttribute("data-sync-state")).toBe("ready");
    expect(rail?.getAttribute("data-position-status")).toBe("active");
    expect(rail?.textContent).toContain("BTC-PERP");
    expect(rail?.textContent).toContain("L LIGHTER / S HYPERLIQUID");
    expect(rail?.textContent).toContain("$25.0/LEG");
    expect(rail?.textContent).toContain("MODEL NET$3.50");
    expect(rail?.textContent).toContain("REAL NET$1.25");
    expect(rail?.textContent).toContain("RUNWAY1.0H MIN");
  });

  it("prioritizes a live position over a newer flat record", () => {
    const active = positionRecord({ status: "active", updated_at: "2026-08-30T10:00:00.000Z" });
    const flat = positionRecord({
      position_id: "carry:position:flat",
      status: "reconciled",
      updated_at: "2026-08-30T11:00:00.000Z",
    });
    expect(selectCarryPositionRecord([flat, active])?.position.position_id).toBe("carry:position:test");
  });

  it("never hides a manual-intervention position behind an active or flat record", () => {
    const active = positionRecord({ status: "active", updated_at: "2026-08-30T11:00:00.000Z" });
    const flat = positionRecord({
      position_id: "carry:position:flat",
      status: "reconciled",
      updated_at: "2026-08-30T12:00:00.000Z",
    });
    const manual = positionRecord({
      position_id: "carry:position:manual",
      status: "manual_intervention",
      updated_at: "2026-08-30T10:00:00.000Z",
    });
    expect(selectCarryPositionRecord([active, flat, manual])?.position.position_id)
      .toBe("carry:position:manual");
  });
});

function positionRecord(overrides: {
  position_id?: string;
  status?: string;
  updated_at?: string;
} = {}): CarryPositionRailRecord {
  return {
    updated_at: overrides.updated_at || new Date().toISOString(),
    position: {
      position_id: overrides.position_id || "carry:position:test",
      asset: "BTC",
      long_venue_id: "lighter",
      short_venue_id: "hyperliquid",
      target_notional_micro_usdc: 25_000_000,
      status: overrides.status || "active",
      next_actions: ["monitor"],
    },
    value_ledger: {
      modeled: { net_value_micro_usdc: 3_500_000 },
      realized: { net_value_micro_usdc: 1_250_000 },
    },
    latest_observation: {
      expected_net_value_bps: 14,
      margin_runway_ms_by_venue: {
        lighter: 3_600_000,
        hyperliquid: 7_200_000,
      },
      margin_runway_status_by_venue: {
        lighter: "warning",
        hyperliquid: "healthy",
      },
      recorded_at_ms: Date.now(),
    },
  };
}
