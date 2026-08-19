import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  createHyperliquidApproveAgentAction,
  hyperliquidApproveAgentTypedData,
  parseHyperliquidEvmSignature,
  type HyperliquidAgentAuthorizationRequest,
} from "./hyperliquid-agent-wallet";
import {
  HyperliquidAgentAuthorizationError,
  preflightHyperliquidMasterAccount,
  verifyAndSubmitHyperliquidAgentAuthorization,
} from "./hyperliquid-agent-wallet.server";
import { hyperliquidVaultAssociatedData } from "./hyperliquid-vault-seal";

const MASTER_PRIVATE_KEY = `0x${"11".repeat(32)}` as const;
const AGENT_PRIVATE_KEY = `0x${"22".repeat(32)}` as const;
const MASTER = privateKeyToAccount(MASTER_PRIVATE_KEY);
const AGENT = privateKeyToAccount(AGENT_PRIVATE_KEY);
const ACCOUNT_COMMITMENT = "private_account_test";
const NOW = 1_780_000_000_000;

type VenueOptions = {
  role?: unknown;
  abstraction?: unknown;
  accountValue?: string;
  withdrawable?: string;
  assetPositions?: unknown[];
  spotBalances?: unknown[];
  spotState?: unknown;
  openOrders?: unknown;
  frontendOpenOrders?: unknown;
  exchange?: { status: number; body?: unknown; throws?: boolean };
  agents?: (exchangeCalls: number, queryCalls: number) => unknown;
};

async function signedRequest(nowMs = NOW): Promise<HyperliquidAgentAuthorizationRequest> {
  const action = createHyperliquidApproveAgentAction({
    accountCommitment: ACCOUNT_COMMITMENT,
    agentAddress: AGENT.address,
    nowMs,
  });
  const signature = parseHyperliquidEvmSignature(
    await MASTER.signTypedData(hyperliquidApproveAgentTypedData(action)),
  );
  return {
    version: 1,
    action,
    signature,
    nonce: action.nonce,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: "sealed-ciphertext-without-plaintext-key",
      recipient: "attested:test",
      aad: hyperliquidVaultAssociatedData({
        accountCommitment: ACCOUNT_COMMITMENT,
        recipientId: "attested:test",
        network: "mainnet",
        venueAccountAddress: MASTER.address,
        agentWalletAddress: AGENT.address,
      }),
    },
  };
}

function venue(options: VenueOptions = {}) {
  let exchangeCalls = 0;
  let agentQueryCalls = 0;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith("/exchange")) {
      exchangeCalls += 1;
      if (options.exchange?.throws) throw new TypeError("network failed");
      return response(options.exchange?.body ?? { status: "ok", response: { type: "default" } }, options.exchange?.status ?? 200);
    }
    switch (body.type) {
      case "userRole":
        return response(options.role ?? { role: "user" });
      case "userAbstraction":
        return response(options.abstraction ?? "default");
      case "clearinghouseState":
        return response({
          assetPositions: options.assetPositions ?? [],
          marginSummary: { accountValue: options.accountValue ?? "12" },
          withdrawable: options.withdrawable ?? options.accountValue ?? "12",
        });
      case "spotClearinghouseState":
        return response(options.spotState ?? { balances: options.spotBalances ?? [] });
      case "openOrders":
        return response(options.openOrders ?? []);
      case "frontendOpenOrders":
        return response(options.frontendOpenOrders ?? []);
      case "extraAgents": {
        agentQueryCalls += 1;
        const defaultAgents = exchangeCalls > 0
          ? [{
              name: "ghola-mainnet",
              address: AGENT.address,
              validUntil: NOW + 24 * 60 * 60 * 1_000,
            }]
          : [];
        return response(options.agents?.(exchangeCalls, agentQueryCalls) ?? defaultAgents);
      }
      default:
        return response({ error: "unexpected info request" }, 400);
    }
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    exchangeCalls: () => exchangeCalls,
    agentQueryCalls: () => agentQueryCalls,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(HyperliquidAgentAuthorizationError);
    return error as HyperliquidAgentAuthorizationError;
  }
}

describe("Hyperliquid agent authorization server verification", () => {
  it("recovers the master, submits the exact action, and verifies venue state before accepting", async () => {
    const request = await signedRequest();
    const mock = venue();
    const result = await verifyAndSubmitHyperliquidAgentAuthorization({
      body: request,
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW, sleep: async () => undefined },
    });

    expect(result.authorization).toMatchObject({
      account_address: MASTER.address.toLowerCase(),
      agent_address: AGENT.address.toLowerCase(),
      agent_base_name: "ghola-mainnet",
      valid_until_ms: NOW + 24 * 60 * 60 * 1_000,
      recovered_existing_authorization: false,
    });
    const exchange = mock.calls.find((call) => call.url.endsWith("/exchange"));
    expect(exchange?.body).toEqual({
      action: request.action,
      nonce: request.nonce,
      signature: request.signature,
      vaultAddress: null,
      expiresAfter: null,
    });
    expect(JSON.stringify(exchange)).not.toContain(MASTER_PRIVATE_KEY);
    expect(mock.exchangeCalls()).toBe(1);
  });

  it("is idempotent when the exact named agent already exists", async () => {
    const request = await signedRequest();
    const mock = venue({
      agents: () => [{
        name: request.action.agentName,
        address: request.action.agentAddress,
        validUntil: NOW + 24 * 60 * 60 * 1_000,
      }],
    });
    const result = await verifyAndSubmitHyperliquidAgentAuthorization({
      body: request,
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW, sleep: async () => undefined },
    });
    expect(result.authorization.recovered_existing_authorization).toBe(true);
    expect(mock.exchangeCalls()).toBe(0);
  });

  it("recovers an older cached signature only when its exact agent is already authorized", async () => {
    const request = await signedRequest(NOW - 10 * 60_000);
    const mock = venue({
      agents: () => [{
        name: request.action.agentName,
        address: request.action.agentAddress,
        validUntil: request.action.nonce + 24 * 60 * 60 * 1_000,
      }],
    });
    const result = await verifyAndSubmitHyperliquidAgentAuthorization({
      body: request,
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW, sleep: async () => undefined },
    });
    expect(result.authorization.recovered_existing_authorization).toBe(true);
    expect(mock.exchangeCalls()).toBe(0);
  });

  it("does not submit while the pre-existing agent state is unknown", async () => {
    const mock = venue({ agents: () => [{ malformed: true }] });
    const error = await rejection(verifyAndSubmitHyperliquidAgentAuthorization({
      body: await signedRequest(),
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW, sleep: async () => undefined },
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_authorization_state_unknown", status: 503 });
    expect(mock.exchangeCalls()).toBe(0);
  });

  it("returns rejected only for a canonical venue error plus authoritative absence", async () => {
    const mock = venue({
      exchange: { status: 200, body: { status: "err", response: "invalid agent" } },
      agents: () => [],
    });
    const error = await rejection(verifyAndSubmitHyperliquidAgentAuthorization({
      body: await signedRequest(),
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW, sleep: async () => undefined },
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_authorization_rejected", status: 422 });
  });

  it("returns retry-safe unknown for transport ambiguity even when info still shows absence", async () => {
    const mock = venue({ exchange: { status: 503, body: { error: "upstream" } }, agents: () => [] });
    const error = await rejection(verifyAndSubmitHyperliquidAgentAuthorization({
      body: await signedRequest(),
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW, sleep: async () => undefined },
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_authorization_state_unknown", status: 503 });
  });

  it("fails closed on ambiguous rows for the reserved agent name", async () => {
    const request = await signedRequest();
    const mock = venue({
      agents: () => [{
        name: request.action.agentName,
        address: request.action.agentAddress,
        validUntil: NOW + 24 * 60 * 60 * 1_000,
      }, {
        name: `ghola-mainnet valid_until ${NOW + 1}`,
        address: `0x${"55".repeat(20)}`,
        validUntil: NOW + 1,
      }],
    });
    const error = await rejection(verifyAndSubmitHyperliquidAgentAuthorization({
      body: request,
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW, sleep: async () => undefined },
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_authorization_state_unknown", status: 503 });
  });

  it("rejects an AAD identity mismatch before any venue request", async () => {
    const request = await signedRequest();
    request.encrypted_execution_vault.aad = request.encrypted_execution_vault.aad.replace(
      /agent-wallet:[^|]+/,
      `agent-wallet:hyperliquid_agent_wallet_${"0".repeat(48)}`,
    );
    const mock = venue();
    const error = await rejection(verifyAndSubmitHyperliquidAgentAuthorization({
      body: request,
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW },
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_vault_binding_mismatch", status: 400 });
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects an AAD recipient mismatch before any venue request", async () => {
    const request = await signedRequest();
    request.encrypted_execution_vault.recipient = "attested:other";
    const mock = venue();
    const error = await rejection(verifyAndSubmitHyperliquidAgentAuthorization({
      body: request,
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: { fetchImpl: mock.fetchImpl, now: () => NOW },
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_vault_binding_mismatch", status: 400 });
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects an unrecoverable signature deterministically before venue requests", async () => {
    const mock = venue();
    const error = await rejection(verifyAndSubmitHyperliquidAgentAuthorization({
      body: await signedRequest(),
      accountCommitment: ACCOUNT_COMMITMENT,
      requireEncryptedVault: true,
      dependencies: {
        fetchImpl: mock.fetchImpl,
        now: () => NOW,
        recoverAddress: vi.fn(async () => { throw new Error("bad signature"); }),
      },
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_signature_invalid", status: 400 });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("Hyperliquid master-account preflight", () => {
  it.each([
    ["11.99", false],
    ["12", true],
  ])("requires a conservative $12 funding floor (%s)", async (accountValue, passes) => {
    const mock = venue({ accountValue });
    const run = preflightHyperliquidMasterAccount(MASTER.address, {
      dependencies: { fetchImpl: mock.fetchImpl },
    });
    if (passes) await expect(run).resolves.toMatchObject({ available_value_usd: 12, role: "user" });
    else expect(await rejection(run)).toMatchObject({ code: "hyperliquid_account_funding_required", status: 409 });
  });

  it("blocks trigger-only frontend orders", async () => {
    const mock = venue({ frontendOpenOrders: [{ oid: 1, orderType: "Stop Market" }] });
    const error = await rejection(preflightHyperliquidMasterAccount(MASTER.address, {
      dependencies: { fetchImpl: mock.fetchImpl },
    }));
    expect(error).toMatchObject({ code: "hyperliquid_account_must_be_flat_for_wallet_setup", status: 409 });
  });

  it("counts Spot USDC only for a unified account", async () => {
    const defaultAccount = venue({
      abstraction: "default",
      accountValue: "0",
      withdrawable: "0",
      spotBalances: [{ coin: "USDC", total: "20", hold: "0" }],
    });
    const defaultError = await rejection(preflightHyperliquidMasterAccount(MASTER.address, {
      dependencies: { fetchImpl: defaultAccount.fetchImpl },
    }));
    expect(defaultError).toMatchObject({ code: "hyperliquid_account_funding_required", status: 409 });
    expect(defaultAccount.calls.map((call) => call.body.type)).toContain("userAbstraction");
    expect(defaultAccount.calls.map((call) => call.body.type)).not.toContain("spotClearinghouseState");

    const unifiedAccount = venue({
      abstraction: "unifiedAccount",
      accountValue: "0",
      withdrawable: "0",
      spotBalances: [{ coin: "USDC", total: "13", hold: "1" }],
    });
    await expect(preflightHyperliquidMasterAccount(MASTER.address, {
      dependencies: { fetchImpl: unifiedAccount.fetchImpl },
    })).resolves.toMatchObject({
      account_abstraction: "unifiedAccount",
      available_value_usd: 12,
    });
    expect(unifiedAccount.calls.map((call) => call.body.type)).toContain("spotClearinghouseState");
  });

  it("fails closed on unsupported abstraction or malformed unified Spot state", async () => {
    const unsupported = await rejection(preflightHyperliquidMasterAccount(MASTER.address, {
      dependencies: { fetchImpl: venue({ abstraction: "portfolioMargin" }).fetchImpl },
    }));
    expect(unsupported).toMatchObject({ code: "hyperliquid_account_preflight_unavailable", status: 503 });

    const malformed = await rejection(preflightHyperliquidMasterAccount(MASTER.address, {
      dependencies: {
        fetchImpl: venue({ abstraction: "unifiedAccount", spotState: "malformed" }).fetchImpl,
      },
    }));
    expect(malformed).toMatchObject({ code: "hyperliquid_account_preflight_unavailable", status: 503 });
  });

  it("blocks malformed or non-flat position rows", async () => {
    for (const assetPositions of [[{}], [{ position: { szi: "0.01" } }]]) {
      const mock = venue({ assetPositions });
      const error = await rejection(preflightHyperliquidMasterAccount(MASTER.address, {
        dependencies: { fetchImpl: mock.fetchImpl },
      }));
      expect(error.code).toBe("hyperliquid_account_must_be_flat_for_wallet_setup");
    }
  });

  it("accepts only the exact user role and distinguishes malformed role state", async () => {
    for (const role of ["agent", "vault", "subAccount", "missing"] as const) {
      const error = await rejection(preflightHyperliquidMasterAccount(MASTER.address, {
        dependencies: { fetchImpl: venue({ role: { role } }).fetchImpl },
      }));
      expect(error).toMatchObject({ code: "hyperliquid_master_account_required", status: 422 });
    }
    const malformed = await rejection(preflightHyperliquidMasterAccount(MASTER.address, {
      dependencies: { fetchImpl: venue({ role: { role: "user", unexpected: true } }).fetchImpl },
    }));
    expect(malformed).toMatchObject({ code: "hyperliquid_account_preflight_unavailable", status: 503 });
  });
});
