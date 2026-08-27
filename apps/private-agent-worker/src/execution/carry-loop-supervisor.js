export function createCarryLoopSupervisor({ name, run, now = () => Date.now() }) {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(String(name || ""))) throw new Error("carry_loop_name_invalid");
  if (typeof run !== "function") throw new Error("carry_loop_runner_required");
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
  });

  const runOnce = () => {
    if (stopped) return Promise.resolve({ ok: false, error: `${name}_stopped` });
    if (active) return active;
    const startedAt = iso(now());
    snapshot = Object.freeze({ ...snapshot, status: "running", running: true, last_started_at: startedAt });
    active = Promise.resolve()
      .then(run)
      .then((result) => {
        const completedAt = iso(now());
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
        });
        return result;
      })
      .catch(() => {
        const completedAt = iso(now());
        snapshot = Object.freeze({
          ...snapshot,
          status: stopped ? "stopped" : "failed",
          running: false,
          run_count: snapshot.run_count + 1,
          consecutive_failures: snapshot.consecutive_failures + 1,
          last_completed_at: completedAt,
          last_error_code: `${name}_threw`,
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
    health: () => snapshot,
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
  });
}

export function carrySupervisionHealth({ monitoring, execution }) {
  const monitorHealth = monitoring?.health?.() || disabledCarryLoopHealth("carry_monitor");
  const executionHealth = execution?.health?.() || disabledCarryLoopHealth("carry_execution");
  const statuses = [monitorHealth.status, executionHealth.status];
  const status = statuses.some((value) => value === "failed" || value === "degraded")
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
