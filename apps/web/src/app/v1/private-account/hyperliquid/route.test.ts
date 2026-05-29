import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GET as vaultStatus,
  POST as sealVault,
} from "./vault/route";
import { POST as armAgent } from "./agent/session/route";
import { POST as accountSnapshot } from "./account-snapshot/route";
import { POST as allocateManaged } from "./managed-allocation/route";
import { GET as hyperliquidStatus } from "./status/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

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

function vaultAad(accountCommitment: string, recipient = "mock_attested:dev") {
  return [
    "ghola/hyperliquid-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient}`,
    "network:mainnet",
  ].join("|");
}

describe("Hyperliquid private-account routes", () => {
  beforeEach(() => {
    process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
  });

  afterEach(async () => {
    delete process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED;
    delete process.env.GHOLA_HYPERLIQUID_LIVE_MODE;
    await resetPrivateAccountStoreForTests();
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
    const statusRes = await hyperliquidStatus(
      request("/v1/private-account/hyperliquid/status"),
    );
    const status = await statusRes.json();

    expect(statusRes.status).toBe(200);
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
      }),
    );
    const sealed = await sealRes.json();

    expect(sealRes.status).toBe(201);
    expect(sealed.ready).toBe(true);
    expect(sealed.hyperliquid_execution_vault.vault_commitment).toMatch(/^hyperliquid_execution_vault_/);
    expect(JSON.stringify(sealed)).not.toContain("raw-secret");
    expect(JSON.stringify(sealed)).not.toContain("strategy_text");

    const statusRes = await vaultStatus(request("/v1/private-account/hyperliquid/vault"));
    const status = await statusRes.json();
    expect(status.ready).toBe(true);
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
    expect(status.connection.ready).toBe(true);
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
    expect(ready.status).toBe("ready_to_trade");
    expect(ready.account_source).toBe("ghola_managed");
    expect(JSON.stringify(ready)).not.toContain("hyperliquid_account_id");
    expect(JSON.stringify(ready)).not.toContain("api_wallet_private_key");
    expect(JSON.stringify(ready)).not.toContain("orders");
  });
});
