import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.PRIVATE_AGENT_TEST_POSTGRES_URL || "";
const fixture = new URL("../scripts/fixtures/cross-venue-postgres-process.mjs", import.meta.url);

describe("cross-venue Postgres durability", { skip: !databaseUrl }, () => {
  it("admits one parent and exactly one submit per venue across worker processes", async () => {
    const seed = unique("parallel");
    const results = await Promise.all(Array.from({ length: 8 }, () => run(seed, "normal")));
    assert.equal(results.reduce((sum, result) => sum + result.submit_calls, 0), 2);
    assert.ok(results.some((result) => result.parent_status === "completed"));

    const restarted = await run(seed, "recover");
    assert.equal(restarted.status, 200);
    assert.equal(restarted.replayed, true);
    assert.equal(restarted.submit_calls, 0);
    assert.equal(restarted.parent_status, "completed");
  });

  it("recovers crash-left child claims from terminal venue truth without rebroadcast", async () => {
    const seed = unique("crash");
    const crashed = await run(seed, "crash");
    assert.equal(crashed.submit_calls, 2);
    assert.equal(crashed.parent_status, "reconcile_required");

    const recovered = await run(seed, "recover");
    assert.equal(recovered.status, 200);
    assert.equal(recovered.submit_calls, 0);
    assert.equal(recovered.parent_status, "completed");
  });

  it("admits one reduce-only paired close across processes and replays final-flat proof", async () => {
    const seed = unique("close_parallel");
    const opened = await run(seed, "normal");
    assert.equal(opened.parent_status, "completed");

    const results = await Promise.all(Array.from({ length: 8 }, () => run(seed, "close")));
    assert.equal(results.reduce((sum, result) => sum + result.close_submit_calls, 0), 2);
    assert.ok(results.some((result) => result.parent_status === "completed"));

    const restarted = await run(seed, "recover_close");
    assert.equal(restarted.status, 200);
    assert.equal(restarted.replayed, true);
    assert.equal(restarted.close_submit_calls, 0);
    assert.equal(restarted.parent_status, "completed");
  });

  it("recovers crash-left paired close claims without rebroadcast", async () => {
    const seed = unique("close_crash");
    assert.equal((await run(seed, "normal")).parent_status, "completed");
    const crashed = await run(seed, "crash_close");
    assert.equal(crashed.close_submit_calls, 2);
    assert.equal(crashed.parent_status, "reconcile_required");

    const recovered = await run(seed, "recover_close");
    assert.equal(recovered.status, 200);
    assert.equal(recovered.close_submit_calls, 0);
    assert.equal(recovered.parent_status, "completed");
  });
});

async function run(seed, mode) {
  const { stdout } = await execFileAsync(process.execPath, [fixture.pathname, databaseUrl, seed, mode]);
  const line = stdout.trim().split("\n").findLast((item) => item.startsWith("CROSS_VENUE_RESULT "));
  if (!line) throw new Error(`cross-venue fixture produced no result: ${stdout}`);
  return JSON.parse(line.slice("CROSS_VENUE_RESULT ".length));
}

function unique(label) {
  return `${label}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
