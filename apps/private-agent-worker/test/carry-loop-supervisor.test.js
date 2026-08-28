import assert from "node:assert/strict";
import test from "node:test";
import {
  carrySupervisionHealth,
  createCarryLoopSupervisor,
  disabledCarryLoopHealth,
} from "../src/execution/carry-loop-supervisor.js";

test("coalesces concurrent loop runs and records healthy completion", async () => {
  let calls = 0;
  let release;
  let nowMs = 1_800_000_000_000;
  const supervisor = createCarryLoopSupervisor({
    name: "carry_monitor",
    now: () => nowMs,
    run: async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      nowMs += 25;
      return { ok: true, checked: 2 };
    },
  });

  const first = supervisor.runOnce();
  const second = supervisor.runOnce();
  await Promise.resolve();
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(supervisor.health().status, "running");
  release();
  await first;
  assert.deepEqual(supervisor.health(), {
    name: "carry_monitor",
    status: "healthy",
    running: false,
    run_count: 1,
    consecutive_failures: 0,
    last_started_at: "2027-01-15T08:00:00.000Z",
    last_completed_at: "2027-01-15T08:00:00.025Z",
    last_success_at: "2027-01-15T08:00:00.025Z",
    last_error_code: null,
    max_silence_ms: null,
    heartbeat_deadline_at: null,
  });
  supervisor.stop();
  assert.equal((await supervisor.runOnce()).error, "carry_monitor_stopped");
  assert.equal(supervisor.health().status, "stopped");
});

test("surfaces degraded and thrown cycles without leaking exception text", async () => {
  const results = [
    { ok: false, results: [{ ok: false, error: "carry_monitor_context_missing" }] },
    new Error("secret provider response"),
  ];
  const supervisor = createCarryLoopSupervisor({
    name: "carry_execution",
    run: async () => {
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  });

  assert.equal((await supervisor.runOnce()).ok, false);
  assert.equal(supervisor.health().status, "degraded");
  assert.equal(supervisor.health().last_error_code, "carry_monitor_context_missing");
  assert.equal((await supervisor.runOnce()).error, "carry_execution_threw");
  assert.equal(supervisor.health().status, "failed");
  assert.equal(supervisor.health().consecutive_failures, 2);
  assert.doesNotMatch(JSON.stringify(supervisor.health()), /secret provider response/);
});

test("represents deliberately disabled supervision explicitly", () => {
  assert.deepEqual(disabledCarryLoopHealth("carry_monitor"), {
    name: "carry_monitor",
    status: "disabled",
    running: false,
    run_count: 0,
    consecutive_failures: 0,
    last_started_at: null,
    last_completed_at: null,
    last_success_at: null,
    last_error_code: null,
    max_silence_ms: null,
    heartbeat_deadline_at: null,
  });
});

test("fails closed when a successful loop stops making progress", async () => {
  let nowMs = 1_800_000_000_000;
  const supervisor = createCarryLoopSupervisor({
    name: "carry_monitor",
    now: () => nowMs,
    maxSilenceMs: 100,
    run: async () => ({ ok: true }),
  });

  await supervisor.runOnce();
  assert.equal(supervisor.health().status, "healthy");
  assert.equal(supervisor.health().heartbeat_deadline_at, "2027-01-15T08:00:00.100Z");

  nowMs += 101;
  assert.equal(supervisor.health().status, "stalled");
  assert.equal(supervisor.health().last_error_code, "carry_monitor_stalled");
  assert.equal(carrySupervisionHealth({ monitoring: supervisor, execution: null }).ready, false);

  await supervisor.runOnce();
  assert.equal(supervisor.health().status, "healthy");
  assert.equal(supervisor.health().last_error_code, null);
});

test("aggregates every critical loop without masking one degraded loop", () => {
  const healthy = (name) => ({ health: () => ({ ...disabledCarryLoopHealth(name), status: "healthy" }) });
  const degraded = {
    health: () => ({
      ...disabledCarryLoopHealth("carry_execution"),
      status: "degraded",
      consecutive_failures: 1,
      last_error_code: "carry_exit_preflight_not_ready",
    }),
  };
  assert.deepEqual(carrySupervisionHealth({
    monitoring: healthy("carry_monitor"),
    execution: degraded,
    recovery: healthy("multi_leg_recovery"),
  }), {
    status: "degraded",
    ready: false,
    monitoring: { ...disabledCarryLoopHealth("carry_monitor"), status: "healthy" },
    execution: degraded.health(),
    recovery: { ...disabledCarryLoopHealth("multi_leg_recovery"), status: "healthy" },
  });
  assert.equal(carrySupervisionHealth({ monitoring: null, execution: null }).status, "disabled");
});

test("does not mask a degraded recovery loop", () => {
  const healthy = (name) => ({ health: () => ({ ...disabledCarryLoopHealth(name), status: "healthy" }) });
  const recovery = {
    health: () => ({
      ...disabledCarryLoopHealth("multi_leg_recovery"),
      status: "stalled",
      last_error_code: "multi_leg_recovery_stalled",
    }),
  };
  const supervision = carrySupervisionHealth({
    monitoring: healthy("carry_monitor"),
    execution: healthy("carry_execution"),
    recovery,
  });
  assert.equal(supervision.status, "degraded");
  assert.equal(supervision.ready, false);
  assert.equal(supervision.recovery.last_error_code, "multi_leg_recovery_stalled");
});
