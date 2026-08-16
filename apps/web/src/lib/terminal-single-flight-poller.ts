export interface TerminalSingleFlightPollerOptions {
  run: (signal: AbortSignal) => Promise<void>;
  intervalMs: number;
  timeoutMs: number;
}

export interface TerminalSingleFlightPoller {
  start: () => void;
  stop: () => void;
}

export function terminalPolledValueForSubject<T>(
  value: T | null,
  valueSubject: string | null,
  currentSubject: string | null,
): T | null {
  return valueSubject === currentSubject ? value : null;
}

/** Runs immediately, never overlaps requests, and waits after completion. */
export function createTerminalSingleFlightPoller(
  options: TerminalSingleFlightPollerOptions,
): TerminalSingleFlightPoller {
  const intervalMs = positiveDelay(options.intervalMs);
  const timeoutMs = positiveDelay(options.timeoutMs);
  let active = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  async function poll() {
    if (!active || controller) return;
    const current = new AbortController();
    controller = current;
    timeoutTimer = setTimeout(() => current.abort(), timeoutMs);
    try {
      await options.run(current.signal);
    } catch {
      // Callers own status reporting; polling remains available after failure.
    } finally {
      if (timeoutTimer != null) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      if (controller === current) controller = null;
      if (active) pollTimer = setTimeout(() => void poll(), intervalMs);
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      void poll();
    },
    stop() {
      active = false;
      if (pollTimer != null) clearTimeout(pollTimer);
      if (timeoutTimer != null) clearTimeout(timeoutTimer);
      pollTimer = null;
      timeoutTimer = null;
      controller?.abort();
      controller = null;
    },
  };
}

function positiveDelay(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("terminal single-flight poll delay must be positive");
  }
  return Math.ceil(value);
}
