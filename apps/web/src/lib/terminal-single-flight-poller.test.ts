import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalSingleFlightPoller,
  terminalPolledValueForSubject,
} from "./terminal-single-flight-poller";

afterEach(() => vi.useRealTimers());

describe("terminal single-flight poller", () => {
  it("fails closed when a polled value belongs to another subject", () => {
    const value = { ready: true };
    expect(terminalPolledValueForSubject(value, "user-a", "user-a")).toBe(value);
    expect(terminalPolledValueForSubject(value, "user-a", "user-b")).toBeNull();
    expect(terminalPolledValueForSubject(value, "user-a", null)).toBeNull();
  });

  it("runs immediately and schedules from settlement without overlap", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const run = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const poller = createTerminalSingleFlightPoller({ run, intervalMs: 20_000, timeoutMs: 10_000 });

    poller.start();
    poller.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("aborts a hung request and retries only after the completion interval", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const poller = createTerminalSingleFlightPoller({ run, intervalMs: 20_000, timeoutMs: 10_000 });

    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("aborts active work and clears future polls on stop", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const run = vi.fn((nextSignal: AbortSignal) => {
      signals.push(nextSignal);
      return new Promise<void>(() => undefined);
    });
    const poller = createTerminalSingleFlightPoller({ run, intervalMs: 20_000, timeoutMs: 10_000 });

    poller.start();
    poller.stop();
    expect(signals[0]?.aborted).toBe(true);
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid timing configuration", () => {
    expect(() => createTerminalSingleFlightPoller({ run: async () => {}, intervalMs: 0, timeoutMs: 1 }))
      .toThrow("positive");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
