import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as simulate } from "../../simulate/route";
import { POST as execute } from "../../execute/route";
import { GET } from "./route";
import { resetTreasuryExecutionStoreForTests } from "@/lib/treasury-execution-store";

const OWNER = "did:key:z6MkiTreasury1111111111111111111111111111111111";
const usd = (value: number) => value * 1_000_000;

function simulateRequest(body: unknown) {
  return new Request("https://ghola.test/v1/treasury-intents/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function executeRequest(body: unknown) {
  return new Request("https://ghola.test/v1/treasury-intents/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk_treasury",
    },
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

describe("treasury intent per-intent status route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetTreasuryExecutionStoreForTests();
  });

  it("returns simulated proposal status after simulation", async () => {
    const simRes = await simulate(simulateRequest(fixture()));
    const simBody = await simRes.json();

    const res = await GET(new Request("https://ghola.test"), {
      params: Promise.resolve({ intent_id: "intent_treasury_1" }),
    });
    const body = await res.json();

    expect(body.reconciliation_state).toBe("simulated");
    expect(body.proposal_hash).toBe(simBody.proposal_hash);
    expect(body.approval_hash).toBe(simBody.approval.approval_hash);
  });

  it("returns submitted receipt status after execution", async () => {
    vi.stubEnv(
      "GHOLA_TREASURY_AGENT_API_KEYS",
      JSON.stringify({
        sk_treasury: { agent_id: "agent_treasury", label: "Treasury Agent" },
      }),
    );
    const simRes = await simulate(simulateRequest(fixture()));
    const simBody = await simRes.json();

    const execRes = await execute(
      executeRequest({
        version: 1,
        intent_id: "intent_treasury_1",
        owner_did: OWNER,
        policy_hash: simBody.policy_hash,
        proposal_hash: simBody.proposal_hash,
        approval_hash: simBody.approval.approval_hash,
        approval_expires_at: simBody.approval.expires_at,
        amount_micro_usd: simBody.proposal.amount_micro_usd,
        rails: simBody.proposal.routes.map((route: { rail: string }) => route.rail),
        encrypted_context_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed",
          recipient: "provider",
          aad: "treasury-intent-v1",
        },
      }),
    );
    const execBody = await execRes.json();

    const res = await GET(new Request("https://ghola.test"), {
      params: Promise.resolve({ intent_id: "intent_treasury_1" }),
    });
    const body = await res.json();

    expect(body.reconciliation_state).toBe("submitted");
    expect(body.receipt_id).toBe(execBody.receipt.receipt_id);
    expect(body.partner_refs).toEqual(execBody.receipt.partner_refs);
  });
});
