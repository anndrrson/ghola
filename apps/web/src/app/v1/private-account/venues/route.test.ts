import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GET as coinbaseVaultStatus,
  POST as sealCoinbaseVault,
} from "./[platform_class]/vault/route";
import { POST as armVenueAgent } from "./[platform_class]/agent/session/route";
import { GET as listVenues } from "./route";
import { GET as venueReadiness } from "./[platform_class]/readiness/route";
import { POST as createSecretHandle } from "./[platform_class]/secret-handles/create/route";
import { POST as createStealthAccount } from "./[platform_class]/stealth-account/create/route";
import { POST as preflightVenue } from "./[platform_class]/preflight/route";
import { GET as omnibusStatus } from "../omnibus/status/route";
import { POST as allocateOmnibus } from "../omnibus/allocate/route";
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
      authorization: auth("coinbase_user_1"),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ platform_class: "coinbase_style_provider" }) };
}

function venueParams(venueId: string) {
  return { params: Promise.resolve({ platform_class: venueId }) };
}

function vaultAad(accountCommitment: string, recipient = "mock_attested:dev") {
  return [
    "ghola/coinbase-advanced-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient}`,
    "mode:byo_api_key",
    "network:mainnet",
  ].join("|");
}

describe("Coinbase venue and omnibus routes", () => {
  beforeEach(() => {
    process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
  });

  afterEach(async () => {
    delete process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    await resetPrivateAccountStoreForTests();
  });

  it("allocates a commitment-only Coinbase omnibus subledger", async () => {
    const allocateRes = await allocateOmnibus(
      request("/v1/private-account/omnibus/allocate", {
        settlement_funding_commitment: "funding_import_commitment_test",
        utilization_bucket: "5",
      }),
    );
    const allocated = await allocateRes.json();

    expect(allocateRes.status).toBe(201);
    expect(allocated.ready).toBe(true);
    expect(allocated.allocation.allocation_commitment).toMatch(/^omnibus_allocation_/);
    expect(JSON.stringify(allocated)).not.toContain("api_key");

    const statusRes = await omnibusStatus(request("/v1/private-account/omnibus/status"));
    const status = await statusRes.json();
    expect(status.ready).toBe(true);
    expect(status.allocation.allocation_commitment).toBe(allocated.allocation.allocation_commitment);
  });

  it("stores only sealed Coinbase BYO API-key vault artifacts", async () => {
    const preflightRes = await coinbaseVaultStatus(
      request("/v1/private-account/venues/coinbase_style_provider/vault"),
      params(),
    );
    const preflight = await preflightRes.json();
    const sealRes = await sealCoinbaseVault(
      request("/v1/private-account/venues/coinbase_style_provider/vault", {
        execution_mode: "byo_api_key",
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-coinbase-vault-only",
          recipient: "mock_attested:dev",
          aad: vaultAad(preflight.account_commitment),
        },
      }),
      params(),
    );
    const sealed = await sealRes.json();

    expect(sealRes.status).toBe(201);
    expect(sealed.ready).toBe(true);
    expect(sealed.venue_execution_vault.vault_commitment).toMatch(/^venue_execution_vault_/);
    expect(JSON.stringify(sealed)).not.toContain("sealed-coinbase-vault-only");
    expect(JSON.stringify(sealed)).not.toContain("api_private_key");

    const armRes = await armVenueAgent(
      request("/v1/private-account/venues/coinbase_style_provider/agent/session", {
        execution_mode: "byo_api_key",
        market_allowlist: ["BTC-USD"],
        max_notional_bucket: "25",
      }),
      params(),
    );
    const armed = await armRes.json();

    expect(armRes.status).toBe(201);
    expect(armed.status).toBe("armed");
    expect(armed.agent_session_commitment).toMatch(/^venue_agent_session_/);
  });

  it("rejects raw Coinbase credentials at web boundaries", async () => {
    const res = await sealCoinbaseVault(
      request("/v1/private-account/venues/coinbase_style_provider/vault", {
        encrypted_execution_vault: {
          api_key_name: "organizations/raw/apiKeys/raw",
          private_key: "raw-pem",
        },
      }),
      params(),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("forbidden");
  });

  it("creates Phoenix secret-gravity artifacts without raw secrets", async () => {
    const venuesRes = await listVenues(request("/v1/private-account/venues"));
    const venues = await venuesRes.json();

    expect(venuesRes.status).toBe(200);
    expect(venues.venues.map((item: { manifest: { venue_id: string } }) => item.manifest.venue_id))
      .toContain("phoenix");

    const readinessRes = await venueReadiness(
      request("/v1/private-account/venues/phoenix/readiness"),
      venueParams("phoenix"),
    );
    const readiness = await readinessRes.json();
    expect(readiness.status).toBe("setup_required");

    const secretRes = await createSecretHandle(
      request("/v1/private-account/venues/phoenix/secret-handles/create", {
        account_mode: "user_stealth",
        purpose: "trader_authority",
        encrypted_secret_commitment: "encrypted_secret_commitment_test",
        sealed_runtime_recipient_commitment: "sealed_recipient_commitment_test",
      }),
      venueParams("phoenix"),
    );
    const secret = await secretRes.json();

    expect(secretRes.status).toBe(201);
    expect(secret.secret_handle.secret_handle_commitment).toMatch(/^secret_handle_/);
    expect(JSON.stringify(secret)).not.toContain("api_wallet_private_key");

    const stealthRes = await createStealthAccount(
      request("/v1/private-account/venues/phoenix/stealth-account/create", {
        secret_handle_commitment: secret.secret_handle.secret_handle_commitment,
      }),
      venueParams("phoenix"),
    );
    const stealth = await stealthRes.json();

    expect(stealthRes.status).toBe(201);
    expect(stealth.venue_account.venue_account_commitment).toMatch(/^stealth_venue_account_/);
    expect(stealth.venue_account.main_wallet_exposed).toBe(false);
    expect(stealth.venue_account.venue_account_visible_to_venue).toBe(true);

    const preflightRes = await preflightVenue(
      request("/v1/private-account/venues/phoenix/preflight", {
        account_mode: "user_stealth",
      }),
      venueParams("phoenix"),
    );
    const preflight = await preflightRes.json();

    expect(preflightRes.status).toBe(200);
    expect(preflight.main_wallet_hidden).toBe(true);
    expect(preflight.venue_account_hidden).toBe(false);
    expect(preflight.venue_sees).toBe("stealth venue account and order");
  });

  it("arms Phoenix and Jupiter BYO venue agent sessions after sealing scoped access", async () => {
    const cases = [
      {
        platformClass: "solana_perps_market",
        venueId: "phoenix",
        aadPrefix: "ghola/solana-perps-execution-vault-v1",
        ciphertext: "sealed-phoenix-agent-vault",
        marketAllowlist: ["SOL-PERP"],
      },
      {
        platformClass: "solana_swap_aggregator",
        venueId: "jupiter",
        aadPrefix: "ghola/solana-swap-execution-vault-v1",
        ciphertext: "sealed-jupiter-agent-vault",
        marketAllowlist: ["SOL/USDC"],
      },
    ];

    for (const item of cases) {
      const statusRes = await coinbaseVaultStatus(
        request(`/v1/private-account/venues/${item.platformClass}/vault`),
        venueParams(item.platformClass),
      );
      const status = await statusRes.json();
      const aad = [
        item.aadPrefix,
        `account:${status.account_commitment}`,
        "recipient:mock_attested:dev",
        "mode:user_stealth",
        "network:mainnet",
        `venue:${item.venueId}`,
      ].join("|");

      const sealRes = await sealCoinbaseVault(
        request(`/v1/private-account/venues/${item.platformClass}/vault`, {
          execution_mode: "user_stealth",
          encrypted_execution_vault: {
            alg: "sealed-provider-v1",
            ciphertext: item.ciphertext,
            recipient: "mock_attested:dev",
            aad,
          },
        }),
        venueParams(item.platformClass),
      );
      expect(sealRes.status).toBe(201);

      const armRes = await armVenueAgent(
        request(`/v1/private-account/venues/${item.platformClass}/agent/session`, {
          execution_mode: "user_stealth",
          market_allowlist: item.marketAllowlist,
          max_notional_bucket: "5",
          max_order_count: 3,
        }),
        venueParams(item.platformClass),
      );
      const armed = await armRes.json();

      expect(armRes.status).toBe(201);
      expect(armed).toMatchObject({
        status: "armed",
        venue_id: item.venueId,
        platform_class: item.platformClass,
        execution_mode: "user_stealth",
      });
      expect(armed.agent_session_commitment).toMatch(/^venue_agent_session_/);
      expect(JSON.stringify(armed)).not.toContain(item.ciphertext);
    }
  });
});
