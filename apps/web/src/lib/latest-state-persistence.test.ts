import { describe, expect, it, vi } from "vitest";
import { createLatestStatePersistence } from "./latest-state-persistence";

function harness<T>(write: (value: T) => void) {
  const tasks = new Map<number, () => void>();
  let nextId = 1;
  const persistence = createLatestStatePersistence<T>({
    write,
    schedule(callback) {
      const id = nextId++;
      tasks.set(id, callback);
      return id;
    },
    cancel(handle) {
      tasks.delete(handle as number);
    },
  });
  return {
    persistence,
    pending: () => tasks.size,
    run() {
      const callbacks = [...tasks.values()];
      tasks.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

describe("latest state persistence", () => {
  it("writes the initial state immediately, then coalesces to the latest state", () => {
    const writes: number[] = [];
    const { persistence, pending, run } = harness<number>((value) => writes.push(value));

    persistence.update(1, { immediate: true });
    persistence.update(2);
    persistence.update(3);

    expect(writes).toEqual([1]);
    expect(pending()).toBe(1);
    run();
    expect(writes).toEqual([1, 3]);
  });

  it("flushes once on lifecycle teardown and cancels the delayed duplicate", () => {
    const writes: number[] = [];
    const { persistence, pending, run } = harness<number>((value) => writes.push(value));

    persistence.update(1, { immediate: true });
    persistence.update(2);
    expect(persistence.flush()).toBe(true);
    expect(persistence.flush()).toBe(false);
    persistence.dispose();

    expect(pending()).toBe(0);
    run();
    expect(writes).toEqual([1, 2]);
  });

  it("cancels a pending write when state returns to the persisted identity", () => {
    const writes: object[] = [];
    const { persistence, pending, run } = harness<object>((value) => writes.push(value));
    const persisted = { revision: 1 };

    persistence.update(persisted, { immediate: true });
    persistence.update({ revision: 2 });
    persistence.update(persisted);

    expect(pending()).toBe(0);
    run();
    expect(writes).toEqual([persisted]);
  });

  it("keeps storage failures nonfatal and accepts later updates", () => {
    const write = vi.fn<(value: number) => void>()
      .mockImplementationOnce(() => { throw new Error("storage blocked"); });
    const { persistence, run } = harness<number>(write);

    expect(() => persistence.update(1, { immediate: true })).not.toThrow();
    expect(persistence.flush()).toBe(true);
    persistence.update(2);
    run();

    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenLastCalledWith(2);
  });

  it("ignores updates after disposal", () => {
    const writes: number[] = [];
    const { persistence, pending } = harness<number>((value) => writes.push(value));

    persistence.update(1);
    persistence.dispose();
    persistence.update(2, { immediate: true });

    expect(writes).toEqual([1]);
    expect(pending()).toBe(0);
  });
});
