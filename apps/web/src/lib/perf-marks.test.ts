import { afterEach, describe, expect, it } from "vitest";

import {
  MARKS,
  clearMarks,
  getEntries,
  hasMark,
  mark,
  markEngineProgress,
  measure,
  snapshot,
} from "./perf-marks";

describe("mark / measure", () => {
  afterEach(() => {
    clearMarks();
  });

  it("records a namespaced mark", () => {
    mark("test-event");
    const e = getEntries().find((x) => x.name.endsWith("test-event"));
    expect(e).toBeTruthy();
    expect(e?.entryType).toBe("mark");
  });

  it("measure returns a positive number between two marks", () => {
    mark("a");
    // Synthesize a small gap by busy-waiting under the timer resolution.
    const start = performance.now();
    while (performance.now() - start < 2) {
      /* spin */
    }
    mark("b");
    const dur = measure("a-to-b", "a");
    expect(dur).not.toBeNull();
    expect(dur!).toBeGreaterThan(0);
  });
});

describe("MARKS constants are stable strings", () => {
  it("matches the canonical Phase-A list", () => {
    expect(MARKS).toEqual({
      ENGINE_FETCH_START: "engine-fetch-start",
      ENGINE_FETCH_DONE: "engine-fetch-done",
      ENGINE_COMPILE_DONE: "engine-compile-done",
      FIRST_TOKEN: "first-token",
    });
  });
});

describe("markEngineProgress", () => {
  afterEach(() => {
    clearMarks();
  });

  it("drops engine-fetch-done on a 'Finish loading' message", () => {
    markEngineProgress({ progress: 1, text: "Finish loading on WebGPU" });
    expect(hasMark(MARKS.ENGINE_FETCH_DONE)).toBe(true);
  });

  it("drops engine-compile-done at progress=1", () => {
    markEngineProgress({ progress: 1, text: "Compile complete" });
    // Either fetch-done OR compile-done depending on which substring
    // matched first — both are acceptable because the snapshot
    // derives engineLoadMs from whichever finishing mark fires. We
    // just need at least one finishing mark.
    expect(
      hasMark(MARKS.ENGINE_FETCH_DONE) || hasMark(MARKS.ENGINE_COMPILE_DONE),
    ).toBe(true);
  });

  it("is idempotent when dedup=true", () => {
    markEngineProgress(
      { progress: 1, text: "Finish loading on WebGPU" },
      { dedup: true },
    );
    markEngineProgress(
      { progress: 1, text: "Finish loading on WebGPU" },
      { dedup: true },
    );
    const fetchDone = getEntries().filter((e) =>
      e.name.endsWith(MARKS.ENGINE_FETCH_DONE),
    );
    expect(fetchDone.length).toBe(1);
  });

  it("does nothing for a generic intermediate progress event", () => {
    markEngineProgress({ progress: 0.42, text: "Fetching param cache 42%" });
    expect(hasMark(MARKS.ENGINE_FETCH_DONE)).toBe(false);
    expect(hasMark(MARKS.ENGINE_COMPILE_DONE)).toBe(false);
  });
});

describe("snapshot", () => {
  afterEach(() => {
    clearMarks();
  });

  it("returns derived deltas when the source marks exist", async () => {
    mark(MARKS.ENGINE_FETCH_START);
    await new Promise((r) => setTimeout(r, 3));
    mark(MARKS.ENGINE_COMPILE_DONE);
    await new Promise((r) => setTimeout(r, 3));
    mark(MARKS.FIRST_TOKEN);

    const s = snapshot();
    expect(s.derived.engineLoadMs).not.toBeNull();
    expect(s.derived.engineLoadMs!).toBeGreaterThan(0);
    expect(s.derived.firstTokenFromFetchStartMs).not.toBeNull();
    expect(s.derived.firstTokenFromCompileDoneMs).not.toBeNull();
    expect(s.derived.firstTokenFromCompileDoneMs!).toBeGreaterThan(0);
  });

  it("leaves derived deltas null when source marks are missing", () => {
    // Only one mark — engineLoadMs needs both.
    mark(MARKS.ENGINE_FETCH_START);
    const s = snapshot();
    expect(s.derived.engineLoadMs).toBeNull();
    expect(s.derived.firstTokenFromFetchStartMs).toBeNull();
  });

  it("strips the 'ghola:' prefix from entry names so they read clean", () => {
    mark("naming-test");
    const s = snapshot();
    expect(s.entries.find((e) => e.name === "naming-test")).toBeTruthy();
    // No entry should keep the prefix.
    expect(s.entries.every((e) => !e.name.startsWith("ghola:"))).toBe(true);
  });
});
