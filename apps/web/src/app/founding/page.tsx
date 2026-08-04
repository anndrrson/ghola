"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { GholaLogo } from "@/components/GholaLogo";
import { useThumperAuth } from "@/lib/thumper-auth-context";

interface FoundingCohortStatus {
  capacity: number;
  claimed_seats: number;
  remaining_seats: number;
  checkout_open: boolean;
}

const features = [
  "100 private compute hours each month",
  "Up to 3 logical private agents",
  "Manual mainnet trading through sealed workers when readiness checks pass",
  "Read-only venue, authority, market, and collateral preflight",
  "Encrypted trading-only credential vault",
  "Execution receipts, reconciliation, reduce-only exits, and cancellations",
  "Direct founding-trader support",
];

export default function FoundingTraderPage() {
  const { authenticated, loading } = useThumperAuth();
  const [cohort, setCohort] = useState<FoundingCohortStatus | null>(null);

  useEffect(() => {
    fetch("/api/billing/founding-cohort", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((status) => setCohort(status as FoundingCohortStatus | null))
      .catch(() => setCohort(null));
  }, []);

  const joinHref = authenticated
    ? "/settings?tab=plan"
    : "/signup?redirect=%2Fsettings%3Ftab%3Dplan";
  const soldOut = cohort?.remaining_seats === 0;
  const checkoutUnavailable = cohort?.checkout_open === false && !soldOut;

  return (
    <main className="min-h-screen bg-[#08090d] px-4 py-10 text-[#eef1f8] sm:px-6">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-[#8b95a8]">
          <GholaLogo size={28} className="text-[#eef1f8]" />
          Ghola
        </Link>

        <section className="mt-16 rounded-2xl border border-[#1e2a3a] bg-[#0f1117] p-6 sm:p-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#3da8ff]/30 bg-[#3da8ff]/10 px-3 py-1 text-xs text-[#8dcfff]">
            <ShieldCheck className="h-3.5 w-3.5" />
            Public founding cohort · 100 seats
          </div>
          <h1 className="mt-6 text-4xl font-medium tracking-tight sm:text-5xl">
            Founding Trader
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#8b95a8]">
            Private trading infrastructure for traders who want explicit readiness checks,
            encrypted trading authority, and evidence for every execution path.
          </p>

          <div className="mt-8 flex flex-col gap-2 border-y border-[#1e2a3a] py-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <span className="text-4xl font-medium">$29</span>
              <span className="text-sm text-[#8b95a8]"> / month</span>
            </div>
            <p className="text-sm text-[#8b95a8]">
              {cohort
                ? `${cohort.remaining_seats.toLocaleString()} of ${cohort.capacity.toLocaleString()} seats remaining`
                : "Live seat count loads before checkout"}
            </p>
          </div>

          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {features.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm leading-6 text-[#b4bdcc]">
                <Check className="mt-1 h-4 w-4 shrink-0 text-[#3da8ff]" />
                {feature}
              </li>
            ))}
          </ul>

          {soldOut ? (
            <div className="mt-8 rounded-xl border border-[#1e2a3a] px-5 py-3 text-center text-sm text-[#8b95a8]">
              The founding cohort is full.
            </div>
          ) : checkoutUnavailable ? (
            <div className="mt-8 rounded-xl border border-[#1e2a3a] px-5 py-3 text-center text-sm text-[#8b95a8]">
              Public checkout is being configured.
            </div>
          ) : (
            <Link
              href={joinHref}
              aria-disabled={loading}
              className="mt-8 flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-3 text-sm font-medium text-[#08090d] transition-colors hover:bg-[#5bb8ff]"
            >
              Join the founding cohort
              <ArrowRight className="h-4 w-4" />
            </Link>
          )}

          <p className="mt-5 text-xs leading-5 text-[#667085]">
            Subscription does not include trading capital and does not guarantee profit or venue
            availability. Mainnet execution remains unavailable until the trader&apos;s selected venue,
            trading-only authority, market, and collateral all pass readiness checks.
          </p>
        </section>
      </div>
    </main>
  );
}
