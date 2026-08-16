export type TerminalLiveExecutionLockBlocker =
  | "subject_scope_invalid"
  | "lock_manager_unavailable"
  | "lock_contended"
  | "lock_request_failed";

export type TerminalLiveExecutionLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; blocker: TerminalLiveExecutionLockBlocker };

const SUBJECT_SCOPE = /^subject_[a-f0-9]{32}$/u;

/** Holds one origin-wide account lock through dispatch and durable local evidence. */
export async function withTerminalLiveExecutionLock<T>(input: {
  lockManager: LockManager | null | undefined;
  subjectScope: string;
  task: () => Promise<T>;
}): Promise<TerminalLiveExecutionLockResult<T>> {
  if (!SUBJECT_SCOPE.test(input.subjectScope)) {
    return { acquired: false, blocker: "subject_scope_invalid" };
  }
  if (!input.lockManager) {
    return { acquired: false, blocker: "lock_manager_unavailable" };
  }
  let taskStarted = false;
  try {
    return await input.lockManager.request(
      `ghola:live-submit:v1:${input.subjectScope}`,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return { acquired: false, blocker: "lock_contended" } as const;
        taskStarted = true;
        return { acquired: true, value: await input.task() } as const;
      },
    );
  } catch (error) {
    if (taskStarted) throw error;
    return { acquired: false, blocker: "lock_request_failed" };
  }
}

export function terminalLiveExecutionLockBlockerLabel(blocker: TerminalLiveExecutionLockBlocker) {
  if (blocker === "lock_contended") {
    return "Another Ghola tab is checking or submitting this account. Wait for it to finish, then refresh the execution ledger.";
  }
  if (blocker === "lock_manager_unavailable") {
    return "This browser cannot provide the required cross-tab execution lock. Live submit remains disabled.";
  }
  if (blocker === "subject_scope_invalid") {
    return "The authenticated execution account scope is invalid. Sign in again before live submit.";
  }
  return "The browser cross-tab execution lock failed. Live submit was not dispatched.";
}
