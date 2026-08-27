import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarryChartStrip } from "./CarryChartStrip";
import type { CarryShadowResponse, CarryShadowSnapshot } from "@/lib/carry-market";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CarryChartStrip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("offers compact Carry setup and preserves the terminal return when routes are unavailable", async () => {
    await act(async () => {
      root.render(<CarryChartStrip asset="BTC" defaultOpen onAssetSelect={vi.fn()} />);
      await Promise.resolve();
    });

    const link = [...container.querySelectorAll("a")].find((item) => item.textContent?.includes("SET UP CARRY"));
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toContain("setup=carry");
    expect(decodeURIComponent(link?.getAttribute("href") || "")).toContain(
      "/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open",
    );
  });

  it("separates observed gross spread from unavailable net economics", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 100_000_000, { taker_fee_bps: null }),
    ]));

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-route-qualified")).toBe("false");
    expect(rail?.getAttribute("data-cost-basis")).toBe("gross-only");
    expect(rail?.textContent).toContain("GROSS");
    expect(rail?.textContent).toContain("NET24H—");
    expect(rail?.textContent).not.toContain("DATA");
    expect(rail?.textContent).not.toContain("QUAL");
  });

  it("marks only an exact positive-net route as qualified", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 100_000_000),
    ]));

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-route-qualified")).toBe("true");
    expect(rail?.getAttribute("data-cost-basis")).toBe("net");
    expect(rail?.textContent).toContain("GROSS");
    expect(rail?.textContent).toContain("NET24H+");
  });

  it("shows negative net value without qualifying the route", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 20_000_000),
    ]));

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-route-qualified")).toBe("false");
    expect(rail?.textContent).toContain("NET24H−");
  });

  async function renderShadow(body: CarryShadowResponse) {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => body,
    } as Response);
    await act(async () => {
      root.render(<CarryChartStrip asset="BTC" onAssetSelect={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function shadowResponse(snapshots: CarryShadowSnapshot[]): CarryShadowResponse {
  return {
    version: 1,
    mode: "shadow_read_only",
    executable: false,
    observed_at: new Date().toISOString(),
    venues: snapshots.map((item) => ({ venue_id: item.venue_id, ok: true, snapshots: [item] })),
  };
}

function snapshot(
  venueId: string,
  fundingRate: number,
  overrides: Partial<CarryShadowSnapshot> = {},
): CarryShadowSnapshot {
  return {
    venue_id: venueId,
    contract_id: `${venueId}:BTC`,
    economic_equivalence_id: "carry:BTC-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: "USDC",
    collateral_asset: "USDC",
    contract_type: "linear_perp",
    status: "ready",
    stale: false,
    funding_rate_e12_per_interval: fundingRate,
    funding_interval_ms: 3_600_000,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    minimum_notional_micro_usdc: 10_000_000,
    initial_margin_bps: 500,
    maintenance_margin_bps: 250,
    mark_price_e8: 6_000_000_000_000,
    index_price_e8: 6_000_000_000_000,
    best_bid_e8: 5_999_900_000_000,
    best_ask_e8: 6_000_100_000_000,
    depth_bids: [{ price_e8: 5_999_900_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 6_000_100_000_000, size_e8: 100_000_000 }],
    depth_observed_at_ms: Date.now(),
    as_of_ms: Date.now(),
    observed_at_ms: Date.now(),
    missing_fields: [],
    ...overrides,
  };
}
