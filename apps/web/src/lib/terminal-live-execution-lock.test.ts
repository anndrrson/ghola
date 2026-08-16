import { describe, expect, it, vi } from "vitest";
import {
  terminalLiveExecutionLockBlockerLabel,
  withTerminalLiveExecutionLock,
} from "./terminal-live-execution-lock";

const SCOPE = `subject_${"a".repeat(32)}`;

describe("terminal live execution cross-tab lock", () => {
  it("runs exactly once under an opaque account-scoped exclusive lock", async () => {
    const task = vi.fn(async () => "submitted");
    const request = vi.fn(async (name, options, callback) => callback({ name, mode: "exclusive" }));
    const result = await withTerminalLiveExecutionLock({
      lockManager: { request } as unknown as LockManager,
      subjectScope: SCOPE,
      task,
    });

    expect(result).toEqual({ acquired: true, value: "submitted" });
    expect(task).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      `ghola:live-submit:v1:${SCOPE}`,
      { mode: "exclusive", ifAvailable: true },
      expect.any(Function),
    );
  });

  it("fails closed without running when another tab owns the lock", async () => {
    const task = vi.fn();
    const request = vi.fn(async (_name, _options, callback) => callback(null));
    await expect(withTerminalLiveExecutionLock({
      lockManager: { request } as unknown as LockManager,
      subjectScope: SCOPE,
      task,
    })).resolves.toEqual({ acquired: false, blocker: "lock_contended" });
    expect(task).not.toHaveBeenCalled();
    expect(terminalLiveExecutionLockBlockerLabel("lock_contended")).toContain("Another Ghola tab");
  });

  it("permits only one concurrent tab through the dispatch section", async () => {
    let held = false;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const request = vi.fn(async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown> | unknown,
    ) => {
      if (held) return callback(null);
      held = true;
      try {
        return await callback({ name: "account", mode: "exclusive" });
      } finally {
        held = false;
      }
    });
    const lockManager = { request } as unknown as LockManager;
    const firstTask = vi.fn(async () => {
      await firstGate;
      return "first";
    });
    const secondTask = vi.fn(async () => "second");

    const first = withTerminalLiveExecutionLock({ lockManager, subjectScope: SCOPE, task: firstTask });
    await vi.waitFor(() => expect(firstTask).toHaveBeenCalledOnce());
    await expect(withTerminalLiveExecutionLock({ lockManager, subjectScope: SCOPE, task: secondTask }))
      .resolves.toEqual({ acquired: false, blocker: "lock_contended" });
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toEqual({ acquired: true, value: "first" });
  });

  it.each([
    ["missing manager", null, SCOPE, "lock_manager_unavailable"],
    ["invalid subject", {} as LockManager, "user@example.com", "subject_scope_invalid"],
  ])("fails closed for %s", async (_label, lockManager, subjectScope, blocker) => {
    const task = vi.fn();
    await expect(withTerminalLiveExecutionLock({ lockManager, subjectScope, task }))
      .resolves.toEqual({ acquired: false, blocker });
    expect(task).not.toHaveBeenCalled();
  });

  it("distinguishes lock-manager failure from a task failure", async () => {
    const failedManager = { request: vi.fn(async () => { throw new Error("manager failed"); }) } as unknown as LockManager;
    await expect(withTerminalLiveExecutionLock({ lockManager: failedManager, subjectScope: SCOPE, task: vi.fn() }))
      .resolves.toEqual({ acquired: false, blocker: "lock_request_failed" });

    const failedTask = vi.fn(async () => { throw new Error("task failed"); });
    const manager = { request: vi.fn(async (_name, _options, callback) => callback({})) } as unknown as LockManager;
    await expect(withTerminalLiveExecutionLock({ lockManager: manager, subjectScope: SCOPE, task: failedTask }))
      .rejects.toThrow("task failed");
  });
});
