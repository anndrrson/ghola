import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { buildTreasuryApprovalHash } from "@/lib/treasury-execution";
import { resetTreasuryExecutionStoreForTests } from "@/lib/treasury-execution-store";

const OWNER = "did:key:z6MkiTreasury1111111111111111111111111111111111";
const usd = (value: number) => value * 1_000_000;
const APPROVAL_EXPIRES_AT = "2999-01-01T00:00:00.000Z";
const APPROVAL_HASH = buildTreasuryApprovalHash({
  ownerDid: OWNER,
  policyHash: "policy_hash",
  proposalHash: "proposal_hash",
  amountMicroUsd: usd(250_000),
  rails: ["bank_cash", "treasury_bills", "stablecoin_shielded"],
  expiresAt: APPROVAL_EXPIRES_AT,
});

function request(body: unknown, apiKey = "sk_treasury") {
  return new Request("https://ghola.test/v1/treasury-intents/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const executeBody = {
  version: 1,
  intent_id: "intent_treasury_1",
  owner_did: OWNER,
  policy_hash: "policy_hash",
  proposal_hash: "proposal_hash",
  approval_hash: APPROVAL_HASH,
  approval_expires_at: APPROVAL_EXPIRES_AT,
  amount_micro_usd: usd(250_000),
  rails: ["bank_cash", "treasury_bills", "stablecoin_shielded"],
  encrypted_context_bundle: {
    alg: "sealed-provider-v1",
    ciphertext: "sealed",
    recipient: "provider",
    aad: "treasury-intent-v1",
  },
};

function readyEnv() {
  vi.stubEnv(
    "GHOLA_TREASURY_AGENT_API_KEYS",
    JSON.stringify({
      sk_treasury: { agent_id: "agent_treasury", label: "Treasury Agent" },
    }),
  );
  vi.stubEnv("GHOLA_TREASURY_RECEIPT_SECRET", "secret");
  vi.stubEnv("GHOLA_TREASURY_PARTNER_RAIL_READY", "true");
  vi.stubEnv("GHOLA_TREASURY_PROVIDER_READY", "true");
}

describe("treasury intent execution route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetTreasuryExecutionStoreForTests();
  });

  it("requires a valid treasury agent API key", async () => {
    readyEnv();

    const res = await POST(request(executeBody, ""));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("valid agent API key required");
  });

  it("fails closed when partner rails are unavailable", async () => {
    readyEnv();
    vi.stubEnv("GHOLA_TREASURY_PARTNER_RAIL_READY", "false");

    const res = await POST(request(executeBody));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.blocking_reasons).toContain("partner_rail_unavailable");
  });

  it("rejects missing approval hash", async () => {
    readyEnv();

    const res = await POST(
      request({
        ...executeBody,
        approval_hash: "",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("approval_hash is required");
  });

  it("rejects approval hash that does not match the execution scope", async () => {
    readyEnv();

    const res = await POST(
      request({
        ...executeBody,
        approval_hash: "bad_hash",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("approval_hash does not match proposal scope");
  });

  it("rejects rails disabled by treasury configuration", async () => {
    readyEnv();
    vi.stubEnv("GHOLA_TREASURY_SUPPORTED_RAILS", "bank_cash,treasury_bills");

    const res = await POST(request(executeBody));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("unsupported treasury rail: stablecoin_shielded");
  });

  it("returns a signed treasury execution receipt", async () => {
    readyEnv();

    const res = await POST(request(executeBody));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.receipt.agent_id).toBe("agent_treasury");
    expect(body.receipt.public_fallback_used).toBe(false);
    expect(body.receipt.reconciliation_state).toBe("submitted");
    expect(body.receipt.partner_refs).toEqual([
      "mock-submit:mock_treasury_partner:bank_cash:intent_treasury_1",
      "mock-submit:mock_treasury_partner:treasury_bills:intent_treasury_1",
      "mock-submit:mock_treasury_partner:stablecoin_shielded:intent_treasury_1",
    ]);
    expect(body.partner_refs).toEqual(body.receipt.partner_refs);
    expect(body.receipt.signature).toMatch(/^[0-9a-f]+$/);
  });

  it("uses a configured HTTP treasury partner adapter", async () => {
    readyEnv();
    vi.stubEnv("GHOLA_TREASURY_PARTNER_ADAPTER_URL", "https://partner.example/treasury");
    vi.stubEnv("GHOLA_TREASURY_PARTNER_ADAPTER_API_KEY", "partner-key");
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const rail = headers.get("x-ghola-treasury-rail") || "unknown";
      const action = url.toString().split("/").pop();
      calls.push({ url: url.toString(), headers });
      return new Response(
        JSON.stringify(
          action === "prepare"
            ? {
                version: 1,
                rail,
                instruction_ref: `http-prepare:${rail}`,
                provider_id: "http_partner",
                redacted: true,
              }
            : {
                version: 1,
                rail,
                partner_ref: `http-submit:${rail}`,
                provider_id: "http_partner",
                reconciliation_state: "submitted",
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const res = await POST(request(executeBody));
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.partner_refs).toEqual([
        "http-submit:bank_cash",
        "http-submit:treasury_bills",
        "http-submit:stablecoin_shielded",
      ]);
      expect(calls).toHaveLength(6);
      expect(calls[0].url).toBe("https://partner.example/treasury/prepare");
      expect(calls[0].headers.get("authorization")).toBe("Bearer partner-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
