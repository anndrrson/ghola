export function createCarryLoopSupervisor({ name, run, now = () => Date.now(), maxSilenceMs = null }) {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(String(name || ""))) throw new Error("carry_loop_name_invalid");
  if (typeof run !== "function") throw new Error("carry_loop_runner_required");
  if (maxSilenceMs !== null && (!Number.isSafeInteger(maxSilenceMs) || maxSilenceMs <= 0)) {
    throw new Error("carry_loop_max_silence_invalid");
  }
  const createdAtMs = clock(now);
  let active = null;
  let stopped = false;
  let snapshot = Object.freeze({
    name,
    status: "starting",
    running: false,
    run_count: 0,
    consecutive_failures: 0,
    last_started_at: null,
    last_completed_at: null,
    last_success_at: null,
    last_error_code: null,
    max_silence_ms: maxSilenceMs,
    heartbeat_deadline_at: deadline(createdAtMs, maxSilenceMs),
  });

  const runOnce = () => {
    if (stopped) return Promise.resolve({ ok: false, error: `${name}_stopped` });
    if (active) return active;
    const startedAtMs = clock(now);
    const startedAt = iso(startedAtMs);
    snapshot = Object.freeze({
      ...snapshot,
      status: "running",
      running: true,
      last_started_at: startedAt,
      heartbeat_deadline_at: deadline(startedAtMs, maxSilenceMs),
    });
    active = Promise.resolve()
      .then(run)
      .then((result) => {
        const completedAtMs = clock(now);
        const completedAt = iso(completedAtMs);
        const ok = result?.ok === true;
        snapshot = Object.freeze({
          ...snapshot,
          status: stopped ? "stopped" : ok ? "healthy" : "degraded",
          running: false,
          run_count: snapshot.run_count + 1,
          consecutive_failures: ok ? 0 : snapshot.consecutive_failures + 1,
          last_completed_at: completedAt,
          last_success_at: ok ? completedAt : snapshot.last_success_at,
          last_error_code: ok ? null : resultErrorCode(result, `${name}_degraded`),
          heartbeat_deadline_at: deadline(completedAtMs, maxSilenceMs),
        });
        return result;
      })
      .catch(() => {
        const completedAtMs = clock(now);
        const completedAt = iso(completedAtMs);
        snapshot = Object.freeze({
          ...snapshot,
          status: stopped ? "stopped" : "failed",
          running: false,
          run_count: snapshot.run_count + 1,
          consecutive_failures: snapshot.consecutive_failures + 1,
          last_completed_at: completedAt,
          last_error_code: `${name}_threw`,
          heartbeat_deadline_at: deadline(completedAtMs, maxSilenceMs),
        });
        return { ok: false, error: `${name}_threw` };
      })
      .finally(() => {
        active = null;
      });
    return active;
  };

  return Object.freeze({
    runOnce,
    health: () => stalledHealth(snapshot, stopped, name, now),
    stop: () => {
      stopped = true;
      snapshot = Object.freeze({ ...snapshot, status: "stopped", running: false });
    },
  });
}

export function disabledCarryLoopHealth(name) {
  return Object.freeze({
    name,
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
}

export function carrySupervisionHealth({ monitoring, execution, recovery, observation }) {
  const monitorHealth = monitoring?.health?.() || disabledCarryLoopHealth("carry_monitor");
  const executionHealth = execution?.health?.() || disabledCarryLoopHealth("carry_execution");
  const recoveryHealth = recovery?.health?.() || disabledCarryLoopHealth("multi_leg_recovery");
  const observationHealth = observation?.health?.() || disabledCarryLoopHealth("carry_shadow_observer");
  const statuses = [monitorHealth.status, executionHealth.status, recoveryHealth.status, observationHealth.status];
  const status = statuses.some((value) => value === "failed" || value === "degraded" || value === "stalled")
    ? "degraded"
    : statuses.some((value) => value === "disabled")
      ? "disabled"
      : statuses.some((value) => value === "starting" || value === "running")
        ? "starting"
        : statuses.some((value) => value === "stopped")
          ? "stopped"
          : "healthy";
  return Object.freeze({
    status,
    ready: status === "healthy",
    monitoring: monitorHealth,
    execution: executionHealth,
    recovery: recoveryHealth,
    observation: observationHealth,
  });
}

function stalledHealth(snapshot, stopped, name, now) {
  if (stopped || !snapshot.heartbeat_deadline_at) return snapshot;
  if (!["starting", "running", "healthy"].includes(snapshot.status)) return snapshot;
  if (clock(now) <= Date.parse(snapshot.heartbeat_deadline_at)) return snapshot;
  return Object.freeze({
    ...snapshot,
    status: "stalled",
    last_error_code: `${name}_stalled`,
  });
}

function resultErrorCode(result, fallback) {
  const value = result?.error || result?.results?.find((item) => item?.ok !== true)?.error;
  return /^[a-z0-9][a-z0-9_:.-]{2,159}$/i.test(String(value || "")) ? String(value) : fallback;
}

function iso(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) throw new Error("carry_loop_clock_invalid");
  return date.toISOString();
}

function clock(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new Error("carry_loop_clock_invalid");
  return value;
}

function deadline(value, maxSilenceMs) {
  return maxSilenceMs === null ? null : iso(value + maxSilenceMs);
}
