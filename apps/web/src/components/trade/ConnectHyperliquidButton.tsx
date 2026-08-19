"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Link2, Loader2, ShieldCheck, TriangleAlert, WifiOff } from "lucide-react";
import {
  getHyperliquidExecutionVaultStatus,
  getHyperliquidLiveAccess,
  removeRevokedLegacyHyperliquidAgentVault,
} from "@/lib/private-account-client";
import { fetchPrivateAgentRuntimeStatus } from "@/lib/hyperliquid-vault-seal";
import {
  preparePhantomHyperliquidAgentAuthorization,
  preparePhantomHyperliquidAgentDisable,
  submitPhantomHyperliquidAuthorization,
  submitPhantomHyperliquidDisable,
} from "@/lib/hyperliquid-agent-wallet.client";
import type {
  HyperliquidAgentAuthorizationRequest,
  HyperliquidAgentRevocationRequest,
} from "@/lib/hyperliquid-agent-wallet";
import {
  chooseConfidentialComputeProvider,
  type PrivateAgentRuntimeStatus,
} from "@/lib/private-agent-runtime";
import { investorFacingErrorMessage } from "@/lib/investor-facing-error";

async function sealableRuntimeStatus(): Promise<PrivateAgentRuntimeStatus> {
  const runtime = await fetchPrivateAgentRuntimeStatus();
  if (chooseConfidentialComputeProvider(runtime.providers, runtime.preferred_provider)) return runtime;
  throw new Error("Agent runtime is offline.");
}

type VaultStatus = {
  version: 1;
  account_commitment: string;
  hyperliquid_execution_vault: {
    status?: string;
    network?: "mainnet" | "testnet" | null;
    authorization_source?: "phantom_approve_agent_v1" | "legacy_import";
    venue_revoke_supported?: boolean;
    authorization_valid_until?: string | null;
  } | null;
  ready: boolean;
};

type ConnectState =
  | { status: "loading" }
  | { status: "runtime_offline" }
  | { status: "eligibility_required" }
  | { status: "signed_out" }
  | {
      status: "connected";
      accountCommitment: string;
      automated: boolean;
      revokeSupported: boolean;
      validUntil: string | null;
    }
  | { status: "legacy_migration"; accountCommitment: string }
  | { status: "ready"; accountCommitment: string; runtime: PrivateAgentRuntimeStatus }
  | { status: "authorizing"; message: string }
  | { status: "disabling"; message: string }
  | { status: "verifying_legacy"; message: string }
  | { status: "error"; message: string; retry: "authorize" | "disable" | "legacy" | null; accountCommitment: string | null };

const PENDING_AUTHORIZE_PREFIX = "ghola-hyperliquid-agent-authorize-v1:";
const PENDING_DISABLE_PREFIX = "ghola-hyperliquid-agent-disable-v1:";

export function ConnectHyperliquidButton({
  ready = false,
  onNetworkChange,
  beforeWalletAction,
  onVaultStatusChange,
}: {
  ready?: boolean;
  network?: "mainnet" | "testnet";
  onNetworkChange?: (network: "mainnet" | "testnet") => void;
  beforeWalletAction?: () => Promise<boolean>;
  onVaultStatusChange?: () => void | Promise<void>;
}) {
  const [state, setState] = useState<ConnectState>({ status: "loading" });
  const pendingAuthorization = useRef<HyperliquidAgentAuthorizationRequest | null>(null);
  const pendingDisable = useRef<HyperliquidAgentRevocationRequest | null>(null);
  const operationRef = useRef(false);

  async function refreshParentSetup() {
    try {
      await onVaultStatusChange?.();
    } catch {
      // The venue mutation already succeeded; the parent retains its own retry UI.
    }
  }

  const refresh = useCallback(async () => {
    setState({ status: "loading" });
    let vault: VaultStatus;
    try {
      vault = await getHyperliquidExecutionVaultStatus() as VaultStatus;
    } catch (error) {
      const status = (error as { status?: number }).status;
      setState(status === 401 ? { status: "signed_out" } : {
        status: "error",
        message: errorMessage(error, "Could not read venue status."),
        retry: null,
        accountCommitment: null,
      });
      return;
    }
    const savedPendingDisable = loadPendingDisable(vault.account_commitment);
    pendingDisable.current = savedPendingDisable;
    if (vault.hyperliquid_execution_vault?.status !== "revoked") {
      if (vault.hyperliquid_execution_vault) {
        const automated = vault.hyperliquid_execution_vault.authorization_source === "phantom_approve_agent_v1";
        if (!automated && vault.hyperliquid_execution_vault.network === "mainnet") {
          pendingAuthorization.current = null;
          clearPendingAuthorization(vault.account_commitment);
          setState({ status: "legacy_migration", accountCommitment: vault.account_commitment });
          return;
        }
        const validUntil = vault.hyperliquid_execution_vault.authorization_valid_until ?? null;
        const revokeSupported = vault.hyperliquid_execution_vault.venue_revoke_supported === true;
        if (savedPendingDisable && automated && revokeSupported) {
          setState({
            status: "error",
            message: "A previous disable may already have reached Hyperliquid. Retry the exact venue check; Phantom will not prompt again.",
            retry: "disable",
            accountCommitment: vault.account_commitment,
          });
          return;
        }
        const authorizationCurrent = vault.ready === true && automated && (
          validUntil !== null && Number.isFinite(Date.parse(validUntil)) && Date.parse(validUntil) > Date.now() + 5 * 60_000
        );
        if (authorizationCurrent) {
          onNetworkChange?.("mainnet");
          pendingAuthorization.current = null;
          clearPendingAuthorization(vault.account_commitment);
          setState({
            status: "connected",
            accountCommitment: vault.account_commitment,
            automated,
            revokeSupported,
            validUntil,
          });
          return;
        }
      }
    }
    if (savedPendingDisable && (!vault.hyperliquid_execution_vault || vault.hyperliquid_execution_vault.status === "revoked")) {
      pendingDisable.current = null;
      clearPendingDisable(vault.account_commitment);
    }
    try {
      const access = await getHyperliquidLiveAccess() as { eligibility_ready?: boolean };
      if (access.eligibility_ready !== true) {
        setState({ status: "eligibility_required" });
        return;
      }
    } catch (error) {
      const status = (error as { status?: number }).status;
      setState(status === 401 ? { status: "signed_out" } : {
        status: "error",
        message: errorMessage(error, "Could not verify live-trading eligibility."),
        retry: null,
        accountCommitment: null,
      });
      return;
    }
    try {
      const runtime = await sealableRuntimeStatus();
      onNetworkChange?.("mainnet");
      const pending = loadPendingAuthorization(vault.account_commitment);
      pendingAuthorization.current = pending;
      setState({ status: "ready", accountCommitment: vault.account_commitment, runtime });
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
    return () => { cancelled = true; };
  }, [ready, refresh]);

  async function authorize() {
    if (state.status !== "ready" && !(state.status === "error" && state.retry === "authorize")) return;
    if (operationRef.current) return;
    operationRef.current = true;
    const accountCommitment = state.status === "ready"
      ? state.accountCommitment
      : state.accountCommitment;
    try {
      if (beforeWalletAction && !await beforeWalletAction()) return;
      if (!accountCommitment) {
        await refresh();
        return;
      }
      let request = pendingAuthorization.current ?? loadPendingAuthorization(accountCommitment);
      if (!request) {
        if (state.status !== "ready") throw new Error("The sealed retry expired. Start wallet authorization again.");
        setState({ status: "authorizing", message: "Checking the selected Hyperliquid account…" });
        request = await preparePhantomHyperliquidAgentAuthorization({
          accountCommitment,
          runtime: state.runtime,
        });
        pendingAuthorization.current = request;
        savePending(PENDING_AUTHORIZE_PREFIX, accountCommitment, request);
      }
      setState({ status: "authorizing", message: "Verifying Hyperliquid authorization…" });
      await submitPhantomHyperliquidAuthorization(request);
      pendingAuthorization.current = null;
      clearPendingAuthorization(accountCommitment);
      await Promise.all([refresh(), refreshParentSetup()]);
    } catch (error) {
      const retrySafe = retrySafeError(error) && pendingAuthorization.current !== null;
      if (!retrySafe) {
        pendingAuthorization.current = null;
        if (accountCommitment) clearPendingAuthorization(accountCommitment);
      }
      setState({
        status: "error",
        message: setupErrorMessage(error),
        retry: retrySafe ? "authorize" : null,
        accountCommitment,
      });
    } finally {
      operationRef.current = false;
    }
  }

  async function disable() {
    if (state.status !== "connected" && !(state.status === "error" && state.retry === "disable")) return;
    if (operationRef.current) return;
    operationRef.current = true;
    const accountCommitment = state.status === "connected"
      ? state.accountCommitment
      : state.accountCommitment;
    try {
      if (!accountCommitment) {
        await refresh();
        return;
      }
      let request = pendingDisable.current ?? loadPendingDisable(accountCommitment);
      if (!request) {
        setState({ status: "disabling", message: "Preparing a safe Hyperliquid key replacement…" });
        request = await preparePhantomHyperliquidAgentDisable({ accountCommitment });
        pendingDisable.current = request;
        savePending(PENDING_DISABLE_PREFIX, accountCommitment, request);
      }
      setState({ status: "disabling", message: "Verifying the old Ghola key is disabled…" });
      await submitPhantomHyperliquidDisable(request);
      pendingDisable.current = null;
      clearPendingDisable(accountCommitment);
      await Promise.all([refresh(), refreshParentSetup()]);
    } catch (error) {
      const retrySafe = retrySafeError(error) && pendingDisable.current !== null;
      if (!retrySafe) {
        pendingDisable.current = null;
        if (accountCommitment) clearPendingDisable(accountCommitment);
      }
      setState({
        status: "error",
        message: disableErrorMessage(error),
        retry: retrySafe ? "disable" : null,
        accountCommitment,
      });
    } finally {
      operationRef.current = false;
    }
  }

  async function verifyLegacyRemoval() {
    if (state.status !== "legacy_migration" && !(state.status === "error" && state.retry === "legacy")) return;
    if (operationRef.current) return;
    operationRef.current = true;
    const accountCommitment = state.accountCommitment;
    try {
      setState({
        status: "verifying_legacy",
        message: "Verifying the decrypted legacy API wallet is no longer authorized…",
      });
      await removeRevokedLegacyHyperliquidAgentVault();
      await Promise.all([refresh(), refreshParentSetup()]);
    } catch (error) {
      setState({
        status: "error",
        message: legacyRemovalErrorMessage(error),
        retry: "legacy",
        accountCommitment,
      });
    } finally {
      operationRef.current = false;
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
        <Status loading>Checking venue connection…</Status>
      ) : state.status === "connected" ? (
        <div className="grid gap-3">
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {state.automated ? (
              <span>
                Phantom approved a sealed, trade-only Hyperliquid API wallet.
                It cannot withdraw or transfer funds
                {state.validUntil ? <> and expires {new Date(state.validUntil).toLocaleString()}</> : ""}.
              </span>
            ) : (
              <span>A legacy sealed Hyperliquid API wallet is stored for this account.</span>
            )}
          </div>
          {state.revokeSupported ? (
            <button
              type="button"
              onClick={() => void disable()}
              className="trade-chip flex h-10 items-center justify-center rounded-md px-4 text-xs"
            >
              Disable Ghola trading
            </button>
          ) : (
            <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-3 text-[11px] leading-5 text-amber-100">
              This legacy API wallet cannot be revoked safely from Ghola. Revoke it in Hyperliquid’s API settings before removing local access.
              <a href="https://app.hyperliquid.xyz/API" target="_blank" rel="noopener noreferrer" className="ml-1 underline underline-offset-2">
                Open Hyperliquid API settings
              </a>
            </div>
          )}
          {process.env.NEXT_PUBLIC_GHOLA_HYPERLIQUID_ACCOUNT_PROOF_ENABLED === "true" ? (
            <Link href="/trade/mainnet-e2e" className="trade-action flex h-10 items-center justify-center rounded-md px-4 text-xs font-semibold">
              Run real $11.00 proof trade
            </Link>
          ) : null}
        </div>
      ) : state.status === "legacy_migration" ? (
        <div className="grid gap-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-3 text-[11px] leading-5 text-amber-100">
          <p>This legacy mainnet API wallet is not investor-ready and cannot unlock trading.</p>
          <p>Revoke it in Hyperliquid API settings, then let Ghola’s worker verify the decrypted agent is absent before local removal.</p>
          <div className="flex flex-wrap gap-2">
            <a href="https://app.hyperliquid.xyz/API" target="_blank" rel="noopener noreferrer" className="trade-chip inline-flex h-9 items-center justify-center rounded-md px-3 text-xs">
              Open Hyperliquid API settings
            </a>
            <button type="button" onClick={() => void verifyLegacyRemoval()} className="trade-chip h-9 rounded-md px-3 text-xs">
              Verify revocation and remove legacy wallet
            </button>
          </div>
        </div>
      ) : state.status === "runtime_offline" ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Agent runtime is offline. Start the secure worker, then retry.</span>
        </div>
      ) : state.status === "eligibility_required" ? (
        <div className="grid gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-3 text-xs text-amber-100">
          <p>Accept the current eligibility, terms, and risk disclosure before authorizing Phantom.</p>
          <Link href="/account?flow=trade#eligibility-consent" className="trade-chip flex h-9 items-center justify-center rounded-md px-4 text-xs">
            Review eligibility and terms
          </Link>
        </div>
      ) : state.status === "authorizing" || state.status === "disabling" || state.status === "verifying_legacy" ? (
        <Status loading>{state.message}</Status>
      ) : state.status === "error" ? (
        <div className="grid gap-2">
          <p role="alert" className="flex items-start gap-1.5 text-[11px] leading-5 text-rose-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {state.message}
          </p>
          <button
            type="button"
            onClick={() => state.retry === "authorize"
              ? void authorize()
              : state.retry === "disable"
                ? void disable()
                : state.retry === "legacy"
                  ? void verifyLegacyRemoval()
                : void refresh()}
            className="trade-chip flex h-9 items-center justify-center rounded-md px-4 text-xs"
          >
            {state.retry ? "Retry exact venue check" : "Try again"}
          </button>
          {state.retry === "legacy" ? (
            <a href="https://app.hyperliquid.xyz/API" target="_blank" rel="noopener noreferrer" className="text-center text-xs text-amber-200 underline underline-offset-2">
              Open Hyperliquid API settings
            </a>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="rounded-md border border-rose-300/20 bg-rose-300/[0.04] px-3 py-2 text-xs font-semibold text-rose-100">
            Hyperliquid mainnet · real funds
          </div>
          <p className="text-[11px] leading-5 text-[#8b95a8]">
            Use the funded Phantom EVM account you trade with on Hyperliquid. Ghola creates a fresh 24-hour API wallet, seals its key directly to the attested worker, then asks Phantom to approve that trade-only wallet.
          </p>
          <ul className="list-disc space-y-1 pl-4 text-[10px] leading-4 text-[#69758a]">
            <li>No seed phrase or private key is requested or shown.</li>
            <li>The Phantom signature is not a transaction and cannot withdraw or transfer funds.</li>
            <li>The account must be a funded, flat Hyperliquid master account with no open orders.</li>
          </ul>
          <button
            type="button"
            onClick={() => void authorize()}
            className="trade-action flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold"
          >
            <ShieldCheck className="h-4 w-4" />
            {pendingAuthorization.current ? "Resume authorization check" : "Authorize with Phantom"}
          </button>
        </div>
      )}
    </div>
  );
}

function Status({ loading, children }: { loading?: boolean; children: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-[#8b95a8]">
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </div>
  );
}

function retrySafeError(error: unknown) {
  const body = (error as { body?: { retry_safe?: unknown } })?.body;
  const status = (error as { status?: number })?.status;
  return (status === 429 || status === 503) && body?.retry_safe === true;
}

function setupErrorMessage(error: unknown) {
  const fallback = "Hyperliquid authorization could not be verified.";
  const code = rawErrorMessage(error, fallback);
  if (code === "hyperliquid_account_funding_required") return "Deposit at least $12 of usable USDC into this Hyperliquid account, then retry.";
  if (code === "hyperliquid_account_must_be_flat_for_wallet_setup") return "Close all positions and orders in Hyperliquid before authorizing Ghola.";
  if (code === "hyperliquid_master_account_required") return "Select the funded Hyperliquid master account in Phantom; agent, vault, and subaccount addresses are not accepted.";
  if (code === "hyperliquid_account_preflight_unavailable") return "Hyperliquid account checks are temporarily unavailable. Retry when the venue responds.";
  if (code === "hyperliquid_agent_authorization_state_unknown") return "Hyperliquid’s authorization state is unknown. Start authorization again after the venue recovers.";
  if (code === "hyperliquid_agent_vault_worker_verification_unknown") return "The attested worker could not confirm the sealed API wallet. Retry the exact worker check; Phantom will not prompt again.";
  if (code === "hyperliquid_agent_vault_storage_state_unknown") return "Ghola could not confirm the sealed wallet was stored. Retry the exact check; Phantom will not prompt again.";
  if (code === "hyperliquid_agent_vault_unreadable") return "The attested worker could not decrypt the sealed API wallet. Start authorization again.";
  if (code === "hyperliquid_agent_vault_recipient_mismatch") return "The secure worker changed before setup completed. Start authorization again with its current attested recipient.";
  if (code === "hyperliquid_agent_vault_identity_mismatch" || code === "hyperliquid_agent_vault_binding_mismatch") return "The sealed API wallet did not match the Phantom authorization. Start again.";
  if (code === "hyperliquid_agent_authorization_rejected") return "Hyperliquid rejected the API-wallet authorization. Confirm the selected Phantom account is funded and active.";
  if (code === "wallet_setup_rate_limited") return "Setup is rate-limited before submission. Retry the exact signed request shortly; Phantom will not prompt again.";
  if (code === "wallet_setup_quota_unavailable" || code === "live_trading_gate_closed") return "Setup is temporarily unavailable before submission. Retry the exact signed request; Phantom will not prompt again.";
  return investorFacingErrorMessage(error, fallback);
}

function disableErrorMessage(error: unknown) {
  const fallback = "Ghola trading access could not be disabled safely.";
  const code = rawErrorMessage(error, fallback);
  if (code === "hyperliquid_agent_authorization_state_unknown") return "Hyperliquid’s replacement state is temporarily unknown. Retry the exact venue check; Phantom will not prompt again.";
  if (code === "hyperliquid_account_preflight_unavailable") return "Hyperliquid account safety checks are temporarily unavailable. Retry the exact disable check; Phantom will not prompt again.";
  if (code === "hyperliquid_account_must_be_flat_for_wallet_setup") return "Close all positions and orders before disabling the API wallet, so risk-reduction access is not stranded.";
  return investorFacingErrorMessage(error, fallback);
}

function legacyRemovalErrorMessage(error: unknown) {
  const fallback = "Legacy API-wallet revocation could not be verified.";
  const code = rawErrorMessage(error, fallback);
  if (code === "legacy_hyperliquid_agent_still_authorized") return "The legacy API wallet is still authorized. Revoke it in Hyperliquid API settings, then verify again.";
  if (code === "hyperliquid_agent_authorization_state_unknown") return "Hyperliquid authority could not be read conclusively. Nothing was removed; retry verification.";
  if (code === "hyperliquid_agent_vault_unreadable" || code === "hyperliquid_agent_vault_recipient_mismatch") return "The secure worker cannot decrypt this legacy wallet, so Ghola will not remove it.";
  if (code === "hyperliquid_agent_vault_identity_mismatch") return "The decrypted legacy wallet does not match this account. Nothing was removed.";
  if (code === "hyperliquid_agent_vault_worker_verification_unknown") return "The secure worker could not prove revocation. Nothing was removed; retry when it is available.";
  if (code === "hyperliquid_execution_vault_state_changed") return "The stored wallet changed during verification. Nothing else was removed; refresh and review the current wallet.";
  return investorFacingErrorMessage(error, fallback);
}

function errorMessage(error: unknown, fallback: string) {
  return investorFacingErrorMessage(error, fallback);
}

function rawErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function savePending(prefix: string, accountCommitment: string, value: unknown) {
  try {
    window.sessionStorage.setItem(`${prefix}${accountCommitment}`, JSON.stringify(value));
  } catch {
    // In-memory recovery remains available when session storage is blocked.
  }
}

function loadPendingAuthorization(accountCommitment: string): HyperliquidAgentAuthorizationRequest | null {
  return loadPending(PENDING_AUTHORIZE_PREFIX, accountCommitment) as HyperliquidAgentAuthorizationRequest | null;
}

function loadPendingDisable(accountCommitment: string): HyperliquidAgentRevocationRequest | null {
  return loadPending(PENDING_DISABLE_PREFIX, accountCommitment) as HyperliquidAgentRevocationRequest | null;
}

function loadPending(prefix: string, accountCommitment: string): unknown | null {
  try {
    const value = window.sessionStorage.getItem(`${prefix}${accountCommitment}`);
    return value ? JSON.parse(value) as unknown : null;
  } catch {
    return null;
  }
}

function clearPendingAuthorization(accountCommitment: string) {
  try {
    window.sessionStorage.removeItem(`${PENDING_AUTHORIZE_PREFIX}${accountCommitment}`);
  } catch {
    // No persistent plaintext exists; storage cleanup is best-effort.
  }
}

function clearPendingDisable(accountCommitment: string) {
  try {
    window.sessionStorage.removeItem(`${PENDING_DISABLE_PREFIX}${accountCommitment}`);
  } catch {
    // No persistent plaintext exists; storage cleanup is best-effort.
  }
}
