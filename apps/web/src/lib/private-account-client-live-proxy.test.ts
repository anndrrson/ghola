import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importPrivateAccountFundingReceipt,
  prepareAsterProgrammaticCredential,
  prepareLighterProgrammaticCredential,
} from "./private-account-client";

describe("private-account guarded client mutations", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["aster", () => prepareAsterProgrammaticCredential({
      owner_address: "0x0000000000000000000000000000000000000001",
    }), "/v1/private-account/platforms/aster/prepare"],
    ["lighter", () => prepareLighterProgrammaticCredential({
      owner_address: "0x0000000000000000000000000000000000000001",
    }), "/v1/private-account/platforms/lighter/prepare"],
    ["funding import", () => importPrivateAccountFundingReceipt({
      funding_intent_id: "funding_1",
      receipt_id: "receipt_1",
    }), "/v1/private-account/funding/import"],
  ])("routes %s through the server proof proxy", async (_label, run, expectedPath) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await run();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/private-account/live-proxy");
    expect(JSON.parse(String(init.body))).toMatchObject({ path: expectedPath, method: "POST" });
  });
});
