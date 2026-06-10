import { describe, expect, it } from "vitest";
import {
  buildTreasuryApprovalHash,
  buildTreasuryExecutionReceipt,
  containsTreasuryPlaintextLeak,
  cancelTreasuryPartnerRefs,
  createHttpTreasuryAdapter,
  reconcileTreasuryPartnerRefs,
  simulateTreasuryIntent,
  submitTreasuryExecutionToAdapters,
  validateTreasuryExecuteRequest,
  verifyTreasuryExecutionReceiptSignature,
  type TreasuryIntentV1,
  type TreasuryPolicyV1,
} from "./treasury-execution";

const OWNER = "did:key:z6MkiTreasury1111111111111111111111111111111111";
const APPROVAL_EXPIRES_AT = "2999-01-01T00:00:00.000Z";

function usd(value: number) {
  return value * 1_000_000;
}

function policy(overrides: Partial<TreasuryPolicyV1> = {}): TreasuryPolicyV1 {
  return {
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
    ...overrides,
  };
}

function intent(overrides: Partial<TreasuryIntentV1> = {}): TreasuryIntentV1 {
  return {
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
    ...overrides,
  };
}

describe("treasury execution primitives", () => {
  it("simulates a private liquidity plan across cash, stablecoins, and T-bills", () => {
    const result = simulateTreasuryIntent({
      policy: policy(),
      intent: intent(),
      now: new Date("2026-05-25T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.proposal.approval_required).toBe(true);
    expect(result.proposal.routes.map((route) => route.rail)).toContain("bank_cash");
    expect(result.proposal.routes.map((route) => route.rail)).toContain("stablecoin_shielded");
    expect(result.proposal.routes.map((route) => route.rail)).toContain("treasury_bills");
    expect(result.proposal.routes.every((route) => Number.isFinite(route.route_score_bps))).toBe(
      true,
    );
    expect(result.approval?.approval_hash).toMatch(/^[0-9a-f]+$/);
    expect(result.exposure_report.public_fallback_allowed).toBe(false);
    expect(result.exposure_report.expected_public_leakage).toBe(
      "sealed_context_partner_instructions_only",
    );
  });

  it("blocks treasury actions above the policy cap", () => {
    const result = simulateTreasuryIntent({
      policy: policy({ max_action_micro_usd: usd(100_000) }),
      intent: intent(),
    });

    expect(result.ok).toBe(false);
    expect(result.exposure_report.blocked_reason).toBe("amount_over_cap");
  });

  it("blocks unapproved public fallback before execution", () => {
    const result = simulateTreasuryIntent({
      policy: policy({
        public_fallback_allowed: true,
      } as unknown as Partial<TreasuryPolicyV1>),
      intent: intent(),
    });

    expect(result.ok).toBe(false);
    expect(result.exposure_report.blocked_reason).toBe("public_fallback_denied");
  });

  it("detects plaintext treasury context recursively", () => {
    expect(
      containsTreasuryPlaintextLeak({
        encrypted_context_bundle: { ciphertext: "abc" },
        nested: [{ balances: { checking: 100 } }],
      }),
    ).toBe(true);
  });

  it("requires approval hash and sealed bundle for execution requests", () => {
    const validation = validateTreasuryExecuteRequest({
      version: 1,
      intent_id: "intent_treasury_1",
      owner_did: OWNER,
      policy_hash: "policy_hash",
      proposal_hash: "proposal_hash",
      approval_expires_at: APPROVAL_EXPIRES_AT,
      amount_micro_usd: usd(250_000),
      rails: ["bank_cash", "treasury_bills"],
      encrypted_context_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed",
        recipient: "provider",
        aad: "treasury-intent-v1",
      },
    });

    expect(validation.ok).toBe(false);
    expect(validation.error).toBe("approval_hash is required");
  });

  it("validates deterministic approval hashes against proposal scope", () => {
    const approvalHash = buildTreasuryApprovalHash({
      ownerDid: OWNER,
      policyHash: "policy_hash",
      proposalHash: "proposal_hash",
      amountMicroUsd: usd(250_000),
      rails: ["treasury_bills", "bank_cash"],
      expiresAt: APPROVAL_EXPIRES_AT,
    });

    const validation = validateTreasuryExecuteRequest({
      version: 1,
      intent_id: "intent_treasury_1",
      owner_did: OWNER,
      policy_hash: "policy_hash",
      proposal_hash: "proposal_hash",
      approval_hash: approvalHash,
      approval_expires_at: APPROVAL_EXPIRES_AT,
      amount_micro_usd: usd(250_000),
      rails: ["bank_cash", "treasury_bills"],
      encrypted_context_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed",
        recipient: "provider",
        aad: "treasury-intent-v1",
      },
    });

    expect(validation.ok).toBe(true);
  });

  it("submits redacted instructions through mock partner adapters", async () => {
    const approvalHash = buildTreasuryApprovalHash({
      ownerDid: OWNER,
      policyHash: "policy_hash",
      proposalHash: "proposal_hash",
      amountMicroUsd: usd(250_000),
      rails: ["bank_cash", "treasury_bills"],
      expiresAt: APPROVAL_EXPIRES_AT,
    });

    const result = await submitTreasuryExecutionToAdapters({
      providerId: "mock_treasury_partner",
      request: {
        version: 1,
        intent_id: "intent_treasury_1",
        owner_did: OWNER,
        policy_hash: "policy_hash",
        proposal_hash: "proposal_hash",
        approval_hash: approvalHash,
        approval_expires_at: APPROVAL_EXPIRES_AT,
        amount_micro_usd: usd(250_000),
        rails: ["bank_cash", "treasury_bills"],
        encrypted_context_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed",
          recipient: "provider",
          aad: "treasury-intent-v1",
        },
      },
    });

    expect(result.prepared.every((instruction) => instruction.redacted)).toBe(true);
    expect(result.partner_refs).toEqual([
      "mock-submit:mock_treasury_partner:bank_cash:intent_treasury_1",
      "mock-submit:mock_treasury_partner:treasury_bills:intent_treasury_1",
    ]);
  });

  it("reconciles and cancels submitted partner refs", async () => {
    const approvalHash = buildTreasuryApprovalHash({
      ownerDid: OWNER,
      policyHash: "policy_hash",
      proposalHash: "proposal_hash",
      amountMicroUsd: usd(250_000),
      rails: ["bank_cash"],
      expiresAt: APPROVAL_EXPIRES_AT,
    });

    const result = await submitTreasuryExecutionToAdapters({
      providerId: "mock_treasury_partner",
      request: {
        version: 1,
        intent_id: "intent_treasury_1",
        owner_did: OWNER,
        policy_hash: "policy_hash",
        proposal_hash: "proposal_hash",
        approval_hash: approvalHash,
        approval_expires_at: APPROVAL_EXPIRES_AT,
        amount_micro_usd: usd(250_000),
        rails: ["bank_cash"],
        encrypted_context_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed",
          recipient: "provider",
          aad: "treasury-intent-v1",
        },
      },
    });

    const reconciled = await reconcileTreasuryPartnerRefs({
      providerId: "mock_treasury_partner",
      submissions: result.submissions,
    });
    const cancelled = await cancelTreasuryPartnerRefs({
      providerId: "mock_treasury_partner",
      submissions: result.submissions,
    });

    expect(reconciled).toEqual([
      {
        version: 1,
        rail: "bank_cash",
        partner_ref: "mock-submit:mock_treasury_partner:bank_cash:intent_treasury_1",
        reconciliation_state: "submitted",
      },
    ]);
    expect(cancelled[0].reconciliation_state).toBe("cancelled");
  });

  it("calls configured HTTP partner adapters with redacted execution payloads", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const action = url.toString().split("/").pop();
      calls.push({
        url: url.toString(),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify(
          action === "prepare"
            ? {
                version: 1,
                rail: "bank_cash",
                instruction_ref: "prepare_1",
                provider_id: "http_partner",
                redacted: true,
              }
            : {
                version: 1,
                rail: "bank_cash",
                partner_ref: "partner_submit_1",
                provider_id: "http_partner",
                reconciliation_state: "submitted",
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const approvalHash = buildTreasuryApprovalHash({
        ownerDid: OWNER,
        policyHash: "policy_hash",
        proposalHash: "proposal_hash",
        amountMicroUsd: usd(250_000),
        rails: ["bank_cash"],
        expiresAt: APPROVAL_EXPIRES_AT,
      });
      const result = await submitTreasuryExecutionToAdapters({
        providerId: "http_partner",
        adapters: new Map([
          [
            "bank_cash",
            createHttpTreasuryAdapter({
              rail: "bank_cash",
              endpoint: "https://partner.example/treasury",
              apiKey: "partner-key",
            }),
          ],
        ]),
        request: {
          version: 1,
          intent_id: "intent_treasury_1",
          owner_did: OWNER,
          policy_hash: "policy_hash",
          proposal_hash: "proposal_hash",
          approval_hash: approvalHash,
          approval_expires_at: APPROVAL_EXPIRES_AT,
          amount_micro_usd: usd(250_000),
          rails: ["bank_cash"],
          encrypted_context_bundle: {
            alg: "sealed-provider-v1",
            ciphertext: "sealed",
            recipient: "provider",
            aad: "treasury-intent-v1",
          },
        },
      });

      expect(result.partner_refs).toEqual(["partner_submit_1"]);
      expect(calls.map((call) => call.url)).toEqual([
        "https://partner.example/treasury/prepare",
        "https://partner.example/treasury/submit",
      ]);
      expect(calls[0].headers.get("authorization")).toBe("Bearer partner-key");
      expect(calls[0].headers.get("x-ghola-treasury-rail")).toBe("bank_cash");
      expect(calls[0].body).toMatchObject({
        version: 1,
        rail: "bank_cash",
        intent_id: "intent_treasury_1",
        policy_hash: "policy_hash",
        encrypted_context_bundle: {
          ciphertext: "sealed",
        },
      });
      expect(calls[0].body).not.toHaveProperty("rails");
      expect(JSON.stringify(calls[0].body)).not.toContain("account_number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("signs and rejects tampered treasury receipts", () => {
    const approvalHash = buildTreasuryApprovalHash({
      ownerDid: OWNER,
      policyHash: "policy_hash",
      proposalHash: "proposal_hash",
      amountMicroUsd: usd(250_000),
      rails: ["bank_cash", "treasury_bills"],
      expiresAt: APPROVAL_EXPIRES_AT,
    });
    const receipt = buildTreasuryExecutionReceipt({
      request: {
        version: 1,
        intent_id: "intent_treasury_1",
        owner_did: OWNER,
        policy_hash: "policy_hash",
        proposal_hash: "proposal_hash",
        approval_hash: approvalHash,
        approval_expires_at: APPROVAL_EXPIRES_AT,
        amount_micro_usd: usd(250_000),
        rails: ["bank_cash", "treasury_bills"],
        encrypted_context_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed",
          recipient: "provider",
          aad: "treasury-intent-v1",
        },
      },
      agentId: "agent_treasury",
      providerId: "mock_treasury_partner",
      signingSecret: "secret",
      now: new Date("2026-05-25T00:00:00.000Z"),
    });

    expect(verifyTreasuryExecutionReceiptSignature(receipt, "secret")).toBe(true);
    expect(
      verifyTreasuryExecutionReceiptSignature(
        { ...receipt, amount_micro_usd: usd(1) },
        "secret",
      ),
    ).toBe(false);
  });
});
