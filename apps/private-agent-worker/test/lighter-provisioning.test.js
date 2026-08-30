import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { x25519 } from "@noble/curves/ed25519";
import { openSealedBundle } from "../src/crypto/envelope.js";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openLighterExecutionCredential, verifyLighterNoSubmit } from "../src/venues/lighter.js";
import {
  authorizeLighterCredential,
  lighterPreparationId,
  prepareLighterCredential,
  prepareLighterCredentialProvisioning,
  reconcileLighterCredential,
} from "../src/venues/lighter-provisioning.js";

const PRIVATE_KEY = "11".repeat(32);
const PUBLIC_KEY = "22".repeat(40);
const OWNER = `0x${"33".repeat(20)}`;
const OWNER_ACCOUNT = privateKeyToAccount(`0x${"42".repeat(32)}`);
const LIGHTER_PROXY = "0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7";
const TEST_SEALING_IDENTITY = generateKeyPairSync("ed25519");

function recipient() {
  const secret = new Uint8Array(32).fill(7);
  return {
    recipient_id: "phala:cvm:lighter-provisioning-test",
    x25519_secret_hex: Buffer.from(secret).toString("hex"),
    x25519_pub_hex: Buffer.from(x25519.getPublicKey(secret)).toString("hex"),
  };
}

function sealingIdentity() {
  return { privateKey: TEST_SEALING_IDENTITY.privateKey, publicKey: TEST_SEALING_IDENTITY.publicKey };
}

function sealedVault(overrides = {}) {
  return {
    alg: "sealed-provider-v1",
    ciphertext: "c2VhbGVkLWxpZ2h0ZXItY3JlZGVudGlhbA==",
    recipient: "phala-recipient-1",
    aad: "ghola/lighter-pending-v1|account:123|key:4",
    ...overrides,
  };
}

test("generates once, seals the private key directly, and returns only public enrollment material", async () => {
  let generated = 0;
  let sealedInput = null;
  const result = await prepareLighterCredentialProvisioning({
    network: "mainnet",
    accountIndex: "123",
    apiKeyIndex: 4,
    generateApiKey: async () => {
      generated += 1;
      return [PRIVATE_KEY, PUBLIC_KEY, null];
    },
    sealVault: async (vault) => {
      sealedInput = vault;
      return sealedVault();
    },
  });

  assert.equal(generated, 1);
  assert.equal(sealedInput.api_private_key, PRIVATE_KEY);
  assert.equal(sealedInput.api_public_key, PUBLIC_KEY);
  assert.equal(sealedInput.provisioning_status, "pending_owner_association");
  assert.deepEqual(sealedInput.allowed_operations, []);
  assert.deepEqual(sealedInput.permissions, {
    can_read: false,
    can_trade: false,
    can_withdraw: false,
    can_transfer: false,
  });
  assert.deepEqual(Object.keys(result).sort(), ["enrollment_payload", "sealed_vault"]);
  assert.equal(result.enrollment_payload.public_key, PUBLIC_KEY);
  assert.equal(result.enrollment_payload.owner_association.status, "pending");
  assert.equal(result.enrollment_payload.owner_association.explicit_owner_authorization_required, true);
  assert.equal(result.enrollment_payload.owner_association.credential_ready, false);
  assert.equal(result.enrollment_payload.owner_association.transaction_broadcast, false);
  assert.deepEqual(result.enrollment_payload.setup_permissions, {
    can_trade: false,
    can_withdraw: false,
    can_transfer: false,
  });
  assert.equal(JSON.stringify(result).includes(PRIVATE_KEY), false);
});

test("generates and self-seals a pending Lighter key without signing or broadcasting", async () => {
  const workerRecipient = recipient();
  const prepared = await prepareLighterCredential({
    ownerAddress: OWNER,
    accountCommitment: "private_account_lighter_programmatic_test",
    accountIndex: 123,
    apiKeyIndex: 4,
    recipient: workerRecipient,
    attestationEvidence: { quote_hash: "quote-test" },
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    generateApiKey: async () => [PRIVATE_KEY, PUBLIC_KEY, null],
    sealingIdentity,
  });

  assert.equal(JSON.stringify(prepared).includes(PRIVATE_KEY), false);
  assert.equal(prepared.public_key, PUBLIC_KEY);
  assert.deepEqual(prepared.setup, {
    may_place_trade: false,
    transaction_signed: false,
    transaction_broadcast: false,
    credential_ready: false,
  });
  assert.equal(prepared.authority_boundary.venue_native_trade_only, false);
  const opened = await openSealedBundle(prepared.encrypted_execution_vault, workerRecipient, {
    expectedKind: "ghola_lighter_pending_execution_vault",
    expectedAad: prepared.encrypted_execution_vault.aad,
  });
  assert.equal(opened.json.api_private_key, PRIVATE_KEY);
  assert.equal(opened.json.api_public_key, PUBLIC_KEY);
  assert.equal(opened.json.account_commitment, "private_account_lighter_programmatic_test");
  assert.equal(opened.json.owner_address, OWNER);
  assert.deepEqual(opened.json.allowed_operations, []);
  assert.equal(opened.json.blocked_operations.includes("withdraw"), true);
});

test("normalizes the official SDK object result without returning its private key", async () => {
  let sealedPrivateKey = null;
  const result = await prepareLighterCredentialProvisioning({
    network: "testnet",
    accountIndex: 0,
    apiKeyIndex: "254",
    generateApiKey: async () => ({
      privateKey: `0x${PRIVATE_KEY.toUpperCase()}`,
      publicKey: `0x${PUBLIC_KEY.toUpperCase()}`,
      error: null,
    }),
    sealVault: async (vault) => {
      sealedPrivateKey = vault.api_private_key;
      return { encrypted_execution_vault: sealedVault() };
    },
  });

  assert.equal(sealedPrivateKey, PRIVATE_KEY);
  assert.equal(result.enrollment_payload.public_key, PUBLIC_KEY);
  assert.equal(JSON.stringify(result).includes(PRIVATE_KEY), false);
});

test("rejects invalid indexes before generating a key", async () => {
  const invalid = [
    { accountIndex: -1, apiKeyIndex: 4, code: "account_index_invalid" },
    { accountIndex: 1.5, apiKeyIndex: 4, code: "account_index_invalid" },
    { accountIndex: 281_474_976_710_656, apiKeyIndex: 4, code: "account_index_invalid" },
    { accountIndex: Number.MAX_SAFE_INTEGER + 1, apiKeyIndex: 4, code: "account_index_invalid" },
    { accountIndex: 123, apiKeyIndex: -1, code: "api_key_index_invalid" },
    { accountIndex: 123, apiKeyIndex: 0, code: "api_key_index_reserved" },
    { accountIndex: 123, apiKeyIndex: 1, code: "api_key_index_reserved" },
    { accountIndex: 123, apiKeyIndex: 255, code: "api_key_index_invalid" },
  ];
  for (const entry of invalid) {
    let generated = false;
    await assert.rejects(prepareLighterCredentialProvisioning({
      network: "mainnet",
      accountIndex: entry.accountIndex,
      apiKeyIndex: entry.apiKeyIndex,
      generateApiKey: async () => {
        generated = true;
        return [PRIVATE_KEY, PUBLIC_KEY, null];
      },
      sealVault: async () => sealedVault(),
    }), (error) => error.code === entry.code);
    assert.equal(generated, false);
  }
});

test("requires an explicit network and injected generation and sealing boundaries", async () => {
  const base = { accountIndex: 123, apiKeyIndex: 4 };
  await assert.rejects(prepareLighterCredentialProvisioning({
    ...base,
    network: "production",
    generateApiKey: async () => [PRIVATE_KEY, PUBLIC_KEY, null],
    sealVault: async () => sealedVault(),
  }), (error) => error.code === "network_invalid");
  await assert.rejects(prepareLighterCredentialProvisioning({
    ...base,
    network: "mainnet",
    sealVault: async () => sealedVault(),
  }), (error) => error.code === "key_generator_required");
  await assert.rejects(prepareLighterCredentialProvisioning({
    ...base,
    network: "mainnet",
    generateApiKey: async () => [PRIVATE_KEY, PUBLIC_KEY, null],
  }), (error) => error.code === "vault_sealer_required");
});

test("rejects malformed SDK keys and never calls the sealer", async () => {
  const pairs = [
    ["bad", PUBLIC_KEY, "private_key_invalid"],
    [PRIVATE_KEY, "bad", "public_key_invalid"],
    [PRIVATE_KEY, "00".repeat(40), "public_key_invalid"],
    [PRIVATE_KEY, "01" + "00".repeat(3) + "ff".repeat(4) + "00".repeat(32), "public_key_noncanonical"],
    ["00".repeat(32), PUBLIC_KEY, "private_key_invalid"],
  ];
  for (const [privateKey, publicKey, code] of pairs) {
    let sealed = false;
    await assert.rejects(prepareLighterCredentialProvisioning({
      network: "testnet",
      accountIndex: 123,
      apiKeyIndex: 4,
      generateApiKey: async () => [privateKey, publicKey, null],
      sealVault: async () => {
        sealed = true;
        return sealedVault();
      },
    }), (error) => error.code === code);
    assert.equal(sealed, false);
  }
});

test("does not leak a private key through generator or sealer failures", async () => {
  await assert.rejects(prepareLighterCredentialProvisioning({
    network: "mainnet",
    accountIndex: 123,
    apiKeyIndex: 4,
    generateApiKey: async () => {
      throw new Error(`failed for ${PRIVATE_KEY}`);
    },
    sealVault: async () => sealedVault(),
  }), (error) => error.code === "key_generation_failed" && !error.message.includes(PRIVATE_KEY));

  await assert.rejects(prepareLighterCredentialProvisioning({
    network: "mainnet",
    accountIndex: 123,
    apiKeyIndex: 4,
    generateApiKey: async () => [PRIVATE_KEY, PUBLIC_KEY, null],
    sealVault: async () => {
      throw new Error(`failed for ${PRIVATE_KEY}`);
    },
  }), (error) => error.code === "vault_sealing_failed" && !error.message.includes(PRIVATE_KEY));
});

test("rejects a sealer that echoes credential material", async () => {
  await assert.rejects(prepareLighterCredentialProvisioning({
    network: "mainnet",
    accountIndex: 123,
    apiKeyIndex: 4,
    generateApiKey: async () => [PRIVATE_KEY, PUBLIC_KEY, null],
    sealVault: async () => sealedVault({ ciphertext: PRIVATE_KEY }),
  }), (error) => error.code === "sealed_vault_exposed_key" && !error.message.includes(PRIVATE_KEY));
});

test("submits one exact owner association, verifies Lighter, and activates the sealed key", async () => {
  const workerRecipient = recipient();
  const accountCommitment = "private_account_lighter_authorize_test";
  const prepared = await prepareLighterCredential({
    ownerAddress: OWNER_ACCOUNT.address,
    accountCommitment,
    accountIndex: 123,
    apiKeyIndex: 4,
    recipient: workerRecipient,
    generateApiKey: async () => [PRIVATE_KEY, PUBLIC_KEY, null],
    sealingIdentity,
  });
  const data = lighterChangePubKeyData(123, 4, PUBLIC_KEY);
  const preparationId = lighterPreparationId({
    accountCommitment,
    ownerAddress: OWNER_ACCOUNT.address,
    accountIndex: 123,
    apiKeyIndex: 4,
    publicKey: PUBLIC_KEY,
    data,
  });
  const rawTransaction = await OWNER_ACCOUNT.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 1,
    gas: 240_000n,
    maxFeePerGas: 60_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    to: LIGHTER_PROXY,
    value: 0n,
    data,
  });
  const transactionHash = keccak256(rawTransaction);
  const state = memoryState();
  let submissions = 0;
  let apiKeyReads = 0;
  const ethereumRpcFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === "eth_sendRawTransaction") {
      submissions += 1;
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: transactionHash });
    }
    assert.equal(request.method, "eth_getTransactionReceipt");
    return jsonResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        transactionHash,
        from: OWNER_ACCOUNT.address,
        to: LIGHTER_PROXY,
        status: "0x1",
      },
    });
  };
  const body = {
    preparation_id: preparationId,
    account_commitment: accountCommitment,
    owner_address: OWNER_ACCOUNT.address,
    account_index: 123,
    api_key_index: 4,
    public_key: PUBLIC_KEY,
    raw_transaction: rawTransaction,
    encrypted_execution_vault: prepared.encrypted_execution_vault,
  };
  const result = await authorizeLighterCredential({
    body,
    recipient: workerRecipient,
    state,
    ethereumRpcUrl: "https://ethereum.test",
    ethereumRpcFetch,
    lighterFetch: async (url) => {
      if (String(url).includes("accountsByL1Address")) {
        return ownerAccountResponse(OWNER_ACCOUNT.address, 123);
      }
      apiKeyReads += 1;
      return jsonResponse({
        code: 200,
        api_keys: apiKeyReads === 1
          ? []
          : [{ account_index: 123, api_key_index: 4, public_key: PUBLIC_KEY }],
      });
    },
    sealingIdentity,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.transaction_hash, transactionHash);
  assert.equal(result.permissions.can_trade, true);
  assert.equal(result.permissions.can_withdraw, false);
  assert.equal(JSON.stringify(result).includes(PRIVATE_KEY), false);
  assert.equal(submissions, 1);
  const opened = await openSealedBundle(result.encrypted_execution_vault, workerRecipient, {
    expectedKind: "ghola_lighter_execution_vault",
    expectedAad: result.encrypted_execution_vault.aad,
  });
  assert.equal(opened.json.api_private_key, PRIVATE_KEY);
  assert.deepEqual(opened.json.allowed_operations, ["read", "limit_order", "cancel", "reconcile"]);
  assert.equal(opened.json.blocked_operations.includes("withdraw"), true);
  const credential = await openLighterExecutionCredential({
    bundle: result.encrypted_execution_vault,
    recipient: workerRecipient,
    accountCommitment,
    sealingIdentity,
  });
  assert.equal(credential.account_index, 123);
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  try {
    const verification = await verifyLighterNoSubmit({
      credential,
      instruction: {
        operation_class: "limit_order",
        order: {
          market: "BTC",
          side: "buy",
          base_size: "0.001",
          limit_price: "100000",
          tif: "Ioc",
          reduce_only: false,
        },
      },
      clientOrderIndex: 77,
      runner: async (payload) => {
        assert.equal(payload.action, "verify");
        assert.equal(payload.credential.account_index, 123);
        return {
          credential_verified: true,
          account_state_checked: true,
          market_data_checked: true,
          order_packet_built: true,
          signed_order_fields_checked: true,
          transaction_broadcast: false,
          account: { available_balance: "50", collateral: "50", positions: [], pending_order_count: 0 },
          market: { maker_fee: "0.0001", taker_fee: "0.00045" },
          order_shape: { base_size: "0.001", limit_price: "100000" },
        };
      },
    });
    assert.equal(verification.status, "verified_ready");
    assert.equal(verification.checks.transaction_broadcast, false);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
  await assert.rejects(openLighterExecutionCredential({
    bundle: result.encrypted_execution_vault,
    recipient: workerRecipient,
    accountCommitment: "private_account_lighter_wrong_binding",
    sealingIdentity,
  }), /associated data mismatch/);
  const wrongSigner = generateKeyPairSync("ed25519");
  await assert.rejects(openLighterExecutionCredential({
    bundle: result.encrypted_execution_vault,
    recipient: workerRecipient,
    accountCommitment,
    sealingIdentity: () => wrongSigner,
  }), (error) => error.code === "venue_access_required");

  const replay = await authorizeLighterCredential({
    body,
    recipient: workerRecipient,
    state,
    ethereumRpcUrl: "https://ethereum.test",
    ethereumRpcFetch,
    lighterFetch: async () => { throw new Error("cached receipt must avoid provider calls"); },
    sealingIdentity,
  });
  assert.equal(replay.status, "ready");
  assert.equal(submissions, 1);
});

test("freezes an ambiguous association and never broadcasts it twice", async () => {
  const workerRecipient = recipient();
  const accountCommitment = "private_account_lighter_ambiguous_test";
  const prepared = await prepareLighterCredential({
    ownerAddress: OWNER_ACCOUNT.address,
    accountCommitment,
    accountIndex: 123,
    apiKeyIndex: 5,
    recipient: workerRecipient,
    generateApiKey: async () => [PRIVATE_KEY, PUBLIC_KEY, null],
    sealingIdentity,
  });
  const data = lighterChangePubKeyData(123, 5, PUBLIC_KEY);
  const preparationId = lighterPreparationId({
    accountCommitment,
    ownerAddress: OWNER_ACCOUNT.address,
    accountIndex: 123,
    apiKeyIndex: 5,
    publicKey: PUBLIC_KEY,
    data,
  });
  const rawTransaction = await OWNER_ACCOUNT.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 2,
    gas: 240_000n,
    maxFeePerGas: 60_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    to: LIGHTER_PROXY,
    value: 0n,
    data,
  });
  const state = memoryState();
  let submissions = 0;
  const transactionHash = keccak256(rawTransaction);
  const body = {
    preparation_id: preparationId,
    account_commitment: accountCommitment,
    owner_address: OWNER_ACCOUNT.address,
    account_index: 123,
    api_key_index: 5,
    public_key: PUBLIC_KEY,
    raw_transaction: rawTransaction,
    encrypted_execution_vault: prepared.encrypted_execution_vault,
  };
  await assert.rejects(authorizeLighterCredential({
    body,
    recipient: workerRecipient,
    state,
    ethereumRpcUrl: "https://ethereum.test",
    ethereumRpcFetch: async () => {
      submissions += 1;
      throw new Error("unknown network outcome");
    },
    lighterFetch: vacantLighterBindingFetch(OWNER_ACCOUNT.address, 123),
    sealingIdentity,
  }), (error) => error.code === "lighter_association_ambiguous");
  assert.equal(submissions, 1);
  const frozen = await state.getExecutionAttempt(preparationId);
  assert.equal(frozen.status, "ambiguous");
  assert.equal(frozen.account_binding_verified, true);
  assert.equal(frozen.api_key_slot_vacant_verified, true);

  await assert.rejects(authorizeLighterCredential({
    body,
    recipient: workerRecipient,
    state,
    ethereumRpcUrl: "https://ethereum.test",
    ethereumRpcFetch: async () => { throw new Error("authorization retry must not contact Ethereum"); },
    lighterFetch: async () => { throw new Error("authorization retry must not contact Lighter"); },
    sealingIdentity,
  }), (error) => error.code === "lighter_association_ambiguous" && error.status === 409);
  const held = await reconcileLighterCredential({
    body: { ...body, transaction_hash: transactionHash },
    recipient: workerRecipient,
    state,
    ethereumRpcUrl: "https://ethereum.test",
    ethereumRpcFetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, "eth_getTransactionReceipt");
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: null });
    },
    lighterFetch: async () => { throw new Error("unconfirmed transaction must not query Lighter"); },
    sealingIdentity,
  });
  assert.equal(held.status, "ambiguous");
  assert.equal(held.setup.transaction_broadcast, null);
  assert.equal(submissions, 1);
  await assert.rejects(authorizeLighterCredential({
    body: { ...body, api_key_index: 4 },
    recipient: workerRecipient,
    state,
    ethereumRpcUrl: "https://ethereum.test",
    ethereumRpcFetch: async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: null }),
    sealingIdentity,
  }), (error) => error.code === "lighter_transaction_binding_invalid");
  assert.equal(submissions, 1);
});

test("refuses association before broadcast unless the exact owner/account is bound and the API-key slot is vacant", async () => {
  const workerRecipient = recipient();
  const accountCommitment = "private_account_lighter_binding_test";
  const prepared = await prepareLighterCredential({
    ownerAddress: OWNER_ACCOUNT.address,
    accountCommitment,
    accountIndex: 123,
    apiKeyIndex: 6,
    recipient: workerRecipient,
    generateApiKey: async () => [PRIVATE_KEY, PUBLIC_KEY, null],
    sealingIdentity,
  });
  const data = lighterChangePubKeyData(123, 6, PUBLIC_KEY);
  const rawTransaction = await OWNER_ACCOUNT.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 3,
    gas: 240_000n,
    maxFeePerGas: 60_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    to: LIGHTER_PROXY,
    value: 0n,
    data,
  });
  const body = {
    preparation_id: lighterPreparationId({
      accountCommitment,
      ownerAddress: OWNER_ACCOUNT.address,
      accountIndex: 123,
      apiKeyIndex: 6,
      publicKey: PUBLIC_KEY,
      data,
    }),
    account_commitment: accountCommitment,
    owner_address: OWNER_ACCOUNT.address,
    account_index: 123,
    api_key_index: 6,
    public_key: PUBLIC_KEY,
    raw_transaction: rawTransaction,
    encrypted_execution_vault: prepared.encrypted_execution_vault,
  };
  let submissions = 0;
  const ethereumRpcFetch = async () => {
    submissions += 1;
    throw new Error("must not broadcast");
  };
  await assert.rejects(authorizeLighterCredential({
    body,
    recipient: workerRecipient,
    state: memoryState(),
    ethereumRpcUrl: "https://ethereum.test",
    ethereumRpcFetch,
    lighterFetch: async (url) => String(url).includes("accountsByL1Address")
      ? ownerAccountResponse(OWNER_ACCOUNT.address, 999)
      : jsonResponse({ code: 200, api_keys: [] }),
    sealingIdentity,
  }), (error) => error.code === "lighter_account_binding_invalid");
  await assert.rejects(authorizeLighterCredential({
    body,
    recipient: workerRecipient,
    state: memoryState(),
    ethereumRpcUrl: "https://ethereum.test",
    ethereumRpcFetch,
    lighterFetch: async (url) => String(url).includes("accountsByL1Address")
      ? ownerAccountResponse(OWNER_ACCOUNT.address, 123)
      : jsonResponse({
          code: 200,
          api_keys: [{ account_index: 123, api_key_index: 6, public_key: "44".repeat(40) }],
        }),
    sealingIdentity,
  }), (error) => error.code === "lighter_api_key_slot_occupied");
  assert.equal(submissions, 0);
});

function lighterChangePubKeyData(accountIndex, apiKeyIndex, publicKey) {
  const accountHex = accountIndex.toString(16).padStart(64, "0");
  const keyIndexHex = apiKeyIndex.toString(16).padStart(64, "0");
  const offsetHex = "60".padStart(64, "0");
  const lengthHex = "28".padStart(64, "0");
  const paddedKey = publicKey.padEnd(128, "0");
  return `0x17010c68${accountHex}${keyIndexHex}${offsetHex}${lengthHex}${paddedKey}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ownerAccountResponse(ownerAddress, accountIndex) {
  return jsonResponse({
    code: 200,
    l1_address: ownerAddress,
    sub_accounts: [{ index: accountIndex, l1_address: ownerAddress }],
  });
}

function vacantLighterBindingFetch(ownerAddress, accountIndex) {
  return async (url) => String(url).includes("accountsByL1Address")
    ? ownerAccountResponse(ownerAddress, accountIndex)
    : jsonResponse({ code: 200, api_keys: [] });
}

function memoryState() {
  const attempts = new Map();
  const receipts = new Map();
  return {
    async getExecutionAttempt(key) { return attempts.get(key) || null; },
    async claimExecutionAttempt(key, value) {
      if (attempts.has(key)) return { ok: false, existing: attempts.get(key) };
      attempts.set(key, { ...value });
      return { ok: true, attempt: value };
    },
    async putExecutionAttempt(key, value) {
      attempts.set(key, { ...value });
      return value;
    },
    async getIdempotency(key) {
      return receipts.has(key) ? { receipt: receipts.get(key) } : null;
    },
    async putIdempotency(key, value) {
      receipts.set(key, value);
      return value;
    },
  };
}
