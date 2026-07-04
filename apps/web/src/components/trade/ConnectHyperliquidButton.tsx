"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ClipboardPaste, Link2, Loader2, ShieldCheck, TriangleAlert, WifiOff } from "lucide-react";
import {
  getHyperliquidExecutionVaultStatus,
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
  connectSolanaWallet,
  requiredSolanaProvider,
  walletSignBytes,
} from "@/lib/wallet-request-proof";
import type { PrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime";

type VaultStatus = {
  version: 1;
  account_commitment: string;
  hyperliquid_execution_vault: { status?: string } | null;
  ready: boolean;
};

type ConnectState =
  | { status: "loading" }
  | { status: "runtime_offline" }
  | { status: "signed_out" }
  | { status: "connected" }
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
export function ConnectHyperliquidButton({ ready = false }: { ready?: boolean }) {
  const [state, setState] = useState<ConnectState>({ status: "loading" });
  const [draft, setDraft] = useState<HyperliquidExecutionCredentialDraft>(EMPTY_DRAFT);
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
    if (vault.hyperliquid_execution_vault) {
      setState({ status: "connected" });
      return;
    }
    try {
      const runtime = await fetchPrivateAgentRuntimeStatus();
      setState({ status: "form", accountCommitment: vault.account_commitment, runtime });
    } catch {
      setState({ status: "runtime_offline" });
    }
  }, []);

  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  function handlePaste(value: string) {
    const imported = parseHyperliquidCredentialImport(value, draft);
    if (imported.fields.length > 0) setDraft(imported.draft);
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
      const ownerWalletAddress = await connectSolanaWallet();
      const bundle = await buildHyperliquidExecutionVaultBundle({
        accountCommitment: state.accountCommitment,
        ownerWalletAddress,
        credential: draft,
        runtimeStatus: state.runtime,
        signBytes: (bytes) => walletSignBytes(requiredSolanaProvider(), bytes),
      });
      await sealHyperliquidExecutionVault({
        encrypted_execution_vault: bundle.encrypted_execution_vault,
      });
      setDraft(EMPTY_DRAFT);
      setState({ status: "connected" });
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
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Your Hyperliquid API wallet is sealed to the agent worker. Trade-only: it cannot withdraw
            your funds, and you can revoke it on Hyperliquid anytime.
          </span>
        </div>
      ) : state.status === "runtime_offline" ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Agent runtime is offline — connecting your account is paused until a sealed worker is live.</span>
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
          <p className="text-[11px] leading-5 text-[#566278]">
            Connect a <strong>trade-only Hyperliquid API wallet</strong> so the agent can execute your
            plan on your own account. The key is sealed in your browser to the agent worker — it is
            never sent or stored in plaintext, cannot withdraw funds, and is revocable anytime.
          </p>
          <label className="grid gap-1 text-[11px] text-[#8b95a8]">
            Hyperliquid account address
            <input
              type="text"
              value={draft.hyperliquid_account_address}
              onChange={(event) => setDraft({ ...draft, hyperliquid_account_address: event.target.value })}
              onPaste={(event) => handlePaste(event.clipboardData.getData("text"))}
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
              onPaste={(event) => handlePaste(event.clipboardData.getData("text"))}
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
