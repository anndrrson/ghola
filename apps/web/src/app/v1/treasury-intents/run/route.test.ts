import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { resetTreasuryExecutionStoreForTests } from "@/lib/treasury-execution-store";

const OWNER = "did:key:z6MkiTreasury1111111111111111111111111111111111";
const usd = (value: number) => value * 1_000_000;

function request(body: unknown, apiKey = "sk_treasury") {
  return new Request("https://ghola.test/v1/treasury-intents/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
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

function fixture(amount = usd(75_000), approvalThreshold = usd(100_000)) {
  return {
    version: 1,
    policy: {
      version: 1,
      policy_id: "policy_treasury_1",
      owner_did: OWNER,
      allowed_assets: ["USD", "USDC", "T_BILL", "BROKER_SWEEP"],
      allowed_payment_rails: ["stablecoin_shielded", "ach", "wire"],
      allowed_rails: [
        "bank_cash",
        "treasury_bills",
        "broker_cash_sweep",
        "stablecoin_shielded",
        "ach",
        "wire",
      ],
      allowed_partners: ["mock_treasury_partner"],
      max_action_micro_usd: usd(300_000),
      daily_action_micro_usd: usd(500_000),
      approval_required_above_micro_usd: approvalThreshold,
      public_fallback_allowed: false,
    },
    intent: {
      version: 1,
      intent_id: "intent_treasury_1",
      owner_did: OWNER,
      objective: "maintain_runway",
      horizon_days: 90,
      amount_micro_usd: amount,
      constraints: {
        min_operating_cash_micro_usd: usd(40_000),
        min_instant_liquidity_micro_usd: usd(60_000),
        min_runway_months: 6,
        max_single_bank_exposure_bps: 10000,
        max_stablecoin_issuer_exposure_bps: 10000,
        max_duration_days: 120,
        approved_rails: [
          "bank_cash",
          "treasury_bills",
          "broker_cash_sweep",
          "stablecoin_shielded",
          "ach",
          "wire",
        ],
        approval_required_above_micro_usd: approvalThreshold,
        public_fallback_allowed: false,
      },
      encrypted_context_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed-treasury-context",
        recipient: "provider",
        aad: "treasury-intent-v1",
      },
    },
  };
}

describe("treasury intent run route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetTreasuryExecutionStoreForTests();
  });

  it("executes automatically when policy does not require approval", async () => {
    readyEnv();

    const res = await POST(request(fixture()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("executed");
    expect(body.receipt.agent_id).toBe("agent_treasury");
    expect(body.partner_refs.length).toBeGreaterThan(0);
  });

  it("returns approval_required instead of executing above approval threshold", async () => {
    readyEnv();

    const res = await POST(request(fixture(usd(250_000), usd(100_000))));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.action).toBe("approval_required");
    expect(body.approval.approval_hash).toMatch(/^[0-9a-f]+$/);
    expect(body.receipt).toBeUndefined();
  });

  it("can simulate only when execute is false", async () => {
    readyEnv();

    const res = await POST(request({ ...fixture(), execute: false }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("simulated");
    expect(body.receipt).toBeUndefined();
  });
});
