import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  connect: vi.fn(),
  proofHeaders: vi.fn(),
  requirePrepared: vi.fn(),
  required: vi.fn(),
  retrySiws: vi.fn(),
  sign: vi.fn(),
  stageCode: vi.fn((error: unknown) => (error as { code?: string } | null)?.code),
}));

const api = vi.hoisted(() => ({
  bind: vi.fn(),
  challenge: vi.fn(),
  eligibility: vi.fn(),
  roundtrip: vi.fn(),
}));

const access = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  billing: { tier: "starter" },
  readiness: { ready: true },
}));

vi.mock("@/lib/wallet-request-proof", () => ({
  connectSolanaWallet: wallet.connect,
  privateAccountMobileProofHeaders: wallet.proofHeaders,
  requirePreparedSolanaProvider: wallet.requirePrepared,
  requiredSolanaProvider: wallet.required,
  retryPhantomSiwsWalletConnection: wallet.retrySiws,
  walletConnectionStageCode: wallet.stageCode,
  walletSignBytes: wallet.sign,
}));

vi.mock("@/lib/private-account-client", () => ({
  HYPERLIQUID_MAINNET_PROOF_CONFIRMATION: "I_UNDERSTAND_THIS_OPENS_AND_CLOSES_A_REAL_MAINNET_POSITION",
  bindPrivateMobileWallet: api.bind,
  getPrivateMobileWalletBindingChallenge: api.challenge,
  runHyperliquidMainnetRoundTrip: api.roundtrip,
  verifyVenueEligibility: api.eligibility,
}));
vi.mock("./InvestorAccessGate", () => ({
  InvestorAccessGate: ({ children }: { children: (control: typeof access) => ReactNode }) => children(access),
}));

import { FundedMainnetRoundTrip } from "./FundedMainnetRoundTrip";

const WALLET = "11111111111111111111111111111111";
const PROVIDER = { isPhantom: true, isConnected: true };

describe("FundedMainnetRoundTrip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    wallet.required.mockReturnValue(PROVIDER);
    wallet.requirePrepared.mockReturnValue(PROVIDER);
    wallet.sign.mockResolvedValue(new Uint8Array(64));
    wallet.proofHeaders.mockImplementation(async (input: { signBytes: (bytes: Uint8Array) => Promise<Uint8Array> }) => {
      await input.signBytes(new Uint8Array([1]));
      return { "x-proof": "ok" };
    });
    api.challenge.mockResolvedValue({ message: "binding-message" });
    api.bind.mockResolvedValue({ ok: true });
    api.eligibility.mockResolvedValue({ ok: true });
    api.roundtrip.mockResolvedValue(completeReport());
    access.ensureReady.mockResolvedValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("states the exact real-money bounds and durable advantages", () => {
    const markup = renderToStaticMarkup(createElement(FundedMainnetRoundTrip));
    expect(markup).toContain("Hyperliquid mainnet · real funds");
    expect(markup).toContain("$11.00 filled round trip");
    expect(markup).toContain("Postgres claims");
    expect(markup).toContain("duplicate-submit protection");
    expect(markup).toContain("final-flat proof");
    expect(markup).toContain("Run real Hyperliquid proof trade");
  });

  it("stages fresh-click SIWS with zero server calls, then single-flights the separate final run", async () => {
    wallet.connect.mockRejectedValueOnce(stageError("phantom_siws_retry_required"));
    wallet.retrySiws.mockResolvedValueOnce(WALLET);
    await mount(root);
    await openConfirmation(container);
    await clickButton(container, "Authorize wallet only");

    expect(wallet.connect).toHaveBeenCalledWith({ deferPhantomSiws: true });
    expect(access.ensureReady.mock.invocationCallOrder[0]).toBeLessThan(wallet.connect.mock.invocationCallOrder[0]);
    expect(wallet.retrySiws).not.toHaveBeenCalled();
    expect(serverCalls()).toBe(0);
    expect(container.querySelector("[data-wallet-stage='phantom_siws_retry_required']")).not.toBeNull();

    await clickButton(container, "Continue with Phantom");
    expect(wallet.retrySiws).toHaveBeenCalledOnce();
    expect(serverCalls()).toBe(0);
    expect(container.textContent).toContain("Wallet verified. No order has been submitted.");

    await act(async () => {
      const button = findButton(container, "Sign and run real $11.00 round trip");
      button.click();
      button.click();
      await flush();
    });

    expect(api.challenge).toHaveBeenCalledOnce();
    expect(wallet.sign).toHaveBeenCalledTimes(2);
    expect(api.bind).toHaveBeenCalledOnce();
    expect(api.eligibility).toHaveBeenCalledOnce();
    expect(api.roundtrip).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLAnchorElement>('a[href="/trade?flow=hyperliquid-live"]')?.textContent)
      .toContain("Open the live terminal");
    expect(wallet.sign.mock.invocationCallOrder[1]).toBeLessThan(api.bind.mock.invocationCallOrder[0]);
    expect(wallet.requirePrepared).toHaveBeenLastCalledWith(PROVIDER, WALLET);
    const finalPinOrder = wallet.requirePrepared.mock.invocationCallOrder[
      wallet.requirePrepared.mock.invocationCallOrder.length - 1
    ];
    expect(finalPinOrder).toBeLessThan(api.roundtrip.mock.invocationCallOrder[0]);
  });

  it("rechecks access and performs no wallet or server work when it is no longer ready", async () => {
    access.ensureReady.mockResolvedValue(false);
    await mount(root);
    await openConfirmation(container);
    await clickButton(container, "Authorize wallet only");

    expect(access.ensureReady).toHaveBeenCalledOnce();
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(wallet.sign).not.toHaveBeenCalled();
    expect(serverCalls()).toBe(0);
  });

  it("rechecks access before a fresh Phantom retry", async () => {
    access.ensureReady.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    wallet.connect.mockRejectedValueOnce(stageError("phantom_siws_retry_required"));
    await mount(root);
    await openConfirmation(container);
    await clickButton(container, "Authorize wallet only");
    await clickButton(container, "Continue with Phantom");

    expect(access.ensureReady).toHaveBeenCalledTimes(2);
    expect(wallet.retrySiws).not.toHaveBeenCalled();
    expect(serverCalls()).toBe(0);
  });

  it("makes no mutating server request when the second signature is rejected", async () => {
    wallet.connect.mockResolvedValueOnce(WALLET);
    wallet.sign.mockResolvedValueOnce(new Uint8Array(64)).mockRejectedValueOnce(new Error("cancelled"));
    await mount(root);
    await openConfirmation(container);
    await clickButton(container, "Authorize wallet only");
    await clickButton(container, "Sign and run real $11.00 round trip");

    expect(api.challenge).toHaveBeenCalledOnce();
    expect(wallet.sign).toHaveBeenCalledTimes(2);
    expect(api.bind).not.toHaveBeenCalled();
    expect(api.eligibility).not.toHaveBeenCalled();
    expect(api.roundtrip).not.toHaveBeenCalled();
  });
});

async function mount(root: Root) {
  await act(async () => {
    root.render(createElement(FundedMainnetRoundTrip));
    await flush();
  });
}

async function openConfirmation(container: HTMLElement) {
  await clickButton(container, "Run real Hyperliquid proof trade");
  const checkbox = container.querySelector("input[type='checkbox']") as HTMLInputElement | null;
  if (!checkbox) throw new Error("checkbox missing");
  await act(async () => checkbox.click());
}

async function clickButton(container: HTMLElement, label: string) {
  await act(async () => {
    findButton(container, label).click();
    await flush();
  });
}

function findButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`button missing: ${label}`);
  return button;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function serverCalls() {
  return api.challenge.mock.calls.length + api.bind.mock.calls.length +
    api.eligibility.mock.calls.length + api.roundtrip.mock.calls.length;
}

function stageError(code: string) {
  return Object.assign(new Error("safe staged recovery"), { code });
}

function completeReport() {
  const fill = { filled_base_size: "1", filled_notional_usd: 11, average_fill_price: 11, fee_usd: 0 };
  const leg = { oid: "oid", cloid: "cloid", order_status: "filled", reduce_only: false, ...fill, fee_token: "USDC", transaction_hashes: [] };
  return {
    ok: true,
    flat_after_exit: true,
    open_orders_after_exit: 0,
    venue_position_protection_proven: true,
    protection_cleanup_confirmed: true,
    protection_children_terminal: true,
    entry_fill_summary: fill,
    exit_fill_summary: fill,
    entry_order_reference: leg,
    exit_order_reference: { ...leg, reduce_only: true },
    proof_work_order_commitment: "proof",
    entry_work_order_commitment: "entry",
    exit_work_order_commitment: "exit",
    claim_store: "postgres",
  };
}
