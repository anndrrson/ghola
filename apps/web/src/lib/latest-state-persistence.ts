export interface LatestStatePersistence<T> {
  update: (value: T, options?: { immediate?: boolean }) => void;
  flush: () => boolean;
  dispose: (options?: { flush?: boolean }) => void;
}

export interface LatestStatePersistenceOptions<T> {
  write: (value: T) => void;
  delayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createLatestStatePersistence<T>(
  options: LatestStatePersistenceOptions<T>,
): LatestStatePersistence<T> {
  const delayMs = persistenceDelay(options.delayMs);
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let latest: T | undefined;
  let persisted: T | undefined;
  let hasLatest = false;
  let hasPersisted = false;
  let dirty = false;
  let disposed = false;
  let scheduled: unknown = null;

  function cancelScheduled() {
    if (scheduled != null) cancel(scheduled);
    scheduled = null;
  }

  function flush() {
    if (disposed || !dirty || !hasLatest) return false;
    cancelScheduled();
    const value = latest as T;
    dirty = false;
    try {
      options.write(value);
    } catch {
      // Persistence is best-effort; the in-memory experience must remain usable.
      dirty = true;
      return false;
    }
    persisted = value;
    hasPersisted = true;
    return true;
  }

  return {
    update(value, updateOptions = {}) {
      if (disposed) return;
      latest = value;
      hasLatest = true;
      if (hasPersisted && Object.is(value, persisted)) {
        dirty = false;
        cancelScheduled();
        return;
      }
      dirty = true;
      if (updateOptions.immediate) {
        flush();
        return;
      }
      if (scheduled == null) {
        scheduled = schedule(() => {
          scheduled = null;
          flush();
        }, delayMs);
      }
    },
    flush,
    dispose(disposeOptions = {}) {
      if (disposed) return;
      if (disposeOptions.flush !== false) flush();
      cancelScheduled();
      disposed = true;
      latest = undefined;
      persisted = undefined;
      hasLatest = false;
      hasPersisted = false;
      dirty = false;
    },
  };
}

function persistenceDelay(value: number | undefined) {
  if (!Number.isFinite(value)) return 750;
  return Math.min(1_000, Math.max(500, Number(value)));
}
