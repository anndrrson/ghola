import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import {
  LIGHTER_CHANGE_PUB_KEY_ABI,
  LIGHTER_MAINNET_PROXY_ADDRESS,
} from "@/lib/lighter-agent-association";
import { POST } from "./route";

const OWNER = "0x3333333333333333333333333333333333333333";
const PUBLIC_KEY = "22".repeat(40);
const PRIVATE_KEY = "11".repeat(32);

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(body: unknown) {
  return new Request("https://ghola.test/v1/private-account/platforms/lighter/prepare", {
    method: "POST",
    headers: {
      authorization: auth("lighter_prepare_user"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Lighter programmatic credential preparation", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-secret";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    process.env.GHOLA_LIGHTER_ETHEREUM_RPC_URL = "https://rpc.example";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v1/accountsByL1Address")) {
        return Response.json({
          code: 200,
          l1_address: OWNER,
          sub_accounts: [{ index: 123, account_type: 0, l1_address: OWNER }],
        });
      }
      if (url.includes("/api/v1/apikeys")) return Response.json({ code: 200, api_keys: [] });
      if (url === "https://mainnet.zklighter.elliot.ai/info") {
        return Response.json({ contract_address: LIGHTER_MAINNET_PROXY_ADDRESS });
      }
      if (url === "https://worker.example/venues/lighter/credentials/prepare") {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const recipient = "phala:cvm:lighter-test";
        return Response.json({
          version: 1,
          venue_id: "lighter",
          network: "mainnet",
          owner_address: payload.owner_address,
          account_index: payload.account_index,
          api_key_index: payload.api_key_index,
          public_key: PUBLIC_KEY,
          encrypted_execution_vault: {
            alg: "sealed-provider-v1",
            ciphertext: "sealed-ciphertext",
            recipient,
            aad: [
              "ghola/lighter-pending-execution-vault-v1",
              `account:${payload.account_commitment}`,
              `recipient:${recipient}`,
              "network:mainnet",
            ].join("|"),
          },
          attested_signer: {
            provider: "phala",
            worker_id: recipient,
            attestation_sha256: `sha256:${"ab".repeat(32)}`,
            private_key_exposed: false,
          },
          owner_association: {
            status: "pending",
            explicit_owner_authorization_required: true,
          },
          authority_boundary: {
            venue_native_trade_only: false,
            enforced_by: "attested_worker_policy_after_association",
          },
          setup: {
            may_place_trade: false,
            transaction_signed: false,
            transaction_broadcast: false,
            credential_ready: false,
          },
        }, { status: 201 });
      }
      if (url === "https://rpc.example") {
        const rpc = JSON.parse(String(init?.body)) as { method: string };
        const result = {
          eth_chainId: "0x1",
          eth_call: "0x",
          eth_getTransactionCount: "0x7",
          eth_estimateGas: "0x30d40",
          eth_maxPriorityFeePerGas: "0x3b9aca00",
          eth_getBlockByNumber: { baseFeePerGas: "0x6fc23ac00" },
        }[rpc.method];
        return Response.json({ jsonrpc: "2.0", id: rpc.method, result });
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
    delete process.env.GHOLA_LIGHTER_ETHEREUM_RPC_URL;
    vi.restoreAllMocks();
    await resetPrivateAccountStoreForTests();
  });

  it("verifies ownership and vacancy before returning the exact unsigned association intent", async () => {
    const response = await POST(request({
      owner_address: OWNER,
      account_index: 123,
      api_key_index: 4,
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      venue_id: "lighter",
      credential_provisioning_mode: "programmatic_generated",
      owner_approval_required: true,
      owner_association: {
        method: "ethereum_change_pub_key",
        status: "transaction_prepared",
        ethereum_gas_required: true,
      },
      transaction_plan: {
        chain_id: 1,
        from: OWNER,
        to: LIGHTER_MAINNET_PROXY_ADDRESS,
        value: "0x0",
        transaction_signed: false,
        transaction_broadcast: false,
        simulation_required_before_signing: true,
        nonce: "0x7",
        gas: "0x3a980",
        simulation: {
          performed: true,
          succeeded: true,
          chain_id_verified: true,
          exact_sender_verified: true,
          exact_contract_verified: true,
        },
      },
      setup: {
        may_place_trade: false,
        transaction_signed: false,
        transaction_broadcast: false,
        credential_ready: false,
      },
    });
    expect(body.authority_boundary.venue_native_trade_only).toBe(false);
    const decoded = decodeFunctionData({
      abi: LIGHTER_CHANGE_PUB_KEY_ABI,
      data: body.transaction_plan.data,
    });
    expect(decoded).toEqual({ functionName: "changePubKey", args: [123, 4, `0x${PUBLIC_KEY}`] });
    expect(JSON.stringify(body)).not.toContain(PRIVATE_KEY);
    const calls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(calls.indexOf("https://worker.example/venues/lighter/credentials/prepare")).toBeGreaterThan(
      calls.findIndex((url) => url.includes("/api/v1/apikeys")),
    );
    const workerCall = vi.mocked(globalThis.fetch).mock.calls.find(([url]) =>
      String(url).includes("/venues/lighter/credentials/prepare"),
    );
    expect(workerCall?.[1]?.headers).toMatchObject({
      "x-ghola-sealed-execution-required": "true",
    });
  });

  it("selects the master account and first free Ghola slot without venue-specific user input", async () => {
    const response = await POST(request({ owner_address: OWNER }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.transaction_plan).toMatchObject({
      account_index: 123,
      api_key_index: 2,
      from: OWNER,
    });
    const workerCall = vi.mocked(globalThis.fetch).mock.calls.find(([url]) =>
      String(url).includes("/venues/lighter/credentials/prepare"),
    );
    expect(JSON.parse(String(workerCall?.[1]?.body))).toMatchObject({
      account_index: 123,
      api_key_index: 2,
    });
  });

  it("does not generate a key when the account is not owned by Turnkey", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/accountsByL1Address")) {
        return Response.json({ code: 200, l1_address: OWNER, sub_accounts: [] });
      }
      if (url.includes("/api/v1/apikeys")) return Response.json({ code: 200, api_keys: [] });
      if (url.endsWith("/info")) return Response.json({ contract_address: LIGHTER_MAINNET_PROXY_ADDRESS });
      return Response.json({ error: "worker_must_not_be_called" }, { status: 500 });
    });
    const response = await POST(request({ owner_address: OWNER, account_index: 123, api_key_index: 4 }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("does not have a Lighter account");
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).includes("worker.example"))).toBe(false);
  });

  it("does not generate a key when the selected slot is occupied", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/accountsByL1Address")) {
        return Response.json({ code: 200, l1_address: OWNER, sub_accounts: [{ index: 123, l1_address: OWNER }] });
      }
      if (url.includes("/api/v1/apikeys")) {
        return Response.json({ code: 200, api_keys: [{ account_index: 123, api_key_index: 4, public_key: PUBLIC_KEY }] });
      }
      if (url.endsWith("/info")) return Response.json({ contract_address: LIGHTER_MAINNET_PROXY_ADDRESS });
      return Response.json({ error: "worker_must_not_be_called" }, { status: 500 });
    });
    const response = await POST(request({ owner_address: OWNER, account_index: 123, api_key_index: 4 }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("already occupied");
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).includes("worker.example"))).toBe(false);
  });
});
