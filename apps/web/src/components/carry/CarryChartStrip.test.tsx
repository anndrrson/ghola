import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarryChartStrip } from "./CarryChartStrip";

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
});
