import assert from "node:assert/strict";
import test from "node:test";
import {
  carrySupervisionHealth,
  createCarryLoopSupervisor,
  disabledCarryLoopHealth,
  verifyCarrySupervisionHealth,
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
  const supervision = carrySupervisionHealth({
    monitoring: healthy("carry_monitor"),
    execution: degraded,
    recovery: healthy("multi_leg_recovery"),
    observation: healthy("carry_shadow_observer"),
    checked_at_ms: 1_800_000_000_000,
  });
  assert.equal(supervision.status, "degraded");
  assert.equal(supervision.ready, false);
  assert.deepEqual(supervision.monitoring, { ...disabledCarryLoopHealth("carry_monitor"), status: "healthy" });
  assert.deepEqual(supervision.execution, degraded.health());
  assert.match(supervision.evidence_commitment, /^carry:supervision:evidence:[0-9a-f]{64}$/);
  assert.equal(carrySupervisionHealth({ monitoring: null, execution: null }).status, "disabled");
});

test("attests fresh healthy supervision across every critical loop", async () => {
  let nowMs = 1_800_000_000_000;
  const supervisor = (name) => createCarryLoopSupervisor({
    name,
    now: () => nowMs,
    maxSilenceMs: 60_000,
    run: async () => ({ ok: true }),
  });
  const monitoring = supervisor("carry_monitor");
  const execution = supervisor("carry_execution");
  const recovery = supervisor("multi_leg_recovery");
  const observation = supervisor("carry_shadow_observer");
  await Promise.all([monitoring.runOnce(), execution.runOnce(), recovery.runOnce(), observation.runOnce()]);
  nowMs += 1;
  const supervision = carrySupervisionHealth({
    monitoring,
    execution,
    recovery,
    observation,
    checked_at_ms: nowMs,
  });
  const assessed = verifyCarrySupervisionHealth(supervision, { now_ms: nowMs });
  assert.equal(assessed.ok, true);
  assert.equal(assessed.health.ready, true);
  assert.equal(assessed.health.status, "healthy");
});

test("rejects tampered supervision evidence", () => {
  const supervision = carrySupervisionHealth({
    monitoring: null,
    execution: null,
    recovery: null,
    observation: null,
    checked_at_ms: 1_800_000_000_000,
  });
  const tampered = structuredClone(supervision);
  tampered.monitoring.run_count = 1;
  assert.equal(verifyCarrySupervisionHealth(tampered, { now_ms: 1_800_000_000_000 }).ok, false);
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
    observation: healthy("carry_shadow_observer"),
  });
  assert.equal(supervision.status, "degraded");
  assert.equal(supervision.ready, false);
  assert.equal(supervision.recovery.last_error_code, "multi_leg_recovery_stalled");
});

test("does not mask a failed market observation loop", () => {
  const healthy = (name) => ({ health: () => ({ ...disabledCarryLoopHealth(name), status: "healthy" }) });
  const observation = {
    health: () => ({
      ...disabledCarryLoopHealth("carry_shadow_observer"),
      status: "failed",
      last_error_code: "carry_shadow_observer_threw",
    }),
  };
  const supervision = carrySupervisionHealth({
    monitoring: healthy("carry_monitor"),
    execution: healthy("carry_execution"),
    recovery: healthy("multi_leg_recovery"),
    observation,
  });
  assert.equal(supervision.status, "degraded");
  assert.equal(supervision.ready, false);
  assert.equal(supervision.observation.last_error_code, "carry_shadow_observer_threw");
});
