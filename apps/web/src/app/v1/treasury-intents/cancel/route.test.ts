import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTreasuryApprovalHash } from "@/lib/treasury-execution";
import { resetTreasuryExecutionStoreForTests } from "@/lib/treasury-execution-store";
import { POST as execute } from "../execute/route";
import { POST } from "./route";

const OWNER = "did:key:z6MkiTreasury1111111111111111111111111111111111";
const usd = (value: number) => value * 1_000_000;
const APPROVAL_EXPIRES_AT = "2999-01-01T00:00:00.000Z";
const APPROVAL_HASH = buildTreasuryApprovalHash({
  ownerDid: OWNER,
  policyHash: "policy_hash",
  proposalHash: "proposal_hash",
  amountMicroUsd: usd(250_000),
  rails: ["bank_cash", "treasury_bills"],
  expiresAt: APPROVAL_EXPIRES_AT,
});

function request(body: unknown, apiKey = "sk_treasury") {
  return new Request("https://ghola.test/v1/treasury-intents/cancel", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function executeRequest() {
  return new Request("https://ghola.test/v1/treasury-intents/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk_treasury",
    },
    body: JSON.stringify({
      version: 1,
      intent_id: "intent_treasury_cancel",
      owner_did: OWNER,
      policy_hash: "policy_hash",
      proposal_hash: "proposal_hash",
      approval_hash: APPROVAL_HASH,
      approval_expires_at: APPROVAL_EXPIRES_AT,
      amount_micro_usd: usd(250_000),
      rails: ["bank_cash", "treasury_bills"],
      encrypted_context_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed",
        recipient: "provider",
        aad: "treasury-intent-v1",
      },
    }),
  });
}

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

describe("treasury intent cancellation route", () => {
  afterEach(async () => {
    await resetTreasuryExecutionStoreForTests();
    vi.unstubAllEnvs();
  });

  it("requires a valid treasury agent API key", async () => {
    readyEnv();

    const res = await POST(request({ version: 1, intent_id: "intent_treasury_cancel" }, ""));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("valid agent API key required");
  });

  it("cancels submitted partner refs and persists cancelled state", async () => {
    readyEnv();

    const execRes = await execute(executeRequest());
    expect(execRes.status).toBe(201);

    const res = await POST(request({ version: 1, intent_id: "intent_treasury_cancel" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.reconciliation_state).toBe("cancelled");
    expect(body.reconciliations).toHaveLength(2);
    expect(
      body.reconciliations.every(
        (item: { reconciliation_state: string }) =>
          item.reconciliation_state === "cancelled",
      ),
    ).toBe(true);
  });
});
