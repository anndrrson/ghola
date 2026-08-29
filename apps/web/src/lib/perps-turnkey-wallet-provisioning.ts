import type { TurnkeyProviderConfig } from "@turnkey/react-wallet-kit";

// Authentication creates only the user's Turnkey sub-organization. The wallet is
// provisioned afterward so a wallet error cannot invalidate a successful login.
export const PERPS_TURNKEY_AUTH_CONFIG = {
  autoRefreshSession: true,
} satisfies NonNullable<TurnkeyProviderConfig["auth"]>;

// Email OTP is the portable authentication path across embedded and external
// browsers. A platform passkey remains available as an optional faster path
// after the user has authenticated on a compatible device.
export const PERPS_TURNKEY_AUTH_METHOD_ORDER: Array<"email" | "passkey"> = [
  "email",
  "passkey",
];

export class PerpsTurnkeyOperationTimeoutError extends Error {
  readonly ambiguous: boolean;

  constructor(ambiguous: boolean) {
    super(ambiguous
      ? "Secure wallet provisioning outcome is unclear. Ghola stopped and will not retry. Reload once to reconcile before continuing."
      : "Secure wallet session did not respond. Authenticate with email and resume; no approval was submitted.");
    this.name = "PerpsTurnkeyOperationTimeoutError";
    this.ambiguous = ambiguous;
  }
}

export async function withPerpsTurnkeyOperationTimeout<T>(
  operation: Promise<T>,
  options: { timeoutMs: number; ambiguous: boolean },
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new PerpsTurnkeyOperationTimeoutError(options.ambiguous)),
          options.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createPerpsWalletProvisioningQueue() {
  let tail: Promise<void> = Promise.resolve();

  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function perpsWalletProvisioningError(caught: unknown): Error {
  if (caught instanceof PerpsTurnkeyOperationTimeoutError) return caught;
  const message = caught instanceof Error ? caught.message : String(caught || "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("create wallet") ||
    normalized.includes("creating wallet") ||
    normalized.includes("wallet creation") ||
    normalized.includes("failed to create wallet")
  ) {
    return new Error(
      "Turnkey signed you in, but wallet provisioning failed. Retry wallet setup; Ghola will reconcile before creating anything new, and no new login code is needed.",
    );
  }
  return caught instanceof Error ? caught : new Error("Turnkey wallet provisioning failed.");
}
