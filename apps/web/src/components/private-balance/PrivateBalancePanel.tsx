"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { getBalance } from "@/lib/api";
import { useWalletAuth } from "@/lib/wallet-provider";
import {
  formatMicroUsd,
  summarizePrivateBalance,
  type PaymentHealth,
  type ShieldedStablecoinHealth,
} from "@/lib/private-balance";

interface PrivateBalancePanelProps {
  compact?: boolean;
}

const TOP_UP_AMOUNTS = [5, 10, 25] as const;
const SHIELD_URL = "https://aleo.org/shield/";

async function fetchPaymentHealth(): Promise<PaymentHealth | null> {
  const res = await fetch("/api/payments/health", {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as PaymentHealth;
}

async function fetchShieldedHealth(): Promise<ShieldedStablecoinHealth | null> {
  const res = await fetch("/api/aleo-shielded/health", {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as ShieldedStablecoinHealth;
}

function shortAddress(address: string | null | undefined): string {
  if (!address) return "Not available";
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

export function PrivateBalancePanel({ compact = false }: PrivateBalancePanelProps) {
  const walletAuth = useWalletAuth();
  const [paymentHealth, setPaymentHealth] = useState<PaymentHealth | null>(null);
  const [shieldedHealth, setShieldedHealth] =
    useState<ShieldedStablecoinHealth | null>(null);
  const [balanceMicroUsd, setBalanceMicroUsd] = useState<number | null>(null);
  const [selectedAmount, setSelectedAmount] =
    useState<(typeof TOP_UP_AMOUNTS)[number]>(10);
  const [notice, setNotice] = useState<string | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [txId, setTxId] = useState("");
  const [verifyState, setVerifyState] = useState<
    "idle" | "checking" | "settled" | "failed"
  >("idle");
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPaymentHealth().then((health) => {
      if (!cancelled) setPaymentHealth(health);
    });
    void fetchShieldedHealth().then((health) => {
      if (!cancelled) setShieldedHealth(health);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!walletAuth.authenticated) {
      setBalanceMicroUsd(null);
      return () => {
        cancelled = true;
      };
    }
    getBalance()
      .then((balance) => {
        if (cancelled) return;
        const amount =
          "balances" in balance
            ? (balance as { balances: { balance: number }[] }).balances.reduce(
                (sum, item) => sum + item.balance,
                0,
              )
            : (balance as { balance: number }).balance;
        setBalanceMicroUsd(amount);
      })
      .catch(() => {
        if (!cancelled) setBalanceMicroUsd(null);
      });
    return () => {
      cancelled = true;
    };
  }, [walletAuth.authenticated]);

  const summary = useMemo(
    () => summarizePrivateBalance(paymentHealth),
    [paymentHealth],
  );
  const recipient =
    shieldedHealth?.recipient ||
    paymentHealth?.rails?.shielded_stablecoin?.recipient ||
    null;

  const statusClass =
    summary.status === "private_ready"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
      : summary.status === "setup_required"
        ? "border-[#3da8ff]/30 bg-[#3da8ff]/10 text-[#a8d8ff]"
        : summary.status === "checking"
          ? "border-[#1e2a3a] bg-[#0f1117] text-[#8b95a8]"
        : "border-amber-400/30 bg-amber-400/10 text-amber-100";

  function handleTopUp() {
    if (!summary.privateSpendReady) {
      setNotice(
        "Private top up is waiting on shielded verifier cutover. Public USDC stays available, but Private Balance will not downgrade to it.",
      );
      return;
    }
    setTopUpOpen(true);
    setNotice(null);
    setVerifyState("idle");
    setVerifyMessage(null);
  }

  async function copyText(value: string | null | undefined, label: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setNotice(`${label}: ${value}`);
    }
  }

  async function verifyTopUp() {
    if (!recipient) {
      setVerifyState("failed");
      setVerifyMessage("Private recipient is not available.");
      return;
    }
    if (!txId.trim()) {
      setVerifyState("failed");
      setVerifyMessage("Enter the Aleo transaction id after sending.");
      return;
    }

    setVerifyState("checking");
    setVerifyMessage(null);
    try {
      const res = await fetch("/api/aleo-shielded/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "aleo",
          network: summary.network,
          asset: summary.asset,
          destination: recipient,
          required_amount: selectedAmount * 1_000_000,
          proof: {
            shielded_receipt_id: txId.trim(),
            proof_b64: null,
            nullifier_hex: null,
          },
        }),
      });
      const result = (await res.json()) as {
        settled?: boolean;
        error?: string;
        amount?: number;
      };
      if (result.settled) {
        setVerifyState("settled");
        setVerifyMessage(
          `Private Balance credited ${formatMicroUsd(result.amount ?? selectedAmount * 1_000_000)}.`,
        );
        return;
      }
      setVerifyState("failed");
      setVerifyMessage(result.error || "Payment was not verified yet.");
    } catch {
      setVerifyState("failed");
      setVerifyMessage("Could not reach the shielded verifier.");
    }
  }

  return (
    <section
      className={
        compact
          ? "w-full max-w-xl rounded-lg border border-[#1e2a3a] bg-[#0a0b10] p-4"
          : "rounded-lg border border-[#1e2a3a] bg-[#0a0b10] p-5 sm:p-6"
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div
            className={`mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${statusClass}`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {summary.label}
          </div>
          <h2
            className={
              compact
                ? "text-lg font-medium text-[#eef1f8]"
                : "text-2xl font-medium text-[#eef1f8] sm:text-3xl"
            }
          >
            Private Balance
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#8b95a8]">
            One balance. Private Mode spends through USDCx-backed shielded
            settlement when the rail is ready. No rail picking, no silent
            public fallback.
          </p>
        </div>
        <div className="sm:text-right">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#5f6c81]">
            Balance
          </p>
          <p className="mt-1 text-3xl font-medium text-[#eef1f8]">
            {formatMicroUsd(balanceMicroUsd)}
          </p>
        </div>
      </div>

      <div
        className={
          compact
            ? "mt-5 grid gap-3"
            : "mt-6 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]"
        }
      >
        <div className="rounded-lg border border-[#151b26] bg-[#08090d] p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#eef1f8] text-[#08090d]">
              <Wallet className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-[#eef1f8]">
                {summary.headline}
              </h3>
              <p className="mt-1 text-sm leading-6 text-[#8b95a8]">
                {summary.detail}
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-2 text-xs text-[#8b95a8] sm:grid-cols-3">
            <div className="rounded-md border border-[#151b26] bg-black/30 px-3 py-2">
              Asset <span className="block font-mono text-[#eef1f8]">{summary.asset}</span>
            </div>
            <div className="rounded-md border border-[#151b26] bg-black/30 px-3 py-2">
              Network <span className="block font-mono text-[#eef1f8]">{summary.network}</span>
            </div>
            <div className="rounded-md border border-[#151b26] bg-black/30 px-3 py-2">
              Recipient{" "}
              <span className="block font-mono text-[#eef1f8]">
                {shortAddress(recipient)}
              </span>
            </div>
            <div className="rounded-md border border-[#151b26] bg-black/30 px-3 py-2">
              Fallback{" "}
              <span className="block font-mono text-[#eef1f8]">
                {summary.fallbackAllowed ? "allowed" : "off"}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-[#151b26] bg-[#08090d] p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-[#eef1f8]">Top up</h3>
            <span className="text-xs text-[#5f6c81]">
              {summary.privateSpendReady ? "Private rail ready" : "Public USDC live"}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {TOP_UP_AMOUNTS.map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => setSelectedAmount(amount)}
                className={`rounded-md border px-3 py-2 text-sm transition ${
                  selectedAmount === amount
                    ? "border-[#eef1f8] bg-[#eef1f8] text-[#08090d]"
                    : "border-[#1e2a3a] bg-[#0f1117] text-[#8b95a8] hover:text-[#eef1f8]"
                }`}
              >
                ${amount}
              </button>
            ))}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setTopUpOpen(true)}
              disabled={!summary.privateSpendReady}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-sm text-[#8b95a8] transition hover:text-[#eef1f8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Wallet className="h-4 w-4" />
              Shield
            </button>
            <button
              type="button"
              disabled
              className="inline-flex cursor-not-allowed items-center justify-center gap-2 rounded-md border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-sm text-[#8b95a8] opacity-50"
            >
              <CreditCard className="h-4 w-4" />
              Card next
            </button>
          </div>
          <button
            type="button"
            onClick={handleTopUp}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#eef1f8] px-4 py-2.5 text-sm font-medium text-[#08090d] transition hover:bg-white"
          >
            {summary.privateSpendReady
              ? "Top up Private Balance"
              : "Prepare Private Balance"}
            <ArrowRight className="h-4 w-4" />
          </button>
          {notice && (
            <p className="mt-3 rounded-md border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-xs leading-5 text-[#8b95a8]">
              {notice}
            </p>
          )}
        </div>
      </div>

      {topUpOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/70 p-3 backdrop-blur-sm sm:items-center sm:justify-center">
          <div className="w-full max-w-lg rounded-lg border border-[#1e2a3a] bg-[#0a0b10] p-4 shadow-2xl shadow-black/60 sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#6f7d9a]">
                  Private top up
                </p>
                <h3 className="mt-2 text-xl font-medium text-[#eef1f8]">
                  Send {formatMicroUsd(selectedAmount * 1_000_000)} USDCx
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setTopUpOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-md border border-[#1e2a3a] text-[#8b95a8] transition hover:text-[#eef1f8]"
                aria-label="Close private top up"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 grid gap-3">
              <div className="rounded-md border border-[#151b26] bg-[#08090d] p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-[#6f7d9a]">Recipient</span>
                  <button
                    type="button"
                    onClick={() => copyText(recipient, "Recipient")}
                    className="inline-flex items-center gap-1 text-xs text-[#a8d8ff] hover:text-[#eef1f8]"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </button>
                </div>
                <p className="mt-2 break-all font-mono text-xs leading-5 text-[#eef1f8]">
                  {recipient || "Recipient loading"}
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() =>
                    copyText(String(selectedAmount * 1_000_000), "Amount")
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-[#1e2a3a] bg-[#0f1117] px-3 py-2.5 text-sm text-[#eef1f8] transition hover:bg-[#151b26]"
                >
                  <Copy className="h-4 w-4" />
                  Copy amount
                </button>
                <a
                  href={SHIELD_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-[#eef1f8] px-3 py-2.5 text-sm font-medium text-[#08090d] transition hover:bg-white"
                >
                  Open Shield
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>

              <div className="rounded-md border border-[#151b26] bg-[#08090d] p-3">
                <label
                  htmlFor="private-top-up-tx"
                  className="text-xs text-[#6f7d9a]"
                >
                  Aleo transaction id
                </label>
                <input
                  id="private-top-up-tx"
                  value={txId}
                  onChange={(event) => {
                    setTxId(event.target.value);
                    setVerifyState("idle");
                    setVerifyMessage(null);
                  }}
                  placeholder="at1..."
                  className="mt-2 w-full rounded-md border border-[#1e2a3a] bg-black px-3 py-2 font-mono text-sm text-[#eef1f8] outline-none transition placeholder:text-[#3d4658] focus:border-[#3da8ff]"
                />
                <button
                  type="button"
                  onClick={verifyTopUp}
                  disabled={verifyState === "checking"}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#3da8ff] px-3 py-2.5 text-sm font-medium text-black transition hover:bg-[#75c1ff] disabled:cursor-wait disabled:opacity-70"
                >
                  {verifyState === "checking" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : verifyState === "settled" ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <ShieldCheck className="h-4 w-4" />
                  )}
                  {verifyState === "settled" ? "Verified" : "Verify top up"}
                </button>
                {verifyMessage && (
                  <p
                    className={`mt-3 rounded-md border px-3 py-2 text-xs leading-5 ${
                      verifyState === "settled"
                        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                        : "border-amber-400/30 bg-amber-400/10 text-amber-100"
                    }`}
                  >
                    {verifyMessage}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {!compact && (
        <div className="mt-5 flex flex-col gap-3 border-t border-[#151b26] pt-5 text-sm text-[#8b95a8] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-[#3da8ff]" />
            Privacy is a mode, not a setup process.
          </div>
          <Link
            href="/x402"
            className="inline-flex items-center gap-2 text-[#a8d8ff] hover:text-[#eef1f8]"
          >
            Rail details <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </section>
  );
}
