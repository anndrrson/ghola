"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ClipboardEvent } from "react";
import { Check, ClipboardPaste, Link2, Loader2, ShieldCheck, TriangleAlert, WifiOff } from "lucide-react";
import {
  bindPrivateMobileWallet,
  getPrivateMobileWalletBindingChallenge,
  getHyperliquidExecutionVaultStatus,
  revokeHyperliquidExecutionVault,
  sealHyperliquidExecutionVault,
} from "@/lib/private-account-client";
import {
  buildHyperliquidExecutionVaultBundle,
  fetchPrivateAgentRuntimeStatus,
  parseHyperliquidCredentialImport,
  validateHyperliquidExecutionCredentialDraft,
  type HyperliquidExecutionCredentialDraft,
} from "@/lib/hyperliquid-vault-seal";
import {
  createBrowserEd25519Wallet,
  signBrowserEd25519Bytes,
} from "@/lib/browser-ed25519-wallet";
import {
  chooseConfidentialComputeProvider,
  type PrivateAgentRuntimeStatus,
} from "@/lib/private-agent-runtime";
import {
  connectSolanaWallet,
  privateAccountMobileProofHeaders,
  requiredSolanaProvider,
  walletSignBytes,
} from "@/lib/wallet-request-proof";

// Runtime starts are always explicit. Reading connection state must never
// consume worker time as a side effect.
async function sealableRuntimeStatus(): Promise<PrivateAgentRuntimeStatus> {
  const hasSealableProvider = (runtime: PrivateAgentRuntimeStatus) =>
    chooseConfidentialComputeProvider(runtime.providers, runtime.preferred_provider) !== null;
  try {
    const runtime = await fetchPrivateAgentRuntimeStatus();
    if (hasSealableProvider(runtime)) return runtime;
  } catch {
    // fall through to the wake attempt
  }
  throw new Error("Agent runtime is offline.");
}

type VaultStatus = {
  version: 1;
  account_commitment: string;
  hyperliquid_execution_vault: { status?: string; network?: "mainnet" | "testnet" | null } | null;
  ready: boolean;
};

type ConnectState =
  | { status: "loading" }
  | { status: "runtime_offline" }
  | { status: "signed_out" }
  | { status: "connected"; network: "mainnet" | "testnet" | null }
  | { status: "form"; accountCommitment: string; runtime: PrivateAgentRuntimeStatus }
  | { status: "sealing"; accountCommitment: string; runtime: PrivateAgentRuntimeStatus }
  | { status: "error"; message: string };

const EMPTY_DRAFT: HyperliquidExecutionCredentialDraft = {
  network: "mainnet",
  hyperliquid_account_address: "",
  api_wallet_private_key: "",
  agent_name: "",
};

// Isolated, additive control: seals a user-provided trade-only Hyperliquid API
// wallet to the attested private-agent recipient, entirely client-side — the
// plaintext key never leaves the browser except as ciphertext sealed to the
// worker. Rendered next to ArmAgentButton; does not touch the hand-coded
// trade layout.
export function ConnectHyperliquidButton({
  ready = false,
  network = "mainnet",
  onNetworkChange,
}: {
  ready?: boolean;
  network?: "mainnet" | "testnet";
  onNetworkChange?: (network: "mainnet" | "testnet") => void;
}) {
  const [state, setState] = useState<ConnectState>({ status: "loading" });
  const [draft, setDraft] = useState<HyperliquidExecutionCredentialDraft>({ ...EMPTY_DRAFT, network });
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState({ status: "loading" });
    let vault: VaultStatus;
    try {
      vault = await getHyperliquidExecutionVaultStatus() as VaultStatus;
    } catch (error) {
      const status = (error as { status?: number }).status;
      setState(status === 401 ? { status: "signed_out" } : {
        status: "error",
        message: error instanceof Error ? error.message : "Could not read venue status.",
      });
      return;
    }
    if (
      vault.hyperliquid_execution_vault &&
      vault.hyperliquid_execution_vault.status !== "revoked"
    ) {
      const connectedNetwork = vault.hyperliquid_execution_vault.network ?? null;
      setState({ status: "connected", network: connectedNetwork });
      if (connectedNetwork) onNetworkChange?.(connectedNetwork);
      return;
    }
    try {
      const runtime = await sealableRuntimeStatus();
      setState({ status: "form", accountCommitment: vault.account_commitment, runtime });
    } catch {
      setState({ status: "runtime_offline" });
    }
  }, [onNetworkChange]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [ready, refresh]);

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const imported = parseHyperliquidCredentialImport(event.clipboardData.getData("text"), draft);
    if (imported.fields.length > 0) {
      event.preventDefault();
      setDraft(imported.draft);
    }
  }

  async function connectAndSeal() {
    if (state.status !== "form") return;
    const errors = validateHyperliquidExecutionCredentialDraft(draft);
    if (errors.length > 0) {
      setFormError(errors[0]);
      return;
    }
    setFormError(null);
    setState({ status: "sealing", accountCommitment: state.accountCommitment, runtime: state.runtime });
    try {
      const authorizationWallet = await connectSolanaWallet();
      const walletProvider = requiredSolanaProvider();
      const bindingChallenge = await getPrivateMobileWalletBindingChallenge(authorizationWallet);
      const bindingSignature = await walletSignBytes(
        walletProvider,
        new TextEncoder().encode(bindingChallenge.message),
      );
      await bindPrivateMobileWallet({
        wallet_pubkey: authorizationWallet,
        message: bindingChallenge.message,
        signature_b64: signatureBase64(bindingSignature),
      });

      // Hyperliquid users authenticate with an EVM wallet. The sealed-envelope
      // format itself uses an Ed25519 sender DID, so create a short-lived local
      // signing identity for the envelope instead of incorrectly requiring the
      // user's injected wallet to expose Solana signMessage.
      const envelopeSigner = createBrowserEd25519Wallet("ghola-hyperliquid-seal");
      const bundle = await buildHyperliquidExecutionVaultBundle({
        accountCommitment: state.accountCommitment,
        ownerWalletAddress: envelopeSigner.walletAddress,
        credential: draft,
        runtimeStatus: state.runtime,
        signBytes: async (bytes) => signBrowserEd25519Bytes(envelopeSigner.secretKeyHex, bytes),
      });
      const vaultBody = {
        encrypted_execution_vault: bundle.encrypted_execution_vault,
      };
      const proofHeaders = await privateAccountMobileProofHeaders({
        path: "/v1/private-account/hyperliquid/vault",
        body: vaultBody,
        wallet: authorizationWallet,
        signBytes: async (bytes) => walletSignBytes(walletProvider, bytes),
      });
      await sealHyperliquidExecutionVault(vaultBody, { proofHeaders });
      setDraft(EMPTY_DRAFT);
      setState({ status: "connected", network: draft.network });
    } catch (error) {
      setDraft((current) => ({ ...current, api_wallet_private_key: "" }));
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not seal the venue credential.",
      });
    }
  }

  if (!ready || state.status === "signed_out") return null;

  return (
    <div className="trade-panel mt-4 rounded-md p-4">
      <div className="mb-2 flex items-center gap-2">
        <Link2 className="h-4 w-4 text-[#5aa7ff]" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#a8d8ff]">
          Connect Hyperliquid
        </span>
      </div>

      {state.status === "loading" ? (
        <div className="flex items-center gap-2 text-xs text-[#8b95a8]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking venue connection…
        </div>
      ) : state.status === "connected" ? (
        <div className="grid gap-2">
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your Hyperliquid API wallet is sealed to the agent worker for <strong>{state.network ?? "an older unspecified network"}</strong>.
              Trade-only: it cannot withdraw your funds, and you can revoke it anytime.
            </span>
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                await revokeHyperliquidExecutionVault();
                await refresh();
              } catch (error) {
                setState({ status: "error", message: error instanceof Error ? error.message : "Could not replace the credential." });
              }
            }}
            className="trade-chip flex h-9 items-center justify-center rounded-md px-4 text-xs"
          >
            Replace or switch network
          </button>
          {state.network === "mainnet" && process.env.NEXT_PUBLIC_GHOLA_HYPERLIQUID_MAINNET_PROOF_UI_ENABLED === "true" ? (
            <Link
              href="/trade/mainnet-e2e"
              className="trade-action flex h-10 items-center justify-center rounded-md px-4 text-xs font-semibold"
            >
              Run real $10.50 proof trade
            </Link>
          ) : null}
        </div>
      ) : state.status === "runtime_offline" ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Agent runtime is offline. Start it explicitly from Agent activity before connecting this account.</span>
        </div>
      ) : state.status === "error" ? (
        <div className="grid gap-2">
          <p className="flex items-start gap-1.5 text-[11px] leading-5 text-rose-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {state.message}
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="trade-chip flex h-9 items-center justify-center rounded-md px-4 text-xs"
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Hyperliquid network">
            {(["mainnet", "testnet"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setDraft((current) => ({ ...current, network: value }));
                  onNetworkChange?.(value);
                }}
                className={`trade-chip h-9 rounded-md text-xs font-semibold ${network === value ? "border-[#5aa7ff] text-[#a8d8ff]" : ""}`}
              >
                {value === "mainnet" ? "Mainnet · real funds" : "Testnet · no real funds"}
              </button>
            ))}
          </div>
          {network === "testnet" ? (
            <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100">
              TESTNET MODE — orders use Hyperliquid testnet only. No real funds.
            </div>
          ) : null}
          <p className="text-[11px] leading-5 text-[#566278]">
            Connect a <strong>trade-only Hyperliquid API wallet</strong> so the agent can execute your
            plan on your own account. The key is sealed in your browser to the agent worker — it is
            never sent or stored in plaintext, cannot withdraw funds, and is revocable anytime.
          </p>
          <p className="text-[10px] leading-4 text-[#69758a]">
            Your Solana wallet signs two authorization messages. No transaction is created and no
            Solana funds move.
          </p>
          <label className="grid gap-1 text-[11px] text-[#8b95a8]">
            Hyperliquid account address
            <input
              type="text"
              value={draft.hyperliquid_account_address}
              onChange={(event) => setDraft({ ...draft, hyperliquid_account_address: event.target.value })}
              onPaste={handlePaste}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              className="trade-chip h-10 rounded-md px-3 font-mono text-xs text-white"
            />
          </label>
          <label className="grid gap-1 text-[11px] text-[#8b95a8]">
            API wallet private key (trade-only)
            <input
              type="password"
              value={draft.api_wallet_private_key}
              onChange={(event) => setDraft({ ...draft, api_wallet_private_key: event.target.value })}
              onPaste={handlePaste}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              className="trade-chip h-10 rounded-md px-3 font-mono text-xs text-white"
            />
          </label>
          <label className="grid gap-1 text-[11px] text-[#8b95a8]">
            Agent name (optional)
            <input
              type="text"
              value={draft.agent_name ?? ""}
              onChange={(event) => setDraft({ ...draft, agent_name: event.target.value })}
              placeholder="ghola-agent"
              autoComplete="off"
              spellCheck={false}
              className="trade-chip h-10 rounded-md px-3 font-mono text-xs text-white"
            />
          </label>
          <div className="flex items-center gap-1.5 text-[10px] text-[#566278]">
            <ClipboardPaste className="h-3 w-3 shrink-0" />
            Paste an exported credential (JSON or key=value) into any field to fill the form.
          </div>
          {formError ? (
            <p className="flex items-center gap-1.5 text-[11px] leading-5 text-rose-300">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {formError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void connectAndSeal()}
            disabled={state.status === "sealing"}
            className="trade-action flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.status === "sealing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {state.status === "sealing" ? "Sealing credential" : "Seal & connect account"}
          </button>
        </div>
      )}
    </div>
  );
}

function signatureBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
