export type TerminalSurfaceFocusResult = "target" | "fallback" | "unavailable" | "cancelled";

export function focusTerminalSurfaceWhenReady(input: {
  targetId: string;
  fallbackId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  root?: Document;
}): Promise<TerminalSurfaceFocusResult> {
  const root = input.root ?? document;
  const signal = input.signal;
  if (signal?.aborted) return Promise.resolve("cancelled");
  const immediate = root.getElementById(input.targetId);
  if (focusSurface(immediate)) return Promise.resolve("target");
  const fallback = input.fallbackId ? root.getElementById(input.fallbackId) : null;
  fallback?.scrollIntoView?.({ behavior: "smooth", block: "start" });

  if (!root.body || typeof MutationObserver === "undefined") {
    return Promise.resolve(focusSurface(fallback) ? "fallback" : "unavailable");
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TerminalSurfaceFocusResult) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const findTarget = () => {
      const target = root.getElementById(input.targetId);
      if (focusSurface(target)) finish("target");
    };
    const onAbort = () => finish("cancelled");
    const observer = new MutationObserver(findTarget);
    observer.observe(root.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      finish(focusSurface(fallback) ? "fallback" : "unavailable");
    }, Math.max(100, Math.min(5_000, input.timeoutMs ?? 3_000)));
    signal?.addEventListener("abort", onAbort, { once: true });
    findTarget();
  });
}

function focusSurface(value: Element | null) {
  if (!(value instanceof HTMLElement) || !value.isConnected) return false;
  value.scrollIntoView?.({ behavior: "smooth", block: "center" });
  value.focus({ preventScroll: true });
  return value.ownerDocument.activeElement === value;
}
