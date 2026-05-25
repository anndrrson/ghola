"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import bs58 from "bs58";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Clock3,
  KeyRound,
  Loader2,
  LockKeyhole,
  Play,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { createChatVault, didKeyFromVerifying } from "@/lib/chat-vault";
import {
  evaluatePrivateAgentAccess,
  type PrivateAgentRuntimeStatus,
} from "@/lib/private-agent-runtime";
import { buildPrivateAgentSessionRequest } from "@/lib/private-agent-seal";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { createThumperCheckout, getThumperBillingStatus } from "@/lib/thumper-api";
import type { ThumperBillingStatusResponse } from "@/lib/thumper-types";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import {
  compileTradingStrategy,
  formatStrategyUsd,
  hashTradingStrategyValue,
  type TradingStrategyMode,
  type TradingStrategyPolicyV1,
  type TradingStrategyRecord,
  type TradingStrategyReceiptV1,
} from "@/lib/trading-strategy";
import {
  evaluateTradeProposal,
  largestAllowedBucket,
  type PrivacyGuardResult,
  type TradeProposalV1,
} from "@/lib/trading-privacy-guard";
import {
  browserShieldedTradeProvider,
  type ShieldedTradeProvider,
} from "@/lib/shielded-trade-provider";
import {
  formatMicroUsd,
  summarizePrivateBalance,
  type PaymentHealth,
} from "@/lib/private-balance";
import {
  loadTradingStrategies,
  saveTradingStrategies,
} from "@/lib/trading-strategy-store";

const EXAMPLES = [
  "DCA $25 into ETH every Friday",
  "If SOL drops 8% in 24h, prepare a $50 buy",
  "Alert me if ETH is above $5,000",
  "Rebalance to 60% ETH and 40% USDC, max $100 per action",
] as const;

function solanaAddressToDid(address: string): string | null {
  try {
    const pub = bs58.decode(address);
    if (pub.length !== 32) return null;
    return didKeyFromVerifying(pub);
  } catch {
    return null;
  }
}

async function fetchPaymentHealth(): Promise<PaymentHealth | null> {
  const res = await fetch("/api/payments/health", { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as PaymentHealth;
}

async function fetchPrivateAgentRuntime(): Promise<PrivateAgentRuntimeStatus | null> {
  const res = await fetch("/api/private-agent/status", { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as PrivateAgentRuntimeStatus;
}

export default function StrategiesPage() {
  const thumperAuth = useThumperAuth();
  const { walletAddress, signBytes, loading: walletLoading } = useTurnkeyWallet();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [source, setSource] = useState<string>(EXAMPLES[0]);
  const [mode, setMode] = useState<TradingStrategyMode>("prepare_only");
  const [draft, setDraft] = useState<TradingStrategyPolicyV1 | null>(null);
  const [draftSummary, setDraftSummary] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [strategies, setStrategies] = useState<TradingStrategyRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<TradeProposalV1 | null>(null);
  const [guard, setGuard] = useState<PrivacyGuardResult | null>(null);
  const [paymentHealth, setPaymentHealth] = useState<PaymentHealth | null>(null);
  const [agentRuntime, setAgentRuntime] = useState<PrivateAgentRuntimeStatus | null>(null);
  const [billing, setBilling] = useState<ThumperBillingStatusResponse | null>(null);
  const [shieldedProviderReady, setShieldedProviderReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const userDid = useMemo(
    () => (walletAddress ? solanaAddressToDid(walletAddress) : null),
    [walletAddress],
  );
  const vault = useMemo(() => {
    if (!userDid) return null;
    return createChatVault({ userDid, signBytes });
  }, [signBytes, userDid]);
  const privateSummary = summarizePrivateBalance(paymentHealth);
  const billingTier = billing?.tier ?? "free";
  const privateCompute = billing?.private_agent_compute ?? null;
  const privateAgentAccess = evaluatePrivateAgentAccess({
    runtime: agentRuntime,
    tier: billingTier,
  });
  const selectedProviderLabel =
    agentRuntime?.providers.find(
      (provider) => provider.id === privateAgentAccess.selected_provider,
    )?.label ?? null;
  const selectedComputeProvider = agentRuntime?.providers.find(
    (provider) => provider.id === privateAgentAccess.selected_provider,
  ) ?? null;
  const selected = useMemo(
    () => strategies.find((strategy) => strategy.id === selectedId) ?? null,
    [selectedId, strategies],
  );

  useEffect(() => {
    void fetchPaymentHealth().then(setPaymentHealth).catch(() => setPaymentHealth(null));
    void fetchPrivateAgentRuntime()
      .then(setAgentRuntime)
      .catch(() => setAgentRuntime(null));
    setShieldedProviderReady(browserShieldedTradeProvider() !== null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (thumperAuth.loading) return;
    if (!thumperAuth.authenticated) {
      setBilling(null);
      return;
    }
    void getThumperBillingStatus()
      .then((billing) => {
        if (!cancelled) setBilling(billing);
      })
      .catch(() => {
        if (!cancelled) setBilling(null);
      });
    return () => {
      cancelled = true;
    };
  }, [thumperAuth.authenticated, thumperAuth.loading]);

  useEffect(() => {
    let cancelled = false;
    if (!vault) {
      setStrategies([]);
      return;
    }
    void loadTradingStrategies(vault)
      .then((items) => {
        if (cancelled) return;
        setStrategies(items);
        setSelectedId((current) => current ?? items[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not unlock encrypted strategies.");
      });
    return () => {
      cancelled = true;
    };
  }, [vault]);

  function requireWallet(): boolean {
    if (thumperAuth.authenticated && userDid && vault) return true;
    setAuthMode("signup");
    setAuthOpen(true);
    setError("Sign in with a wallet before saving private strategies.");
    return false;
  }

  async function subscribeForPrivateCompute() {
    if (!thumperAuth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      setError("Sign in before subscribing for private compute.");
      return;
    }
    setBusy("checkout");
    setError(null);
    try {
      const { checkout_url } = await createThumperCheckout("private_agent");
      window.location.assign(checkout_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout.");
      setBusy(null);
    }
  }

  function compile() {
    setError(null);
    setStatus(null);
    setProposal(null);
    setGuard(null);
    if (!requireWallet() || !userDid) return;
    const result = compileTradingStrategy(source, userDid, { mode });
    if (!result.ok) {
      setDraft(null);
      setDraftSummary("");
      setWarnings(result.field_hints);
      setError(result.reason);
      return;
    }
    const runtimeWarnings =
      mode === "capped_session_key" && !privateAgentAccess.remote_execution_ready
        ? [privateAgentAccess.message]
        : [];
    setDraft(result.policy);
    setDraftSummary(result.review_summary);
    setWarnings([...result.warnings, ...runtimeWarnings]);
  }

  async function saveDraft() {
    if (!draft || !vault) return;
    setBusy("save");
    setError(null);
    const now = new Date().toISOString();
    const record: TradingStrategyRecord = {
      id: draft.strategy_id,
      source,
      policy: draft,
      review_summary: draftSummary,
      receipts: [],
      active: true,
      created_at: now,
      updated_at: now,
    };
    const next = [record, ...strategies.filter((item) => item.id !== record.id)];
    try {
      await saveTradingStrategies(next, vault);
      setStrategies(next);
      setSelectedId(record.id);
      setStatus("Strategy saved encrypted on this device.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save strategy.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleActive(record: TradingStrategyRecord) {
    if (!vault) return;
    const next = strategies.map((item) =>
      item.id === record.id
        ? { ...item, active: !item.active, updated_at: new Date().toISOString() }
        : item,
    );
    setStrategies(next);
    await saveTradingStrategies(next, vault).catch(() =>
      setError("Could not update encrypted strategies."),
    );
  }

  async function deleteStrategy(record: TradingStrategyRecord) {
    if (!vault) return;
    const next = strategies.filter((item) => item.id !== record.id);
    setStrategies(next);
    setSelectedId(next[0]?.id ?? null);
    await saveTradingStrategies(next, vault).catch(() =>
      setError("Could not update encrypted strategies."),
    );
  }

  function prepareProposal(record = selected) {
    if (!record) return;
    setError(null);
    setStatus(null);
    const amount = largestAllowedBucket(record.policy);
    if (!amount || record.policy.trigger.kind === "alert_only") {
      setProposal(null);
      setGuard(null);
      setStatus("Alert-only strategy has no executable trade.");
      return;
    }
    const now = new Date();
    const triggerSeenAt = new Date(
      now.getTime() - (record.policy.min_delay_seconds + 30) * 1000,
    );
    const baseAsset = record.policy.allowed_assets.find((asset) => asset !== "USDC") ?? "ETH";
    const side =
      record.policy.trigger.kind === "price_above" ||
      (record.policy.trigger.kind === "percent_change_24h" &&
        record.policy.trigger.direction === "up")
        ? "sell"
        : "buy";
    const nextProposal: TradeProposalV1 = {
      version: 1,
      proposal_id: `proposal_${crypto.randomUUID()}`,
      strategy_id: record.policy.strategy_id,
      created_at: now.toISOString(),
      trigger_seen_at: triggerSeenAt.toISOString(),
      venue: "railgun_private_swap",
      public_amm: false,
      unshield: false,
      destination_address: null,
      destination_label: null,
      known_public_wallet: false,
      base_asset: baseAsset,
      quote_asset: "USDC",
      side,
      amount_micro_usdc: amount,
      slippage_bps: Math.min(30, record.policy.max_slippage_bps),
      calldata_kind: "railgun_private_swap",
      execution_mode: record.policy.mode,
      user_confirmed: record.policy.mode === "prepare_only",
    };
    const result = evaluateTradeProposal(record.policy, nextProposal);
    setProposal(nextProposal);
    setGuard(result);
    void appendReceipt(record, nextProposal, result);
  }

  async function appendReceipt(
    record: TradingStrategyRecord,
    nextProposal: TradeProposalV1,
    result: PrivacyGuardResult,
    txRef?: string,
  ) {
    if (!vault) return;
    const receipt: TradingStrategyReceiptV1 = {
      version: 1,
      strategy_id: record.id,
      policy_hash: result.policy_hash,
      source_hash: record.policy.source_hash,
      proposal_hash: result.proposal_hash,
      guard_ok: result.ok,
      ...(result.ok ? {} : { guard_reason: result.reason }),
      mode: record.policy.mode,
      venue: nextProposal.venue,
      amount_bucket_micro_usdc: nextProposal.amount_micro_usdc,
      created_at: new Date().toISOString(),
      ...(txRef ? { tx_ref: txRef } : {}),
    };
    const next = strategies.map((item) =>
      item.id === record.id
        ? {
            ...item,
            receipts: [receipt, ...(item.receipts ?? [])].slice(0, 25),
            updated_at: new Date().toISOString(),
          }
        : item,
    );
    setStrategies(next);
    await saveTradingStrategies(next, vault).catch(() => {});
  }

  async function executePrepared() {
    if (!selected || !proposal || !guard?.ok) return;
    if (selected.policy.mode === "capped_session_key") {
      if (!privateAgentAccess.remote_execution_ready) {
        setError(privateAgentAccess.message);
        return;
      }
      if (!userDid || !selectedComputeProvider) {
        setError("Sealed compute provider is not selected.");
        return;
      }
      setBusy("session");
      setError(null);
      try {
        const sealed = await buildPrivateAgentSessionRequest({
          record: selected,
          ownerDid: userDid,
          provider: selectedComputeProvider,
          signBytes,
        });
        const res = await fetch("/api/private-agent/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(sealed.request),
        });
        const body = (await res.json().catch(() => null)) as {
          session_id?: string;
          provider?: string;
          error?: string;
          details?: string[];
        } | null;
        if (!res.ok) {
          throw new Error(
            body?.details?.join(" ") ||
              body?.error ||
              `Private agent session failed (${res.status})`,
          );
        }
        setStatus(
          `Sealed private-agent session ${body?.session_id ?? "accepted"} is ready on ${body?.provider ?? selectedProviderLabel ?? "provider"}.`,
        );
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Could not create sealed private-agent session.",
        );
      } finally {
        setBusy(null);
      }
      return;
    }
    if (!privateSummary.privateSpendReady) {
      setError("Private shielded rail is not ready. Trade was not submitted.");
      return;
    }
    const shieldedProvider: ShieldedTradeProvider | null =
      browserShieldedTradeProvider();
    if (!shieldedProvider) {
      setError("Shielded trade provider is not available in this browser.");
      setShieldedProviderReady(false);
      return;
    }
    setBusy("execute");
    try {
      const quote = await shieldedProvider.quotePrivateSwap(proposal, selected.policy);
      const built = await shieldedProvider.buildPrivateSwap(
        quote,
        guard.policy_hash,
        guard.proposal_hash,
      );
      const signed = await shieldedProvider.requestUserSignature(built.unsigned_tx);
      const submitted = await shieldedProvider.submitPrivateSwap(signed);
      await appendReceipt(selected, proposal, guard, submitted.tx_ref);
      setStatus(`Submitted private trade ${submitted.tx_ref}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Private trade submission failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#08090d] pt-16 text-[#eef1f8]">
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onModeChange={setAuthMode}
      />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#4a5568]">
              Private strategies
            </p>
            <h1 className="mt-2 font-display text-3xl text-[#eef1f8]">
              User-directed trading
            </h1>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <StatusPill
              icon={LockKeyhole}
              label={userDid ? "Vault ready" : "Vault locked"}
              tone={userDid ? "good" : "warn"}
            />
            <StatusPill
              icon={ShieldCheck}
              label={privateSummary.privateSpendReady ? "Shielded rail ready" : "Shielded rail paused"}
              tone={privateSummary.privateSpendReady ? "good" : "warn"}
            />
            <StatusPill
              icon={Wallet}
              label={shieldedProviderReady ? "Trade provider ready" : "Provider missing"}
              tone={shieldedProviderReady ? "good" : "warn"}
            />
            <StatusPill
              icon={Cloud}
              label={
                privateAgentAccess.remote_execution_ready
                  ? `Sealed ${selectedProviderLabel ?? "compute"}`
                  : "Local-only agents"
              }
              tone={privateAgentAccess.remote_execution_ready ? "good" : "warn"}
            />
          </div>
        </div>

        {(error || status) && (
          <div
            className={`mb-5 rounded-md border px-4 py-3 text-sm ${
              error
                ? "border-red-400/30 bg-red-400/10 text-red-100"
                : "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
            }`}
          >
            {error ?? status}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section className="rounded-md border border-[#1e2a3a] bg-[#0a0b10]">
            <div className="border-b border-[#1e2a3a] p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-[#eef1f8]">
                <Plus className="h-4 w-4 text-[#3da8ff]" />
                New strategy
              </div>
            </div>
            <div className="space-y-5 p-4">
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setSource(example)}
                    className="rounded-full border border-[#1e2a3a] px-3 py-1.5 text-xs text-[#8b95a8] transition hover:border-[#3a4a60] hover:text-[#eef1f8]"
                  >
                    {example}
                  </button>
                ))}
              </div>
              <textarea
                value={source}
                onChange={(event) => setSource(event.target.value)}
                rows={5}
                className="w-full resize-none rounded-md border border-[#1e2a3a] bg-[#10131c] px-4 py-3 text-sm text-[#eef1f8] outline-none transition focus:border-[#3da8ff]"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-full border border-[#1e2a3a] bg-[#08090d] p-0.5">
                  <ModeButton
                    selected={mode === "prepare_only"}
                    onClick={() => setMode("prepare_only")}
                    icon={ShieldCheck}
                    label="Prepare"
                  />
                  <ModeButton
                    selected={mode === "capped_session_key"}
                    onClick={() => {
                      setMode("capped_session_key");
                      if (!privateAgentAccess.remote_execution_ready) {
                        setStatus(privateAgentAccess.message);
                      }
                    }}
                    icon={KeyRound}
                    label="Session key"
                  />
                </div>
                <button
                  type="button"
                  onClick={compile}
                  disabled={walletLoading || busy !== null}
                  className="inline-flex items-center gap-2 rounded-md bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] transition hover:bg-[#5bb8ff] disabled:opacity-60"
                >
                  {walletLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
                  Compile policy
                </button>
              </div>

              {draft && (
                <div className="rounded-md border border-[#24364d] bg-[#0f1420] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-[#eef1f8]">
                        {draftSummary}
                      </p>
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#4a5568]">
                        {hashTradingStrategyValue(draft).slice(0, 16)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={saveDraft}
                      disabled={busy !== null}
                      className="inline-flex shrink-0 items-center gap-2 rounded-md border border-[#3da8ff]/50 px-3 py-2 text-xs font-medium text-[#cfeaff] transition hover:border-[#7cc8ff] disabled:opacity-60"
                    >
                      {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Save
                    </button>
                  </div>
                  <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
                    <PolicyMetric label="Per trade" value={formatMicroUsd(draft.max_trade_micro_usdc)} />
                    <PolicyMetric label="Daily cap" value={formatMicroUsd(draft.daily_cap_micro_usdc)} />
                    <PolicyMetric label="Slippage" value={`${draft.max_slippage_bps} bps`} />
                  </dl>
                  {warnings.length > 0 && (
                    <div className="mt-3 text-xs text-amber-100">
                      {warnings.join(" ")}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-5">
            <section className="rounded-md border border-[#1e2a3a] bg-[#0a0b10]">
              <div className="border-b border-[#1e2a3a] p-4 text-sm font-medium">
                Saved strategies
              </div>
              <div className="divide-y divide-[#1e2a3a]">
                {strategies.length === 0 ? (
                  <div className="p-4 text-sm text-[#8b95a8]">
                    No encrypted strategies on this device.
                  </div>
                ) : (
                  strategies.map((record) => (
                    <button
                      key={record.id}
                      type="button"
                      onClick={() => setSelectedId(record.id)}
                      className={`block w-full px-4 py-3 text-left transition ${
                        selectedId === record.id
                          ? "bg-[#3da8ff]/10"
                          : "hover:bg-[#10131c]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="line-clamp-1 text-sm text-[#eef1f8]">
                          {record.review_summary}
                        </p>
                        <span className={`h-2 w-2 rounded-full ${record.active ? "bg-emerald-300" : "bg-[#4a5568]"}`} />
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-[#6f7b90]">
                        {record.source}
                      </p>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-md border border-[#1e2a3a] bg-[#0a0b10]">
              <div className="border-b border-[#1e2a3a] p-4 text-sm font-medium">
                Execution
              </div>
              <div className="space-y-4 p-4">
                {selected ? (
                  <>
                    <div>
                      <p className="text-sm text-[#eef1f8]">{selected.review_summary}</p>
                      <p className="mt-1 text-xs text-[#6f7b90]">
                        {selected.policy.mode === "prepare_only"
                          ? "User signs every execution."
                          : "Capped session-key policy saved; automation adapter pending."}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => prepareProposal(selected)}
                        className="inline-flex items-center gap-2 rounded-md bg-[#eef1f8] px-3 py-2 text-xs font-medium text-[#08090d] transition hover:bg-white"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Prepare
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleActive(selected)}
                        className="rounded-md border border-[#1e2a3a] px-3 py-2 text-xs text-[#8b95a8] transition hover:text-[#eef1f8]"
                      >
                        {selected.active ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteStrategy(selected)}
                        className="rounded-md border border-red-400/30 px-3 py-2 text-xs text-red-100 transition hover:border-red-400/60"
                      >
                        Delete
                      </button>
                    </div>
                    {guard && proposal && (
                      <div
                        className={`rounded-md border p-3 text-sm ${
                          guard.ok
                            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                            : "border-amber-400/30 bg-amber-400/10 text-amber-100"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {guard.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                          <span>{guard.explanation}</span>
                        </div>
                        <p className="mt-2 text-xs opacity-85">
                          {proposal.side.toUpperCase()} {proposal.base_asset} for {formatStrategyUsd(proposal.amount_micro_usdc)}
                        </p>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={executePrepared}
                      disabled={!guard?.ok || busy !== null}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#3da8ff] px-4 py-2.5 text-sm font-medium text-[#08090d] transition hover:bg-[#5bb8ff] disabled:opacity-50"
                    >
                      {busy === "execute" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                      Sign private trade
                    </button>
                    {(selected.receipts?.length ?? 0) > 0 && (
                      <div className="space-y-2">
                        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#4a5568]">
                          Receipts
                        </p>
                        {selected.receipts?.slice(0, 3).map((receipt) => (
                          <div
                            key={`${receipt.proposal_hash}-${receipt.created_at}`}
                            className="flex items-center justify-between gap-3 text-xs text-[#8b95a8]"
                          >
                            <span>{receipt.guard_ok ? "Prepared" : "Blocked"}</span>
                            <span className="font-mono">{receipt.proposal_hash.slice(0, 10)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-[#8b95a8]">
                    Select or save a strategy to prepare a private action.
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-md border border-[#1e2a3a] bg-[#0a0b10] p-4 text-sm text-[#8b95a8]">
              <div className="mb-2 flex items-center gap-2 text-[#eef1f8]">
                <Clock3 className="h-4 w-4 text-[#3da8ff]" />
                Active watcher
              </div>
              <p>
                V1 watchers run in this browser tab. Cloud background watchers stay off unless sealed execution is ready.
              </p>
              <div className="mt-3 rounded-md border border-[#1e2a3a] bg-[#08090d] p-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-mono uppercase tracking-[0.16em] text-[#4a5568]">
                    Private cloud
                  </span>
                  <span
                    className={
                      privateAgentAccess.remote_execution_ready
                        ? "text-emerald-200"
                        : "text-amber-100"
                    }
                  >
                    {privateAgentAccess.remote_execution_ready
                      ? selectedProviderLabel ?? "Ready"
                      : "Paused"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-[#8b95a8]">
                  {privateAgentAccess.message}
                </p>
                {privateAgentAccess.blocking_reasons.length > 0 && (
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#4a5568]">
                    {privateAgentAccess.blocking_reasons.slice(0, 3).join(" / ")}
                  </p>
                )}
                {privateAgentAccess.entitled && privateCompute && (
                  <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-[#1e2a3a] bg-[#0a0b10] p-3 text-xs">
                    <div>
                      <p className="text-[#4a5568]">Remaining</p>
                      <p className="mt-1 text-[#eef1f8]">
                        {formatComputeHours(privateCompute.remaining_seconds)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[#4a5568]">Active</p>
                      <p className="mt-1 text-[#eef1f8]">
                        {privateCompute.active_agent_count}/{privateCompute.active_agent_limit}
                      </p>
                    </div>
                  </div>
                )}
                {!privateAgentAccess.entitled && (
                  <button
                    type="button"
                    onClick={subscribeForPrivateCompute}
                    disabled={busy === "checkout"}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#3da8ff] px-3 py-2 text-xs font-medium text-[#08090d] transition hover:bg-[#5bb8ff] disabled:opacity-60"
                  >
                    {busy === "checkout" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Cloud className="h-3.5 w-3.5" />
                    )}
                    Start private compute hours
                  </button>
                )}
              </div>
              <Link
                href="/private-balance"
                className="mt-3 inline-flex text-xs font-medium text-[#3da8ff] hover:text-[#7cc8ff]"
              >
                Private balance status
              </Link>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function formatComputeHours(seconds: number): string {
  const hours = Math.max(0, seconds) / 3600;
  const maximumFractionDigits = hours >= 10 || Number.isInteger(hours) ? 0 : 1;
  return `${hours.toLocaleString(undefined, {
    maximumFractionDigits,
  })}h`;
}

function StatusPill({
  icon: Icon,
  label,
  tone,
}: {
  icon: typeof ShieldCheck;
  label: string;
  tone: "good" | "warn";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${
        tone === "good"
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
          : "border-amber-400/30 bg-amber-400/10 text-amber-100"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function ModeButton({
  selected,
  onClick,
  icon: Icon,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  icon: typeof ShieldCheck;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
        selected ? "bg-[#3da8ff]/15 text-[#3da8ff]" : "text-[#8b95a8] hover:text-[#eef1f8]"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function PolicyMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono uppercase tracking-[0.16em] text-[#4a5568]">
        {label}
      </dt>
      <dd className="mt-1 text-[#eef1f8]">{value}</dd>
    </div>
  );
}
