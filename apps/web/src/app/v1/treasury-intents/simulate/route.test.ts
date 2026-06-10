import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { resetTreasuryExecutionStoreForTests } from "@/lib/treasury-execution-store";

const OWNER = "did:key:z6MkiTreasury1111111111111111111111111111111111";
const usd = (value: number) => value * 1_000_000;

function request(body: unknown) {
  return new Request("https://ghola.test/v1/treasury-intents/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fixture() {
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
      approval_required_above_micro_usd: usd(100_000),
      public_fallback_allowed: false,
    },
    intent: {
      version: 1,
      intent_id: "intent_treasury_1",
      owner_did: OWNER,
      objective: "maintain_runway",
      horizon_days: 90,
      amount_micro_usd: usd(250_000),
      constraints: {
        min_operating_cash_micro_usd: usd(40_000),
        min_instant_liquidity_micro_usd: usd(60_000),
        min_runway_months: 6,
        max_single_bank_exposure_bps: 5000,
        max_stablecoin_issuer_exposure_bps: 2500,
        max_duration_days: 120,
        approved_rails: [
          "bank_cash",
          "treasury_bills",
          "broker_cash_sweep",
          "stablecoin_shielded",
          "ach",
          "wire",
        ],
        approval_required_above_micro_usd: usd(100_000),
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

describe("treasury intent simulation route", () => {
  afterEach(() => {
    resetTreasuryExecutionStoreForTests();
  });

  it("returns a sealed-context liquidity proposal", async () => {
    const res = await POST(request(fixture()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.approval.approval_hash).toMatch(/^[0-9a-f]+$/);
    expect(body.proposal.approval_required).toBe(true);
    expect(body.proposal.routes.map((route: { rail: string }) => route.rail)).toContain(
      "treasury_bills",
    );
    expect(body.exposure_report.public_fallback_allowed).toBe(false);
  });

  it("rejects plaintext treasury context", async () => {
    const res = await POST(
      request({
        ...fixture(),
        balances: { checking: usd(250_000) },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("plaintext balances");
  });
});
