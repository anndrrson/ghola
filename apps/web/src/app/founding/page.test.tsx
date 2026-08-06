import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/thumper-auth-context", () => ({
  useThumperAuth: () => ({ authenticated: false, loading: false }),
}));

import FoundingTraderPage from "./page";

describe("Founding Trader page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the ten-seat cohort and sends logged-out visitors through signup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        capacity: 10,
        claimed_seats: 0,
        remaining_seats: 10,
        checkout_open: true,
      }),
    }));

    await renderPage();

    expect(container.textContent).toContain("Public founding cohort · 10 seats");
    expect(container.textContent).toContain("10 of 10 seats remaining");
    const joinLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Join the founding cohort"),
    );
    expect(joinLink?.getAttribute("href")).toBe(
      "/signup?redirect=%2Fsettings%3Ftab%3Dplan",
    );
  });

  it("suppresses admission when all ten seats are claimed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        capacity: 10,
        claimed_seats: 10,
        remaining_seats: 0,
        checkout_open: false,
      }),
    }));

    await renderPage();

    expect(container.textContent).toContain("The founding cohort is full.");
    expect(container.textContent).not.toContain("Join the founding cohort");
  });

  async function renderPage() {
    await act(async () => {
      root.render(createElement(FoundingTraderPage));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }
});
