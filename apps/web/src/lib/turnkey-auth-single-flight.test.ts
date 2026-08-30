import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTurnkeyAuthModalLock,
  TURNKEY_AUTH_MODAL_LOCK_TIMEOUT_MS,
} from "./turnkey-auth-single-flight";

afterEach(() => vi.useRealTimers());

describe("Turnkey authentication modal lock", () => {
  it("stays locked when handleLogin resolves immediately", async () => {
    const operation = vi.fn().mockResolvedValue(undefined);
    const lock = createTurnkeyAuthModalLock();

    const first = lock.run(operation);
    await first;
    const duplicate = lock.run(operation);

    expect(duplicate).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);

    lock.release();
    await lock.run(operation);
    expect(operation).toHaveBeenCalledTimes(2);
    lock.release();
  });

  it("releases after an SDK failure", async () => {
    const lock = createTurnkeyAuthModalLock();
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("rejected"))
      .mockResolvedValueOnce();

    await expect(lock.run(operation)).rejects.toThrow("rejected");
    await lock.run(operation);
    expect(operation).toHaveBeenCalledTimes(2);
    lock.release();
  });

  it("has a bounded escape hatch", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockResolvedValue(undefined);
    const lock = createTurnkeyAuthModalLock();

    await lock.run(operation);
    await vi.advanceTimersByTimeAsync(TURNKEY_AUTH_MODAL_LOCK_TIMEOUT_MS);
    await lock.run(operation);

    expect(operation).toHaveBeenCalledTimes(2);
  });
});
