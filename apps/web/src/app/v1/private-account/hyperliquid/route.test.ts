import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as vaultStatus,
  POST as sealVault,
} from "./vault/route";
import { POST as armAgent } from "./agent/session/route";
import { POST as accountSnapshot } from "./account-snapshot/route";
import { GET as accountStream } from "./account-stream/route";
import { GET as agentAuthorization } from "./agent-authorization/route";
import { POST as allocateManaged } from "./managed-allocation/route";
import { GET as hyperliquidRoot } from "./route";
import { GET as hyperliquidStatus } from "./status/route";
import { POST as createBalanceFundingIntent } from "../balance/funding-intent/route";
import { POST as importBalanceCredit } from "../balance/import-credit/route";
import { POST as verifyVenueEligibility } from "../venues/[platform_class]/eligibility/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { signHyperliquidApiWalletBinding } from "@/lib/hyperliquid-api-wallet";

const TEST_HYPERLIQUID_OWNER = "0x1111111111111111111111111111111111111111";
const TEST_HYPERLIQUID_AGENT = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const TEST_HYPERLIQUID_AGENT_KEY = `0x${"00".repeat(31)}01`;

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(path: string, body?: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      authorization: auth("hyperliquid_user_1"),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function requestWithHeaders(path: string, body: unknown, headers: Record<string, string>) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: auth("hyperliquid_user_1"),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function acceptHyperliquidLaunchTerms(countryCode = "CA") {
  const res = await verifyVenueEligibility(
    requestWithHeaders("/v1/private-account/venues/hyperliquid/eligibility", {
      accepted_terms: true,
      accepted_risk: true,
      jurisdiction_assertion: "non_us",
      country_code: countryCode,
    }, { "x-ghola-test-country": countryCode }),
    { params: Promise.resolve({ platform_class: "hyperliquid" }) },
  );
  expect(res.status).toBe(201);
  return res.json();
}

async function creditGholaBalance(amountBucket = "1000") {
  const intentRes = await createBalanceFundingIntent(
    request("/v1/private-account/balance/funding-intent", {
      amount_bucket: amountBucket,
      asset_bucket: "stablecoin",
    }),
  );
  expect(intentRes.status).toBe(201);
  const intent = await intentRes.json();
  const importRes = await importBalanceCredit(
    request("/v1/private-account/balance/import-credit", {
      funding_intent_id: intent.instruction.funding_intent_id,
      receipt_id: `custom_receipt_hyperliquid_balance_${amountBucket}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    }),
  );
  expect(importRes.status).toBe(201);
  return importRes.json();
}

async function readSseEvent(res: Response, eventName: string) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("missing response body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const event = block
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim();
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (event === eventName && data) return JSON.parse(data);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`missing SSE event ${eventName}`);
}

function vaultAad(accountCommitment: string, recipient = "mock_attested:dev") {
  return [
    "ghola/hyperliquid-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient}`,
    "network:mainnet",
  ].join("|");
}

function credentialBinding(accountCommitment: string) {
  return signHyperliquidApiWalletBinding({
    privateKey: TEST_HYPERLIQUID_AGENT_KEY,
    accountCommitment,
    network: "mainnet",
    ownerAddress: TEST_HYPERLIQUID_OWNER,
  });
}

describe("Hyperliquid private-account routes", () => {
  beforeEach(() => {
    process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([{
      address: TEST_HYPERLIQUID_AGENT,
      name: "ghola-test",
      validUntil: null,
    }]), { status: 200, headers: { "content-type": "application/json" } }));
  });

  afterEach(async () => {
    delete process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER;
    delete process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_KEY_ID;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE;
    delete process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED;
    delete process.env.GHOLA_HYPERLIQUID_LIVE_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL;
    delete process.env.GHOLA_PRIVATE_AGENT_PROVIDER;
    delete process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET;
    delete process.env.GHOLA_CONNECTOR_MODE;
    vi.restoreAllMocks();
    await resetPrivateAccountStoreForTests();
  });

  it("reports the exact owner-to-agent authorization without submitting an order", async () => {
    const res = await agentAuthorization(request(
      `/v1/private-account/hyperliquid/agent-authorization?network=mainnet&owner=${TEST_HYPERLIQUID_OWNER}&agent=${TEST_HYPERLIQUID_AGENT}`,
    ));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      network: "mainnet",
      owner_address: TEST_HYPERLIQUID_OWNER,
      agent_address: TEST_HYPERLIQUID_AGENT,
      status: "authorized",
      authorized: true,
      active_named_agent_count: 1,
      named_agent_limit: 3,
      preferred_agent_name: "ghola",
      preferred_name_in_use: false,
      named_slot_available: true,
    });
  });

  it("reports an unapproved agent so only that pending wallet may be replaced", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json([]));
    const res = await agentAuthorization(request(
      `/v1/private-account/hyperliquid/agent-authorization?network=mainnet&owner=${TEST_HYPERLIQUID_OWNER}&agent=${TEST_HYPERLIQUID_AGENT}`,
    ));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("not_authorized");
    expect(body.authorized).toBe(false);
  });

  it("reports a full named-agent account before the user opens a wallet prompt", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json([
      { name: "alpha", address: `0x${"aa".repeat(20)}`, validUntil: null },
      { name: "beta", address: `0x${"bb".repeat(20)}`, validUntil: null },
      { name: "gamma", address: `0x${"cc".repeat(20)}`, validUntil: null },
    ]));
    const res = await agentAuthorization(request(
      `/v1/private-account/hyperliquid/agent-authorization?network=mainnet&owner=${TEST_HYPERLIQUID_OWNER}&agent=${TEST_HYPERLIQUID_AGENT}`,
    ));
    const body = await res.json();

    expect(body).toMatchObject({
      authorized: false,
      active_named_agent_count: 3,
      named_agent_limit: 3,
      preferred_name_in_use: false,
      named_slot_available: false,
    });
  });

  it("allows deterministic replacement of an existing Ghola named slot", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json([
      { name: "ghola", address: `0x${"aa".repeat(20)}`, validUntil: null },
      { name: "beta", address: `0x${"bb".repeat(20)}`, validUntil: null },
      { name: "gamma", address: `0x${"cc".repeat(20)}`, validUntil: null },
    ]));
    const res = await agentAuthorization(request(
      `/v1/private-account/hyperliquid/agent-authorization?network=mainnet&owner=${TEST_HYPERLIQUID_OWNER}&agent=${TEST_HYPERLIQUID_AGENT}`,
    ));
    const body = await res.json();

    expect(body).toMatchObject({
      authorized: false,
      active_named_agent_count: 3,
      preferred_name_in_use: true,
      named_slot_available: true,
    });
  });

  it("does not count Hyperliquid's separate unnamed API wallet as a named slot", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json([
      { name: "", address: `0x${"dd".repeat(20)}`, validUntil: null },
      { name: "alpha", address: `0x${"aa".repeat(20)}`, validUntil: null },
      { name: "beta", address: `0x${"bb".repeat(20)}`, validUntil: null },
    ]));
    const res = await agentAuthorization(request(
      `/v1/private-account/hyperliquid/agent-authorization?network=mainnet&owner=${TEST_HYPERLIQUID_OWNER}&agent=${TEST_HYPERLIQUID_AGENT}`,
    ));
    const body = await res.json();

    expect(body).toMatchObject({
      authorized: false,
      active_named_agent_count: 2,
      named_agent_limit: 3,
      named_slot_available: true,
    });
  });

  it("fails closed when Hyperliquid authorization cannot be checked", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network unavailable"));
    const res = await agentAuthorization(request(
      `/v1/private-account/hyperliquid/agent-authorization?network=mainnet&owner=${TEST_HYPERLIQUID_OWNER}&agent=${TEST_HYPERLIQUID_AGENT}`,
    ));

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("hyperliquid_binding_check_unavailable");
  });

  it("requires a client-sealed encrypted execution vault bundle", async () => {
    const sealRes = await sealVault(
      request("/v1/private-account/hyperliquid/vault", {}),
    );
    const body = await sealRes.json();

    expect(sealRes.status).toBe(400);
    expect(body.error).toBe("encrypted_execution_vault_required");
  });

  it("reports missing BYO venue access without jurisdiction gating", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    const rootRes = await hyperliquidRoot(
      request("/v1/private-account/hyperliquid"),
    );
    const root = await rootRes.json();
    const statusRes = await hyperliquidStatus(
      request("/v1/private-account/hyperliquid/status"),
    );
    const status = await statusRes.json();

    expect(rootRes.status).toBe(200);
    expect(root.platform_class).toBe("hyperliquid_style_market");
    expect(statusRes.status).toBe(200);
    expect(status.hyperliquid_connection_status).toBe("connect_account");
    expect(status.no_submit_verification_status).toBe("not_run");
    expect(status.ready_to_attempt_broadcast).toBe(false);
    expect(status.final_venue_execution_proven).toBe(false);
    expect(status.final_fill_proven).toBe(false);
    expect(status.connection.ready).toBe(false);
    expect(status.gates.reason_codes).toContain("venue_access_required");
    expect(status.gates.reason_codes).not.toContain("restricted_jurisdiction");
    expect(JSON.stringify(status).toLowerCase()).not.toContain("bypass");
    expect(JSON.stringify(status).toLowerCase()).not.toContain("jurisdiction");
  });

  it("rejects stale or mismatched Hyperliquid vault recipients", async () => {
    const preflightRes = await vaultStatus(request("/v1/private-account/hyperliquid/vault"));
    const preflight = await preflightRes.json();
    const sealRes = await sealVault(
      request("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-ciphertext-only",
          recipient: "phala:cvm:stale",
          aad: vaultAad(preflight.account_commitment, "phala:cvm:stale"),
        },
      }),
    );
    const body = await sealRes.json();

    expect(sealRes.status).toBe(400);
    expect(body.error).toBe("encrypted_execution_vault_recipient_mismatch");
  });

  it("rejects a signed API wallet claim when Hyperliquid does not bind it to the owner", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json([]));
    const preflight = await (await vaultStatus(
      request("/v1/private-account/hyperliquid/vault"),
    )).json();
    const sealRes = await sealVault(
      request("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-ciphertext-only",
          recipient: "mock_attested:dev",
          aad: vaultAad(preflight.account_commitment),
        },
        credential_binding: await credentialBinding(preflight.account_commitment),
      }),
    );

    expect(sealRes.status).toBe(400);
    expect((await sealRes.json()).error).toBe("hyperliquid_agent_not_authorized");
  });

  it("accepts the configured local worker recipient instead of a hardcoded mock recipient", async () => {
    const recipient = "phala:cvm:local-worker";
    process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_KEY_ID = recipient;
    const preflight = await (await vaultStatus(
      request("/v1/private-account/hyperliquid/vault"),
    )).json();
    const sealRes = await sealVault(
      request("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-ciphertext-only",
          recipient,
          aad: vaultAad(preflight.account_commitment, recipient),
        },
        credential_binding: await credentialBinding(preflight.account_commitment),
      }),
    );

    expect(sealRes.status).toBe(201);
    expect((await sealRes.json()).credentials_sealed).toBe(true);
  });

  it("rejects plaintext execution vault and strategy fields at the web boundary", async () => {
    const vaultRes = await sealVault(
      request("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          api_secret: "raw-secret",
        },
      }),
    );
    const vaultBody = await vaultRes.json();

    expect(vaultRes.status).toBe(400);
    expect(vaultBody.error).toContain("forbidden");

    const agentRes = await armAgent(
      request("/v1/private-account/hyperliquid/agent/session", {
        strategy_text: "buy ETH with raw prompt",
      }),
    );
    const agentBody = await agentRes.json();

    expect(agentRes.status).toBe(400);
    expect(agentBody.error).toContain("forbidden");
  });

  it("rejects Hyperliquid agent session mutations without live proof headers when enforcement is enabled", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "enforce";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = "secure_private_account_request_proof_secret_32bytes";

    const agentRes = await armAgent(
      request("/v1/private-account/hyperliquid/agent/session", {
        market_allowlist: ["ETH", "BTC"],
        max_notional_bucket: "25",
        max_order_count: 3,
      }),
    );
    const body = await agentRes.json();

    expect(agentRes.status).toBe(403);
    expect(body.error).toBe("request_proof_required");
  });

  it("stores only sealed Hyperliquid vault artifacts and arms a capped session policy", async () => {
    const preflightRes = await vaultStatus(request("/v1/private-account/hyperliquid/vault"));
    const preflight = await preflightRes.json();
    const sealRes = await sealVault(
      request("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-ciphertext-only",
          recipient: "mock_attested:dev",
          aad: vaultAad(preflight.account_commitment),
        },
        credential_binding: await credentialBinding(preflight.account_commitment),
      }),
    );
    const sealed = await sealRes.json();

    expect(sealRes.status).toBe(201);
    expect(sealed.ready).toBe(false);
    expect(sealed.credentials_sealed).toBe(true);
    expect(sealed.hyperliquid_execution_vault.vault_commitment).toMatch(/^hyperliquid_execution_vault_/);
    expect(JSON.stringify(sealed)).not.toContain("raw-secret");
    expect(JSON.stringify(sealed)).not.toContain("strategy_text");

    const statusRes = await vaultStatus(request("/v1/private-account/hyperliquid/vault"));
    const status = await statusRes.json();
    expect(status.ready).toBe(false);
    expect(status.credentials_sealed).toBe(true);
    expect(JSON.stringify(status)).not.toContain("sealed-ciphertext-only");

    const armRes = await armAgent(
      request("/v1/private-account/hyperliquid/agent/session", {
        market_allowlist: ["ETH", "BTC"],
        max_notional_bucket: "25",
        max_order_count: 3,
      }),
    );
    const armed = await armRes.json();

    expect(armRes.status).toBe(201);
    expect(armed.status).toBe("armed");
    expect(armed.agent_session_commitment).toMatch(/^hyperliquid_agent_session_/);
    expect(armed.session_policy.policy_commitment).toMatch(/^hyperliquid_session_policy_/);
    expect(armed.session_policy.strategy_commitment).toMatch(/^hyperliquid_strategy_/);
    expect(JSON.stringify(armed)).not.toContain("sealed-ciphertext-only");
  });

  it("arms the capped Hyperliquid session on the selected private worker", async () => {
    const preflight = await (await vaultStatus(
      request("/v1/private-account/hyperliquid/vault"),
    )).json();
    const sealed = await (await sealVault(
      request("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-ciphertext-only",
          recipient: "mock_attested:dev",
          aad: vaultAad(preflight.account_commitment),
        },
        credential_binding: await credentialBinding(preflight.account_commitment),
      }),
    )).json();
    process.env.GHOLA_CONNECTOR_MODE = "http";
    process.env.GHOLA_PRIVATE_AGENT_PROVIDER = "mock_attested";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "test-worker-capability-secret";
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string"
        ? input
        : input instanceof URL ? input.href : input.url);
      if (url.hostname === "worker.example" && url.pathname === "/hyperliquid/sessions") {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer ghcap_v1\./);
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          version: 1,
          account_commitment: preflight.account_commitment,
          execution_mode: "byo_api_key",
          policy_commitment: sealed.hyperliquid_execution_vault.policy_commitment,
        });
        expect(body.encrypted_execution_vault.ciphertext).toBe("sealed-ciphertext-only");
        return Response.json({
          status: "armed",
          hyperliquid_session_commitment: "hyperliquid_session_worker_proof",
        }, { status: 201 });
      }
      return Response.json([{
        address: TEST_HYPERLIQUID_AGENT,
        name: "ghola-test",
        validUntil: null,
      }]);
    });

    const armRes = await armAgent(
      request("/v1/private-account/hyperliquid/agent/session", {
        market_allowlist: ["HYPE"],
        max_notional_bucket: "25",
        max_order_count: 3,
      }),
    );
    const armed = await armRes.json();

    expect(armRes.status).toBe(201);
    expect(armed.status).toBe("armed");
    expect(armed.agent_session_commitment).toBe("hyperliquid_session_worker_proof");
  });

  it("surfaces worker capability drift without retrying the session", async () => {
    const preflight = await (await vaultStatus(
      request("/v1/private-account/hyperliquid/vault"),
    )).json();
    await sealVault(
      request("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-ciphertext-only",
          recipient: "mock_attested:dev",
          aad: vaultAad(preflight.account_commitment),
        },
        credential_binding: await credentialBinding(preflight.account_commitment),
      }),
    );
    process.env.GHOLA_CONNECTOR_MODE = "http";
    process.env.GHOLA_PRIVATE_AGENT_PROVIDER = "mock_attested";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "stale-preview-secret";
    let sessionAttempts = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = new URL(typeof input === "string"
        ? input
        : input instanceof URL ? input.href : input.url);
      if (url.hostname === "worker.example" && url.pathname === "/hyperliquid/sessions") {
        sessionAttempts += 1;
        return Response.json({
          error: "worker capability signature is invalid",
          error_code: "worker_capability_invalid",
        }, { status: 403 });
      }
      return Response.json([{
        address: TEST_HYPERLIQUID_AGENT,
        name: "ghola-test",
        validUntil: null,
      }]);
    });

    const armRes = await armAgent(
      request("/v1/private-account/hyperliquid/agent/session", {
        market_allowlist: ["HYPE"],
        max_notional_bucket: "25",
        max_order_count: 3,
      }),
    );

    expect(armRes.status).toBe(400);
    await expect(armRes.json()).resolves.toEqual({ error: "worker_authorization_misconfigured" });
    expect(sessionAttempts).toBe(1);
  });

  it("allocates a managed Hyperliquid testnet account and reports simple gates", async () => {
    const allocationRes = await allocateManaged(
      request("/v1/private-account/hyperliquid/managed-allocation", {
        market_allowlist: ["BTC", "ETH"],
        max_notional_bucket: "25",
        max_order_count: 3,
      }),
    );
    const allocated = await allocationRes.json();

    expect(allocationRes.status).toBe(201);
    expect(allocated.ready).toBe(true);
    expect(allocated.managed_allocation.execution_mode).toBe("managed_testnet");
    expect(allocated.managed_allocation.network).toBe("testnet");
    expect(allocated.managed_allocation.allocation_commitment).toMatch(/^hyperliquid_managed_allocation_/);
    expect(JSON.stringify(allocated)).not.toContain("credential_ref");
    expect(JSON.stringify(allocated)).not.toContain("api_wallet_private_key");

    const statusRes = await hyperliquidStatus(
      request("/v1/private-account/hyperliquid/status"),
    );
    const status = await statusRes.json();

    expect(statusRes.status).toBe(200);
    expect(status.hyperliquid_connection_status).toBe("check_connection");
    expect(status.no_submit_verification_status).toBe("not_run");
    expect(status.ready_to_attempt_broadcast).toBe(false);
    expect(status.final_venue_execution_proven).toBe(false);
    expect(status.final_fill_proven).toBe(false);
    expect(status.connection.ready).toBe(false);
    expect(status.connection.credentials_sealed).toBe(true);
    expect(status.connection.mode).toBe("managed_testnet");
    expect(status.gates.can_connect).toBe(true);
    expect(status.gates.can_read).toBe(true);
    expect(status.gates.can_trade).toBe(false);
    expect(status.visibility.hyperliquid_sees).toContain("order");

    const armRes = await armAgent(
      request("/v1/private-account/hyperliquid/agent/session", {
        execution_mode: "managed_testnet",
        market_allowlist: ["BTC"],
        max_notional_bucket: "25",
      }),
    );
    const armed = await armRes.json();

    expect(armRes.status).toBe(201);
    expect(armed.execution_mode).toBe("managed_testnet");
    expect(armed.allocation_commitment).toBe(allocated.managed_allocation.allocation_commitment);
  });

  it("requires explicit non-US terms acceptance before Hyperliquid pooled allocation", async () => {
    const allocationRes = await allocateManaged(
      request("/v1/private-account/hyperliquid/managed-allocation", {
        execution_mode: "ghola_pooled",
        market_allowlist: ["BTC", "ETH"],
        max_notional_bucket: "1000",
        max_order_count: 3,
      }),
    );
    const body = await allocationRes.json();

    expect(allocationRes.status).toBe(400);
    expect(body.error).toBe("venue_eligibility_required");

    const missingTermsRes = await verifyVenueEligibility(
      request("/v1/private-account/venues/hyperliquid/eligibility", {
        credential_type: "self_attested_eligible_user",
      }),
      { params: Promise.resolve({ platform_class: "hyperliquid" }) },
    );
    const missingTerms = await missingTermsRes.json();

    expect(missingTermsRes.status).toBe(400);
    expect(missingTerms.error).toBe("terms_acceptance_required");
  });

  it("rejects US Hyperliquid pooled launch eligibility", async () => {
    const eligibilityRes = await verifyVenueEligibility(
      requestWithHeaders("/v1/private-account/venues/hyperliquid/eligibility", {
        accepted_terms: true,
        accepted_risk: true,
        jurisdiction_assertion: "non_us",
        country_code: "CA",
      }, { "x-ghola-test-country": "US" }),
      { params: Promise.resolve({ platform_class: "hyperliquid" }) },
    );
    const body = await eligibilityRes.json();

    expect(eligibilityRes.status).toBe(400);
    expect(body.error).toBe("restricted_jurisdiction");
  });

  it("requires Ghola balance for Hyperliquid pooled launch caps", async () => {
    const eligibility = await acceptHyperliquidLaunchTerms("CA");
    expect(eligibility.eligibility.launch_scope).toBe("hyperliquid_pooled_non_us_beta");
    expect(eligibility.eligibility.terms_version).toBe("ghola-public-beta-2026-06-13");

    const allocationRes = await allocateManaged(
      request("/v1/private-account/hyperliquid/managed-allocation", {
        execution_mode: "ghola_pooled",
        market_allowlist: ["BTC", "ETH"],
        max_notional_bucket: "1000",
        max_order_count: 3,
      }),
    );
    const body = await allocationRes.json();

    expect(allocationRes.status).toBe(400);
    expect(body.error).toBe("ghola_balance_insufficient");
  });

  it("allocates Hyperliquid pooled access after terms and Ghola balance", async () => {
    await acceptHyperliquidLaunchTerms("CA");
    await creditGholaBalance("1000");

    const allocationRes = await allocateManaged(
      request("/v1/private-account/hyperliquid/managed-allocation", {
        execution_mode: "ghola_pooled",
        market_allowlist: ["BTC", "ETH", "SOL"],
        max_notional_bucket: "1000",
        max_order_count: 10,
      }),
    );
    const allocated = await allocationRes.json();

    expect(allocationRes.status).toBe(201);
    expect(allocated.ready).toBe(true);
    expect(allocated.ghola_balance.available_micro_usdc).toBe(1_000_000_000);
    expect(allocated.managed_allocation.execution_mode).toBe("ghola_pooled");
    expect(allocated.managed_allocation.network).toBe("mainnet");
    expect(allocated.managed_allocation.session_policy.max_notional_bucket).toBe("1000");
    expect(allocated.managed_allocation.eligibility_commitment).toMatch(/^venue_eligibility_/);
    expect(allocated.managed_allocation.funding_evidence_commitment).toMatch(/^ghola_balance_funding_evidence_/);

    const armRes = await armAgent(
      request("/v1/private-account/hyperliquid/agent/session", {
        execution_mode: "ghola_pooled",
        market_allowlist: ["BTC"],
        max_notional_bucket: "1000",
        max_order_count: 3,
      }),
    );
    const armed = await armRes.json();

    expect(armRes.status).toBe(201);
    expect(armed.execution_mode).toBe("ghola_pooled");
    expect(armed.session_policy.max_notional_bucket).toBe("1000");
    expect(armed.allocation_commitment).toBe(allocated.managed_allocation.allocation_commitment);
  });

  it("reports account snapshot readiness without raw venue fields", async () => {
    const missingRes = await accountSnapshot(
      request("/v1/private-account/hyperliquid/account-snapshot", {}),
    );
    const missing = await missingRes.json();

    expect(missingRes.status).toBe(200);
    expect(missing.status).toBe("venue_access_required");
    expect(missing.account_source).toBe("none");

    await allocateManaged(
      request("/v1/private-account/hyperliquid/managed-allocation", {
        market_allowlist: ["BTC"],
        max_notional_bucket: "25",
      }),
    );
    const readyRes = await accountSnapshot(
      request("/v1/private-account/hyperliquid/account-snapshot", {}),
    );
    const ready = await readyRes.json();

    expect(readyRes.status).toBe(200);
    expect(ready.status).toBe("worker_unavailable");
    expect(ready.trading_enabled).toBe(false);
    expect(ready.account_source).toBe("ghola_managed");
    expect(JSON.stringify(ready)).not.toContain("hyperliquid_account_id");
    expect(JSON.stringify(ready)).not.toContain("api_wallet_private_key");
    expect(JSON.stringify(ready)).not.toContain("\"orders\"");
  });

  it("streams account state without raw venue fields", async () => {
    await allocateManaged(
      request("/v1/private-account/hyperliquid/managed-allocation", {
        market_allowlist: ["BTC"],
        max_notional_bucket: "25",
      }),
    );
    const streamRes = await accountStream(
      request("/v1/private-account/hyperliquid/account-stream?coin=BTC"),
    );
    const state = await readSseEvent(streamRes, "account_state");

    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
    expect(state.status).toBe("private_mode_waiting");
    expect(state.stream_status).toBe("connecting");
    expect(state.visibility_summary.main_wallet_exposed).toBe(false);
    expect(state.visibility_summary.hyperliquid_sees).toContain("order");
    expect(JSON.stringify(state)).not.toContain("hyperliquid_account_id");
    expect(JSON.stringify(state)).not.toContain("api_wallet_private_key");
    expect(JSON.stringify(state)).not.toContain("\"orders\"");
  });
});
