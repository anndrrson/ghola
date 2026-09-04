import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarryAccountSetup } from "./CarryAccountSetup";

const state = vi.hoisted(() => ({
  search: "",
  recovery: null as null | Record<string, unknown>,
  perpsAuthenticated: false,
  hasPasskey: false,
  organizationId: "organization-one" as string | null,
}));
const api = vi.hoisted(() => ({
  getHyperliquidExecutionVaultStatus: vi.fn(),
  getPrivateAgentPassport: vi.fn(),
  fetchPrivateAgentRuntimeStatus: vi.fn(),
  addPasskey: vi.fn(),
  ensureWalletPair: vi.fn(),
  fetchLighterActivationReadiness: vi.fn(),
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
    authenticated: true,
    loading: false,
    user: { id: "carry-user", email: "carry@example.com" },
  }),
}));
vi.mock("@/lib/turnkey-provider", () => ({
  opaqueTurnkeyWalletScope: () => "a".repeat(64),
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
    hasPasskey: state.hasPasskey,
    organizationId: state.organizationId,
    loading: false,
    ensureWalletPair: api.ensureWalletPair,
    login: vi.fn(),
    logout: vi.fn(),
    addPasskey: api.addPasskey,
    replaceWalletPair: vi.fn(),
    signAsterAgentApproval: vi.fn(),
    signLighterApiKeyAssociation: vi.fn(),
  }),
}));
vi.mock("@/lib/private-account-client", () => ({
  getHyperliquidExecutionVaultStatus: api.getHyperliquidExecutionVaultStatus,
  getPrivateAgentPassport: api.getPrivateAgentPassport,
  linkPrivateAgentPlatform: vi.fn(),
  completeAsterProgrammaticCredential: vi.fn(),
  completeLighterProgrammaticCredential: vi.fn(),
  prepareAsterProgrammaticCredential: vi.fn(),
  prepareLighterProgrammaticCredential: vi.fn(),
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
    state.hasPasskey = false;
    state.organizationId = "organization-one";
    api.addPasskey.mockReset().mockResolvedValue(undefined);
    api.ensureWalletPair.mockReset().mockResolvedValue({
      owner: { address: `0x${"33".repeat(20)}` },
    });
    api.fetchLighterActivationReadiness.mockReset().mockResolvedValue(null);
    api.getPrivateAgentPassport.mockReset().mockResolvedValue({
      account_commitment: "carry:account:test:0001",
      venues: [],
    });
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
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens the existing Hyperliquid manager inline and preserves the selected pair", async () => {
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    expect(container.textContent).toContain("0 of 2 connected");
    expect(container.textContent).toContain("Hyperliquid");
    expect(container.textContent).toContain("Lighter");
    expect(container.textContent).not.toContain("Aster");
    expect(container.querySelector('a[href*="setup=hyperliquid"]')).toBeNull();
    const pairRail = container.querySelector('[aria-label="Selected Carry execution pair"]');
    expect(pairRail?.querySelectorAll("[data-carry-venue]")).toHaveLength(2);
    expect(pairRail?.querySelector('[data-carry-venue="hyperliquid"]')?.getAttribute("data-carry-role")).toBe("long");
    expect(pairRail?.querySelector('[data-carry-venue="lighter"]')?.getAttribute("data-carry-role")).toBe("short");
    expect(pairRail?.textContent).toContain("LONG");
    expect(pairRail?.textContent).toContain("SHORT");

    const continueButton = container.querySelector<HTMLButtonElement>('[aria-controls="carry-hyperliquid-setup"]');
    expect(continueButton?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => continueButton?.click());

    expect(container.querySelector('[aria-label="Connect Hyperliquid"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hyperliquid-manager"]')?.textContent).toBe("mainnet:BTC:complete");
    expect(continueButton?.getAttribute("aria-expanded")).toBe("true");
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

  it("confirms Touch ID only after enrollment completes", async () => {
    state.perpsAuthenticated = true;
    state.search = "long_venue=lighter&short_venue=hyperliquid";
    let completeEnrollment!: () => void;
    api.addPasskey.mockImplementation(() => new Promise<void>((resolve) => {
      completeEnrollment = resolve;
    }));

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=lighter&short_venue=hyperliquid");

    const addButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add Touch ID");
    expect(addButton).toBeTruthy();
    act(() => addButton?.click());
    expect(container.textContent).toContain("Waiting for Touch ID…");
    expect(container.textContent).not.toContain("Touch ID was added successfully");
    const venueButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create & associate key");
    expect(venueButton?.disabled).toBe(true);

    await act(async () => {
      completeEnrollment();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Added on this device");
    expect(container.textContent).toContain("Touch ID was added successfully on this device.");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Add Touch ID")).toBe(false);
  });

  it("shows a retry when Touch ID is cancelled", async () => {
    state.perpsAuthenticated = true;
    const cancellation = new Error("The operation either timed out or was not allowed.");
    cancellation.name = "NotAllowedError";
    api.addPasskey.mockRejectedValue({
      name: "TurnkeyError",
      code: "ADD_PASSKEY_ERROR",
      cause: { name: "TurnkeyError", cause: cancellation },
    });

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    const addButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add Touch ID");
    await act(async () => {
      addButton?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Touch ID wasn’t added");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry Touch ID")).toBe(true);
  });

  it("distinguishes a Touch ID setup failure from cancellation", async () => {
    state.perpsAuthenticated = true;
    const serviceFailure = new Error("internal service detail");
    serviceFailure.name = "TurnkeyRequestError";
    api.addPasskey.mockRejectedValue(serviceFailure);

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=lighter&short_venue=hyperliquid");
    const addButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add Touch ID");
    await act(async () => {
      addButton?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Check this device’s Touch ID and passkey settings");
    expect(container.textContent).not.toContain("internal service detail");
  });

  it("keeps Touch ID disabled without changing its label during a venue mutation", async () => {
    state.perpsAuthenticated = true;
    state.search = "long_venue=lighter&short_venue=hyperliquid";
    let finishWalletLookup!: (value: { owner: { address: string } }) => void;
    api.ensureWalletPair.mockImplementation(() => new Promise((resolve) => {
      finishWalletLookup = resolve;
    }));

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=lighter&short_venue=hyperliquid");
    const venueButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create & associate key");
    act(() => venueButton?.click());

    const touchIdButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add Touch ID");
    expect(touchIdButton?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Waiting for Touch ID…");

    await act(async () => {
      finishWalletLookup({ owner: { address: `0x${"33".repeat(20)}` } });
      await Promise.resolve();
    });
  });

  it("describes an existing passkey as account-level evidence", async () => {
    state.perpsAuthenticated = true;
    state.hasPasskey = true;

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    expect(container.textContent).toContain("Enabled for account");
    expect(container.textContent).toContain("A Ghola passkey is enabled for this account.");
    expect(container.textContent).not.toContain("successfully on this device");
  });

  it("resets device-local Touch ID confirmation when the wallet account changes", async () => {
    state.perpsAuthenticated = true;
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    const addButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add Touch ID");
    await act(async () => addButton?.click());
    expect(container.textContent).toContain("Added on this device");

    state.organizationId = "organization-two";
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Not added");
    expect(container.textContent).not.toContain("Added on this device");
  });

  it("ignores a Touch ID enrollment that finishes after the wallet account changes", async () => {
    state.perpsAuthenticated = true;
    let completeEnrollment!: () => void;
    api.addPasskey.mockImplementation(() => new Promise<void>((resolve) => {
      completeEnrollment = resolve;
    }));
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    const addButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add Touch ID");
    act(() => addButton?.click());
    expect(container.textContent).toContain("Waiting for Touch ID…");

    state.organizationId = "organization-two";
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");
    await act(async () => {
      completeEnrollment();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Not added");
    expect(container.textContent).not.toContain("Added on this device");
  });

  it("clears a stale Touch ID error when account-level passkey evidence arrives", async () => {
    state.perpsAuthenticated = true;
    api.addPasskey.mockRejectedValue(new Error("service unavailable"));
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    const addButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add Touch ID");
    await act(async () => addButton?.click());
    expect(container.textContent).toContain("Touch ID couldn’t be added");

    state.hasPasskey = true;
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Enabled for account");
    expect(container.textContent).not.toContain("Touch ID couldn’t be added");
    expect(container.textContent).not.toContain("Added on this device");
  });

  it("keeps current-device Touch ID failure feedback when the account already has a passkey", async () => {
    state.perpsAuthenticated = true;
    state.hasPasskey = true;
    const cancellation = new Error("not allowed");
    cancellation.name = "NotAllowedError";
    api.addPasskey.mockRejectedValue(cancellation);
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=lighter");

    const setupButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Set up this device");
    await act(async () => setupButton?.click());

    expect(container.textContent).toContain("Touch ID wasn’t added");
    expect(container.textContent).toContain("Retry Touch ID");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Enabled for account");
  });

  it("keeps the Lighter gas disclosure visible before authentication", async () => {
    state.search = "long_venue=lighter&short_venue=hyperliquid";
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=lighter&short_venue=hyperliquid");

    const disclosure = [...container.querySelectorAll("p")]
      .find((node) => node.textContent === "Uses one wallet approval and Ethereum gas. No order or deposit.");
    expect(disclosure).toBeTruthy();
    expect(disclosure?.closest("details")).toBeNull();
    expect(container.textContent).toContain("Authenticate by email");
  });

  it("keeps Aster approval scope visible beside its primary action", async () => {
    state.perpsAuthenticated = true;
    state.search = "long_venue=aster&short_venue=lighter";
    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=aster&short_venue=lighter");

    const disclosure = [...container.querySelectorAll("p")]
      .find((node) => node.textContent === "One approval lasts 30 days. Withdrawals stay disabled.");
    expect(disclosure).toBeTruthy();
    expect(disclosure?.closest("details")).toBeNull();
    expect(container.textContent).toContain("Connect Aster");
  });

  it("keeps Lighter gas use visible before finishing an active wallet", async () => {
    state.perpsAuthenticated = true;
    state.search = "long_venue=lighter&short_venue=hyperliquid";
    const ownerAddress = `0x${"55".repeat(20)}`;
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      lighter_activation: {
        owner_address: ownerAddress,
        reason: "venue_account_not_found",
      },
    };
    api.getHyperliquidExecutionVaultStatus.mockResolvedValue({ ready: true });
    api.fetchLighterActivationReadiness.mockResolvedValue({
      version: 2,
      owner_address: ownerAddress,
      lighter_account_index: 7,
      base_usdc_microunits: "3000000",
      base_eth_wei: "3000000000000",
      ethereum_eth_wei: "66000000000000",
      estimated_base_gas_wei: "3000000000000",
      estimated_ethereum_association_gas_wei: "66000000000000",
      base_deposit_ready: true,
      ethereum_association_gas_ready: true,
      lighter_owner_account_ready: true,
      ready: true,
      blockers: [],
      checked_at: new Date().toISOString(),
    });

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=lighter&short_venue=hyperliquid");

    expect(container.textContent).toContain("Finish connection");
    const disclosure = [...container.querySelectorAll("p")]
      .find((node) => node.textContent === "Finishing uses one wallet approval and Ethereum gas. No order or deposit.");
    expect(disclosure).toBeTruthy();
    expect(disclosure?.closest("details")).toBeNull();
  });

  it("presents Lighter activation as an actionable prerequisite and confirms copying the full address", async () => {
    state.perpsAuthenticated = true;
    state.search = "long_venue=lighter&short_venue=hyperliquid";
    const ownerAddress = `0x${"44".repeat(20)}`;
    state.recovery = {
      account_commitment: "carry:account:test:0001",
      lighter_activation: {
        owner_address: ownerAddress,
        reason: "venue_account_not_found",
      },
    };
    api.getHyperliquidExecutionVaultStatus.mockResolvedValue({ ready: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await renderSetup("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=lighter&short_venue=hyperliquid");

    expect(container.textContent).toContain("Next step");
    expect(container.textContent).toContain("Activate Lighter");
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).toContain("Funding and fee details");
    expect(container.textContent).toContain(ownerAddress);
    expect(container.querySelector('a[href="https://app.lighter.xyz/"]')).toBeTruthy();
    const copyButton = container.querySelector<HTMLButtonElement>('[aria-label="Copy owner address"]');
    await act(async () => copyButton?.click());
    expect(writeText).toHaveBeenCalledWith(ownerAddress);
    expect(container.querySelector('[aria-label="Owner address copied"]')?.textContent).toContain("Copied");
  });

  async function renderSetup(returnTo: string) {
    await act(async () => {
      root.render(<CarryAccountSetup returnTo={returnTo} hyperliquidNetwork="mainnet" />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});
