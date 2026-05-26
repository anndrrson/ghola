import { afterEach, describe, expect, it, vi } from "vitest";
import { signPrivateExecutionProviderResult } from "@/lib/private-execution";
import { resetPrivateExecutionStoreForTests } from "@/lib/private-execution-store";
import { POST } from "./route";

function request(body: unknown, apiKey = "sk_agent") {
  return new Request("https://ghola.test/v1/private-intents/execute", {
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
  intent_id: "intent_1",
  owner_did: "did:key:z6Mk",
  policy_hash: "policy_hash",
  proposal_hash: "proposal_hash",
  amount_micro_usdc: 25_000_000,
  rail: "railgun_private_swap",
  encrypted_intent_bundle: {
    alg: "sealed-provider-v1",
    ciphertext: "sealed",
    recipient: "provider",
    aad: "aad",
  },
};

function readyEnv() {
  vi.stubEnv(
    "GHOLA_AGENT_API_KEYS",
    JSON.stringify({ sk_agent: { agent_id: "agent_1", label: "Agent One" } }),
  );
  vi.stubEnv("GHOLA_PRIVATE_EXECUTION_FEE_RECIPIENT", "railgun:fee");
  vi.stubEnv("GHOLA_PRIVATE_EXECUTION_SHIELDED_RAIL_READY", "true");
  vi.stubEnv("GHOLA_PRIVATE_EXECUTION_RECEIPT_SECRET", "secret");
  vi.stubEnv("GHOLA_PRIVATE_EXECUTION_PROVIDER_RESULT_SECRET", "provider-secret");
}

function providerResult(overrides: Record<string, unknown> = {}) {
  const unsigned = {
    version: 1 as const,
    provider_id: "mock_attested",
    rail: "railgun_private_swap" as const,
    tx_ref: "shielded:real-tx",
    policy_hash: "policy_hash",
    proposal_hash: "proposal_hash",
    amount_micro_usdc: 25_000_000,
    fee_micro_usdc: 50_000,
    fee_recipient: "railgun:fee",
    executed_at: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
  return {
    ...unsigned,
    signature: signPrivateExecutionProviderResult(unsigned, "provider-secret"),
  };
}

describe("private intent execution route", () => {
  afterEach(async () => {
    await resetPrivateExecutionStoreForTests();
    vi.unstubAllEnvs();
  });

  it("requires a valid agent API key", async () => {
    readyEnv();

    const res = await POST(request(executeBody, ""));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("valid agent API key required");
  });

  it("fails closed when private rail config is unavailable", async () => {
    readyEnv();
    vi.stubEnv("GHOLA_PRIVATE_EXECUTION_SHIELDED_RAIL_READY", "false");

    const res = await POST(request({ ...executeBody, provider_result: providerResult() }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.blocking_reasons).toContain("shielded_rail_unavailable");
  });

  it("rejects plaintext strategy/context fields", async () => {
    readyEnv();

    const res = await POST(
      request({
        ...executeBody,
        provider_result: providerResult(),
        financial_context: { balance: 100 },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("plaintext strategy");
  });

  it("returns a fee-bearing private execution receipt", async () => {
    readyEnv();

    const res = await POST(request({ ...executeBody, provider_result: providerResult() }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.receipt.agent_id).toBe("agent_1");
    expect(body.receipt.tx_ref).toBe("shielded:real-tx");
    expect(body.receipt.public_fallback_used).toBe(false);
    expect(body.receipt.fee_quote.fee_recipient).toBe("railgun:fee");
    expect(body.receipt.signature).toMatch(/^[0-9a-f]+$/);
  });

  it("rejects provider results that do not match the quoted fee", async () => {
    readyEnv();

    const res = await POST(
      request({
        ...executeBody,
        provider_result: providerResult({ fee_micro_usdc: 1 }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("provider_result fee mismatch");
  });
});
