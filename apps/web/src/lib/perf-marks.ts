// Typed Performance API helper. Records start/end of named phases
// (e.g. "hero-rendered", "chat-mount", "first-token") so we can
// surface real numbers in a future dashboard. Wrapped so SSR safe.
//
// Phase A of the Apple-flash-memory adoption plan
// (.claude/plans/zesty-giggling-charm.md) treats this module as the
// instrumentation backbone for local-mode cold-load measurement.
// The MARKS constant pins the named events the WebLLM warm-up path
// drops; markEngineProgress maps WebLLM's free-text InitProgressReport
// to those names; snapshot() returns a JSON-serializable view a
// reviewer can copy out of DevTools into a baseline file.
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

// ---- Phase A: named marks for local-mode cold-load measurement ----

/** The named events the local-mode warm-up + first-stream path drops.
 *  Keys mirror what a reviewer sees in DevTools after stripping the
 *  "ghola:" namespace prefix. Strings are intentionally short — they
 *  become Performance entry names that show up in flame charts. */
export const MARKS = {
  /** Right before `CreateMLCEngine` is invoked the first time. */
  ENGINE_FETCH_START: "engine-fetch-start",
  /** WebLLM reports the param-shard download has finished. */
  ENGINE_FETCH_DONE: "engine-fetch-done",
  /** WebLLM reports shader compilation / engine init has finished. */
  ENGINE_COMPILE_DONE: "engine-compile-done",
  /** The first non-empty completion delta arrives from streamWebGPUChat. */
  FIRST_TOKEN: "first-token",
} as const;

/** Heuristic mapping of WebLLM's free-text `InitProgressReport.text`
 *  to one of the Phase-A marks. WebLLM doesn't expose typed phases —
 *  the progress text is generated server-side in the runtime and
 *  changes between point releases. We match on the substrings that
 *  have been stable across 0.2.x and drop the mark idempotently
 *  (User Timing accepts repeat marks; we only WANT the first one per
 *  phase, so callers should pass `dedup: true` when wiring the
 *  callback). */
export function markEngineProgress(
  report: { progress?: number; text?: string },
  options: { dedup?: boolean } = {},
): void {
  const text = (report.text ?? "").toLowerCase();
  const progress = typeof report.progress === "number" ? report.progress : null;

  // Fetch-done: when WebLLM finishes downloading params it transitions
  // from "Fetching param cache" / "Loading model from cache" messages
  // into a "Finish loading" or progress 1.0 state for the fetch phase.
  // We also accept any text containing "finish" as a belt-and-braces.
  const fetchLooksDone =
    text.includes("finish loading on") ||
    text.includes("finished fetching") ||
    (progress !== null && progress >= 1 && text.includes("loading"));
  if (fetchLooksDone) {
    if (options.dedup && hasMark(MARKS.ENGINE_FETCH_DONE)) return;
    mark(MARKS.ENGINE_FETCH_DONE);
    return;
  }

  // Compile-done: the final message after shader compilation is
  // typically "Finish loading" with progress=1 in current WebLLM. The
  // fetch-done case above will fire first when there's a separate
  // fetch-phase message; if not, we still drop both at the same point
  // and `dedup` keeps a single entry per name.
  if (
    progress === 1 ||
    text.includes("compile") && text.includes("finish")
  ) {
    if (options.dedup && hasMark(MARKS.ENGINE_COMPILE_DONE)) return;
    mark(MARKS.ENGINE_COMPILE_DONE);
  }
}

/** Has a mark with the given short name already been recorded? */
export function hasMark(name: string): boolean {
  if (!perfAvailable() || typeof performance.getEntriesByName !== "function") {
    return false;
  }
  try {
    return performance.getEntriesByName(`${PREFIX}${name}`, "mark").length > 0;
  } catch {
    return false;
  }
}

/** JSON-serializable summary of every ghola-namespaced mark + measure
 *  recorded so far. Phase-A reviewers paste this from DevTools console
 *  into `docs/perf/baseline-local-llama-3.2-1b-q4f16.json`.
 *
 *  Shape is stable across browsers because we project each entry onto
 *  `{ name, entryType, startTime, duration }` — PerformanceEntry has
 *  additional fields in some browsers (Chrome's `detail`) which we
 *  drop to keep the snapshot reproducible.
 */
export interface PerfSnapshotEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
}

export interface PerfSnapshot {
  recordedAt: number;
  entries: PerfSnapshotEntry[];
  // Derived convenience deltas a reviewer reads at a glance. Each is
  // null when the source mark is missing. All deltas are in
  // milliseconds, sourced from PerformanceMark.startTime which is
  // page-load-relative.
  derived: {
    engineLoadMs: number | null;
    firstTokenFromFetchStartMs: number | null;
    firstTokenFromCompileDoneMs: number | null;
  };
}

export function snapshot(): PerfSnapshot {
  const entries = getEntries().map((e) => ({
    name: e.name.startsWith(PREFIX) ? e.name.slice(PREFIX.length) : e.name,
    entryType: e.entryType,
    startTime: e.startTime,
    duration: e.duration,
  }));

  function start(name: string): number | null {
    const hit = entries.find((e) => e.name === name && e.entryType === "mark");
    return hit ? hit.startTime : null;
  }

  const fetchStart = start(MARKS.ENGINE_FETCH_START);
  const compileDone = start(MARKS.ENGINE_COMPILE_DONE);
  const firstToken = start(MARKS.FIRST_TOKEN);

  return {
    recordedAt: Date.now(),
    entries,
    derived: {
      engineLoadMs:
        fetchStart !== null && compileDone !== null
          ? compileDone - fetchStart
          : null,
      firstTokenFromFetchStartMs:
        fetchStart !== null && firstToken !== null
          ? firstToken - fetchStart
          : null,
      firstTokenFromCompileDoneMs:
        compileDone !== null && firstToken !== null
          ? firstToken - compileDone
          : null,
    },
  };
}

/** Clear every ghola-namespaced mark + measure. Used by tests to
 *  isolate runs; production callers should not need this. */
export function clearMarks(): void {
  if (!perfAvailable()) return;
  try {
    if (typeof performance.clearMarks === "function") {
      for (const e of getEntries()) {
        if (e.entryType === "mark") performance.clearMarks(e.name);
      }
    }
    if (typeof performance.clearMeasures === "function") {
      for (const e of getEntries()) {
        if (e.entryType === "measure") performance.clearMeasures(e.name);
      }
    }
  } catch {
    // Swallow.
  }
}
