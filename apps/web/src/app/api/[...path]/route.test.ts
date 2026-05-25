import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(url: string, init?: NextRequestInit) {
  return new NextRequest(url, init);
}

describe("API catch-all proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unsafe path segments before proxying", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await GET(request("https://ghola.test/api/../health"), {
      params: Promise.resolve({ path: ["..", "health"] }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid proxy path");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a typed 503 when the upstream fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failed"));

    const res = await GET(request("https://ghola.test/api/health"), {
      params: Promise.resolve({ path: ["health"] }),
    });
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toBe("upstream unavailable");
  });

  it("rejects cross-site cookie-authenticated mutation requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      request("https://ghola.test/api/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "ghola_thumper_session=session-token",
          origin: "https://evil.test",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["tasks"] }) },
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("cross-site cookie-authenticated request rejected");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
