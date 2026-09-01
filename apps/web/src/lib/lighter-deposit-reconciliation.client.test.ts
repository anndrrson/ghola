import { describe, expect, it, vi } from "vitest";
import {
  checkLighterDepositReconciliation,
  lighterUsdcToMicrounits,
  LighterDepositReconciliationError,
} from "./lighter-deposit-reconciliation.client";

const OWNER = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}`;
const EXPECTATION = `lighter_deposit_expectation_${"cd".repeat(24)}`;

describe("Lighter exact deposit reconciliation client", () => {
  it("converts the default and minimum USDC amounts without floating point math", () => {
    expect(lighterUsdcToMicrounits("5.5")).toBe("5500000");
    expect(lighterUsdcToMicrounits("5")).toBe("5000000");
    expect(lighterUsdcToMicrounits("4.999999")).toBeNull();
    expect(lighterUsdcToMicrounits("5.0000001")).toBeNull();
  });

  it("submits one exact owner, destination, hash, and amount check", async () => {
    const fetchImpl = vi.fn(async () => Response.json(unseen(), { status: 202 }));
    await expect(checkLighterDepositReconciliation(input(fetchImpl))).resolves.toMatchObject({
      owner_address: OWNER,
      deposit_address: DEPOSIT,
      transaction_hash: HASH,
      expected_amount_microunits: "5500000",
      status: "unseen",
      reconciliation_complete: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/carry/lighter-deposit-reconciliation",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          version: 1,
          owner_address: OWNER,
          deposit_address: DEPOSIT,
          transaction_hash: HASH,
          expected_amount_microunits: "5500000",
        }),
      }),
    );
  });

  it.each(["PROCESSING", "COMPLETED"] as const)("validates exact %s bindings", async (status) => {
    const fetchImpl = vi.fn(async () => Response.json(observed(status)));
    await expect(checkLighterDepositReconciliation(input(fetchImpl))).resolves.toMatchObject({
      status,
      reconciliation_complete: status === "COMPLETED",
    });
  });

  it.each([
    ["owner", { owner_address: "0x3333333333333333333333333333333333333333" }],
    ["deposit", { deposit_address: "0x3333333333333333333333333333333333333333" }],
    ["hash", { transaction_hash: `0x${"ef".repeat(32)}` }],
    ["amount", { expected_amount_microunits: "6000000" }],
  ])("locks retry after a malformed or mismatched %s response", async (_label, mutation) => {
    const fetchImpl = vi.fn(async () => Response.json({ ...observed("PROCESSING"), ...mutation }));
    let caught: unknown;
    try {
      await checkLighterDepositReconciliation(input(fetchImpl));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LighterDepositReconciliationError);
    expect((caught as LighterDepositReconciliationError).retryForbidden).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("locks after transport ambiguity and never retries automatically", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("secret transport detail"); });
    let caught: unknown;
    try {
      await checkLighterDepositReconciliation(input(fetchImpl));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "The check outcome is uncertain. Do not submit it again; reconcile this exact transaction manually.",
      retryForbidden: true,
    });
    expect(JSON.stringify(caught)).not.toContain("secret transport detail");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sanitizes deterministic server errors", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      error: "private_provider_failure",
      secret: "must-not-surface",
    }, { status: 400 }));
    await expect(checkLighterDepositReconciliation(input(fetchImpl))).rejects.toMatchObject({
      message: "The deposit check was rejected. Verify the exact Base transaction hash and USDC amount.",
      retryForbidden: false,
    });
  });
});

function input(fetchImpl: typeof fetch) {
  return {
    ownerAddress: OWNER,
    depositAddress: DEPOSIT,
    transactionHash: HASH,
    expectedAmountMicrounits: "5500000",
    fetchImpl,
  };
}

function unseen() {
  return {
    version: 1,
    expectation_id: EXPECTATION,
    observed: false,
    reconciliation_complete: false,
    poll_after_ms: 1_500,
    checked_at: new Date().toISOString(),
  };
}

function observed(status: "PROCESSING" | "COMPLETED") {
  return {
    version: 1,
    expectation_id: EXPECTATION,
    owner_address: OWNER,
    deposit_address: DEPOSIT,
    transaction_hash: HASH,
    expected_amount_microunits: "5500000",
    source: {
      chain_id: 8453,
      token_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    },
    destination: {
      to_chain_id: "3586256",
      to_token_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    },
    observed: true,
    status,
    reconciliation_complete: status === "COMPLETED",
    provider_created_time_ms: Date.now(),
    checked_at: new Date().toISOString(),
  };
}
