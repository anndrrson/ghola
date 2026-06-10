import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NO_ATTESTED_PRIVATE_PROVIDERS_MESSAGE,
  selectRoute,
} from "./sovereignty";

describe("sovereignty fail-closed routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("explains when private base readiness is online but provider capacity is empty", async () => {
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
            private_ready: true,
            reason_codes: [],
            attested_provider_count: 0,
            private_capacity_ready: false,
            capacity_reason_codes: ["no_attested_private_providers"],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const route = await selectRoute("private");

    expect(route.transport).toBe("private-unavailable");
    expect(route.caveat).toBe(NO_ATTESTED_PRIVATE_PROVIDERS_MESSAGE);
    expect(route.reasonCodes).toEqual(["no_attested_private_providers"]);
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

  it("auto mode prefers paired ghola-home", async () => {
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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const route = await selectRoute("auto");

    expect(route.transport).toBe("ghola-home");
    expect(route.mode).toBe("auto");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto mode uses browser hardware when WebGPU is available", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn().mockResolvedValue({}) },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const route = await selectRoute("auto");

    expect(route.transport).toBe("webgpu");
    expect(route.mode).toBe("auto");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto mode tries protected cloud when local hardware is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.stubGlobal("navigator", {});
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

    const route = await selectRoute("auto");

    expect(route.transport).toBe("relay-sealed");
    expect(route.mode).toBe("auto");
    expect(route.enclave?.enclave_key_id).toBe("key-1");
  });

  it("auto mode skips browser hardware on mobile-class browsers", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn().mockResolvedValue({}) },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile",
      hardwareConcurrency: 8,
    });
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

    const route = await selectRoute("auto");

    expect(route.transport).toBe("relay-sealed");
    expect(route.mode).toBe("auto");
  });

  it("auto mode skips browser hardware on low-memory desktop browsers", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn().mockResolvedValue({}) },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
      deviceMemory: 4,
      hardwareConcurrency: 8,
    });
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

    const route = await selectRoute("auto");

    expect(route.transport).toBe("relay-sealed");
    expect(route.mode).toBe("auto");
  });

  it("auto mode tries protected cloud when WebGPU has no adapter", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn().mockResolvedValue(null) },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
      deviceMemory: 16,
      hardwareConcurrency: 10,
    });
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

    const route = await selectRoute("auto");

    expect(route.transport).toBe("relay-sealed");
    expect(route.mode).toBe("auto");
  });

  it("auto mode fails closed when neither local nor protected cloud is available", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.stubGlobal("navigator", {});
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

    const route = await selectRoute("auto");

    expect(route.transport).toBe("private-unavailable");
    expect(route.mode).toBe("auto");
    expect(route.transport).not.toBe("relay-plain");
    expect(route.reasonCodes).toEqual(["did_set_stale"]);
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
