import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { x25519 } from "@noble/curves/ed25519";
import {
  bytesToBase64,
  bytesToHex,
  didKeyFromVerifying,
  sealForTest,
} from "../src/crypto/envelope.js";
import { executeAutopilotOrder } from "../src/execution/private-execution.js";
import { createWorkerState } from "../src/state/private-state.js";

test("atomically permits exactly one Lighter submission under concurrent identical requests", async (t) => {
  const old = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "ghola-lighter-concurrent-submit-"));
  t.after(() => {
    process.env = old;
    rmSync(dir, { recursive: true, force: true });
  });

  const signer = generateKeyPairSync("ed25519");
  process.env.PRIVATE_AGENT_FUNDING_SIGNING_KEY = signer.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "full_ticket";
  process.env.PRIVATE_AGENT_LIGHTER_FULL_TICKET_MAX_NOTIONAL_USD = "25";
  process.env.PRIVATE_AGENT_LIGHTER_DAILY_NOTIONAL_CAP_USD = "100";
  process.env.PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD = "0";
  process.env.PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE = "0";
  process.env.PRIVATE_AGENT_LIGHTER_RECONCILE_TIMEOUT_MS = "250";
  process.env.PRIVATE_AGENT_LIGHTER_RECONCILE_INTERVAL_MS = "25";

  const actionLog = join(dir, "runner-actions.log");
  const runner = join(dir, "lighter-test-runner.mjs");
  writeFileSync(runner, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
appendFileSync(process.env.GHOLA_LIGHTER_TEST_LOG, payload.action + "\\n");
const result = payload.action === "submit"
  ? { accepted: true, status: "submitted", tx_hash: "lighter-test-tx" }
  : {
      target_market_checked: true,
      order: {
        client_order_index: payload.client_order_index,
        order_index: "7",
        market_index: 1,
        status: "filled",
        filled_base_amount: "0.01",
        filled_quote_amount: "10"
      },
      fee_proof: {
        version: 1,
        proof_kind: "lighter_authenticated_order_trades_fee_v1",
        complete: true,
        pagination_complete: true,
        transaction_broadcast: false,
        account_index: 123,
        market_id: 1,
        order_index: "7",
        client_order_index: payload.client_order_index,
        trade_count: 1,
        first_trade_id: "9223372036854775807",
        last_trade_id: "9223372036854775807",
        filled_base_amount: "0.01",
        filled_quote_amount: "10",
        fee_quote_amount: "0.001",
        fee_asset: "USDC",
        fee_rate_tick_denominator: 1000000,
        quote_atomic_denominator: 1000000,
        evidence_commitment: "sha256:${"ab".repeat(32)}"
      }
    };
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
  chmodSync(runner, 0o700);
  process.env.PRIVATE_AGENT_PYTHON = runner;
  process.env.GHOLA_LIGHTER_TEST_LOG = actionLog;

  const recipientSecret = x25519.utils.randomPrivateKey();
  const recipientPublic = x25519.getPublicKey(recipientSecret);
  const recipient = {
    recipient_id: "phala:cvm:lighter-concurrency-test",
    x25519_secret_hex: bytesToHex(recipientSecret),
    x25519_pub_hex: bytesToHex(recipientPublic),
  };
  const accountCommitment = "private_account_lighter_concurrent_test";
  const aad = [
    "ghola/lighter-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const publicDer = signer.publicKey.export({ format: "der", type: "spki" });
  const senderDid = didKeyFromVerifying(new Uint8Array(publicDer.subarray(-32)));
  const sealed = await sealForTest({
    senderDid,
    recipientId: recipient.recipient_id,
    recipientX25519: recipientPublic,
    associatedData: aad,
    plaintext: {
      version: 1,
      kind: "ghola_lighter_execution_vault",
      network: "mainnet",
      account_commitment: accountCommitment,
      owner_address: `0x${"33".repeat(20)}`,
      account_index: 123,
      api_key_index: 4,
      api_private_key: "11".repeat(32),
      api_public_key: "22".repeat(40),
      provisioning_status: "owner_association_verified",
      permissions: { can_read: true, can_trade: true, can_withdraw: false, can_transfer: false },
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
      owner_only_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
    },
    signBody: async (digest) => new Uint8Array(sign(null, Buffer.from(digest), signer.privateKey)),
  });

  const state = createWorkerState(dir);
  const args = {
    venue_id: "lighter",
    operation_class: "limit_order",
    work_order_commitment: "work:lighter:concurrent:0001",
    policy_commitment: "policy:lighter:concurrent:0001",
    session_policy: {
      policy_commitment: "policy:lighter:concurrent:0001",
      market_allowlist: ["BTC-PERP"],
      max_notional_bucket: "25",
      max_order_count: 1,
      max_daily_notional_bucket: "100",
      kill_switch: false,
    },
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "lighter",
      operation_class: "limit_order",
      order: {
        market: "BTC",
        side: "buy",
        base_size: "0.01",
        limit_price: "1000",
        tif: "Ioc",
        reduce_only: false,
      },
    },
    execution: {
      execution_mode: "byo_api_key",
      account_commitment: accountCommitment,
      encrypted_execution_vault: {
        alg: "sealed-provider-v1",
        ciphertext: bytesToBase64(sealed),
        recipient: recipient.recipient_id,
        aad,
      },
    },
    recipient,
    state,
  };

  const originalGetAttempt = state.getExecutionAttempt.bind(state);
  const originalClaimAttempt = state.claimExecutionAttemptWithPolicyUsage.bind(state);
  let reads = 0;
  let releaseReads;
  let firstRead;
  const bothRead = new Promise((resolve) => { releaseReads = resolve; });
  const firstReadStarted = new Promise((resolve) => { firstRead = resolve; });
  const claims = [];
  state.getExecutionAttempt = async (key) => {
    const result = await originalGetAttempt(key);
    if (key === args.work_order_commitment && reads < 2) {
      reads += 1;
      if (reads === 1) {
        firstRead();
        await bothRead;
      } else {
        releaseReads();
      }
    }
    return result;
  };
  state.claimExecutionAttemptWithPolicyUsage = async (...claimArgs) => {
    const result = await originalClaimAttempt(...claimArgs);
    claims.push(result.ok);
    return result;
  };

  const first = executeAutopilotOrder(args);
  await firstReadStarted;
  const second = executeAutopilotOrder(args);
  const outcomes = await Promise.allSettled([first, second]);

  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejected.reason.status, 409);
  assert.match(rejected.reason.message, /reconcile it instead of retrying/);
  assert.deepEqual(readFileSync(actionLog, "utf8").trim().split("\n"), ["submit", "reconcile"]);
  const attempt = await originalGetAttempt(args.work_order_commitment);
  assert.equal(attempt.status, "filled");
  assert.equal(attempt.submit_count, 1);
  assert.equal(attempt.ambiguity_retry_count, 0);

  const persisted = JSON.parse(readFileSync(join(dir, "private-agent-execution-state-v1.json"), "utf8"));
  assert.deepEqual(Object.keys(persisted.policy_counts), [args.policy_commitment]);
  assert.equal(persisted.policy_counts[args.policy_commitment].count, 1);
  assert.equal(Object.keys(persisted.policy_amounts).length, 2);
  assert.equal(Object.values(persisted.policy_amounts).every((entry) => entry.amount === 10), true);

  const deniedArgs = {
    ...args,
    work_order_commitment: "work:lighter:policy-denied:0001",
    policy_commitment: "policy:lighter:policy-denied:0001",
    session_policy: {
      ...args.session_policy,
      policy_commitment: "policy:lighter:policy-denied:0001",
      max_order_count: 0,
    },
  };
  const runnerCallsBeforeDenial = readFileSync(actionLog, "utf8");
  await assert.rejects(
    executeAutopilotOrder(deniedArgs),
    /session policy order count exceeded/,
  );
  assert.equal(readFileSync(actionLog, "utf8"), runnerCallsBeforeDenial);
  const deniedAttempt = await originalGetAttempt(deniedArgs.work_order_commitment);
  assert.equal(deniedAttempt.status, "failed_no_submit");
  assert.equal(deniedAttempt.submit_count, 0);
  assert.equal(deniedAttempt.final_proof, null);

  const recovered = await executeAutopilotOrder({
    ...deniedArgs,
    session_policy: {
      ...deniedArgs.session_policy,
      max_order_count: 1,
    },
  });
  assert.equal(recovered.status, "filled");
  const rearmedAttempt = await originalGetAttempt(deniedArgs.work_order_commitment);
  assert.equal(rearmedAttempt.status, "filled");
  assert.equal(rearmedAttempt.submit_count, 1);
  assert.equal(rearmedAttempt.ambiguity_retry_count, 0);
  assert.equal(rearmedAttempt.policy_rearm_count, 1);
  assert.equal(rearmedAttempt.policy_rearm_lineage.length, 1);
  assert.equal(rearmedAttempt.policy_rearm_lineage[0].status, "failed_no_submit");
  assert.equal(rearmedAttempt.policy_rearm_lineage[0].submit_count, 0);
  assert.equal(rearmedAttempt.policy_rearm_lineage[0].policy_denial.key, deniedArgs.policy_commitment);

  const recoveredState = JSON.parse(readFileSync(join(dir, "private-agent-execution-state-v1.json"), "utf8"));
  assert.equal(recoveredState.policy_counts[deniedArgs.policy_commitment].count, 1);
  const recoveredAmounts = Object.entries(recoveredState.policy_amounts)
    .filter(([key]) => key.includes(deniedArgs.policy_commitment));
  assert.equal(recoveredAmounts.length, 2);
  assert.equal(recoveredAmounts.every(([, entry]) => entry.amount === 10), true);
});
