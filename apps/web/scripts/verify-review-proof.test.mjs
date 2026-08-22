import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const verifier = fileURLToPath(new URL("./verify-review-proof.mjs", import.meta.url));
const signerDid = "did:key:z6MkhGholaReviewProofFixture11111111111111111111";
const commitments = {
  policy_commitment: "policy_fixture",
  private_intent_commitment: "intent_fixture",
  strategy_commitment: "strategy_fixture",
  sealed_envelope_commitment: "envelope_fixture",
  work_order_commitment: "work_fixture",
  attestation_commitment: "attestation_fixture",
  result_commitment: "result_fixture",
};

test("a complete exact-ticket reviewer story passes", async () => {
  await withReviewerServer({}, async ({ baseUrl, requests }) => {
    const result = await runVerifier(baseUrl);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests, [
      "GET /v1/private-account/demo/verification-key",
      "POST /v1/private-account/demo/run",
      "GET /v1/private-account/demo/verify?token=fixture",
    ]);
    assert.equal(JSON.parse(result.stdout).ok, true);
  });
});

test("a missing public key route fails before requesting a demo run", async () => {
  await withReviewerServer({ keyStatus: 404 }, async ({ baseUrl, requests }) => {
    const result = await runVerifier(baseUrl);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /verification-key returned HTTP 404/);
    assert.deepEqual(requests, ["GET /v1/private-account/demo/verification-key"]);
  });
});

test("a signer pin mismatch fails before requesting a demo run", async () => {
  await withReviewerServer({ publishedSignerDid: `${signerDid}Different` }, async ({ baseUrl, requests }) => {
    const result = await runVerifier(baseUrl);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /published review signer differs/);
    assert.deepEqual(requests, ["GET /v1/private-account/demo/verification-key"]);
  });
});

test("a verifier response for a different exact receipt is rejected", async () => {
  await withReviewerServer({ changedResultCommitment: true }, async ({ baseUrl, requests }) => {
    const result = await runVerifier(baseUrl);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /different result_commitment/);
    assert.equal(requests.at(-1), "GET /v1/private-account/demo/verify?token=fixture");
  });
});

async function runVerifier(baseUrl) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [verifier], {
      env: {
        ...process.env,
        GHOLA_VERIFY_BASE_URL: baseUrl,
        GHOLA_REVIEW_PROOF_SIGNER_DID: signerDid,
      },
      timeout: 5_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

async function withReviewerServer(options, assertion) {
  const requests = [];
  let baseUrl = "";
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url === "/v1/private-account/demo/verification-key") {
      json(response, options.keyStatus ?? 200, {
        configured: true,
        algorithm: "Ed25519",
        signer_did: options.publishedSignerDid ?? signerDid,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/private-account/demo/run") {
      for await (const _ of request) {
        // Drain the request before responding so the child process can reuse the connection.
      }
      json(response, 200, fixtureRun(baseUrl));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/private-account/demo/verify?token=fixture") {
      const run = fixtureRun(baseUrl);
      json(response, 200, {
        valid: true,
        signature_valid: true,
        receipt_hash_matches: true,
        receipt_sha256: run.verification.receipt_sha256,
        receipt: {
          execution_ticket: {
            ...run.execution_ticket,
            ...(options.changedResultCommitment ? { result_commitment: "changed_result" } : {}),
          },
        },
      });
      return;
    }
    json(response, 404, { error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server address unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await assertion({ baseUrl, requests });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function fixtureRun(baseUrl) {
  return {
    status: "verified_no_submit_structural",
    demo_run_id: "fixture",
    execution_mode: "public_no_submit",
    wallet_required: false,
    deposit_required: false,
    broadcast: false,
    execution_ticket: { ticket_id: "fixture", ...commitments },
    verification: {
      status: "signed_exact_receipt",
      method: "Ed25519",
      signer_did: signerDid,
      verification_url: `${baseUrl}/v1/private-account/demo/verify?token=fixture`,
      receipt_sha256: "a".repeat(64),
    },
    worker: { ready: false, attested_ready: false },
  };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
