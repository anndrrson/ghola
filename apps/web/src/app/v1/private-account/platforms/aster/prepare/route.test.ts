import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { ASTER_V3_AGENT_MAX_LIFETIME_MS } from "@/lib/aster-agent-onboarding";
import { POST } from "./route";

const OWNER = "0x2222222222222222222222222222222222222222";
const SIGNER = "0x3333333333333333333333333333333333333333";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(body: unknown) {
  return new Request("https://ghola.test/v1/private-account/platforms/aster/prepare", {
    method: "POST",
    headers: {
      authorization: auth("aster_prepare_user"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Aster programmatic credential preparation", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-secret";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://fapi.asterdex.com/fapi/v3/time") {
        return Response.json({ serverTime: 1_800_000_000_000 });
      }
      if (url === "https://worker.example/venues/aster/credentials/prepare") {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const recipient = "phala:cvm:aster-test";
        return Response.json({
          version: 1,
          venue_id: "aster",
          network: "mainnet",
          owner_address: payload.owner_address,
          signer_address: SIGNER,
          encrypted_execution_vault: {
            alg: "sealed-provider-v1",
            ciphertext: "sealed-ciphertext",
            recipient,
            aad: [
              "ghola/aster-execution-vault-v1",
              `account:${payload.account_commitment}`,
              `recipient:${recipient}`,
              "network:mainnet",
            ].join("|"),
          },
          attested_signer: {
            public_address: SIGNER,
            provider: "phala",
            worker_id: recipient,
            attestation_sha256: `sha256:${"ab".repeat(32)}`,
            private_key_exposed: false,
          },
          permissions: {
            can_read: true,
            can_trade: true,
            can_spot_trade: false,
            can_perp_trade: true,
            can_withdraw: false,
            can_transfer: false,
            can_manage_credentials: false,
            can_export_secret: false,
            unknown_scopes: [],
          },
          owner_authorization: { required: true, status: "signature_required" },
          setup: { may_place_trade: false, transaction_broadcast: false },
        }, { status: 201 });
      }
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    });
  });

  afterEach(async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_CONNECTOR_MODE;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN;
    delete process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET;
    vi.restoreAllMocks();
    await resetPrivateAccountStoreForTests();
  });

  it("returns one explicit owner-signature contract without registering or trading", async () => {
    const response = await POST(request({ owner_address: OWNER, agent_name: "ghola-perps" }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      venue_id: "aster",
      credential_provisioning_mode: "programmatic_generated",
      owner_approval_required: true,
      setup: {
        may_place_trade: false,
        transaction_broadcast: false,
        credential_registered: false,
      },
    });
    expect(body.contract.ownerAuthorization).toMatchObject({
      required: true,
      status: "signature_required",
      ownerAddress: OWNER,
    });
    expect(body.contract.permissions).toEqual({
      canSpotTrade: false,
      canPerpTrade: true,
      canWithdraw: false,
    });
    expect(body.contract.approval.typedData.primaryType).toBe("ApproveAgent");
    expect(body.contract.approval.parametersWithoutSignature.expired).toBe(
      1_800_000_000_000 + ASTER_V3_AGENT_MAX_LIFETIME_MS,
    );
    expect(body.authorization_expires_at).toBe(
      new Date(1_800_000_000_000 + ASTER_V3_AGENT_MAX_LIFETIME_MS).toISOString(),
    );
    expect(JSON.stringify(body)).not.toContain("api_wallet_private_key");

    const workerCall = vi.mocked(globalThis.fetch).mock.calls.find(([url]) =>
      String(url).includes("/venues/aster/credentials/prepare"),
    );
    expect(workerCall?.[1]?.headers).toMatchObject({
      "x-ghola-sealed-execution-required": "true",
    });
    const authorization = (workerCall?.[1]?.headers as Record<string, string>).authorization;
    expect(authorization).toMatch(/^Bearer ghcap_v1\./);
  });

  it("rejects an invalid owner before generating a signer", async () => {
    const response = await POST(request({ owner_address: "not-an-address" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "aster_owner_address_invalid" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects broader permissions or a worker identity that differs from the vault recipient", async () => {
    let invalidMode: "permissions" | "worker_binding" = "permissions";
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/fapi/v3/time")) return Response.json({ serverTime: 1_800_000_000_000 });
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const recipient = "phala:cvm:aster-test";
      return Response.json({
        version: 1,
        venue_id: "aster",
        network: "mainnet",
        owner_address: payload.owner_address,
        signer_address: SIGNER,
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-ciphertext",
          recipient,
          aad: `ghola/aster-execution-vault-v1|account:${payload.account_commitment}|recipient:${recipient}|network:mainnet`,
        },
        attested_signer: {
          public_address: SIGNER,
          provider: "phala",
          worker_id: invalidMode === "worker_binding" ? "phala:cvm:other-worker" : recipient,
          attestation_sha256: `sha256:${"ab".repeat(32)}`,
          private_key_exposed: false,
        },
        permissions: {
          can_read: true,
          can_trade: true,
          can_spot_trade: false,
          can_perp_trade: true,
          can_withdraw: invalidMode === "permissions",
          can_transfer: false,
          can_manage_credentials: false,
          can_export_secret: false,
          unknown_scopes: [],
        },
        setup: { may_place_trade: false, transaction_broadcast: false },
      }, { status: 201 });
    });
    const response = await POST(request({ owner_address: OWNER }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "aster_worker_response_invalid" });

    invalidMode = "worker_binding";
    const mismatchedWorker = await POST(request({ owner_address: OWNER }));
    expect(mismatchedWorker.status).toBe(502);
    expect(await mismatchedWorker.json()).toEqual({ error: "aster_worker_response_invalid" });
  });
});
