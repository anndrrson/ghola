import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const ORIGINAL_TOKEN = process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;

describe("legacy live-trading canary report", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = "legacy-report-test-token";
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    else process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = ORIGINAL_TOKEN;
  });

  it("requires internal authentication", async () => {
    const response = await POST(new Request("http://localhost/v1/private-account/live-trading/canary-report", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("retires the authenticated legacy evidence path", async () => {
    const response = await POST(new Request("http://localhost/v1/private-account/live-trading/canary-report", {
      method: "POST",
      headers: { authorization: "Bearer legacy-report-test-token" },
    }));
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: "legacy_canary_report_retired" });
  });
});
