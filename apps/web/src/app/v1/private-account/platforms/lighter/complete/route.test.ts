import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { LIGHTER_MAINNET_PROXY_ADDRESS } from "@/lib/lighter-agent-association";
import { POST as prepare } from "../prepare/route";
import { POST as complete } from "./route";

const OWNER = privateKeyToAccount(`0x${"42".repeat(32)}`);
const PUBLIC_KEY = "22".repeat(40);
let accountCommitment = "";
let workerDisposition: "ready" | "submitted" = "ready";
let externalTransaction: Record<string, unknown> | null = null;

function auth() {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "lighter_complete_user", email: "lighter@example.com" })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: { authorization: auth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Lighter programmatic credential completion", () => {
  beforeEach(() => {
    accountCommitment = "";
    workerDisposition = "ready";
    externalTransaction = null;
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
          l1_address: OWNER.address,
          sub_accounts: [{ index: 123, account_type: 0, l1_address: OWNER.address }],
        });
      }
      if (url.includes("/api/v1/apikeys")) return Response.json({ code: 200, api_keys: [] });
      if (url.endsWith("/info")) return Response.json({ contract_address: LIGHTER_MAINNET_PROXY_ADDRESS });
      if (url === "https://rpc.example") {
        const rpc = JSON.parse(String(init?.body)) as { method: string };
        const result = {
          eth_chainId: "0x1",
          eth_call: "0x",
          eth_getTransactionCount: "0x7",
          eth_estimateGas: "0x30d40",
          eth_maxPriorityFeePerGas: "0x3b9aca00",
          eth_getBlockByNumber: { baseFeePerGas: "0x6fc23ac00" },
          eth_getTransactionByHash: externalTransaction,
        }[rpc.method];
        return Response.json({ jsonrpc: "2.0", id: rpc.method, result });
      }
      if (url.endsWith("/venues/lighter/credentials/prepare")) {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        accountCommitment = String(payload.account_commitment);
        const recipient = "phala:cvm:lighter-complete-test";
        return Response.json({
          version: 1,
          venue_id: "lighter",
          network: "mainnet",
          owner_address: payload.owner_address,
          account_index: payload.account_index,
          api_key_index: payload.api_key_index,
          public_key: PUBLIC_KEY,
          encrypted_execution_vault: pendingVault(recipient),
          attested_signer: {
            provider: "phala",
            worker_id: recipient,
            attestation_sha256: `sha256:${"ab".repeat(32)}`,
            private_key_exposed: false,
          },
          authority_boundary: { venue_native_trade_only: false },
          setup: {
            may_place_trade: false,
            transaction_signed: false,
            transaction_broadcast: false,
            credential_ready: false,
          },
        }, { status: 201 });
      }
      if (url.includes("/venues/lighter/credentials/authorize") || url.includes("/venues/lighter/credentials/receipt")) {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const transactionHash = typeof payload.transaction_hash === "string"
          ? payload.transaction_hash
          : keccak256(String(payload.raw_transaction) as `0x${string}`);
        if (workerDisposition === "submitted") {
          return Response.json({
            version: 1,
            venue_id: "lighter",
            status: "submitted",
            preparation_id: payload.preparation_id,
            owner_address: payload.owner_address,
            account_index: payload.account_index,
            api_key_index: payload.api_key_index,
            public_key: payload.public_key,
            transaction_hash: transactionHash,
            setup: {
              may_place_trade: false,
              transaction_broadcast: true,
              credential_registered: false,
              owner_association_verified: false,
            },
          }, { status: 202 });
        }
        const recipient = "phala:cvm:lighter-complete-test";
        return Response.json({
          version: 1,
          venue_id: "lighter",
          status: "ready",
          preparation_id: payload.preparation_id,
          owner_address: payload.owner_address,
          account_index: payload.account_index,
          api_key_index: payload.api_key_index,
          public_key: payload.public_key,
          transaction_hash: transactionHash,
          permissions: {
            can_read: true,
            can_trade: true,
            can_withdraw: false,
            can_transfer: false,
            can_manage_credentials: false,
            can_export_secret: false,
            unknown_scopes: [],
          },
          encrypted_execution_vault: activeVault(recipient),
          setup: {
            may_place_trade: false,
            transaction_broadcast: true,
            credential_registered: true,
            owner_association_verified: true,
          },
        }, { status: 201 });
      }
      if (url.endsWith("/venues/credentials/verify")) {
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
      return Response.json({ error: `unexpected_request:${url}` }, { status: 500 });
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

  it("links only after the exact Turnkey transaction and onchain association are verified", async () => {
    const prepared = await preparedCredential();
    const authorization = await sign(prepared.transaction_plan);
    const response = await complete(request("/v1/private-account/platforms/lighter/complete", {
      preparation_id: prepared.preparation_id,
      owner_address: prepared.transaction_plan.from,
      account_index: prepared.transaction_plan.account_index,
      api_key_index: prepared.transaction_plan.api_key_index,
      public_key: prepared.transaction_plan.public_key,
      raw_transaction: authorization.raw_transaction,
      transaction_hash: authorization.transaction_hash,
      transaction_plan: prepared.transaction_plan,
      encrypted_execution_vault: prepared.encrypted_execution_vault,
    }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({
      venue_id: "lighter",
      status: "ready",
      credential_registered: true,
      transaction_hash: authorization.transaction_hash,
      platform_link: { capability: { status: "ready", can_trade: true, can_withdraw: false } },
    });
    const workerCall = vi.mocked(globalThis.fetch).mock.calls.find(([url]) =>
      String(url).includes("/venues/lighter/credentials/authorize"),
    );
    expect(workerCall?.[1]?.headers).toMatchObject({
      "x-ghola-credential-authorization-required": "true",
      "x-ghola-sealed-execution-required": "true",
    });
  });

  it("holds a submitted association for reconciliation instead of relinking or retrying", async () => {
    workerDisposition = "submitted";
    const prepared = await preparedCredential();
    const authorization = await sign(prepared.transaction_plan);
    const response = await complete(request("/v1/private-account/platforms/lighter/complete", {
      preparation_id: prepared.preparation_id,
      owner_address: prepared.transaction_plan.from,
      account_index: prepared.transaction_plan.account_index,
      api_key_index: prepared.transaction_plan.api_key_index,
      public_key: prepared.transaction_plan.public_key,
      raw_transaction: authorization.raw_transaction,
      transaction_hash: authorization.transaction_hash,
      transaction_plan: prepared.transaction_plan,
      encrypted_execution_vault: prepared.encrypted_execution_vault,
    }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(202);
    expect(body).toMatchObject({
      status: "submitted",
      retry_allowed: false,
      reconcile_only: true,
    });
  });

  it("rejects tampered signed transactions before calling the worker", async () => {
    const prepared = await preparedCredential();
    const authorization = await sign(prepared.transaction_plan);
    const response = await complete(request("/v1/private-account/platforms/lighter/complete", {
      preparation_id: prepared.preparation_id,
      owner_address: prepared.transaction_plan.from,
      account_index: prepared.transaction_plan.account_index,
      api_key_index: prepared.transaction_plan.api_key_index,
      public_key: prepared.transaction_plan.public_key,
      raw_transaction: `${authorization.raw_transaction.slice(0, -2)}00`,
      transaction_hash: authorization.transaction_hash,
      transaction_plan: prepared.transaction_plan,
      encrypted_execution_vault: prepared.encrypted_execution_vault,
    }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(403);
    const authorizeCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([url]) =>
      String(url).includes("/venues/lighter/credentials/authorize"),
    );
    expect(authorizeCalls).toHaveLength(0);
  });

  it("verifies an externally broadcast owner transaction and only reconciles it", async () => {
    const prepared = await preparedCredential();
    const transactionHash = `0x${"77".repeat(32)}`;
    externalTransaction = {
      hash: transactionHash,
      from: prepared.transaction_plan.from,
      to: prepared.transaction_plan.to,
      input: prepared.transaction_plan.data,
      value: prepared.transaction_plan.value,
      nonce: prepared.transaction_plan.nonce,
      gas: prepared.transaction_plan.gas,
      maxFeePerGas: prepared.transaction_plan.max_fee_per_gas,
      maxPriorityFeePerGas: prepared.transaction_plan.max_priority_fee_per_gas,
      type: "0x2",
    };
    const response = await complete(request("/v1/private-account/platforms/lighter/complete", {
      preparation_id: prepared.preparation_id,
      owner_address: prepared.transaction_plan.from,
      account_index: prepared.transaction_plan.account_index,
      api_key_index: prepared.transaction_plan.api_key_index,
      public_key: prepared.transaction_plan.public_key,
      external_broadcast: true,
      transaction_hash: transactionHash,
      transaction_plan: prepared.transaction_plan,
      encrypted_execution_vault: prepared.encrypted_execution_vault,
    }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ status: "ready", transaction_hash: transactionHash });
    const calls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.includes("/venues/lighter/credentials/receipt"))).toBe(true);
    expect(calls.some((url) => url.includes("/venues/lighter/credentials/authorize"))).toBe(false);
  });

  it("holds an externally broadcast transaction until Ethereum can return it", async () => {
    const prepared = await preparedCredential();
    const response = await complete(request("/v1/private-account/platforms/lighter/complete", {
      preparation_id: prepared.preparation_id,
      owner_address: prepared.transaction_plan.from,
      account_index: prepared.transaction_plan.account_index,
      api_key_index: prepared.transaction_plan.api_key_index,
      public_key: prepared.transaction_plan.public_key,
      external_broadcast: true,
      transaction_hash: `0x${"66".repeat(32)}`,
      transaction_plan: prepared.transaction_plan,
      encrypted_execution_vault: prepared.encrypted_execution_vault,
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ retry_allowed: false, reconcile_only: true });
    const receiptCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([url]) =>
      String(url).includes("/venues/lighter/credentials/receipt"),
    );
    expect(receiptCalls).toHaveLength(0);
  });
});

async function preparedCredential() {
  const response = await prepare(request("/v1/private-account/platforms/lighter/prepare", {
    owner_address: OWNER.address,
  }));
  expect(response.status).toBe(201);
  return response.json();
}

async function sign(plan: Record<string, string | number>) {
  const rawTransaction = await OWNER.signTransaction({
    type: "eip1559",
    chainId: Number(plan.chain_id),
    nonce: Number(BigInt(String(plan.nonce))),
    gas: BigInt(String(plan.gas)),
    maxFeePerGas: BigInt(String(plan.max_fee_per_gas)),
    maxPriorityFeePerGas: BigInt(String(plan.max_priority_fee_per_gas)),
    to: String(plan.to) as `0x${string}`,
    value: BigInt(String(plan.value)),
    data: String(plan.data) as `0x${string}`,
  });
  return { raw_transaction: rawTransaction, transaction_hash: keccak256(rawTransaction) };
}

function pendingVault(recipient: string) {
  return {
    alg: "sealed-provider-v1",
    ciphertext: "c2VhbGVkLXBlbmRpbmc=",
    recipient,
    aad: [
      "ghola/lighter-pending-execution-vault-v1",
      `account:${accountCommitment}`,
      `recipient:${recipient}`,
      "network:mainnet",
    ].join("|"),
  };
}

function activeVault(recipient: string) {
  return {
    alg: "sealed-provider-v1",
    ciphertext: "c2VhbGVkLWFjdGl2ZQ==",
    recipient,
    aad: [
      "ghola/lighter-execution-vault-v1",
      `account:${accountCommitment}`,
      `recipient:${recipient}`,
      "network:mainnet",
    ].join("|"),
  };
}
