import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { POST as prepare } from "../prepare/route";
import { POST as complete } from "./route";

const OWNER_KEY = `0x${"42".repeat(32)}` as `0x${string}`;
const OWNER = privateKeyToAccount(OWNER_KEY);
const SIGNER = "0x3333333333333333333333333333333333333333";
const NOW = 1_800_000_000_000;
let credentialVerificationFailures = 0;
let registeredReceipt: Record<string, unknown> | null = null;

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      authorization: auth("aster_complete_user"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Aster programmatic credential completion", () => {
  beforeEach(() => {
    credentialVerificationFailures = 0;
    registeredReceipt = null;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-secret";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://fapi.asterdex.com/fapi/v3/time") {
        return Response.json({ serverTime: NOW });
      }
      if (url.endsWith("/venues/aster/credentials/prepare")) {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const recipient = "phala:cvm:aster-complete-test";
        return Response.json({
          version: 1,
          venue_id: "aster",
          network: "mainnet",
          owner_address: payload.owner_address,
          signer_address: SIGNER,
          encrypted_execution_vault: {
            alg: "sealed-provider-v1",
            ciphertext: "sealed-aster-complete-test",
            recipient,
            aad: `ghola/aster-execution-vault-v1|account:${payload.account_commitment}|recipient:${recipient}|network:mainnet`,
          },
          attested_signer: {
            public_address: SIGNER,
            provider: "phala",
            worker_id: recipient,
            attestation_sha256: `sha256:${"ab".repeat(32)}`,
            private_key_exposed: false,
          },
          permissions: safePermissions(),
          setup: { may_place_trade: false, transaction_broadcast: false },
        }, { status: 201 });
      }
      if (url.endsWith("/venues/aster/credentials/authorize")) {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        registeredReceipt = {
          version: 1,
          venue_id: "aster",
          status: "registered",
          preparation_id: payload.preparation_id,
          owner_address: payload.owner_address,
          signer_address: payload.signer_address,
          permissions: safePermissions(),
          encrypted_execution_vault: payload.encrypted_execution_vault,
          setup: {
            may_place_trade: false,
            transaction_broadcast: false,
            credential_registered: true,
          },
          registered_at: new Date(NOW).toISOString(),
        };
        return Response.json(registeredReceipt, { status: 201 });
      }
      if (url.endsWith("/venues/aster/credentials/receipt")) {
        return registeredReceipt
          ? Response.json(registeredReceipt)
          : Response.json({ error: "aster_registration_receipt_not_found" }, { status: 404 });
      }
      if (url.endsWith("/venues/credentials/verify")) {
        if (credentialVerificationFailures > 0) {
          credentialVerificationFailures -= 1;
          return Response.json({ error: "credential_verification_unavailable" }, { status: 503 });
        }
        return Response.json({
          status: "verified",
          can_read: true,
          can_trade: true,
          can_withdraw: false,
          can_transfer: false,
          can_manage_credentials: false,
          can_export_secret: false,
          unknown_scopes: [],
        });
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

  it("verifies one owner signature, registers once through the worker, then links a ready Aster capability", async () => {
    const preparedResponse = await prepare(request(
      "/v1/private-account/platforms/aster/prepare",
      { owner_address: OWNER.address, agent_name: "ghola-perps" },
    ));
    expect(preparedResponse.status).toBe(201);
    const prepared = await preparedResponse.json();
    const typedData = prepared.contract.approval.typedData;
    const signature = await OWNER.signTypedData({
      domain: typedData.domain,
      types: { Message: typedData.types.Message },
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
    const params = prepared.contract.approval.parametersWithoutSignature;
    const response = await complete(request(
      "/v1/private-account/platforms/aster/complete",
      {
        preparation_id: prepared.preparation_id,
        owner_address: OWNER.address,
        signer_address: prepared.contract.attestedSigner.publicAddress,
        agent_name: params.agentName,
        nonce: params.nonce,
        expired: params.expired,
        ip_whitelist: [],
        signature,
        attested_signer: {
          provider: prepared.contract.attestedSigner.provider,
          worker_id: prepared.contract.attestedSigner.workerId,
          attestation_sha256: prepared.contract.attestedSigner.attestationSha256,
        },
        encrypted_execution_vault: prepared.encrypted_execution_vault,
      },
    ));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      venue_id: "aster",
      status: "ready",
      credential_registered: true,
      setup: { may_place_trade: false, transaction_broadcast: false },
      platform_link: {
        capability: {
          venue_id: "aster",
          provisioning_mode: "programmatic_generated",
          can_read: true,
          can_trade: true,
          can_withdraw: false,
          status: "ready",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain(signature);
    const authorizeCall = vi.mocked(globalThis.fetch).mock.calls.find(([url]) =>
      String(url).endsWith("/venues/aster/credentials/authorize"),
    );
    expect(authorizeCall?.[1]?.headers).toMatchObject({
      "x-ghola-credential-authorization-required": "true",
      "x-ghola-sealed-execution-required": "true",
    });
  });

  it("rejects a mismatched owner signature before credential registration", async () => {
    const preparedResponse = await prepare(request(
      "/v1/private-account/platforms/aster/prepare",
      { owner_address: OWNER.address },
    ));
    const prepared = await preparedResponse.json();
    const typedData = prepared.contract.approval.typedData;
    const wrongSignature = await privateKeyToAccount(`0x${"43".repeat(32)}`).signTypedData({
      domain: typedData.domain,
      types: { Message: typedData.types.Message },
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
    const params = prepared.contract.approval.parametersWithoutSignature;
    const response = await complete(request(
      "/v1/private-account/platforms/aster/complete",
      {
        preparation_id: prepared.preparation_id,
        owner_address: OWNER.address,
        signer_address: prepared.contract.attestedSigner.publicAddress,
        agent_name: params.agentName,
        nonce: params.nonce,
        expired: params.expired,
        ip_whitelist: [],
        signature: wrongSignature,
        attested_signer: {
          provider: prepared.contract.attestedSigner.provider,
          worker_id: prepared.contract.attestedSigner.workerId,
          attestation_sha256: prepared.contract.attestedSigner.attestationSha256,
        },
        encrypted_execution_vault: prepared.encrypted_execution_vault,
      },
    ));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("owner_signature_mismatch");
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) =>
      String(url).endsWith("/venues/aster/credentials/authorize"),
    )).toBe(false);
  });

  it("marks a stale pre-registration approval for one deliberate re-prepare without calling the worker", async () => {
    const preparedResponse = await prepare(request(
      "/v1/private-account/platforms/aster/prepare",
      { owner_address: OWNER.address },
    ));
    const prepared = await preparedResponse.json();
    const typedData = prepared.contract.approval.typedData;
    const signature = await OWNER.signTypedData({
      domain: typedData.domain,
      types: { Message: typedData.types.Message },
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
    const params = prepared.contract.approval.parametersWithoutSignature;
    vi.mocked(Date.now).mockReturnValue(NOW + 10_001);
    const response = await complete(request(
      "/v1/private-account/platforms/aster/complete",
      {
        preparation_id: prepared.preparation_id,
        owner_address: OWNER.address,
        signer_address: prepared.contract.attestedSigner.publicAddress,
        agent_name: params.agentName,
        nonce: params.nonce,
        expired: params.expired,
        ip_whitelist: [],
        signature,
        attested_signer: {
          provider: prepared.contract.attestedSigner.provider,
          worker_id: prepared.contract.attestedSigner.workerId,
          attestation_sha256: prepared.contract.attestedSigner.attestationSha256,
        },
        encrypted_execution_vault: prepared.encrypted_execution_vault,
      },
    ));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "nonce_outside_aster_window",
      reprepare_allowed: true,
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) =>
      String(url).endsWith("/venues/aster/credentials/authorize"),
    )).toBe(false);
  });

  it("recovers an exact registered receipt to finish linking without authorizing again", async () => {
    const preparedResponse = await prepare(request(
      "/v1/private-account/platforms/aster/prepare",
      { owner_address: OWNER.address, agent_name: "ghola-perps" },
    ));
    const prepared = await preparedResponse.json();
    const typedData = prepared.contract.approval.typedData;
    const signature = await OWNER.signTypedData({
      domain: typedData.domain,
      types: { Message: typedData.types.Message },
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
    const params = prepared.contract.approval.parametersWithoutSignature;
    const completionBody = {
      preparation_id: prepared.preparation_id,
      owner_address: OWNER.address,
      signer_address: prepared.contract.attestedSigner.publicAddress,
      agent_name: params.agentName,
      nonce: params.nonce,
      expired: params.expired,
      ip_whitelist: [],
      signature,
      attested_signer: {
        provider: prepared.contract.attestedSigner.provider,
        worker_id: prepared.contract.attestedSigner.workerId,
        attestation_sha256: prepared.contract.attestedSigner.attestationSha256,
      },
      encrypted_execution_vault: prepared.encrypted_execution_vault,
    };
    credentialVerificationFailures = 1;
    const first = await complete(request(
      "/v1/private-account/platforms/aster/complete",
      completionBody,
    ));
    expect(first.status).toBe(502);
    const failedLink = await first.json();
    expect(failedLink).toMatchObject({
      credential_registered: true,
      needs_link_retry: true,
      registration_receipt: {
        status: "registered",
        preparation_id: prepared.preparation_id,
        authorization_expires_at: new Date(params.expired).toISOString(),
      },
    });
    expect(JSON.stringify(failedLink.registration_receipt)).not.toContain("encrypted_execution_vault");
    expect(JSON.stringify(failedLink.registration_receipt)).not.toContain(signature);

    const recovered = await complete(request(
      "/v1/private-account/platforms/aster/complete",
      {
        ...completionBody,
        link_recovery: true,
        registration_receipt: failedLink.registration_receipt,
      },
    ));
    expect(recovered.status).toBe(201);
    expect(await recovered.json()).toMatchObject({ status: "ready", credential_registered: true });
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.filter(([url]) => String(url).endsWith("/venues/aster/credentials/authorize"))).toHaveLength(1);
    expect(calls.filter(([url]) => String(url).endsWith("/venues/aster/credentials/receipt"))).toHaveLength(1);
    const receiptCall = calls.find(([url]) => String(url).endsWith("/venues/aster/credentials/receipt"));
    expect(String(receiptCall?.[1]?.body)).not.toContain(signature);
    expect(String(receiptCall?.[1]?.body)).not.toContain("encrypted_execution_vault");
  });

  it("marks ambiguous, consumed, and rejected registrations as non-retryable", async () => {
    const completionBody = await preparedCompletionBody();
    const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let outcome: "ambiguous" | "consumed" | "rejected" = "ambiguous";
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (!String(input).endsWith("/venues/aster/credentials/authorize")) {
        return originalFetch(input, init);
      }
      if (outcome === "ambiguous") throw new Error("worker response lost");
      if (outcome === "consumed") {
        return Response.json({ error: "aster_registration_not_retryable" }, { status: 409 });
      }
      return Response.json({
        error: "aster_registration_rejected",
        provider_code: -2015,
        provider_message: "Invalid Aster account.",
      }, { status: 400 });
    });

    for (const expected of [
      ["ambiguous", "aster_registration_outcome_ambiguous", 502],
      ["consumed", "aster_registration_not_retryable", 409],
      ["rejected", "aster_registration_rejected", 400],
    ] as const) {
      outcome = expected[0];
      const response = await complete(request("/v1/private-account/platforms/aster/complete", completionBody));
      expect(response.status).toBe(expected[2]);
      const body = await response.json();
      expect(body).toMatchObject({ error: expected[1], retry_allowed: false });
      if (outcome === "rejected") {
        expect(body).toMatchObject({
          provider_code: -2015,
          provider_message: "Invalid Aster account.",
        });
      }
    }
  });

  it("does not report ready when the worker receipt omits registered state", async () => {
    const completionBody = await preparedCompletionBody();
    const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (!String(input).endsWith("/venues/aster/credentials/authorize")) {
        return originalFetch(input, init);
      }
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        version: 1,
        venue_id: "aster",
        status: "registered",
        preparation_id: payload.preparation_id,
        owner_address: payload.owner_address,
        signer_address: payload.signer_address,
        permissions: safePermissions(),
        encrypted_execution_vault: payload.encrypted_execution_vault,
        setup: { may_place_trade: false, transaction_broadcast: false },
      }, { status: 201 });
    });
    const response = await complete(request("/v1/private-account/platforms/aster/complete", completionBody));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "aster_registration_receipt_invalid" });
  });
});

async function preparedCompletionBody() {
  const preparedResponse = await prepare(request(
    "/v1/private-account/platforms/aster/prepare",
    { owner_address: OWNER.address, agent_name: "ghola-perps" },
  ));
  const prepared = await preparedResponse.json();
  const typedData = prepared.contract.approval.typedData;
  const signature = await OWNER.signTypedData({
    domain: typedData.domain,
    types: { Message: typedData.types.Message },
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
  const params = prepared.contract.approval.parametersWithoutSignature;
  return {
    preparation_id: prepared.preparation_id,
    owner_address: OWNER.address,
    signer_address: prepared.contract.attestedSigner.publicAddress,
    agent_name: params.agentName,
    nonce: params.nonce,
    expired: params.expired,
    ip_whitelist: [],
    signature,
    attested_signer: {
      provider: prepared.contract.attestedSigner.provider,
      worker_id: prepared.contract.attestedSigner.workerId,
      attestation_sha256: prepared.contract.attestedSigner.attestationSha256,
    },
    encrypted_execution_vault: prepared.encrypted_execution_vault,
  };
}

function safePermissions() {
  return {
    can_read: true,
    can_trade: true,
    can_spot_trade: false,
    can_perp_trade: true,
    can_withdraw: false,
    can_transfer: false,
    can_manage_credentials: false,
    can_export_secret: false,
    unknown_scopes: [],
  };
}
