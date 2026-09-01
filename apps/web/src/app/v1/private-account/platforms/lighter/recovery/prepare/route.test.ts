import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, encodeFunctionResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";

vi.mock("server-only", () => ({}));

const bindingMocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/lighter-turnkey-owner-binding.server", () => ({
  resolveLighterTurnkeyPerpsOwnerBinding: bindingMocks.resolve,
}));

import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import {
  LIGHTER_MAINNET_PROXY_ADDRESS,
} from "@/lib/lighter-agent-association";
import {
  LIGHTER_OWNER_RECOVERY_ABI,
  LIGHTER_RECOVERY_IMPLEMENTATION_ADDRESS,
  LIGHTER_RECOVERY_USDC_ADDRESS,
  buildLighterOwnerRecoveryIntent,
} from "@/lib/lighter-owner-recovery";
import { POST } from "./route";

const OWNER = privateKeyToAccount(`0x${"42".repeat(32)}`);
let ownerBalance = "0xde0b6b3a7640000";
let implementation = LIGHTER_RECOVERY_IMPLEMENTATION_ADDRESS;
let accountExists = true;

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(body: unknown) {
  return new Request("https://ghola.test/v1/private-account/platforms/lighter/recovery/prepare", {
    method: "POST",
    headers: { authorization: auth("lighter_recovery_user"), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Lighter owner recovery no-submit readiness", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    process.env.GHOLA_LIGHTER_ETHEREUM_RPC_URL = "https://rpc.example";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = "secure-recovery-readiness-request-proof-secret-2026";
    ownerBalance = "0xde0b6b3a7640000";
    implementation = LIGHTER_RECOVERY_IMPLEMENTATION_ADDRESS;
    accountExists = true;
    bindingMocks.resolve.mockReset().mockResolvedValue({});
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_CONNECTOR_MODE;
    delete process.env.GHOLA_LIGHTER_ETHEREUM_RPC_URL;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    vi.restoreAllMocks();
    await resetPrivateAccountStoreForTests();
  });

  it("proves exact Turnkey owner recovery readiness without signing or broadcasting a transaction", async () => {
    const first = await POST(request({ version: 1, owner_address: OWNER.address, account_index: 123 }));
    expect(first.status).toBe(200);
    const challenge = await first.json();
    expect(challenge).toMatchObject({
      status: "owner_signature_required",
      ready: false,
      funding_precondition_satisfied: false,
      funding_authorized: false,
      checks: {
        owner_signer_verified: false,
        owner_account_binding_verified: true,
        contract_identity_verified: true,
        asset_identity_verified: true,
        exact_calldata_simulated: true,
        gas_ready: true,
        zero_redirect_verified: true,
      },
      recovery_plan: {
        from: OWNER.address.toLowerCase(),
        to: LIGHTER_MAINNET_PROXY_ADDRESS,
        recipient_address: OWNER.address.toLowerCase(),
        recipient_parameter_present: false,
        redirect_possible: false,
        transaction_signed: false,
        transaction_broadcast: false,
        submission_available: false,
      },
      safety: { no_submit: true, funds_moved: false, claim_available: false },
    });
    const signature = await OWNER.signMessage({ message: challenge.challenge.message });
    const second = await POST(request({
      version: 1,
      owner_address: OWNER.address,
      account_index: 123,
      challenge_token: challenge.challenge.challenge_token,
      owner_signature: signature,
    }));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: "post_account_recovery_ready",
      ready: true,
      recovery_readiness_proven: true,
      post_account_recovery_ready: true,
      funding_precondition_satisfied: false,
      initial_funding_safety_proven: false,
      funding_authorized: false,
      checks: { owner_signer_verified: true, zero_redirect_verified: true },
      owner_signer: {
        method: "turnkey_eip191_owner_proof",
        verified: true,
        transaction_signed: false,
      },
      safety: { transaction_broadcast: false, funds_moved: false },
    });
    const rpcMethods = vi.mocked(globalThis.fetch).mock.calls
      .filter(([url]) => String(url) === "https://rpc.example")
      .map(([, init]) => JSON.parse(String(init?.body)).method);
    expect(rpcMethods).not.toContain("eth_sendRawTransaction");
    expect(rpcMethods).not.toContain("eth_sendTransaction");
  });

  it("fails closed for a wrong signer and insufficient owner gas", async () => {
    const first = await POST(request({ version: 1, owner_address: OWNER.address }));
    const challenge = await first.json();
    const wrong = privateKeyToAccount(`0x${"43".repeat(32)}`);
    const wrongResponse = await POST(request({
      version: 1,
      owner_address: OWNER.address,
      challenge_token: challenge.challenge.challenge_token,
      owner_signature: await wrong.signMessage({ message: challenge.challenge.message }),
    }));
    expect(wrongResponse.status).toBe(403);
    expect(await wrongResponse.json()).toMatchObject({
      error: "lighter_recovery_readiness_signature_mismatch",
      ready: false,
      funding_authorized: false,
    });

    ownerBalance = "0x0";
    const noGas = await POST(request({ version: 1, owner_address: OWNER.address }));
    expect(noGas.status).toBe(409);
    expect(await noGas.json()).toMatchObject({
      error: "lighter_recovery_owner_gas_insufficient",
      status: "blocked",
      ready: false,
      checks: { gas_ready: false },
      funding_precondition_satisfied: false,
      funding_authorized: false,
    });
  });

  it("pins the proxy implementation and rejects drift", async () => {
    implementation = "0x4444444444444444444444444444444444444444";
    const response = await POST(request({ version: 1, owner_address: OWNER.address }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "lighter_recovery_contract_identity_mismatch",
      ready: false,
      funding_authorized: false,
    });
  });

  it("rejects a generic EOA before any Lighter or RPC preflight", async () => {
    bindingMocks.resolve.mockRejectedValueOnce(Object.assign(
      new Error("lighter_turnkey_owner_binding_mismatch"),
      { code: "lighter_turnkey_owner_binding_mismatch", status: 403 },
    ));
    const response = await POST(request({ version: 1, owner_address: OWNER.address }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("lighter_turnkey_owner_binding_mismatch");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("rejects a brand-new owner before RPC and never acts as an initial-funding gate", async () => {
    accountExists = false;
    const response = await POST(request({ version: 1, owner_address: OWNER.address }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "lighter_recovery_owner_account_not_found",
      ready: false,
      post_account_recovery_ready: false,
      funding_precondition_satisfied: false,
      initial_funding_safety_proven: false,
      funding_authorized: false,
      applicability: {
        stage: "post_lighter_account_activation",
        brand_new_account_supported: false,
        pre_uda_funding_gate: false,
      },
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url) === "https://rpc.example")).toBe(false);
  });
});

async function fetchMock(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  if (url.includes("/api/v1/accountsByL1Address")) {
    if (!accountExists) return Response.json({ code: 21100, message: "account not found" }, { status: 400 });
    return Response.json({
      code: 200,
      l1_address: OWNER.address,
      sub_accounts: [{ index: 123, account_type: 0, l1_address: OWNER.address }],
    });
  }
  if (url === "https://mainnet.zklighter.elliot.ai/info") {
    return Response.json({ contract_address: LIGHTER_MAINNET_PROXY_ADDRESS });
  }
  if (url.includes("/api/v1/assetDetails")) {
    return Response.json({
      code: 200,
      asset_details: [{
        asset_id: 3,
        symbol: "USDC",
        l1_decimals: 6,
        decimals: 6,
        min_withdrawal_amount: "1.000000",
        margin_mode: "enabled",
        l1_address: LIGHTER_RECOVERY_USDC_ADDRESS,
      }],
    });
  }
  if (url.endsWith("/api/v1/withdrawalDelay")) return Response.json({ seconds: 1125 });
  if (url === "https://rpc.example") {
    const rpc = JSON.parse(String(init?.body)) as { method: string; params: Array<Record<string, string> | string> };
    let result: unknown;
    if (rpc.method === "eth_chainId") result = "0x1";
    else if (rpc.method === "eth_getCode") result = "0x60006000";
    else if (rpc.method === "eth_getStorageAt") result = `0x${"0".repeat(24)}${implementation.slice(2).toLowerCase()}`;
    else if (rpc.method === "eth_getBalance") result = ownerBalance;
    else if (rpc.method === "eth_getTransactionCount") result = "0x7";
    else if (rpc.method === "eth_estimateGas") result = "0x1adb0";
    else if (rpc.method === "eth_maxPriorityFeePerGas") result = "0x3b9aca00";
    else if (rpc.method === "eth_getBlockByNumber") result = { baseFeePerGas: "0x6fc23ac00" };
    else if (rpc.method === "eth_call") result = ethCallResult((rpc.params[0] as Record<string, string>).data);
    else return Response.json({ jsonrpc: "2.0", id: rpc.method, error: { message: "unexpected method" } });
    return Response.json({ jsonrpc: "2.0", id: rpc.method, result });
  }
  return Response.json({ error: "unexpected request" }, { status: 500 });
}

function ethCallResult(data: string) {
  const mapping = encodeFunctionData({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "addressToAccountIndex",
    args: [OWNER.address],
  });
  const asset = encodeFunctionData({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "assetConfigs",
    args: [3],
  });
  const pending = encodeFunctionData({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "getPendingBalance",
    args: [OWNER.address, 3],
  });
  if (data === mapping) {
    return encodeFunctionResult({ abi: LIGHTER_OWNER_RECOVERY_ABI, functionName: "addressToAccountIndex", result: 123 });
  }
  if (data === asset) {
    return encodeFunctionResult({
      abi: LIGHTER_OWNER_RECOVERY_ABI,
      functionName: "assetConfigs",
      result: [LIGHTER_RECOVERY_USDC_ADDRESS, 1, BigInt(1_000_000), BigInt(1), BigInt(1_000_000_000), BigInt(1_000_000)],
    });
  }
  if (data === pending) {
    return encodeFunctionResult({ abi: LIGHTER_OWNER_RECOVERY_ABI, functionName: "getPendingBalance", result: BigInt(0) });
  }
  if (data === buildLighterOwnerRecoveryIntent({ ownerAddress: OWNER.address, accountIndex: 123 }).data) return "0x";
  throw new Error(`Unexpected eth_call ${data}`);
}
