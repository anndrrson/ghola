import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => {
  delete process.env.GHOLA_LIVE_TRADING_COUNTRY_ALLOWLIST;
  delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
  delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
  vi.restoreAllMocks();
});

describe("autopilot resume jurisdiction gate", () => {
  it("denies an unverifiable jurisdiction before session mutation or worker contact", async () => {
    process.env.GHOLA_LIVE_TRADING_COUNTRY_ALLOWLIST = "CA";
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await POST(new Request(
      "https://ghola.test/v1/private-account/autopilot/sessions/session-1/resume",
      {
        method: "POST",
        headers: {
          authorization: "Bearer local-resume-user",
          "content-type": "application/json",
          "x-country-code": "CA",
        },
        body: "{}",
      },
    ), { params: Promise.resolve({ session_id: "session-1" }) });

    expect(response.status).toBe(451);
    await expect(response.json()).resolves.toMatchObject({
      error: "restricted_jurisdiction",
      reason_codes: ["country_header_missing"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
