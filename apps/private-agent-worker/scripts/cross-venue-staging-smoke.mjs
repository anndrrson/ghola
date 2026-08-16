import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.PRIVATE_AGENT_TEST_POSTGRES_URL || process.env.PRIVATE_AGENT_STAGING_POSTGRES_URL || "";
if (!databaseUrl) throw new Error("PRIVATE_AGENT_STAGING_POSTGRES_URL or PRIVATE_AGENT_TEST_POSTGRES_URL is required");

const fixture = new URL("./fixtures/cross-venue-postgres-process.mjs", import.meta.url);
const seed = `staging_${Date.now()}_${randomBytes(6).toString("hex")}`;
const entry = await run("normal");
assert.equal(entry.parent_status, "completed");
assert.equal(entry.submit_calls, 2);

const entryReplay = await run("recover");
assert.equal(entryReplay.replayed, true);
assert.equal(entryReplay.submit_calls, 0);

const close = await run("close");
assert.equal(close.parent_status, "completed");
assert.equal(close.close_submit_calls, 2);

const closeReplay = await run("recover_close");
assert.equal(closeReplay.replayed, true);
assert.equal(closeReplay.close_submit_calls, 0);

process.stdout.write(`${JSON.stringify({
  version: 1,
  status: "passed",
  store: "postgres",
  entry_submits: entry.submit_calls,
  close_submits: close.close_submit_calls,
  restart_rebroadcasts: entryReplay.submit_calls + closeReplay.close_submit_calls,
  final_flat_proven: close.parent_status === "completed",
})}\n`);

async function run(mode) {
  const { stdout } = await execFileAsync(process.execPath, [fixture.pathname, databaseUrl, seed, mode]);
  const line = stdout.trim().split("\n").findLast((item) => item.startsWith("CROSS_VENUE_RESULT "));
  if (!line) throw new Error(`cross-venue staging fixture produced no result for ${mode}`);
  return JSON.parse(line.slice("CROSS_VENUE_RESULT ".length));
}
