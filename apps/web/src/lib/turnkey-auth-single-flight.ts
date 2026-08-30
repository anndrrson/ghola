export const TURNKEY_AUTH_MODAL_CLOSED_EVENT = "ghola:turnkey-auth-modal-closed";
export const TURNKEY_AUTH_MODAL_LOCK_TIMEOUT_MS = 5 * 60 * 1_000;

export function createTurnkeyAuthModalLock(
  timeoutMs = TURNKEY_AUTH_MODAL_LOCK_TIMEOUT_MS,
) {
  let active: Promise<void> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const release = () => {
    active = null;
    if (timeout) clearTimeout(timeout);
    timeout = null;
  };

  const run = (operation: () => Promise<void>): Promise<void> => {
    if (active) return active;

    const attempt = Promise.resolve().then(operation);
    active = attempt;
    timeout = setTimeout(release, timeoutMs);
    void attempt.catch(() => {
      if (active === attempt) release();
    });
    return attempt;
  };

  return { run, release };
}
