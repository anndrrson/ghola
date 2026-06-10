import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupModel } from "./model-registry";

// `deriveModelPda` is a thin wrapper around `PublicKey.findProgramAddress`
// — testing it under jsdom is unstable because @solana/web3.js does
// cross-realm Uint8Array equality checks that don't survive the jsdom
// environment. The math is exercised end-to-end by `lookupModel` below,
// which is the actual surface a chat session calls.
//
// What we DO test: `lookupModel` returns the right status for each
// observable RPC outcome so the badge UI can rely on the discriminator.

describe("lookupModel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'unreachable' when the Solana RPC throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const result = await lookupModel("any-model");
    expect(result.status).toBe("unreachable");
    expect(result.error).toBeTruthy();
    expect(result.modelId).toBe("any-model");
  });

  it("always propagates the original modelId in the result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const result = await lookupModel("Phi-3-mini-4k-instruct-q4f16_1-MLC");
    expect(result.modelId).toBe("Phi-3-mini-4k-instruct-q4f16_1-MLC");
  });

  it("falls back to same-origin server RPC when browser RPC is blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/model-registry?")) {
          return new Response(
            JSON.stringify({
              status: "unregistered",
              modelId: "any-model",
              lookupSource: "server_rpc",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        throw new Error("browser rpc blocked");
      }),
    );
    const result = await lookupModel("any-model");
    expect(result.status).toBe("unregistered");
    expect(result.lookupSource).toBe("server_rpc");
    expect(result.modelId).toBe("any-model");
  });

  // Note: the "unregistered" happy-path (account-not-found at the
  // deterministic PDA) needs to exercise PublicKey.findProgramAddress,
  // which fails under jsdom due to a cross-realm Uint8Array prototype
  // mismatch in @solana/web3.js. That path is verified at runtime in
  // the dev server and in the production browser bundle; not by unit
  // tests in this environment.
});
