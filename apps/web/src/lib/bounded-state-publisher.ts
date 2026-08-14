export interface BoundedStatePublisher<T> {
  push: (value: T, options?: { critical?: boolean }) => void;
  cancelPending: () => void;
}

export interface BoundedStatePublisherOptions<T> {
  onPublish: (value: T) => void;
  cadenceMs?: number | (() => number);
  now?: () => number;
  isCritical?: (previous: T, next: T) => boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createBoundedStatePublisher<T>(
  options: BoundedStatePublisherOptions<T>,
): BoundedStatePublisher<T> {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let lastPublishedAt: number | null = null;
  let lastPublished: T | undefined;
  let hasPublished = false;
  let pending: T | undefined;
  let hasPending = false;
  let timer: unknown = null;

  function cadenceMs() {
    const value = typeof options.cadenceMs === "function" ? options.cadenceMs() : options.cadenceMs;
    return Number.isFinite(value) ? Math.max(100, Number(value)) : 100;
  }

  function clearTimer() {
    if (timer != null) cancel(timer);
    timer = null;
  }

  function publish(value: T) {
    clearTimer();
    hasPending = false;
    pending = undefined;
    lastPublishedAt = now();
    lastPublished = value;
    hasPublished = true;
    options.onPublish(value);
  }

  function flushPending() {
    timer = null;
    if (!hasPending) return;
    publish(pending as T);
  }

  return {
    push(value, pushOptions = {}) {
      const critical = pushOptions.critical === true || (
        hasPublished && options.isCritical?.(lastPublished as T, value) === true
      );
      if (!hasPublished || critical) {
        publish(value);
        return;
      }
      const elapsed = Math.max(0, now() - (lastPublishedAt ?? now()));
      const cadence = cadenceMs();
      if (elapsed >= cadence) {
        publish(value);
        return;
      }
      pending = value;
      hasPending = true;
      if (timer == null) timer = schedule(flushPending, cadence - elapsed);
    },
    cancelPending() {
      clearTimer();
      hasPending = false;
      pending = undefined;
    },
  };
}
