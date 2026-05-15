// Typed Performance API helper. Records start/end of named phases
// (e.g. "hero-rendered", "chat-mount", "first-token") so we can
// surface real numbers in a future dashboard. Wrapped so SSR safe.
//
// All entries are namespaced under the "ghola:" prefix so they're
// trivial to filter out of a `performance.getEntriesByType("mark")`
// dump without colliding with framework or third-party marks.
//
// Usage:
//   mark("hero-rendered");
//   // ...later
//   measure("hero-to-chat", "hero-rendered");
//   const entries = getEntries();
//
// All three exports are no-ops in environments without the
// Performance API (Node SSR, very old browsers). They never throw —
// observability code must never break the host page.

const PREFIX = "ghola:";

/** Returns true when the Performance API is usable in the current
 *  execution context. Used by every public API in this module to
 *  bail out cleanly during SSR or in environments where marks would
 *  be a no-op anyway. */
function perfAvailable(): boolean {
  return (
    typeof performance !== "undefined" &&
    typeof performance.mark === "function" &&
    typeof performance.measure === "function"
  );
}

/** Drop a User Timing mark at the current time under our namespace.
 *  Safe to call multiple times with the same name — modern browsers
 *  accept duplicate marks and surface each as its own entry. */
export function mark(name: string): void {
  if (!perfAvailable()) return;
  try {
    performance.mark(`${PREFIX}${name}`);
  } catch {
    // Swallow — observability must never break the page.
  }
}

/** Measure the duration between two named marks (or from a single
 *  mark to "now"). Returns the duration in milliseconds when the
 *  measurement was recorded, or `null` if anything went sideways
 *  (missing source mark, SSR, etc.). */
export function measure(name: string, from: string): number | null {
  if (!perfAvailable()) return null;
  try {
    const entry = performance.measure(
      `${PREFIX}${name}`,
      `${PREFIX}${from}`,
    );
    // PerformanceMeasure exposes `duration` on the returned object in
    // modern browsers; older ones return void, so fall back to the
    // entries list lookup.
    if (entry && typeof entry.duration === "number") {
      return entry.duration;
    }
    const measured = performance.getEntriesByName(
      `${PREFIX}${name}`,
      "measure",
    );
    const last = measured[measured.length - 1];
    return last ? last.duration : null;
  } catch {
    return null;
  }
}

/** Returns all ghola-namespaced timing entries currently recorded
 *  by the User Timing buffer. Empty array on SSR / unsupported. */
export function getEntries(): PerformanceEntry[] {
  if (!perfAvailable() || typeof performance.getEntries !== "function") {
    return [];
  }
  try {
    return performance
      .getEntries()
      .filter((e) => e.name.startsWith(PREFIX));
  } catch {
    return [];
  }
}
