import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectInviteResponse,
  issueInvestorAccessPass,
  main,
} from "./issue-investor-access-pass.mjs";

const CODE = "A".repeat(43);
const INVITE = "https://ghola.xyz/account#access=" + CODE;
const PASS_ID = "123e4567-e89b-42d3-a456-426614174000";
const IDEMPOTENCY_KEY = "investor-issuance-0001";

test("issues through the operator route and stores the invitation only in a 0600 file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-investor-pass-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outPath = join(directory, "investor.json");
  let request;
  const result = await issueInvestorAccessPass({
    email: "Investor@Example.com",
    outPath,
    tier: "private_agent",
    grantDays: 14,
    redeemDays: 7,
    idempotencyKey: IDEMPOTENCY_KEY,
    apiBase: "https://api.ghola.test",
    expectedWebOrigin: "https://ghola.xyz",
    operatorBearer: "operator-session-token-value",
    adminSecret: "a".repeat(32),
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return Response.json({
        pass_id: PASS_ID,
        invite_url: INVITE,
        tier: "private_agent",
        redeem_expires_at: "2026-08-26T16:00:00+00:00",
        grant_days: 14,
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, "https://api.ghola.test/api/billing/access-passes");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.authorization, "Bearer operator-session-token-value");
  assert.equal(request.init.headers["x-ghola-admin-secret"], "a".repeat(32));
  assert.deepEqual(JSON.parse(request.init.body), {
    email: "investor@example.com",
    tier: "private_agent",
    grant_days: 14,
    redeem_days: 7,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal((await stat(outPath)).mode & 0o777, 0o600);
  const artifact = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(artifact.invite_url, INVITE);
  assert.equal(artifact.pass_id, PASS_ID);
  assert.equal(artifact.idempotency_key, IDEMPOTENCY_KEY);
  assert.equal(artifact.email, "investor@example.com");
  assert.equal(artifact.redeem_expires_at, "2026-08-26T16:00:00+00:00");
});

test("never prints the invitation URL on success", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-investor-pass-main-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outPath = join(directory, "investor.json");
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (value) => { stdout += String(value); return true; };
  process.stderr.write = (value) => { stderr += String(value); return true; };
  t.after(() => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  });
  const status = await main([
    "--email", "investor@example.com",
    "--idempotency-key", IDEMPOTENCY_KEY,
    "--out", outPath,
  ], {
    GHOLA_THUMPER_API_BASE: "https://api.ghola.test",
    GHOLA_INVESTOR_WEB_ORIGIN: "https://ghola.xyz",
    GHOLA_OPERATOR_SESSION_TOKEN: "operator-session-token-value",
    GHOLA_INVESTOR_PASS_ADMIN_SECRET: "a".repeat(32),
  }, async () => Response.json({
    pass_id: PASS_ID,
    invite_url: INVITE,
    tier: "private_agent",
    redeem_expires_at: "2026-08-26T16:00:00.000Z",
    grant_days: 14,
  }));
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /access=/u);
  assert.doesNotMatch(stdout, new RegExp(CODE, "u"));
  assert.equal(stdout.includes(outPath), false);
});

test("rejects query tokens, wrong paths, origins, or extra fragments", () => {
  const base = {
    pass_id: PASS_ID,
    tier: "private_agent",
    redeem_expires_at: "2026-08-26T16:00:00.000Z",
    grant_days: 14,
  };
  assert.equal(inspectInviteResponse({
    ...base,
    invite_url: INVITE,
  }, "https://ghola.xyz")?.url, INVITE);
  assert.equal(inspectInviteResponse({
    ...base,
    invite_url: INVITE,
  }), null);
  for (const invite_url of [
    "https://ghola.xyz/account?access=" + CODE,
    "https://ghola.xyz/trade#access=" + CODE,
    "https://www.ghola.xyz/account#access=" + CODE,
    "https://ghola.xyz.attacker.test/account#access=" + CODE,
    "https://evil.test/account#access=" + CODE,
    "https://ghola.xyz/account#access=" + CODE + "&x=1",
  ]) {
    assert.equal(inspectInviteResponse({ ...base, invite_url }, "https://ghola.xyz"), null);
  }
});

test("fails closed when the server returns a different grant", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-investor-pass-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outPath = join(directory, "investor.json");
  await assert.rejects(issueInvestorAccessPass({
    email: "investor@example.com",
    outPath,
    tier: "private_agent",
    grantDays: 14,
    redeemDays: 7,
    idempotencyKey: IDEMPOTENCY_KEY,
    apiBase: "https://api.ghola.test",
    expectedWebOrigin: "https://ghola.xyz",
    operatorBearer: "operator-session-token-value",
    adminSecret: "a".repeat(32),
    fetchImpl: async () => Response.json({
      pass_id: PASS_ID,
      invite_url: INVITE,
      tier: "starter",
      redeem_expires_at: "2026-08-26T16:00:00+00:00",
      grant_days: 14,
    }),
  }), /issuance_response_invalid/u);
  await assert.rejects(stat(outPath));
});

test("fails closed without leaving a token file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-investor-pass-fail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outPath = join(directory, "investor.json");
  await assert.rejects(issueInvestorAccessPass({
    email: "investor@example.com",
    outPath,
    tier: "private_agent",
    grantDays: 14,
    redeemDays: 7,
    idempotencyKey: IDEMPOTENCY_KEY,
    apiBase: "https://api.ghola.test",
    expectedWebOrigin: "https://ghola.xyz",
    operatorBearer: "operator-session-token-value",
    adminSecret: "a".repeat(32),
    fetchImpl: async () => Response.json({ error: "denied" }, { status: 403 }),
  }), /issuance_request_failed/u);
  await assert.rejects(stat(outPath));
});
