import test from "node:test";
import assert from "node:assert/strict";
import {
  mintFreshExecutionCredential,
  relayShieldedWithdrawal,
  pollShieldedWithdrawStatus,
  fundFreshCredential,
  ShieldedFundingError,
  NATIVE_SHIELDED_RAIL,
} from "../src/venues/shielded_funding.js";

const BUNDLE = { instruction_data_hex: "deadbeef", accounts: [] };

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

// fetch is injected per-call via fetchImpl (no global mutation), so tests are
// isolation-proof when files run together.

test("mintFreshExecutionCredential returns a fresh keypair + pubkey", () => {
  const a = mintFreshExecutionCredential();
  const b = mintFreshExecutionCredential();
  assert.ok(a.public_key.length > 0);
  assert.notEqual(a.public_key, b.public_key, "each credential is fresh");
  assert.equal(a.keypair.publicKey.toBase58(), a.public_key);
});

test("relay requires configured relayer outside dry-run", async () => {
  await withEnv(
    { GHOLA_SHIELDED_POOL_RELAYER_URL: undefined, PRIVATE_AGENT_VENUE_DRY_RUN: undefined },
    async () => {
      await assert.rejects(
        () =>
          relayShieldedWithdrawal({
            withdraw_bundle: BUNDLE,
            destination_commitment: "dest-1",
            amount_bucket: "25",
          }),
        (err) => err instanceof ShieldedFundingError && err.code === "shielded_pool_unconfigured",
      );
    },
  );
});

test("dry-run relay returns a deterministic mock id without network", async () => {
  await withEnv({ PRIVATE_AGENT_VENUE_DRY_RUN: "true" }, async () => {
    const fetchImpl = () => {
      throw new Error("network must not be called in dry-run");
    };
    const a = await relayShieldedWithdrawal({
      withdraw_bundle: BUNDLE,
      destination_commitment: "dest-commit-deterministic",
      amount_bucket: "25",
      fetchImpl,
    });
    const b = await relayShieldedWithdrawal({
      withdraw_bundle: BUNDLE,
      destination_commitment: "dest-commit-deterministic",
      amount_bucket: "25",
      fetchImpl,
    });
    assert.equal(a.relay_id, b.relay_id, "deterministic for same destination");
  });
});

test("relay rejects a missing destination or bundle", async () => {
  await withEnv({ PRIVATE_AGENT_VENUE_DRY_RUN: "true" }, async () => {
    await assert.rejects(
      () => relayShieldedWithdrawal({ withdraw_bundle: BUNDLE, destination_commitment: "", amount_bucket: "25" }),
      (err) => err.code === "destination_required",
    );
    await assert.rejects(
      () => relayShieldedWithdrawal({ withdraw_bundle: null, destination_commitment: "d", amount_bucket: "25" }),
      (err) => err.code === "withdraw_bundle_required",
    );
  });
});

test("relay surfaces a relayer rejection", async () => {
  await withEnv(
    { GHOLA_SHIELDED_POOL_RELAYER_URL: "https://relayer.example", PRIVATE_AGENT_VENUE_DRY_RUN: undefined },
    async () => {
      const fetchImpl = async () => ({ ok: false, status: 422, json: async () => ({}) });
      await assert.rejects(
        () =>
          relayShieldedWithdrawal({
            withdraw_bundle: BUNDLE,
            destination_commitment: "dest-1",
            amount_bucket: "25",
            fetchImpl,
          }),
        (err) => err.code === "relayer_rejected",
      );
    },
  );
});

test("poll returns a confirmed observation from the relayer", async () => {
  await withEnv(
    { GHOLA_SHIELDED_POOL_RELAYER_URL: "https://relayer.example", PRIVATE_AGENT_VENUE_DRY_RUN: undefined },
    async () => {
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          status: "confirmed",
          confirmations: 5,
          destination_commitment: "dest-1",
          amount_bucket: "25",
        }),
      });
      const obs = await pollShieldedWithdrawStatus("relay-1", {
        now: () => new Date("2026-05-29T00:00:00Z"),
        fetchImpl,
      });
      assert.equal(obs.status, "confirmed");
      assert.equal(obs.confirmations, 5);
      assert.equal(obs.destination_commitment, "dest-1");
      assert.equal(obs.amount_bucket, "25");
      assert.equal(obs.observed_at, "2026-05-29T00:00:00.000Z");
    },
  );
});

test("poll treats a 404 as failed (fail-closed)", async () => {
  await withEnv(
    { GHOLA_SHIELDED_POOL_RELAYER_URL: "https://relayer.example", PRIVATE_AGENT_VENUE_DRY_RUN: undefined },
    async () => {
      const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
      const obs = await pollShieldedWithdrawStatus("relay-missing", { fetchImpl });
      assert.equal(obs.status, "failed");
    },
  );
});

test("poll normalizes an unknown status to pending", async () => {
  await withEnv(
    { GHOLA_SHIELDED_POOL_RELAYER_URL: "https://relayer.example", PRIVATE_AGENT_VENUE_DRY_RUN: undefined },
    async () => {
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "weird", confirmations: 0 }),
      });
      const obs = await pollShieldedWithdrawStatus("relay-1", { fetchImpl });
      assert.equal(obs.status, "pending");
    },
  );
});

test("fundFreshCredential polls until confirmed", async () => {
  await withEnv(
    { GHOLA_SHIELDED_POOL_RELAYER_URL: "https://relayer.example", PRIVATE_AGENT_VENUE_DRY_RUN: undefined },
    async () => {
      const statuses = [
        { status: "pending", confirmations: 0 },
        { status: "submitted", confirmations: 1 },
        { status: "confirmed", confirmations: 3, destination_commitment: "dest-1", amount_bucket: "25" },
      ];
      let i = 0;
      const fetchImpl = async (url) => {
        // Status URLs (/status/relay-1) contain the "/relay" substring, so
        // match the more specific /status/ route first.
        if (url.includes("/status/")) {
          const body = statuses[Math.min(i, statuses.length - 1)];
          i += 1;
          return { ok: true, status: 200, json: async () => body };
        }
        return { ok: true, status: 200, json: async () => ({ relay_id: "relay-1" }) };
      };
      const obs = await fundFreshCredential({
        withdraw_bundle: BUNDLE,
        destination_commitment: "dest-1",
        amount_bucket: "25",
        minConfirmations: 3,
        timeoutMs: 10_000,
        intervalMs: 0,
        sleep: async () => {},
        fetchImpl,
      });
      assert.equal(obs.rail, NATIVE_SHIELDED_RAIL);
      assert.equal(obs.status, "confirmed");
      assert.equal(obs.confirmations, 3);
      assert.equal(obs.destination_commitment, "dest-1");
      assert.equal(obs.amount_bucket, "25");
    },
  );
});

test("fundFreshCredential returns last non-confirmed observation on timeout (fail-closed)", async () => {
  await withEnv(
    { GHOLA_SHIELDED_POOL_RELAYER_URL: "https://relayer.example", PRIVATE_AGENT_VENUE_DRY_RUN: undefined },
    async () => {
      let clock = 0;
      const fetchImpl = async (url) => {
        if (url.includes("/status/")) {
          return { ok: true, status: 200, json: async () => ({ status: "pending", confirmations: 0 }) };
        }
        return { ok: true, status: 200, json: async () => ({ relay_id: "relay-1" }) };
      };
      const obs = await fundFreshCredential({
        withdraw_bundle: BUNDLE,
        destination_commitment: "dest-1",
        amount_bucket: "25",
        minConfirmations: 3,
        timeoutMs: 5,
        intervalMs: 0,
        sleep: async () => {
          clock += 10;
        },
        now: () => new Date(clock),
        fetchImpl,
      });
      assert.notEqual(obs.status, "confirmed");
      // Verifier will reject this — producer never fabricates confirmation.
    },
  );
});
