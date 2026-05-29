"use client";

import Link from "next/link";
import { ArrowRight, BadgeCheck, FileText, Layers3, LockKeyhole, ShieldAlert, ShieldCheck } from "lucide-react";
import { PrivateAccountOperationsPanel } from "@/components/private-account/PrivateAccountOperationsPanel";
import { RequireThumperAuth } from "@/components/RequireThumperAuth";

const panels = [
  ["Custody/provider connections", "Commitment-only links for custody, providers, and venue accounts.", ShieldCheck],
  ["Private state vault", "Portfolio imports become vault roots, note roots, and readiness status.", LockKeyhole],
  ["Policy and approvals", "Thresholds, allowed rails, batch windows, and degraded acceptance policy.", BadgeCheck],
  ["Privacy preflight", "Threat model, anonymity set, leakage map, and platform profile evaluation.", ShieldAlert],
  ["Batch queue", "Compatible intents wait for cohort depth before settlement.", Layers3],
  ["Receipts/auditor export", "Selective disclosure without exposing raw platform payloads publicly.", FileText],
] as const;

export default function GholaControlRoomPage() {
  return (
    <RequireThumperAuth
      title="Sign in to open Control Room"
      detail="Operator controls are available after account sign-in."
    >
      <main className="min-h-screen bg-[#08090d] pt-16 text-[#eef1f8]">
      <section className="border-b border-[#151b26] px-5 py-14 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f7d9a]">
            Ghola Control Room
          </p>
          <div className="mt-5 grid gap-8 lg:grid-cols-[1fr_0.8fr] lg:items-end">
            <div>
              <h1 className="max-w-4xl text-5xl font-medium leading-[0.98] text-[#f6f8ff] sm:text-7xl">
                Policy-first private execution for operators.
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-7 text-[#aab5c8] sm:text-lg">
                Funds, DAOs, institutions, and agent operators submit private
                intents into the same anonymity engine used by Ghola Account.
                Work orders cannot reach venues or settlement rails until
                preflight, approvals, and receipt bindings pass.
              </p>
            </div>
            <div className="border border-[#1e2a3a] bg-[#0f1117] p-5">
              <h2 className="text-lg font-medium">Control defaults</h2>
              <div className="mt-5 space-y-3">
                <Row label="Execution mode" value="Private Mode gated" />
                <Row label="Public fallback" value="approval required" />
                <Row label="Batch minimum" value="institutional threshold" />
                <Row label="Audit output" value="selective disclosure" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 py-10 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {panels.map(([title, detail, Icon]) => (
              <div key={title} className="border border-[#1e2a3a] bg-[#0f1117] p-5">
                <Icon className="h-5 w-5 text-[#a8d8ff]" />
                <h2 className="mt-4 text-lg font-medium">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-[#8b95a8]">{detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-[#151b26] px-5 py-10 sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-[#8b95a8]">
            The Control Room replaces market-terminal defaults with custody,
            policy, preflight, approval, batching, and receipt controls.
          </p>
          <Link href="/app/account" className="inline-flex items-center gap-2 text-sm font-medium text-[#a8d8ff] hover:text-[#eef1f8]">
            Open Ghola Account <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <PrivateAccountOperationsPanel />
      </main>
    </RequireThumperAuth>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-[#8b95a8]">{label}</span>
      <span className="text-sm text-[#eef1f8]">{value}</span>
    </div>
  );
}
