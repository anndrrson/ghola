import type { TurnkeyProviderConfig } from "@turnkey/react-wallet-kit";

// Authentication creates only the user's Turnkey sub-organization. The wallet is
// provisioned afterward so a wallet error cannot invalidate a successful login.
export const PERPS_TURNKEY_AUTH_CONFIG = {
  autoRefreshSession: true,
} satisfies NonNullable<TurnkeyProviderConfig["auth"]>;

export function createPerpsWalletProvisioningQueue() {
  let tail: Promise<void> = Promise.resolve();

  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function perpsWalletProvisioningError(caught: unknown): Error {
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
