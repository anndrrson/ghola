import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarryAccountSetup } from "./CarryAccountSetup";

const state = vi.hoisted(() => ({
  search: "",
  recovery: null as null | Record<string, unknown>,
}));
const api = vi.hoisted(() => ({
  getHyperliquidExecutionVaultStatus: vi.fn(),
  getPrivateAgentPassport: vi.fn(),
  fetchPrivateAgentRuntimeStatus: vi.fn(),
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
    authenticated: false,
    configured: true,
    hasPasskey: true,
    loading: false,
    ensureWalletPair: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    createPasskey: vi.fn(),
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
  fetchLighterActivationReadiness: vi.fn().mockResolvedValue(null),
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

    expect(container.textContent).toContain("0/2");
    expect(container.textContent).toContain("Hyperliquid");
    expect(container.textContent).toContain("Lighter");
    expect(container.textContent).not.toContain("Aster");
    expect(container.querySelector('a[href*="setup=hyperliquid"]')).toBeNull();

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

  async function renderSetup(returnTo: string) {
    await act(async () => {
      root.render(<CarryAccountSetup returnTo={returnTo} hyperliquidNetwork="mainnet" />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});
