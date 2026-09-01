import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION } from "@/lib/lighter-funding-eligibility";
import { CarryAccountSetup } from "./CarryAccountSetup";

const state = vi.hoisted(() => ({
  search: "",
  recovery: null as null | Record<string, unknown>,
  perpsAuthenticated: false,
  authenticated: true,
  userId: "carry-user",
}));
const api = vi.hoisted(() => ({
  loginPerps: vi.fn(),
  getHyperliquidExecutionVaultStatus: vi.fn(),
  getPrivateAgentPassport: vi.fn(),
  fetchPrivateAgentRuntimeStatus: vi.fn(),
  fetchLighterActivationReadiness: vi.fn(),
  fetchVerifiedLighterDepositDestination: vi.fn(),
  reconcileExistingLighterDepositDestination: vi.fn(),
  checkLighterDepositReconciliation: vi.fn(),
  verifyLighterOwnerRecoveryReadiness: vi.fn(),
  signLighterRecoveryReadiness: vi.fn(),
  prepareAsterProgrammaticCredential: vi.fn(),
  prepareLighterProgrammaticCredential: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("@/components/AuthModal", () => ({ AuthModal: () => null }));
vi.mock("@/components/trade/TurnkeyPerpsManager", () => ({
  TurnkeyPerpsManager: ({
    network,
    market,
    onReady,
  }: {
    network: string;
    market: string;
    onReady?: (risk: Record<string, never>) => void;
  }) => (
    <button type="button" data-testid="hyperliquid-manager" onClick={() => onReady?.({})}>
      {network}:{market}:complete
    </button>
  ),
}));
vi.mock("@/lib/thumper-auth-context", () => ({
  useThumperAuth: () => ({
    authenticated: state.authenticated,
    loading: false,
    user: state.authenticated ? { id: state.userId, email: "carry@example.com" } : null,
  }),
}));
vi.mock("@/lib/turnkey-provider", () => ({
  opaqueTurnkeyWalletScope: (value: string) => value === "carry-user-2"
    ? "b".repeat(64)
    : value ? "a".repeat(64) : "",
  useTurnkeyWallet: () => ({
    walletAddress: `0x${"11".repeat(20)}`,
    createWallet: vi.fn(),
    signBytes: vi.fn(),
  }),
}));
vi.mock("@/lib/perps-turnkey-provider", () => ({
  usePerpsTurnkey: () => ({
    authenticated: state.perpsAuthenticated,
    configured: true,
    hasPasskey: true,
    loading: false,
    ensureWalletPair: vi.fn(),
    login: api.loginPerps,
    logout: vi.fn(),
    createPasskey: vi.fn(),
    replaceWalletPair: vi.fn(),
    signAsterAgentApproval: vi.fn(),
    signLighterApiKeyAssociation: vi.fn(),
    signLighterDepositAuthorization: vi.fn(),
    signLighterRecoveryReadiness: api.signLighterRecoveryReadiness,
  }),
}));
vi.mock("@/lib/private-account-client", () => ({
  getHyperliquidExecutionVaultStatus: api.getHyperliquidExecutionVaultStatus,
  getPrivateAgentPassport: api.getPrivateAgentPassport,
  linkPrivateAgentPlatform: vi.fn(),
  completeAsterProgrammaticCredential: vi.fn(),
  completeLighterProgrammaticCredential: vi.fn(),
  prepareAsterProgrammaticCredential: api.prepareAsterProgrammaticCredential,
  prepareLighterProgrammaticCredential: api.prepareLighterProgrammaticCredential,
}));
vi.mock("@/lib/hyperliquid-vault-seal", () => ({
  fetchPrivateAgentRuntimeStatus: api.fetchPrivateAgentRuntimeStatus,
}));
vi.mock("@/lib/aster-vault-seal", () => ({
  buildAsterExecutionVaultBundle: vi.fn(),
  validateAsterExecutionCredentialDraft: () => [],
}));
vi.mock("@/lib/lighter-vault-seal", () => ({
  buildLighterExecutionVaultBundle: vi.fn(),
  validateLighterExecutionCredentialDraft: () => [],
}));
vi.mock("@/lib/aster-onboarding-recovery", () => ({
  classifyAsterOnboardingFailure: vi.fn(),
}));
vi.mock("@/lib/carry-onboarding-recovery", () => ({
  readCarryOnboardingRecovery: () => state.recovery,
  readCarryOnboardingRecoveryForUser: () => state.recovery,
  updateCarryOnboardingRecoveryForUser: vi.fn(),
}));
vi.mock("@/lib/lighter-activation-readiness", () => ({
  describeLighterActivationNextStep: () => "Activation required.",
  fetchLighterActivationReadiness: api.fetchLighterActivationReadiness,
  LIGHTER_NEW_ACCOUNT_DEPOSIT_SOURCE: "https://app.lighter.xyz/",
  LIGHTER_NEW_ACCOUNT_MINIMUM_USDC_MICROUNITS: BigInt(5_000_000),
}));
vi.mock("@/lib/lighter-universal-deposit-address.client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/lighter-universal-deposit-address.client")>(),
  fetchVerifiedLighterDepositDestination: api.fetchVerifiedLighterDepositDestination,
  reconcileExistingLighterDepositDestination: api.reconcileExistingLighterDepositDestination,
}));
vi.mock("@/lib/lighter-deposit-reconciliation.client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/lighter-deposit-reconciliation.client")>(),
  checkLighterDepositReconciliation: api.checkLighterDepositReconciliation,
}));
vi.mock("@/lib/lighter-owner-recovery-readiness.client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/lighter-owner-recovery-readiness.client")>(),
  verifyLighterOwnerRecoveryReadiness: api.verifyLighterOwnerRecoveryReadiness,
}));
vi.mock("@/lib/carry-setup-auth-recovery", () => ({
  shouldResumeUnsignedTurnkeySetup: () => false,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CarryAccountSetup", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    state.search = "long_venue=hyperliquid&short_venue=lighter";
    state.recovery = null;
    state.perpsAuthenticated = false;
    state.authenticated = true;
    state.userId = "carry-user";
    window.localStorage.clear();
    api.getPrivateAgentPassport.mockReset().mockResolvedValue({
      account_commitment: "carry:account:test:0001",
      venues: [],
    });
    api.loginPerps.mockReset().mockResolvedValue(undefined);
    api.getHyperliquidExecutionVaultStatus.mockReset().mockResolvedValue({});
    api.fetchPrivateAgentRuntimeStatus.mockReset().mockResolvedValue({
      selected_provider: "phala",
      blocking_reasons: [],
      providers: [{
        id: "phala",
        available: true,
        supports_trading_execution: true,
        evidence: { worker_authorization_verified: true },
      }],
    });
    api.fetchLighterActivationReadiness.mockReset().mockResolvedValue(null);
    api.fetchVerifiedLighterDepositDestination.mockReset();
    api.reconcileExistingLighterDepositDestination.mockReset();
    api.checkLighterDepositReconciliation.mockReset();
    api.verifyLighterOwnerRecoveryReadiness.mockReset();
    api.signLighterRecoveryReadiness.mockReset();
    api.prepareAsterProgrammaticCredential.mockReset();
    api.prepareLighterProgrammaticCredential.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("fails closed when existing account readiness cannot be loaded", async () => {
    api.getPrivateAgentPassport.mockReset().mockRejectedValue(new Error("offline"));

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await flush();

    expect(container.querySelector('[data-carry-account-readiness="failed"]')).toBeTruthy();
    expect(container.textContent).toContain("Connection state is unknown");
    expect(container.textContent).toContain("No wallet action was enabled");
    expect(container.querySelector('[aria-controls="carry-hyperliquid-setup"]')).toBeNull();
    expect(container.querySelector('[aria-label="Selected Carry execution pair"]')).toBeNull();
    expect(container.querySelector('[data-testid="hyperliquid-manager"]')).toBeNull();
    expect([...container.querySelectorAll("button")].map((button) => button.textContent?.trim()))
      .toEqual(["Retry account check"]);
  });

  it("blocks wallet preparation on vault-status failure and unlocks only after a successful retry", async () => {
    api.getHyperliquidExecutionVaultStatus.mockReset()
      .mockRejectedValueOnce(new Error("vault status offline"))
      .mockResolvedValue({});

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await flush();
    expect(container.querySelector('[data-carry-account-readiness="failed"]')).toBeTruthy();
    expect(container.querySelector('[aria-controls="carry-hyperliquid-setup"]')).toBeNull();
    expect(api.prepareAsterProgrammaticCredential).not.toHaveBeenCalled();
    expect(api.prepareLighterProgrammaticCredential).not.toHaveBeenCalled();
    const retry = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Retry account check");

    await act(async () => {
      retry?.click();
      await flush();
    });

    expect(api.getHyperliquidExecutionVaultStatus).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-carry-account-readiness]")).toBeNull();
    expect(container.querySelector('[aria-label="Selected Carry execution pair"]')).toBeTruthy();
    const continueButton = container.querySelector<HTMLButtonElement>('[aria-controls="carry-hyperliquid-setup"]');
    expect(continueButton).toBeTruthy();
    await act(async () => continueButton?.click());
    expect(container.querySelector('[data-testid="hyperliquid-manager"]')).toBeTruthy();
  });

  it("ignores a readiness response that resolves after logout", async () => {
    const passport = deferred<Record<string, unknown>>();
    api.getPrivateAgentPassport.mockReset().mockReturnValueOnce(passport.promise);

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    state.authenticated = false;
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await act(async () => {
      passport.resolve({
        account_commitment: "carry:account:old-user",
        venues: [{ venue_id: "lighter" }],
      });
      await flush();
    });

    expect(container.textContent).toContain("Sign in to continue");
    expect(container.querySelector("[data-carry-account-readiness]")).toBeNull();
    expect(container.querySelector('[aria-label="Selected Carry execution pair"]')).toBeNull();
    expect(container.querySelector('[data-testid="hyperliquid-manager"]')).toBeNull();
  });

  it("rechecks a switched user and ignores the prior user's late response", async () => {
    const firstPassport = deferred<Record<string, unknown>>();
    api.getPrivateAgentPassport.mockReset()
      .mockReturnValueOnce(firstPassport.promise)
      .mockResolvedValueOnce({
        account_commitment: "carry:account:new-user",
        venues: [],
      });

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    state.userId = "carry-user-2";
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await flush();
    expect(api.getPrivateAgentPassport).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("0/2");

    await act(async () => {
      firstPassport.resolve({
        account_commitment: "carry:account:old-user",
        venues: [{ venue_id: "lighter" }],
      });
      await flush();
    });

    expect(container.textContent).toContain("0/2");
    expect(container.textContent).not.toContain("1/2");
    expect(container.querySelector('[aria-label="Selected Carry execution pair"]')).toBeTruthy();
  });

  it("opens the existing Hyperliquid manager inline and preserves the selected pair", async () => {
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    expect(container.textContent).toContain("0/2");
    expect(container.textContent).toContain("Hyperliquid");
    expect(container.textContent).toContain("Lighter");
    expect(container.textContent).not.toContain("Aster");
    expect(container.querySelector('a[href*="setup=hyperliquid"]')).toBeNull();
    const pairRail = container.querySelector('[aria-label="Selected Carry execution pair"]');
    expect(pairRail?.querySelectorAll("[data-carry-venue]")).toHaveLength(2);
    expect(pairRail?.querySelector('[data-carry-venue="hyperliquid"]')?.getAttribute("data-carry-role")).toBe("long");
    expect(pairRail?.querySelector('[data-carry-venue="lighter"]')?.getAttribute("data-carry-role")).toBe("short");

    const continueButton = container.querySelector<HTMLButtonElement>('[aria-controls="carry-hyperliquid-setup"]');
    expect(continueButton?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => continueButton?.click());

    expect(container.querySelector('[aria-label="Connect Hyperliquid"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hyperliquid-manager"]')?.textContent).toBe("mainnet:BTC:complete");
    expect(continueButton?.getAttribute("aria-expanded")).toBe("true");
  });

  it("requires an exact pair before starting fresh setup and keeps Lighter optional", async () => {
    state.search = "";
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open");

    expect(container.textContent).toContain("Start with two venues—not the whole fleet.");
    expect(container.textContent).toContain("Lighter stays optional until a selected route needs it.");
    expect(container.textContent).toContain("Access · choose pair");
    expect(container.querySelector('[aria-label="Carry execution fleet"]')).toBeNull();
    expect(container.querySelector('[aria-controls="carry-hyperliquid-setup"]')).toBeNull();
    const proofLink = [...container.querySelectorAll<HTMLAnchorElement>("a")]
      .find((anchor) => anchor.textContent?.trim() === "Start no-submit proof");
    expect(proofLink).toBeTruthy();
    const setup = new URL(proofLink?.href || "", "https://ghola.local");
    expect(setup.searchParams.get("long_venue")).toBe("hyperliquid");
    expect(setup.searchParams.get("short_venue")).toBe("aster");
    expect(setup.searchParams.get("return_to")).toContain("long_venue=hyperliquid&short_venue=aster");
  });

  it("reauthenticates a connected pair before preserving its exact no-submit return", async () => {
    const returnTo = "/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter";
    api.getPrivateAgentPassport.mockResolvedValue({
      account_commitment: "carry:account:test:0001",
      venues: [{ venue_id: "lighter", status: "ready", can_read: true, can_trade: true }],
    });
    api.getHyperliquidExecutionVaultStatus.mockResolvedValue({ credentials_sealed: true });

    await renderSetup(returnTo);
    await flush();

    const authenticate = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Authenticate secure wallet");
    expect(authenticate).toBeTruthy();
    expect([...container.querySelectorAll("a")].some((link) => link.textContent?.trim() === "Verify routes")).toBe(false);
    await act(async () => {
      authenticate?.click();
      await flush();
    });
    expect(api.loginPerps).toHaveBeenCalledTimes(1);

    state.perpsAuthenticated = true;
    await renderSetup(returnTo);
    const verify = [...container.querySelectorAll("a")]
      .find((link) => link.textContent?.trim() === "Verify routes");
    expect(verify?.getAttribute("href")).toBe(`${returnTo}&carry_check=no-submit`);
  });

  it("does not surface stale external activation outside the selected pair", async () => {
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      aster_activation: {
        owner_address: `0x${"22".repeat(20)}`,
        reason: "venue_account_not_found",
      },
    };

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    expect(container.querySelector('a[href="https://www.asterdex.com/en"]')).toBeNull();
    expect(container.querySelector('a[href="https://app.lighter.xyz/"]')).toBeNull();
  });

  it("surfaces external activation only when that venue is required by the pair", async () => {
    state.search = "long_venue=aster&short_venue=lighter";
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      aster_activation: {
        owner_address: `0x${"22".repeat(20)}`,
        reason: "venue_account_not_found",
      },
    };

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=aster&short_venue=lighter");

    expect(container.querySelector('a[href="https://www.asterdex.com/en"]')).toBeTruthy();
    expect(container.querySelector('a[href="https://app.lighter.xyz/"]')).toBeNull();
  });

  it("keeps Lighter address generation disabled until explicit eligibility consent", async () => {
    state.perpsAuthenticated = true;
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      lighter_activation: {
        owner_address: `0x${"22".repeat(20)}`,
        reason: "venue_account_not_found",
      },
    };
    api.fetchLighterActivationReadiness.mockResolvedValue({
      version: 4,
      owner_address: `0x${"22".repeat(20)}`,
      lighter_account_index: null,
      base_usdc_microunits: "0",
      base_eth_wei: "0",
      ethereum_eth_wei: "0",
      estimated_base_gas_wei: "1",
      estimated_ethereum_association_gas_wei: "1",
      base_deposit_ready: false,
      ethereum_association_gas_ready: false,
      lighter_owner_account_ready: false,
      deposit_destination_verified: false,
      funding_action_enabled: false,
      ready: false,
      blockers: [
        "lighter_base_usdc_below_minimum",
        "lighter_base_gas_required",
        "lighter_owner_account_required",
        "lighter_ethereum_association_gas_required",
      ],
      checked_at: new Date().toISOString(),
    });

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const checkbox = container.querySelector<HTMLInputElement>('#lighter-funding-eligibility-consent');
    const generateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Generate verified deposit address");
    expect(container.querySelector('a[href="https://lighter.xyz/terms"]')).toBeTruthy();
    expect(container.textContent).toContain("I accept the Lighter Terms and attest that neither I nor any entity I represent is a prohibited person.");
    expect(checkbox?.checked).toBe(false);
    expect(generateButton?.disabled).toBe(true);

    await act(async () => checkbox?.click());

    expect(checkbox?.checked).toBe(true);
    expect(generateButton?.disabled).toBe(false);
  });

  it("keeps funding locked and explains a missing server funding credential", async () => {
    const ownerAddress = `0x${"22".repeat(20)}`;
    state.perpsAuthenticated = true;
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      lighter_activation: { owner_address: ownerAddress, reason: "venue_account_not_found" },
    };
    api.fetchLighterActivationReadiness.mockResolvedValue(lighterReadiness(ownerAddress));
    api.fetchVerifiedLighterDepositDestination.mockRejectedValue(
      new Error("lighter_uda_builder_key_unconfigured"),
    );

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await flush();
    await act(async () => container.querySelector<HTMLInputElement>("#lighter-funding-eligibility-consent")?.click());
    const generate = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Generate verified deposit address");
    await act(async () => {
      generate?.click();
      await flush();
    });

    expect(container.querySelector('[data-lighter-deposit-verified="false"]')).toBeTruthy();
    expect(container.textContent).toContain("Ghola's Lighter funding connection is not enabled yet. Do not send USDC.");
    expect(container.querySelector('[data-lighter-deposit-verified="true"]')).toBeNull();
  });

  it("replays a previously persisted verified address only after fresh consent", async () => {
    const ownerAddress = `0x${"22".repeat(20)}`;
    const storageKey = `ghola_lighter_uda_retry_forbidden_v1:${ownerAddress.toLowerCase()}`;
    state.perpsAuthenticated = true;
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      lighter_activation: { owner_address: ownerAddress, reason: "venue_account_not_found" },
    };
    window.localStorage.setItem(storageKey, "1");
    api.fetchLighterActivationReadiness.mockResolvedValue(lighterReadiness(ownerAddress));
    api.reconcileExistingLighterDepositDestination.mockResolvedValue(verifiedDestination(ownerAddress));

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await flush();
    await act(async () => container.querySelector<HTMLInputElement>("#lighter-funding-eligibility-consent")?.click());
    const reconcile = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Check provider status");
    expect(reconcile).toBeTruthy();
    expect(container.textContent).not.toContain("Generate verified deposit address");
    expect(container.textContent).toContain("provider history alone never unlocks funding.");

    await act(async () => {
      reconcile?.click();
      await flush();
    });

    expect(api.reconcileExistingLighterDepositDestination).toHaveBeenCalledTimes(1);
    expect(api.reconcileExistingLighterDepositDestination).toHaveBeenCalledWith(
      ownerAddress,
      LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
    );
    expect(api.fetchVerifiedLighterDepositDestination).not.toHaveBeenCalled();
    expect(container.querySelector('[data-lighter-deposit-verified="true"]')?.textContent)
      .toContain(`0x${"33".repeat(20)}`);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("keeps the manual lock after inconclusive reconciliation without retrying generation", async () => {
    const ownerAddress = `0x${"22".repeat(20)}`;
    const storageKey = `ghola_lighter_uda_retry_forbidden_v1:${ownerAddress.toLowerCase()}`;
    state.perpsAuthenticated = true;
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      lighter_activation: { owner_address: ownerAddress, reason: "venue_account_not_found" },
    };
    window.localStorage.setItem(storageKey, "1");
    api.fetchLighterActivationReadiness.mockResolvedValue(lighterReadiness(ownerAddress));
    api.reconcileExistingLighterDepositDestination.mockRejectedValue(
      new Error("lighter_uda_reconciliation_not_proven"),
    );

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await flush();
    await act(async () => container.querySelector<HTMLInputElement>("#lighter-funding-eligibility-consent")?.click());
    const reconcile = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Check provider status");
    await act(async () => {
      reconcile?.click();
      await flush();
    });

    expect(api.reconcileExistingLighterDepositDestination).toHaveBeenCalledTimes(1);
    expect(api.fetchVerifiedLighterDepositDestination).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No current safe funding address was proven. Generation remains locked; do not send USDC.");
    expect(container.textContent).toContain("Check provider status");
    expect(container.textContent).toContain("provider history alone never unlocks funding.");
    expect(container.textContent).not.toContain("Generate verified deposit address");
    expect(window.localStorage.getItem(storageKey)).toBe("1");
  });

  it("shows an exact manual tracker only after a fresh verified destination", async () => {
    const ownerAddress = `0x${"22".repeat(20)}`;
    const transactionHash = `0x${"ab".repeat(32)}`;
    state.perpsAuthenticated = true;
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      lighter_activation: { owner_address: ownerAddress, reason: "venue_account_not_found" },
    };
    api.fetchLighterActivationReadiness.mockResolvedValue(lighterReadiness(ownerAddress));
    api.fetchVerifiedLighterDepositDestination.mockResolvedValue(verifiedDestination(ownerAddress));
    api.checkLighterDepositReconciliation
      .mockResolvedValueOnce(reconciliation(ownerAddress, transactionHash, "unseen"))
      .mockResolvedValueOnce(reconciliation(ownerAddress, transactionHash, "PROCESSING"))
      .mockResolvedValueOnce(reconciliation(ownerAddress, transactionHash, "COMPLETED"));
    api.verifyLighterOwnerRecoveryReadiness.mockResolvedValue(recoveryReadiness(ownerAddress));

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await flush();
    expect(container.querySelector("[data-lighter-deposit-reconciliation]")).toBeNull();

    await act(async () => container.querySelector<HTMLInputElement>("#lighter-funding-eligibility-consent")?.click());
    const generate = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Generate verified deposit address");
    await act(async () => {
      generate?.click();
      await flush();
    });

    const tracker = container.querySelector("[data-lighter-deposit-reconciliation]");
    const hashInput = tracker?.querySelector<HTMLInputElement>('input[aria-label="Exact Base transaction hash"]');
    const amountInput = tracker?.querySelector<HTMLInputElement>('input[aria-label="Expected USDC amount"]');
    expect(tracker).toBeTruthy();
    expect(container.textContent).not.toContain("Verify owner recovery");
    expect(amountInput?.value).toBe("5.5");
    expect(tracker?.querySelector("[data-lighter-deposit-status]")?.textContent).toBe("unseen");

    await setInput(hashInput, transactionHash);
    const check = Array.from(tracker?.querySelectorAll("button") || [])
      .find((button) => button.textContent === "Check exact deposit");
    await act(async () => {
      check?.click();
      await flush();
    });

    expect(api.checkLighterDepositReconciliation).toHaveBeenCalledTimes(1);
    expect(api.checkLighterDepositReconciliation).toHaveBeenCalledWith({
      ownerAddress,
      depositAddress: `0x${"33".repeat(20)}`,
      transactionHash,
      expectedAmountMicrounits: "5500000",
    });
    expect(hashInput?.disabled).toBe(false);
    expect(amountInput?.disabled).toBe(false);
    await act(async () => { await flush(); });
    expect(api.checkLighterDepositReconciliation).toHaveBeenCalledTimes(1);

    const checkAgain = Array.from(tracker?.querySelectorAll("button") || [])
      .find((button) => button.textContent === "Check exact deposit again");
    await act(async () => {
      checkAgain?.click();
      await flush();
    });
    expect(tracker?.querySelector("[data-lighter-deposit-status]")?.textContent).toBe("PROCESSING");
    expect(hashInput?.disabled).toBe(true);
    expect(amountInput?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Verify owner recovery");
    await act(async () => {
      checkAgain?.click();
      await flush();
    });
    expect(tracker?.querySelector("[data-lighter-deposit-status]")?.textContent).toBe("COMPLETED");
    expect(api.checkLighterDepositReconciliation).toHaveBeenCalledTimes(3);
    const verifyRecovery = Array.from(tracker?.querySelectorAll("button") || [])
      .find((button) => button.textContent === "Verify owner recovery");
    expect(verifyRecovery).toBeTruthy();
    await act(async () => {
      verifyRecovery?.click();
      await flush();
    });
    expect(api.verifyLighterOwnerRecoveryReadiness).toHaveBeenCalledWith({
      ownerAddress,
      signLighterRecoveryReadiness: api.signLighterRecoveryReadiness,
    });
    expect(container.textContent).toContain("Post-account owner recovery capability verified.");
  });

  async function renderSetup(returnTo: string) {
    await act(async () => {
      root.render(<CarryAccountSetup returnTo={returnTo} hyperliquidNetwork="mainnet" />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  async function setInput(input: HTMLInputElement | null | undefined, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
});

function lighterReadiness(ownerAddress: string) {
  return {
    version: 4,
    owner_address: ownerAddress,
    lighter_account_index: null,
    base_usdc_microunits: "0",
    base_eth_wei: "0",
    ethereum_eth_wei: "0",
    estimated_base_gas_wei: "1",
    estimated_ethereum_association_gas_wei: "1",
    base_deposit_ready: false,
    ethereum_association_gas_ready: false,
    lighter_owner_account_ready: false,
    deposit_destination_verified: false,
    funding_action_enabled: false,
    ready: false,
    blockers: ["lighter_base_usdc_below_minimum", "lighter_owner_account_required"],
    checked_at: new Date().toISOString(),
  };
}

function verifiedDestination(ownerAddress: string) {
  return {
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    owner_address: ownerAddress,
    source: {
      chain_id: 8453,
      chain: "base",
      asset: "USDC",
      token_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      minimum_microunits: "5000000",
      recommended_microunits: "5500000",
    },
    destination: {
      deposit_address: `0x${"33".repeat(20)}`,
      provider: "lighter_fun_uda",
      market: "perps",
      asset: "USDC",
      blocked: false,
      resolved: {
        to_chain_id: "3586256",
        to_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        action_type: "LIGHTER_PERPS",
        recipient_address: ownerAddress,
        recipient_binding: "owner_address",
        owner_account_index: null,
        user_id: ownerAddress,
      },
    },
    deposit_destination_verified: true,
    funding_action_enabled: true,
    checked_at: new Date().toISOString(),
    safety: {
      address_generation_only: true,
      transfer_performed: false,
      withdrawal_performed: false,
      trade_performed: false,
      bounded_replay: "returns_only_the_original_owner_bound_destination",
    },
  };
}

function reconciliation(ownerAddress: string, transactionHash: string, status: "unseen" | "PROCESSING" | "COMPLETED") {
  return {
    version: 1,
    expectation_id: `lighter_deposit_expectation_${"cd".repeat(24)}`,
    owner_address: ownerAddress,
    deposit_address: `0x${"33".repeat(20)}`,
    transaction_hash: transactionHash,
    expected_amount_microunits: "5500000",
    status,
    reconciliation_complete: status === "COMPLETED",
    checked_at: new Date().toISOString(),
  };
}

function recoveryReadiness(ownerAddress: string) {
  return {
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    status: "post_account_recovery_ready",
    owner_address: ownerAddress,
    account_index: 123,
    ready: true,
    recovery_readiness_proven: true,
    post_account_recovery_ready: true,
    funding_precondition_satisfied: false,
    initial_funding_safety_proven: false,
    funding_authorized: false,
    checks: {
      owner_signer_verified: true,
      lighter_balance_verified: false,
      withdrawal_execution_verified: false,
    },
    safety: {
      no_submit: true,
      transaction_signed: false,
      transaction_broadcast: false,
      withdrawal_authorized: false,
      withdrawal_execution_proven: false,
      funds_moved: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
