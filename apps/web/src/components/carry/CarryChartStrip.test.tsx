import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarryChartStrip, carryRouteQuoteParameters } from "./CarryChartStrip";
import type { CarryShadowResponse, CarryShadowSnapshot } from "@/lib/carry-market";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("next/dynamic", () => ({
  default: () => function MockCarryTerminalBuilder({
    quoteNotional,
    quoteHorizonDays,
    onQuoteNotionalChange,
    onQuoteHorizonDaysChange,
  }: {
    quoteNotional?: string;
    quoteHorizonDays?: string;
    onQuoteNotionalChange?: (value: string) => void;
    onQuoteHorizonDaysChange?: (value: string) => void;
  }) {
    return (
      <div aria-label="Carry position builder">
        <input
          aria-label="Carry notional per leg"
          value={quoteNotional ?? ""}
          onChange={(event) => onQuoteNotionalChange?.(event.target.value)}
        />
        <input
          aria-label="Carry horizon in days"
          value={quoteHorizonDays ?? ""}
          onChange={(event) => onQuoteHorizonDaysChange?.(event.target.value)}
        />
      </div>
    );
  },
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

  it("shows an honest loading state before live routes arrive", async () => {
    vi.mocked(fetch).mockReturnValue(new Promise<Response>(() => undefined));
    await act(async () => {
      root.render(<CarryChartStrip asset="BTC" defaultOpen onAssetSelect={vi.fn()} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("LOADING LIVE ROUTES");
    expect(container.textContent).toContain("Checking live market qualification…");
    expect(container.textContent).toContain("Loading live cross-venue routes…");
    expect(container.textContent).not.toContain("has not started");
    expect(container.textContent).not.toContain("No fresh cross-venue quote pair");
  });

  it("uses one quote horizon for route ranking and displayed net sign", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 10_000_001),
    ]), true);

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(carryRouteQuoteParameters("11", "30")).toEqual({ notionalUsd: 11, horizonHours: 720 });
    expect(rail?.getAttribute("data-ranking-notional-usd")).toBe("11");
    expect(rail?.getAttribute("data-ranking-horizon-hours")).toBe("720");
    expect(rail?.textContent).toContain("NET/30D*−");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Carry horizon in days"]')?.value).toBe("30");

    await setInput(container.querySelector<HTMLInputElement>('[aria-label="Carry horizon in days"]'), "1");

    expect(rail?.getAttribute("data-ranking-horizon-hours")).toBe("24");
    expect(rail?.textContent).toContain("NET/1D*−");
  });

  it("separates observed gross spread from unavailable net economics", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 100_000_000, { taker_fee_bps: null }),
    ]));

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-modeled-net-positive")).toBe("false");
    expect(rail?.getAttribute("data-edge-evidence")).toBe("indicative");
    expect(rail?.getAttribute("data-cost-basis")).toBe("gross-only");
    expect(rail?.textContent).toContain("GROSS");
    expect(rail?.textContent).toContain("NET/30D*—");
    expect(rail?.textContent).not.toContain("DATA");
    expect(rail?.textContent).not.toContain("QUAL");
  });

  it("marks an exact point-in-time model as indicative net positive", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 150_000_000),
    ]));

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-modeled-net-positive")).toBe("true");
    expect(rail?.getAttribute("data-cost-basis")).toBe("net");
    expect(rail?.textContent).toContain("GROSS");
    expect(rail?.textContent).toContain("NET/30D*+");
  });

  it("shows modeled routing edge without presenting it as realized P&L", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 40_000_000),
      snapshot("lighter", 10_000_000),
      snapshot("aster", 150_000_000),
    ]), true);

    const edge = [...container.querySelectorAll("span")].find((item) => item.textContent?.includes("EDGE*"));
    expect(edge?.textContent).toContain("EDGE* +");
    expect(edge?.getAttribute("title")).toContain("modeled net versus");
    expect(edge?.getAttribute("title")).toContain("not realized P&L");
  });

  it("upgrades modeled edge only when worker evidence matches the selected route", async () => {
    const body = shadowResponse([
      snapshot("hyperliquid", 40_000_000),
      snapshot("lighter", 10_000_000),
      snapshot("aster", 150_000_000),
    ]);
    body.shadow_qualification = marketQualification();
    body.funding_persistence = routingFundingPersistence();
    body.routing_advantage = routingAdvantageSummary(Date.parse(body.observed_at));
    await renderShadow(body, true);

    expect(container.querySelector('[aria-label="Cross-venue route intelligence"]')
      ?.getAttribute("data-routing-evidence")).not.toBe("committed");
    await setInput(container.querySelector<HTMLInputElement>('[aria-label="Carry notional per leg"]'), "10000");
    await setInput(container.querySelector<HTMLInputElement>('[aria-label="Carry horizon in days"]'), "1");

    const edge = [...container.querySelectorAll("span")].find((item) => item.textContent?.includes("EDGE✓"));
    expect(container.querySelector('[aria-label="Cross-venue route intelligence"]')
      ?.getAttribute("data-routing-evidence")).toBe("committed");
    expect(container.querySelector('[aria-label="Cross-venue route intelligence"]')
      ?.getAttribute("data-net-evidence")).toBe("committed");
    expect(container.querySelector('[aria-label="Cross-venue route intelligence"]')
      ?.firstElementChild?.textContent).toContain("NET/1D✓+3.50BP/D");
    expect(edge?.textContent).toContain("EDGE✓ +");
    expect(edge?.getAttribute("title")).toContain("worker-committed modeled net");
    expect(edge?.getAttribute("title")).toContain("excludes the account fee tier");
    expect(edge?.getAttribute("title")).toContain("not realized P&L");
  });

  it("defaults to the worker-committed route when the live ranking points elsewhere", async () => {
    const body = shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 40_000_000),
      snapshot("aster", 150_000_000),
    ]);
    body.shadow_qualification = marketQualification();
    body.funding_persistence = routingFundingPersistence();
    body.routing_advantage = routingAdvantageSummary(Date.parse(body.observed_at));
    await renderShadow(body, true);

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Carry execution route"]')?.value)
      .toBe("BTC:lighter:aster");
    expect(rail?.firstElementChild?.textContent).toContain("L LIGHTER/S ASTER");
    expect(rail?.getAttribute("data-edge-evidence")).toBe("durable");
    expect(rail?.getAttribute("data-routing-evidence")).toBe("indicative");
    expect(rail?.textContent).toContain("EDGE*");
    expect(rail?.textContent).not.toContain("EVID FAIL");
    expect(rail?.textContent).not.toContain("EDGE!");
  });

  it("keeps the primary rail aligned with the executable builder route", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("aster", 100_000_000),
      snapshot("edgex", 200_000_000),
    ]), true);

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    const primary = rail?.firstElementChild?.textContent || "";
    expect(rail?.getAttribute("data-route-mode")).toBe("execution");
    expect(primary).toContain("EXEC");
    expect(primary).toContain("HYPERLIQUID");
    expect(primary).toContain("ASTER");
    expect(primary).not.toContain("EDGEX");
  });

  it("labels a five-venue opportunity as shadow when no execution adapter is qualified", async () => {
    await renderShadow(shadowResponse([
      snapshot("edgex", 10_000_000),
      snapshot("dydx", 150_000_000),
    ]));

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-route-mode")).toBe("shadow");
    expect(rail?.firstElementChild?.textContent).toContain("SHADOW");
    expect(container.querySelector('[aria-label="Carry position builder"]')).toBeNull();
  });

  it("restores only an exact currently qualified execution route", async () => {
    const body = shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("aster", 100_000_000),
      snapshot("lighter", 150_000_000),
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => body } as Response);
    await act(async () => {
      root.render(
        <CarryChartStrip
          asset="BTC"
          defaultOpen
          preferredLongVenue="hyperliquid"
          preferredShortVenue="aster"
          onAssetSelect={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const route = container.querySelector<HTMLSelectElement>('[aria-label="Carry execution route"]');
    expect(route?.value).toBe("BTC:hyperliquid:aster");
  });

  it("never substitutes another route when the requested pair is stale", async () => {
    const staleAt = Date.now() - 31_000;
    const body = shadowResponse([
      snapshot("hyperliquid", 10_000_000, {
        as_of_ms: staleAt,
        observed_at_ms: staleAt,
        depth_observed_at_ms: staleAt,
      }),
      snapshot("aster", 100_000_000),
      snapshot("lighter", 150_000_000),
    ]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => body } as Response);
    await act(async () => {
      root.render(
        <CarryChartStrip
          asset="BTC"
          defaultOpen
          preferredLongVenue="hyperliquid"
          preferredShortVenue="aster"
          onAssetSelect={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="Carry position builder"]')).toBeNull();
    expect(container.querySelector('[aria-label="Cross-venue route intelligence"]')?.getAttribute("data-route-mode")).toBe("none");
    expect(container.textContent).toContain("SELECTED ROUTE STALE OR UNAVAILABLE · NO CHECK STARTED");
    expect(container.textContent).toContain("USE CURRENT QUALIFIED ROUTE");
  });

  it("quarantines aged quotes from both display and execution", async () => {
    const staleAt = Date.now() - 31_000;
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000, { as_of_ms: staleAt, observed_at_ms: staleAt }),
      snapshot("lighter", 150_000_000, { as_of_ms: staleAt, observed_at_ms: staleAt }),
    ]), true);

    expect(container.textContent).toContain("NO FRESH ROUTE");
    expect(container.querySelector('[aria-label="Carry position builder"]')).toBeNull();
  });

  it("shows negative net value without qualifying the route", async () => {
    await renderShadow(shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 10_000_001),
    ]));

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-modeled-net-positive")).toBe("false");
    expect(rail?.textContent).toContain("NET/30D*−");
  });

  it("shows only commitment-backed worker history as durable route evidence", async () => {
    const body = shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 150_000_000),
    ]);
    body.funding_persistence = fundingPersistence({
      ready: true,
      sample_count: 8,
      minimum_samples: 8,
      observed_span_ms: 35 * 60_000,
      minimum_span_ms: 30 * 60_000,
      conservative_hourly_spread_e12: 100_000_000,
      evidence_commitment: `carry:funding:${"a".repeat(64)}`,
    });
    await renderShadow(body, true);

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-edge-evidence")).toBe("durable");
    expect(rail?.textContent).toContain("EVID 8/8");
  });

  it("fails closed when a ready funding claim lacks a worker commitment", async () => {
    const body = shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 150_000_000),
    ]);
    body.funding_persistence = fundingPersistence({
      ready: true,
      sample_count: 8,
      minimum_samples: 8,
      observed_span_ms: 35 * 60_000,
      minimum_span_ms: 30 * 60_000,
      conservative_hourly_spread_e12: 100_000_000,
      evidence_commitment: null,
    });
    await renderShadow(body, true);

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-edge-evidence")).toBe("rejected");
    expect(rail?.textContent).toContain("EVID FAIL");
  });

  it("shows durable funding observation progress without claiming readiness", async () => {
    const body = shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 150_000_000),
    ]);
    body.funding_persistence = fundingPersistence({
      sample_count: 2,
      minimum_samples: 8,
      observed_span_ms: 5 * 60_000,
      minimum_span_ms: 30 * 60_000,
      reasons: ["funding_history_insufficient", "funding_observation_span_insufficient"],
    });
    await renderShadow(body);

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-edge-evidence")).toBe("observing");
    expect(rail?.textContent).toContain("EVID 2/8");
  });

  it("shows compact worker-bound five-venue market evidence", async () => {
    const body = shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 150_000_000),
    ]);
    body.shadow_qualification = marketQualification();
    await renderShadow(body, true);

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-market-evidence")).toBe("ready");
    expect(rail?.textContent).toContain("MKT5V 3/3");
  });

  it("fails closed when five-venue market readiness is not release-bound", async () => {
    const body = shadowResponse([
      snapshot("hyperliquid", 10_000_000),
      snapshot("lighter", 150_000_000),
    ]);
    body.shadow_qualification = marketQualification({ release_bound: false });
    await renderShadow(body, true);

    const rail = container.querySelector('[aria-label="Cross-venue route intelligence"]');
    expect(rail?.getAttribute("data-market-evidence")).toBe("rejected");
    expect(rail?.textContent).toContain("MKTFAIL");
  });

  async function renderShadow(body: CarryShadowResponse, defaultOpen = false) {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => body,
    } as Response);
    await act(async () => {
      root.render(<CarryChartStrip asset="BTC" defaultOpen={defaultOpen} onAssetSelect={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function setInput(input: HTMLInputElement | null, value: string) {
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
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

function fundingPersistence(route: Partial<NonNullable<CarryShadowResponse["funding_persistence"]>["routes"][number]>) {
  return {
    version: 1 as const,
    transaction_broadcast: false as const,
    observed_route_count: 1,
    ready_route_count: route.ready ? 1 : 0,
    routes: [{
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "lighter",
      ready: false,
      reasons: [],
      sample_count: 0,
      minimum_samples: 8,
      observed_span_ms: 0,
      minimum_span_ms: 30 * 60_000,
      conservative_hourly_spread_e12: null,
      evidence_commitment: null,
      ...route,
    }],
  };
}

function marketQualification(
  overrides: Partial<NonNullable<CarryShadowResponse["shadow_qualification"]>> = {},
): NonNullable<CarryShadowResponse["shadow_qualification"]> {
  return {
    version: 1,
    kind: "carry_shadow_qualification",
    ready: true,
    release_bound: true,
    transaction_broadcast: false,
    image_digest: `sha256:${"1".repeat(64)}`,
    checked_at_ms: Date.now(),
    required_samples: 3,
    completed_samples: 3,
    venues: 5,
    assets: 3,
    requested_assets: ["BTC", "ETH", "SOL"],
    minimum_span_ms: 120_000,
    duration_ms: 120_000,
    expected_snapshots_per_sample: 15,
    sample_commitments: ["2", "3", "4"].map((value) => `carry:shadow:sample:${value.repeat(64)}`),
    source_observation_commitments: ["6", "7", "8"].map((value) => `carry:shadow:sources:${value.repeat(64)}`),
    evidence_commitment: `carry:shadow:qualification:${"5".repeat(64)}`,
    failures: [],
    ...overrides,
  };
}

function routingAdvantageSummary(observedAtMs: number): NonNullable<CarryShadowResponse["routing_advantage"]> {
  return {
    version: 2,
    kind: "carry_routing_advantage",
    ready: true,
    failures: [],
    benchmark_kind: "next_best_executable_route",
    execution_venue_ids: ["hyperliquid", "lighter", "aster"],
    requested_assets: ["BTC"],
    notional_micro_usdc: 10_000_000_000,
    horizon_ms: 86_400_000,
    modeled: true,
    realized: false,
    account_fee_tier_included: false,
    execution_ready: false,
    transaction_broadcast: false,
    shadow_qualification_commitment: `carry:shadow:qualification:${"5".repeat(64)}`,
    observer_image_digest: `sha256:${"1".repeat(64)}`,
    observed_at_ms: observedAtMs,
    evidence_commitment: `carry:routing:advantage:${"6".repeat(64)}`,
    routes: [{
      asset: "BTC",
      status: "advantaged",
      selected_route: { long_venue_id: "lighter", short_venue_id: "aster" },
      baseline_route: { long_venue_id: "hyperliquid", short_venue_id: "aster" },
      selected_modeled_net_micro_usdc_per_day: 3_500_000,
      baseline_modeled_net_micro_usdc_per_day: 2_250_000,
      daily_net_advantage_micro_usdc: 1_250_000,
      daily_net_advantage_e6_bps: 1_250_000,
      sample_count: 8,
      minimum_samples: 8,
      observed_span_ms: 35 * 60_000,
      minimum_span_ms: 30 * 60_000,
      selected_value: {
        benchmark_kind: "no_trade",
        selected_route: { long_venue_id: "lighter", short_venue_id: "aster" },
        modeled_net_micro_usdc_per_day: 3_500_000,
        modeled_net_e6_bps_per_day: 3_500_000,
        sample_count: 8,
        minimum_samples: 8,
        observed_span_ms: 35 * 60_000,
        minimum_span_ms: 30 * 60_000,
        funding_evidence_commitment: `carry:funding:${"a".repeat(64)}`,
        ready: true,
        reasons: [],
      },
      funding_evidence_commitments: [
        `carry:funding:${"a".repeat(64)}`,
        `carry:funding:${"b".repeat(64)}`,
      ],
      ready: true,
      reasons: [],
    }],
  };
}

function routingFundingPersistence(): NonNullable<CarryShadowResponse["funding_persistence"]> {
  return {
    version: 1,
    transaction_broadcast: false,
    observed_route_count: 2,
    ready_route_count: 2,
    routes: ["a", "b"].map((suffix, index) => ({
      asset: "BTC",
      long_venue_id: index === 0 ? "lighter" : "hyperliquid",
      short_venue_id: "aster",
      ready: true,
      reasons: [],
      sample_count: 8,
      minimum_samples: 8,
      observed_span_ms: 35 * 60_000,
      minimum_span_ms: 30 * 60_000,
      conservative_hourly_spread_e12: 1,
      evidence_commitment: `carry:funding:${suffix.repeat(64)}`,
    })),
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
