#!/usr/bin/env node

const rawBase = process.env.GHOLA_VERIFY_BASE_URL?.trim();
const expectedSignerDid = process.env.GHOLA_REVIEW_PROOF_SIGNER_DID?.trim();
if (!rawBase) {
  fail("Set GHOLA_VERIFY_BASE_URL explicitly (for example, https://ghola.xyz).");
}

const base = new URL(rawBase);
if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
  fail("The review-proof verifier requires HTTPS except on localhost.");
}

const keyUrl = new URL("/v1/private-account/demo/verification-key", base);
const keyResponse = await requestJson(keyUrl, { method: "GET" });
assert(keyResponse.response.ok, `verification-key returned HTTP ${keyResponse.response.status}`);
assert(keyResponse.body?.configured === true, "review receipt signing key is not configured");
assert(keyResponse.body?.algorithm === "Ed25519", "review receipt key is not Ed25519");
assert(typeof keyResponse.body?.signer_did === "string", "review receipt signer DID is missing");
if (expectedSignerDid) {
  assert(
    keyResponse.body.signer_did === expectedSignerDid,
    "published review signer differs from GHOLA_REVIEW_PROOF_SIGNER_DID",
  );
}

// Only request a proof after the new side-effect-free key endpoint is present.
// This avoids accidentally exercising an older deployment whose public demo
// route still woke paid compute.
const runUrl = new URL("/v1/private-account/demo/run", base);
const startedAt = Date.now();
const runResponse = await requestJson(runUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    scenario_id: "btc_momentum",
    venue_id: "phoenix",
    market_id: "BTC-USD",
    notional_bucket: 25,
    max_slippage_bps: 50,
  }),
});
const elapsedMs = Date.now() - startedAt;
assert(runResponse.response.ok, `demo run returned HTTP ${runResponse.response.status}`);
const run = runResponse.body;
assert(run?.execution_mode === "public_no_submit", "execution mode is not public_no_submit");
assert(run?.wallet_required === false, "review receipt unexpectedly requires a wallet");
assert(run?.deposit_required === false, "review receipt unexpectedly requires a deposit");
assert(run?.broadcast === false, "review receipt unexpectedly reports a broadcast");
assert(run?.demo_run_id === run?.execution_ticket?.ticket_id, "run and ticket IDs differ");
assert(run?.verification?.status === "signed_exact_receipt", "exact receipt is not signed");
assert(run?.verification?.method === "Ed25519", "exact receipt is not Ed25519 signed");
assert(
  run?.verification?.signer_did === keyResponse.body.signer_did,
  "receipt signer differs from the published review key",
);

const verifyUrl = new URL(run.verification.verification_url);
assert(verifyUrl.origin === base.origin, "exact verifier points at a different origin");
assert(
  verifyUrl.pathname === "/v1/private-account/demo/verify",
  "exact verifier points at the wrong path",
);
const verifiedResponse = await requestJson(verifyUrl, { method: "GET" });
assert(verifiedResponse.response.ok, `exact verifier returned HTTP ${verifiedResponse.response.status}`);
const verified = verifiedResponse.body;
assert(verified?.valid === true, `exact verifier failed: ${verified?.reason_code ?? "unknown"}`);
assert(verified?.signature_valid === true, "exact verifier did not validate the signature");
assert(verified?.receipt_hash_matches === true, "exact verifier did not validate the receipt hash");
assert(
  verified?.receipt_sha256 === run.verification.receipt_sha256,
  "verified receipt hash differs from the in-app response",
);
assert(
  verified?.receipt?.execution_ticket?.ticket_id === run.execution_ticket.ticket_id,
  "exact verifier returned a different ticket",
);

for (const field of [
  "policy_commitment",
  "private_intent_commitment",
  "strategy_commitment",
  "sealed_envelope_commitment",
  "work_order_commitment",
  "attestation_commitment",
  "result_commitment",
]) {
  assert(
    verified.receipt.execution_ticket[field] === run.execution_ticket[field],
    `exact verifier returned a different ${field}`,
  );
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  elapsed_ms: elapsedMs,
  ticket_id: run.execution_ticket.ticket_id,
  receipt_sha256: run.verification.receipt_sha256,
  signer_did: run.verification.signer_did,
  worker_ready: run.worker?.ready === true,
  worker_attested_ready: run.worker?.attested_ready === true,
  run_status: run.status,
}, null, 2)}\n`);

async function requestJson(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const body = await response.json().catch(() => null);
    return { response, body };
  } catch (error) {
    fail(`${url.pathname} request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`review-proof verification failed: ${message}\n`);
  process.exit(1);
}
