import { describe, expect, it, vi } from "vitest";
import { createBoundedStatePublisher } from "./bounded-state-publisher";

describe("bounded state publisher", () => {
  it("publishes latest-wins updates at no more than ten hertz", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const published: number[] = [];
    const publisher = createBoundedStatePublisher<number>({
      now: () => now,
      cadenceMs: 100,
      onPublish: (value) => published.push(value),
    });

    publisher.push(1);
    now += 20;
    publisher.push(2);
    now += 20;
    publisher.push(3);
    expect(published).toEqual([1]);

    now = 1_100;
    vi.advanceTimersByTime(80);
    expect(published).toEqual([1, 3]);
    vi.useRealTimers();
  });

  it("publishes critical transitions immediately and cancels queued data", () => {
    vi.useFakeTimers();
    let now = 2_000;
    const published: Array<{ status: string; revision: number }> = [];
    const publisher = createBoundedStatePublisher<{ status: string; revision: number }>({
      now: () => now,
      cadenceMs: 100,
      isCritical: (previous, next) => previous.status !== next.status,
      onPublish: (value) => published.push(value),
    });

    publisher.push({ status: "live", revision: 1 });
    now += 10;
    publisher.push({ status: "live", revision: 2 });
    now += 10;
    publisher.push({ status: "stale", revision: 3 });
    expect(published).toEqual([
      { status: "live", revision: 1 },
      { status: "stale", revision: 3 },
    ]);
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(2);
    vi.useRealTimers();
  });

  it("cancels pending publication during teardown", () => {
    vi.useFakeTimers();
    let now = 3_000;
    const published: number[] = [];
    const publisher = createBoundedStatePublisher<number>({
      now: () => now,
      cadenceMs: 100,
      onPublish: (value) => published.push(value),
    });
    publisher.push(1);
    now += 10;
    publisher.push(2);
    publisher.cancelPending();
    vi.advanceTimersByTime(100);
    expect(published).toEqual([1]);
    vi.useRealTimers();
  });

  it("clamps an explicit zero cadence to ten hertz", () => {
    vi.useFakeTimers();
    let now = 4_000;
    const published: number[] = [];
    const publisher = createBoundedStatePublisher<number>({
      now: () => now,
      cadenceMs: 0,
      onPublish: (value) => published.push(value),
    });

    publisher.push(1);
    now = 4_001;
    publisher.push(2);
    vi.advanceTimersByTime(98);
    expect(published).toEqual([1]);

    now = 4_100;
    vi.advanceTimersByTime(1);
    expect(published).toEqual([1, 2]);
    vi.useRealTimers();
  });
});
