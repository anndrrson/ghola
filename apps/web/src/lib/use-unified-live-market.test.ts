import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedMarketAdapter, UnifiedMarketAdapterContext } from "./unified-live-market";
import { useUnifiedLiveMarket } from "./use-unified-live-market";

describe("useUnifiedLiveMarket restart generation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("stops the old selected feed and starts exactly one replacement", () => {
    const adapters: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    const createStream = (): UnifiedMarketAdapter => {
      const adapter = { start: vi.fn(), stop: vi.fn() };
      adapters.push(adapter);
      return adapter;
    };

    act(() => root.render(createElement(Harness, { restartKey: 0, createStream })));
    expect(adapters).toHaveLength(1);
    expect(adapters[0].start).toHaveBeenCalledOnce();

    act(() => root.render(createElement(Harness, { restartKey: 1, createStream })));
    expect(adapters).toHaveLength(2);
    expect(adapters[0].stop).toHaveBeenCalledOnce();
    expect(adapters[1].start).toHaveBeenCalledOnce();

    act(() => root.render(createElement(Harness, { restartKey: 1, createStream })));
    expect(adapters).toHaveLength(2);
  });
});

function Harness({ restartKey, createStream }: { restartKey: number; createStream: (context: UnifiedMarketAdapterContext) => UnifiedMarketAdapter }) {
  const state = useUnifiedLiveMarket({
    venue: "hyperliquid",
    market: "BTC",
    interval: "5m",
    hyperliquidNetwork: "mainnet",
    restartKey,
    createStream,
    now: FIXED_NOW,
    isDocumentHidden: DOCUMENT_VISIBLE,
  });
  return createElement("span", null, state.status);
}

const FIXED_NOW = () => Date.parse("2026-08-13T04:00:00.000Z");
const DOCUMENT_VISIBLE = () => false;
