"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CreditCard,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { getBalance } from "@/lib/api";
import { useWalletAuth } from "@/lib/wallet-provider";
import {
  formatMicroUsd,
  summarizePrivateBalance,
  type PaymentHealth,
} from "@/lib/private-balance";

interface PrivateBalancePanelProps {
  compact?: boolean;
}

const TOP_UP_AMOUNTS = [5, 10, 25] as const;

async function fetchPaymentHealth(): Promise<PaymentHealth | null> {
  const res = await fetch("/api/payments/health", {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as PaymentHealth;
}

export function PrivateBalancePanel({ compact = false }: PrivateBalancePanelProps) {
  const walletAuth = useWalletAuth();
  const [paymentHealth, setPaymentHealth] = useState<PaymentHealth | null>(null);
  const [balanceMicroUsd, setBalanceMicroUsd] = useState<number | null>(null);
  const [selectedAmount, setSelectedAmount] =
    useState<(typeof TOP_UP_AMOUNTS)[number]>(10);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPaymentHealth().then((health) => {
      if (!cancelled) setPaymentHealth(health);
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
    setNotice(
      `Ready to top up ${formatMicroUsd(selectedAmount * 1_000_000)} into Private Balance.`,
    );
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
            One balance. Private Mode spends through USDC-backed shielded
            settlement when the rail is ready. No bridge UI, no rail picking,
            no silent public fallback.
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
              className="inline-flex items-center justify-center gap-2 rounded-md border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-sm text-[#8b95a8]"
            >
              <Wallet className="h-4 w-4" />
              USDC live
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-sm text-[#8b95a8]"
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
