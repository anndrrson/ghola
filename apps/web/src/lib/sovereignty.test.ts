import { afterEach, describe, expect, it, vi } from "vitest";

import { selectRoute } from "./sovereignty";

describe("sovereignty fail-closed routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never falls back private mode to relay-plain when no enclave is available", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            private_ready: false,
            reason_codes: ["did_set_stale"],
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const route = await selectRoute("private");

    expect(route.transport).toBe("private-unavailable");
    expect(route.transport).not.toBe("relay-plain");
    expect(route.reasonCodes).toEqual(["did_set_stale"]);
  });

  it("local mode returns webgpu transport when no ghola-home pair token is stored", async () => {
    // Tier 1A anonymous front door: an unpaired browser running Local
    // must route to in-browser WebGPU inference, not to ghola-home.
    // The localStorage check is module-internal — clear and verify.
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });

    const route = await selectRoute("local");

    expect(route.transport).toBe("webgpu");
    expect(route.mode).toBe("local");
  });

  it("local mode returns ghola-home transport when a pair token exists", async () => {
    // The user installed ghola-home + paired the browser. Local must
    // route to the native daemon for the bigger Ollama-hosted models.
    const store: Record<string, string> = {
      "ghola:home-pair-token": "tok-xyz",
    };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });

    const route = await selectRoute("local");

    expect(route.transport).toBe("ghola-home");
  });

  it("uses relay-sealed for private mode when attested enclave exists", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            enclave_key_id: "key-1",
            provider_id: "provider-1",
            tee_kind: "nitro",
            enclave_x25519_pub_hex:
              "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            enclave_ed25519_pub_hex:
              "ffeeddccbbaa9988776655443322110000112233445566778899aabbccddeeff",
            measurement_hex: "deadbeef",
            expires_at_unix: 9999999999,
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const route = await selectRoute("private");

    expect(route.transport).toBe("relay-sealed");
    expect(route.enclave?.enclave_key_id).toBe("key-1");
  });
});
