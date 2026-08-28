import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createHash, createHmac, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import {
  carryCreationOpportunityAuthenticationMessage,
  carryPrivatePrimeWorkerAuthenticationMessage,
} from "@ghola/execution-core";
import { POST as postArbCanaryReport } from "@/app/v1/private-account/agent-passport/arb-canary-report/route";
import { POST as armArbRoute } from "@/app/v1/private-account/agent-passport/arm-arb/route";
import { POST as linkPlatformRoute } from "@/app/v1/private-account/platforms/link/route";
import { POST as carryRoute } from "@/app/v1/private-account/carry/route";
import {
  privateAccountOwnerFromRequest,
  createOrGetStoredPrivateAccount,
  type PrivateAccountRequestOwner,
} from "@/app/v1/private-account/_lib";
import {
  agentPassportReadinessForOwner,
  linkAgentPlatformFromBody,
} from "./private-agent-passport";
import {
  getVenueExecutionVaultByAccount,
  putPrivateVenueCapability,
  resetPrivateAccountStoreForTests,
} from "./private-account-store";

const owner: PrivateAccountRequestOwner = {
  owner_commitment: "owner_passport_test",
  user: {
    id: "owner_passport_test",
    email: "owner_passport_test@example.com",
  },
};
const carrySigner = generateKeyPairSync("ed25519");
const carrySignerPublicKeyB64 = carrySigner.publicKey.export({ format: "der", type: "spki" }).toString("base64");

describe("agent passport venue linking", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.PRIVATE_AGENT_ARB_LIVE_SUBMIT;
    delete process.env.PRIVATE_AGENT_TRI_VENUE_ARB_LIVE_SUBMIT;
    delete process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD;
    delete process.env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD;
    delete process.env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS;
    delete process.env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS;
    delete process.env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN;
    delete process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL;
    delete process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN;
    delete process.env.GHOLA_PRIVATE_AGENT_WORKER_URL;
    delete process.env.PRIVATE_AGENT_WORKER_URL;
    delete process.env.PRIVATE_AGENT_WORKER_TOKEN;
    delete process.env.PHALA_AGENT_ENDPOINT;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.GHOLA_ARB_CANARY_MAX_STALE_MS;
    delete process.env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64;
  });

  it("records sealed trade-only venue capabilities and blocks withdrawal scopes", async () => {
    const linked = await linkAgentPlatformFromBody({
      venue_id: "coinbase_advanced",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("coinbase"),
    }, owner, new Date("2026-06-03T12:00:00.000Z"));

    expect("error" in linked).toBe(false);
    if ("error" in linked) return;
    expect(linked.capability.venue_id).toBe("coinbase_advanced");
    expect(linked.capability.can_read).toBe(true);
    expect(linked.capability.can_trade).toBe(true);
    expect(linked.capability.can_withdraw).toBe(false);
    expect(linked.capability.vault_commitment).toMatch(/^venue_execution_vault_/);

    const blocked = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: tradeOnlyPermissions({ can_withdraw: true }),
      encrypted_execution_vault: sealedVault("hyperliquid"),
    }, owner);

    expect(blocked).toEqual({ error: "withdrawal_permission_blocked" });

    const lighter = await linkAgentPlatformFromBody({
      venue_id: "lighter",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("lighter"),
    }, owner);
    expect("error" in lighter).toBe(false);
    if (!("error" in lighter)) {
      expect(lighter.capability.venue_id).toBe("lighter");
      expect(lighter.capability.can_withdraw).toBe(false);
    }

    const transferBlocked = await linkAgentPlatformFromBody({
      venue_id: "lighter",
      permission_attestation: tradeOnlyPermissions({ can_transfer: true }),
      encrypted_execution_vault: sealedVault("lighter"),
    }, owner);
    expect(transferBlocked).toEqual({ error: "transfer_permission_blocked" });
  });

  it("fails closed when admin, export, or unknown-scope evidence is missing", async () => {
    const incomplete = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: {
        can_read: true,
        can_trade: true,
        can_withdraw: false,
        can_transfer: false,
      },
      encrypted_execution_vault: sealedVault("secret-must-not-return"),
    }, owner);

    expect(incomplete).toEqual({ error: "permission_attestation_incomplete" });
    expect(JSON.stringify(incomplete)).not.toContain("secret-must-not-return");
  });

  it.each([
    ["can_manage_credentials", "credential_admin_permission_blocked"],
    ["can_export_secret", "secret_export_permission_blocked"],
    ["unknown_scopes", "unknown_permission_scope_blocked"],
  ] as const)("blocks unsafe %s evidence before persisting the vault", async (field, error) => {
    const permission = tradeOnlyPermissions(field === "unknown_scopes"
      ? { unknown_scopes: ["account:admin"] }
      : { [field]: true });
    const linked = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: permission,
      encrypted_execution_vault: sealedVault(`unsafe-${field}`),
    }, owner);

    expect(linked).toEqual({ error });
    const account = await createOrGetStoredPrivateAccount(owner);
    expect(await getVenueExecutionVaultByAccount({
      account_commitment: account.account_commitment,
      venue_id: "hyperliquid",
      execution_mode: "byo_api_key",
    })).toBeNull();
    expect(JSON.stringify(linked)).not.toContain(`unsafe-${field}`);
  });

  it("requires complete owner authorization and non-exportable custody for programmatic setup", async () => {
    const incomplete = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      provisioning_mode: "turnkey_delegated",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("turnkey-incomplete"),
    }, owner);
    expect(incomplete).toEqual({ error: "explicit_owner_authorization_required" });

    const linked = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      provisioning_mode: "turnkey_delegated",
      turnkey_role: "venue_owner",
      owner_authorization_source: "turnkey_venue_owner",
      explicit_owner_authorization: true,
      owner_binding_verified: true,
      secret_handling: "turnkey_non_exportable",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("turnkey-complete"),
    }, owner);
    expect("error" in linked).toBe(false);
  });

  it("accepts Aster programmatic provisioning only after explicit owner authorization", async () => {
    const linked = await linkAgentPlatformFromBody({
      venue_id: "aster",
      provisioning_mode: "programmatic_generated",
      turnkey_role: "none",
      owner_authorization_source: "external_owner_signature",
      explicit_owner_authorization: true,
      owner_binding_verified: true,
      secret_handling: "direct_to_attested_runtime",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("aster-programmatic"),
    }, owner);
    expect("error" in linked).toBe(false);
  });

  it("accepts verified external or Turnkey-owner Lighter association", async () => {
    const external = await linkAgentPlatformFromBody({
      venue_id: "lighter",
      provisioning_mode: "programmatic_generated",
      turnkey_role: "none",
      owner_authorization_source: "external_owner_signature",
      explicit_owner_authorization: true,
      owner_binding_verified: true,
      secret_handling: "direct_to_attested_runtime",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("lighter-future"),
    }, owner);
    expect("error" in external).toBe(false);

    const linked = await linkAgentPlatformFromBody({
      venue_id: "lighter",
      provisioning_mode: "programmatic_generated",
      turnkey_role: "venue_owner",
      owner_authorization_source: "turnkey_venue_owner",
      explicit_owner_authorization: true,
      owner_binding_verified: true,
      secret_handling: "direct_to_attested_runtime",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("lighter-turnkey-owner"),
    }, owner);
    expect("error" in linked).toBe(false);
  });

  it("rejects unsupported manual venue linking even in local verification mode", async () => {
    const linked = await linkAgentPlatformFromBody({
      venue_id: "backpack",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("backpack-unsupported"),
    }, owner);
    expect(linked).toEqual({ error: "venue_not_supported" });
  });

  it("does not send unsupported or unsafe sealed vaults to the worker", async () => {
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    let workerCalls = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      workerCalls += 1;
      return new Response(JSON.stringify({ status: "verified" }), { status: 200 });
    }) as typeof fetch;

    try {
      const unsupported = await linkAgentPlatformFromBody({
        venue_id: "backpack",
        permission_attestation: tradeOnlyPermissions(),
        encrypted_execution_vault: sealedVault("must-not-send-unsupported"),
      }, owner);
      const unsafe = await linkAgentPlatformFromBody({
        venue_id: "hyperliquid",
        permission_attestation: tradeOnlyPermissions({ can_export_secret: true }),
        encrypted_execution_vault: sealedVault("must-not-send-unsafe"),
      }, owner);

      expect(unsupported).toEqual({ error: "venue_not_supported" });
      expect(unsafe).toEqual({ error: "secret_export_permission_blocked" });
      expect(workerCalls).toBe(0);
      expect(JSON.stringify({ unsupported, unsafe })).not.toContain("must-not-send");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("downgrades legacy ready capabilities until they pass the credential contract", async () => {
    const account = await createOrGetStoredPrivateAccount(owner);
    await putPrivateVenueCapability({
      version: 1,
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      venue_id: "hyperliquid",
      capability_commitment: "legacy_capability_without_contract_evidence",
      status: "ready",
      capability: {
        can_read: true,
        can_trade: true,
        can_withdraw: false,
      },
      created_at: "2026-06-03T12:00:00.000Z",
      updated_at: "2026-06-03T12:00:00.000Z",
    });

    const readiness = await agentPassportReadinessForOwner(owner);
    const hyperliquid = readiness.passport.venues.find((venue) => venue.venue_id === "hyperliquid");
    expect(hyperliquid).toMatchObject({
      status: "blocked",
      can_read: false,
      can_trade: false,
      reason_codes: expect.arrayContaining(["credential_contract_reverification_required"]),
    });
    expect(readiness.can_arm).toBe(false);
  });

  it("does not persist an encrypted venue vault before worker verification succeeds", async () => {
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: "rejected" }), { status: 400 })) as typeof fetch;

    try {
      const linked = await linkAgentPlatformFromBody({
        venue_id: "aster",
        permission_attestation: tradeOnlyPermissions(),
        encrypted_execution_vault: sealedVault("aster"),
      }, owner);
      expect(linked).toEqual({ error: "credential_verification_failed" });

      const account = await createOrGetStoredPrivateAccount(owner);
      expect(await getVenueExecutionVaultByAccount({
        account_commitment: account.account_commitment,
        venue_id: "aster",
        execution_mode: "byo_api_key",
      })).toBeNull();
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("links two Carry venues through authenticated routes and forwards only sealed access to no-submit", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL = "https://worker.example";
    process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN = "worker-token";
    process.env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 = carrySignerPublicKeyB64;
    const workerBodies: Record<string, unknown>[] = [];
    let tamperCarryOpportunity = false;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      workerBodies.push(body);
      if (url === "https://worker.example/venues/credentials/verify") {
        return new Response(JSON.stringify({
          status: "verified",
          can_read: true,
          can_trade: true,
          can_withdraw: false,
        }), { status: 200 });
      }
      if (url === "https://worker.example/carry/preflight") {
        const creationOpportunity = authenticatedCarryOpportunity(String(body.owner_commitment || ""));
        if (tamperCarryOpportunity) creationOpportunity.projected_net_value_micro_usdc = 999;
        return new Response(JSON.stringify({
          no_submit_ready: true,
          transaction_broadcast: false,
          live_creation_ready: true,
          creation_opportunity: creationOpportunity,
        }), { status: 200 });
      }
      return oldFetch(input, init);
    }) as typeof fetch;

    try {
      for (const venue of ["aster", "lighter"] as const) {
        const response = await linkPlatformRoute(authedPost("/v1/private-account/platforms/link", {
          venue_id: venue,
          execution_mode: "byo_api_key",
          permission_attestation: tradeOnlyPermissions(),
          encrypted_execution_vault: sealedVault(venue),
        }));
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(201);
        expect(body.capability.venue_id).toBe(venue);
        expect(JSON.stringify(body)).not.toContain(`sealed-${venue}-vault`);
        expect(JSON.stringify(body)).not.toContain("encrypted_execution_vault");
      }

      const response = await carryRoute(new NextRequest("https://ghola.test/v1/private-account/carry", {
        method: "POST",
        headers: {
          authorization: "Bearer investor-test-token",
          "content-type": "application/json",
          "x-ghola-correlation-id": "ghola-carry-pair-test-0001",
          origin: "https://ghola.test",
        },
        body: JSON.stringify({
          action: "preflight_pair",
          asset: "BTC",
          long_venue_id: "aster",
          short_venue_id: "lighter",
          notional_usd: "11",
          horizon_days: "1",
        }),
      }));
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(response.headers.get("x-ghola-correlation-id")).toBe("ghola-carry-pair-test-0001");
      expect(result.no_submit_ready).toBe(true);

      const preflight = workerBodies.find((body) => body.operation_class === "paired_no_submit");
      const access = preflight?.venue_access as Record<string, Record<string, unknown>>;
      expect(access.aster.encrypted_execution_vault).toMatchObject({ ciphertext: "sealed-aster-vault" });
      expect(access.lighter.encrypted_execution_vault).toMatchObject({ ciphertext: "sealed-lighter-vault" });
      expect(preflight).not.toHaveProperty("api_private_key");
      expect(preflight).not.toHaveProperty("api_wallet_private_key");

      tamperCarryOpportunity = true;
      const tampered = await carryRoute(new NextRequest("https://ghola.test/v1/private-account/carry", {
        method: "POST",
        headers: {
          authorization: "Bearer investor-test-token",
          "content-type": "application/json",
          origin: "https://ghola.test",
        },
        body: JSON.stringify({
          action: "preflight_pair",
          asset: "BTC",
          long_venue_id: "aster",
          short_venue_id: "lighter",
          notional_usd: "11",
          horizon_days: "1",
        }),
      }));
      expect(tampered.status).toBe(502);
      expect(await tampered.json()).toMatchObject({
        error: "carry_creation_opportunity_worker_authentication_invalid",
      });
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("forwards all three sealed Carry venues through one no-submit matrix", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    const matrixBodies: Record<string, unknown>[] = [];
    const readinessBodies: Record<string, unknown>[] = [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      if (url === "https://worker.example/venues/credentials/verify") {
        return new Response(JSON.stringify({ status: "verified", can_read: true, can_trade: true, can_withdraw: false }), { status: 200 });
      }
      if (url === "https://worker.example/carry/preflight-matrix") {
        matrixBodies.push(body);
        return new Response(JSON.stringify(authenticatedPrivatePrimeResult(body, "/carry/preflight-matrix", {
          mode: "carry_execution_no_submit_matrix",
          no_submit_ready: true,
          transaction_broadcast: false,
          venues: ["hyperliquid", "lighter", "aster"].map((venue_id) => ({ venue_id, transaction_broadcast: false })),
          failures: [],
        })), { status: 200 });
      }
      if (url === "https://worker.example/carry/readiness") {
        readinessBodies.push(body);
        return new Response(JSON.stringify(authenticatedPrivatePrimeResult(body, "/carry/readiness", {
          ready: true,
          network: "mainnet",
          asset: "BTC",
          notional_usd: "11",
          horizon_days: "1",
          registry_venue_ids: ["hyperliquid", "lighter", "aster"],
          expires_at_ms: Date.now() + 60_000,
          evidence_commitment: "carry:readiness:evidence:test",
        })), { status: 200 });
      }
      return oldFetch(input, init);
    }) as typeof fetch;

    try {
      for (const venue of ["hyperliquid", "lighter", "aster"] as const) {
        const linked = await linkPlatformRoute(authedPost("/v1/private-account/platforms/link", {
          venue_id: venue,
          execution_mode: "byo_api_key",
          permission_attestation: tradeOnlyPermissions(),
          encrypted_execution_vault: sealedVault(venue),
        }));
        expect(linked.status).toBe(201);
      }

      const response = await carryRoute(new NextRequest("https://ghola.test/v1/private-account/carry", {
        method: "POST",
        headers: {
          authorization: "Bearer investor-test-token",
          "content-type": "application/json",
          origin: "https://ghola.test",
        },
        body: JSON.stringify({ action: "preflight_matrix", asset: "BTC", notional_usd: "11", horizon_days: "1" }),
      }));
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result.no_submit_ready).toBe(true);
      expect(result.transaction_broadcast).toBe(false);

      expect(matrixBodies).toHaveLength(1);
      const matrixBody = matrixBodies[0];
      const access = matrixBody.venue_access as Record<string, Record<string, unknown>>;
      expect(Object.keys(access).sort()).toEqual(["aster", "hyperliquid", "lighter"]);
      for (const venue of Object.keys(access)) {
        expect(access[venue].owner_commitment).toBe(matrixBody.owner_commitment);
        expect(access[venue].encrypted_execution_vault).toMatchObject({ ciphertext: `sealed-${venue}-vault` });
      }
      expect(matrixBody).not.toHaveProperty("api_private_key");
      expect(matrixBody).not.toHaveProperty("api_wallet_private_key");

      const readinessResponse = await carryRoute(new NextRequest("https://ghola.test/v1/private-account/carry", {
        method: "POST",
        headers: {
          authorization: "Bearer investor-test-token",
          "content-type": "application/json",
          origin: "https://ghola.test",
        },
        body: JSON.stringify({ action: "readiness", asset: "BTC", notional_usd: "11", horizon_days: "1" }),
      }));
      const readinessResult = await readinessResponse.json();
      expect(readinessResponse.status, JSON.stringify(readinessResult)).toBe(200);
      expect(readinessResult.ready).toBe(true);
      expect(readinessBodies).toHaveLength(1);
      expect(readinessBodies[0]).toMatchObject({ asset: "BTC", notional_usd: "11", horizon_days: "1" });
      const readinessAccess = readinessBodies[0].venue_access as Record<string, Record<string, unknown>>;
      expect(Object.keys(readinessAccess).sort()).toEqual(["aster", "hyperliquid", "lighter"]);
      for (const venue of Object.keys(readinessAccess)) {
        expect(readinessAccess[venue].owner_commitment).toBe(readinessBodies[0].owner_commitment);
        expect(readinessAccess[venue].encrypted_execution_vault).toMatchObject({ ciphertext: `sealed-${venue}-vault` });
      }
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("forwards sanitized missing-venue markers so ready Carry pairs still produce evidence", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    const matrixBodies: Record<string, unknown>[] = [];
    const readinessBodies: Record<string, unknown>[] = [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      if (url === "https://worker.example/venues/credentials/verify") {
        return new Response(JSON.stringify({ status: "verified", can_read: true, can_trade: true, can_withdraw: false }), { status: 200 });
      }
      if (url === "https://worker.example/carry/preflight-matrix") {
        matrixBodies.push(body);
        return new Response(JSON.stringify(authenticatedPrivatePrimeResult(body, "/carry/preflight-matrix", {
          mode: "carry_execution_no_submit_matrix",
          no_submit_ready: false,
          transaction_broadcast: false,
          pairs: [
            { long_venue_id: "hyperliquid", short_venue_id: "lighter", no_submit_ready: true, transaction_broadcast: false },
            { long_venue_id: "aster", short_venue_id: "hyperliquid", no_submit_ready: false, transaction_broadcast: false, error_code: "carry_account_not_ready:aster" },
            { long_venue_id: "lighter", short_venue_id: "aster", no_submit_ready: false, transaction_broadcast: false, error_code: "carry_account_not_ready:aster" },
          ],
          failures: ["pair_check_failed:2:carry_account_not_ready:aster", "pair_check_failed:3:carry_account_not_ready:aster"],
        })), { status: 200 });
      }
      if (url === "https://worker.example/carry/readiness") {
        readinessBodies.push(body);
        return new Response(JSON.stringify(authenticatedPrivatePrimeResult(body, "/carry/readiness", {
          ready: false,
          reasons: ["carry_readiness_evidence_missing"],
          diagnostic: { available: true, diagnostic_only: true, reusable_for_readiness: false },
        })), { status: 200 });
      }
      return oldFetch(input, init);
    }) as typeof fetch;

    try {
      for (const venue of ["hyperliquid", "lighter"] as const) {
        const linked = await linkPlatformRoute(authedPost("/v1/private-account/platforms/link", {
          venue_id: venue,
          execution_mode: "byo_api_key",
          permission_attestation: tradeOnlyPermissions(),
          encrypted_execution_vault: sealedVault(venue),
        }));
        expect(linked.status).toBe(201);
      }

      const response = await carryRoute(new NextRequest("https://ghola.test/v1/private-account/carry", {
        method: "POST",
        headers: {
          authorization: "Bearer investor-test-token",
          "content-type": "application/json",
          origin: "https://ghola.test",
        },
        body: JSON.stringify({ action: "preflight_matrix", asset: "BTC", notional_usd: "11", horizon_days: "1" }),
      }));
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result.no_submit_ready).toBe(false);
      expect(result.transaction_broadcast).toBe(false);

      const access = matrixBodies[0].venue_access as Record<string, Record<string, unknown>>;
      expect(access.hyperliquid.status).toBe("ready");
      expect(access.lighter.status).toBe("ready");
      expect(access.aster).toEqual({
        status: "not_ready",
        owner_commitment: matrixBodies[0].owner_commitment,
      });
      expect(JSON.stringify(access.aster)).not.toContain("vault");

      const restoredResponse = await carryRoute(new NextRequest("https://ghola.test/v1/private-account/carry", {
        method: "POST",
        headers: {
          authorization: "Bearer investor-test-token",
          "content-type": "application/json",
          origin: "https://ghola.test",
        },
        body: JSON.stringify({ action: "readiness", asset: "BTC", notional_usd: "11", horizon_days: "1" }),
      }));
      const restored = await restoredResponse.json();
      expect(restoredResponse.status, JSON.stringify(restored)).toBe(200);
      expect(restored.ready).toBe(false);
      expect(restored.diagnostic).toMatchObject({ diagnostic_only: true, reusable_for_readiness: false });
      const restoredAccess = readinessBodies[0].venue_access as Record<string, Record<string, unknown>>;
      expect(restoredAccess.aster).toEqual({
        status: "not_ready",
        owner_commitment: readinessBodies[0].owner_commitment,
      });
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("surfaces Carry worker authorization drift without blaming venue wallets", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "stale-preview-secret";
    const oldFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://worker.example/carry/preflight-matrix") {
        attempts += 1;
        return Response.json({
          error: "worker capability signature is invalid",
          error_code: "worker_capability_invalid",
        }, { status: 403 });
      }
      return oldFetch(input);
    }) as typeof fetch;

    try {
      const result = await carryRoute(new NextRequest("https://ghola.test/v1/private-account/carry", {
        method: "POST",
        headers: {
          authorization: "Bearer investor-test-token",
          "content-type": "application/json",
          origin: "https://ghola.test",
        },
        body: JSON.stringify({
          action: "preflight_matrix",
          asset: "BTC",
          notional_usd: "11",
          horizon_days: "1",
        }),
      }));

      expect(result.status).toBe(503);
      await expect(result.json()).resolves.toMatchObject({
        error: "carry_worker_authorization_misconfigured",
      });
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = oldFetch;
      delete process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET;
    }
  });

  it("keeps guarded SOL arbitrage blocked while Backpack credential verification is unsupported", async () => {
    await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("hyperliquid"),
    }, owner);
    let readiness = await agentPassportReadinessForOwner(owner);
    expect(readiness.can_arm).toBe(false);
    expect(readiness.blockers).toEqual(expect.arrayContaining(["phoenix_required", "backpack_required"]));

    await linkAgentPlatformFromBody({
      venue_id: "phoenix",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("phoenix"),
    }, owner);
    const backpack = await linkAgentPlatformFromBody({
      venue_id: "backpack",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("backpack"),
    }, owner);
    process.env.PRIVATE_AGENT_ARB_LIVE_SUBMIT = "true";
    process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD = "25";
    process.env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD = "100";
    process.env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS = "25";
    process.env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS = "2000";
    process.env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS = "2000";

    readiness = await agentPassportReadinessForOwner(owner);
    expect(backpack).toEqual({ error: "venue_not_supported" });
    expect(readiness.can_arm).toBe(false);
    expect(readiness.can_live_submit).toBe(false);
    expect(readiness.ready_venues).toEqual(expect.arrayContaining(["hyperliquid", "phoenix"]));
    expect(readiness.blockers).toContain("backpack_required");
  });

  it("rejects arm-arb until Agent Passport has a hedged venue pair", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";

    const res = await armArbRoute(authedPost("/v1/private-account/agent-passport/arm-arb", {
      mode: "no_submit",
      market: "SOL-USD",
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("agent_passport_not_ready");
    expect(body.blockers).toContain("hyperliquid_required");
  });

  it("stores arb canary diagnostics without making Agent Passport readiness depend on them", async () => {
    let readiness = await agentPassportReadinessForOwner(owner, new Date("2026-06-03T12:00:00.000Z"));
    expect(readiness.can_arm).toBe(false);
    expect(readiness.arb_canary_required).toBe(false);
    expect(readiness.arb_canary_status).toBe("missing");
    expect(readiness.blockers).toContain("hyperliquid_required");
    expect(readiness.blockers).not.toContain("agent_arb_canary_missing");

    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = "internal_agent_arb_canary_token_32_bytes";
    const reportRes = await postArbCanaryReport(internalPost("/v1/private-account/agent-passport/arb-canary-report", {
      canary_id: "arb_canary_green_123",
      status: "no_submit_pair_verified",
      mode: "no_submit",
      market: "SOL-USD",
      worker_url: "https://worker.example/private/path",
      completed_at: "2026-06-03T12:01:00.000Z",
      leg_notional_usd: 5,
      checks: [
        { name: "coinbase no-submit preflight", ok: true, result_commitment: "result_coinbase" },
        { name: "hyperliquid no-submit preflight", ok: true, result_commitment: "result_hyperliquid" },
      ],
      preflight: {
        coinbase: { verification_commitment: "verify_coinbase" },
        hyperliquid: { verification_commitment: "verify_hyperliquid" },
      },
    }));
    const reportBody = await reportRes.json();
    expect(reportRes.status, JSON.stringify(reportBody)).toBe(202);
    expect(reportBody.report.status).toBe("green");

    readiness = await agentPassportReadinessForOwner(owner, new Date("2026-06-03T12:02:00.000Z"));
    expect(readiness.can_arm).toBe(false);
    expect(readiness.arb_canary_required).toBe(false);
    expect(readiness.arb_canary_status).toBe("green");
    expect(readiness.arb_canary_report).not.toBeNull();
    if (!readiness.arb_canary_report) throw new Error("expected arb canary report");
    expect(readiness.arb_canary_report.worker_url).toBe("https://worker.example");
    expect(readiness.blockers).toContain("hyperliquid_required");
    expect(readiness.blockers).not.toContain("agent_arb_canary_missing");
  });

  it("rejects arb canary reports that include secret-looking fields", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = "internal_agent_arb_canary_token_32_bytes";
    const res = await postArbCanaryReport(internalPost("/v1/private-account/agent-passport/arb-canary-report", {
      canary_id: "arb_canary_secret_123",
      status: "failed",
      mode: "no_submit",
      market: "SOL-USD",
      completed_at: "2026-06-03T12:01:00.000Z",
      checks: [{ name: "fatal", ok: false, error: "failed" }],
      api_private_key_pem: "-----BEGIN PRIVATE KEY-----",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_agent_arb_canary_report");
    expect(body.reason_codes).toContain("secret_field_rejected");
  });

  it("fails arm-arb before contacting the worker when a required venue is unsupported", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";

    const routeOwner = await privateAccountOwnerFromRequest(authedPost("/v1/private-account/agent-passport/arm-arb", {}));
    expect(routeOwner).not.toBeNull();
    if (!routeOwner) return;
    const linkedHyperliquid = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("hyperliquid"),
    }, routeOwner);
    const linkedPhoenix = await linkAgentPlatformFromBody({
      venue_id: "phoenix",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("phoenix"),
    }, routeOwner);
    const linkedBackpack = await linkAgentPlatformFromBody({
      venue_id: "backpack",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("backpack"),
    }, routeOwner);
    expect("error" in linkedHyperliquid).toBe(false);
    expect("error" in linkedPhoenix).toBe(false);
    expect(linkedBackpack).toEqual({ error: "venue_not_supported" });

    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "token";

    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://worker.example/autopilot/sessions") {
        return new Response(JSON.stringify({ error: "worker_booting" }), { status: 503 });
      }
      return oldFetch(input);
    }) as typeof fetch;

    try {
      const res = await armArbRoute(authedPost("/v1/private-account/agent-passport/arm-arb", {
        mode: "no_submit",
        market: "SOL-USD",
      }));
      const body = await res.json();

      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(body.error).toBe("agent_passport_not_ready");
      expect(body.blockers).toContain("backpack_required");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("does not arm a guarded arbitrage worker with an unsupported credential lane", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    process.env.PRIVATE_AGENT_ARB_LIVE_SUBMIT = "true";
    process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD = "5";
    process.env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD = "25";
    process.env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS = "25";
    process.env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS = "2000";
    process.env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS = "2000";

    const routeOwner = await privateAccountOwnerFromRequest(authedPost("/v1/private-account/agent-passport/arm-arb", {}));
    expect(routeOwner).not.toBeNull();
    if (!routeOwner) return;
    const linkedHyperliquid = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("hyperliquid"),
    }, routeOwner);
    const linkedPhoenix = await linkAgentPlatformFromBody({
      venue_id: "phoenix",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("phoenix"),
    }, routeOwner);
    const linkedBackpack = await linkAgentPlatformFromBody({
      venue_id: "backpack",
      permission_attestation: tradeOnlyPermissions(),
      encrypted_execution_vault: sealedVault("backpack"),
    }, routeOwner);
    expect("error" in linkedHyperliquid).toBe(false);
    expect("error" in linkedPhoenix).toBe(false);
    expect(linkedBackpack).toEqual({ error: "venue_not_supported" });

    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "token";

    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://worker.example/autopilot/sessions") {
        return new Response(JSON.stringify({
          version: 1,
          session: {
            version: 2,
            autopilot_session_id: "worker_arb_123",
            worker_session_commitment: "worker_arb_commitment_123",
            status: "running",
            strategy: {
              version: 1,
              strategy_id: "hedged_spread_arbitrage_v1",
              decision_model: "rules_plus_ai_score",
              executable_order_source: "deterministic_guarded_arb_planner",
              ai_can_execute_directly: false,
            },
            session_policy: {
              strategy_id: "hedged_spread_arbitrage_v1",
              venue_allowlist: ["phoenix", "hyperliquid", "backpack"],
              market_allowlist: ["SOL-USD"],
              max_notional_bucket: "5",
              max_daily_notional_bucket: "25",
              max_order_count: 4,
              ttl_ms: 60 * 60_000,
              max_slippage_bps: 25,
              cooldown_ms: 60_000,
              data_max_age_ms: 2_000,
              min_net_edge_bps: 25,
              max_execution_skew_ms: 2000,
              kill_switch: false,
              policy_commitment: "worker_arb_policy",
            },
            venue_access: {
              phoenix: { status: "ready", execution_mode: "byo_api_key", reason: "agent_passport_ready" },
              hyperliquid: { status: "ready", execution_mode: "byo_api_key", reason: "agent_passport_ready" },
              backpack: { status: "ready", execution_mode: "byo_api_key", reason: "agent_passport_ready" },
            },
            order_count: 0,
            daily_notional_used_bucket: "0",
            updated_at: "2026-06-03T12:00:00.000Z",
            expires_at: "2026-06-03T13:00:00.000Z",
            next_step: "Bounded intent executor is running.",
            execution_enabled: true,
          },
          events: [],
        }), { status: 201 });
      }
      return oldFetch(input);
    }) as typeof fetch;

    try {
      const res = await armArbRoute(authedPost("/v1/private-account/agent-passport/arm-arb", {
        mode: "tiny_live",
        market: "SOL-USD",
      }));
      const body = await res.json();

      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(body.error).toBe("agent_passport_not_ready");
      expect(body.blockers).toContain("backpack_required");
      expect(body.readiness.can_live_submit).toBe(false);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

function sealedVault(label: string) {
  return {
    alg: "sealed-provider-v1",
    ciphertext: `sealed-${label}-vault`,
    recipient: "phala:cvm:test",
    aad: `ghola/${label}-execution-vault-v1|account:acct|recipient:phala:cvm:test`,
  };
}

function tradeOnlyPermissions(overrides: Record<string, unknown> = {}) {
  return {
    can_read: true,
    can_trade: true,
    can_withdraw: false,
    can_transfer: false,
    can_manage_credentials: false,
    can_export_secret: false,
    unknown_scopes: [],
    ...overrides,
  };
}

function authedPost(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer investor-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function internalPost(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer internal_agent_arb_canary_token_32_bytes",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function authenticatedCarryOpportunity(ownerCommitment: string) {
  const checkedAtMs = Date.now();
  const expiresAtMs = checkedAtMs + 60_000;
  const unsigned = {
    version: 1,
    asset: "BTC",
    checked_at_ms: checkedAtMs,
    projected_net_value_micro_usdc: 123,
  };
  const message = carryCreationOpportunityAuthenticationMessage({
    owner_commitment: ownerCommitment,
    opportunity: unsigned,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
  });
  return {
    ...unsigned,
    worker_authentication: {
      version: 1,
      algorithm: "ed25519",
      attestation_bound: true,
      deterministic_only: true,
      checked_at_ms: checkedAtMs,
      expires_at_ms: expiresAtMs,
      evidence_commitment: `carry:creation-opportunity:evidence:${createHash("sha256").update(message).digest("hex")}`,
      signature_b64: signEd25519(null, Buffer.from(message, "utf8"), carrySigner.privateKey).toString("base64"),
      signer_public_key_b64: carrySignerPublicKeyB64,
    },
  };
}

function authenticatedPrivatePrimeResult(
  body: Record<string, unknown>,
  routePath: string,
  result: Record<string, unknown>,
) {
  const checkedAtMs = Date.now();
  const expiresAtMs = checkedAtMs + 5_000;
  const readiness = {
    owner_commitment: body.owner_commitment,
    asset: body.asset,
    evidence_commitment: `carry:private-prime:${"a".repeat(40)}`,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
  };
  const message = carryPrivatePrimeWorkerAuthenticationMessage({
    route_path: routePath,
    owner_commitment: body.owner_commitment,
    asset: body.asset,
    operation_class: body.operation_class,
    work_order_commitment: body.work_order_commitment,
    evidence_commitment: readiness.evidence_commitment,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
  });
  return {
    ...result,
    private_prime_readiness: readiness,
    private_prime_authentication: {
      version: 1,
      algorithm: "hmac-sha256",
      request_bound: true,
      mac_hex: createHmac("sha256", "worker-token").update(message).digest("hex"),
      signature_algorithm: "ed25519",
      attestation_bound: true,
      signature_b64: signEd25519(null, Buffer.from(message, "utf8"), carrySigner.privateKey).toString("base64"),
      signer_public_key_b64: carrySignerPublicKeyB64,
    },
  };
}
