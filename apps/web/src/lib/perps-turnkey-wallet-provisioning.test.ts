import { describe, expect, it, vi } from "vitest";
import {
  createPerpsWalletProvisioningQueue,
  PERPS_TURNKEY_AUTH_CONFIG,
  PERPS_TURNKEY_AUTH_METHOD_ORDER,
  PerpsTurnkeyOperationTimeoutError,
  perpsWalletProvisioningError,
  withPerpsTurnkeyOperationTimeout,
} from "./perps-turnkey-wallet-provisioning";

describe("Turnkey perps wallet provisioning", () => {
  it("keeps wallet creation out of authentication", () => {
    expect(PERPS_TURNKEY_AUTH_CONFIG).toEqual({ autoRefreshSession: false });
    expect(PERPS_TURNKEY_AUTH_CONFIG).not.toHaveProperty("createSuborgParams");
  });

  it("defaults to portable email verification while preserving optional passkeys", () => {
    expect(PERPS_TURNKEY_AUTH_METHOD_ORDER).toEqual(["email", "passkey"]);
  });

  it("serializes reconciliation so concurrent consumers cannot create duplicate wallets", async () => {
    const enqueue = createPerpsWalletProvisioningQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return "first";
    });
    const secondOperation = vi.fn(async () => {
      events.push("second:start");
      return "second";
    });
    const second = enqueue(secondOperation);

    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("preserves login and explains the safe retry after a wallet failure", () => {
    expect(perpsWalletProvisioningError(new Error("Failed to create wallet")).message).toMatch(
      /signed you in[\s\S]*reconcile[\s\S]*no new login code/i,
    );
  });

  it("bounds stalled reads with email recovery and no approval", async () => {
    await expect(withPerpsTurnkeyOperationTimeout(new Promise(() => {}), {
      timeoutMs: 1,
      ambiguous: false,
    })).rejects.toMatchObject({
      ambiguous: false,
      message: expect.stringMatching(/email[\s\S]*no approval/i),
    });
  });

  it("freezes a timed-out mutation instead of implying a safe retry", async () => {
    const failure = await withPerpsTurnkeyOperationTimeout(new Promise(() => {}), {
      timeoutMs: 1,
      ambiguous: true,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(PerpsTurnkeyOperationTimeoutError);
    expect(perpsWalletProvisioningError(failure)).toMatchObject({
      ambiguous: true,
      message: expect.stringMatching(/unclear[\s\S]*will not retry/i),
    });
  });
});
