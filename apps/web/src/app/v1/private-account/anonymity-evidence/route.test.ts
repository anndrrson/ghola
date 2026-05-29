import { afterEach, describe, expect, it } from "vitest";
import { POST as createAccount } from "../create/route";
import { POST } from "./route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

const AUTH = `Bearer ${[
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "user_1", email: "user@example.com" })).toString("base64url"),
  "sig",
].join(".")}`;
const INTERNAL_TOKEN = "test_internal_private_account_token";

function userRequest(path: string, body: unknown = {}) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: AUTH,
    },
    body: JSON.stringify(body),
  });
}

function internalRequest(path: string, body: unknown, token = INTERNAL_TOKEN) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("private account anonymity evidence route", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
  });

  it("requires internal auth before writing anonymity evidence", async () => {
    const createRes = await createAccount(userRequest("/v1/private-account/create"));
    const created = await createRes.json();

    const res = await POST(
      userRequest("/v1/private-account/anonymity-evidence", {
        account_commitment: created.account.account_commitment,
        effective_anonymity_set: 75,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("internal_auth_required");
  });

  it("writes commitment-only evidence with valid internal auth", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    const createRes = await createAccount(userRequest("/v1/private-account/create"));
    const created = await createRes.json();

    const res = await POST(
      internalRequest("/v1/private-account/anonymity-evidence", {
        account_commitment: created.account.account_commitment,
        source: "internal_test",
        effective_anonymity_set: 75,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.evidence.evidence_commitment).toMatch(/^anon_evidence_/);
    expect(JSON.stringify(body)).not.toContain("wallet_address");
  });

  it("rejects forbidden raw fields before writing evidence", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    const res = await POST(
      internalRequest("/v1/private-account/anonymity-evidence", {
        account_commitment: "acct_missing",
        wallet_address: "raw-wallet",
        effective_anonymity_set: 75,
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("forbidden");
  });
});
