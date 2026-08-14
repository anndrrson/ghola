import { act, createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRouteCandidate, TerminalRouteDecision } from "@/lib/terminal-route-decision";
import type { TerminalRouteImprovement } from "@/lib/terminal-route-alert";
import {
  emptyTerminalRouteCostPolicy,
  deriveTerminalAllInRouteModel,
  inspectTerminalRouteCostPolicy,
  serializeTerminalRouteCostPolicy,
  terminalRouteCostPolicyStorageKey,
  TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS,
  updateTerminalRouteCostPolicy,
} from "@/lib/terminal-route-cost-policy";
import { useTerminalRouteCostPolicy } from "@/lib/use-terminal-route-cost-policy";
import { TerminalRouteMatrix, type TerminalRouteMatrixProps } from "./TerminalRouteMatrix";

describe("TerminalRouteMatrix staging", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("stages the certified best peer without exposing an execution action", () => {
    const onStageCandidate = vi.fn();
    act(() => root.render(routeMatrix({
      decision: decision(),
      improvement: improvement(),
      selectedVenue: "hyperliquid",
      persistenceScope: "device_guest",
      onStageCandidate,
    })));

    click(buttonNamed(container, "Stage best route"));
    expect(onStageCandidate).toHaveBeenCalledWith(expect.objectContaining({ venue: "phoenix", rank: 1 }));
    expect(container.textContent).toContain("never previews or submits");
    expect(container.textContent).toContain("PHOENIX has $0.10 / +10.00 bp price advantage versus HYPERLIQUID");
    expect(container.textContent).not.toMatch(/execute|submit order/iu);
  });

  it("cannot restage the selected venue or stage a no-fill candidate", () => {
    const noFill = candidate({ venue: "coinbase", rank: 3, status: "none", fillPct: 0 });
    const value = decision({ candidates: [candidate({ venue: "hyperliquid", rank: 1 }), noFill] });
    act(() => root.render(routeMatrix({
      decision: value,
      improvement: null,
      selectedVenue: "hyperliquid",
      persistenceScope: "device_guest",
      onStageCandidate: vi.fn(),
    })));

    expect(buttonNamed(container, "Selected").disabled).toBe(true);
    expect(buttonNamed(container, "No fill").disabled).toBe(true);
  });

  it("explains every excluded route instead of hiding fail-closed diagnostics", () => {
    act(() => root.render(routeMatrix({
      decision: decision({
        candidates: [],
        best: null,
        status: "unavailable",
        exclusions: [
          { venue: "hyperliquid", product: "BTC-PERP", code: "route_visible_book_timestamp_invalid" },
          { venue: "coinbase", product: "BTC-USD", code: "route_product_class_mismatch" },
          { venue: "phoenix", product: "BTC-PERP", code: "route_product_class_mismatch" },
        ],
      }),
      improvement: null,
      selectedVenue: "hyperliquid",
      persistenceScope: "device_guest",
      onStageCandidate: vi.fn(),
    })));

    expect(container.textContent).toContain("Excluded: 1 book clock missing · 2 spot/perpetual mismatch.");
  });

  it("can stop only the on-demand peer-feed lifecycle", () => {
    const onStopPeerFeeds = vi.fn();
    act(() => root.render(routeMatrix({
      decision: decision(),
      improvement: improvement(),
      selectedVenue: "hyperliquid",
      persistenceScope: "device_guest",
      onStageCandidate: vi.fn(),
      onStopPeerFeeds,
    })));

    expect(container.querySelector("#terminal-route-matrix")?.getAttribute("tabindex")).toBe("-1");
    click(buttonNamed(container, "Stop peer feeds"));
    expect(onStopPeerFeeds).toHaveBeenCalledOnce();
  });

  it("uses persisted local costs to avoid staging a gross peer that loses all-in", async () => {
    const key = terminalRouteCostPolicyStorageKey("device_guest") as string;
    const nowMs = Date.now();
    let policy = updateTerminalRouteCostPolicy({
      policy: emptyTerminalRouteCostPolicy(),
      venue: "phoenix",
      field: "feeBps",
      value: 20,
      nowMs: nowMs - 3,
    });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "phoenix", field: "bufferBps", value: 0, nowMs: nowMs - 2 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "feeBps", value: 0, nowMs: nowMs - 1 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "bufferBps", value: 0, nowMs });
    window.localStorage.setItem(key, serializeTerminalRouteCostPolicy(policy));
    await act(async () => {
      root.render(routeMatrix({
        decision: decision(),
        improvement: improvement(),
        selectedVenue: "hyperliquid",
        persistenceScope: "device_guest",
        onStageCandidate: vi.fn(),
      }));
      await Promise.resolve();
    });

    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Stage best route")).toBe(false);
    expect(container.textContent).toContain("No full-fill peer improves the selected venue after your local fee");
    expect(container.textContent).toContain("A#1");
    expect(container.textContent).toContain("G#2 · SOL-PERP");
  });

  it("persists bounded account-local assumptions on blur", async () => {
    await act(async () => {
      root.render(routeMatrix({
        decision: decision(),
        improvement: improvement(),
        selectedVenue: "hyperliquid",
        persistenceScope: "device_guest",
        onStageCandidate: vi.fn(),
      }));
      await Promise.resolve();
    });
    const input = requiredInput(container, "phoenix Fee bp");
    await act(async () => {
      input.value = "7.5";
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    const key = terminalRouteCostPolicyStorageKey("device_guest") as string;
    expect(inspectTerminalRouteCostPolicy(window.localStorage.getItem(key))).toMatchObject({
      status: "ready",
      policy: { venues: { phoenix: { feeBps: 7.5 } } },
    });
    expect(container.textContent).toContain("phoenix fee set to 7.50 bp");
  });

  it("labels expired assumptions and withholds all-in ranking", async () => {
    const key = terminalRouteCostPolicyStorageKey("device_guest") as string;
    const staleAt = Date.now() - TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS - 1_000;
    let policy = emptyTerminalRouteCostPolicy();
    for (const venue of ["phoenix", "hyperliquid"] as const) {
      policy = updateTerminalRouteCostPolicy({ policy, venue, field: "feeBps", value: 1, nowMs: staleAt });
      policy = updateTerminalRouteCostPolicy({ policy, venue, field: "bufferBps", value: 2, nowMs: staleAt });
    }
    window.localStorage.setItem(key, serializeTerminalRouteCostPolicy(policy));
    await act(async () => {
      root.render(routeMatrix({ decision: decision(), improvement: improvement(), selectedVenue: "hyperliquid", persistenceScope: "device_guest", onStageCandidate: vi.fn() }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Fee bp · expired");
    expect(container.textContent).toContain("All-in ranking withheld");
    expect(container.textContent).toContain("Reconfirm at least every 7 days");
    const reconfirm = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Reconfirm both");
    expect(reconfirm).toHaveLength(2);
    reconfirm.forEach(click);
    expect(container.textContent).toContain("Fee bp · set");
    expect(container.textContent).toContain("Modeled all-in edge");
    expect(container.textContent).toContain("explicitly reconfirmed");
  });

  it("expires visible evidence exactly at its deadline without another market update", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const nowMs = 2_000_000_000_000;
      vi.setSystemTime(nowMs);
      const updatedAt = nowMs - TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS + 99;
      const key = terminalRouteCostPolicyStorageKey("device_guest") as string;
      let policy = emptyTerminalRouteCostPolicy();
      for (const venue of ["phoenix", "hyperliquid"] as const) {
        policy = updateTerminalRouteCostPolicy({ policy, venue, field: "feeBps", value: 1, nowMs: updatedAt });
        policy = updateTerminalRouteCostPolicy({ policy, venue, field: "bufferBps", value: 2, nowMs: updatedAt });
      }
      window.localStorage.setItem(key, serializeTerminalRouteCostPolicy(policy));
      await act(async () => {
        root.render(routeMatrix({ decision: decision(), improvement: improvement(), selectedVenue: "hyperliquid", persistenceScope: "device_guest", onStageCandidate: vi.fn() }));
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Fee bp · set");
      expect(container.textContent).toContain("Modeled all-in edge");
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(container.textContent).toContain("Fee bp · expired");
      expect(container.textContent).toContain("All-in ranking withheld");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves corrupt policy bytes and locks only all-in ranking", async () => {
    const key = terminalRouteCostPolicyStorageKey("device_guest") as string;
    window.localStorage.setItem(key, "{broken-cost-policy");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => {
      root.render(routeMatrix({
        decision: decision(),
        improvement: improvement(),
        selectedVenue: "hyperliquid",
        persistenceScope: "device_guest",
        onStageCandidate: vi.fn(),
      }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("all-in ranking is locked");
    expect(container.textContent).toContain("Gross visible edge");
    act(() => buttonNamed(container, "Reset cost policy").click());
    expect(window.localStorage.getItem(key)).toBe("{broken-cost-policy");
  });
});

function improvement(overrides: Partial<TerminalRouteImprovement> = {}): TerminalRouteImprovement {
  return {
    improvementBps: 10,
    improvementUsd: 0.1,
    selectedVenue: "hyperliquid",
    selectedVwap: 100,
    peerVenue: "phoenix",
    peerVwap: 99.9,
    ...overrides,
  };
}

function decision(overrides: Partial<TerminalRouteDecision> = {}): TerminalRouteDecision {
  const candidates = overrides.candidates ?? [
    candidate({ venue: "phoenix", rank: 1, vwap: 99.9 }),
    candidate({ venue: "hyperliquid", rank: 2, vwap: 100 }),
  ];
  return {
    status: "full_available",
    blocker: null,
    side: "buy",
    requestedNotionalUsd: 100,
    limitPrice: 101,
    candidates,
    exclusions: [],
    best: candidates[0] ?? null,
    ...overrides,
  };
}

function candidate(overrides: Partial<TerminalRouteCandidate> = {}): TerminalRouteCandidate {
  return {
    rank: 1,
    venue: "phoenix",
    product: "SOL-PERP",
    productClass: "perpetual",
    network: "mainnet",
    status: "full",
    fillPct: 100,
    vwap: 100,
    impactBps: 2,
    filledNotionalUsd: 100,
    unfilledNotionalUsd: 0,
    worstPrice: 100,
    levelsConsumed: 1,
    bookAgeMs: 100,
    bookObservedAt: "2026-08-12T11:59:59.900Z",
    fetchedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function buttonNamed(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`button_not_found:${label}`);
  return button;
}

function click(button: HTMLButtonElement) {
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function routeMatrix(
  props: Omit<TerminalRouteMatrixProps, "costPolicy" | "allInModel"> & { persistenceScope: string | null },
) {
  return createElement(RouteMatrixHarness, props);
}

function RouteMatrixHarness({ persistenceScope, ...props }: Omit<TerminalRouteMatrixProps, "costPolicy" | "allInModel"> & { persistenceScope: string | null }) {
  const costPolicy = useTerminalRouteCostPolicy(persistenceScope);
  const allInModel = useMemo(() => costPolicy.ready && costPolicy.inspection.status !== "blocked"
    ? deriveTerminalAllInRouteModel({ decision: props.decision, policy: costPolicy.inspection.policy, selectedVenue: props.selectedVenue, nowMs: costPolicy.nowMs })
    : null,
  [costPolicy.inspection, costPolicy.nowMs, costPolicy.ready, props.decision, props.selectedVenue]);
  return createElement(TerminalRouteMatrix, { ...props, costPolicy, allInModel });
}

function requiredInput(container: HTMLElement, label: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`input_not_found:${label}`);
  return input;
}
