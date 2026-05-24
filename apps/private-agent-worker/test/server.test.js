import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateAgentWorkerServer, loadRecipient } from "../src/server.js";

const OLD_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...OLD_ENV };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function encryptedRequest(overrides = {}) {
  return {
    version: 1,
    strategy_id: "strategy_123",
    policy_hash: "policy_hash_123",
    owner_did: "did:key:z123",
    mode: "capped_session_key",
    encrypted_strategy_bundle: {
      alg: "sealed-provider-v1",
      ciphertext: "sealed-ciphertext",
      recipient: "phala:cvm:recipient",
      aad: "ghola/private-agent-session-v1",
    },
    ...overrides,
  };
}

describe("private agent worker", () => {
  let dir;
  let server;
  let baseUrl;

  beforeEach(async () => {
    resetEnv();
    dir = mkdtempSync(join(tmpdir(), "ghola-private-agent-worker-"));
    process.env.PRIVATE_AGENT_DATA_DIR = dir;
    process.env.PRIVATE_AGENT_EXECUTION_TOKEN = "secret";
    process.env.PRIVATE_AGENT_ALLOW_UNATTESTED_DEV = "true";
    server = createPrivateAgentWorkerServer();
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
    resetEnv();
  });

  it("publishes a stable recipient key", async () => {
    const first = await fetch(`${baseUrl}/.well-known/private-agent-recipient`);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.match(body.recipient_id, /^phala:cvm:/);
    assert.match(body.x25519_pub_hex, /^[0-9a-f]{64}$/);
    assert.equal(body.attested_ready, false);

    const loaded = loadRecipient();
    assert.equal(loaded.recipient_id, body.recipient_id);
    assert.equal(loaded.x25519_pub_hex, body.x25519_pub_hex);
  });

  it("rejects missing provider bearer tokens", async () => {
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(encryptedRequest()),
    });

    assert.equal(response.status, 401);
  });

  it("rejects plaintext strategy fields recursively", async () => {
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(
        encryptedRequest({
          nested: {
            prompt: "buy ETH every Friday",
          },
        }),
      ),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.details.join(" "), /plaintext/);
  });

  it("accepts encrypted sessions in explicit unattested dev mode only", async () => {
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(encryptedRequest()),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.version, 1);
    assert.equal(body.provider, "phala");
    assert.equal(body.strategy_id, "strategy_123");
    assert.equal(body.sealed_execution_required, true);
  });
});
