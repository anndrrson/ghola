import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  account: vi.fn(),
  vault: vi.fn(),
  transportAllowed: vi.fn(),
  workerAuth: vi.fn(),
}));

vi.mock("./live-trading-authorization.server", () => ({
  authorizeLiveTradingRiskReduction: mocks.authorize,
}));
vi.mock("./private-account-store", () => ({
  getPrivateAccountByOwner: mocks.account,
  getHyperliquidExecutionVaultByAccount: mocks.vault,
}));
vi.mock("./private-agent-worker-readiness", () => ({
  autopilotWorkerConfig: () => ({ url: new URL("https://worker.test"), token: "worker-token", authConfigured: true }),
}));
vi.mock("./private-agent-spend-policy", () => ({
  privateAgentEmergencyControlTransportAllowed: mocks.transportAllowed,
}));
vi.mock("./private-agent-capability", () => ({
  workerAuthorizationHeader: mocks.workerAuth,
  workerCapabilityExpectedFromBody: (_body: unknown, expected: unknown) => expected,
}));

import {
  HYPERLIQUID_CLOSE_CONFIRMATION,
  closeHyperliquidPositionForOwner,
  parseHyperliquidCloseRequest,
} from "./hyperliquid-risk-reduction.server";

const request = {
  version: 1 as const,
  market: "BTC" as const,
  idempotency_key: "close_test_12345",
  confirmation: HYPERLIQUID_CLOSE_CONFIRMATION as typeof HYPERLIQUID_CLOSE_CONFIRMATION,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ ok: true, account_commitment: "account_commitment_12345", vault_commitment: "vault_commitment_12345" });
  mocks.account.mockResolvedValue({ account_commitment: "account_commitment_12345" });
  mocks.vault.mockResolvedValue(vaultRecord());
  mocks.transportAllowed.mockReturnValue(true);
  mocks.workerAuth.mockReturnValue("Bearer capability");
});

describe("Hyperliquid risk-reduction web boundary", () => {
  it("requires the exact reduce-only close confirmation and idempotency key", () => {
    expect(parseHyperliquidCloseRequest(request)).toEqual(request);
    expect(parseHyperliquidCloseRequest({ ...request, confirmation: "close it" })).toBeNull();
    expect(parseHyperliquidCloseRequest({ ...request, idempotency_key: "short" })).toBeNull();
  });

  it("reuses strict live gates and accepts only venue-filled final-flat evidence", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.market).toBe("BTC");
      expect(body.session_policy.market_allowlist).toEqual(["BTC-USD"]);
      expect(body.session_policy.max_slippage_bps).toBe(100);
      return Response.json(validEvidence());
    }) as unknown as typeof fetch;
    const result = await closeHyperliquidPositionForOwner({
      owner_commitment: "owner_commitment_12345",
      web_session_token: "session-token",
      request,
      env: {},
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fill_summary");
    expect(JSON.stringify(result)).not.toContain("filled_notional_usd");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ required_capabilities: ["reduce_only"] }));
    expect(mocks.workerAuth).toHaveBeenCalledWith(expect.objectContaining({ scope: "order:submit" }));
  });

  it("fails closed when a worker omits reduce-only venue readback", async () => {
    const invalid = validEvidence();
    invalid.closes[0].reduce_only = false as unknown as true;
    const fetchImpl = vi.fn(async () => Response.json(invalid)) as unknown as typeof fetch;
    const result = await closeHyperliquidPositionForOwner({
      owner_commitment: "owner_commitment_12345",
      web_session_token: "session-token",
      request,
      env: {},
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: "hyperliquid_close_evidence_invalid", status: 502 });
  });

  it.each([
    [
      "cross-account AAD",
      "ghola/hyperliquid-execution-vault-v1|account:account_commitment_other|recipient:worker_recipient|network:mainnet",
    ],
    [
      "testnet AAD",
      "ghola/hyperliquid-execution-vault-v1|account:account_commitment_12345|recipient:worker_recipient|network:testnet",
    ],
  ])("rejects %s before calling the worker", async (_label, aad) => {
    mocks.vault.mockResolvedValue(vaultRecord(aad));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await closeHyperliquidPositionForOwner({
      owner_commitment: "owner_commitment_12345",
      web_session_token: "session-token",
      request,
      env: {},
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: "hyperliquid_mainnet_vault_required", status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.workerAuth).not.toHaveBeenCalled();
  });

  it.each([
    ["owner", { owner_commitment: "owner_commitment_other" }],
    ["account", { account_commitment: "account_commitment_other" }],
    ["sealed status", { status: "deleted" }],
  ])("revalidates the vault %s binding before calling the worker", async (_label, overrides) => {
    mocks.vault.mockResolvedValue({ ...vaultRecord(), ...overrides });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await closeHyperliquidPositionForOwner({
      owner_commitment: "owner_commitment_12345",
      web_session_token: "session-token",
      request,
      env: {},
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: "sealed_hyperliquid_vault_required", status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.workerAuth).not.toHaveBeenCalled();
  });
});

function vaultRecord(
  aad = "ghola/hyperliquid-execution-vault-v1|account:account_commitment_12345|recipient:worker_recipient|network:mainnet",
) {
  return {
    owner_commitment: "owner_commitment_12345",
    account_commitment: "account_commitment_12345",
    vault_commitment: "vault_commitment_12345",
    policy_commitment: "policy_commitment_12345",
    status: "sealed",
    vault: {
      encrypted_execution_vault: {
        version: 1,
        recipient: "worker_recipient",
        aad,
        ciphertext_b64: "sealed_ciphertext",
      },
    },
  };
}

function validEvidence() {
  return {
    version: 1,
    proof_kind: "hyperliquid_position_close_v1",
    status: "reconciled",
    network: "mainnet",
    markets: ["BTC"],
    initial_position_count: 1,
    initial_open_order_count: 0,
    cancellations: [],
    closes: [{
      market: "BTC",
      work_order_commitment: "hl_close_work_order_12345",
      venue_order_oid: "987654321",
      venue_order_cloid: "0x1234567890abcdef",
      terminal_status: "filled",
      reduce_only: true as const,
      fill_count_bucket: "1" as const,
      fill_evidence_commitment: "hl_fill_evidence_1234567890",
      fill_summary: { filled_base_size: "0.001", filled_notional_usd: 65.2, average_price: 65_200 },
      venue_readback_proven: true,
      replay_protected: true,
    }],
    reduce_only_exit_proven: true,
    cancellations_terminal: true,
    market_flat: true,
    account_flat: true,
    open_order_count: 0,
    final_flat_proven: true,
    reconciled_at: "2026-08-17T12:00:01.000Z",
    completed_at: "2026-08-17T12:00:02.000Z",
    root_work_order_commitment: "hl_close_root_1234567890",
    evidence_commitment: "hl_risk_evidence_1234567890",
  };
}
